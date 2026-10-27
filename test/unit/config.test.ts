import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadConfig, parseSources } from '../../src/config/env.ts';
import { PeriscopeError } from '../../src/core/errors.ts';

const defaults = { maxQueryDurationMs: 900_000, maxResultBytes: 10 * 1024 ** 3 };

const expectConfigError = (fn: () => unknown, variable: RegExp): void => {
    assert.throws(
        fn,
        (error: unknown) =>
            error instanceof PeriscopeError && error.code === 'config_invalid' && variable.test(error.message)
    );
};

describe('source configuration', () => {
    it('parses one source of every type', () => {
        const sources = parseSources(
            {
                PERISCOPE_SOURCE_N: '6',
                PERISCOPE_SOURCE_0_NAME: 'pg',
                PERISCOPE_SOURCE_0_TYPE: 'postgres',
                PERISCOPE_SOURCE_0_URL: 'postgres://u:p@h/db',
                PERISCOPE_SOURCE_0_ALLOW_ROUTINES: 'public.f, g',
                PERISCOPE_SOURCE_1_NAME: 'erp',
                PERISCOPE_SOURCE_1_TYPE: 'oracle',
                PERISCOPE_SOURCE_1_HOST: 'db',
                PERISCOPE_SOURCE_1_SID: 'ORCL',
                PERISCOPE_SOURCE_1_USER: 'u',
                PERISCOPE_SOURCE_1_PASSWORD: 'p',
                PERISCOPE_SOURCE_2_NAME: 'docs',
                PERISCOPE_SOURCE_2_TYPE: 'cosmos',
                PERISCOPE_SOURCE_2_CONNECTION_STRING:
                    'AccountEndpoint=https://a.documents.azure.com:443/;AccountKey=k==;',
                PERISCOPE_SOURCE_2_MAX_RU_PER_SEC: '500',
                PERISCOPE_SOURCE_3_NAME: 'files',
                PERISCOPE_SOURCE_3_TYPE: 'blob',
                PERISCOPE_SOURCE_3_ACCOUNT_URL: 'https://a.blob.core.windows.net',
                PERISCOPE_SOURCE_3_AUTH: 'azure',
                PERISCOPE_SOURCE_4_NAME: 'logs',
                PERISCOPE_SOURCE_4_TYPE: 'loganalytics',
                PERISCOPE_SOURCE_4_WORKSPACE_ID: 'ws',
                PERISCOPE_SOURCE_4_MAX_QUERY_DURATION: 'PT5M',
                PERISCOPE_SOURCE_5_NAME: 'cache',
                PERISCOPE_SOURCE_5_TYPE: 'redis',
                PERISCOPE_SOURCE_5_HOST: 'r',
                PERISCOPE_SOURCE_5_CLUSTER: 'true',
            },
            defaults
        );
        assert.deepEqual(
            sources.map((s) => s.type),
            ['postgres', 'oracle', 'cosmos', 'blob', 'loganalytics', 'redis']
        );
        const [pg, oracle, cosmos, , logs, redis] = sources;
        assert.deepEqual(pg?.type === 'postgres' && pg.allowRoutines, ['public.f', 'g']);
        assert.equal(
            oracle?.type === 'oracle' && oracle.connectString,
            '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))'
        );
        assert.equal(cosmos?.type === 'cosmos' && cosmos.endpoint, 'https://a.documents.azure.com:443/');
        assert.equal(logs?.maxQueryDurationMs, 300_000);
        assert.equal(redis?.type === 'redis' && redis.cluster, true);
    });

    it('parses sql server sources and derives the read intent', () => {
        const [pooled, direct] = parseSources(
            {
                PERISCOPE_SOURCE_N: '2',
                PERISCOPE_SOURCE_0_NAME: 'crm',
                PERISCOPE_SOURCE_0_TYPE: 'mssql',
                PERISCOPE_SOURCE_0_CONNECTION_STRING:
                    'Server=tcp:db,1433;Database=crm;User Id=u;Password=p;ApplicationIntent=ReadOnly',
                PERISCOPE_SOURCE_0_ALLOW_ROUTINES: 'dbo.f',
                PERISCOPE_SOURCE_1_NAME: 'billing',
                PERISCOPE_SOURCE_1_TYPE: 'mssql',
                PERISCOPE_SOURCE_1_HOST: 'db',
                PERISCOPE_SOURCE_1_DATABASE: 'billing',
                PERISCOPE_SOURCE_1_AUTH: 'azure',
            },
            defaults
        );
        assert.equal(pooled?.type === 'mssql' && pooled.readIntent, true);
        assert.deepEqual(pooled?.type === 'mssql' && pooled.allowRoutines, ['DBO.F']);
        assert.equal(direct?.type === 'mssql' && direct.readIntent, false);
        assert.equal(direct?.type === 'mssql' && direct.port, 1433);
        assert.equal(direct?.type === 'mssql' && direct.encrypt, true);
        assert.throws(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '1',
                        PERISCOPE_SOURCE_0_NAME: 'x',
                        PERISCOPE_SOURCE_0_TYPE: 'mssql',
                        PERISCOPE_SOURCE_0_HOST: 'db',
                    },
                    defaults
                ),
            /USER and PASSWORD/
        );
    });

    it('parses kim sources and normalizes origins', () => {
        const [kim] = parseSources(
            {
                PERISCOPE_SOURCE_N: '1',
                PERISCOPE_SOURCE_0_NAME: 'records',
                PERISCOPE_SOURCE_0_TYPE: 'kim',
                PERISCOPE_SOURCE_0_URL: 'https://kim.example.com/',
                PERISCOPE_SOURCE_0_STAGE: 'acme.crm.prod',
                PERISCOPE_SOURCE_0_API_KEY: `kim_sk_${'0'.repeat(64)}`,
            },
            defaults
        );
        assert.ok(kim?.type === 'kim');
        assert.equal(kim.url, 'https://kim.example.com');
        assert.equal(kim.identityUrl, 'https://kim.example.com');
        assert.equal(kim.allowReveal, false);
        assert.throws(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '1',
                        PERISCOPE_SOURCE_0_NAME: 'records',
                        PERISCOPE_SOURCE_0_TYPE: 'kim',
                        PERISCOPE_SOURCE_0_URL: 'https://kim.example.com',
                        PERISCOPE_SOURCE_0_STAGE: 'acme.crm.prod',
                        PERISCOPE_SOURCE_0_API_KEY: 'not-a-key',
                    },
                    defaults
                ),
            /API_KEY/
        );
    });

    it('parses rest sources with rules, headers and script variables', () => {
        const [source] = parseSources(
            {
                PERISCOPE_SOURCE_N: '1',
                PERISCOPE_SOURCE_0_NAME: 'api',
                PERISCOPE_SOURCE_0_TYPE: 'rest',
                PERISCOPE_SOURCE_0_BASE_URL: 'https://api.example.com/v1/',
                PERISCOPE_SOURCE_0_ALLOW: 'GET /items/**,\nPOST /search',
                PERISCOPE_SOURCE_0_ALLOW_HEADERS: 'X-Api-Version',
                PERISCOPE_SOURCE_0_VAR_USERNAME: 'reader',
                PERISCOPE_SOURCE_0_VAR_PASSWORD: 'secret',
            },
            defaults
        );
        assert.ok(source?.type === 'rest');
        assert.equal(source.baseUrl, 'https://api.example.com/v1');
        assert.deepEqual(source.allow, ['GET /items/**', 'POST /search']);
        assert.deepEqual(source.allowHeaders, ['x-api-version']);
        assert.deepEqual(source.vars, { USERNAME: 'reader', PASSWORD: 'secret' });
        assert.equal(source.maxRequests, 1000);
        const [plain] = parseSources(
            {
                PERISCOPE_SOURCE_N: '1',
                PERISCOPE_SOURCE_0_NAME: 'api',
                PERISCOPE_SOURCE_0_TYPE: 'rest',
                PERISCOPE_SOURCE_0_BASE_URL: 'https://api.example.com',
            },
            defaults
        );
        assert.deepEqual(plain?.type === 'rest' && plain.allow, ['GET /**']);
        expectConfigError(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '1',
                        PERISCOPE_SOURCE_0_NAME: 'api',
                        PERISCOPE_SOURCE_0_TYPE: 'rest',
                        PERISCOPE_SOURCE_0_BASE_URL: 'https://api.example.com',
                        PERISCOPE_SOURCE_0_ALLOW: 'GET /a/../b',
                    },
                    defaults
                ),
            /PERISCOPE_SOURCE_0/
        );
        expectConfigError(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '1',
                        PERISCOPE_SOURCE_0_NAME: 'pg',
                        PERISCOPE_SOURCE_0_TYPE: 'postgres',
                        PERISCOPE_SOURCE_0_URL: 'postgres://h/db',
                        PERISCOPE_SOURCE_0_VAR_X: 'y',
                    },
                    defaults
                ),
            /PERISCOPE_SOURCE_0_VAR_X/
        );
    });

    it('rejects missing, extra and duplicate entries and unknown keys', () => {
        expectConfigError(() => parseSources({ PERISCOPE_SOURCE_N: '1' }, defaults), /PERISCOPE_SOURCE_0/);
        expectConfigError(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '1',
                        PERISCOPE_SOURCE_0_NAME: 'a',
                        PERISCOPE_SOURCE_0_TYPE: 'redis',
                        PERISCOPE_SOURCE_0_HOST: 'h',
                        PERISCOPE_SOURCE_1_NAME: 'b',
                    },
                    defaults
                ),
            /PERISCOPE_SOURCE_1_NAME/
        );
        expectConfigError(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '1',
                        PERISCOPE_SOURCE_0_NAME: 'a',
                        PERISCOPE_SOURCE_0_TYPE: 'redis',
                        PERISCOPE_SOURCE_0_HOST: 'h',
                        PERISCOPE_SOURCE_0_SAS: 'x',
                    },
                    defaults
                ),
            /PERISCOPE_SOURCE_0_SAS.*unknown key/
        );
        // per-source roles are gone: the app role opens every source
        for (const key of ['REQUIRED_ROLE', 'DOWNLOAD_ROLE']) {
            expectConfigError(
                () =>
                    parseSources(
                        {
                            PERISCOPE_SOURCE_N: '1',
                            PERISCOPE_SOURCE_0_NAME: 'a',
                            PERISCOPE_SOURCE_0_TYPE: 'redis',
                            PERISCOPE_SOURCE_0_HOST: 'h',
                            [`PERISCOPE_SOURCE_0_${key}`]: 'Periscope.Other',
                        },
                        defaults
                    ),
                new RegExp(`PERISCOPE_SOURCE_0_${key}.*unknown key`)
            );
        }
        expectConfigError(
            () =>
                parseSources(
                    {
                        PERISCOPE_SOURCE_N: '2',
                        PERISCOPE_SOURCE_0_NAME: 'a',
                        PERISCOPE_SOURCE_0_TYPE: 'redis',
                        PERISCOPE_SOURCE_0_HOST: 'h',
                        PERISCOPE_SOURCE_1_NAME: 'a',
                        PERISCOPE_SOURCE_1_TYPE: 'redis',
                        PERISCOPE_SOURCE_1_HOST: 'h',
                    },
                    defaults
                ),
            /duplicate/
        );
        expectConfigError(
            () =>
                parseSources(
                    { PERISCOPE_SOURCE_N: '1', PERISCOPE_SOURCE_0_NAME: 'Bad Name', PERISCOPE_SOURCE_0_TYPE: 'redis' },
                    defaults
                ),
            /PERISCOPE_SOURCE_0_NAME/
        );
        expectConfigError(
            () =>
                parseSources(
                    { PERISCOPE_SOURCE_N: '1', PERISCOPE_SOURCE_0_NAME: 'l', PERISCOPE_SOURCE_0_TYPE: 'loganalytics' },
                    defaults
                ),
            /WORKSPACE_ID or RESOURCE_ID/
        );
    });
});

describe('global configuration', () => {
    it('reads the Oracle driver and additional CA certificates', () => {
        const certificate = readFileSync(new URL('../fixtures/tls-test.crt', import.meta.url), 'utf8');
        const defaults = loadConfig({});
        assert.equal(defaults.oracleDriver, 'thin');
        assert.deepEqual(defaults.extraCaCerts, []);
        const config = loadConfig({
            PERISCOPE_ORACLE_DRIVER: 'thick',
            PERISCOPE_EXTRA_CA_CERTS: `${certificate}\n${certificate}`,
        });
        assert.equal(config.oracleDriver, 'thick');
        assert.equal(config.extraCaCerts.length, 2);
        expectConfigError(() => loadConfig({ PERISCOPE_ORACLE_DRIVER: 'instant' }), /PERISCOPE_ORACLE_DRIVER/);
        expectConfigError(
            () => loadConfig({ PERISCOPE_EXTRA_CA_CERTS: 'not a certificate' }),
            /PERISCOPE_EXTRA_CA_CERTS/
        );
        expectConfigError(
            () =>
                loadConfig({
                    PERISCOPE_EXTRA_CA_CERTS: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
                }),
            /PERISCOPE_EXTRA_CA_CERTS/
        );
    });

    it('defaults to stdio without auth and a filesystem store', () => {
        const config = loadConfig({});
        assert.equal(config.transport, 'stdio');
        assert.equal(config.auth.mode, 'none');
        assert.equal(config.results.store, 'filesystem');
        assert.equal(config.results.retentionMs, 24 * 3_600_000);
        assert.equal(config.auditLog, 'stderr');
    });

    it('requires Entra settings, a public URL and a signing key for http', () => {
        expectConfigError(() => loadConfig({ PERISCOPE_TRANSPORT: 'http' }), /PERISCOPE_AUTH_TENANT_ID/);
        expectConfigError(
            () =>
                loadConfig({
                    PERISCOPE_TRANSPORT: 'http',
                    PERISCOPE_AUTH_TENANT_ID: 't',
                    PERISCOPE_AUTH_CLIENT_ID: 'c',
                }),
            /PERISCOPE_PUBLIC_URL/
        );
        expectConfigError(
            () =>
                loadConfig({
                    PERISCOPE_TRANSPORT: 'http',
                    PERISCOPE_AUTH_TENANT_ID: 't',
                    PERISCOPE_AUTH_CLIENT_ID: 'c',
                    PERISCOPE_PUBLIC_URL: 'https://p.example.com',
                    PERISCOPE_RESULTS_ACCOUNT_URL: 'https://a.blob.core.windows.net',
                }),
            /PERISCOPE_DOWNLOAD_SIGNING_KEY/
        );
    });

    it('configures the entra broker with a federated token file or a secret', () => {
        const base = {
            PERISCOPE_TRANSPORT: 'http',
            PERISCOPE_AUTH: 'entra-broker',
            PERISCOPE_AUTH_TENANT_ID: '11111111-2222-3333-4444-555555555555',
            PERISCOPE_AUTH_CLIENT_ID: 'c',
            PERISCOPE_PUBLIC_URL: 'https://p.example.com',
            PERISCOPE_RESULTS_ACCOUNT_URL: 'https://a.blob.core.windows.net',
            PERISCOPE_DOWNLOAD_SIGNING_KEY: 'k'.repeat(32),
        };
        expectConfigError(() => loadConfig(base), /PERISCOPE_AUTH_CLIENT_ASSERTION_FILE/);
        const federated = loadConfig({ ...base, AZURE_FEDERATED_TOKEN_FILE: '/var/run/token' });
        assert.equal(federated.auth.clientAssertionFile, '/var/run/token');
        assert.deepEqual(federated.auth.redirectUris, [
            'https://claude.ai/api/mcp/auth_callback',
            'https://claude.com/api/mcp/auth_callback',
        ]);
        assert.equal(federated.auth.sessionTtlMs, 30 * 86_400_000);
        assert.equal(loadConfig({ ...base, PERISCOPE_AUTH_CLIENT_SECRET: 's' }).auth.clientSecret, 's');
        assert.equal(
            loadConfig({ ...base, PERISCOPE_AUTH_ASSERTION_IDENTITY: 'mi-client-id' }).auth.assertionIdentity,
            'mi-client-id'
        );
        expectConfigError(
            () => loadConfig({ ...base, PERISCOPE_AUTH_CLIENT_SECRET: 's', PERISCOPE_AUTH_TENANT_ID: 'contoso.com' }),
            /PERISCOPE_AUTH_TENANT_ID/
        );
        expectConfigError(
            () =>
                loadConfig({
                    ...base,
                    PERISCOPE_AUTH_CLIENT_SECRET: 's',
                    PERISCOPE_PUBLIC_URL: 'https://p.example.com/periscope',
                }),
            /PERISCOPE_PUBLIC_URL/
        );
        const { PERISCOPE_DOWNLOAD_SIGNING_KEY: _key, ...withoutKey } = base;
        expectConfigError(
            () => loadConfig({ ...withoutKey, PERISCOPE_AUTH_CLIENT_SECRET: 's' }),
            /PERISCOPE_DOWNLOAD_SIGNING_KEY/
        );
        expectConfigError(
            () =>
                loadConfig({
                    ...base,
                    PERISCOPE_AUTH_CLIENT_SECRET: 's',
                    PERISCOPE_AUTH_REDIRECT_URIS: 'http://x.example.com/cb',
                }),
            /PERISCOPE_AUTH_REDIRECT_URIS/
        );
    });

    it('only allows disabled auth on localhost', () => {
        expectConfigError(() => loadConfig({ PERISCOPE_TRANSPORT: 'http', PERISCOPE_AUTH: 'none' }), /localhost/);
        const config = loadConfig({
            PERISCOPE_TRANSPORT: 'http',
            PERISCOPE_AUTH: 'none',
            PERISCOPE_HOST: '127.0.0.1',
            PERISCOPE_RESULTS_STORE: 'filesystem',
        });
        assert.equal(config.auth.mode, 'none');
    });
});
