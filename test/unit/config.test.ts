import assert from 'node:assert/strict';
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
