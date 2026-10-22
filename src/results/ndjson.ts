import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import type { AppendWriter, ResultStore } from './store/store.ts';
import type { BlockIndex } from './types.ts';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export const BLOCK_BYTES = 1024 * 1024;
export const BLOCK_ROWS = 10_000;

export interface PartResult {
    bytes: number;
    sha256: string;
    rowCount: number;
    blocks: BlockIndex['blocks'];
}

/**
 * Writes one NDJSON part as a sequence of independent gzip members ("blocks"),
 * each holding whole lines (concept §6.2). Concatenated members are valid gzip.
 */
export class NdjsonPartWriter {
    readonly #out: AppendWriter;
    readonly #hash = createHash('sha256');
    readonly #blocks: BlockIndex['blocks'] = [];
    #lines: string[] = [];
    #lineBytes = 0;
    #rows = 0;
    #bytes = 0;

    constructor(out: AppendWriter) {
        this.#out = out;
    }

    get rowCount(): number {
        return this.#rows + this.#lines.length;
    }

    /** Compressed bytes written so far (excluding the pending block). */
    get bytes(): number {
        return this.#bytes;
    }

    async add(line: string): Promise<void> {
        this.#lines.push(line);
        this.#lineBytes += Buffer.byteLength(line) + 1;
        if (this.#lineBytes >= BLOCK_BYTES || this.#lines.length >= BLOCK_ROWS) await this.#flushBlock();
    }

    async #flushBlock(): Promise<void> {
        if (this.#lines.length === 0) return;
        const raw = Buffer.from(`${this.#lines.join('\n')}\n`);
        const compressed = await gzip(raw);
        this.#blocks.push([this.#rows, this.#lines.length, this.#bytes, compressed.length]);
        this.#rows += this.#lines.length;
        this.#lines = [];
        this.#lineBytes = 0;
        this.#hash.update(compressed);
        this.#bytes += compressed.length;
        await this.#out.write(compressed);
    }

    async finish(): Promise<PartResult> {
        await this.#flushBlock();
        await this.#out.finish('application/gzip');
        return { bytes: this.#bytes, sha256: this.#hash.digest('hex'), rowCount: this.#rows, blocks: this.#blocks };
    }

    abort(): Promise<void> {
        return this.#out.abort();
    }
}

/**
 * Reads rows `[start, start + count)` (relative to the part) using the block index:
 * one ranged read covering the needed blocks, then only those blocks are decompressed.
 */
export const readNdjsonRows = async (
    store: ResultStore,
    path: string,
    index: BlockIndex,
    start: number,
    count: number
): Promise<unknown[]> => {
    const end = start + count;
    const needed = index.blocks.filter(([rowStart, rowCount]) => rowStart < end && rowStart + rowCount > start);
    if (needed.length === 0) return [];
    const first = needed[0] as [number, number, number, number];
    const last = needed[needed.length - 1] as [number, number, number, number];
    const data = await store.getRange(path, first[2], last[2] + last[3] - first[2]);
    const rows: unknown[] = [];
    for (const [rowStart, , byteOffset, byteLength] of needed) {
        const block = await gunzip(data.subarray(byteOffset - first[2], byteOffset - first[2] + byteLength));
        const lines = block.toString('utf8').split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        for (let i = 0; i < lines.length; i++) {
            const row = rowStart + i;
            if (row >= start && row < end) rows.push(JSON.parse(lines[i] as string));
        }
    }
    return rows;
};
