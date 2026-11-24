import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import type { CosmosSourceConfig } from '../../src/config/sources.ts';
import type { Loggers } from '../../src/core/logger.ts';
import type { SourceAdapter } from '../../src/sources/adapter.ts';
import { CosmosAdapter, type PageIterator, queryPages } from '../../src/sources/cosmos/adapter.ts';
import {
    evenRanges,
    GONE,
    type MockCosmos,
    type MockCosmosOptions,
    PLAIN_QUERY_INFO,
    startMockCosmos,
    throttled,
} from '../helpers/cosmos-mock.ts';
import { createResultHarness, type ResultHarness, testCaller } from '../helpers/results.ts';

/**
 * Cosmos queries that do not come back, against a stand-in for the gateway that answers
 * the way the service did in production: with empty pages, 429, 410 after a split, or
 * not at all.
 */

interface AuditLine {
    event: string;
    resultId: string;
    status?: string;
    error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the gateway has seen what the test is about; a query that never gets there fails the test. */
const until = async (reached: () => boolean): Promise<void> => {
    for (let waited = 0; !reached(); waited += 10) {
        assert.ok(waited < 5_000, 'the query did not reach the gateway');
        await sleep(10);
    }
};

describe('cosmos queries that do not come back', () => {
    let harness: ResultHarness;
    const audit: AuditLine[] = [];
    const gateways: MockCosmos[] = [];
    const adapters: CosmosAdapter[] = [];

    before(async () => {
        const loggers: Loggers = {
            log: pino({ level: 'silent' }),
            audit: pino(
                { level: 'info', messageKey: 'event', base: null },
                { write: (line: string) => void audit.push(JSON.parse(line) as AuditLine) }
            ),
        };
        harness = await createResultHarness({ loggers });
    });

    after(async () => {
        await harness.dispose();
        for (const adapter of adapters) await adapter.close();
        for (const gateway of gateways) await gateway.close();
    });

    const cosmos = async (
        options: MockCosmosOptions,
        overrides: Partial<CosmosSourceConfig> = {}
    ): Promise<{ adapter: CosmosAdapter; gateway: MockCosmos }> => {
        const gateway = await startMockCosmos(options);
        gateways.push(gateway);
        const adapter = new CosmosAdapter({
            index: 0,
            type: 'cosmos',
            name: `cosmos-${gateways.length}`,
            description: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            endpoint: gateway.endpoint,
            key: Buffer.from('not a real key').toString('base64'),
            azureAuth: false,
            database: 'main',
            maxRuPerSec: undefined,
            lowPriority: false,
            ...overrides,
        });
        await adapter.init(pino({ level: 'silent' }));
        adapters.push(adapter);
        return { adapter, gateway };
    };

    const start = async (adapter: SourceAdapter, query: string, params: unknown, container: string) =>
        harness.service.start(adapter, await adapter.validate(query, params, { container }), testCaller);

    /** Waits for the query to end and returns its manifest with the time that took. */
    const ended = async (resultId: string, withinMs: number) => {
        const started = Date.now();
        for (;;) {
            const { manifest } = await harness.service.snapshot(resultId, 500);
            if (manifest.status !== 'running' && manifest.status !== 'queued') {
                return { manifest, elapsedMs: Date.now() - started };
            }
            assert.ok(Date.now() - started < withinMs, `query still ${manifest.status} after ${withinMs} ms`);
        }
    };

    /** The audit line is written when the outcome is stored, a moment after the status is visible. */
    const auditEnd = async (resultId: string): Promise<AuditLine | undefined> => {
        for (let i = 0; i < 50; i++) {
            const line = audit.find((entry) => entry.event === 'query.end' && entry.resultId === resultId);
            if (line) return line;
            await sleep(20);
        }
        return undefined;
    };

    const rows = async (resultId: string): Promise<unknown[][]> =>
        (await harness.service.readRows(resultId, 0, 100, undefined)).rows;

    const GROUP_QUERY =
        'SELECT c.status, COUNT(1) AS calls FROM c WHERE ARRAY_CONTAINS(@values, c.status) GROUP BY c.status';
    const GROUP_QUERY_INFO = {
        ...PLAIN_QUERY_INFO,
        groupByExpressions: ['c.status'],
        groupByAliases: ['status'],
        groupByAliasToAggregateType: { status: null, calls: 'Count' },
        rewrittenQuery:
            'SELECT [{"item": c.status}] AS groupByItems, {"status": c.status, "calls": {"item": COUNT(1)}} AS payload ' +
            'FROM c WHERE ARRAY_CONTAINS(@values, c.status) GROUP BY c.status',
    };
    const group = (status: string, calls: number) => ({
        groupByItems: [{ item: status }],
        payload: { status, calls: { item: calls } },
    });
    const TOP_QUERY = 'SELECT TOP 12 * FROM c WHERE ARRAY_CONTAINS(@batches, c.batch)';
    const TOP_QUERY_INFO = { ...PLAIN_QUERY_INFO, top: 12 };
    const pageRequests = (gateway: MockCosmos): number =>
        Object.values(gateway.counts.pages).reduce((sum, count) => sum + count, 0);

    it('aggregates across partitions of which a whole batch has no match', async () => {
        // twelve partitions read four at a time: the second batch comes back empty, the third holds a group again
        const { adapter, gateway } = await cosmos({
            ranges: () => evenRanges(12),
            queryInfo: GROUP_QUERY_INFO,
            page: ({ rangeId }) => ({
                documents: rangeId === '1' ? [group('a', 3)] : rangeId === '10' ? [group('a', 4)] : [],
            }),
        });
        const resultId = await start(adapter, GROUP_QUERY, { '@values': ['a'] }, 'orders');
        const { manifest } = await ended(resultId, 5_000);
        assert.equal(manifest.status, 'succeeded');
        assert.deepEqual(await rows(resultId), [['a', 7]]);
        assert.equal(Object.keys(gateway.counts.pages).length, 12, 'every partition was read');
    });

    it('aggregates across pages of which one is empty', async () => {
        // a busy partition answers with an empty page and a continuation before it finds the next group
        const { adapter, gateway } = await cosmos({
            ranges: () => evenRanges(1),
            queryInfo: GROUP_QUERY_INFO,
            page: ({ call }) =>
                call === 1
                    ? { documents: [group('a', 3)], continuation: 'page-2' }
                    : call === 2
                      ? { documents: [], continuation: 'page-3' }
                      : { documents: [group('a', 4)] },
        });
        const resultId = await start(adapter, GROUP_QUERY, { '@values': ['a'] }, 'orders');
        const { manifest } = await ended(resultId, 5_000);
        assert.equal(manifest.status, 'succeeded');
        assert.deepEqual(await rows(resultId), [['a', 7]]);
        assert.equal(gateway.counts.pages['0'], 3);
    });

    it('fails instead of asking a partition range that is gone again and again', async () => {
        const { adapter, gateway } = await cosmos({
            ranges: () => evenRanges(2),
            queryInfo: TOP_QUERY_INFO,
            page: () => GONE,
        });
        const resultId = await start(adapter, TOP_QUERY, { '@batches': ['b'] }, 'events');
        const { manifest } = await ended(resultId, 5_000);
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'source_error');
        assert.ok(pageRequests(gateway) <= 4, `${pageRequests(gateway)} requests to ranges that are gone`);
    });

    it('cancels a query whose client waits for an answer it never gets', async () => {
        // the client reads the partition key ranges without the query's abort signal
        const { adapter, gateway } = await cosmos({
            ranges: () => evenRanges(2),
            queryInfo: TOP_QUERY_INFO,
            page: () => ({ documents: [] }),
            metadata: (kind) => (kind === 'ranges' ? { hang: true } : undefined),
        });
        const resultId = await start(adapter, TOP_QUERY, { '@batches': ['b'] }, 'events');
        await until(() => gateway.counts.ranges > 0);

        const cancelled = await harness.service.cancel(resultId);
        assert.equal(cancelled.manifest.status, 'cancelled');
        assert.equal(cancelled.manifest.error?.code, 'cancelled');
        assert.equal(cancelled.state?.cancelRequested, true);
        assert.equal((await auditEnd(resultId))?.status, 'cancelled');
    });

    it('holds the maximum duration against a client that never answers', async () => {
        const { adapter } = await cosmos(
            {
                ranges: () => evenRanges(2),
                queryInfo: TOP_QUERY_INFO,
                page: () => ({ documents: [] }),
                metadata: (kind) => (kind === 'ranges' ? { hang: true } : undefined),
            },
            { maxQueryDurationMs: 1_000 }
        );
        const resultId = await start(adapter, TOP_QUERY, { '@batches': ['b'] }, 'events');
        const { manifest, elapsedMs } = await ended(resultId, 5_000);
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'timeout');
        assert.ok(elapsedMs >= 700, `ended after ${elapsedMs} ms, before its time`);
        const line = await auditEnd(resultId);
        assert.deepEqual([line?.status, line?.error], ['failed', 'timeout']);
    });

    it('cancels a query while its client waits out a throttled request', async () => {
        // the client sleeps for as long as a 429 asks it to and does not look at the abort signal meanwhile
        const { adapter, gateway } = await cosmos({
            ranges: () => evenRanges(2),
            queryInfo: TOP_QUERY_INFO,
            page: () => throttled(3_000),
        });
        const resultId = await start(adapter, TOP_QUERY, { '@batches': ['b'] }, 'events');
        await until(() => Object.keys(gateway.counts.pages).length >= 2);

        // the job does not wait for the client's sleep to end
        const cancelled = await harness.service.cancel(resultId);
        assert.equal(cancelled.manifest.status, 'cancelled');
        const sent = pageRequests(gateway);
        await sleep(3_500);
        assert.equal(pageRequests(gateway), sent, 'no page request follows the wait');
    });

    it('sends nothing more once a query is cancelled, whatever the client still retries', async () => {
        // the client retries the throttled read of the partition key ranges nine times, without the abort signal
        const { adapter, gateway } = await cosmos({
            ranges: () => evenRanges(2),
            queryInfo: TOP_QUERY_INFO,
            page: () => ({ documents: [] }),
            metadata: (kind) => (kind === 'ranges' ? throttled(150) : undefined),
        });
        const resultId = await start(adapter, TOP_QUERY, { '@batches': ['b'] }, 'events');
        await until(() => gateway.counts.ranges >= 2);

        assert.equal((await harness.service.cancel(resultId)).manifest.status, 'cancelled');
        const sent = gateway.counts.ranges;
        await sleep(1_000);
        assert.equal(gateway.counts.ranges, sent);
    });

    it('lets timers and requests run while a client answers without asking the account', async () => {
        // what the client did after it had ended a GROUP BY early: "more results", and each page empty at once
        const idle: PageIterator = { hasMoreResults: () => true, fetchNext: async () => ({ resources: [] }) };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 50);
        const pages: unknown[][] = [];
        for await (const page of queryPages(idle, { signal: controller.signal, addCost: () => undefined }, undefined)) {
            pages.push(page);
        }
        clearTimeout(timer);
        assert.equal(controller.signal.aborted, true, 'the timer ran, so the loop gave way to it');
        assert.deepEqual(pages, []);
    });
});
