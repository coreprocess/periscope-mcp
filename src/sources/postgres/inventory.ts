import type pg from 'pg';
import type { CredentialState } from '../adapter.ts';
import { collectReferences, isDeniedFunction } from './guard.ts';

/**
 * Startup inventory for Postgres (concept §7.1 B3).
 *
 * A READ ONLY transaction blocks local writes, but not writes made through a separate
 * connection or a background worker (dblink, oracle_fdw's oracle_execute, pg_background)
 * or through untrusted procedural languages. User-defined functions and views can wrap
 * such calls invisibly. So:
 * - normal mode: only functions denied by name, plus every view that depends on them;
 * - strict mode (any such capability is executable by the role): every user-defined
 *   function is blocked unless allowlisted, plus every view that depends on one.
 */
export interface PostgresInventory {
    strict: boolean;
    dangerousCapabilities: string[];
    /** Lowercased function names (bare and schema-qualified) that must not be called. */
    blockedFunctions: Set<string>;
    /** Lowercased relation names (bare and schema-qualified) that must not be read. */
    blockedRelations: Set<string>;
    credential: CredentialState;
    credentialNote: string;
}

const DANGEROUS_CAPABILITIES = `
SELECT n.nspname || '.' || p.proname AS name
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (p.proname LIKE 'dblink%' OR p.proname = 'oracle_execute' OR p.proname LIKE 'pg\\_background%')
  AND has_function_privilege(p.oid, 'EXECUTE')
UNION ALL
SELECT n.nspname || '.' || p.proname || ' (' || l.lanname || ')'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
WHERE NOT l.lanpltrusted AND l.lanname NOT IN ('c', 'internal')
  AND has_function_privilege(p.oid, 'EXECUTE')
LIMIT 50`;

/** User-defined functions: outside the catalog schemas and not members of an extension. */
const USER_FUNCTIONS = `
SELECT p.oid::bigint AS oid, n.nspname AS schema, p.proname AS name
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;

/** Definitions of all readable views; their function calls are checked with the Postgres parser. */
const VIEW_DEFINITIONS = `
SELECT n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid) AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND has_table_privilege(c.oid, 'SELECT')`;

const POSTURE = `
SELECT r.rolsuper AS superuser,
  EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (pg_has_role(c.relowner, 'USAGE')
        OR has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
        OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
  ) AS can_write,
  has_database_privilege(current_database(), 'CREATE') AS can_create
FROM pg_roles r WHERE r.rolname = current_user`;

const addNames = (target: Set<string>, schema: string, name: string): void => {
    target.add(name.toLowerCase());
    target.add(`${schema}.${name}`.toLowerCase());
};

export const loadInventory = async (client: pg.ClientBase, allowRoutines: string[]): Promise<PostgresInventory> => {
    const allowed = new Set(allowRoutines.map((r) => r.toLowerCase()));
    const dangerous = (await client.query<{ name: string }>(DANGEROUS_CAPABILITIES)).rows.map((r) => r.name);
    const strict = dangerous.length > 0;

    const blockedFunctions = new Set<string>();
    if (strict) {
        const functions = await client.query<{ oid: string; schema: string; name: string }>(USER_FUNCTIONS);
        for (const f of functions.rows) {
            const qualified = `${f.schema}.${f.name}`.toLowerCase();
            if (allowed.has(qualified) || allowed.has(f.name.toLowerCase())) continue;
            addNames(blockedFunctions, f.schema, f.name);
        }
    }

    // Postgres records no dependencies on built-in functions, so view definitions are parsed instead.
    const definitions = await client.query<{ schema: string; name: string; definition: string | null }>(
        VIEW_DEFINITIONS
    );
    const views = new Map<string, { schema: string; name: string; refs: string[]; unsafe: boolean }>();
    for (const view of definitions.rows) {
        let unsafe = false;
        let refs: string[] = [];
        try {
            const found = collectReferences(view.definition ?? '');
            refs = found.relations.map((r) => r.toLowerCase());
            unsafe = found.functions.some((f) => isDeniedFunction(f) || blockedFunctions.has(f.toLowerCase()));
        } catch {
            unsafe = true; // fail closed when a definition cannot be analysed
        }
        views.set(`${view.schema}.${view.name}`.toLowerCase(), { schema: view.schema, name: view.name, refs, unsafe });
    }
    const viewByName = (ref: string): { unsafe: boolean } | undefined =>
        views.get(ref) ?? [...views.values()].find((v) => v.name.toLowerCase() === ref);
    // Propagate through views that read other unsafe views.
    let changed = true;
    while (changed) {
        changed = false;
        for (const view of views.values()) {
            if (view.unsafe) continue;
            if (view.refs.some((ref) => viewByName(ref)?.unsafe)) {
                view.unsafe = true;
                changed = true;
            }
        }
    }
    const blockedRelations = new Set<string>();
    for (const view of views.values()) if (view.unsafe) addNames(blockedRelations, view.schema, view.name);

    const posture = (await client.query<{ superuser: boolean; can_write: boolean; can_create: boolean }>(POSTURE))
        .rows[0];
    const writeCapable = Boolean(posture?.superuser || posture?.can_write || posture?.can_create);
    return {
        strict,
        dangerousCapabilities: dangerous,
        blockedFunctions,
        blockedRelations,
        credential: writeCapable ? 'write-capable' : 'read-only verified',
        credentialNote: posture?.superuser
            ? 'superuser'
            : writeCapable
              ? 'role can write or create objects; read-only is enforced by Periscope'
              : 'role has no write privileges',
    };
};
