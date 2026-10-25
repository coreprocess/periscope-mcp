import { createHash } from 'node:crypto';
import { PeriscopeError } from '../core/errors.ts';
import { isResultId, newResultId } from '../core/ids.ts';
import type { Loggers } from '../core/logger.ts';
import type { Signer } from '../core/signing.ts';
import type { PreparedQuery, SourceAdapter } from '../sources/adapter.ts';
import { encodeFileReference } from './files.ts';
import { Job } from './job.ts';
import type { StoreDescriptor } from './parquet/protocol.ts';
import { getJson, type ResultStore } from './store/store.ts';
import type { JobState, Manifest } from './types.ts';
import { CANCEL_PATH, MANIFEST_PATH, STATE_PATH } from './types.ts';
import { type RowWindow, readWindow, type WindowLimits } from './window.ts';

export interface Caller {
    oid: string;
    name?: string | undefined;
    roles: ReadonlySet<string>;
}

export interface ResultServiceOptions {
    store: ResultStore;
    storeDescriptor: StoreDescriptor;
    retentionMs: number;
    partBytes: number;
    maxConcurrentQueriesPerUser: number;
    read: WindowLimits;
    loggers: Loggers;
    signer: Signer;
}

/** A heartbeat older than this means the replica running the job is gone. */
const STALE_MS = 30_000;
const POLL_MS = 500;
export const MAX_WAIT_MS = 10_000;

export interface ResultSnapshot {
    manifest: Manifest;
    state: JobState | undefined;
}

/**
 * Entry point for everything about results: starting queries, status with long-poll,
 * windows, cancellation and retention. Jobs run in the replica that started them; all
 * other operations read from the shared result store, so any replica can serve them.
 */
export class ResultService {
    readonly #options: ResultServiceOptions;
    readonly #jobs = new Map<string, Job>();
    readonly #running = new Map<string, number>();

    constructor(options: ResultServiceOptions) {
        this.#options = options;
    }

    get store(): ResultStore {
        return this.#options.store;
    }

    async start(adapter: SourceAdapter, prepared: PreparedQuery, caller: Caller): Promise<string> {
        const active = this.#running.get(caller.oid) ?? 0;
        if (active >= this.#options.maxConcurrentQueriesPerUser) {
            throw new PeriscopeError(
                'limit_exceeded',
                `Too many concurrent queries (${active}); wait for one to finish or cancel it`
            );
        }
        const resultId = newResultId();
        const now = new Date();
        const config = adapter.config;
        const manifest: Manifest = {
            version: 1,
            resultId,
            source: config.name,
            status: 'queued',
            format: 'ndjson',
            rowCount: null,
            bytes: 0,
            schema: { columns: [] },
            files: [],
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.#options.retentionMs).toISOString(),
        };
        const state: JobState = {
            version: 1,
            resultId,
            source: config.name,
            sourceType: config.type,
            creator: { oid: caller.oid, ...(caller.name ? { name: caller.name } : {}) },
            queryHash: createHash('sha256')
                .update(JSON.stringify([prepared.query, prepared.params ?? null, prepared.options]))
                .digest('hex'),
            createdAt: now.toISOString(),
            heartbeatAt: now.toISOString(),
            status: 'queued',
            cancelRequested: false,
            progress: { rows: 0, bytes: 0, files: 0 },
            stats: { elapsedMs: 0 },
        };
        const log = this.#options.loggers.log.child({ resultId, source: config.name });
        const job = new Job(manifest, state, {
            store: this.#options.store,
            storeDescriptor: this.#options.storeDescriptor,
            partBytes: this.#options.partBytes,
            maxResultBytes: config.maxResultBytes,
            log,
            fileReference: (id, reference) => encodeFileReference(this.#options.signer, id, reference),
        });
        await job.persist();
        this.#jobs.set(resultId, job);
        this.#running.set(caller.oid, active + 1);
        const deadline = Date.now() + config.maxQueryDurationMs;
        const context = job.context(deadline, log);
        this.#options.loggers.audit.info(
            { resultId, source: config.name, user: caller.oid, queryHash: state.queryHash },
            'query.start'
        );
        void job
            .run(() => adapter.execute(prepared, context), deadline)
            .finally(() => {
                this.#running.set(caller.oid, Math.max((this.#running.get(caller.oid) ?? 1) - 1, 0));
                this.#options.loggers.audit.info(
                    {
                        resultId,
                        source: config.name,
                        user: caller.oid,
                        status: job.manifest.status,
                        rows: job.manifest.rowCount,
                        bytes: job.manifest.bytes,
                        elapsedMs: job.state.stats.elapsedMs,
                        ...(job.manifest.error ? { error: job.manifest.error.code } : {}),
                    },
                    'query.end'
                );
                setTimeout(() => this.#jobs.delete(resultId), 60_000).unref();
            });
        return resultId;
    }

    async #load(resultId: string): Promise<ResultSnapshot> {
        if (!isResultId(resultId)) throw new PeriscopeError('not_found', `Unknown result '${resultId}'`);
        const local = this.#jobs.get(resultId);
        if (local) return { manifest: structuredClone(local.manifest), state: structuredClone(local.state) };
        const [manifest, state] = await Promise.all([
            getJson<Manifest>(this.#options.store, `${resultId}/${MANIFEST_PATH}`),
            getJson<JobState>(this.#options.store, `${resultId}/${STATE_PATH}`),
        ]);
        if (!manifest) throw new PeriscopeError('not_found', `Unknown or deleted result '${resultId}'`);
        if (
            state &&
            (manifest.status === 'running' || manifest.status === 'queued') &&
            Date.now() - Date.parse(state.heartbeatAt) > STALE_MS
        ) {
            manifest.status = 'failed';
            manifest.error = {
                code: 'internal',
                message: 'The replica running this query stopped; run the query again',
                partial: manifest.files.length > 0,
            };
        }
        return { manifest, state };
    }

    /** Returns the current snapshot, waiting up to `waitMs` for a status change. */
    async snapshot(resultId: string, waitMs = 0): Promise<ResultSnapshot> {
        let current = await this.#load(resultId);
        const wait = Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
        const isActive = (s: ResultSnapshot): boolean =>
            s.manifest.status === 'running' || s.manifest.status === 'queued';
        if (wait > 0 && isActive(current)) {
            const initialStatus = current.manifest.status;
            const initialFiles = current.manifest.files.length;
            const until = Date.now() + wait;
            const local = this.#jobs.get(resultId);
            while (Date.now() < until) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, Math.min(POLL_MS, until - Date.now()));
                    const off = local?.onChange(() => {
                        clearTimeout(timer);
                        off?.();
                        resolve();
                    });
                });
                current = await this.#load(resultId);
                if (current.manifest.status !== initialStatus || !isActive(current)) break;
                if (current.manifest.files.length !== initialFiles && current.manifest.status !== 'running') break;
            }
        }
        if (Date.now() > Date.parse(current.manifest.expiresAt)) current.manifest.status = 'expired';
        return current;
    }

    async readRows(resultId: string, offset: number, limit: number, columns: string[] | undefined): Promise<RowWindow> {
        const { manifest } = await this.snapshot(resultId);
        if (manifest.status === 'expired') throw new PeriscopeError('expired', `Result '${resultId}' has expired`);
        return readWindow(this.#options.store, manifest, offset, limit, columns, this.#options.read);
    }

    async cancel(resultId: string): Promise<ResultSnapshot> {
        const local = this.#jobs.get(resultId);
        if (local) {
            local.cancel();
        } else {
            const { manifest } = await this.#load(resultId);
            if (manifest.status === 'running' || manifest.status === 'queued') {
                // The job's own heartbeat rewrites state.json, so remote cancellation uses a separate marker.
                await this.#options.store.put(`${resultId}/${CANCEL_PATH}`, '{}\n', 'application/json');
            }
        }
        return this.snapshot(resultId, 2_000);
    }

    /** Deletes expired results (filesystem store; Azure uses a lifecycle rule as well). */
    async sweep(): Promise<number> {
        let deleted = 0;
        for await (const resultId of this.#options.store.listResults()) {
            if (!isResultId(resultId) || this.#jobs.has(resultId)) continue;
            const manifest = await getJson<Manifest>(this.#options.store, `${resultId}/${MANIFEST_PATH}`).catch(
                () => undefined
            );
            if (manifest && Date.now() <= Date.parse(manifest.expiresAt)) continue;
            await this.#options.store.deleteResult(resultId);
            deleted++;
        }
        return deleted;
    }

    /** Cancels running jobs on shutdown, so their results are marked accordingly. */
    async shutdown(): Promise<void> {
        for (const job of this.#jobs.values()) {
            if (job.manifest.status === 'running' || job.manifest.status === 'queued') job.cancel();
        }
        const deadline = Date.now() + 5_000;
        while ([...this.#jobs.values()].some((j) => j.manifest.status === 'running') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /** Remote cancellation: running jobs look for a cancel marker written by another replica. */
    async pollRemoteCancellations(): Promise<void> {
        for (const [resultId, job] of this.#jobs) {
            if (job.manifest.status !== 'running') continue;
            const marker = await this.#options.store.head(`${resultId}/${CANCEL_PATH}`).catch(() => undefined);
            if (marker) job.cancel();
        }
    }
}
