import { z } from 'zod';
import { parseIsoDuration } from '../core/duration.ts';

export const SOURCE_TYPES = ['postgres', 'oracle', 'mssql', 'cosmos', 'blob', 'loganalytics', 'redis'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const bool = z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => ['true', 'false', '1', '0', 'yes', 'no'].includes(v), 'expected true or false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');
const positiveInt = z.coerce.number().int().positive();
const port = z.coerce.number().int().min(1).max(65535);
const duration = z.string().transform((v, ctx) => {
    try {
        return parseIsoDuration(v);
    } catch {
        ctx.addIssue({ code: 'custom', message: `invalid ISO 8601 duration '${v}'` });
        return z.NEVER;
    }
});
const list = z.string().transform((v) =>
    v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
);
const auth = z.enum(['azure']);

const common = {
    NAME: z.string().regex(/^[a-z0-9_-]{1,64}$/, 'must match [a-z0-9_-]{1,64}'),
    DESCRIPTION: z.string().optional(),
    REQUIRED_ROLE: z.string().min(1).optional(),
    DOWNLOAD_ROLE: z.string().min(1).optional(),
    MAX_QUERY_DURATION: duration.optional(),
    MAX_RESULT_BYTES: positiveInt.optional(),
};

const schemas = {
    postgres: z.object({
        ...common,
        TYPE: z.literal('postgres'),
        URL: z.string().optional(),
        HOST: z.string().optional(),
        PORT: port.optional(),
        DATABASE: z.string().optional(),
        USER: z.string().optional(),
        PASSWORD: z.string().optional(),
        AUTH: auth.optional(),
        SSL: z.enum(['disable', 'require', 'verify-full']).optional(),
        SEARCH_PATH: z.string().optional(),
        ALLOW_ROUTINES: list.optional(),
    }),
    oracle: z.object({
        ...common,
        TYPE: z.literal('oracle'),
        CONNECT_STRING: z.string().optional(),
        HOST: z.string().optional(),
        PORT: port.optional(),
        SID: z.string().optional(),
        SERVICE_NAME: z.string().optional(),
        USER: z.string(),
        PASSWORD: z.string(),
        ALLOW_ROUTINES: list.optional(),
        ALLOW_DBLINKS: bool.optional(),
    }),
    mssql: z.object({
        ...common,
        TYPE: z.literal('mssql'),
        CONNECTION_STRING: z.string().optional(),
        HOST: z.string().optional(),
        PORT: port.optional(),
        DATABASE: z.string().optional(),
        USER: z.string().optional(),
        PASSWORD: z.string().optional(),
        AUTH: auth.optional(),
        ENCRYPT: bool.optional(),
        TRUST_SERVER_CERTIFICATE: bool.optional(),
        READ_INTENT: bool.optional(),
        ALLOW_ROUTINES: list.optional(),
        ALLOW_LINKED_SERVERS: bool.optional(),
    }),
    cosmos: z.object({
        ...common,
        TYPE: z.literal('cosmos'),
        CONNECTION_STRING: z.string().optional(),
        ENDPOINT: z.string().url().optional(),
        KEY: z.string().optional(),
        AUTH: auth.optional(),
        DATABASE: z.string().optional(),
        MAX_RU_PER_SEC: positiveInt.optional(),
        LOW_PRIORITY: bool.optional(),
    }),
    blob: z.object({
        ...common,
        TYPE: z.literal('blob'),
        CONNECTION_STRING: z.string().optional(),
        ACCOUNT_URL: z.string().url().optional(),
        SAS: z.string().optional(),
        AUTH: auth.optional(),
        CONTAINER: z.string().optional(),
    }),
    loganalytics: z.object({
        ...common,
        TYPE: z.literal('loganalytics'),
        WORKSPACE_ID: z.string().optional(),
        RESOURCE_ID: z.string().startsWith('/').optional(),
        AUTH: auth.optional(),
        DEFAULT_TIMESPAN: z.string().optional(),
        ENDPOINT: z.string().url().optional(),
    }),
    redis: z.object({
        ...common,
        TYPE: z.literal('redis'),
        URL: z.string().optional(),
        HOST: z.string().optional(),
        PORT: port.optional(),
        USERNAME: z.string().optional(),
        PASSWORD: z.string().optional(),
        TLS: bool.optional(),
        AUTH: auth.optional(),
        DATABASE: z.coerce.number().int().min(0).optional(),
        CLUSTER: bool.optional(),
        READ_FROM_REPLICAS: bool.optional(),
        MAX_OPS_PER_SEC: positiveInt.optional(),
    }),
} as const;

export const sourceKeySchemas = schemas;

/** Keys that hold secrets. Their values are never logged or echoed. */
export const SECRET_KEYS = new Set(['PASSWORD', 'KEY', 'SAS', 'CONNECTION_STRING', 'URL', 'CONNECT_STRING']);

type Raw<T extends SourceType> = z.infer<(typeof schemas)[T]>;

interface CommonSourceConfig {
    index: number;
    name: string;
    description: string | undefined;
    requiredRole: string | undefined;
    downloadRole: string | undefined;
    maxQueryDurationMs: number;
    maxResultBytes: number;
}

export interface PostgresSourceConfig extends CommonSourceConfig {
    type: 'postgres';
    url: string | undefined;
    host: string | undefined;
    port: number | undefined;
    database: string | undefined;
    user: string | undefined;
    password: string | undefined;
    azureAuth: boolean;
    ssl: 'disable' | 'require' | 'verify-full' | undefined;
    searchPath: string | undefined;
    allowRoutines: string[];
}

export interface OracleSourceConfig extends CommonSourceConfig {
    type: 'oracle';
    connectString: string;
    user: string;
    password: string;
    allowRoutines: string[];
    allowDbLinks: boolean;
}

export interface MssqlSourceConfig extends CommonSourceConfig {
    type: 'mssql';
    connectionString: string | undefined;
    host: string | undefined;
    port: number;
    database: string | undefined;
    user: string | undefined;
    password: string | undefined;
    azureAuth: boolean;
    encrypt: boolean;
    trustServerCertificate: boolean;
    readIntent: boolean;
    allowRoutines: string[];
    allowLinkedServers: boolean;
}

export interface CosmosSourceConfig extends CommonSourceConfig {
    type: 'cosmos';
    endpoint: string;
    key: string | undefined;
    azureAuth: boolean;
    database: string | undefined;
    maxRuPerSec: number | undefined;
    lowPriority: boolean;
}

export interface BlobSourceConfig extends CommonSourceConfig {
    type: 'blob';
    connectionString: string | undefined;
    accountUrl: string | undefined;
    sas: string | undefined;
    azureAuth: boolean;
    container: string | undefined;
}

export interface LogAnalyticsSourceConfig extends CommonSourceConfig {
    type: 'loganalytics';
    workspaceId: string | undefined;
    resourceId: string | undefined;
    defaultTimespan: string;
    endpoint: string;
}

export interface RedisSourceConfig extends CommonSourceConfig {
    type: 'redis';
    url: string | undefined;
    host: string | undefined;
    port: number | undefined;
    username: string | undefined;
    password: string | undefined;
    tls: boolean;
    azureAuth: boolean;
    database: number | undefined;
    cluster: boolean;
    readFromReplicas: boolean;
    maxOpsPerSec: number | undefined;
}

export type SourceConfig =
    | PostgresSourceConfig
    | OracleSourceConfig
    | MssqlSourceConfig
    | CosmosSourceConfig
    | BlobSourceConfig
    | LogAnalyticsSourceConfig
    | RedisSourceConfig;

export interface SourceDefaults {
    maxQueryDurationMs: number;
    maxResultBytes: number;
}

const commonFields = (index: number, raw: Raw<SourceType>, defaults: SourceDefaults): CommonSourceConfig => ({
    index,
    name: raw.NAME,
    description: raw.DESCRIPTION,
    requiredRole: raw.REQUIRED_ROLE,
    downloadRole: raw.DOWNLOAD_ROLE,
    maxQueryDurationMs: raw.MAX_QUERY_DURATION ?? defaults.maxQueryDurationMs,
    maxResultBytes: raw.MAX_RESULT_BYTES ?? defaults.maxResultBytes,
});

/** Parses Cosmos connection strings of the form `AccountEndpoint=...;AccountKey=...;`. */
export const parseCosmosConnectionString = (value: string): { endpoint: string; key: string } => {
    const parts = new Map<string, string>();
    for (const segment of value.split(';')) {
        const eq = segment.indexOf('=');
        if (eq > 0) parts.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim());
    }
    const endpoint = parts.get('accountendpoint');
    const key = parts.get('accountkey');
    if (!endpoint || !key) throw new Error('connection string needs AccountEndpoint and AccountKey');
    return { endpoint, key };
};

const buildOracleConnectString = (raw: Raw<'oracle'>): string => {
    if (raw.CONNECT_STRING) return raw.CONNECT_STRING;
    if (!raw.HOST) throw new Error('needs CONNECT_STRING or HOST');
    const portNumber = raw.PORT ?? 1521;
    if (raw.SID) {
        return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${raw.HOST})(PORT=${portNumber}))(CONNECT_DATA=(SID=${raw.SID})))`;
    }
    if (!raw.SERVICE_NAME) throw new Error('needs SID or SERVICE_NAME together with HOST');
    return `${raw.HOST}:${portNumber}/${raw.SERVICE_NAME}`;
};

/** Converts validated raw keys into a typed source config. Throws plain Errors with a reason. */
export const buildSourceConfig = (
    index: number,
    raw: Raw<SourceType> & { TYPE: SourceType },
    defaults: SourceDefaults
): SourceConfig => {
    const base = commonFields(index, raw, defaults);
    switch (raw.TYPE) {
        case 'postgres': {
            const r = raw as Raw<'postgres'>;
            if (!r.URL && !r.HOST) throw new Error('needs URL or HOST');
            return {
                ...base,
                type: 'postgres',
                url: r.URL,
                host: r.HOST,
                port: r.PORT,
                database: r.DATABASE,
                user: r.USER,
                password: r.PASSWORD,
                azureAuth: r.AUTH === 'azure',
                ssl: r.SSL,
                searchPath: r.SEARCH_PATH,
                allowRoutines: (r.ALLOW_ROUTINES ?? []).map((s) => s.toLowerCase()),
            };
        }
        case 'oracle': {
            const r = raw as Raw<'oracle'>;
            return {
                ...base,
                type: 'oracle',
                connectString: buildOracleConnectString(r),
                user: r.USER,
                password: r.PASSWORD,
                allowRoutines: (r.ALLOW_ROUTINES ?? []).map((s) => s.toUpperCase()),
                allowDbLinks: r.ALLOW_DBLINKS ?? false,
            };
        }
        case 'mssql': {
            const r = raw as Raw<'mssql'>;
            if (!r.CONNECTION_STRING && !r.HOST) throw new Error('needs CONNECTION_STRING or HOST');
            if (!r.CONNECTION_STRING && r.AUTH !== 'azure' && (!r.USER || !r.PASSWORD)) {
                throw new Error('needs USER and PASSWORD, or AUTH=azure');
            }
            const readIntentInString = /applicationintent\s*=\s*readonly/i.test(r.CONNECTION_STRING ?? '');
            return {
                ...base,
                type: 'mssql',
                connectionString: r.CONNECTION_STRING,
                host: r.HOST,
                port: r.PORT ?? 1433,
                database: r.DATABASE,
                user: r.USER,
                password: r.PASSWORD,
                azureAuth: r.AUTH === 'azure',
                encrypt: r.ENCRYPT ?? true,
                trustServerCertificate: r.TRUST_SERVER_CERTIFICATE ?? false,
                readIntent: r.READ_INTENT ?? readIntentInString,
                allowRoutines: (r.ALLOW_ROUTINES ?? []).map((s) => s.toUpperCase()),
                allowLinkedServers: r.ALLOW_LINKED_SERVERS ?? false,
            };
        }
        case 'cosmos': {
            const r = raw as Raw<'cosmos'>;
            let endpoint = r.ENDPOINT;
            let key = r.KEY;
            if (r.CONNECTION_STRING) ({ endpoint, key } = parseCosmosConnectionString(r.CONNECTION_STRING));
            if (!endpoint) throw new Error('needs CONNECTION_STRING or ENDPOINT');
            if (!key && r.AUTH !== 'azure') throw new Error('needs KEY or AUTH=azure');
            return {
                ...base,
                type: 'cosmos',
                endpoint,
                key: r.AUTH === 'azure' ? undefined : key,
                azureAuth: r.AUTH === 'azure',
                database: r.DATABASE,
                maxRuPerSec: r.MAX_RU_PER_SEC,
                lowPriority: r.LOW_PRIORITY ?? false,
            };
        }
        case 'blob': {
            const r = raw as Raw<'blob'>;
            if (!r.CONNECTION_STRING && !r.ACCOUNT_URL) throw new Error('needs CONNECTION_STRING or ACCOUNT_URL');
            if (r.ACCOUNT_URL && !r.CONNECTION_STRING && !r.SAS && r.AUTH !== 'azure') {
                throw new Error('ACCOUNT_URL needs SAS or AUTH=azure');
            }
            return {
                ...base,
                type: 'blob',
                connectionString: r.CONNECTION_STRING,
                accountUrl: r.ACCOUNT_URL,
                sas: r.SAS,
                azureAuth: r.AUTH === 'azure',
                container: r.CONTAINER,
            };
        }
        case 'loganalytics': {
            const r = raw as Raw<'loganalytics'>;
            if (!r.WORKSPACE_ID === !r.RESOURCE_ID) throw new Error('needs exactly one of WORKSPACE_ID or RESOURCE_ID');
            const timespan = r.DEFAULT_TIMESPAN ?? 'P1D';
            parseIsoDuration(timespan);
            return {
                ...base,
                type: 'loganalytics',
                workspaceId: r.WORKSPACE_ID,
                resourceId: r.RESOURCE_ID,
                defaultTimespan: timespan,
                endpoint: (r.ENDPOINT ?? 'https://api.loganalytics.io').replace(/\/+$/, ''),
            };
        }
        case 'redis': {
            const r = raw as Raw<'redis'>;
            if (!r.URL && !r.HOST) throw new Error('needs URL or HOST');
            if (r.CLUSTER && r.DATABASE !== undefined && r.DATABASE !== 0) {
                throw new Error('DATABASE is not supported in cluster mode');
            }
            return {
                ...base,
                type: 'redis',
                url: r.URL,
                host: r.HOST,
                port: r.PORT,
                username: r.USERNAME,
                password: r.PASSWORD,
                tls: r.TLS ?? false,
                azureAuth: r.AUTH === 'azure',
                database: r.DATABASE,
                cluster: r.CLUSTER ?? false,
                readFromReplicas: r.READ_FROM_REPLICAS ?? false,
                maxOpsPerSec: r.MAX_OPS_PER_SEC,
            };
        }
    }
};
