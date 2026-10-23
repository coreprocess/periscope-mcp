import { DefaultAzureCredential } from '@azure/identity';
import sql from 'mssql';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { MssqlSourceConfig } from '../../config/sources.ts';
import { PeriscopeError, QueryRejectedError } from '../../core/errors.ts';
import { scalarColumn } from '../../results/parquet/columns.ts';
import type {
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
    TabularStream,
} from '../adapter.ts';
import { likePattern, parseOptions, remaining, splitPath } from '../common.ts';
import { loadMssqlInventory, type MssqlInventory } from './inventory.ts';
import { checkReadOnlyStatement } from './lexer.ts';
import { type MappedColumn, type MssqlColumnMetadata, mapMssqlColumn } from './types.ts';

const BATCH_ROWS = 5000;
const INVENTORY_TTL_MS = 10 * 60_000;
const PARAM_NAME = /^@?[A-Za-z_][A-Za-z0-9_]*$/;

const optionsSchema = z.object({ explain: z.boolean().optional() }).strict();
const bindValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const paramsSchema = z.record(z.string().regex(PARAM_NAME), bindValue);

interface Plan {
    sql: string;
    explain: boolean;
}

/** mssql accepts per-request overrides; its type definitions do not declare them yet. */
const RequestWithTimeout = sql.Request as unknown as new (
    parent: sql.Transaction,
    overrides: { requestTimeout: number }
) => sql.Request;

const sourceError = (error: unknown): PeriscopeError =>
    error instanceof PeriscopeError
        ? error
        : new PeriscopeError('source_error', error instanceof Error ? error.message : String(error));

/** Binds `{ name: value }` as `@name`; integers outside int32 are sent as bigint. */
const bind = (request: sql.Request, params: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(params)) {
        const name = key.replace(/^@/, '');
        if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) > 2_147_483_647) {
            request.input(name, sql.BigInt, value);
        } else if (typeof value === 'number' && !Number.isInteger(value)) {
            request.input(name, sql.Float, value);
        } else if (value === null) {
            request.input(name, sql.NVarChar, null);
        } else {
            request.input(name, value);
        }
    }
};

interface RowStream {
    columns(): Promise<MssqlColumnMetadata[]>;
    /** The next batch of raw rows, or undefined at the end. */
    next(): Promise<unknown[][] | undefined>;
    /** Cancels the request if it still runs and waits until its connection is free. */
    stop(): Promise<void>;
}

/**
 * Streams the rows of a single result set with backpressure. In stream mode mssql always
 * emits `done` last, also after an error, so the transaction can be rolled back safely then.
 */
const streamRows = (request: sql.Request, text: string): RowStream => {
    const queue: unknown[][] = [];
    let columns: MssqlColumnMetadata[] | undefined;
    let failure: unknown;
    let done = false;
    let paused = false;
    let wake: (() => void) | undefined;
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const notify = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    request.stream = true;
    request.on('recordset', (metadata: MssqlColumnMetadata[]) => {
        if (columns) {
            failure ??= new PeriscopeError('source_error', 'The statement returned more than one result set');
            request.cancel();
        } else {
            columns = metadata;
        }
        notify();
    });
    request.on('row', (row: unknown[]) => {
        queue.push(row);
        if (queue.length >= 2 * BATCH_ROWS && !paused) {
            paused = true;
            request.pause();
        }
        notify();
    });
    request.on('error', (error: unknown) => {
        failure ??= error;
        notify();
    });
    request.on('done', () => {
        done = true;
        finish();
        notify();
    });
    request.query(text, () => undefined);
    const waitFor = async (ready: () => boolean): Promise<void> => {
        while (!ready() && !done && failure === undefined) {
            if (paused) {
                paused = false;
                request.resume();
            }
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    };
    return {
        async columns() {
            await waitFor(() => columns !== undefined);
            if (failure !== undefined) throw failure;
            return columns ?? [];
        },
        async next() {
            await waitFor(() => queue.length >= BATCH_ROWS);
            if (failure !== undefined) throw failure;
            return queue.length > 0 ? queue.splice(0, BATCH_ROWS) : undefined;
        },
        async stop() {
            if (done) return;
            if (paused) request.resume();
            request.cancel();
            await finished;
        },
    };
};

/** SQL Server and Azure SQL: strict lexer, transaction that is always rolled back, routine inventory. */
export class MssqlAdapter implements SourceAdapter {
    readonly config: MssqlSourceConfig;
    #pool: sql.ConnectionPool | undefined;
    #inventory: MssqlInventory | undefined;
    #inventoryAt = 0;
    #log: Logger | undefined;

    constructor(config: MssqlSourceConfig) {
        this.config = config;
    }

    #poolConfig(): sql.config {
        const c = this.config;
        const base: sql.config = c.connectionString
            ? sql.ConnectionPool.parseConnectionString(c.connectionString)
            : {
                  server: c.host as string,
                  port: c.port,
                  database: c.database,
                  user: c.user,
                  password: c.password,
              };
        const options: sql.IOptions = {
            ...base.options,
            encrypt: c.connectionString ? (base.options?.encrypt ?? c.encrypt) : c.encrypt,
            trustServerCertificate: c.connectionString
                ? (base.options?.trustServerCertificate ?? c.trustServerCertificate)
                : c.trustServerCertificate,
            appName: 'periscope',
            // parseConnectionString ignores ApplicationIntent, so it is set explicitly.
            readOnlyIntent: c.readIntent,
        };
        if (!c.connectionString && c.database) options.database = c.database;
        return {
            ...base,
            options,
            ...(c.azureAuth
                ? {
                      user: undefined,
                      password: undefined,
                      authentication: {
                          type: 'token-credential',
                          options: { credential: new DefaultAzureCredential() },
                      } as never,
                  }
                : {}),
            arrayRowMode: true,
            connectionTimeout: 15_000,
            requestTimeout: Math.min(c.maxQueryDurationMs, 2_147_483_647),
            pool: { min: 0, max: 6, idleTimeoutMillis: 60_000 },
        };
    }

    async init(log: Logger): Promise<void> {
        this.#log = log;
        const pool = new sql.ConnectionPool(this.#poolConfig());
        pool.on('error', (error: Error) => log.warn({ error: error.message }, 'sql server pool error'));
        this.#pool = await pool.connect();
        await this.#refreshInventory();
    }

    #requirePool(): sql.ConnectionPool {
        if (!this.#pool) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        return this.#pool;
    }

    #isolation(): sql.IIsolationLevel {
        return this.#inventory?.snapshotIsolation ? sql.ISOLATION_LEVEL.SNAPSHOT : sql.ISOLATION_LEVEL.READ_COMMITTED;
    }

    /** Runs `fn` inside a transaction that is always rolled back. */
    async #rolledBack<T>(fn: (transaction: sql.Transaction) => Promise<T>): Promise<T> {
        const transaction = new sql.Transaction(this.#requirePool());
        await transaction.begin(this.#isolation());
        try {
            return await fn(transaction);
        } finally {
            await transaction.rollback().catch(() => undefined);
        }
    }

    async #refreshInventory(): Promise<MssqlInventory> {
        if (this.#inventory && Date.now() - this.#inventoryAt < INVENTORY_TTL_MS) return this.#inventory;
        const inventory = await this.#rolledBack((transaction) =>
            loadMssqlInventory(transaction, {
                allowRoutines: this.config.allowRoutines,
                allowLinkedServers: this.config.allowLinkedServers,
            })
        );
        this.#inventory = inventory;
        this.#inventoryAt = Date.now();
        this.#log?.info(
            {
                source: this.config.name,
                strict: inventory.strict,
                reasons: inventory.reasons,
                blocked: inventory.blocked.size,
            },
            'sql server routine inventory loaded'
        );
        return inventory;
    }

    info(): SourceInfo {
        const inventory = this.#inventory;
        const mode = inventory
            ? inventory.strict
                ? `strict: ${inventory.reasons.join(', ')}`
                : 'standard'
            : 'pending';
        return {
            name: this.config.name,
            type: 'mssql',
            description: this.config.description,
            queryLanguage: 'T-SQL (a single SELECT)',
            dialectHints: [
                'Exactly one SELECT or WITH … SELECT; a trailing ";" is removed, no other ";" allowed.',
                'Paging: ORDER BY … OFFSET n ROWS FETCH NEXT m ROWS ONLY, or SELECT TOP (n).',
                'Parameters as @name with params {"name": value}.',
                'Quote identifiers with [brackets]; JSON via OPENJSON, JSON_VALUE, JSON_QUERY.',
                'Not available: SELECT … INTO, EXEC, variables (DECLARE/SET), NEXT VALUE FOR, OPENQUERY/OPENROWSET, locking hints.',
                ...(inventory?.strict
                    ? ['User-defined functions and views using them are blocked unless allowlisted (ALLOW_ROUTINES).']
                    : []),
            ],
            options: { explain: 'boolean: return the estimated plan (SET SHOWPLAN_TEXT) instead of rows' },
            params: 'object { name: value } for @name parameters',
            readOnlyLayers: [
                'transaction that is always rolled back',
                'strict lexer: single SELECT, no EXEC, no DDL/DML, no SELECT INTO, no NEXT VALUE FOR, no remote rowsets',
                `routine inventory (${mode}): functions with EXEC, extended procedures, OLE Automation or CLR, and dependent views blocked`,
                ...(this.config.readIntent
                    ? [
                          `ApplicationIntent=ReadOnly${inventory?.readOnlyReplica ? ' (connected to a read-only replica)' : ''}`,
                      ]
                    : []),
            ],
            credential: inventory?.credential ?? 'unverified',
            ...(inventory ? { credentialNote: inventory.credentialNote } : {}),
        };
    }

    async validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const binds = params === undefined || params === null ? {} : params;
        if (!paramsSchema.safeParse(binds).success) {
            throw new PeriscopeError(
                'invalid_argument',
                'params must be an object { name: value } for @name parameters (string, number, boolean or null)'
            );
        }
        const checked = checkReadOnlyStatement(query, { allowLinkedServers: this.config.allowLinkedServers });
        const inventory = await this.#refreshInventory();
        for (const identifier of checked.identifiers) {
            if (inventory.blocked.has(identifier)) {
                throw new QueryRejectedError(
                    `'${identifier}' is a function (or depends on one) that may have side effects; allowlist it with ALLOW_ROUTINES after review`
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
        const params = prepared.params as Record<string, unknown>;
        const transaction = new sql.Transaction(this.#requirePool());
        let request: sql.Request | undefined;
        let stop = async (): Promise<void> => undefined;
        const onAbort = (): void => request?.cancel();
        const cleanup = async (): Promise<void> => {
            context.signal.removeEventListener('abort', onAbort);
            await stop();
            await transaction.rollback().catch(() => undefined);
        };
        try {
            await transaction.begin(this.#isolation());
        } catch (error) {
            throw sourceError(error);
        }
        const newRequest = (): sql.Request => {
            const r = new RequestWithTimeout(transaction, {
                requestTimeout: Math.min(remaining(context.deadline), 2_147_483_647),
            });
            r.arrayRowMode = true;
            return r;
        };
        try {
            context.signal.addEventListener('abort', onAbort, { once: true });
            if (plan.explain) return await this.#explain(newRequest, plan, params, cleanup);

            request = newRequest();
            bind(request, params);
            const rows = streamRows(request, plan.sql);
            stop = rows.stop;
            const mapped = (await rows.columns()).map(mapMssqlColumn);
            const batches = async function* (): AsyncGenerator<unknown[][]> {
                try {
                    for (let batch = await rows.next(); batch; batch = await rows.next()) {
                        yield batch.map((row) => row.map((value, i) => (mapped[i] as MappedColumn).convert(value)));
                    }
                } catch (error) {
                    if (context.signal.aborted) throw context.signal.reason;
                    throw sourceError(error);
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
            throw sourceError(error);
        }
    }

    async #explain(
        newRequest: () => sql.Request,
        plan: Plan,
        params: Record<string, unknown>,
        cleanup: () => Promise<void>
    ): Promise<TabularStream> {
        try {
            // SHOWPLAN must be alone in its batch; the statement is compiled, not executed.
            await newRequest().batch('SET SHOWPLAN_TEXT ON');
            try {
                // sp_executesql (used by query()) is not planned under SHOWPLAN; a batch is,
                // with parameters declared in front of the statement.
                const request = newRequest();
                request.arrayRowMode = false;
                bind(request, params);
                const result = await request.batch(plan.sql);
                const recordsets = result.recordsets as unknown as Record<string, unknown>[][];
                const lines = recordsets.flatMap((set) => set.map((row) => [String(Object.values(row)[0] ?? '')]));
                const batches = async function* (): AsyncGenerator<unknown[][]> {
                    if (lines.length > 0) yield lines;
                };
                return {
                    format: 'parquet',
                    columns: [scalarColumn('StmtText', 'string', { sourceType: 'nvarchar' })],
                    batches: batches(),
                };
            } finally {
                await newRequest()
                    .batch('SET SHOWPLAN_TEXT OFF')
                    .catch(() => undefined);
            }
        } catch (error) {
            throw new PeriscopeError(
                'source_error',
                `Execution plan not available: ${(error as Error).message}. SET SHOWPLAN_TEXT needs the SHOWPLAN permission.`
            );
        } finally {
            await cleanup();
        }
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const parts = splitPath(path);
        const pattern = likePattern(filter);
        return this.#rolledBack(async (transaction) => {
            const query = async (
                text: string,
                inputs: Record<string, string> = {}
            ): Promise<Record<string, unknown>[]> => {
                const request = new sql.Request(transaction);
                request.arrayRowMode = false;
                for (const [name, value] of Object.entries(inputs)) request.input(name, sql.NVarChar, value);
                return (await request.query(text)).recordset as Record<string, unknown>[];
            };
            if (parts.length === 0) {
                const schemas = await query(
                    `SELECT s.name AS name, COUNT(o.object_id) AS objects
                     FROM sys.schemas s
                     JOIN sys.objects o ON o.schema_id = s.schema_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
                     WHERE s.name LIKE @pattern ESCAPE '\\'
                     GROUP BY s.name ORDER BY s.name`,
                    { pattern }
                );
                return { level: 'schemas', database: await this.#database(query), schemas };
            }
            if (parts.length === 1) {
                const objects = await query(
                    `SELECT TOP (2000) o.name AS name, CASE o.type WHEN 'U' THEN 'TABLE' ELSE 'VIEW' END AS kind,
                            (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS estimated_rows,
                            CAST(ep.value AS nvarchar(4000)) AS comment
                     FROM sys.objects o
                     JOIN sys.schemas s ON s.schema_id = o.schema_id
                     LEFT JOIN sys.extended_properties ep
                       ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
                     WHERE s.name = @schema AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
                       AND o.name LIKE @pattern ESCAPE '\\'
                     ORDER BY o.name`,
                    { schema: parts[0] as string, pattern }
                );
                return { level: 'objects', schema: parts[0], objects };
            }
            const [schema, name] = parts.slice(-2) as [string, string];
            const target = { schema, name };
            const columns = await query(
                `SELECT c.name AS name, t.name AS type, c.max_length AS length, c.precision, c.scale,
                        c.is_nullable AS nullable, c.is_identity AS [identity], c.is_computed AS computed,
                        CAST(ep.value AS nvarchar(4000)) AS comment
                 FROM sys.columns c
                 JOIN sys.objects o ON o.object_id = c.object_id
                 JOIN sys.schemas s ON s.schema_id = o.schema_id
                 JOIN sys.types t ON t.user_type_id = c.user_type_id
                 LEFT JOIN sys.extended_properties ep
                   ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
                 WHERE s.name = @schema AND o.name = @name AND c.name LIKE @pattern ESCAPE '\\'
                 ORDER BY c.column_id`,
                { ...target, pattern }
            );
            if (columns.length === 0) throw new PeriscopeError('not_found', `Object '${schema}.${name}' not found`);
            const keys = await query(
                `SELECT k.name AS name, k.type_desc AS kind,
                        STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
                 FROM sys.key_constraints k
                 JOIN sys.index_columns ic ON ic.object_id = k.parent_object_id AND ic.index_id = k.unique_index_id
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                 WHERE k.parent_object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name))
                 GROUP BY k.name, k.type_desc`,
                target
            );
            const foreignKeys = await query(
                `SELECT f.name AS name,
                        STRING_AGG(pc.name, ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) AS columns,
                        OBJECT_SCHEMA_NAME(f.referenced_object_id) + '.' + OBJECT_NAME(f.referenced_object_id) AS references_table,
                        STRING_AGG(rc.name, ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) AS references_columns
                 FROM sys.foreign_keys f
                 JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
                 JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
                 JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
                 WHERE f.parent_object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name))
                 GROUP BY f.name, f.referenced_object_id`,
                target
            );
            const indexes = await query(
                `SELECT i.name AS name, i.type_desc AS kind, i.is_unique AS [unique],
                        STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
                 FROM sys.indexes i
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                 WHERE i.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name)) AND i.name IS NOT NULL
                 GROUP BY i.name, i.type_desc, i.is_unique`,
                target
            );
            const [view] = await query(
                `SELECT OBJECT_DEFINITION(o.object_id) AS definition
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE s.name = @schema AND o.name = @name AND o.type = 'V'`,
                target
            );
            return {
                level: 'object',
                schema,
                name,
                columns,
                keys,
                foreignKeys,
                indexes,
                ...(view?.definition ? { viewDefinition: view.definition } : {}),
            };
        });
    }

    async #database(query: (text: string) => Promise<Record<string, unknown>[]>): Promise<unknown> {
        const [row] = await query('SELECT DB_NAME() AS name');
        return row?.name;
    }

    async close(): Promise<void> {
        await this.#pool?.close().catch(() => undefined);
    }
}
