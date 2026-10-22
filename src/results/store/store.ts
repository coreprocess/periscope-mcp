import type { Readable } from 'node:stream';

/**
 * Storage for result files. Paths are relative to the store root and always start
 * with the result ID (`<resultId>/manifest.json`). Implementations: local filesystem
 * and Azure Blob Storage. This is Periscope's own storage, never a source.
 */
export interface StoredObjectInfo {
    size: number;
    etag: string;
    lastModified: Date;
}

export interface AppendWriter {
    /** Appends bytes. Data becomes visible only after `finish`. */
    write(chunk: Buffer): Promise<void>;
    /** Commits the object atomically. */
    finish(contentType: string): Promise<{ bytes: number }>;
    abort(): Promise<void>;
}

export interface ResultStore {
    readonly kind: 'filesystem' | 'azureblob';
    init(): Promise<void>;
    put(path: string, body: Buffer | string, contentType: string): Promise<void>;
    get(path: string): Promise<Buffer | undefined>;
    getRange(path: string, offset: number, length: number): Promise<Buffer>;
    head(path: string): Promise<StoredObjectInfo | undefined>;
    stream(path: string, range?: { offset: number; length: number }): Promise<Readable>;
    appendWriter(path: string): AppendWriter;
    /** Lists result IDs (top-level prefixes). */
    listResults(): AsyncIterable<string>;
    deleteResult(resultId: string): Promise<void>;
}

export const getJson = async <T>(store: ResultStore, path: string): Promise<T | undefined> => {
    const data = await store.get(path);
    return data === undefined ? undefined : (JSON.parse(data.toString('utf8')) as T);
};

export const putJson = (store: ResultStore, path: string, value: unknown): Promise<void> =>
    store.put(path, `${JSON.stringify(value, null, 1)}\n`, 'application/json');
