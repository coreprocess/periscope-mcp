import { CosmosClient, type FeedOptions, PriorityLevel, type SqlParameter } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { CosmosSourceConfig } from '../../config/sources.ts';
import { PeriscopeError } from '../../core/errors.ts';
import { SchemaInferrer } from '../../results/infer.ts';
import type {
    DocumentStream,
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { filterRegex, parseOptions, splitPath } from '../common.ts';
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

/** Cosmos DB for NoSQL: queries and metadata only; writes are never offered and blocked on the wire. */
export class CosmosAdapter implements SourceAdapter {
    readonly config: CosmosSourceConfig;
    #client: CosmosClient | undefined;

    constructor(config: CosmosSourceConfig) {
        this.config = config;
    }

    async init(_log: Logger): Promise<void> {
        const c = this.config;
        this.#client = new CosmosClient({
            endpoint: c.endpoint,
            ...(c.azureAuth ? { aadCredentials: new DefaultAzureCredential() } : { key: c.key as string }),
            httpClient: guardedCosmosHttpClient(c.name),
            userAgentSuffix: 'periscope-mcp',
            connectionPolicy: {
                enableEndpointDiscovery: !/localhost|127\.0\.0\.1/.test(c.endpoint),
                requestTimeout: 30_000,
            },
        });
        // Fail fast for unreachable or deleted accounts; the registry retries later.
        try {
            await this.#client.getDatabaseAccount({ abortSignal: AbortSignal.timeout(15_000) });
        } catch (error) {
            const reason =
                (error as { name?: string }).name === 'AbortError' ? 'no answer within 15s' : (error as Error).message;
            throw new PeriscopeError(
                'source_error',
                `Cosmos account ${new URL(c.endpoint).host} is not reachable (${reason})`
            );
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
        const container = this.#clientOrThrow.database(plan.database).container(plan.container);
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
            while (iterator.hasMoreResults()) {
                if (context.signal.aborted) return;
                const started = Date.now();
                const page = await iterator.fetchNext().catch((error: unknown) => {
                    throw new PeriscopeError('source_error', error instanceof Error ? error.message : String(error));
                });
                const ru = page.requestCharge ?? 0;
                context.addCost({ ru });
                if (page.resources && page.resources.length > 0) yield page.resources;
                if (budget && ru > 0) {
                    const minimum = (ru / budget) * 1000;
                    const elapsed = Date.now() - started;
                    if (minimum > elapsed) await sleep(minimum - elapsed, context.signal);
                }
            }
        };
        return { format: 'ndjson', batches: batches() } satisfies DocumentStream;
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const client = this.#clientOrThrow;
        const parts = splitPath(path);
        const matches = filterRegex(filter);
        if (parts.length === 0) {
            const { resources } = await client.databases.readAll().fetchAll();
            return {
                level: 'databases',
                defaultDatabase: this.config.database ?? null,
                databases: resources.filter((d) => matches.test(d.id)).map((d) => ({ id: d.id })),
            };
        }
        const database = client.database(parts[0] as string);
        if (parts.length === 1) {
            const { resources } = await database.containers.readAll().fetchAll();
            return {
                level: 'containers',
                database: parts[0],
                containers: resources
                    .filter((c) => matches.test(c.id))
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
        const schema = inferrer.columns().filter((c) => matches.test(c.name) && !c.name.startsWith('_'));
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
