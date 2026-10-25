import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { SourceConfig } from '../../src/config/sources.ts';
import { scalarColumn } from '../../src/results/parquet/columns.ts';
import type {
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../../src/sources/adapter.ts';
import { createResultHarness, type ResultHarness, testCaller } from '../helpers/results.ts';

/** A scriptable source for exercising the job runner without a database. */
class FakeAdapter implements SourceAdapter {
    readonly config: SourceConfig;
    readonly #stream: (context: ExecutionContext) => ResultStream;

    constructor(stream: (context: ExecutionContext) => ResultStream, overrides: Partial<SourceConfig> = {}) {
        this.#stream = stream;
        this.config = {
            index: 0,
            type: 'redis',
            name: 'fake',
            description: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            ...overrides,
        } as SourceConfig;
    }
    async init(): Promise<void> {
        // nothing to connect
    }
    info(): SourceInfo {
        return {} as SourceInfo;
    }
    async describe(): Promise<unknown> {
        return {};
    }
    async validate(query: string): Promise<PreparedQuery> {
        return { query, params: null, options: {} };
    }
    async execute(_prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        return this.#stream(context);
    }
    async close(): Promise<void> {
        // nothing to close
    }
}

const documents = (count: number, delayMs = 0) =>
    async function* (): AsyncGenerator<unknown[]> {
        for (let i = 0; i < count; i += 1000) {
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            yield Array.from({ length: Math.min(1000, count - i) }, (_, k) => ({ i: i + k, text: 'x'.repeat(50) }));
        }
    };

describe('result jobs', () => {
    let harness: ResultHarness;
    before(async () => {
        harness = await createResultHarness({ partBytes: 20_000 });
    });
    after(() => harness.dispose());

    const finish = async (resultId: string) => {
        let snapshot = await harness.service.snapshot(resultId, 10_000);
        while (snapshot.manifest.status === 'running' || snapshot.manifest.status === 'queued') {
            snapshot = await harness.service.snapshot(resultId, 10_000);
        }
        return snapshot;
    };

    it('closes the first part early and later parts by size', async () => {
        const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(40_000)() }));
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'succeeded');
        assert.equal(manifest.rowCount, 40_000);
        assert.equal(manifest.files[0]?.rowCount, 5000, 'first part closes after FIRST_PART_ROWS');
        assert.ok(manifest.files.length > 2);
        assert.deepEqual(
            manifest.schema.columns.map((c) => [c.name, c.type, c.presence]),
            [
                ['i', 'integer', 1],
                ['text', 'string', 1],
            ]
        );
    });

    it('makes rows readable while the query is still running', async () => {
        const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(12_000, 300)() }));
        const prepared = await adapter.validate('q');
        const resultId = await harness.service.start(adapter, prepared, testCaller);
        let window = await harness.service.readRows(resultId, 0, 5, ['i']);
        for (let i = 0; i < 50 && window.rows.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            window = await harness.service.readRows(resultId, 0, 5, ['i']);
        }
        assert.deepEqual(window.rows, [[0], [1], [2], [3], [4]]);
        const running = await harness.service.snapshot(resultId);
        assert.equal(running.manifest.status, 'running');
        await harness.service.cancel(resultId);
        const { manifest } = await finish(resultId);
        assert.equal(manifest.status, 'cancelled');
        assert.equal(manifest.error?.partial, true);
    });

    it('fails with too_large when the result exceeds the size limit', async () => {
        const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(100_000)() }), {
            maxResultBytes: 30_000,
        });
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'too_large');
    });

    it('fails with timeout after the maximum query duration', async () => {
        const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(100_000, 200)() }), {
            maxQueryDurationMs: 500,
        });
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'timeout');
    });

    it('reports source errors and keeps partial data', async () => {
        const adapter = new FakeAdapter(() => ({
            format: 'parquet',
            columns: [scalarColumn('n', 'int32', { sourceType: 'int' })],
            batches: (async function* () {
                yield Array.from({ length: 6000 }, (_, i) => [i]);
                throw new Error('connection lost');
            })(),
        }));
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'failed');
        assert.match(manifest.error?.message ?? '', /connection lost/);
        assert.equal(manifest.error?.partial, true);
        assert.equal(manifest.files[0]?.rowCount, 6000);
    });

    it('limits concurrent queries per user', async () => {
        // a caller of its own, so jobs of earlier tests that are still winding down do not count
        const caller = { ...testCaller, oid: 'concurrency-test-user' };
        const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(1_000_000, 1000)() }));
        const prepared = await adapter.validate('q');
        const started: string[] = [];
        for (let i = 0; i < 8; i++) started.push(await harness.service.start(adapter, prepared, caller));
        await assert.rejects(harness.service.start(adapter, prepared, caller), /Too many concurrent queries/);
        for (const id of started) await harness.service.cancel(id);
        for (const id of started) await finish(id);
    });

    it('rejects unknown result ids', async () => {
        await assert.rejects(harness.service.snapshot('r_doesnotexist'), /Unknown result/);
        await assert.rejects(harness.service.snapshot('../../etc/passwd'), /Unknown result/);
    });
});
