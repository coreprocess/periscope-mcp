import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient, RestError } from '@azure/storage-blob';
import { PeriscopeError } from '../../core/errors.ts';
import type { AppendWriter, ResultStore, StoredObjectInfo } from './store.ts';

const BLOCK_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;

const isNotFound = (error: unknown): boolean => error instanceof RestError && error.statusCode === 404;

/**
 * Result store on Azure Blob Storage. Uses Periscope's own storage account with
 * read-write access to a single container. Retention is enforced by a lifecycle rule.
 */
export class AzureBlobResultStore implements ResultStore {
    readonly kind = 'azureblob' as const;
    readonly #container: ContainerClient;

    constructor(options: {
        accountUrl?: string | undefined;
        connectionString?: string | undefined;
        container: string;
    }) {
        const service = options.connectionString
            ? BlobServiceClient.fromConnectionString(options.connectionString)
            : new BlobServiceClient(options.accountUrl as string, new DefaultAzureCredential());
        this.#container = service.getContainerClient(options.container);
    }

    /** The container belongs to the deployment, which creates it with the storage account. */
    async init(): Promise<void> {}

    async put(path: string, body: Buffer | string, contentType: string): Promise<void> {
        const data = typeof body === 'string' ? Buffer.from(body) : body;
        await this.#container.getBlockBlobClient(path).uploadData(data, {
            blobHTTPHeaders: { blobContentType: contentType },
        });
    }

    async get(path: string): Promise<Buffer | undefined> {
        try {
            return await this.#container.getBlobClient(path).downloadToBuffer();
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    }

    async getRange(path: string, offset: number, length: number): Promise<Buffer> {
        if (length === 0) return Buffer.alloc(0);
        try {
            return await this.#container.getBlobClient(path).downloadToBuffer(offset, length, { concurrency: 1 });
        } catch (error) {
            if (isNotFound(error)) throw new PeriscopeError('not_found', `Not found: ${path}`);
            throw error;
        }
    }

    async head(path: string): Promise<StoredObjectInfo | undefined> {
        try {
            const props = await this.#container.getBlobClient(path).getProperties();
            return {
                size: props.contentLength ?? 0,
                etag: props.etag ?? '',
                lastModified: props.lastModified ?? new Date(0),
            };
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    }

    async stream(path: string, range?: { offset: number; length: number }): Promise<Readable> {
        try {
            const response = await this.#container
                .getBlobClient(path)
                .download(range?.offset ?? 0, range ? Math.max(range.length, 1) : undefined);
            if (!response.readableStreamBody) throw new PeriscopeError('internal', 'Empty download stream');
            return response.readableStreamBody as Readable;
        } catch (error) {
            if (isNotFound(error)) throw new PeriscopeError('not_found', `Not found: ${path}`);
            throw error;
        }
    }

    appendWriter(path: string): AppendWriter {
        const client = this.#container.getBlockBlobClient(path);
        const prefix = randomBytes(4).toString('hex');
        const blockIds: string[] = [];
        const inFlight = new Set<Promise<void>>();
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let bytes = 0;
        let failure: unknown;

        const stage = (): void => {
            if (pendingBytes === 0) return;
            const chunk = Buffer.concat(pending, pendingBytes);
            pending = [];
            pendingBytes = 0;
            const id = Buffer.from(`${prefix}-${String(blockIds.length).padStart(6, '0')}`).toString('base64');
            blockIds.push(id);
            const promise: Promise<void> = client
                .stageBlock(id, chunk, chunk.length)
                .then(() => undefined)
                .catch((error: unknown) => {
                    failure ??= error;
                })
                .finally(() => inFlight.delete(promise));
            inFlight.add(promise);
        };
        const drain = async (max: number): Promise<void> => {
            while (inFlight.size > max) await Promise.race(inFlight);
            if (failure) throw failure;
        };

        return {
            write: async (chunk) => {
                pending.push(chunk);
                pendingBytes += chunk.length;
                bytes += chunk.length;
                if (pendingBytes >= BLOCK_BYTES) {
                    stage();
                    await drain(MAX_IN_FLIGHT - 1);
                }
            },
            finish: async (contentType) => {
                stage();
                await drain(0);
                await client.commitBlockList(blockIds, { blobHTTPHeaders: { blobContentType: contentType } });
                return { bytes };
            },
            abort: async () => {
                pending = [];
                await Promise.allSettled(inFlight);
            },
        };
    }

    async *listResults(): AsyncIterable<string> {
        for await (const item of this.#container.listBlobsByHierarchy('/')) {
            if (item.kind === 'prefix') yield item.name.replace(/\/$/, '');
        }
    }

    async deleteResult(resultId: string): Promise<void> {
        for await (const blob of this.#container.listBlobsFlat({ prefix: `${resultId}/` })) {
            await this.#container.deleteBlob(blob.name, { deleteSnapshots: 'include' }).catch(() => undefined);
        }
    }
}
