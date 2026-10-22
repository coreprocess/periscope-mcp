/**
 * Types of the result model (concept §6). `Manifest` and `BlockIndex` are public,
 * versioned contracts served to clients; `JobState` is internal and never served.
 */

export type ResultFormat = 'parquet' | 'ndjson';
export type ResultStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

/** Normalized column types shared by all sources. */
export type NormalizedType =
    | 'string'
    | 'integer'
    | 'decimal'
    | 'number'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'time'
    | 'json'
    | 'binary'
    | 'list'
    | 'object'
    | 'mixed'
    | 'null';

export interface ColumnInfo {
    name: string;
    type: NormalizedType;
    sourceType?: string;
    parquetType?: string;
    nullable: boolean;
    /** Share of rows that contain the field (inferred schemas only). */
    presence?: number;
    note?: string;
}

export interface PartInfo {
    path: string;
    rowStart: number;
    rowCount: number;
    bytes: number;
    sha256: string;
    index: string;
}

export interface ResultError {
    code: string;
    message: string;
    partial: boolean;
}

export interface Manifest {
    version: 1;
    resultId: string;
    source: string;
    status: ResultStatus;
    format: ResultFormat;
    compression?: 'gzip';
    rowCount: number | null;
    bytes: number;
    schema: { columns: ColumnInfo[] };
    files: PartInfo[];
    blobCount?: number;
    blobBytes?: number;
    mayContainDuplicates?: boolean;
    createdAt: string;
    completedAt?: string;
    expiresAt: string;
    error?: ResultError;
}

export interface JobState {
    version: 1;
    resultId: string;
    source: string;
    sourceType: string;
    creator: { oid: string; name?: string };
    queryHash: string;
    createdAt: string;
    heartbeatAt: string;
    status: ResultStatus;
    cancelRequested: boolean;
    progress: { rows: number; bytes: number; files: number };
    stats: { elapsedMs: number; sourceCost?: Record<string, number> };
    error?: ResultError;
}

export type BlockUnit = 'gzip-member' | 'row-group' | 'lines';

export interface ColumnStats {
    min?: unknown;
    max?: unknown;
    nullCount?: number;
}

export interface BlockIndex {
    version: 1;
    file: string;
    unit: BlockUnit;
    columns:
        | ['rowStart', 'rowCount', 'byteOffset', 'byteLength']
        | ['lineStart', 'lineCount', 'byteOffset', 'byteLength'];
    blocks: [number, number, number, number][];
    stats?: Record<string, ColumnStats>;
}

export const MANIFEST_PATH = 'manifest.json';
export const STATE_PATH = 'state.json';
export const partPath = (index: number, format: ResultFormat): string =>
    `part-${String(index).padStart(4, '0')}.${format === 'parquet' ? 'parquet' : 'ndjson.gz'}`;
export const partIndexPath = (index: number): string => `index/part-${String(index).padStart(4, '0')}.json`;
