import { DefaultAzureCredential } from '@azure/identity';
import pg from 'pg';
import Cursor from 'pg-cursor';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { PostgresSourceConfig } from '../../config/sources.ts';
import { PeriscopeError, QueryRejectedError } from '../../core/errors.ts';
import type {
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
    TabularStream,
} from '../adapter.ts';
import { likePattern, parseOptions, remaining, splitPath } from '../common.ts';
import { ensureParser, parseReadOnlyQuery } from './guard.ts';
import { loadInventory, type PostgresInventory } from './inventory.ts';
import { type ExtensionTypes, type FieldDescription, mapField, SESSION_SETTINGS, typeParsers } from './types.ts';

const BATCH_ROWS = 5_000;
const ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const INVENTORY_TTL_MS = 10 * 60_000;

const optionsSchema = z
    .object({
        explain: z.boolean().optional(),
        analyze: z.boolean().optional(),
    })
    .strict();

const paramsSchema = z.array(
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
);

interface Plan {
    sql: string;
}

/** Postgres source: read-only transaction, syntax-tree guard, routine inventory (concept §7.1 B). */
export class PostgresAdapter implements SourceAdapter {
    readonly config: PostgresSourceConfig;
    #pool: pg.Pool | undefined;
    #inventory: PostgresInventory | undefined;
    #inventoryAt = 0;
    #extension: ExtensionTypes = { vector: new Set() };
    #log: Logger | undefined;

    constructor(config: PostgresSourceConfig) {
        this.config = config;
    }

    async init(log: Logger): Promise<void> {
        this.#log = log;
        await ensureParser();
        const c = this.config;
        const credential = c.azureAuth ? new DefaultAzureCredential() : undefined;
        const ssl =
            c.ssl === 'disable'
                ? false
                : c.ssl === 'require'
                  ? { rejectUnauthorized: false }
                  : c.ssl === 'verify-full'
                    ? { rejectUnauthorized: true }
                    : undefined;
        this.#pool = new pg.Pool({
            ...(c.url ? { connectionString: c.url } : {}),
            ...(c.host ? { host: c.host } : {}),
            ...(c.port ? { port: c.port } : {}),
            ...(c.database ? { database: c.database } : {}),
            ...(c.user ? { user: c.user } : {}),
            ...(credential
                ? {
                      password: async () => {
                          const token = await credential.getToken(ENTRA_SCOPE);
                          return token.token;
                      },
                  }
                : c.password
                  ? { password: c.password }
                  : {}),
            ...(ssl !== undefined ? { ssl } : {}),
            application_name: 'periscope-mcp',
            options: '-c default_transaction_read_only=on',
            max: 10,
            idleTimeoutMillis: 60_000,
            connectionTimeoutMillis: 15_000,
        });
        this.#pool.on('error', (error) => log.warn({ err: error, source: c.name }, 'postgres pool error'));
        await this.#refreshInventory();
    }

    /** Session settings for exact types, plus the configured search path. */
    get #session(): string {
        return this.config.searchPath
            ? `${SESSION_SETTINGS}; SET search_path TO ${this.config.searchPath}`
            : SESSION_SETTINGS;
    }

    get #poolOrThrow(): pg.Pool {
        if (!this.#pool) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        return this.#pool;
    }

    /** Runs `fn` in a REPEATABLE READ READ ONLY transaction that is always rolled back. */
    async #readOnly<T>(fn: (client: pg.PoolClient) => Promise<T>, timeoutMs = 60_000): Promise<T> {
        const client = await this.#poolOrThrow.connect();
        try {
            await client.query(this.#session);
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query(`SET LOCAL statement_timeout = ${Math.ceil(timeoutMs)}`);
            return await fn(client);
        } finally {
            await this.#release(client);
        }
    }

    async #release(client: pg.PoolClient, destroy = false): Promise<void> {
        try {
            await client.query('ROLLBACK');
            // Session-level advisory locks survive ROLLBACK.
            await client.query('SELECT pg_advisory_unlock_all()');
            client.release();
        } catch (error) {
            client.release(destroy ? true : (error as Error));
        }
    }

    async #refreshInventory(): Promise<PostgresInventory> {
        if (this.#inventory && Date.now() - this.#inventoryAt < INVENTORY_TTL_MS) return this.#inventory;
        const inventory = await this.#readOnly(async (client) => {
            const vectors = await client.query<{ oid: number }>(
                "SELECT oid::int AS oid FROM pg_type WHERE typname IN ('vector', 'halfvec')"
            );
            this.#extension = { vector: new Set(vectors.rows.map((r) => r.oid)) };
            return loadInventory(client, this.config.allowRoutines);
        });
        this.#inventory = inventory;
        this.#inventoryAt = Date.now();
        if (inventory.strict) {
            this.#log?.warn(
                { source: this.config.name, capabilities: inventory.dangerousCapabilities },
                'role can reach functions that write outside the transaction; user-defined functions are blocked unless allowlisted'
            );
        }
        return inventory;
    }

    info(): SourceInfo {
        const inventory = this.#inventory;
        return {
            name: this.config.name,
            type: 'postgres',
            description: this.config.description,
            queryLanguage: 'PostgreSQL SQL (a single SELECT)',
            dialectHints: [
                'Exactly one SELECT (or WITH … SELECT); no trailing semicolon needed.',
                'Bind parameters as $1, $2, … with params: [value, …].',
                'Use LIMIT/OFFSET for paging inside SQL; large results are fine, they are exported to files.',
                'Use options.explain (and options.analyze) to get the execution plan instead of data.',
                ...(inventory?.strict
                    ? ['User-defined functions are blocked on this source unless allowlisted (ALLOW_ROUTINES).']
                    : []),
            ],
            options: {
                explain: 'boolean: return the execution plan instead of rows',
                analyze: 'boolean: with explain, run EXPLAIN ANALYZE',
            },
            params: 'array of positional values for $1, $2, …',
            readOnlyLayers: [
                'read-only transaction (REPEATABLE READ READ ONLY, always rolled back)',
                'syntax-tree guard (single SELECT, no locking, no data-modifying CTEs)',
                inventory?.strict
                    ? 'routine inventory: strict (user-defined functions blocked)'
                    : 'routine inventory: side-effect functions and dependent views blocked',
            ],
            credential: inventory?.credential ?? 'unverified',
            ...(inventory ? { credentialNote: inventory.credentialNote } : {}),
        };
    }

    async validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const values = params === undefined || params === null ? [] : params;
        const parsedParams = paramsSchema.safeParse(values);
        if (!parsedParams.success) {
            throw new PeriscopeError('invalid_argument', 'params must be an array of values for $1, $2, …');
        }
        const parsed = parseReadOnlyQuery(query);
        const inventory = await this.#refreshInventory();
        for (const name of parsed.functions) {
            if (inventory.blockedFunctions.has(name.toLowerCase())) {
                throw new QueryRejectedError(
                    `Function '${name}' is blocked on this source (it may write through another connection); allowlist it with ALLOW_ROUTINES after review`
                );
            }
        }
        for (const relation of parsed.relations) {
            if (inventory.blockedRelations.has(relation.toLowerCase())) {
                throw new QueryRejectedError(`View '${relation}' uses functions with side effects and is blocked`);
            }
        }
        let sql = query.trim().replace(/;\s*$/, '');
        if (opts.explain && parsed.kind === 'select') {
            sql = `EXPLAIN (FORMAT TEXT${opts.analyze ? ', ANALYZE, BUFFERS' : ''}) ${sql}`;
        }
        return {
            query,
            params: parsedParams.data.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
            options: opts,
            plan: { sql } satisfies Plan,
        };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const { sql } = prepared.plan as Plan;
        const pool = this.#poolOrThrow;
        const client = await pool.connect();
        const pid = (client as unknown as { processID: number }).processID;
        const onAbort = (): void => {
            pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
        };
        let cursor: Cursor | undefined;
        const cleanup = async (): Promise<void> => {
            context.signal.removeEventListener('abort', onAbort);
            await new Promise<void>((resolve) => (cursor ? cursor.close(() => resolve()) : resolve()));
            await this.#release(client);
        };
        try {
            await client.query(this.#session);
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query(`SET LOCAL statement_timeout = ${Math.ceil(remaining(context.deadline))}`);
            context.signal.addEventListener('abort', onAbort, { once: true });
            cursor = client.query(
                new Cursor(sql, prepared.params as unknown[], {
                    rowMode: 'array',
                    types: typeParsers(this.#extension) as never,
                })
            );
            const read = (count: number): Promise<{ rows: unknown[][]; fields: FieldDescription[] }> =>
                new Promise((resolve, reject) =>
                    (cursor as Cursor).read(count, (error, rows, result) =>
                        error
                            ? reject(new PeriscopeError('source_error', error.message))
                            : resolve({
                                  rows: rows as unknown as unknown[][],
                                  fields: (result?.fields ?? []) as unknown as FieldDescription[],
                              })
                    )
                );
            const first = await read(BATCH_ROWS);
            const typeNames = await this.#typeNames(first.fields);
            const mapped = first.fields.map((field) =>
                mapField(field, typeNames.get(field.dataTypeID) ?? String(field.dataTypeID), this.#extension)
            );
            const convert = (rows: unknown[][]): unknown[][] =>
                rows.map((row) => row.map((value, i) => (mapped[i]?.convert ? mapped[i].convert(value) : value)));
            const batches = async function* (): AsyncGenerator<unknown[][]> {
                try {
                    if (first.rows.length > 0) yield convert(first.rows);
                    if (first.rows.length < BATCH_ROWS) return;
                    while (true) {
                        const next = await read(BATCH_ROWS);
                        if (next.rows.length === 0) return;
                        yield convert(next.rows);
                        if (next.rows.length < BATCH_ROWS) return;
                    }
                } finally {
                    await cleanup();
                }
            };
            return {
                format: 'parquet',
                columns: mapped.map((m) => m.column),
                batches: batches(),
            } satisfies TabularStream;
        } catch (error) {
            await cleanup();
            throw error;
        }
    }

    async #typeNames(fields: FieldDescription[]): Promise<Map<number, string>> {
        const oids = [...new Set(fields.map((f) => f.dataTypeID))];
        if (oids.length === 0) return new Map();
        const result = await this.#poolOrThrow.query<{ oid: number; name: string }>(
            'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
            [oids]
        );
        return new Map(result.rows.map((r) => [r.oid, r.name]));
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const parts = splitPath(path);
        const pattern = likePattern(filter);
        return this.#readOnly(async (client) => {
            if (parts.length === 0) {
                const schemas = await client.query(
                    `SELECT n.nspname AS schema, count(c.oid)::int AS relations, obj_description(n.oid, 'pg_namespace') AS comment
                     FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')
                     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND n.nspname ILIKE $1
                       AND has_schema_privilege(n.oid, 'USAGE')
                     GROUP BY n.oid, n.nspname ORDER BY n.nspname LIMIT 1000`,
                    [pattern]
                );
                return { level: 'schemas', schemas: schemas.rows };
            }
            if (parts.length === 1) {
                const relations = await client.query(
                    `SELECT c.relname AS name,
                            CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
                              WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS kind,
                            GREATEST(c.reltuples, 0)::bigint::text AS estimated_rows,
                            obj_description(c.oid, 'pg_class') AS comment
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND c.relname ILIKE $2
                     ORDER BY c.relname LIMIT 2000`,
                    [parts[0], pattern]
                );
                return { level: 'relations', schema: parts[0], relations: relations.rows };
            }
            const [schema, table] = parts as [string, string];
            const regclass = await client.query<{ oid: number | null }>(
                "SELECT to_regclass(quote_ident($1) || '.' || quote_ident($2))::oid::int AS oid",
                [schema, table]
            );
            const oid = regclass.rows[0]?.oid;
            if (!oid) throw new PeriscopeError('not_found', `Relation '${schema}.${table}' not found`);
            const columns = await client.query(
                `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                            pg_get_expr(d.adbin, d.adrelid) AS default, col_description(a.attrelid, a.attnum) AS comment
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE $2
                     ORDER BY a.attnum`,
                [oid, pattern]
            );
            const constraints = await client.query(
                `SELECT conname AS name, CASE contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key'
                              WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' ELSE contype::text END AS kind,
                            pg_get_constraintdef(oid) AS definition
                     FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`,
                [oid]
            );
            const indexes = await client.query(
                `SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition
                     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = $1 ORDER BY i.relname`,
                [oid]
            );
            const info = await client.query(
                `SELECT GREATEST(c.reltuples, 0)::bigint::text AS estimated_rows, obj_description(c.oid, 'pg_class') AS comment,
                            CASE c.relkind WHEN 'v' THEN pg_get_viewdef(c.oid) WHEN 'm' THEN pg_get_viewdef(c.oid) END AS view_definition
                     FROM pg_class c WHERE c.oid = $1`,
                [oid]
            );
            return {
                level: 'relation',
                schema,
                name: table,
                ...info.rows[0],
                columns: columns.rows,
                constraints: constraints.rows,
                indexes: indexes.rows,
            };
        });
    }

    async close(): Promise<void> {
        await this.#pool?.end();
    }
}
