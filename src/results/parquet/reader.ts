import { zstdDecompressSync } from 'node:zlib';
import {
    type AsyncBuffer,
    type FileMetaData,
    parquetMetadataAsync,
    parquetReadObjects,
    type SchemaElement,
} from 'hyparquet';
import type { ResultStore } from '../store/store.ts';
import { decimalCell } from './decimal.ts';

const FOOTER_FETCH = 1024 * 1024;
const CACHE_SIZE = 64;

const compressors = {
    ZSTD: (input: Uint8Array): Uint8Array => new Uint8Array(zstdDecompressSync(input)),
};
const decoder = new TextDecoder();

const microsToIso = (micros: bigint): string => {
    const floorMillis = micros >= 0n ? micros / 1000n : -((-micros + 999n) / 1000n);
    const rest = Number(micros - floorMillis * 1000n);
    const iso = new Date(Number(floorMillis)).toISOString();
    return `${iso.slice(0, 23)}${String(rest).padStart(3, '0')}Z`;
};

const parsers = {
    timestampFromMicroseconds: (micros: bigint): string => microsToIso(micros),
    timestampFromMilliseconds: (millis: bigint): string => new Date(Number(millis)).toISOString(),
    timestampFromNanoseconds: (nanos: bigint): string => microsToIso(nanos / 1000n),
    dateFromDays: (days: number): string => new Date(days * 86_400_000).toISOString().slice(0, 10),
    jsonFromBytes: (bytes: Uint8Array): unknown => {
        const text = decoder.decode(bytes);
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    },
};

interface OpenPart {
    file: AsyncBuffer;
    metadata: FileMetaData;
    /** Metadata with DECIMAL annotations removed, so decimals arrive as raw unscaled values. */
    rawMetadata: FileMetaData;
    decimals: Map<string, number>;
    localTimestamps: Set<string>;
    columnNames: string[];
}

const isDecimal = (e: SchemaElement): boolean =>
    e.converted_type === 'DECIMAL' || (e.logical_type as { type?: string } | undefined)?.type === 'DECIMAL';

/** Small LRU of opened parts. Parts are immutable once listed, so caching by path is safe. */
const cache = new Map<string, Promise<OpenPart>>();

const asyncBuffer = (store: ResultStore, path: string, size: number): AsyncBuffer => {
    let tail: { start: number; data: ArrayBuffer } | undefined;
    return {
        byteLength: size,
        async slice(start: number, end?: number): Promise<ArrayBuffer> {
            const stop = end ?? size;
            if (tail && start >= tail.start) return tail.data.slice(start - tail.start, stop - tail.start);
            const data = await store.getRange(path, start, stop - start);
            const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
            if (stop === size) tail = { start, data: buffer };
            return buffer;
        },
    };
};

const openPart = async (store: ResultStore, path: string): Promise<OpenPart> => {
    const info = await store.head(path);
    if (!info) throw new Error(`Part not found: ${path}`);
    const file = asyncBuffer(store, path, info.size);
    const metadata = await parquetMetadataAsync(file, { initialFetchSize: FOOTER_FETCH, parsers });
    const decimals = new Map<string, number>();
    const localTimestamps = new Set<string>();
    const columnNames: string[] = [];
    const root = metadata.schema[0];
    let position = 1;
    for (let c = 0; c < Number(root?.num_children ?? 0); c++) {
        const element = metadata.schema[position] as SchemaElement;
        columnNames.push(element.name);
        if (isDecimal(element)) decimals.set(element.name, Number(element.scale ?? 0));
        const logical = element.logical_type as { type?: string; isAdjustedToUTC?: boolean } | undefined;
        if (logical?.type === 'TIMESTAMP' && logical.isAdjustedToUTC === false) localTimestamps.add(element.name);
        // skip nested children of LIST columns
        let skip = Number(element.num_children ?? 0);
        position++;
        while (skip > 0) {
            const child = metadata.schema[position] as SchemaElement;
            skip += Number(child.num_children ?? 0) - 1;
            position++;
        }
    }
    const rawSchema = metadata.schema.map((element) => {
        if (!isDecimal(element)) return element;
        const { converted_type: _c, logical_type: _l, ...rest } = element;
        return rest as SchemaElement;
    });
    return { file, metadata, rawMetadata: { ...metadata, schema: rawSchema }, decimals, localTimestamps, columnNames };
};

const getPart = (store: ResultStore, path: string): Promise<OpenPart> => {
    const key = `${store.kind}:${path}`;
    let entry = cache.get(key);
    if (entry) {
        cache.delete(key);
    } else {
        entry = openPart(store, path);
        entry.catch(() => cache.delete(key));
    }
    cache.set(key, entry);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return entry;
};

/** Column names of a Parquet part, in file order. */
export const parquetColumnNames = async (store: ResultStore, path: string): Promise<string[]> =>
    (await getPart(store, path)).columnNames;

/**
 * Reads rows `[start, start + count)` of one part, optionally projected to `columns`.
 * Uses the offset index, so only the pages containing the window are fetched.
 */
export const readParquetRows = async (
    store: ResultStore,
    path: string,
    start: number,
    count: number,
    columns?: string[]
): Promise<{ columns: string[]; rows: unknown[][] }> => {
    const part = await getPart(store, path);
    const selected = columns?.length ? columns.filter((c) => part.columnNames.includes(c)) : part.columnNames;
    const objects = await parquetReadObjects({
        file: part.file,
        metadata: part.rawMetadata,
        columns: selected,
        rowStart: start,
        rowEnd: start + count,
        utf8: false,
        useOffsetIndex: true,
        compressors,
        parsers,
    });
    const rows = objects.map((object) =>
        selected.map((name) => {
            const value = object[name];
            const scale = part.decimals.get(name);
            if (scale !== undefined) return decimalCell(value, scale);
            if (part.localTimestamps.has(name) && typeof value === 'string') return value.replace(/Z$/, '');
            return value ?? null;
        })
    );
    return { columns: selected, rows };
};
