import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildSourceConfig, type ResourceGraphSourceConfig } from '../../src/config/sources.ts';
import { PeriscopeError, WireGuardError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { ResourceGraphAdapter, throttleWaitMs } from '../../src/sources/resourcegraph/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

interface GraphRequest {
    url: string;
    query: string;
    subscriptions?: string[];
    options: { resultFormat: string; $top: number; $skipToken?: string };
}

const RESOURCES = 2500;

/**
 * Mock of the Resource Graph query API: `resources` has 2500 rows, served in pages of `$top` with a skip token.
 * `throttle` answers the first request with 429, `take 1500` is truncated without a skip token, `wherex` is a
 * parser failure.
 */
const startMock = (): Promise<{ server: Server; url: string; requests: GraphRequest[] }> =>
    new Promise((resolve) => {
        const requests: GraphRequest[] = [];
        let throttled = false;
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                const request = { url: req.url ?? '', ...(JSON.parse(body) as Omit<GraphRequest, 'url'>) };
                requests.push(request);
                assert.equal(req.headers.authorization, 'Bearer test-token');
                assert.equal(req.method, 'POST');
                res.setHeader('content-type', 'application/json');
                const reply = (status: number, value: unknown) => {
                    res.statusCode = status;
                    res.end(JSON.stringify(value));
                };
                if (request.query.includes('throttle') && !throttled) {
                    throttled = true;
                    res.setHeader('x-ms-user-quota-resets-after', '00:00:00');
                    reply(429, { error: { code: 'RateLimiting', message: 'Please provide below info' } });
                    return;
                }
                if (request.query.includes('wherex')) {
                    reply(400, {
                        error: {
                            code: 'BadRequest',
                            message: 'Please provide below info when asking for support',
                            details: [
                                { code: 'InvalidQuery', message: 'Query is invalid.' },
                                {
                                    code: 'ParserFailure',
                                    message: 'ParserFailure',
                                    line: 1,
                                    characterPositionInLine: 12,
                                    token: 'wherex',
                                },
                            ],
                        },
                    });
                    return;
                }
                if (request.query.includes('summarize rows = count() by type')) {
                    reply(200, {
                        data: [
                            { type: 'microsoft.security/assessments', rows: 12 },
                            { type: 'microsoft.security/locations/alerts', rows: 3 },
                        ],
                        resultTruncated: 'false',
                    });
                    return;
                }
                if (request.query.includes('take 1500')) {
                    reply(200, {
                        data: Array.from({ length: 1000 }, (_, i) => ({ id: `/r/${i}` })),
                        resultTruncated: 'true',
                    });
                    return;
                }
                const start = Number(request.options.$skipToken ?? 0);
                const end = Math.min(start + request.options.$top, RESOURCES);
                reply(200, {
                    data: Array.from({ length: end - start }, (_, i) => ({
                        id: `/r/${start + i}`,
                        properties: { n: start + i },
                    })),
                    resultTruncated: 'false',
                    ...(end < RESOURCES ? { $skipToken: String(end) } : {}),
                });
            });
        });
        server.listen(0, '127.0.0.1', () =>
            resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests })
        );
    });

const configFor = (endpoint: string, subscriptions: string[] = []): ResourceGraphSourceConfig => ({
    index: 0,
    type: 'resourcegraph',
    name: 'azure',
    description: undefined,
    maxQueryDurationMs: 60_000,
    maxResultBytes: 1024 ** 3,
    subscriptions,
    managementGroups: [],
    endpoint,
});

describe('resource graph source', () => {
    let mock: Awaited<ReturnType<typeof startMock>>;
    let adapter: ResourceGraphAdapter;
    let harness: ResultHarness;

    before(async () => {
        mock = await startMock();
        adapter = new ResourceGraphAdapter(configFor(mock.url, ['00000000-0000-0000-0000-000000000001']), {
            tokenProvider: async () => 'test-token',
        });
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness();
    });

    after(async () => {
        mock.server.close();
        await harness.dispose();
    });

    it('reads every page and sends only queries to the query endpoint, in the configured scope', async () => {
        const resultId = await harness.run(adapter, 'resources | project id, properties');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, RESOURCES);
        const window = await harness.service.readRows(resultId, 2499, 1, undefined);
        assert.deepEqual(window.rows[0], ['/r/2499', { n: 2499 }]);
        const pages = mock.requests.filter((r) => r.query === 'resources | project id, properties');
        assert.deepEqual(
            pages.map((r) => r.options.$skipToken),
            [undefined, '1000', '2000']
        );
        for (const request of pages) {
            assert.equal(request.url, '/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01');
            assert.deepEqual(request.subscriptions, ['00000000-0000-0000-0000-000000000001']);
            assert.equal(request.options.resultFormat, 'objectArray');
        }
    });

    it('waits and retries when throttled', async () => {
        const resultId = await harness.run(adapter, 'resources | where name == "throttle"');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(mock.requests.filter((r) => r.query.includes('throttle')).length, 4);
    });

    it('fails a result that Resource Graph cut off', async () => {
        const resultId = await harness.run(adapter, 'resources | take 1500');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'too_large');
    });

    it('reports where a query is invalid', async () => {
        const resultId = await harness.run(adapter, 'resources | wherex x');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'failed');
        assert.match(manifest.error?.message ?? '', /Query is invalid\.; ParserFailure at 1:12 near 'wherex'/);
    });

    it('rejects options', async () => {
        await assert.rejects(adapter.validate('resources', null, { timespan: 'P1D' }), PeriscopeError);
    });

    it('lists tables, and the types in a table', async () => {
        const tables = (await adapter.describe(undefined, 'security*')) as { tables: { table: string }[] };
        assert.deepEqual(
            tables.tables.map((t) => t.table),
            ['securityresources']
        );
        const types = (await adapter.describe('securityresources', '*alerts')) as { types: unknown[] };
        assert.deepEqual(types.types, [{ type: 'microsoft.security/locations/alerts', rows: 3 }]);
        await assert.rejects(adapter.describe('resources | take 1', undefined), PeriscopeError);
    });

    it('blocks an endpoint with a path before anything is sent', async () => {
        const count = mock.requests.length;
        const guarded = new ResourceGraphAdapter(configFor(`${mock.url}/other`), {
            tokenProvider: async () => 'test-token',
        });
        await guarded.init(nullLoggers().log);
        await assert.rejects(guarded.describe('resources', undefined), WireGuardError);
        assert.equal(mock.requests.length, count);
    });

    it('reads the wait of a throttled request from the quota reset or Retry-After', () => {
        assert.equal(throttleWaitMs(new Headers({ 'x-ms-user-quota-resets-after': '00:00:03' })), 3000);
        assert.equal(throttleWaitMs(new Headers({ 'retry-after': '2' })), 2000);
        assert.equal(throttleWaitMs(new Headers()), 5000);
    });

    it('takes at most one scope and only the origin of the endpoint', () => {
        const defaults = { maxQueryDurationMs: 60_000, maxResultBytes: 1024 };
        const config = buildSourceConfig(
            0,
            { NAME: 'azure', TYPE: 'resourcegraph', ENDPOINT: 'https://management.example.com/x/' },
            defaults
        );
        assert.equal(config.type === 'resourcegraph' && config.endpoint, 'https://management.example.com');
        assert.throws(
            () =>
                buildSourceConfig(
                    0,
                    { NAME: 'azure', TYPE: 'resourcegraph', SUBSCRIPTIONS: ['a'], MANAGEMENT_GROUPS: ['b'] },
                    defaults
                ),
            /at most one of SUBSCRIPTIONS or MANAGEMENT_GROUPS/
        );
    });
});
