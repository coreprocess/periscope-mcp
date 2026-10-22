import { DefaultAzureCredential } from '@azure/identity';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { LogAnalyticsSourceConfig } from '../../config/sources.ts';
import { parseIsoDuration } from '../../core/duration.ts';
import { PeriscopeError, QueryRejectedError, WireGuardError } from '../../core/errors.ts';
import { type ParquetColumn, scalarColumn, timestampColumn } from '../../results/parquet/columns.ts';
import type {
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
    TabularStream,
} from '../adapter.ts';
import { filterRegex, parseOptions, remaining } from '../common.ts';

/**
 * Log Analytics (and workspace-based Application Insights) through the query REST API.
 * The API has no write operations; Periscope only ever POSTs to the query endpoint and
 * requests tokens only for the query API audience (concept §7.1 A).
 */

const BATCH_ROWS = 5000;
const MAX_SPLIT_DEPTH = 8;

const optionsSchema = z.object({ timespan: z.string().min(1).optional() }).strict();

export type TokenProvider = () => Promise<string>;

interface KqlColumn {
    name: string;
    type: string;
}
interface KqlTable {
    name: string;
    columns: KqlColumn[];
    rows: unknown[][];
}
interface KqlResponse {
    tables?: KqlTable[];
    error?: { code?: string; message?: string; innererror?: { code?: string; message?: string } };
}

class ResultTooLargeError extends Error {}

/** Operators after which rows are no longer independent per time window. */
const NON_SPLITTABLE =
    /\b(summarize|count|dcount|top|top-nested|take|limit|sample|sort|order|distinct|join|lookup|make-series|evaluate|serialize|row_number|prev|next|scan|partition|render|as|fork|facet)\b/i;

const stripStrings = (kql: string): string => kql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

export const isSplittable = (kql: string): boolean => !NON_SPLITTABLE.test(stripStrings(kql));

/** Resolves a timespan option (duration or `start/end` interval) to absolute bounds. */
export const resolveTimespan = (timespan: string, now = Date.now()): { start: number; end: number } => {
    if (timespan.includes('/')) {
        const [a, b] = timespan.split('/') as [string, string];
        const start = a.startsWith('P') ? Date.parse(b) - parseIsoDuration(a) : Date.parse(a);
        const end = b.startsWith('P') ? Date.parse(a) + parseIsoDuration(b) : Date.parse(b);
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
            throw new PeriscopeError('invalid_argument', `Invalid timespan interval '${timespan}'`);
        }
        return { start, end };
    }
    return { start: now - parseIsoDuration(timespan), end: now };
};

const toInterval = ({ start, end }: { start: number; end: number }): string =>
    `${new Date(start).toISOString()}/${new Date(end).toISOString()}`;

const datetimeToMicros = (value: string): bigint => {
    const match = /^(.*?)(?:\.(\d+))?Z?$/.exec(value);
    const millis = Date.parse(`${match?.[1] ?? value}Z`);
    const fraction = (match?.[2] ?? '').padEnd(6, '0').slice(0, 6);
    return BigInt(millis) * 1000n + BigInt(fraction);
};

interface MappedKql {
    column: ParquetColumn;
    convert: (value: unknown) => unknown;
}

const passString = (value: unknown): unknown =>
    value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);

export const mapKqlColumn = (column: KqlColumn): MappedKql => {
    const extra = { sourceType: column.type };
    switch (column.type) {
        case 'bool':
        case 'boolean':
            return {
                column: scalarColumn(column.name, 'boolean', extra),
                convert: (v) => (v === null || v === undefined ? null : v === true || v === 1 || v === 'true'),
            };
        case 'int':
            return {
                column: scalarColumn(column.name, 'int32', extra),
                convert: (v) => (v === null ? null : Number(v)),
            };
        case 'long':
            return {
                column: scalarColumn(column.name, 'int64', extra),
                convert: (v) => (v === null || v === undefined ? null : BigInt(v as number | string)),
            };
        case 'real':
            return {
                column: scalarColumn(column.name, 'double', extra),
                convert: (v) => (v === null ? null : Number(v)),
            };
        case 'datetime':
            return {
                column: timestampColumn(column.name, true, extra),
                convert: (v) => (v === null || v === undefined || v === '' ? null : datetimeToMicros(String(v))),
            };
        case 'dynamic':
            return { column: scalarColumn(column.name, 'json', extra), convert: passString };
        case 'decimal':
            return {
                column: scalarColumn(column.name, 'string', { ...extra, note: 'KQL decimal stored as exact text' }),
                convert: passString,
            };
        default:
            return { column: scalarColumn(column.name, 'string', extra), convert: passString };
    }
};

export class LogAnalyticsAdapter implements SourceAdapter {
    readonly config: LogAnalyticsSourceConfig;
    readonly #tokenProvider: TokenProvider | undefined;
    #token: TokenProvider | undefined;

    constructor(config: LogAnalyticsSourceConfig, options: { tokenProvider?: TokenProvider } = {}) {
        this.config = config;
        this.#tokenProvider = options.tokenProvider;
    }

    async init(_log: Logger): Promise<void> {
        if (this.#tokenProvider) {
            this.#token = this.#tokenProvider;
            return;
        }
        const credential = new DefaultAzureCredential();
        const scope = `${this.config.endpoint}/.default`;
        this.#token = async () => (await credential.getToken(scope)).token;
    }

    get #queryUrl(): string {
        const c = this.config;
        return c.workspaceId
            ? `${c.endpoint}/v1/workspaces/${encodeURIComponent(c.workspaceId)}/query`
            : `${c.endpoint}/v1${c.resourceId}/query`;
    }

    /** The only network call this source makes. */
    async #query(kql: string, timespan: string, signal: AbortSignal, timeoutMs: number): Promise<KqlTable> {
        const url = this.#queryUrl;
        if (!url.startsWith(`${this.config.endpoint}/v1/`) || !url.endsWith('/query')) {
            throw new WireGuardError(this.config.name, `POST ${url}`);
        }
        if (!this.#token) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        const waitSeconds = Math.max(Math.min(Math.floor(timeoutMs / 1000), 600), 1);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${await this.#token()}`,
                'content-type': 'application/json',
                prefer: `wait=${waitSeconds}`,
            },
            body: JSON.stringify({ query: kql, timespan }),
            signal,
        });
        const body = (await response.json().catch(() => ({}))) as KqlResponse;
        const message = [body.error?.message, body.error?.innererror?.message].filter(Boolean).join(': ');
        if (/exceed|too large|limit/i.test(message) && /record|size|result/i.test(message)) {
            throw new ResultTooLargeError(message);
        }
        if (!response.ok || body.error) {
            throw new PeriscopeError('source_error', message || `Log Analytics returned ${response.status}`);
        }
        const table = body.tables?.[0];
        if (!table) throw new PeriscopeError('source_error', 'Log Analytics returned no table');
        return table;
    }

    info(): SourceInfo {
        return {
            name: this.config.name,
            type: 'loganalytics',
            description: this.config.description,
            queryLanguage: 'KQL (Kusto Query Language)',
            dialectHints: [
                `Time range comes from options.timespan (default ${this.config.defaultTimespan}); no need to filter TimeGenerated for it.`,
                this.config.resourceId
                    ? 'Scoped to one Application Insights resource: classic table names work (requests, dependencies, traces, exceptions).'
                    : 'Workspace tables for Application Insights: AppRequests, AppDependencies, AppTraces, AppExceptions, AppEvents, AppMetrics.',
                'A single query returns at most ~500k rows / ~100 MB. Row-level queries larger than that are split into time windows automatically; aggregate first otherwise.',
                'Control commands (starting with ".") are not available.',
            ],
            options: {
                timespan: 'ISO 8601 duration (P7D, PT6H) or interval (2026-01-01T00:00:00Z/2026-01-02T00:00:00Z)',
            },
            params: 'not used',
            readOnlyLayers: [
                'query API only (it has no write operations)',
                'single hard-coded endpoint; tokens only for the query API audience',
                'control commands rejected',
            ],
            credential: 'read-only verified',
            credentialNote: 'the Log Analytics query API cannot modify data',
        };
    }

    async validate(query: string, _params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const trimmed = query.trim();
        if (!trimmed) throw new PeriscopeError('invalid_argument', 'query must not be empty');
        if (trimmed.startsWith('.')) throw new QueryRejectedError('Control commands are not allowed');
        const timespan = opts.timespan ?? this.config.defaultTimespan;
        resolveTimespan(timespan);
        return { query: trimmed, params: null, options: { ...opts, timespan } };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const timespan = prepared.options.timespan as string;
        const tables: KqlTable[] = [];
        const run = async (window: string, depth: number): Promise<void> => {
            try {
                tables.push(await this.#query(prepared.query, window, context.signal, remaining(context.deadline)));
            } catch (error) {
                if (!(error instanceof ResultTooLargeError)) throw error;
                if (!isSplittable(prepared.query) || depth >= MAX_SPLIT_DEPTH) {
                    throw new PeriscopeError(
                        'too_large',
                        `${error.message}. The query cannot be split into time windows (it aggregates, sorts or limits); aggregate further or narrow the timespan`
                    );
                }
                const { start, end } = resolveTimespan(window);
                const middle = start + Math.floor((end - start) / 2);
                context.log.info({ window, depth }, 'splitting log analytics query into two time windows');
                await run(toInterval({ start, end: middle }), depth + 1);
                await run(toInterval({ start: middle, end }), depth + 1);
            }
        };
        await run(toInterval(resolveTimespan(timespan)), 0);
        const first = tables[0] as KqlTable;
        const mapped = first.columns.map(mapKqlColumn);
        for (const table of tables) {
            if (table.columns.map((c) => c.name).join('\u0000') !== first.columns.map((c) => c.name).join('\u0000')) {
                throw new PeriscopeError('source_error', 'Time windows returned different columns; narrow the query');
            }
        }
        const batches = async function* (): AsyncGenerator<unknown[][]> {
            for (const table of tables) {
                for (let i = 0; i < table.rows.length; i += BATCH_ROWS) {
                    yield table.rows
                        .slice(i, i + BATCH_ROWS)
                        .map((row) => row.map((value, c) => (mapped[c] as MappedKql).convert(value)));
                }
            }
        };
        return { format: 'parquet', columns: mapped.map((m) => m.column), batches: batches() } satisfies TabularStream;
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const signal = AbortSignal.timeout(120_000);
        const timespan = toInterval(resolveTimespan(this.config.defaultTimespan));
        const matches = filterRegex(filter);
        if (!path) {
            const table = await this.#query(
                'union withsource=_Table * | summarize rows = count() by _Table | order by _Table asc',
                timespan,
                signal,
                120_000
            );
            return {
                level: 'tables',
                timespan: this.config.defaultTimespan,
                tables: table.rows
                    .filter((row) => matches.test(String(row[0])))
                    .map((row) => ({ table: row[0], rows: row[1] })),
            };
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(path))
            throw new PeriscopeError('invalid_argument', `Invalid table name '${path}'`);
        const schema = await this.#query(`${path} | getschema`, timespan, signal, 120_000);
        const index = (name: string): number => schema.columns.findIndex((c) => c.name === name);
        const nameAt = index('ColumnName');
        const typeAt = index('ColumnType');
        return {
            level: 'table',
            table: path,
            columns: schema.rows
                .filter((row) => matches.test(String(row[nameAt])))
                .map((row) => ({ name: row[nameAt], type: row[typeAt] })),
        };
    }

    async close(): Promise<void> {}
}
