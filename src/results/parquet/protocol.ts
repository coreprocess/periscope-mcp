import type { BlockIndex, ColumnStats } from '../types.ts';
import type { ParquetColumn } from './columns.ts';

/** Serializable description of the result store, so the worker can open its own client. */
export type StoreDescriptor =
    | { kind: 'filesystem'; dir: string }
    | { kind: 'azureblob'; accountUrl?: string | undefined; connectionString?: string | undefined; container: string };

export const ROW_GROUP_ROWS = 50_000;
export const ROW_GROUP_BYTES = 32 * 1024 * 1024;
export const PAGE_SIZE = 64 * 1024;

export type ToWorker =
    | { type: 'open'; store: StoreDescriptor; path: string; columns: ParquetColumn[] }
    | { type: 'rows'; columns: unknown[][]; estimatedBytes: number }
    | { type: 'finish' }
    | { type: 'abort' };

export type FromWorker =
    | { type: 'ack'; bytes: number }
    | {
          type: 'done';
          bytes: number;
          sha256: string;
          rowCount: number;
          blocks: BlockIndex['blocks'];
          stats: Record<string, ColumnStats>;
      }
    | { type: 'error'; message: string };
