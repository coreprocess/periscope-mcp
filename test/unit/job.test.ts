import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { pino } from 'pino';
import type { SourceConfig } from '../../src/config/sources.ts';
import { newResultId } from '../../src/core/ids.ts';
import { createLoggers, nullLoggers } from '../../src/core/logger.ts';
import { scalarColumn } from '../../src/results/parquet/columns.ts';
import { ResultService } from '../../src/results/service.ts';
import { FilesystemResultStore } from '../../src/results/store/filesystem.ts';
import { putJson } from '../../src/results/store/store.ts';
import { type JobState, MANIFEST_PATH, type Manifest, STATE_PATH } from '../../src/results/types.ts';
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

/** A store whose manifest writes lag, as uploads to a remote store do. */
class SlowManifestStore extends FilesystemResultStore {
    override async put(path: string, body: Buffer | string): Promise<void> {
        if (path.endsWith(MANIFEST_PATH)) await new Promise((resolve) => setTimeout(resolve, 200));
        await super.put(path, body);
    }
}

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

    it('tells a window of a running query apart from an empty result', async () => {
        const gate = Promise.withResolvers<void>();
        const adapter = new FakeAdapter(() => ({
            format: 'ndjson',
            batches: (async function* () {
                await gate.promise;
                yield* documents(3)();
            })(),
        }));
        const prepared = await adapter.validate('q');
        const resultId = await harness.service.start(adapter, prepared, testCaller);

        const pending = await harness.service.readRows(resultId, 0, 10, undefined);
        assert.ok(pending.status === 'queued' || pending.status === 'running', pending.status);
        assert.deepEqual(pending.columns, []);
        assert.deepEqual(pending.rows, []);
        assert.equal(pending.nextOffset, 0);
        assert.equal(pending.rowCount, null);

        gate.resolve();
        await finish(resultId);
        const done = await harness.service.readRows(resultId, 0, 10, undefined);
        assert.equal(done.status, 'succeeded');
        assert.deepEqual(done.columns, ['i', 'text']);
        assert.deepEqual(
            done.rows.map((row) => row[0]),
            [0, 1, 2]
        );
        assert.equal(done.nextOffset, null);
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

    it('does not report a stream that ends quietly on abort as succeeded', async () => {
        const quiet = (context: ExecutionContext): ResultStream => ({
            format: 'ndjson',
            batches: (async function* () {
                for (let i = 0; ; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    if (context.signal.aborted) return;
                    yield [{ i }];
                }
            })(),
        });
        const timedOut = await finish(await harness.run(new FakeAdapter(quiet, { maxQueryDurationMs: 300 }), 'q'));
        assert.equal(timedOut.manifest.status, 'failed');
        assert.equal(timedOut.manifest.error?.code, 'timeout');

        const adapter = new FakeAdapter(quiet);
        const resultId = await harness.service.start(adapter, await adapter.validate('q'), testCaller);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await harness.service.cancel(resultId);
        const { manifest } = await finish(resultId);
        assert.equal(manifest.status, 'cancelled');
    });

    const storedManifest = async (dir: string, resultId: string) =>
        JSON.parse(await readFile(join(dir, resultId, MANIFEST_PATH), 'utf8')) as Manifest;

    it('reports a status only once its manifest is stored', async () => {
        const slow = await createResultHarness({ store: (dir) => new SlowManifestStore(dir) });
        try {
            const resultId = await slow.run(
                new FakeAdapter(() => ({ format: 'ndjson', batches: documents(3)() })),
                'q'
            );
            const stored = await storedManifest(slow.dir, resultId);
            assert.equal(stored.status, 'succeeded');
            assert.equal(stored.rowCount, 3);
        } finally {
            await slow.dispose();
        }
    });

    it('fails running queries on shutdown and stores that before it returns', async () => {
        const slow = await createResultHarness({ store: (dir) => new SlowManifestStore(dir) });
        try {
            const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(1_000_000, 100)() }));
            const resultId = await slow.service.start(adapter, await adapter.validate('q'), testCaller);
            await new Promise((resolve) => setTimeout(resolve, 300));
            await slow.service.shutdown();
            const stored = await storedManifest(slow.dir, resultId);
            assert.equal(stored.status, 'failed');
            assert.equal(stored.error?.code, 'internal');
            assert.match(stored.error?.message ?? '', /restarted .* run the query again/);
        } finally {
            await slow.dispose();
        }
    });

    /** A source whose client neither answers nor reacts to the abort signal. */
    const deaf = (): FakeAdapter =>
        new FakeAdapter(
            () => ({
                format: 'ndjson',
                batches: (async function* (): AsyncGenerator<unknown[]> {
                    yield [{ i: 0 }];
                    await new Promise(() => undefined);
                })(),
            }),
            { maxQueryDurationMs: 60_000 }
        );

    it('ends a cancelled query at once, whether or not its source reacts', async () => {
        const adapter = deaf();
        const resultId = await harness.service.start(adapter, await adapter.validate('q'), testCaller);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = Date.now();
        const cancelled = await harness.service.cancel(resultId);
        assert.equal(cancelled.manifest.status, 'cancelled');
        assert.ok(Date.now() - started < 1_000);
        assert.equal((await storedManifest(harness.dir, resultId)).status, 'cancelled');
    });

    it('holds the maximum duration against a source that does not react', async () => {
        const adapter = new FakeAdapter(
            () => ({
                format: 'ndjson',
                batches: (async function* (): AsyncGenerator<unknown[]> {
                    await new Promise(() => undefined);
                })(),
            }),
            { maxQueryDurationMs: 300 }
        );
        const started = Date.now();
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.error?.code, 'timeout');
        assert.ok(Date.now() - started < 2_000);
    });

    it('releases what a source holds when the query is aborted between two batches', async () => {
        let released = false;
        const adapter = new FakeAdapter(() => ({
            format: 'ndjson',
            batches: (async function* (): AsyncGenerator<unknown[]> {
                try {
                    for (let i = 0; ; i++) {
                        yield [{ i }];
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                } finally {
                    released = true;
                }
            })(),
        }));
        const resultId = await harness.service.start(adapter, await adapter.validate('q'), testCaller);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal((await harness.service.cancel(resultId)).manifest.status, 'cancelled');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(released, true);
    });

    it('does not ask an aborted source for another batch', async () => {
        // the abort arrives while the job stores the first part: the source has nothing running that it could stop
        const slow = await createResultHarness({ store: (dir) => new SlowManifestStore(dir) });
        try {
            let resumed = false;
            let finished = false;
            const adapter = new FakeAdapter(() => ({
                format: 'ndjson',
                batches: (async function* (): AsyncGenerator<unknown[]> {
                    try {
                        yield Array.from({ length: 5000 }, (_, i) => ({ i }));
                        resumed = true;
                        await new Promise(() => undefined);
                    } finally {
                        finished = true;
                    }
                })(),
            }));
            const resultId = await slow.service.start(adapter, await adapter.validate('q'), testCaller);
            // the first part is written by now and its manifest is on its slow way into the store
            await new Promise((resolve) => setTimeout(resolve, 300));
            assert.equal(resumed, false, 'the abort comes while the job is still storing the part');
            assert.equal((await slow.service.cancel(resultId)).manifest.status, 'cancelled');
            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.equal(resumed, false);
            assert.equal(finished, true, 'the source was told to release what it holds');
        } finally {
            await slow.dispose();
        }
    });

    it('holds the limit per user for queries that start at the same moment', async () => {
        const caller = { ...testCaller, oid: 'parallel-test-user' };
        const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(1_000_000, 1000)() }));
        const prepared = await adapter.validate('q');
        const started = await Promise.allSettled(
            Array.from({ length: 12 }, () => harness.service.start(adapter, prepared, caller))
        );
        const accepted = started.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
        assert.equal(accepted.length, 8);
        for (const resultId of accepted) await harness.service.cancel(resultId);
    });

    it('fails and audits a query on shutdown, whether or not its source reacts', async () => {
        const lines: Record<string, unknown>[] = [];
        const audit = pino(
            { level: 'info', messageKey: 'event', base: null, timestamp: false },
            { write: (line: string) => void lines.push(JSON.parse(line)) }
        );
        const stopping = await createResultHarness({ loggers: { log: pino({ level: 'silent' }), audit } });
        try {
            const adapter = deaf();
            const resultId = await stopping.service.start(adapter, await adapter.validate('q'), testCaller);
            await new Promise((resolve) => setTimeout(resolve, 100));
            const started = Date.now();
            await stopping.service.shutdown();
            assert.ok(Date.now() - started < 2_000, 'the shutdown does not wait for the source');
            const stored = await storedManifest(stopping.dir, resultId);
            assert.equal(stored.status, 'failed');
            assert.match(stored.error?.message ?? '', /restarted .* run the query again/);
            const end = lines.find((line) => line.event === 'query.end');
            assert.deepEqual([end?.resultId, end?.status, end?.error], [resultId, 'failed', 'internal']);
        } finally {
            await stopping.dispose();
        }
    });

    it('lets go of every batch once it is written', async () => {
        // an export must not grow with its result: no batch may stay reachable while later ones are read
        setFlagsFromString('--expose-gc');
        const collect = runInNewContext('gc') as () => void;
        const batches: WeakRef<unknown[]>[] = [];
        let released = 0;
        const adapter = new FakeAdapter(() => ({
            format: 'ndjson',
            batches: (async function* () {
                for (let i = 0; i < 40; i++) {
                    const batch = [{ i, text: 'x'.repeat(1000) }];
                    batches.push(new WeakRef(batch));
                    yield batch;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                collect();
                released = batches.slice(0, 30).filter((batch) => batch.deref() === undefined).length;
            })(),
        }));
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'succeeded');
        assert.equal(released, 30);
    });

    it('reports source errors and keeps partial data', async () => {
        const adapter = new FakeAdapter(() => ({
            format: 'parquet',
            columns: [scalarColumn('n', 'int32', { sourceType: 'int' })],
            batches: (async function* () {
                yield Array.from({ length: 6000 }, (_, i) => [i]);
                throw new Error('connection lost\nRequest URI: /dbs/main/colls/claims, headers: x-ms-activity-id');
            })(),
        }));
        const { manifest } = await finish(await harness.run(adapter, 'q'));
        assert.equal(manifest.status, 'failed');
        // the client sees the first line; the request details stay in the server log
        assert.equal(manifest.error?.message, 'connection lost');
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

    it('writes each audit event once', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'periscope-audit-'));
        const auditLog = join(dir, 'audit.log');
        const loggers = createLoggers({ level: 'silent', auditLog, transport: 'http' });
        const audited = await createResultHarness({ loggers });
        try {
            await audited.run(new FakeAdapter(() => ({ format: 'ndjson', batches: documents(10)() })), 'q');
            let lines: string[] = [];
            for (let i = 0; i < 50 && lines.length < 2; i++) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                loggers.audit.flush();
                lines = (await readFile(auditLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
            }
            assert.deepEqual(
                lines.map((line) => (JSON.parse(line) as { event: string }).event),
                ['query.start', 'query.end']
            );
            for (const line of lines) assert.equal(line.split('"event":').length, 2, line);
        } finally {
            await audited.dispose();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('closes and audits a query whose replica died, once its heartbeat is stale', async () => {
        const lines: Record<string, unknown>[] = [];
        const audit = pino(
            { level: 'info', messageKey: 'event', base: null, timestamp: false },
            { write: (line: string) => void lines.push(JSON.parse(line)) }
        );
        const survivor = await createResultHarness({ loggers: { log: pino({ level: 'silent' }), audit } });
        try {
            // a result as a killed replica leaves it: running, with one part, and nobody to finish it
            const resultId = newResultId();
            const createdAt = new Date(Date.now() - 1_200_000).toISOString();
            const manifest: Manifest = {
                version: 1,
                resultId,
                source: 'fake',
                status: 'running',
                format: 'ndjson',
                compression: 'gzip',
                rowCount: null,
                bytes: 100,
                schema: { columns: [] },
                files: [{ path: 'part-0000.ndjson.gz', rowStart: 0, rowCount: 7, bytes: 100, sha256: '', index: '' }],
                createdAt,
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            };
            const state: JobState = {
                version: 1,
                resultId,
                source: 'fake',
                sourceType: 'redis',
                creator: { oid: 'user-of-the-dead-replica' },
                queryHash: 'hash',
                createdAt,
                heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
                status: 'running',
                cancelRequested: false,
                progress: { rows: 7, bytes: 100, files: 1 },
                stats: { elapsedMs: 60_000 },
            };
            await putJson(survivor.service.store, `${resultId}/${STATE_PATH}`, state);
            await putJson(survivor.service.store, `${resultId}/${MANIFEST_PATH}`, manifest);

            assert.equal((await survivor.service.snapshot(resultId)).manifest.status, 'failed');
            assert.equal((await storedManifest(survivor.dir, resultId)).status, 'running', 'reading stores nothing');
            // a heartbeat of a minute ago may be a replica that is only slow: readers take it as failed, the
            // sweep does not yet overwrite what that replica would still store
            await survivor.service.sweep();
            assert.equal((await storedManifest(survivor.dir, resultId)).status, 'running');
            assert.deepEqual(lines, []);

            state.heartbeatAt = new Date(Date.now() - 600_000).toISOString();
            await putJson(survivor.service.store, `${resultId}/${STATE_PATH}`, state);
            await survivor.service.sweep();
            const stored = await storedManifest(survivor.dir, resultId);
            assert.equal(stored.status, 'failed');
            assert.equal(stored.rowCount, 7);
            assert.deepEqual(stored.error, {
                code: 'internal',
                message: 'The replica running this query stopped; run the query again',
                partial: true,
            });
            const end = {
                event: 'query.end',
                level: 30,
                resultId,
                source: 'fake',
                user: 'user-of-the-dead-replica',
                status: 'failed',
                rows: 7,
                bytes: 100,
                elapsedMs: 60_000,
                error: 'internal',
            };
            assert.deepEqual(lines, [end]);
            await survivor.service.sweep();
            assert.deepEqual(lines, [end], 'a closed result is not closed again');
        } finally {
            await survivor.dispose();
        }
    });

    it('sweeps only what has expired, and keeps what it cannot read', async () => {
        /** A store whose reads of one result fail, as during an outage. */
        class FlakyStore extends FilesystemResultStore {
            unreadable = '';
            override async get(path: string): Promise<Buffer | undefined> {
                if (this.unreadable && path.startsWith(this.unreadable)) throw new Error('store unavailable');
                return super.get(path);
            }
        }
        const stores: FlakyStore[] = [];
        const sweeping = await createResultHarness({
            store: (dir) => {
                const store = new FlakyStore(dir);
                stores.push(store);
                return store;
            },
        });
        try {
            const store = stores[0] as FlakyStore;
            const now = Date.now();
            const manifestOf = (resultId: string, expiresAt: number): Manifest => ({
                version: 1,
                resultId,
                source: 'fake',
                status: 'succeeded',
                format: 'ndjson',
                rowCount: 0,
                bytes: 0,
                schema: { columns: [] },
                files: [],
                createdAt: new Date(now - 7_200_000).toISOString(),
                expiresAt: new Date(expiresAt).toISOString(),
            });
            const stateOf = (resultId: string, heartbeatAt: number): JobState => ({
                version: 1,
                resultId,
                source: 'fake',
                sourceType: 'redis',
                creator: { oid: 'someone' },
                queryHash: 'hash',
                createdAt: new Date(heartbeatAt).toISOString(),
                heartbeatAt: new Date(heartbeatAt).toISOString(),
                status: 'queued',
                cancelRequested: false,
                progress: { rows: 0, bytes: 0, files: 0 },
                stats: { elapsedMs: 0 },
            });
            const [expired, unreadable, starting, leftover, abandoned, cutOff] = Array.from(
                { length: 6 },
                newResultId
            ) as [string, string, string, string, string, string];
            await putJson(store, `${expired}/${MANIFEST_PATH}`, manifestOf(expired, now - 1000));
            // expired as well, but its manifest cannot be read during this sweep
            await putJson(store, `${unreadable}/${MANIFEST_PATH}`, manifestOf(unreadable, now - 1000));
            // another replica has stored the state of a query and not yet its manifest
            await putJson(store, `${starting}/${STATE_PATH}`, stateOf(starting, now));
            // what an interrupted deletion leaves: files without a manifest, with an old state or none
            await store.put(`${leftover}/part-0000.ndjson.gz`, 'rest');
            await putJson(store, `${abandoned}/${STATE_PATH}`, stateOf(abandoned, now - 2 * 3_600_000));

            const left = async (): Promise<string[]> => {
                const ids: string[] = [];
                for await (const id of store.listResults()) ids.push(id);
                return ids.sort();
            };
            // a manifest cut off by a crash, long ago: it will never read, so it does not stay for good
            await store.put(`${cutOff}/${MANIFEST_PATH}`, '{"version":1,"resultId"');

            store.unreadable = unreadable;
            assert.equal(await sweeping.service.sweep(), 4);
            assert.deepEqual(await left(), [starting, unreadable].sort());

            store.unreadable = '';
            assert.equal(await sweeping.service.sweep(), 1, 'the next sweep reads it and finds it expired');
            assert.deepEqual(await left(), [starting]);
        } finally {
            await sweeping.dispose();
        }
    });

    it('interrupts a query that is just starting when it shuts down, and waits for its outcome', async () => {
        const lines: Record<string, unknown>[] = [];
        const audit = pino(
            { level: 'info', messageKey: 'event', base: null, timestamp: false },
            { write: (line: string) => void lines.push(JSON.parse(line)) }
        );
        // the store is slow, so the start is still storing the new result when the shutdown begins
        const stopping = await createResultHarness({
            loggers: { log: pino({ level: 'silent' }), audit },
            store: (dir) => new SlowManifestStore(dir),
        });
        try {
            let executed = false;
            const adapter = new FakeAdapter(() => {
                executed = true;
                return { format: 'ndjson', batches: documents(3)() };
            });
            const starting = stopping.service.start(adapter, await adapter.validate('q'), testCaller);
            await new Promise((resolve) => setTimeout(resolve, 50));
            await stopping.service.shutdown();

            const resultId = await starting;
            const stored = await storedManifest(stopping.dir, resultId);
            assert.equal(stored.status, 'failed', 'the outcome is stored when the shutdown returns');
            assert.match(stored.error?.message ?? '', /restarted .* run the query again/);
            assert.equal(executed, false, 'the source was never asked');
            assert.deepEqual(
                lines.map((line) => [line.event, line.status]),
                [
                    ['query.start', undefined],
                    ['query.end', 'failed'],
                ]
            );
        } finally {
            await stopping.dispose();
        }
    });

    it('ends a query in an orderly way when the store fails as it starts', async () => {
        /** A store whose third write fails: the first of the two that mark the query as running. */
        class FailingOnce extends FilesystemResultStore {
            #puts = 0;
            override async put(path: string, body: Buffer | string): Promise<void> {
                if (++this.#puts === 3) throw new Error('store unavailable');
                await super.put(path, body);
            }
        }
        const lines: Record<string, unknown>[] = [];
        const audit = pino(
            { level: 'info', messageKey: 'event', base: null, timestamp: false },
            { write: (line: string) => void lines.push(JSON.parse(line)) }
        );
        const failing = await createResultHarness({
            loggers: { log: pino({ level: 'silent' }), audit },
            store: (dir) => new FailingOnce(dir),
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(3)() }));
            const { manifest } = await failing.service.snapshot(await failing.run(adapter, 'q'));
            assert.equal(manifest.status, 'failed');
            assert.equal((await storedManifest(failing.dir, manifest.resultId)).status, 'failed');
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.deepEqual(unhandled, []);
            assert.deepEqual(
                lines.map((line) => [line.event, line.status]),
                [
                    ['query.start', undefined],
                    ['query.end', 'failed'],
                ]
            );
        } finally {
            process.off('unhandledRejection', onUnhandled);
            await failing.dispose();
        }
    });

    it('waits for the replica that runs a query to cancel it', async () => {
        // two replicas on one store: the second one cancels, the first one runs the query and looks for markers
        const first = await createResultHarness();
        const second = new ResultService({
            store: new FilesystemResultStore(first.dir),
            storeDescriptor: { kind: 'filesystem', dir: first.dir },
            retentionMs: 3_600_000,
            partBytes: 100 * 1024 * 1024,
            maxConcurrentQueriesPerUser: 8,
            read: { maxRows: 500, maxBytes: 65_536, maxValueChars: 2000 },
            loggers: nullLoggers(),
            signer: first.signer,
        });
        try {
            const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(1_000_000, 100)() }));
            const resultId = await first.service.start(adapter, await adapter.validate('q'), testCaller);
            await new Promise((resolve) => setTimeout(resolve, 200));
            const cancelling = second.cancel(resultId);
            // the first replica finds the marker some seconds later, as on its five-second timer
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            await first.service.pollRemoteCancellations();
            assert.equal((await cancelling).manifest.status, 'cancelled');
        } finally {
            await second.shutdown();
            await first.dispose();
        }
    });

    it('takes no query once it shuts down', async () => {
        const closing = await createResultHarness();
        try {
            await closing.service.shutdown();
            const adapter = new FakeAdapter(() => ({ format: 'ndjson', batches: documents(3)() }));
            await assert.rejects(
                closing.service.start(adapter, await adapter.validate('q'), testCaller),
                /shutting down/
            );
        } finally {
            await closing.dispose();
        }
    });

    it('rejects unknown result ids', async () => {
        await assert.rejects(harness.service.snapshot('r_doesnotexist'), /Unknown result/);
        await assert.rejects(harness.service.snapshot('../../etc/passwd'), /Unknown result/);
    });
});
