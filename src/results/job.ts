import type { Logger } from 'pino';
import { PeriscopeError, toPeriscopeError } from '../core/errors.ts';
import { toJson } from '../core/values.ts';
import type {
    DocumentStream,
    ExecutionContext,
    FileReference,
    ResultStream,
    TabularStream,
} from '../sources/adapter.ts';
import { SchemaInferrer } from './infer.ts';
import { NdjsonPartWriter, type PartResult } from './ndjson.ts';
import type { StoreDescriptor } from './parquet/protocol.ts';
import { ParquetPartWriter } from './parquet/sink.ts';
import { putJson, type ResultStore } from './store/store.ts';
import {
    type BlockIndex,
    type ColumnInfo,
    type ColumnStats,
    type JobState,
    MANIFEST_PATH,
    type Manifest,
    type PartInfo,
    partIndexPath,
    partPath,
    type ResultError,
    STATE_PATH,
} from './types.ts';

export const FIRST_PART_ROWS = 5_000;
export const FIRST_PART_MS = 5_000;
export const HEARTBEAT_MS = 5_000;

interface PartWriter {
    readonly rowCount: number;
    readonly bytes: number;
    finish(): Promise<PartResult & { stats?: Record<string, ColumnStats> }>;
    abort(): Promise<void>;
}

export interface JobOptions {
    store: ResultStore;
    storeDescriptor: StoreDescriptor;
    partBytes: number;
    maxResultBytes: number;
    log: Logger;
    fileReference: (resultId: string, reference: FileReference) => string;
}

/**
 * Runs one query to completion: streams batches from the source into parts, writes
 * indexes, keeps the public manifest and the internal state up to date, and enforces
 * duration, size and cancellation.
 */
export class Job {
    readonly #options: JobOptions;
    readonly manifest: Manifest;
    readonly state: JobState;
    readonly #controller = new AbortController();
    readonly #started = Date.now();
    readonly #listeners = new Set<() => void>();
    readonly #costs: Record<string, number> = {};
    #heartbeat: NodeJS.Timeout | undefined;
    #persisting: Promise<void> = Promise.resolve();
    #inferrer: SchemaInferrer | undefined;
    #writer: PartWriter | undefined;

    constructor(manifest: Manifest, state: JobState, options: JobOptions) {
        this.manifest = manifest;
        this.state = state;
        this.#options = options;
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    /** Notifies `listener` whenever the manifest changes. Returns an unsubscribe function. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    cancel(): void {
        this.state.cancelRequested = true;
        this.#controller.abort(new PeriscopeError('cancelled', 'Query cancelled'));
    }

    context(deadline: number, log: Logger): ExecutionContext {
        return {
            signal: this.#controller.signal,
            deadline,
            log,
            addCost: (cost) => {
                for (const [key, value] of Object.entries(cost)) this.#costs[key] = (this.#costs[key] ?? 0) + value;
            },
            fileReference: (reference) => this.#options.fileReference(this.manifest.resultId, reference),
        };
    }

    #notify(): void {
        for (const listener of this.#listeners) listener();
    }

    /** Persists manifest and state; serialized so writes never interleave. */
    persist(): Promise<void> {
        this.state.heartbeatAt = new Date().toISOString();
        this.state.stats = {
            elapsedMs: Date.now() - this.#started,
            ...(Object.keys(this.#costs).length ? { sourceCost: { ...this.#costs } } : {}),
        };
        const manifest = structuredClone(this.manifest);
        const state = structuredClone(this.state);
        const prefix = this.manifest.resultId;
        this.#persisting = this.#persisting
            .catch(() => undefined)
            .then(async () => {
                await putJson(this.#options.store, `${prefix}/${STATE_PATH}`, state);
                await putJson(this.#options.store, `${prefix}/${MANIFEST_PATH}`, manifest);
            });
        this.#notify();
        return this.#persisting;
    }

    async run(open: () => Promise<ResultStream>, deadline: number): Promise<void> {
        const timer = setTimeout(
            () => this.#controller.abort(new PeriscopeError('timeout', 'Maximum query duration exceeded')),
            Math.max(deadline - Date.now(), 0)
        );
        this.#heartbeat = setInterval(() => void this.persist().catch(() => undefined), HEARTBEAT_MS);
        this.manifest.status = 'running';
        this.state.status = 'running';
        await this.persist();
        try {
            const stream = await open();
            this.#throwIfAborted();
            this.manifest.format = stream.format;
            if (stream.format === 'ndjson') this.manifest.compression = 'gzip';
            else delete this.manifest.compression;
            await this.#consume(stream);
            const last = this.#writer;
            this.#writer = undefined;
            if (last && last.rowCount > 0) await this.#closePart(last, stream);
            else await last?.abort();
            this.#finishSchema(stream);
            if (stream.format === 'ndjson') this.#documentExtras(stream);
            this.#complete('succeeded');
        } catch (error) {
            await this.#writer?.abort().catch(() => undefined);
            this.#writer = undefined;
            const reason = this.#controller.signal.aborted ? this.#controller.signal.reason : error;
            const failure = toPeriscopeError(reason, 'source_error');
            if (failure.code !== 'cancelled' && failure.cause !== undefined) {
                this.#options.log.warn({ err: failure, resultId: this.manifest.resultId }, 'query failed');
            }
            this.#complete(failure.code === 'cancelled' ? 'cancelled' : 'failed', {
                code: failure.code,
                message: failure.message,
                partial: this.manifest.files.length > 0,
            });
        } finally {
            clearTimeout(timer);
            clearInterval(this.#heartbeat);
            await this.persist().catch((error: unknown) =>
                this.#options.log.error({ err: error, resultId: this.manifest.resultId }, 'failed to persist result')
            );
        }
    }

    #throwIfAborted(): void {
        if (this.#controller.signal.aborted) throw this.#controller.signal.reason;
    }

    async #consume(stream: ResultStream): Promise<void> {
        const firstPartStarted = Date.now();
        const needsRollover = (w: PartWriter): boolean => {
            if (this.manifest.files.length === 0) {
                return (
                    w.rowCount >= FIRST_PART_ROWS || (w.rowCount > 0 && Date.now() - firstPartStarted >= FIRST_PART_MS)
                );
            }
            return w.bytes >= this.#options.partBytes;
        };
        if (stream.format === 'parquet') {
            this.manifest.schema = { columns: stream.columns.map((c) => c.info) };
            for await (const batch of stream.batches) {
                this.#throwIfAborted();
                const writer = (this.#writer as ParquetPartWriter | undefined) ?? (await this.#openParquet(stream));
                this.#writer = writer;
                await writer.add(batch);
                this.#progress(writer, batch.length);
                if (needsRollover(writer)) {
                    this.#writer = undefined;
                    await this.#closePart(writer, stream);
                }
            }
        } else {
            this.#inferrer = new SchemaInferrer();
            for await (const batch of stream.batches) {
                this.#throwIfAborted();
                const writer = (this.#writer as NdjsonPartWriter | undefined) ?? this.#openNdjson();
                this.#writer = writer;
                for (const document of batch) {
                    this.#inferrer.observe(document);
                    await writer.add(toJson(document));
                }
                this.#progress(writer, batch.length);
                if (needsRollover(writer)) {
                    this.#writer = undefined;
                    await this.#closePart(writer, stream);
                }
            }
        }
    }

    #progress(writer: PartWriter, rows: number): void {
        this.state.progress.rows += rows;
        const bytes = this.manifest.bytes + writer.bytes;
        this.state.progress.bytes = bytes;
        if (bytes > this.#options.maxResultBytes) {
            throw new PeriscopeError(
                'too_large',
                `Result exceeds the maximum size of ${this.#options.maxResultBytes} bytes; narrow the query`
            );
        }
    }

    #openParquet(stream: TabularStream): Promise<ParquetPartWriter> {
        const path = `${this.manifest.resultId}/${partPath(this.manifest.files.length, 'parquet')}`;
        return ParquetPartWriter.open(this.#options.storeDescriptor, path, stream.columns);
    }

    #openNdjson(): NdjsonPartWriter {
        const path = `${this.manifest.resultId}/${partPath(this.manifest.files.length, 'ndjson')}`;
        return new NdjsonPartWriter(this.#options.store.appendWriter(path));
    }

    async #closePart(writer: PartWriter, stream: ResultStream): Promise<void> {
        const number = this.manifest.files.length;
        const result = await writer.finish();
        const file = partPath(number, stream.format);
        const indexPath = partIndexPath(number);
        const index: BlockIndex = {
            version: 1,
            file,
            unit: stream.format === 'parquet' ? 'row-group' : 'gzip-member',
            columns: ['rowStart', 'rowCount', 'byteOffset', 'byteLength'],
            blocks: result.blocks,
            ...(result.stats ? { stats: result.stats } : {}),
        };
        await putJson(this.#options.store, `${this.manifest.resultId}/${indexPath}`, index);
        const rowStart = this.manifest.files.reduce((sum, part) => sum + part.rowCount, 0);
        const part: PartInfo = {
            path: file,
            rowStart,
            rowCount: result.rowCount,
            bytes: result.bytes,
            sha256: result.sha256,
            index: indexPath,
        };
        this.manifest.files.push(part);
        this.manifest.bytes += result.bytes;
        this.state.progress.files = this.manifest.files.length;
        if (stream.format === 'ndjson') this.#finishSchema(stream);
        await this.persist();
    }

    #finishSchema(stream: ResultStream): void {
        if (stream.format === 'ndjson' && this.#inferrer) {
            const columns: ColumnInfo[] = this.#inferrer.columns();
            this.manifest.schema = { columns };
        }
    }

    #documentExtras(stream: DocumentStream): void {
        if (stream.mayContainDuplicates?.()) this.manifest.mayContainDuplicates = true;
        const totals = stream.blobTotals?.();
        if (totals) {
            this.manifest.blobCount = totals.count;
            this.manifest.blobBytes = totals.bytes;
        }
    }

    #complete(status: 'succeeded' | 'failed' | 'cancelled', error?: ResultError): void {
        this.manifest.status = status;
        this.state.status = status;
        this.manifest.rowCount = this.manifest.files.reduce((sum, part) => sum + part.rowCount, 0);
        this.manifest.completedAt = new Date().toISOString();
        if (error) {
            this.manifest.error = error;
            this.state.error = error;
        }
    }
}
