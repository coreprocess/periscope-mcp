import { type CallToolResult, McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { claimsOf } from '../auth/entra.ts';
import { PeriscopeError, toPeriscopeError } from '../core/errors.ts';
import { toJson } from '../core/values.ts';
import { VERSION } from '../core/version.ts';
import { readFileWindow } from '../results/file-window.ts';
import { decodeFileReference } from '../results/files.ts';
import { type Caller, MAX_WAIT_MS, type ResultSnapshot } from '../results/service.ts';
import { downloadBase, LOCAL_CALLER, requireSource, type ToolContext } from './context.ts';

const SCHEMA_INLINE_COLUMNS = 200;
const DESCRIBE_TIMEOUT_MS = 45_000;

/** Bounds calls that have no result job around them, so a hanging source answers with an error. */
const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new PeriscopeError('timeout', `${what} did not answer within ${ms / 1000}s`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: toJson(value) }] });

const failure = (error: unknown): CallToolResult => {
    const e = toPeriscopeError(error);
    return {
        isError: true,
        content: [{ type: 'text', text: toJson({ error: { code: e.code, message: e.message } }) }],
    };
};

const callerOf = (context: ToolContext, ctx: ServerContext): Caller => {
    if (context.config.auth.mode === 'none') return LOCAL_CALLER;
    const claims = claimsOf(ctx.http?.authInfo);
    if (!claims) return { oid: 'anonymous', roles: new Set() };
    return { oid: claims.oid, name: claims.name, roles: new Set(claims.roles) };
};

const sourceOfResult = async (context: ToolContext, resultId: string): Promise<ResultSnapshot> => {
    const snapshot = await context.service.snapshot(resultId);
    requireSource(context, snapshot.manifest.source);
    return snapshot;
};

/** Shapes a snapshot into the `get_result` response (concept §5.3). */
const describeResult = (context: ToolContext, caller: Caller, { manifest, state }: ResultSnapshot) => {
    const availableRows = manifest.files.reduce((sum, part) => sum + part.rowCount, 0);
    const columns = manifest.schema.columns;
    const download: Record<string, unknown> = {
        format: manifest.format,
        ...(manifest.compression ? { compression: manifest.compression } : {}),
        fileCount: manifest.files.length,
        bytes: manifest.bytes,
        ...(manifest.blobCount !== undefined ? { blobCount: manifest.blobCount, blobBytes: manifest.blobBytes } : {}),
    };
    if (manifest.status !== 'expired') {
        const { base, expiresAt } = downloadBase(context, caller, manifest.resultId, manifest.expiresAt);
        download.manifestUrl = `${base}/manifest.json`;
        download.urlExpiresAt = expiresAt;
    }
    const active = manifest.status === 'running' || manifest.status === 'queued';
    return {
        resultId: manifest.resultId,
        status: manifest.status,
        source: manifest.source,
        createdAt: manifest.createdAt,
        ...(manifest.completedAt ? { completedAt: manifest.completedAt } : {}),
        expiresAt: manifest.expiresAt,
        rowCount: manifest.rowCount,
        availableRows,
        schema: { columns: columns.slice(0, SCHEMA_INLINE_COLUMNS) },
        ...(columns.length > SCHEMA_INLINE_COLUMNS ? { schemaTruncated: true } : {}),
        window: context.config.read,
        download,
        ...(active && state ? { progress: { ...state.progress, elapsedMs: state.stats.elapsedMs } } : {}),
        stats: state?.stats ?? null,
        ...(manifest.mayContainDuplicates ? { mayContainDuplicates: true } : {}),
        error: manifest.error ?? null,
    };
};

const audit = (context: ToolContext, caller: Caller, tool: string, details: Record<string, unknown>): void => {
    context.loggers.audit.info({ event: 'tool', tool, user: caller.oid, userName: caller.name, ...details }, 'tool');
};

export const createMcpServer = (context: ToolContext): McpServer => {
    const server = new McpServer(
        { name: 'periscope-mcp', version: VERSION },
        {
            instructions:
                'Read-only access to data sources. Start with list_sources and describe. query starts a query and returns a resultId; ' +
                'get_result reports status, schema and a manifest URL for downloading the full result; read_result pages through it in context. ' +
                'Prefer downloading large results (curl, DuckDB, jq) over paging them into context.',
        }
    );

    server.registerTool(
        'list_sources',
        {
            title: 'List data sources',
            description:
                'Lists the data sources you may query: name, type, query language, dialect hints, options, limits and the active read-only layers.',
            inputSchema: z.object({}),
            annotations: READ_ONLY,
        },
        async (_args, ctx) => {
            const caller = callerOf(context, ctx);
            try {
                await context.registry.settle(20_000);
                const sources = context.registry.configs().map((config) => {
                    const status = context.registry.status(config.name);
                    const adapter = context.registry.peek(config.name);
                    return {
                        ...(adapter?.info() ?? { name: config.name, type: config.type }),
                        available: status.available,
                        ...(status.error ? { unavailableReason: status.error } : {}),
                        limits: {
                            maxQueryDuration: `${config.maxQueryDurationMs / 1000}s`,
                            maxResultBytes: config.maxResultBytes,
                        },
                    };
                });
                audit(context, caller, 'list_sources', { count: sources.length });
                return json({ sources });
            } catch (error) {
                return failure(error);
            }
        }
    );

    server.registerTool(
        'describe',
        {
            title: 'Describe metadata',
            description:
                'Browses metadata of a source step by step (schemas/tables/columns, databases/containers with sampled schemas, ' +
                'blob prefixes, Log Analytics tables, Redis key prefixes). Use path to drill down and filter (with * wildcards) to narrow.',
            inputSchema: z.object({
                source: z.string().describe('Source name from list_sources'),
                path: z
                    .string()
                    .optional()
                    .describe('Level to describe, e.g. "public.orders", "main/claims", "invoices/2026/"'),
                filter: z.string().optional().describe('Name pattern, * and ? wildcards'),
            }),
            annotations: READ_ONLY,
        },
        async ({ source, path, filter }, ctx) => {
            const caller = callerOf(context, ctx);
            try {
                requireSource(context, source);
                const adapter = await context.registry.get(source);
                const result = await withTimeout(adapter.describe(path, filter), DESCRIBE_TIMEOUT_MS, 'describe');
                audit(context, caller, 'describe', { source, path });
                return json(result);
            } catch (error) {
                return failure(error);
            }
        }
    );

    server.registerTool(
        'query',
        {
            title: 'Start a query',
            description:
                'Starts a read-only query and returns a resultId immediately. Query language depends on the source (see list_sources). ' +
                'Invalid or non-read-only queries are rejected right away with a reason. Then call get_result / read_result.',
            inputSchema: z.object({
                source: z.string().describe('Source name from list_sources'),
                query: z.string().min(1).describe('SQL, Cosmos SQL, KQL, a blob glob or a Redis command'),
                params: z.unknown().optional().describe('Bind parameters (format depends on the source)'),
                options: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Type-specific options (see list_sources)'),
            }),
            annotations: { ...READ_ONLY, idempotentHint: false },
        },
        async ({ source, query, params, options }, ctx) => {
            const caller = callerOf(context, ctx);
            try {
                requireSource(context, source);
                const adapter = await context.registry.get(source);
                const prepared = await adapter.validate(query, params, options ?? {});
                const resultId = await context.service.start(adapter, prepared, caller);
                audit(context, caller, 'query', { source, resultId, query });
                return json({
                    resultId,
                    status: 'queued',
                    next: 'Call get_result (optionally with wait) for status, schema and download; read_result for rows.',
                });
            } catch (error) {
                audit(context, caller, 'query', { source, query, rejected: toPeriscopeError(error).message });
                return failure(error);
            }
        }
    );

    server.registerTool(
        'get_result',
        {
            title: 'Get result status and metadata',
            description:
                'Status, progress, schema, row counts, window limits and download information (one manifest URL; all files are listed in the manifest). ' +
                `Use wait (seconds, max ${MAX_WAIT_MS / 1000}) to wait for a status change.`,
            inputSchema: z.object({
                resultId: z.string(),
                wait: z
                    .number()
                    .min(0)
                    .max(MAX_WAIT_MS / 1000)
                    .optional()
                    .describe('Seconds to wait for a status change'),
            }),
            annotations: READ_ONLY,
        },
        async ({ resultId, wait }, ctx) => {
            const caller = callerOf(context, ctx);
            try {
                await sourceOfResult(context, resultId);
                const snapshot = await context.service.snapshot(resultId, (wait ?? 0) * 1000);
                return json(describeResult(context, caller, snapshot));
            } catch (error) {
                return failure(error);
            }
        }
    );

    server.registerTool(
        'read_result',
        {
            title: 'Read a window of a result',
            description:
                'Returns one window of a result inline: rows (offset, limit, optional columns), or for blob results the content of a ' +
                'referenced text file by line range (file, lineOffset, lineLimit) or an image (file). Long values are truncated; downloads keep full values.',
            inputSchema: z.object({
                resultId: z.string(),
                offset: z.number().int().min(0).optional(),
                limit: z.number().int().min(1).optional(),
                columns: z.array(z.string()).optional().describe('Columns or JSON paths (documents) to return'),
                file: z.string().optional().describe('Blob results: the file path from a listing row'),
                lineOffset: z.number().int().min(0).optional(),
                lineLimit: z.number().int().min(1).optional(),
            }),
            annotations: READ_ONLY,
        },
        async ({ resultId, offset, limit, columns, file, lineOffset, lineLimit }, ctx) => {
            const caller = callerOf(context, ctx);
            try {
                const { manifest } = await sourceOfResult(context, resultId);
                if (!file) {
                    const window = await context.service.readRows(resultId, offset ?? 0, limit ?? 100, columns);
                    return json(window);
                }
                const adapter = await context.registry.get(manifest.source);
                const reference = decodeFileReference(context.signer, resultId, file);
                if (!adapter.files || !reference)
                    throw toPeriscopeError(new Error('Unknown file for this result'), 'not_found');
                const window = await readFileWindow({
                    store: context.service.store,
                    resultId,
                    file,
                    reference,
                    provider: adapter.files,
                    lineOffset: lineOffset ?? 0,
                    lineLimit: Math.min(lineLimit ?? 200, 5000),
                    maxBytes: context.config.read.maxBytes,
                });
                audit(context, caller, 'read_result', { resultId, file: reference.name });
                if (window.kind === 'image') {
                    return {
                        content: [
                            { type: 'image', data: window.data, mimeType: window.mimeType },
                            { type: 'text', text: toJson({ file: window.file, bytes: window.bytes }) },
                        ],
                    };
                }
                return json(window);
            } catch (error) {
                return failure(error);
            }
        }
    );

    server.registerTool(
        'cancel_query',
        {
            title: 'Cancel a running query',
            description: 'Stops a running query. Parts already written stay readable until the result expires.',
            inputSchema: z.object({ resultId: z.string() }),
            annotations: { ...READ_ONLY, idempotentHint: true },
        },
        async ({ resultId }, ctx) => {
            const caller = callerOf(context, ctx);
            try {
                await sourceOfResult(context, resultId);
                const snapshot = await context.service.cancel(resultId);
                audit(context, caller, 'cancel_query', { resultId });
                return json(describeResult(context, caller, snapshot));
            } catch (error) {
                return failure(error);
            }
        }
    );

    return server;
};
