import type { Readable } from 'node:stream';
import { type BlobItem, type BlobServiceClient, RestError } from '@azure/storage-blob';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { BlobSourceConfig } from '../../config/sources.ts';
import { PeriscopeError } from '../../core/errors.ts';
import { compileFilter, compileGlob } from '../../core/glob.ts';
import type {
    CredentialState,
    DocumentStream,
    ExecutionContext,
    FileContent,
    FileProvider,
    FileReference,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { parseOptions } from '../common.ts';
import { createBlobClient } from './client.ts';

const PAGE_SIZE = 5000;
const DESCRIBE_LIMIT = 1000;

const includeValues = ['metadata', 'tags', 'versions', 'snapshots'] as const;

const optionsSchema = z
    .object({
        container: z.string().min(1).optional(),
        tagFilter: z.string().min(1).optional(),
        include: z.array(z.enum(includeValues)).optional(),
    })
    .strict();

interface Plan {
    container: string | undefined;
    tagFilter: string | undefined;
    include: Set<(typeof includeValues)[number]>;
}

const toRow = (container: string, item: BlobItem, context: ExecutionContext, include: Plan['include']) => {
    const props = item.properties;
    const reference: FileReference = {
        container,
        name: item.name,
        ...(props.etag ? { etag: props.etag } : {}),
        ...(item.snapshot ? { snapshot: item.snapshot } : {}),
        ...(item.versionId && !item.isCurrentVersion ? { versionId: item.versionId } : {}),
    };
    return {
        container,
        name: item.name,
        size: props.contentLength ?? 0,
        contentType: props.contentType ?? null,
        lastModified: props.lastModified?.toISOString() ?? null,
        etag: props.etag ?? null,
        accessTier: props.accessTier ?? null,
        ...(item.snapshot ? { snapshot: item.snapshot } : {}),
        ...(item.versionId ? { versionId: item.versionId, isCurrentVersion: item.isCurrentVersion ?? false } : {}),
        ...(include.has('metadata') ? { metadata: item.metadata ?? {} } : {}),
        ...(include.has('tags') ? { tags: item.tags ?? {} } : {}),
        file: context.fileReference(reference),
    };
};

const mapRestError = (error: unknown): never => {
    if (error instanceof RestError) {
        if (error.statusCode === 412) {
            throw new PeriscopeError('precondition_failed', 'The blob changed after the query; run the query again');
        }
        if (error.statusCode === 404) throw new PeriscopeError('not_found', 'The blob no longer exists');
        if (error.statusCode === 416) throw new PeriscopeError('invalid_argument', 'Requested range not satisfiable');
    }
    throw error;
};

/** Azure Blob Storage: listings as results, contents referenced in place and served read-only. */
export class BlobAdapter implements SourceAdapter, FileProvider {
    readonly config: BlobSourceConfig;
    #client: BlobServiceClient | undefined;
    #credential: CredentialState = 'unverified';
    #credentialNote = '';

    constructor(config: BlobSourceConfig) {
        this.config = config;
    }

    get files(): FileProvider {
        return this;
    }

    async init(_log: Logger): Promise<void> {
        const setup = createBlobClient(this.config);
        this.#client = setup.client;
        this.#credential = setup.credential;
        this.#credentialNote = setup.credentialNote;
    }

    get #clientOrThrow(): BlobServiceClient {
        if (!this.#client) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        return this.#client;
    }

    info(): SourceInfo {
        return {
            name: this.config.name,
            type: 'blob',
            description: this.config.description,
            queryLanguage: 'Blob selection: a glob or prefix relative to the container',
            dialectHints: [
                "Query is a glob: '**' matches across '/', '*' and '?' within one path segment; no wildcard means prefix.",
                "Examples: 'invoices/2026/**/*.pdf', 'logs/app-*.log', 'exports/' (everything under a prefix).",
                "options.tagFilter uses blob index tag syntax, e.g. \"status = 'open' AND year >= '2026'\".",
                'Each row has a `file` path: read text/images with read_result(file=…), download other files.',
            ],
            options: {
                container: `string: container${this.config.container ? ` (default '${this.config.container}')` : ' (required unless tagFilter is used)'}`,
                tagFilter: 'string: blob index tag filter expression',
                include: "array of 'metadata', 'tags', 'versions', 'snapshots'",
            },
            params: 'not used',
            readOnlyLayers: [
                'only list and read operations implemented',
                'wire guard: only GET/HEAD requests reach the network',
                'downloads pinned to the ETag, version or snapshot listed by the query',
            ],
            credential: this.#credential,
            credentialNote: this.#credentialNote,
        };
    }

    async validate(query: string, _params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const container = opts.container ?? this.config.container;
        if (!container && !opts.tagFilter) {
            throw new PeriscopeError('invalid_argument', 'options.container is required (or use options.tagFilter)');
        }
        compileGlob(query);
        const plan: Plan = { container, tagFilter: opts.tagFilter, include: new Set(opts.include ?? []) };
        return { query, params: null, options: opts, plan };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const plan = prepared.plan as Plan;
        const glob = compileGlob(prepared.query);
        const client = this.#clientOrThrow;
        let count = 0;
        let bytes = 0;
        const track = (row: { size: number }): void => {
            count++;
            bytes += row.size;
        };
        const listing = async function* (): AsyncGenerator<unknown[]> {
            if (plan.tagFilter) {
                const iterator = plan.container
                    ? client.getContainerClient(plan.container).findBlobsByTags(plan.tagFilter)
                    : client.findBlobsByTags(plan.tagFilter);
                for await (const page of iterator.byPage({ maxPageSize: PAGE_SIZE })) {
                    if (context.signal.aborted) return;
                    const rows: unknown[] = [];
                    for (const match of page.blobs) {
                        if (!glob.matches(match.name)) continue;
                        const blob = client.getContainerClient(match.containerName).getBlobClient(match.name);
                        const props = await blob.getProperties();
                        const row = toRow(
                            match.containerName,
                            {
                                name: match.name,
                                deleted: false,
                                snapshot: '',
                                properties: {
                                    ...props,
                                    lastModified: props.lastModified ?? new Date(0),
                                    etag: props.etag ?? '',
                                },
                                tags: match.tags,
                            } as unknown as BlobItem,
                            context,
                            new Set([...plan.include, 'tags'])
                        );
                        track(row);
                        rows.push(row);
                    }
                    if (rows.length) yield rows;
                }
                return;
            }
            const container = client.getContainerClient(plan.container as string);
            const iterator = container.listBlobsFlat({
                prefix: glob.prefix || undefined,
                includeMetadata: plan.include.has('metadata'),
                includeTags: plan.include.has('tags'),
                includeVersions: plan.include.has('versions'),
                includeSnapshots: plan.include.has('snapshots'),
            });
            for await (const page of iterator.byPage({ maxPageSize: PAGE_SIZE })) {
                if (context.signal.aborted) return;
                const rows = page.segment.blobItems
                    .filter((item) => glob.matches(item.name))
                    .map((item) => toRow(plan.container as string, item, context, plan.include));
                for (const row of rows) track(row);
                if (rows.length) yield rows;
            }
        };
        return {
            format: 'ndjson',
            batches: listing(),
            blobTotals: () => ({ count, bytes }),
        } satisfies DocumentStream;
    }

    async openFile(reference: FileReference, range?: { offset: number; length: number }): Promise<FileContent> {
        let blob = this.#clientOrThrow.getContainerClient(reference.container).getBlobClient(reference.name);
        if (reference.versionId) blob = blob.withVersion(reference.versionId);
        if (reference.snapshot) blob = blob.withSnapshot(reference.snapshot);
        const conditions = reference.etag ? { ifMatch: reference.etag } : undefined;
        try {
            const response = await blob.download(range?.offset ?? 0, range ? Math.max(range.length, 1) : undefined, {
                ...(conditions ? { conditions } : {}),
            });
            const total = response.contentRange
                ? Number(response.contentRange.split('/')[1])
                : Number(response.contentLength ?? 0);
            const start = range?.offset ?? 0;
            const end = start + Number(response.contentLength ?? 0) - 1;
            return {
                size: total,
                contentType: response.contentType ?? 'application/octet-stream',
                etag: response.etag ?? reference.etag ?? '',
                stream: response.readableStreamBody as Readable,
                ...(range ? { range: { start, end } } : {}),
            };
        } catch (error) {
            return mapRestError(error);
        }
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const client = this.#clientOrThrow;
        const matches = compileFilter(filter);
        const trimmed = (path ?? '').replace(/^\/+/, '');
        if (!trimmed) {
            const containers: { name: string; lastModified: string | null }[] = [];
            for await (const container of client.listContainers()) {
                if (matches(container.name)) {
                    containers.push({
                        name: container.name,
                        lastModified: container.properties.lastModified?.toISOString() ?? null,
                    });
                }
                if (containers.length >= DESCRIBE_LIMIT) break;
            }
            return { level: 'containers', defaultContainer: this.config.container ?? null, containers };
        }
        const slash = trimmed.indexOf('/');
        const containerName = slash === -1 ? trimmed : trimmed.slice(0, slash);
        const prefix = slash === -1 ? '' : trimmed.slice(slash + 1).replace(/([^/])$/, '$1/');
        const container = client.getContainerClient(containerName);
        const prefixes: string[] = [];
        const blobs: { name: string; size: number; contentType: string | null; lastModified: string | null }[] = [];
        let truncated = false;
        for await (const item of container.listBlobsByHierarchy('/', { prefix })) {
            const leaf = item.name.slice(prefix.length).replace(/\/$/, '');
            if (!matches(leaf)) continue;
            if (prefixes.length + blobs.length >= DESCRIBE_LIMIT) {
                truncated = true;
                break;
            }
            if (item.kind === 'prefix') prefixes.push(item.name);
            else {
                blobs.push({
                    name: item.name,
                    size: item.properties.contentLength ?? 0,
                    contentType: item.properties.contentType ?? null,
                    lastModified: item.properties.lastModified?.toISOString() ?? null,
                });
            }
        }
        return { level: 'prefix', container: containerName, prefix, prefixes, blobs, truncated };
    }

    async close(): Promise<void> {
        // the blob client holds no connections that need closing
    }
}
