import type oracledb from 'oracledb';
import type { CredentialState } from '../adapter.ts';

/**
 * Routine inventory for Oracle (concept §7.1 B3).
 *
 * Functions called from a query cannot write (ORA-14551) unless they use an autonomous
 * transaction, and dynamic SQL can reach such routines invisibly. Two modes:
 * - precise: with catalog access (DBA_SOURCE/DBA_DEPENDENCIES), routines whose source
 *   contains autonomous transactions, dynamic SQL or job/network packages, or is wrapped,
 *   are blocked together with everything that depends on them;
 * - conservative: without catalog access (package bodies are invisible), every
 *   user-defined routine and everything that depends on one is blocked.
 * Allowlisted routines (ALLOW_ROUTINES) are exempt. Matching is by name, because Oracle
 * allows calling zero-argument functions without parentheses.
 */
export interface OracleInventory {
    mode: 'precise' | 'conservative';
    blocked: Set<string>;
    credential: CredentialState;
    credentialNote: string;
}

const MAINTAINED = `SELECT username FROM all_users WHERE oracle_maintained = 'Y'`;

const UNSAFE_PATTERN = `'AUTONOMOUS_TRANSACTION|EXECUTE[[:space:]]+IMMEDIATE|DBMS_SQL|DBMS_JOB|DBMS_SCHEDULER|DBMS_PIPE|DBMS_LOCK|DBMS_AQ|UTL_[A-Z]+'`;

const PRECISE_ROOTS = `
SELECT DISTINCT owner, name FROM dba_source
WHERE type IN ('FUNCTION', 'PROCEDURE', 'PACKAGE BODY', 'TYPE BODY')
  AND owner NOT IN (${MAINTAINED.replace('all_users', 'dba_users')})
  AND (REGEXP_LIKE(UPPER(text), ${UNSAFE_PATTERN}) OR (line = 1 AND UPPER(text) LIKE '% WRAPPED%'))`;

const CONSERVATIVE_ROOTS = `
SELECT owner, object_name FROM all_objects
WHERE object_type IN ('FUNCTION', 'PROCEDURE', 'PACKAGE', 'TYPE') AND owner NOT IN (${MAINTAINED})
UNION
SELECT referenced_owner, referenced_name FROM all_dependencies
WHERE referenced_type IN ('FUNCTION', 'PROCEDURE', 'PACKAGE', 'TYPE') AND referenced_owner NOT IN (${MAINTAINED})`;

const dependencies = (view: 'dba_dependencies' | 'all_dependencies'): string => `
SELECT owner, name, referenced_owner, referenced_name FROM ${view}
WHERE referenced_owner NOT IN (${MAINTAINED}) AND referenced_link_name IS NULL`;

const SYNONYMS = `SELECT synonym_name, table_owner, table_name FROM all_synonyms
WHERE table_owner NOT IN (${MAINTAINED})`;

const POSTURE = `
SELECT
  (SELECT COUNT(*) FROM session_privs
    WHERE privilege <> 'CREATE SESSION' AND (privilege LIKE 'CREATE %' OR privilege LIKE 'ALTER %' OR privilege LIKE 'DROP %'
      OR privilege LIKE 'INSERT %' OR privilege LIKE 'UPDATE %' OR privilege LIKE 'DELETE %' OR privilege LIKE 'EXECUTE ANY%'
      OR privilege LIKE 'GRANT %')) AS sys_privs,
  (SELECT COUNT(*) FROM user_objects) AS owned,
  (SELECT COUNT(*) FROM all_tab_privs WHERE privilege IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX')
    AND grantee IN (SELECT role FROM session_roles UNION SELECT USER FROM dual UNION SELECT 'PUBLIC' FROM dual)) AS obj_privs
FROM dual`;

type Rows = { rows?: unknown[][] };

export const loadOracleInventory = async (
    connection: oracledb.Connection,
    allowRoutines: string[]
): Promise<OracleInventory> => {
    const allowed = new Set(allowRoutines.map((r) => r.toUpperCase()));
    const isAllowed = (owner: string, name: string): boolean => allowed.has(name) || allowed.has(`${owner}.${name}`);

    let mode: OracleInventory['mode'] = 'precise';
    let roots: unknown[][];
    let edges: unknown[][];
    const options = { fetchArraySize: 10_000 };
    try {
        await connection.execute('SELECT 1 FROM dba_source WHERE ROWNUM = 1');
        await connection.execute('SELECT 1 FROM dba_dependencies WHERE ROWNUM = 1');
        roots = ((await connection.execute(PRECISE_ROOTS, [], options)) as Rows).rows ?? [];
        edges = ((await connection.execute(dependencies('dba_dependencies'), [], options)) as Rows).rows ?? [];
    } catch {
        mode = 'conservative';
        roots = ((await connection.execute(CONSERVATIVE_ROOTS, [], options)) as Rows).rows ?? [];
        edges = ((await connection.execute(dependencies('all_dependencies'), [], options)) as Rows).rows ?? [];
    }
    // Everything that (transitively) depends on an unsafe, non-allowlisted routine is blocked too.
    const dependents = new Map<string, string[]>();
    for (const [owner, name, refOwner, refName] of edges as [string, string, string, string][]) {
        const key = `${refOwner}.${refName}`;
        const list = dependents.get(key) ?? [];
        list.push(`${owner}.${name}`);
        dependents.set(key, list);
    }
    const blockedPairs = new Set<string>();
    const queue: string[] = [];
    for (const [owner, name] of roots as [string, string][]) {
        if (isAllowed(owner, name)) continue;
        const key = `${owner}.${name}`;
        if (!blockedPairs.has(key)) {
            blockedPairs.add(key);
            queue.push(key);
        }
    }
    while (queue.length > 0) {
        for (const dependent of dependents.get(queue.pop() as string) ?? []) {
            const [owner = '', name = ''] = dependent.split('.');
            if (blockedPairs.has(dependent) || isAllowed(owner, name)) continue;
            blockedPairs.add(dependent);
            queue.push(dependent);
        }
    }
    const blocked = new Set([...blockedPairs].map((pair) => pair.slice(pair.indexOf('.') + 1)));
    const synonyms = ((await connection.execute(SYNONYMS)) as Rows).rows ?? [];
    for (const [synonym, owner, name] of synonyms as [string, string, string][]) {
        if (blockedPairs.has(`${owner}.${name}`)) blocked.add(synonym);
    }

    let credential: CredentialState = 'unverified';
    let note = 'privileges could not be inspected';
    try {
        const posture = (((await connection.execute(POSTURE)) as Rows).rows?.[0] ?? [0, 0, 0]) as number[];
        const writeCapable = posture.some((count) => Number(count) > 0);
        credential = writeCapable ? 'write-capable' : 'read-only verified';
        note = writeCapable
            ? 'user owns objects or holds write privileges; read-only is enforced by Periscope'
            : 'user has no write privileges';
    } catch {
        // keep 'unverified'
    }
    return { mode, blocked, credential, credentialNote: note };
};
