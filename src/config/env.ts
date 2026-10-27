import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { parseIsoDuration } from '../core/duration.ts';
import { PeriscopeError } from '../core/errors.ts';
import {
    buildSourceConfig,
    SOURCE_TYPES,
    type SourceConfig,
    type SourceDefaults,
    type SourceType,
    sourceKeySchemas,
    VAR_KEY_TYPES,
} from './sources.ts';

export interface AuthConfig {
    mode: 'entra' | 'entra-broker' | 'none';
    tenantId: string | undefined;
    clientId: string | undefined;
    requiredRole: string;
    scopeName: string;
    /** entra-broker: how Periscope authenticates to Entra (secret, or a federated token file). */
    clientSecret: string | undefined;
    clientAssertionFile: string | undefined;
    /** entra-broker: client ID of a user-assigned managed identity whose token is the client assertion. */
    assertionIdentity: string | undefined;
    /** entra-broker: redirect URIs MCP clients may register, besides loopback. */
    redirectUris: string[];
    accessTokenTtlMs: number;
    sessionTtlMs: number;
    /** Overrides for non-public clouds and tests. Defaults derive from the tenant. */
    issuer: string | undefined;
    jwksUri: string | undefined;
    authorizationServer: string | undefined;
}

export interface ResultsConfig {
    store: 'azureblob' | 'filesystem';
    accountUrl: string | undefined;
    connectionString: string | undefined;
    container: string;
    dir: string;
    retentionMs: number;
    partBytes: number;
}

export interface Config {
    transport: 'stdio' | 'http';
    host: string;
    port: number;
    publicUrl: string;
    auth: AuthConfig;
    results: ResultsConfig;
    download: { urlTtlMs: number; signingKey: Buffer; signingKeyGenerated: boolean };
    read: { maxRows: number; maxBytes: number; maxValueChars: number };
    maxConcurrentQueriesPerUser: number;
    auditLog: string;
    logLevel: string;
    sources: SourceConfig[];
}

type Env = Record<string, string | undefined>;

const fail = (variable: string, reason: string): never => {
    throw new PeriscopeError('config_invalid', `${variable}: ${reason}`, { variable });
};

const intVar = (env: Env, name: string, fallback: number, min = 1): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) fail(name, `expected an integer >= ${min}`);
    return value;
};

const durationVar = (env: Env, name: string, fallback: string): number => {
    const raw = env[name] ?? fallback;
    try {
        return parseIsoDuration(raw);
    } catch {
        return fail(name, `invalid ISO 8601 duration '${raw}'`);
    }
};

const enumVar = <T extends string>(env: Env, name: string, values: readonly T[], fallback: T): T => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!values.includes(raw as T)) fail(name, `expected one of ${values.join(', ')}`);
    return raw as T;
};

const SOURCE_KEY = /^PERISCOPE_SOURCE_(\d+)_([A-Z0-9_]+)$/;
const VAR_KEY = /^VAR_([A-Z0-9_]+)$/;

/** Discovers and validates `PERISCOPE_SOURCE_<i>_<KEY>` variables. */
export const parseSources = (env: Env, defaults: SourceDefaults): SourceConfig[] => {
    const countRaw = env.PERISCOPE_SOURCE_N;
    const count = countRaw === undefined || countRaw === '' ? 0 : Number(countRaw);
    if (!Number.isInteger(count) || count < 0) fail('PERISCOPE_SOURCE_N', 'expected a non-negative integer');

    const byIndex = new Map<number, Record<string, string>>();
    for (const [key, value] of Object.entries(env)) {
        const match = SOURCE_KEY.exec(key);
        if (!match || value === undefined) continue;
        const index = Number(match[1]);
        if (index >= count) fail(key, `index ${index} is not below PERISCOPE_SOURCE_N=${count}`);
        const entry = byIndex.get(index) ?? {};
        entry[match[2] as string] = value;
        byIndex.set(index, entry);
    }

    const sources: SourceConfig[] = [];
    const names = new Set<string>();
    for (let index = 0; index < count; index++) {
        const raw = byIndex.get(index);
        const prefix = `PERISCOPE_SOURCE_${index}`;
        if (!raw) return fail(prefix, 'missing (every index below PERISCOPE_SOURCE_N needs NAME and TYPE)');
        const type = raw.TYPE as SourceType | undefined;
        if (!type) return fail(`${prefix}_TYPE`, 'missing');
        if (!SOURCE_TYPES.includes(type)) return fail(`${prefix}_TYPE`, `expected one of ${SOURCE_TYPES.join(', ')}`);

        const schema = sourceKeySchemas[type];
        const keys: Record<string, string> = {};
        const vars: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) {
            const variable = VAR_KEY.exec(key)?.[1];
            if (variable && VAR_KEY_TYPES.has(type)) vars[variable] = value;
            else if (key in schema.shape) keys[key] = value;
            else fail(`${prefix}_${key}`, `unknown key for type '${type}'`);
        }
        const parsed = schema.safeParse(keys);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const key = issue?.path[0] !== undefined ? `${prefix}_${String(issue.path[0])}` : prefix;
            return fail(key, issue?.message ?? 'invalid');
        }
        let source: SourceConfig;
        try {
            source = buildSourceConfig(index, parsed.data as never, defaults, vars);
        } catch (error) {
            return fail(prefix, error instanceof Error ? error.message : String(error));
        }
        if (names.has(source.name)) fail(`${prefix}_NAME`, `duplicate source name '${source.name}'`);
        names.add(source.name);
        sources.push(source);
    }
    return sources;
};

const urlSchema = z.string().url();

/** Loads the full configuration from environment variables. */
export const loadConfig = (env: Env = process.env): Config => {
    const transport = enumVar(env, 'PERISCOPE_TRANSPORT', ['stdio', 'http'] as const, 'stdio');
    const port = intVar(env, 'PERISCOPE_PORT', 8080, 0);
    const host = env.PERISCOPE_HOST ?? (transport === 'http' ? '0.0.0.0' : '127.0.0.1');

    const authMode = enumVar(
        env,
        'PERISCOPE_AUTH',
        ['entra', 'entra-broker', 'none'] as const,
        transport === 'http' ? 'entra' : 'none'
    );
    if (authMode === 'none' && transport === 'http' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
        fail('PERISCOPE_AUTH', "'none' is only allowed with stdio or a localhost bind (PERISCOPE_HOST)");
    }
    const entraAuth = authMode === 'entra' || authMode === 'entra-broker';
    if (entraAuth) {
        if (!env.PERISCOPE_AUTH_TENANT_ID) fail('PERISCOPE_AUTH_TENANT_ID', `required for ${authMode} auth`);
        if (!env.PERISCOPE_AUTH_CLIENT_ID) fail('PERISCOPE_AUTH_CLIENT_ID', `required for ${authMode} auth`);
    }
    // Workload identity (AKS) injects AZURE_FEDERATED_TOKEN_FILE; it doubles as the client assertion.
    const clientAssertionFile = env.PERISCOPE_AUTH_CLIENT_ASSERTION_FILE ?? env.AZURE_FEDERATED_TOKEN_FILE;
    if (authMode === 'entra-broker') {
        if (transport !== 'http') fail('PERISCOPE_AUTH', "'entra-broker' needs the http transport");
        if (!env.PERISCOPE_AUTH_CLIENT_SECRET && !env.PERISCOPE_AUTH_ASSERTION_IDENTITY && !clientAssertionFile) {
            fail(
                'PERISCOPE_AUTH_CLIENT_ASSERTION_FILE',
                'entra-broker needs a client assertion file, PERISCOPE_AUTH_ASSERTION_IDENTITY or PERISCOPE_AUTH_CLIENT_SECRET'
            );
        }
        if (!env.PERISCOPE_DOWNLOAD_SIGNING_KEY) {
            fail('PERISCOPE_DOWNLOAD_SIGNING_KEY', 'required for entra-broker auth (it also seals OAuth tokens)');
        }
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.PERISCOPE_AUTH_TENANT_ID ?? '')
        ) {
            fail('PERISCOPE_AUTH_TENANT_ID', 'entra-broker needs the tenant ID (GUID), not a domain');
        }
        const path = env.PERISCOPE_PUBLIC_URL ? new URL(env.PERISCOPE_PUBLIC_URL).pathname : '/';
        if (path !== '/' && path !== '') fail('PERISCOPE_PUBLIC_URL', 'entra-broker needs a URL without a path');
    }
    const redirectUris = (
        env.PERISCOPE_AUTH_REDIRECT_URIS ??
        'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'
    )
        .split(',')
        .map((uri) => uri.trim())
        .filter(Boolean);
    for (const uri of authMode === 'entra-broker' ? redirectUris : []) {
        if (!uri.startsWith('https://') || !urlSchema.safeParse(uri).success) {
            fail('PERISCOPE_AUTH_REDIRECT_URIS', `'${uri}' is not an https URL`);
        }
    }

    let publicUrl = env.PERISCOPE_PUBLIC_URL;
    if (transport === 'http' && entraAuth && !publicUrl) fail('PERISCOPE_PUBLIC_URL', 'required for http');
    if (publicUrl !== undefined && !urlSchema.safeParse(publicUrl).success) fail('PERISCOPE_PUBLIC_URL', 'invalid URL');
    publicUrl = (publicUrl ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`).replace(/\/+$/, '');

    const storeDefault = transport === 'http' ? 'azureblob' : 'filesystem';
    const store = enumVar(env, 'PERISCOPE_RESULTS_STORE', ['azureblob', 'filesystem'] as const, storeDefault);
    if (store === 'azureblob' && !env.PERISCOPE_RESULTS_ACCOUNT_URL && !env.PERISCOPE_RESULTS_CONNECTION_STRING) {
        fail('PERISCOPE_RESULTS_ACCOUNT_URL', 'required for the azureblob result store');
    }

    let signingKey: Buffer;
    let signingKeyGenerated = false;
    if (env.PERISCOPE_DOWNLOAD_SIGNING_KEY) {
        signingKey = Buffer.from(env.PERISCOPE_DOWNLOAD_SIGNING_KEY, 'utf8');
        if (signingKey.length < 32) fail('PERISCOPE_DOWNLOAD_SIGNING_KEY', 'must be at least 32 bytes');
    } else {
        if (transport === 'http' && store === 'azureblob') {
            fail('PERISCOPE_DOWNLOAD_SIGNING_KEY', 'required when results are shared across replicas');
        }
        signingKey = randomBytes(32);
        signingKeyGenerated = true;
    }

    const maxQueryDurationMs = durationVar(env, 'PERISCOPE_MAX_QUERY_DURATION', 'PT15M');
    const maxResultBytes = intVar(env, 'PERISCOPE_MAX_RESULT_BYTES', 10 * 1024 ** 3);

    return {
        transport,
        host,
        port,
        publicUrl,
        auth: {
            mode: authMode,
            tenantId: env.PERISCOPE_AUTH_TENANT_ID,
            clientId: env.PERISCOPE_AUTH_CLIENT_ID,
            requiredRole: env.PERISCOPE_AUTH_REQUIRED_ROLE ?? 'Periscope.Reader',
            scopeName: env.PERISCOPE_AUTH_SCOPE ?? 'Periscope.Access',
            clientSecret: env.PERISCOPE_AUTH_CLIENT_SECRET,
            clientAssertionFile,
            assertionIdentity: env.PERISCOPE_AUTH_ASSERTION_IDENTITY,
            redirectUris,
            accessTokenTtlMs: durationVar(env, 'PERISCOPE_AUTH_ACCESS_TOKEN_TTL', 'PT1H'),
            sessionTtlMs: durationVar(env, 'PERISCOPE_AUTH_SESSION_TTL', 'P30D'),
            issuer: env.PERISCOPE_AUTH_ISSUER,
            jwksUri: env.PERISCOPE_AUTH_JWKS_URI,
            authorizationServer: env.PERISCOPE_AUTH_AUTHORIZATION_SERVER,
        },
        results: {
            store,
            accountUrl: env.PERISCOPE_RESULTS_ACCOUNT_URL,
            connectionString: env.PERISCOPE_RESULTS_CONNECTION_STRING,
            container: env.PERISCOPE_RESULTS_CONTAINER ?? 'results',
            dir: env.PERISCOPE_RESULTS_DIR ?? './.periscope/results',
            retentionMs: durationVar(env, 'PERISCOPE_RESULTS_RETENTION', 'PT24H'),
            partBytes: intVar(env, 'PERISCOPE_RESULTS_PART_BYTES', 100 * 1024 * 1024),
        },
        download: {
            urlTtlMs: durationVar(env, 'PERISCOPE_DOWNLOAD_URL_TTL', 'PT1H'),
            signingKey,
            signingKeyGenerated,
        },
        read: {
            maxRows: intVar(env, 'PERISCOPE_READ_MAX_ROWS', 500),
            maxBytes: intVar(env, 'PERISCOPE_READ_MAX_BYTES', 65_536),
            maxValueChars: intVar(env, 'PERISCOPE_READ_MAX_VALUE_CHARS', 2000),
        },
        maxConcurrentQueriesPerUser: intVar(env, 'PERISCOPE_MAX_CONCURRENT_QUERIES', 4),
        auditLog: env.PERISCOPE_AUDIT_LOG ?? (transport === 'stdio' ? 'stderr' : 'stdout'),
        logLevel: env.PERISCOPE_LOG_LEVEL ?? 'info',
        sources: parseSources(env, { maxQueryDurationMs, maxResultBytes }),
    };
};
