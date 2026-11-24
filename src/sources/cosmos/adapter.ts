import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDefaultHttpClient, type HttpClient } from '@azure/core-rest-pipeline';
import {
    CosmosClient,
    type CosmosClientOptions,
    type FeedOptions,
    PriorityLevel,
    type SqlParameter,
} from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { CosmosSourceConfig } from '../../config/sources.ts';
import { PeriscopeError, summaryOf } from '../../core/errors.ts';
import { compileFilter } from '../../core/glob.ts';
import { SchemaInferrer } from '../../results/infer.ts';
import type {
    DocumentStream,
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { parseOptions, splitPath } from '../common.ts';
import { guardedCosmosHttpClient } from './guard.ts';

const PAGE_SIZE = 1000;
const SAMPLE_SIZE = 100;

const optionsSchema = z
    .object({
        database: z.string().min(1).optional(),
        container: z.string().min(1),
        partitionKey: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown())]).optional(),
    })
    .strict();

const paramsSchema = z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.object({ name: z.string(), value: z.unknown() })),
]);

interface Plan {
    database: string;
    container: string;
    parameters: SqlParameter[];
    partitionKey: unknown;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });

/**
 * Sends every request with `signal` on top of the request's own. The client passes a query's abort signal only
 * to the page requests; the reads it makes on the side (partition key ranges, the account) would go on, and be
 * retried, after the query was aborted.
 */
const boundTo = (signal: AbortSignal, inner: HttpClient): HttpClient => ({
    async sendRequest(request) {
        const own = request.abortSignal;
        if (!own) {
            request.abortSignal = signal;
            return inner.sendRequest(request);
        }
        const either = new AbortController();
        const abort = (): void => either.abort();
        if (own.aborted || signal.aborted) abort();
        own.addEventListener('abort', abort);
        signal.addEventListener('abort', abort);
        request.abortSignal = either.signal;
        try {
            return await inner.sendRequest(request);
        } finally {
            own.removeEventListener('abort', abort);
            signal.removeEventListener('abort', abort);
        }
    },
});

/** What the page loop needs of the client's query iterator. */
export interface PageIterator {
    hasMoreResults(): boolean;
    fetchNext(): Promise<{ resources?: unknown[]; requestCharge?: number }>;
}

/** Reads a query page by page, within the RU budget, until it ends or the query is aborted. */
export async function* queryPages(
    iterator: PageIterator,
    context: Pick<ExecutionContext, 'signal' | 'addCost'>,
    budget: number | undefined
): AsyncGenerator<unknown[]> {
    while (iterator.hasMoreResults()) {
        if (context.signal.aborted) return;
        const started = Date.now();
        const page = await iterator.fetchNext().catch((error: unknown) => {
            throw new PeriscopeError('source_error', summaryOf(error), undefined, { cause: error });
        });
        const ru = page.requestCharge ?? 0;
        context.addCost({ ru });
        if (page.resources && page.resources.length > 0) yield page.resources;
        // A page without results may have come without a request. A client that goes on answering like that
        // would otherwise keep this loop on resolved promises alone, and no timer or request of the whole
        // process would run again: neither the abort above nor anything else.
        else await nextTurn();
        if (budget && ru > 0) {
            const minimum = (ru / budget) * 1000;
            const elapsed = Date.now() - started;
            if (minimum > elapsed) await sleep(minimum - elapsed, context.signal);
        }
    }
}

/** Cosmos DB for NoSQL: queries and metadata only; writes are never offered and blocked on the wire. */
export class CosmosAdapter implements SourceAdapter {
    readonly config: CosmosSourceConfig;
    readonly #credential: DefaultAzureCredential | undefined;
    #client: CosmosClient | undefined;

    constructor(config: CosmosSourceConfig) {
        this.config = config;
        // one credential for all clients, so a token is fetched once and not per query
        this.#credential = config.azureAuth ? new DefaultAzureCredential() : undefined;
    }

    #clientOptions(httpClient: HttpClient): CosmosClientOptions {
        const c = this.config;
        return {
            endpoint: c.endpoint,
            ...(this.#credential ? { aadCredentials: this.#credential } : { key: c.key as string }),
            httpClient,
            userAgentSuffix: 'periscope-mcp',
            connectionPolicy: {
                enableEndpointDiscovery: !/localhost|127\.0\.0\.1/.test(c.endpoint),
                requestTimeout: 30_000,
            },
        };
    }

    async init(_log: Logger): Promise<void> {
        this.#client = new CosmosClient(this.#clientOptions(guardedCosmosHttpClient(this.config.name)));
        // Fail fast for unreachable or deleted accounts; the registry retries later.
        try {
            await this.#client.getDatabaseAccount({ abortSignal: AbortSignal.timeout(15_000) });
        } catch (error) {
            const reason =
                (error as { name?: string }).name === 'AbortError' ? 'no answer within 15s' : (error as Error).message;
            throw new PeriscopeError('source_error', `Cosmos account is not reachable: ${reason}`, undefined, {
                cause: error,
            });
        }
    }

    get #clientOrThrow(): CosmosClient {
        if (!this.#client) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        return this.#client;
    }

    info(): SourceInfo {
        return {
            name: this.config.name,
            type: 'cosmos',
            description: this.config.description,
            queryLanguage: 'Azure Cosmos DB for NoSQL query language',
            dialectHints: [
                'SELECT * FROM c WHERE c.status = @status; the container alias is free (c, root, …).',
                'options.container is required; options.database defaults to the source default.',
                'Pass parameters as { "@status": "open" }.',
                'Set options.partitionKey to keep a query in one partition (cheaper).',
                'Aggregates: SELECT VALUE COUNT(1) FROM c. Results are documents (NDJSON).',
            ],
            options: {
                database: `string: database${this.config.database ? ` (default '${this.config.database}')` : ''}`,
                container: 'string: container to query (required)',
                partitionKey: 'value or array (hierarchical keys): restrict the query to one logical partition',
            },
            params: 'object mapping @name to value, or [{ name, value }]',
            readOnlyLayers: [
                'only read and query operations implemented',
                'wire guard: only GET/HEAD and query POSTs reach the network',
            ],
            credential: 'unverified',
            credentialNote: this.config.azureAuth
                ? 'managed identity; assign Cosmos DB Built-in Data Reader for a read-only credential'
                : 'account key; read-only keys cannot be told apart from primary keys',
        };
    }

    #database(options: { database?: string | undefined }): string {
        const database = options.database ?? this.config.database;
        if (!database) throw new PeriscopeError('invalid_argument', 'options.database is required for this source');
        return database;
    }

    async validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        if (query.trim().length === 0) throw new PeriscopeError('invalid_argument', 'query must not be empty');
        let parameters: SqlParameter[] = [];
        if (params !== undefined && params !== null) {
            const parsed = paramsSchema.safeParse(params);
            if (!parsed.success) {
                throw new PeriscopeError('invalid_argument', 'params must be { "@name": value } or [{ name, value }]');
            }
            parameters = Array.isArray(parsed.data)
                ? (parsed.data as SqlParameter[])
                : Object.entries(parsed.data).map(([name, value]) => ({
                      name: name.startsWith('@') ? name : `@${name}`,
                      value: value as SqlParameter['value'],
                  }));
        }
        const plan: Plan = {
            database: this.#database(opts),
            container: opts.container,
            parameters,
            partitionKey: opts.partitionKey,
        };
        return { query, params: parameters, options: opts, plan };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const plan = prepared.plan as Plan;
        // A client of its own for the query, with every request bound to the query's abort signal: once the
        // query is aborted, nothing of it reaches the account any more, whatever the client still retries.
        const client = new CosmosClient(
            this.#clientOptions(
                guardedCosmosHttpClient(this.config.name, boundTo(context.signal, createDefaultHttpClient()))
            )
        );
        const container = client.database(plan.database).container(plan.container);
        const feedOptions: FeedOptions = {
            maxItemCount: PAGE_SIZE,
            maxDegreeOfParallelism: 4,
            abortSignal: context.signal,
            ...(plan.partitionKey !== undefined ? { partitionKey: plan.partitionKey as never } : {}),
            ...(this.config.lowPriority ? { priorityLevel: PriorityLevel.Low } : {}),
        };
        const iterator = container.items.query({ query: prepared.query, parameters: plan.parameters }, feedOptions);
        const budget = this.config.maxRuPerSec;
        const batches = async function* (): AsyncGenerator<unknown[]> {
            try {
                yield* queryPages(iterator, context, budget);
            } finally {
                client.dispose();
            }
        };
        return { format: 'ndjson', batches: batches() } satisfies DocumentStream;
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const client = this.#clientOrThrow;
        const parts = splitPath(path);
        const matches = compileFilter(filter);
        if (parts.length === 0) {
            const { resources } = await client.databases.readAll().fetchAll();
            return {
                level: 'databases',
                defaultDatabase: this.config.database ?? null,
                databases: resources.filter((d) => matches(d.id)).map((d) => ({ id: d.id })),
            };
        }
        const database = client.database(parts[0] as string);
        if (parts.length === 1) {
            const { resources } = await database.containers.readAll().fetchAll();
            return {
                level: 'containers',
                database: parts[0],
                containers: resources
                    .filter((c) => matches(c.id))
                    .map((c) => ({
                        id: c.id,
                        partitionKey: c.partitionKey?.paths ?? [],
                        defaultTtl: c.defaultTtl ?? null,
                    })),
            };
        }
        const container = database.container(parts[1] as string);
        const { resource } = await container.read();
        if (!resource) throw new PeriscopeError('not_found', `Container '${parts[0]}/${parts[1]}' not found`);
        const sample = await container.items
            .query(`SELECT TOP ${SAMPLE_SIZE} * FROM c`, { maxItemCount: SAMPLE_SIZE })
            .fetchNext();
        const inferrer = new SchemaInferrer();
        for (const document of sample.resources) inferrer.observe(document);
        const schema = inferrer.columns().filter((c) => matches(c.name) && !c.name.startsWith('_'));
        const raw = resource as unknown as Record<string, unknown>;
        return {
            level: 'container',
            database: parts[0],
            container: parts[1],
            partitionKey: resource.partitionKey ?? null,
            indexingPolicy: resource.indexingPolicy ?? null,
            vectorEmbeddingPolicy: raw.vectorEmbeddingPolicy ?? null,
            defaultTtl: resource.defaultTtl ?? null,
            sampledDocuments: sample.resources.length,
            inferredSchema: schema,
        };
    }

    async close(): Promise<void> {
        this.#client?.dispose();
    }
}
