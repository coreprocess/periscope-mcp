import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { SourceConfig } from '../../src/config/sources.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { Signer } from '../../src/core/signing.ts';
import { scalarColumn } from '../../src/results/parquet/columns.ts';
import { ResultService } from '../../src/results/service.ts';
import { AzureBlobResultStore } from '../../src/results/store/azureblob.ts';
import type { PreparedQuery, ResultStream, SourceAdapter, SourceInfo } from '../../src/sources/adapter.ts';
import { testCaller } from '../helpers/results.ts';

const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

const fake = (stream: () => ResultStream): SourceAdapter => ({
    config: {
        index: 0,
        type: 'redis',
        name: 'fake',
        maxQueryDurationMs: 60_000,
        maxResultBytes: 1024 ** 3,
    } as SourceConfig,
    init: async () => {},
    info: () => ({}) as SourceInfo,
    describe: async () => ({}),
    validate: async (query: string): Promise<PreparedQuery> => ({ query, params: null, options: {} }),
    execute: async () => stream(),
    close: async () => {},
});

describe('azure blob result store', () => {
    let container: StartedTestContainer;
    let store: AzureBlobResultStore;
    let service: ResultService;

    before(async () => {
        container = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite')
            .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'])
            .withExposedPorts(10000)
            .withWaitStrategy(Wait.forLogMessage(/Azurite Blob service successfully listens/))
            .start();
        const connectionString = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://${container.getHost()}:${container.getMappedPort(10000)}/devstoreaccount1;`;
        store = new AzureBlobResultStore({ connectionString, container: 'results' });
        await store.init();
        service = new ResultService({
            store,
            storeDescriptor: { kind: 'azureblob', connectionString, container: 'results' },
            retentionMs: 3_600_000,
            partBytes: 300_000,
            maxConcurrentQueriesPerUser: 4,
            read: { maxRows: 500, maxBytes: 65_536, maxValueChars: 2000 },
            loggers: nullLoggers(),
            signer: new Signer(randomBytes(32)),
        });
    });

    after(async () => {
        await service?.shutdown();
        await container?.stop();
    });

    const run = async (adapter: SourceAdapter): Promise<string> => {
        const resultId = await service.start(adapter, await adapter.validate('q', null, {}), testCaller);
        let snapshot = await service.snapshot(resultId, 10_000);
        while (snapshot.manifest.status === 'running' || snapshot.manifest.status === 'queued') {
            snapshot = await service.snapshot(resultId, 10_000);
        }
        return resultId;
    };

    it('writes Parquet parts from the worker thread into block blobs and reads windows by range', async () => {
        const resultId = await run(
            fake(() => ({
                format: 'parquet',
                columns: [
                    scalarColumn('n', 'int64', { sourceType: 'x' }),
                    scalarColumn('s', 'string', { sourceType: 'x' }),
                ],
                batches: (async function* () {
                    for (let i = 0; i < 200_000; i += 10_000) {
                        yield Array.from({ length: 10_000 }, (_, k) => [
                            BigInt(i + k),
                            `row-${i + k}-${'x'.repeat(20)}`,
                        ]);
                    }
                })(),
            }))
        );
        const { manifest } = await service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, 200_000);
        assert.ok(manifest.files.length >= 2);
        const window = await service.readRows(resultId, 150_000, 2, undefined);
        assert.deepEqual(window.rows, [
            [150_000, `row-150000-${'x'.repeat(20)}`],
            [150_001, `row-150001-${'x'.repeat(20)}`],
        ]);
        const head = await store.head(`${resultId}/${manifest.files[0]?.path}`);
        assert.equal(head?.size, manifest.files[0]?.bytes);
    });

    it('writes block-gzip NDJSON parts, serves ranges and sweeps expired results', async () => {
        const resultId = await run(
            fake(() => ({
                format: 'ndjson',
                batches: (async function* () {
                    for (let i = 0; i < 30_000; i += 1000) {
                        yield Array.from({ length: 1000 }, (_, k) => ({ i: i + k }));
                    }
                })(),
            }))
        );
        const { manifest } = await service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        const part = manifest.files[0] as { path: string; bytes: number };
        const whole = await store.get(`${resultId}/${part.path}`);
        assert.equal(whole?.length, part.bytes);
        assert.ok(
            gunzipSync(whole as Buffer)
                .toString()
                .split('\n').length > 1000
        );
        const range = await store.getRange(`${resultId}/${part.path}`, 0, 10);
        assert.equal(range.length, 10);
        const window = await service.readRows(resultId, 29_998, 5, ['i']);
        assert.deepEqual(window.rows, [[29_998], [29_999]]);

        const ids: string[] = [];
        for await (const id of store.listResults()) ids.push(id);
        assert.ok(ids.includes(resultId));
        await store.deleteResult(resultId);
        assert.equal(await store.head(`${resultId}/manifest.json`), undefined);
    });
});
