import oracledb from 'oracledb';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { OracleSourceConfig } from '../../config/sources.ts';
import { PeriscopeError, QueryRejectedError } from '../../core/errors.ts';
import {
    decimalColumn,
    MAX_DECIMAL_PRECISION,
    type ParquetColumn,
    scalarColumn,
    timestampColumn,
} from '../../results/parquet/columns.ts';
import { toUnscaled } from '../../results/parquet/decimal.ts';
import type {
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
    TabularStream,
} from '../adapter.ts';
import { likePattern, parseOptions, remaining, splitPath } from '../common.ts';
import { loadOracleInventory, type OracleInventory } from './inventory.ts';
import { checkReadOnlyStatement } from './lexer.ts';

// Oracle DATE/TIMESTAMP values arrive as JS Dates in the process time zone; Periscope runs in UTC.
process.env.TZ = 'UTC';

const BATCH_ROWS = 5000;
const INVENTORY_TTL_MS = 10 * 60_000;

const optionsSchema = z.object({ explain: z.boolean().optional() }).strict();
const bindValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const paramsSchema = z.union([z.array(bindValue), z.record(z.string(), bindValue)]);

interface Plan {
    sql: string;
    explain: boolean;
}

interface Mapped {
    column: ParquetColumn;
    convert: (value: unknown) => unknown;
}

const toMicros = (value: unknown): unknown =>
    value instanceof Date ? BigInt(value.getTime()) * 1000n : value === null || value === undefined ? null : value;

const toText = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

/** Fetch exact values: numbers as strings, LOBs as strings/buffers. */
const fetchTypeHandler = (metadata: oracledb.Metadata<unknown>): oracledb.FetchTypeResponse | undefined => {
    switch (metadata.dbType) {
        case oracledb.DB_TYPE_NUMBER:
        case oracledb.DB_TYPE_CLOB:
        case oracledb.DB_TYPE_NCLOB:
        case oracledb.DB_TYPE_LONG:
            return { type: oracledb.STRING };
        case oracledb.DB_TYPE_BLOB:
        case oracledb.DB_TYPE_LONG_RAW:
            return { type: oracledb.BUFFER };
        default:
            return undefined;
    }
};

export const mapOracleColumn = (metadata: oracledb.Metadata<unknown>): Mapped => {
    const name = metadata.name;
    const typeName = metadata.dbTypeName ?? String(metadata.dbType);
    const extra = { sourceType: typeName };
    switch (metadata.dbType) {
        case oracledb.DB_TYPE_NUMBER: {
            const precision = metadata.precision ?? 0;
            const scale = metadata.scale ?? -127;
            if (precision > 0 && precision <= MAX_DECIMAL_PRECISION && scale >= 0 && scale <= precision) {
                return {
                    column: decimalColumn(name, precision, scale, { sourceType: `NUMBER(${precision},${scale})` }),
                    convert: (v) => {
                        if (v === null || v === undefined) return null;
                        const unscaled = toUnscaled(String(v), precision, scale);
                        if (unscaled === undefined) {
                            throw new PeriscopeError(
                                'source_error',
                                `Value '${v}' in '${name}' does not fit NUMBER(${precision},${scale})`
                            );
                        }
                        return unscaled;
                    },
                };
            }
            return {
                column: scalarColumn(name, 'string', {
                    sourceType: precision > 0 ? `NUMBER(${precision},${scale})` : 'NUMBER',
                    note: 'NUMBER without fixed precision and scale; stored as exact decimal text',
                }),
                convert: toText,
            };
        }
        case oracledb.DB_TYPE_BINARY_FLOAT:
        case oracledb.DB_TYPE_BINARY_DOUBLE:
            return { column: scalarColumn(name, 'double', extra), convert: (v) => (v === null ? null : Number(v)) };
        case oracledb.DB_TYPE_DATE:
            return {
                column: timestampColumn(name, false, { sourceType: 'DATE', note: 'Oracle DATE (no time zone)' }),
                convert: toMicros,
            };
        case oracledb.DB_TYPE_TIMESTAMP:
            return {
                column: timestampColumn(name, false, {
                    ...extra,
                    note: 'millisecond precision through the thin driver',
                }),
                convert: toMicros,
            };
        case oracledb.DB_TYPE_TIMESTAMP_TZ:
        case oracledb.DB_TYPE_TIMESTAMP_LTZ:
            return {
                column: timestampColumn(name, true, {
                    ...extra,
                    note: 'millisecond precision through the thin driver',
                }),
                convert: toMicros,
            };
        case oracledb.DB_TYPE_RAW:
        case oracledb.DB_TYPE_LONG_RAW:
        case oracledb.DB_TYPE_BLOB:
            return {
                column: scalarColumn(name, 'binary', extra),
                convert: (v) => (v === null || v === undefined ? null : new Uint8Array(v as Buffer)),
            };
        case oracledb.DB_TYPE_JSON:
            return {
                column: scalarColumn(name, 'json', extra),
                convert: (v) => (v === null || v === undefined ? null : JSON.stringify(v)),
            };
        case oracledb.DB_TYPE_BOOLEAN:
            return { column: scalarColumn(name, 'boolean', extra), convert: (v) => (v === null ? null : Boolean(v)) };
        default:
            return { column: scalarColumn(name, 'string', extra), convert: toText };
    }
};

/** Oracle (19c reference): strict lexer, read-only transaction, routine inventory, system package allowlist. */
export class OracleAdapter implements SourceAdapter {
    readonly config: OracleSourceConfig;
    #pool: oracledb.Pool | undefined;
    #inventory: OracleInventory | undefined;
    #inventoryAt = 0;
    #log: Logger | undefined;

    constructor(config: OracleSourceConfig) {
        this.config = config;
    }

    async init(log: Logger): Promise<void> {
        this.#log = log;
        this.#pool = await oracledb.createPool({
            user: this.config.user,
            password: this.config.password,
            connectString: this.config.connectString,
            poolMin: 0,
            poolMax: 6,
            poolIncrement: 1,
            poolTimeout: 60,
        });
        await this.#refreshInventory();
    }

    async #connection(): Promise<oracledb.Connection> {
        if (!this.#pool) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        const connection = await this.#pool.getConnection();
        connection.module = 'periscope';
        connection.action = 'query';
        return connection;
    }

    async #readOnly<T>(fn: (connection: oracledb.Connection) => Promise<T>, timeoutMs = 120_000): Promise<T> {
        const connection = await this.#connection();
        try {
            connection.callTimeout = timeoutMs;
            await connection.execute('SET TRANSACTION READ ONLY');
            return await fn(connection);
        } finally {
            await connection.rollback().catch(() => undefined);
            await connection.close().catch(() => undefined);
        }
    }

    async #refreshInventory(): Promise<OracleInventory> {
        if (this.#inventory && Date.now() - this.#inventoryAt < INVENTORY_TTL_MS) return this.#inventory;
        const inventory = await this.#readOnly((connection) =>
            loadOracleInventory(connection, this.config.allowRoutines)
        );
        this.#inventory = inventory;
        this.#inventoryAt = Date.now();
        this.#log?.info(
            { source: this.config.name, mode: inventory.mode, blocked: inventory.blocked.size },
            'oracle routine inventory loaded'
        );
        return inventory;
    }

    info(): SourceInfo {
        const inventory = this.#inventory;
        return {
            name: this.config.name,
            type: 'oracle',
            description: this.config.description,
            queryLanguage: 'Oracle SQL (a single SELECT)',
            dialectHints: [
                'Exactly one SELECT or WITH … SELECT; a trailing ";" is removed, no other ";" allowed.',
                'Paging: OFFSET n ROWS FETCH FIRST m ROWS ONLY. Queries without a table need FROM dual.',
                'No BOOLEAN in SQL on 19c; JSON_VALUE/JSON_QUERY/JSON_TABLE are available.',
                'Bind variables as :name with params {"name": value}, or :1, :2 with an array.',
                'Sequences (NEXTVAL), PL/SQL, FOR UPDATE, DML/DDL keywords and most DBMS_/UTL_ packages are not available.',
                ...(inventory?.mode === 'conservative'
                    ? ['User-defined functions and views using them are blocked unless allowlisted (ALLOW_ROUTINES).']
                    : []),
            ],
            options: { explain: 'boolean: return the execution plan (DBMS_XPLAN.DISPLAY_CURSOR) instead of rows' },
            params: 'object { name: value } for :name binds, or array for :1, :2, …',
            readOnlyLayers: [
                'read-only transaction (SET TRANSACTION READ ONLY, always rolled back)',
                'strict lexer: single SELECT, no PL/SQL, no DML/DDL keywords, no FOR UPDATE, no NEXTVAL',
                `routine inventory (${inventory?.mode ?? 'pending'}): autonomous/dynamic-SQL routines and dependents blocked`,
                'system package allowlist (DBMS_LOB, DBMS_METADATA, DBMS_XPLAN)',
            ],
            credential: inventory?.credential ?? 'unverified',
            ...(inventory ? { credentialNote: inventory.credentialNote } : {}),
        };
    }

    async validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const binds = params === undefined || params === null ? [] : params;
        if (!paramsSchema.safeParse(binds).success) {
            throw new PeriscopeError(
                'invalid_argument',
                'params must be an array (for :1, :2) or an object (for :name)'
            );
        }
        const checked = checkReadOnlyStatement(query, { allowDbLinks: this.config.allowDbLinks });
        const inventory = await this.#refreshInventory();
        // `A.B…` is object B of schema A, or member B of package (or synonym) A: both are matched
        for (const [first = '', second] of checked.references) {
            const qualified = second === undefined ? undefined : `${first}.${second}`;
            if (inventory.blocked.has(first) || (qualified && inventory.blockedQualified.has(qualified))) {
                const name = qualified && !inventory.blocked.has(first) ? qualified : first;
                throw new QueryRejectedError(
                    `'${name}' is a routine, or a view or synonym using one, that may write; allowlist the routine with ALLOW_ROUTINES after review. ` +
                        'A table of the same name in another schema is read qualified (OWNER.NAME); a column alias takes AS'
                );
            }
        }
        return {
            query,
            params: binds,
            options: opts,
            plan: { sql: checked.sql, explain: opts.explain ?? false } satisfies Plan,
        };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const plan = prepared.plan as Plan;
        const connection = await this.#connection();
        const onAbort = (): void => void connection.break().catch(() => undefined);
        const cleanup = async (): Promise<void> => {
            context.signal.removeEventListener('abort', onAbort);
            await connection.rollback().catch(() => undefined);
            await connection.close().catch(() => undefined);
        };
        try {
            connection.callTimeout = Math.min(remaining(context.deadline), 2_147_483_647);
            await connection.execute('SET TRANSACTION READ ONLY');
            context.signal.addEventListener('abort', onAbort, { once: true });
            if (plan.explain) return await this.#explain(connection, plan, prepared.params, cleanup);

            const stream = connection.queryStream(plan.sql, prepared.params as oracledb.BindParameters, {
                fetchArraySize: 1000,
                fetchTypeHandler,
            });
            const metadata = await new Promise<oracledb.Metadata<unknown>[]>((resolve, reject) => {
                stream.once('metadata', resolve);
                stream.once('error', (error: Error) => reject(new PeriscopeError('source_error', error.message)));
            });
            const mapped = metadata.map(mapOracleColumn);
            const batches = async function* (): AsyncGenerator<unknown[][]> {
                let batch: unknown[][] = [];
                try {
                    for await (const row of stream as AsyncIterable<unknown[]>) {
                        batch.push(row.map((value, i) => (mapped[i] as Mapped).convert(value)));
                        if (batch.length >= BATCH_ROWS) {
                            yield batch;
                            batch = [];
                        }
                    }
                    if (batch.length > 0) yield batch;
                } catch (error) {
                    if ((error as { code?: string }).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
                    throw new PeriscopeError('source_error', error instanceof Error ? error.message : String(error));
                } finally {
                    stream.destroy();
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
            throw error instanceof PeriscopeError
                ? error
                : new PeriscopeError('source_error', (error as Error).message);
        }
    }

    async #explain(
        connection: oracledb.Connection,
        plan: Plan,
        params: unknown,
        cleanup: () => Promise<void>
    ): Promise<TabularStream> {
        try {
            await connection.execute(plan.sql, params as oracledb.BindParameters, { maxRows: 1, fetchTypeHandler });
            const result = await connection.execute<[string]>(
                "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'TYPICAL'))"
            );
            const lines = (result.rows ?? []).map((row) => [row[0]]);
            const batches = async function* (): AsyncGenerator<unknown[][]> {
                if (lines.length > 0) yield lines;
            };
            return {
                format: 'parquet',
                columns: [scalarColumn('PLAN_TABLE_OUTPUT', 'string', { sourceType: 'VARCHAR2' })],
                batches: batches(),
            };
        } catch (error) {
            throw new PeriscopeError(
                'source_error',
                `Execution plan not available: ${(error as Error).message}. DBMS_XPLAN.DISPLAY_CURSOR needs SELECT on V$SQL_PLAN, V$SQL and V$SESSION.`
            );
        } finally {
            await cleanup();
        }
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const parts = splitPath(path).map((p) => (p === p.toLowerCase() ? p.toUpperCase() : p));
        const pattern = likePattern(filter);
        return this.#readOnly(async (connection) => {
            const query = async (
                sql: string,
                binds: oracledb.BindParameters = {}
            ): Promise<Record<string, unknown>[]> =>
                (
                    await connection.execute<Record<string, unknown>>(sql, binds, {
                        outFormat: oracledb.OUT_FORMAT_OBJECT,
                        fetchTypeHandler,
                    })
                ).rows ?? [];
            if (parts.length === 0) {
                const owners = await query(
                    `SELECT owner, COUNT(*) AS objects FROM all_objects
                     WHERE object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
                       AND owner NOT IN (SELECT username FROM all_users WHERE oracle_maintained = 'Y')
                       AND owner LIKE :pattern ESCAPE '\\'
                     GROUP BY owner ORDER BY owner`,
                    { pattern: pattern.toUpperCase() }
                );
                return { level: 'owners', owners };
            }
            if (parts.length === 1) {
                const objects = await query(
                    `SELECT o.object_name AS name, o.object_type AS kind, t.num_rows AS estimated_rows, c.comments AS "COMMENT"
                     FROM all_objects o
                     LEFT JOIN all_tables t ON t.owner = o.owner AND t.table_name = o.object_name
                     LEFT JOIN all_tab_comments c ON c.owner = o.owner AND c.table_name = o.object_name
                     WHERE o.owner = :owner AND o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
                       AND UPPER(o.object_name) LIKE UPPER(:pattern) ESCAPE '\\'
                     ORDER BY o.object_name FETCH FIRST 2000 ROWS ONLY`,
                    { owner: parts[0] as string, pattern }
                );
                return { level: 'objects', owner: parts[0], objects };
            }
            const [owner, table] = parts as [string, string];
            const columns = await query(
                `SELECT c.column_name AS name, c.data_type AS type, c.data_length AS length, c.data_precision AS precision,
                        c.data_scale AS scale, c.nullable, m.comments AS "COMMENT"
                 FROM all_tab_columns c
                 LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
                 WHERE c.owner = :owner AND c.table_name = :name AND UPPER(c.column_name) LIKE UPPER(:pattern) ESCAPE '\\'
                 ORDER BY c.column_id`,
                { owner, name: table, pattern }
            );
            if (columns.length === 0) throw new PeriscopeError('not_found', `Object '${owner}.${table}' not found`);
            const constraints = await query(
                `SELECT c.constraint_name AS name, c.constraint_type AS kind,
                        LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) AS columns,
                        r.table_name AS references_table
                 FROM all_constraints c
                 JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                 LEFT JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
                 WHERE c.owner = :owner AND c.table_name = :name AND c.constraint_type IN ('P', 'U', 'R')
                 GROUP BY c.constraint_name, c.constraint_type, r.table_name`,
                { owner, name: table }
            );
            const indexes = await query(
                `SELECT i.index_name AS name, i.uniqueness,
                        LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position) AS columns
                 FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
                 WHERE i.table_owner = :owner AND i.table_name = :name
                 GROUP BY i.index_name, i.uniqueness`,
                { owner, name: table }
            );
            const view = await query('SELECT text FROM all_views WHERE owner = :owner AND view_name = :name', {
                owner,
                name: table,
            });
            return {
                level: 'object',
                owner,
                name: table,
                columns,
                constraints,
                indexes,
                ...(view[0] ? { viewDefinition: view[0].TEXT } : {}),
            };
        });
    }

    async close(): Promise<void> {
        await this.#pool?.close(5).catch(() => undefined);
    }
}
