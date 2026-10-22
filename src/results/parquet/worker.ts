import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { constants, zstdCompressSync } from 'node:zlib';
import type { ColumnChunk, SchemaElement } from 'hyparquet';
import { ByteWriter, ParquetWriter } from 'hyparquet-writer';
import { AzureBlobResultStore } from '../store/azureblob.ts';
import { FilesystemResultStore } from '../store/filesystem.ts';
import type { AppendWriter, ResultStore } from '../store/store.ts';
import type { BlockIndex, ColumnStats } from '../types.ts';
import { fileSchema, type ParquetColumn } from './columns.ts';
import { formatDecimal } from './decimal.ts';
import {
    type FromWorker,
    PAGE_SIZE,
    ROW_GROUP_BYTES,
    ROW_GROUP_ROWS,
    type StoreDescriptor,
    type ToWorker,
} from './protocol.ts';

/**
 * Worker thread that encodes one Parquet part with hyparquet-writer and streams the
 * bytes into the result store. Encoding is CPU-bound and synchronous, so it runs here
 * to keep the server's event loop responsive.
 */

const CHUNK_BYTES = 8 * 1024 * 1024;
const compressors = {
    ZSTD: (input: Uint8Array): Uint8Array =>
        new Uint8Array(zstdCompressSync(input, { params: { [constants.ZSTD_c_compressionLevel]: 3 } })),
};
const encoder = new TextEncoder();

/** hyparquet-writer `Writer` that streams into an AppendWriter, with backpressure on flush. */
class StoreByteWriter extends ByteWriter {
    readonly #out: AppendWriter;
    readonly #hash = createHash('sha256');
    #pending: Promise<void> = Promise.resolve();

    constructor(out: AppendWriter) {
        super(CHUNK_BYTES + 1024 * 1024);
        this.#out = out;
    }

    override ensure(size: number): void {
        if (this.index >= CHUNK_BYTES) this.#cut();
        super.ensure(size);
    }

    #cut(): void {
        if (this.index === 0) return;
        const chunk = Buffer.from(new Uint8Array(this.buffer, 0, this.index).slice());
        this.index = 0;
        this.#hash.update(chunk);
        this.#pending = this.#pending.then(() => this.#out.write(chunk));
    }

    flush(): Promise<void> {
        this.#cut();
        return this.#pending;
    }

    override async finish(): Promise<void> {
        this.#cut();
        await this.#pending;
        await this.#out.finish('application/vnd.apache.parquet');
    }

    digest(): string {
        return this.#hash.digest('hex');
    }
}

const openStore = (descriptor: StoreDescriptor): ResultStore =>
    descriptor.kind === 'filesystem' ? new FilesystemResultStore(descriptor.dir) : new AzureBlobResultStore(descriptor);

const daysToIso = (days: number): string => new Date(days * 86_400_000).toISOString().slice(0, 10);
export const microsToIso = (micros: bigint): string => {
    const millis = micros / 1000n;
    const rest = Number(((micros % 1000n) + 1000n) % 1000n);
    const iso = new Date(Number(millis - (micros < 0n && rest > 0 ? 1n : 0n))).toISOString();
    return `${iso.slice(0, 23)}${String(rest).padStart(3, '0')}Z`;
};

/** Converts a raw statistics value into a JSON-friendly value for the index. */
const statValue = (column: ParquetColumn, value: unknown): unknown => {
    if (value === undefined || value === null) return undefined;
    switch (column.kind) {
        case 'int32':
        case 'double':
            return typeof value === 'number' ? value : Number(value);
        case 'int64':
            return typeof value === 'bigint' ? value.toString() : value;
        case 'decimal':
            return formatDecimal(BigInt(value as number | bigint), column.scale ?? 0);
        case 'date':
            return daysToIso(Number(value));
        case 'timestamp':
            return microsToIso(BigInt(value as bigint));
        case 'string':
            return typeof value === 'string' ? value.slice(0, 64) : undefined;
        case 'boolean':
            return value;
        default:
            return undefined;
    }
};

const less = (a: unknown, b: unknown): boolean => (a as number) < (b as number);

let writer: ParquetWriter | undefined;
let sink: StoreByteWriter | undefined;
let output: AppendWriter | undefined;
let columns: ParquetColumn[] = [];
let buffered: unknown[][] = [];
let bufferedRows = 0;
let bufferedBytes = 0;
let totalRows = 0;

const post = (message: FromWorker): void => parentPort?.postMessage(message);

const writeGroup = async (): Promise<void> => {
    if (!writer || bufferedRows === 0) return;
    const columnData = columns.map((column, i) => ({
        name: column.name,
        data: buffered[i] as unknown[],
        columnIndex: true,
    }));
    buffered = columns.map(() => []);
    totalRows += bufferedRows;
    bufferedRows = 0;
    bufferedBytes = 0;
    // biome-ignore lint/suspicious/noExplicitAny: hyparquet-writer's DecodedArray typing is narrower than our cell values
    await writer.write({ columnData: columnData as any, rowGroupSize: Number.MAX_SAFE_INTEGER, pageSize: PAGE_SIZE });
};

const toCell = (column: ParquetColumn, value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (column.kind === 'json') return encoder.encode(value as string);
    return value;
};

const buildIndex = (): { blocks: BlockIndex['blocks']; stats: Record<string, ColumnStats> } => {
    const blocks: BlockIndex['blocks'] = [];
    const stats: Record<string, ColumnStats> = {};
    let rowStart = 0;
    for (const group of writer?.row_groups ?? []) {
        const chunks = group.columns as ColumnChunk[];
        let byteOffset = Number.MAX_SAFE_INTEGER;
        for (const chunk of chunks) {
            const meta = chunk.meta_data;
            if (!meta) continue;
            const start = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
            byteOffset = Math.min(byteOffset, start);
        }
        const rowCount = Number(group.num_rows);
        blocks.push([rowStart, rowCount, byteOffset, Number(group.total_compressed_size ?? 0n)]);
        rowStart += rowCount;

        for (const chunk of chunks) {
            const path = chunk.meta_data?.path_in_schema ?? [];
            const column = columns.find((c) => c.name === path[0]);
            if (!column || column.kind === 'list' || column.kind === 'json' || column.kind === 'binary') continue;
            const s = chunk.meta_data?.statistics;
            if (!s) continue;
            const entry = (stats[column.name] ??= { nullCount: 0 });
            entry.nullCount = (entry.nullCount ?? 0) + Number(s.null_count ?? 0n);
            const min = s.min_value ?? s.min;
            const max = s.max_value ?? s.max;
            if (min !== undefined && min !== null && (entry.min === undefined || less(min, entry.min))) entry.min = min;
            if (max !== undefined && max !== null && (entry.max === undefined || less(entry.max, max))) entry.max = max;
        }
    }
    for (const column of columns) {
        const entry = stats[column.name];
        if (!entry) continue;
        const min = statValue(column, entry.min);
        const max = statValue(column, entry.max);
        stats[column.name] = {
            ...(min !== undefined ? { min } : {}),
            ...(max !== undefined ? { max } : {}),
            nullCount: entry.nullCount ?? 0,
        };
    }
    return { blocks, stats };
};

const handle = async (message: ToWorker): Promise<void> => {
    switch (message.type) {
        case 'open': {
            const store = openStore(message.store);
            columns = message.columns;
            buffered = columns.map(() => []);
            output = store.appendWriter(message.path);
            sink = new StoreByteWriter(output);
            writer = new ParquetWriter({
                writer: sink,
                schema: fileSchema(columns),
                codec: 'ZSTD',
                compressors,
                createdBy: 'periscope-mcp',
            });
            post({ type: 'ack', bytes: 0 });
            return;
        }
        case 'rows': {
            const rowCount = message.columns[0]?.length ?? 0;
            for (let c = 0; c < columns.length; c++) {
                const column = columns[c] as ParquetColumn;
                const target = buffered[c] as unknown[];
                for (const value of message.columns[c] as unknown[]) target.push(toCell(column, value));
            }
            bufferedRows += rowCount;
            bufferedBytes += message.estimatedBytes;
            if (bufferedRows >= ROW_GROUP_ROWS || bufferedBytes >= ROW_GROUP_BYTES) await writeGroup();
            post({ type: 'ack', bytes: sink?.offset ?? 0 });
            return;
        }
        case 'finish': {
            await writeGroup();
            if (!writer || !sink) throw new Error('writer not open');
            // JSON columns carry raw text bytes; annotate them only in the footer.
            let position = 1;
            for (const column of columns) {
                const element: SchemaElement | undefined = writer.schema[position];
                if (column.kind === 'json' && element) {
                    Object.assign(element, { converted_type: 'JSON', logical_type: { type: 'JSON' } });
                }
                position += column.elements.length;
            }
            await writer.finish();
            const { blocks, stats } = buildIndex();
            post({ type: 'done', bytes: sink.offset, sha256: sink.digest(), rowCount: totalRows, blocks, stats });
            return;
        }
        case 'abort':
            await output?.abort();
            process.exit(0);
    }
};

let queue: Promise<void> = Promise.resolve();
parentPort?.on('message', (message: ToWorker) => {
    queue = queue
        .then(() => handle(message))
        .catch((error: unknown) =>
            post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        );
});
