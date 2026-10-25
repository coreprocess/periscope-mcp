import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { NdjsonPartWriter, readNdjsonRows } from '../../src/results/ndjson.ts';
import {
    dateColumn,
    decimalColumn,
    listColumn,
    scalarColumn,
    timestampColumn,
} from '../../src/results/parquet/columns.ts';
import { toUnscaled } from '../../src/results/parquet/decimal.ts';
import { readParquetRows } from '../../src/results/parquet/reader.ts';
import { ParquetPartWriter } from '../../src/results/parquet/sink.ts';
import { FilesystemResultStore } from '../../src/results/store/filesystem.ts';
import type { BlockIndex } from '../../src/results/types.ts';

let dir: string;
let store: FilesystemResultStore;

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'periscope-formats-'));
    store = new FilesystemResultStore(dir);
    await store.init();
});
after(() => rm(dir, { recursive: true, force: true }));

describe('decimal parsing', () => {
    it('parses exact values and rejects precision loss', () => {
        assert.equal(toUnscaled('123.45', 10, 2), 12345n);
        assert.equal(toUnscaled('-0.5', 10, 2), -50n);
        assert.equal(toUnscaled('1e3', 10, 2), 100000n);
        assert.equal(toUnscaled('1.234', 10, 2), undefined);
        assert.equal(toUnscaled('1.230', 10, 2), 123n);
        assert.equal(toUnscaled('99999999999', 10, 0), undefined);
    });
});

describe('parquet part', () => {
    const extra = { sourceType: 'test' };
    const columns = [
        scalarColumn('id', 'int64', extra),
        decimalColumn('amount', 38, 10, extra),
        decimalColumn('price', 12, 2, extra),
        decimalColumn('small', 5, 1, extra),
        timestampColumn('ts', true, extra),
        timestampColumn('local_ts', false, extra),
        dateColumn('d', extra),
        scalarColumn('doc', 'json', extra),
        scalarColumn('bin', 'binary', extra),
        scalarColumn('name', 'string', extra),
        listColumn('tags', 'int64', extra),
        scalarColumn('flag', 'boolean', extra),
        scalarColumn('f', 'double', extra),
    ];
    const big = '-99999999999999999999999999.9999999999';
    const row = (i: number): unknown[] => [
        BigInt(i),
        i === 1 ? toUnscaled(big, 38, 10) : i % 7 === 0 ? null : toUnscaled(`${i}.0000000001`, 38, 10),
        toUnscaled(`${i}.25`, 12, 2),
        i % 2 === 0 ? 15n : null,
        1_700_000_000_123_456n + BigInt(i),
        1_700_000_000_000_000n,
        19_000 + i,
        i % 3 === 0 ? null : `{"k":${i},"big":12345678901234567890}`,
        new Uint8Array([i & 255, 1, 2]),
        `name-${i}`,
        i % 5 === 0 ? null : [BigInt(i), null, 3n],
        i % 2 === 0,
        i * 0.5,
    ];

    it('round-trips every column kind exactly, with index and statistics', async () => {
        const writer = await ParquetPartWriter.open({ kind: 'filesystem', dir }, 'r1/part-0000.parquet', columns);
        const total = 120_000;
        for (let start = 0; start < total; start += 10_000) {
            await writer.add(Array.from({ length: 10_000 }, (_, k) => row(start + k)));
        }
        const result = await writer.finish();
        assert.equal(result.rowCount, total);
        assert.equal(result.blocks.length, 3, 'three row groups of 50k/50k/20k rows');
        assert.deepEqual(
            result.blocks.map((b) => b[1]),
            [50_000, 50_000, 20_000]
        );
        assert.equal(result.stats.id?.min, '0');
        assert.equal(result.stats.id?.max, String(total - 1));
        assert.equal(result.stats.price?.min, '0.25');
        assert.equal(result.stats.ts?.min, '2023-11-14T22:13:20.123456Z');

        const window = await readParquetRows(store, 'r1/part-0000.parquet', 0, 3);
        assert.deepEqual(
            window.columns,
            columns.map((c) => c.name)
        );
        const [r0, r1] = window.rows as unknown[][];
        assert.equal(r1?.[1], big);
        assert.equal(r0?.[2], '0.25');
        assert.equal(r0?.[3], '1.5');
        assert.equal(r1?.[3], null);
        assert.equal(r0?.[4], '2023-11-14T22:13:20.123456Z');
        assert.equal(r0?.[5], '2023-11-14T22:13:20.000000');
        assert.equal(r0?.[6], '2022-01-08');
        assert.equal(r0?.[7], null);
        assert.deepEqual(r1?.[7], { k: 1, big: 12345678901234567000 });
        assert.deepEqual(r1?.[10], [1n, null, 3n]);

        const deep = await readParquetRows(store, 'r1/part-0000.parquet', 99_998, 4, ['id', 'name']);
        assert.deepEqual(deep.rows, [
            [99_998n, 'name-99998'],
            [99_999n, 'name-99999'],
            [100_000n, 'name-100000'],
            [100_001n, 'name-100001'],
        ]);
    });

    it('aborts with rows in flight without an unhandled rejection', async () => {
        const unhandled: unknown[] = [];
        const record = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', record);
        try {
            const writer = await ParquetPartWriter.open({ kind: 'filesystem', dir }, 'r9/part-0000.parquet', columns);
            // one reply stays outstanding (back-pressure only waits from two on), then the export is cancelled
            await writer.add(Array.from({ length: 5000 }, (_, k) => row(k)));
            await writer.abort();
            await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
            process.off('unhandledRejection', record);
        }
        assert.deepEqual(unhandled, []);
    });
});

describe('ndjson part', () => {
    it('writes independent gzip members and reads windows through the block index', async () => {
        const writer = new NdjsonPartWriter(store.appendWriter('r2/part-0000.ndjson.gz'));
        const total = 25_000;
        for (let i = 0; i < total; i++) await writer.add(JSON.stringify({ i, text: 'x'.repeat(i % 300) }));
        const result = await writer.finish();
        assert.equal(result.rowCount, total);
        assert.ok(result.blocks.length >= 3);

        const whole = gunzipSync((await store.get('r2/part-0000.ndjson.gz')) as Buffer).toString('utf8');
        assert.equal(whole.split('\n').filter(Boolean).length, total, 'concatenated members are valid gzip');

        const index: BlockIndex = {
            version: 1,
            file: 'part-0000.ndjson.gz',
            unit: 'gzip-member',
            columns: ['rowStart', 'rowCount', 'byteOffset', 'byteLength'],
            blocks: result.blocks,
        };
        const rows = (await readNdjsonRows(store, 'r2/part-0000.ndjson.gz', index, 9_998, 5)) as { i: number }[];
        assert.deepEqual(
            rows.map((r) => r.i),
            [9_998, 9_999, 10_000, 10_001, 10_002]
        );
    });
});
