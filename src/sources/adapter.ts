import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { SourceConfig, SourceType } from '../config/sources.ts';
import type { ParquetColumn } from '../results/parquet/columns.ts';

/**
 * The read-only contract every source implements. Adapters only describe, validate
 * and stream; jobs, parts, windows and downloads are generic (concept §9.2).
 */

export type CredentialState = 'read-only verified' | 'unverified' | 'write-capable';

export interface SourceInfo {
    name: string;
    type: SourceType;
    description: string | undefined;
    queryLanguage: string;
    dialectHints: string[];
    options: Record<string, string>;
    params: string;
    readOnlyLayers: string[];
    credential: CredentialState;
    credentialNote?: string;
}

export interface PreparedQuery {
    query: string;
    params: unknown;
    options: Record<string, unknown>;
    /** Adapter-specific data computed during validation (e.g. the parsed command). */
    plan?: unknown;
}

export interface ExecutionContext {
    signal: AbortSignal;
    deadline: number;
    log: Logger;
    /** Adds to the per-result cost statistics, e.g. `{ ru: 3.2 }`. */
    addCost(cost: Record<string, number>): void;
    /** Builds the signed relative path (`files/…`) under which a referenced blob is served. */
    fileReference(reference: FileReference): string;
}

export interface TabularStream {
    format: 'parquet';
    columns: ParquetColumn[];
    /** Batches of row-major rows, values in the form the column kinds expect. */
    batches: AsyncIterable<unknown[][]>;
}

export interface DocumentStream {
    format: 'ndjson';
    batches: AsyncIterable<unknown[]>;
    /** Set when the stream may repeat rows (Redis SCAN beyond the dedupe budget). */
    mayContainDuplicates?: () => boolean;
    /** Blob results: number and total size of referenced blobs. */
    blobTotals?: () => { count: number; bytes: number };
}

export type ResultStream = TabularStream | DocumentStream;

/** Blob contents referenced by a result (`files/...`), served from the source. */
export interface FileReference {
    container: string;
    name: string;
    etag?: string;
    versionId?: string;
    snapshot?: string;
}

export interface FileContent {
    size: number;
    contentType: string;
    etag: string;
    stream: Readable;
    range?: { start: number; end: number };
}

export interface FileProvider {
    openFile(reference: FileReference, range?: { offset: number; length: number }): Promise<FileContent>;
}

export interface SourceAdapter {
    readonly config: SourceConfig;
    /** Connects lazily and runs startup checks (inventory, credential posture). */
    init(log: Logger): Promise<void>;
    info(): SourceInfo;
    describe(path: string | undefined, filter: string | undefined): Promise<unknown>;
    /** Synchronous read-only guard: throws QueryRejectedError before any result exists. */
    validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery>;
    execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream>;
    files?: FileProvider;
    close(): Promise<void>;
}
