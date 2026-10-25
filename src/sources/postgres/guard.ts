import { loadModule, parseSync } from 'libpg-query';
import { QueryRejectedError } from '../../core/errors.ts';

/**
 * Syntax-tree guard for Postgres (concept §7.1 B). Uses the Postgres parser itself
 * (libpg-query, WASM) and accepts exactly one SELECT, or EXPLAIN of one.
 */

/**
 * Functions with side effects that a READ ONLY transaction does not prevent, and functions that run a query given
 * as text or read a relation given by name: the guard never sees that query or relation.
 */
const DENIED_FUNCTIONS = [
    /^query_to_xml/,
    /^cursor_to_xml/,
    /^table_to_xml/,
    /^schema_to_xml/,
    /^database_to_xml/,
    /^ts_stat$/,
    /^ts_rewrite$/,
    /^dblink/,
    /^oracle_execute$/,
    /^pg_background/,
    /^pg_advisory/,
    /^pg_try_advisory/,
    /^pg_notify$/,
    /^pg_terminate_backend$/,
    /^pg_cancel_backend$/,
    /^pg_reload_conf$/,
    /^pg_rotate_logfile/,
    /^pg_logical_emit_message$/,
    /^pg_stat_reset/,
    /^pg_stat_statements_reset$/,
    /^pg_switch_wal$/,
    /^pg_create_.*_replication_slot$/,
    /^pg_drop_replication_slot$/,
    /^pg_replication_slot_advance$/,
    /^pg_copy_.*_replication_slot$/,
    /^pg_sync_replication_slots$/,
    /^pg_logical_slot_/,
    /^pg_replication_origin_/,
    /^pg_create_restore_point$/,
    /^pg_log_standby_snapshot$/,
    /^pg_backup_/,
    /^pg_wal_replay_/,
    /^pg_promote$/,
    /^pg_log_backend_memory_contexts$/,
    /^pg_read_file$/,
    /^pg_read_binary_file$/,
    /^pg_ls_/,
    /^pg_file_/,
    /^set_config$/,
    /^lo_/,
    /^nextval$/,
    /^setval$/,
    /^txid_current$/,
    /^pg_current_xact_id$/,
    /^pg_import_system_collations$/,
    /^pg_sleep/,
];

export const isDeniedFunction = (name: string): boolean => {
    const bare = name.includes('.') ? (name.split('.').pop() as string) : name;
    return DENIED_FUNCTIONS.some((pattern) => pattern.test(bare.toLowerCase()));
};

/** Schemas whose functions are part of extensions or the catalog and trusted by name. */
const DENIED_SCHEMAS = new Set(['cron', 'dblink']);

export interface ParsedQuery {
    kind: 'select' | 'explain';
    /** The SELECT text to run (for EXPLAIN, the inner statement is still sent as written). */
    functions: string[];
    relations: string[];
    analyze: boolean;
}

let loaded: Promise<void> | undefined;
export const ensureParser = (): Promise<void> => {
    loaded ??= loadModule();
    return loaded;
};

type Node = Record<string, unknown>;

const FORBIDDEN_NODES = new Set([
    'InsertStmt',
    'UpdateStmt',
    'DeleteStmt',
    'MergeStmt',
    'CopyStmt',
    'CallStmt',
    'DoStmt',
    'VariableSetStmt',
    'TransactionStmt',
    'LockStmt',
    'NotifyStmt',
    'ListenStmt',
    'CreateTableAsStmt',
]);

const nameOf = (parts: unknown): string =>
    ((parts as Node[] | undefined) ?? [])
        .map((p) => ((p.String as Node | undefined)?.sval as string | undefined) ?? '')
        .join('.');

/** Walks the parse tree, rejecting forbidden constructs and collecting functions and relations. */
const walk = (value: unknown, found: { functions: string[]; relations: string[] }): void => {
    if (Array.isArray(value)) {
        for (const item of value) walk(item, found);
        return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Node)) {
        if (FORBIDDEN_NODES.has(key)) {
            throw new QueryRejectedError(`Only reading queries are allowed (found ${key.replace(/Stmt$/, '')})`);
        }
        if (key === 'SelectStmt') {
            const select = child as Node;
            if (select.intoClause) throw new QueryRejectedError('SELECT … INTO creates a table and is not allowed');
            if (Array.isArray(select.lockingClause) && select.lockingClause.length > 0) {
                throw new QueryRejectedError('Row locking (FOR UPDATE/SHARE) is not allowed');
            }
        }
        if (key === 'FuncCall') {
            const name = nameOf((child as Node).funcname);
            const schema = name.includes('.') ? name.split('.')[0] : undefined;
            if (isDeniedFunction(name) || (schema && DENIED_SCHEMAS.has(schema))) {
                throw new QueryRejectedError(
                    `Function '${name}' is not allowed (side effects, or a query or relation the guard cannot check)`
                );
            }
            found.functions.push(name);
        }
        if (key === 'RangeVar') {
            const range = child as Node;
            const relation = [range.schemaname, range.relname].filter(Boolean).join('.');
            if (relation) found.relations.push(relation);
        }
        walk(child, found);
    }
};

/** Collects function calls and relations of any statement without judging it (used for view definitions). */
export const collectReferences = (sql: string): { functions: string[]; relations: string[] } => {
    const found = { functions: [] as string[], relations: [] as string[] };
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (value === null || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Node)) {
            if (key === 'FuncCall') found.functions.push(nameOf((child as Node).funcname));
            if (key === 'RangeVar') {
                const range = child as Node;
                const relation = [range.schemaname, range.relname].filter(Boolean).join('.');
                if (relation) found.relations.push(relation);
            }
            visit(child);
        }
    };
    visit(parseSync(sql));
    return found;
};

export const parseReadOnlyQuery = (sql: string): ParsedQuery => {
    let tree: { stmts?: { stmt?: Node }[] };
    try {
        tree = parseSync(sql) as unknown as { stmts?: { stmt?: Node }[] };
    } catch (error) {
        throw new QueryRejectedError(`SQL syntax error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const statements = tree.stmts ?? [];
    if (statements.length !== 1) throw new QueryRejectedError('Exactly one statement is allowed');
    const statement = statements[0]?.stmt ?? {};
    const [type] = Object.keys(statement);
    const found = { functions: [] as string[], relations: [] as string[] };

    if (type === 'SelectStmt') {
        walk(statement, found);
        return { kind: 'select', ...found, analyze: false };
    }
    if (type === 'ExplainStmt') {
        const explain = statement.ExplainStmt as Node;
        const inner = explain.query as Node | undefined;
        if (!inner || Object.keys(inner)[0] !== 'SelectStmt') {
            throw new QueryRejectedError('EXPLAIN is only allowed for SELECT statements');
        }
        walk(inner, found);
        const options = ((explain.options as Node[] | undefined) ?? []).map(
            (o) => ((o.DefElem as Node | undefined)?.defname as string | undefined) ?? ''
        );
        return { kind: 'explain', ...found, analyze: options.includes('analyze') };
    }
    throw new QueryRejectedError(`Only SELECT queries are allowed (got ${type?.replace(/Stmt$/, '') ?? 'nothing'})`);
};
