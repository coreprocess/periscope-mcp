import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { PeriscopeError } from '../../core/errors.ts';
import type { AppendWriter, ResultStore, StoredObjectInfo } from './store.ts';

/** Result store on the local filesystem (stdio mode, single-replica deployments, tests). */
export class FilesystemResultStore implements ResultStore {
    readonly kind = 'filesystem' as const;
    readonly #root: string;

    constructor(root: string) {
        this.#root = resolve(root);
    }

    async init(): Promise<void> {
        await mkdir(this.#root, { recursive: true });
    }

    #path(path: string): string {
        const full = resolve(this.#root, path);
        if (!full.startsWith(this.#root + sep)) throw new PeriscopeError('invalid_argument', 'Path escapes store root');
        return full;
    }

    async put(path: string, body: Buffer | string): Promise<void> {
        const full = this.#path(path);
        await mkdir(dirname(full), { recursive: true });
        const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, body);
        await rename(temp, full);
    }

    async get(path: string): Promise<Buffer | undefined> {
        try {
            return await readFile(this.#path(path));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async getRange(path: string, offset: number, length: number): Promise<Buffer> {
        const handle = await open(this.#path(path), 'r').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') throw new PeriscopeError('not_found', `Not found: ${path}`);
            throw error;
        });
        try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    }

    async head(path: string): Promise<StoredObjectInfo | undefined> {
        try {
            const info = await stat(this.#path(path));
            return {
                size: info.size,
                etag: `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
                lastModified: info.mtime,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async stream(path: string, range?: { offset: number; length: number }): Promise<Readable> {
        const full = this.#path(path);
        await stat(full).catch(() => {
            throw new PeriscopeError('not_found', `Not found: ${path}`);
        });
        if (!range) return createReadStream(full);
        if (range.length === 0) return createReadStream(full, { start: 1, end: 0 });
        return createReadStream(full, { start: range.offset, end: range.offset + range.length - 1 });
    }

    appendWriter(path: string): AppendWriter {
        const full = this.#path(path);
        const temp = `${full}.${process.pid}.${Date.now()}.partial`;
        let stream: WriteStream | undefined;
        let bytes = 0;
        const ensure = async (): Promise<WriteStream> => {
            if (!stream) {
                await mkdir(dirname(full), { recursive: true });
                stream = createWriteStream(temp);
            }
            return stream;
        };
        const end = (s: WriteStream): Promise<void> =>
            new Promise((done, failed) => {
                s.once('error', failed);
                s.end(() => done());
            });
        return {
            write: async (chunk) => {
                const s = await ensure();
                bytes += chunk.length;
                if (!s.write(chunk)) await new Promise<void>((done) => s.once('drain', () => done()));
            },
            finish: async () => {
                await end(await ensure());
                await rename(temp, full);
                return { bytes };
            },
            abort: async () => {
                if (stream) await end(stream).catch(() => undefined);
                await rm(temp, { force: true });
            },
        };
    }

    async *listResults(): AsyncIterable<string> {
        const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) if (entry.isDirectory()) yield entry.name;
    }

    async deleteResult(resultId: string): Promise<void> {
        await rm(join(this.#root, resultId), { recursive: true, force: true });
    }
}
