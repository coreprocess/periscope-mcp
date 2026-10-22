import { createTruncator } from '../core/values.ts';
import { getPath } from './infer.ts';
import { readNdjsonRows } from './ndjson.ts';
import { readParquetRows } from './parquet/reader.ts';
import { getJson, type ResultStore } from './store/store.ts';
import type { BlockIndex, Manifest } from './types.ts';

export interface WindowLimits {
    maxRows: number;
    maxBytes: number;
    maxValueChars: number;
}

export interface RowWindow {
    columns: string[];
    rows: unknown[][];
    offset: number;
    nextOffset: number | null;
    rowCount: number | null;
    availableRows: number;
    truncatedValues: number;
    truncatedByBytes: boolean;
}

const indexCache = new Map<string, Promise<BlockIndex | undefined>>();
const loadIndex = (store: ResultStore, path: string): Promise<BlockIndex | undefined> => {
    let entry = indexCache.get(path);
    if (!entry) {
        entry = getJson<BlockIndex>(store, path);
        entry.catch(() => indexCache.delete(path));
        indexCache.set(path, entry);
        if (indexCache.size > 256) indexCache.delete(indexCache.keys().next().value as string);
    }
    return entry;
};

/** Default columns for documents: top-level fields from the inferred schema. */
const documentColumns = (manifest: Manifest): string[] => {
    const names = manifest.schema.columns.map((c) => c.name).filter((name) => !name.includes('.'));
    return names.length > 0 ? names : ['value'];
};

/**
 * Reads rows `[offset, offset + limit)` across parts, projects and truncates values,
 * and stops early when the response would exceed `maxBytes`.
 */
export const readWindow = async (
    store: ResultStore,
    manifest: Manifest,
    offset: number,
    limit: number,
    requestedColumns: string[] | undefined,
    limits: WindowLimits
): Promise<RowWindow> => {
    const available = manifest.files.reduce((sum, part) => sum + part.rowCount, 0);
    const wanted = Math.min(limit, limits.maxRows);
    const truncator = createTruncator({ maxValueChars: limits.maxValueChars });
    const columns = requestedColumns?.length
        ? requestedColumns
        : manifest.format === 'ndjson'
          ? documentColumns(manifest)
          : manifest.schema.columns.map((c) => c.name);
    const rows: unknown[][] = [];
    let bytes = 0;
    let truncatedByBytes = false;
    let position = offset;
    const end = Math.min(offset + wanted, available);

    for (const part of manifest.files) {
        if (position >= end) break;
        const partEnd = part.rowStart + part.rowCount;
        if (partEnd <= position) continue;
        const start = position - part.rowStart;
        const count = Math.min(end, partEnd) - position;
        const path = `${manifest.resultId}/${part.path}`;
        let raw: unknown[][];
        if (manifest.format === 'parquet') {
            raw = (await readParquetRows(store, path, start, count, columns)).rows;
        } else {
            const index = await loadIndex(store, `${manifest.resultId}/${part.index}`);
            if (!index) throw new Error(`Missing index for ${part.path}`);
            const documents = await readNdjsonRows(store, path, index, start, count);
            raw = documents.map((document) => columns.map((name) => getPath(document, name) ?? null));
        }
        for (const row of raw) {
            const rendered = row.map((value) => truncator.render(value));
            const size = JSON.stringify(rendered).length + 1;
            if (rows.length > 0 && bytes + size > limits.maxBytes) {
                truncatedByBytes = true;
                break;
            }
            bytes += size;
            rows.push(rendered);
            position++;
        }
        if (truncatedByBytes) break;
    }

    const isDone = manifest.status !== 'running' && manifest.status !== 'queued';
    const nextOffset = position < available || !isDone ? position : null;
    return {
        columns,
        rows,
        offset,
        nextOffset,
        rowCount: manifest.rowCount,
        availableRows: available,
        truncatedValues: truncator.truncated,
        truncatedByBytes,
    };
};
