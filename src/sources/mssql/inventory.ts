import type { ConnectionPool, Transaction } from 'mssql';
import sql from 'mssql';
import type { CredentialState } from '../adapter.ts';

/**
 * Routine inventory for SQL Server.
 *
 * User-defined functions cannot change data, and the transaction around every query is
 * rolled back. What remains are side effects outside the database transaction: extended
 * stored procedures (`EXEC xp_…` is allowed inside functions), OLE Automation, CLR and
 * linked servers. So:
 * - functions that use EXEC, extended procedures, OLE Automation or remote rowsets, CLR
 *   functions, and functions whose definition cannot be read are always blocked;
 * - strict mode (sysadmin login, xp_cmdshell, OLE Automation or CLR enabled, a TRUSTWORTHY
 *   database, or linked servers present): every user-defined function is blocked unless allowlisted, and
 *   views whose dependencies cannot be read are blocked too;
 * - views (transitively) depending on a blocked function, or on a linked server unless
 *   allowed, are blocked.
 */
export interface MssqlInventory {
    strict: boolean;
    reasons: string[];
    blocked: Set<string>;
    readOnlyReplica: boolean;
    snapshotIsolation: boolean;
    credential: CredentialState;
    credentialNote: string;
}

const CAPABILITIES = `
SELECT
  CAST(ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS int) AS sysadmin,
  (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'xp_cmdshell') AS xp_cmdshell,
  (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'Ole Automation Procedures') AS ole,
  (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'clr enabled') AS clr,
  (SELECT COUNT(*) FROM sys.servers WHERE is_linked = 1) AS linked,
  CAST(DATABASEPROPERTYEX(DB_NAME(), 'Updateability') AS nvarchar(20)) AS updateability,
  (SELECT snapshot_isolation_state FROM sys.databases WHERE name = DB_NAME()) AS snapshot_state,
  (SELECT CAST(is_trustworthy_on AS int) FROM sys.databases WHERE name = DB_NAME()) AS trustworthy`;

const MODULES = `
SELECT o.object_id AS id, s.name AS schema_name, o.name, RTRIM(o.type) AS type, m.definition
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE o.is_ms_shipped = 0 AND o.type IN ('FN', 'IF', 'TF', 'FS', 'FT', 'AF', 'V')`;

const DEPENDENCIES = `
SELECT referencing_id, referenced_id, referenced_server_name, referenced_entity_name
FROM sys.sql_expression_dependencies`;

const POSTURE = `
SELECT
  CAST(ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS int)
  + CAST(ISNULL(IS_ROLEMEMBER('db_owner'), 0) AS int)
  + CAST(ISNULL(IS_ROLEMEMBER('db_datawriter'), 0) AS int)
  + CAST(ISNULL(IS_ROLEMEMBER('db_ddladmin'), 0) AS int)
  + ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT'), 0)
  + ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE'), 0)
  + ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE'), 0)
  + ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER'), 0)
  + ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'), 0) AS write_capabilities`;

const UNSAFE_DEFINITION = /\bEXEC(UTE)?\b|\bxp_|\bsp_OA|\bOPENROWSET\b|\bOPENQUERY\b|\bOPENDATASOURCE\b/i;
const FUNCTION_TYPES = new Set(['FN', 'IF', 'TF', 'FS', 'FT', 'AF']);
const CLR_TYPES = new Set(['FS', 'FT', 'AF']);

interface ModuleRow {
    id: number;
    schema_name: string;
    name: string;
    type: string;
    definition: string | null;
}

interface DependencyRow {
    referencing_id: number;
    referenced_id: number | null;
    referenced_server_name: string | null;
}

export const loadMssqlInventory = async (
    pool: ConnectionPool | Transaction,
    options: { allowRoutines: string[]; allowLinkedServers: boolean }
): Promise<MssqlInventory> => {
    const query = <T>(text: string): Promise<T[]> => {
        const request = new sql.Request(pool as never);
        request.arrayRowMode = false;
        return request.query<T>(text).then((r) => r.recordset as T[]);
    };
    const allowed = new Set(options.allowRoutines.map((r) => r.toUpperCase()));
    const isAllowed = (m: ModuleRow): boolean =>
        allowed.has(m.name.toUpperCase()) || allowed.has(`${m.schema_name}.${m.name}`.toUpperCase());

    const [capabilities] = await query<{
        sysadmin: number;
        xp_cmdshell: number | null;
        ole: number | null;
        clr: number | null;
        linked: number;
        updateability: string | null;
        snapshot_state: number | null;
        trustworthy: number | null;
    }>(CAPABILITIES);
    const reasons: string[] = [];
    if (capabilities?.sysadmin) reasons.push('sysadmin login');
    if (capabilities?.xp_cmdshell) reasons.push('xp_cmdshell enabled');
    if (capabilities?.ole) reasons.push('OLE Automation enabled');
    if (capabilities?.clr) reasons.push('CLR enabled');
    if (capabilities?.trustworthy) reasons.push('database is TRUSTWORTHY');
    if (capabilities?.linked) reasons.push(`${capabilities.linked} linked server(s)`);
    const strict = reasons.length > 0;

    const modules = await query<ModuleRow>(MODULES);
    const dependencies = await query<DependencyRow>(DEPENDENCIES);
    const byId = new Map(modules.map((m) => [m.id, m]));
    const blockedIds = new Set<number>();

    for (const module of modules) {
        if (isAllowed(module)) continue;
        if (FUNCTION_TYPES.has(module.type)) {
            const unsafe =
                CLR_TYPES.has(module.type) ||
                module.definition === null ||
                UNSAFE_DEFINITION.test(module.definition) ||
                strict;
            if (unsafe) blockedIds.add(module.id);
        } else if (module.type === 'V' && strict && module.definition === null) {
            blockedIds.add(module.id); // dependencies of an unreadable view cannot be checked
        }
    }
    const dependents = new Map<number, number[]>();
    for (const dependency of dependencies) {
        if (dependency.referenced_server_name && !options.allowLinkedServers) {
            const module = byId.get(dependency.referencing_id);
            if (module && !isAllowed(module)) blockedIds.add(module.id);
        }
        if (dependency.referenced_id === null) continue;
        const list = dependents.get(dependency.referenced_id) ?? [];
        list.push(dependency.referencing_id);
        dependents.set(dependency.referenced_id, list);
    }
    const queue = [...blockedIds];
    while (queue.length > 0) {
        for (const dependent of dependents.get(queue.pop() as number) ?? []) {
            const module = byId.get(dependent);
            if (blockedIds.has(dependent) || (module && isAllowed(module))) continue;
            blockedIds.add(dependent);
            queue.push(dependent);
        }
    }
    const blocked = new Set<string>();
    for (const id of blockedIds) {
        const module = byId.get(id);
        if (module) blocked.add(module.name.toUpperCase());
    }

    const readOnlyReplica = capabilities?.updateability === 'READ_ONLY';
    let credential: CredentialState = 'unverified';
    let note = 'permissions could not be inspected';
    try {
        const [posture] = await query<{ write_capabilities: number }>(POSTURE);
        const writeCapable = Number(posture?.write_capabilities ?? 0) > 0;
        credential = readOnlyReplica || !writeCapable ? 'read-only verified' : 'write-capable';
        note = readOnlyReplica
            ? 'connected to a read-only replica (ApplicationIntent=ReadOnly)'
            : writeCapable
              ? 'login can write or change the schema; read-only is enforced by Periscope'
              : 'login has no write permissions';
    } catch {
        // keep 'unverified'
    }
    return {
        strict,
        reasons,
        blocked,
        readOnlyReplica,
        snapshotIsolation: capabilities?.snapshot_state === 1,
        credential,
        credentialNote: note,
    };
};
