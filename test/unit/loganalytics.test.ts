import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { LogAnalyticsSourceConfig } from '../../src/config/sources.ts';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { isSplittable, LogAnalyticsAdapter, resolveTimespan } from '../../src/sources/loganalytics/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

/** Mock of the Log Analytics query API: one row per minute; windows over 6h are "too large". */
const startMock = (): Promise<{ server: Server; url: string; requests: { query: string; timespan: string }[] }> =>
    new Promise((resolve) => {
        const requests: { query: string; timespan: string }[] = [];
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                const { query, timespan } = JSON.parse(body) as { query: string; timespan: string };
                requests.push({ query, timespan });
                assert.equal(req.headers.authorization, 'Bearer test-token');
                assert.equal(req.method, 'POST');
                assert.match(req.url ?? '', /^\/v1\/workspaces\/ws1\/query$/);
                const [a, b] = timespan.split('/') as [string, string];
                const start = Date.parse(a);
                const end = Date.parse(b);
                res.setHeader('content-type', 'application/json');
                if (query.includes('getschema')) {
                    res.end(
                        JSON.stringify({
                            tables: [
                                {
                                    name: 'PrimaryResult',
                                    columns: [
                                        { name: 'ColumnName', type: 'string' },
                                        { name: 'ColumnType', type: 'string' },
                                    ],
                                    rows: [
                                        ['TimeGenerated', 'datetime'],
                                        ['Message', 'string'],
                                    ],
                                },
                            ],
                        })
                    );
                    return;
                }
                if (end - start > 6 * 3_600_000) {
                    res.end(
                        JSON.stringify({
                            error: {
                                code: 'PartialError',
                                message: 'Query result set has exceeded the internal record count limit',
                            },
                        })
                    );
                    return;
                }
                const rows: unknown[][] = [];
                for (let t = Math.ceil(start / 60_000) * 60_000; t < end; t += 60_000) {
                    rows.push([new Date(t).toISOString().replace('Z', '1234Z'), `m${t}`, 7, '{"a":1}', true, '12.5']);
                }
                res.end(
                    JSON.stringify({
                        tables: [
                            {
                                name: 'PrimaryResult',
                                columns: [
                                    { name: 'TimeGenerated', type: 'datetime' },
                                    { name: 'Message', type: 'string' },
                                    { name: 'Count', type: 'long' },
                                    { name: 'Props', type: 'dynamic' },
                                    { name: 'Ok', type: 'bool' },
                                    { name: 'Amount', type: 'decimal' },
                                ],
                                rows,
                            },
                        ],
                    })
                );
            });
        });
        server.listen(0, '127.0.0.1', () =>
            resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests })
        );
    });

describe('log analytics source', () => {
    let mock: Awaited<ReturnType<typeof startMock>>;
    let adapter: LogAnalyticsAdapter;
    let harness: ResultHarness;

    before(async () => {
        mock = await startMock();
        const config: LogAnalyticsSourceConfig = {
            index: 0,
            type: 'loganalytics',
            name: 'logs',
            description: undefined,
            requiredRole: undefined,
            downloadRole: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            workspaceId: 'ws1',
            resourceId: undefined,
            defaultTimespan: 'PT1H',
            endpoint: mock.url,
        };
        adapter = new LogAnalyticsAdapter(config, { tokenProvider: async () => 'test-token' });
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness();
    });

    after(async () => {
        mock.server.close();
        await harness.dispose();
    });

    it('detects queries that can be split into time windows', () => {
        assert.equal(isSplittable('AppRequests | where Success == false | project TimeGenerated, Name'), true);
        assert.equal(isSplittable('AppRequests | summarize count() by Name'), false);
        assert.equal(isSplittable('AppRequests | take 10'), false);
        assert.equal(isSplittable('AppTraces | where Message has "summarize"'), true);
    });

    it('resolves durations and intervals', () => {
        const now = Date.parse('2026-01-02T00:00:00Z');
        assert.deepEqual(resolveTimespan('P1D', now), { start: Date.parse('2026-01-01T00:00:00Z'), end: now });
        assert.deepEqual(resolveTimespan('2026-01-01T00:00:00Z/PT2H'), {
            start: Date.parse('2026-01-01T00:00:00Z'),
            end: Date.parse('2026-01-01T02:00:00Z'),
        });
    });

    it('rejects control commands', async () => {
        await assert.rejects(adapter.validate('.drop table AppTraces', null, {}), QueryRejectedError);
    });

    it('maps KQL types and splits large row-level queries into time windows', async () => {
        const resultId = await harness.run(adapter, 'AppTraces | project TimeGenerated, Message', null, {
            timespan: '2026-01-01T00:00:00Z/2026-01-02T00:00:00Z',
        });
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, 24 * 60);
        assert.equal(mock.requests.filter((r) => r.query.startsWith('AppTraces')).length, 1 + 2 + 4);
        const types = Object.fromEntries(manifest.schema.columns.map((c) => [c.name, c.parquetType]));
        assert.deepEqual(types, {
            TimeGenerated: 'TIMESTAMP(MICROS, UTC)',
            Message: 'STRING',
            Count: 'INT64',
            Props: 'STRING (JSON)',
            Ok: 'BOOLEAN',
            Amount: 'STRING',
        });
        const window = await harness.service.readRows(resultId, 0, 1, undefined);
        assert.deepEqual(window.rows[0], [
            '2026-01-01T00:00:00.000123Z',
            `m${Date.parse('2026-01-01T00:00:00Z')}`,
            7,
            { a: 1 },
            true,
            '12.5',
        ]);
    });

    it('refuses to split aggregating queries', async () => {
        const resultId = await harness.run(adapter, 'AppTraces | summarize count() by Message', null, {
            timespan: 'P2D',
        });
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'too_large');
    });

    it('describes table schemas', async () => {
        const table = (await adapter.describe('AppTraces', undefined)) as { columns: { name: string }[] };
        assert.deepEqual(
            table.columns.map((c) => c.name),
            ['TimeGenerated', 'Message']
        );
    });
});
