import { Worker } from 'node:worker_threads';
import { PeriscopeError } from '../../core/errors.ts';
import type { PartResult } from '../ndjson.ts';
import type { ColumnStats } from '../types.ts';
import type { ParquetColumn } from './columns.ts';
import type { FromWorker, StoreDescriptor, ToWorker } from './protocol.ts';

const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
const MAX_OUTSTANDING = 2;

const estimateBytes = (value: unknown): number => {
    if (value === null || value === undefined) return 1;
    if (typeof value === 'string') return value.length;
    if (value instanceof Uint8Array) return value.length;
    if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + estimateBytes(v), 4);
    return 8;
};

/**
 * Main-thread handle for one Parquet part. Rows are handed to a worker thread in
 * column-major batches; the worker encodes row groups and streams them to the store.
 */
export class ParquetPartWriter {
    readonly #worker: Worker;
    readonly #waiting: { resolve: (m: FromWorker) => void; reject: (e: Error) => void }[] = [];
    readonly #outstanding: Promise<FromWorker>[] = [];
    readonly #columnCount: number;
    #failure: Error | undefined;
    #rows = 0;
    #bytes = 0;

    private constructor(worker: Worker, columnCount: number) {
        this.#worker = worker;
        this.#columnCount = columnCount;
        worker.on('message', (message: FromWorker) => {
            const waiter = this.#waiting.shift();
            if (message.type === 'error') {
                this.#fail(new PeriscopeError('internal', `Parquet writer failed: ${message.message}`));
                waiter?.reject(this.#failure as Error);
                return;
            }
            if (message.type === 'ack') this.#bytes = message.bytes;
            waiter?.resolve(message);
        });
        worker.on('error', (error) => this.#fail(error));
        worker.on('exit', (code) => {
            if (code !== 0) this.#fail(new PeriscopeError('internal', `Parquet worker exited with code ${code}`));
        });
    }

    static async open(store: StoreDescriptor, path: string, columns: ParquetColumn[]): Promise<ParquetPartWriter> {
        const writer = new ParquetPartWriter(
            new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: 512 } }),
            columns.length
        );
        await writer.#send({ type: 'open', store, path, columns });
        return writer;
    }

    get rowCount(): number {
        return this.#rows;
    }

    /** Compressed bytes written so far, as last reported by the worker. */
    get bytes(): number {
        return this.#bytes;
    }

    #fail(error: Error): void {
        if (this.#failure) return;
        this.#failure = error;
        for (const waiter of this.#waiting.splice(0)) waiter.reject(error);
    }

    #send(message: ToWorker): Promise<FromWorker> {
        if (this.#failure) return Promise.reject(this.#failure);
        const reply = new Promise<FromWorker>((resolve, reject) => this.#waiting.push({ resolve, reject }));
        this.#worker.postMessage(message);
        return reply;
    }

    /** Adds row-major rows (one array of cell values per row). */
    async add(rows: unknown[][]): Promise<void> {
        if (rows.length === 0) return;
        const columns: unknown[][] = Array.from({ length: this.#columnCount }, () => new Array(rows.length));
        let estimatedBytes = 0;
        for (let r = 0; r < rows.length; r++) {
            const row = rows[r] as unknown[];
            for (let c = 0; c < this.#columnCount; c++) {
                const value = row[c] ?? null;
                (columns[c] as unknown[])[r] = value;
                estimatedBytes += estimateBytes(value);
            }
        }
        this.#rows += rows.length;
        const reply = this.#send({ type: 'rows', columns, estimatedBytes });
        // awaited later (back-pressure, finish); an abort in between must not become an unhandled rejection
        reply.catch(() => undefined);
        this.#outstanding.push(reply);
        while (this.#outstanding.length >= MAX_OUTSTANDING) await this.#outstanding.shift();
    }

    async finish(): Promise<PartResult & { stats: Record<string, ColumnStats> }> {
        await Promise.all(this.#outstanding.splice(0));
        const done = await this.#send({ type: 'finish' });
        await this.#worker.terminate();
        if (done.type !== 'done') throw new PeriscopeError('internal', 'Unexpected Parquet worker reply');
        this.#bytes = done.bytes;
        return {
            bytes: done.bytes,
            sha256: done.sha256,
            rowCount: done.rowCount,
            blocks: done.blocks,
            stats: done.stats,
        };
    }

    async abort(): Promise<void> {
        this.#outstanding.splice(0);
        if (!this.#failure) this.#worker.postMessage({ type: 'abort' } satisfies ToWorker);
        this.#fail(new PeriscopeError('cancelled', 'Parquet part aborted'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        await this.#worker.terminate();
    }
}
