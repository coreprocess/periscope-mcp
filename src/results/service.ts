import { createHash } from 'node:crypto';
import { PeriscopeError } from '../core/errors.ts';
import { isResultId, newResultId } from '../core/ids.ts';
import type { Loggers } from '../core/logger.ts';
import type { Signer } from '../core/signing.ts';
import type { PreparedQuery, SourceAdapter } from '../sources/adapter.ts';
import { encodeFileReference } from './files.ts';
import { concludeResult, Job } from './job.ts';
import type { StoreDescriptor } from './parquet/protocol.ts';
import { getJson, putJson, type ResultStore } from './store/store.ts';
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
/** How long `cancel` waits for the query to end. A local job ends at once; one of another replica when it polls. */
const CANCEL_WAIT_MS = 2_000;
/** The same for a query of another replica, which looks for cancel markers every 5 s. */
const REMOTE_CANCEL_WAIT_MS = 7_000;
/**
 * How old a heartbeat is before a sweep stores the query as failed. Far beyond the 30 s after which readers take
 * it as failed: storing it overwrites what a replica that is only slow would still write.
 */
const CLOSE_ORPHAN_MS = 5 * 60_000;
/** How long a shutdown waits for interrupted jobs to store their final manifest. */
const SHUTDOWN_WAIT_MS = 5_000;

const REPLICA_STOPPED = new PeriscopeError('internal', 'The replica running this query stopped; run the query again');

/** A query nobody runs any more: its replica died without storing how the query ended. */
const isOrphaned = (manifest: Manifest, state: JobState, staleMs = STALE_MS): boolean =>
    (manifest.status === 'running' || manifest.status === 'queued') &&
    Date.now() - Date.parse(state.heartbeatAt) > staleMs;

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
    readonly #runs = new Set<Promise<void>>();
    #closing = false;

    constructor(options: ResultServiceOptions) {
        this.#options = options;
    }

    get store(): ResultStore {
        return this.#options.store;
    }

    async start(adapter: SourceAdapter, prepared: PreparedQuery, caller: Caller): Promise<string> {
        if (this.#closing) {
            throw new PeriscopeError('internal', 'Periscope is shutting down; run the query again');
        }
        // counted from the jobs themselves: a query stops counting the moment it has ended, not some time after
        let active = 0;
        for (const job of this.#jobs.values()) {
            const { status } = job.manifest;
            if (job.state.creator.oid === caller.oid && (status === 'running' || status === 'queued')) active++;
        }
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
        // Known to the service before the first await: a start that runs at the same time counts it against the
        // user's limit, and a shutdown reaches it, interrupts it and waits until its outcome is stored.
        this.#jobs.set(resultId, job);
        const ended = Promise.withResolvers<void>();
        this.#runs.add(ended.promise);
        const settle = (): void => {
            this.#runs.delete(ended.promise);
            ended.resolve();
        };
        await job.persist().catch((error: unknown) => {
            this.#jobs.delete(resultId);
            settle();
            throw error;
        });
        const deadline = Date.now() + config.maxQueryDurationMs;
        const context = job.context(deadline, log);
        this.#options.loggers.audit.info(
            { resultId, source: config.name, user: caller.oid, queryHash: state.queryHash },
            'query.start'
        );
        void job
            .run(() => adapter.execute(prepared, context), deadline)
            .finally(() => {
                this.#auditEnd(job.manifest, job.state);
                setTimeout(() => this.#jobs.delete(resultId), 60_000).unref();
                settle();
            });
        return resultId;
    }

    #auditEnd(manifest: Manifest, state: JobState): void {
        this.#options.loggers.audit.info(
            {
                resultId: manifest.resultId,
                source: manifest.source,
                user: state.creator.oid,
                status: manifest.status,
                rows: manifest.rowCount,
                bytes: manifest.bytes,
                elapsedMs: state.stats.elapsedMs,
                ...(manifest.error ? { error: manifest.error.code } : {}),
            },
            'query.end'
        );
    }

    async #load(resultId: string): Promise<ResultSnapshot> {
        if (!isResultId(resultId)) throw new PeriscopeError('not_found', `Unknown result '${resultId}'`);
        const stored = this.#jobs.get(resultId)?.stored;
        if (stored) return structuredClone(stored);
        const [manifest, state] = await Promise.all([
            getJson<Manifest>(this.#options.store, `${resultId}/${MANIFEST_PATH}`),
            getJson<JobState>(this.#options.store, `${resultId}/${STATE_PATH}`),
        ]);
        if (!manifest) throw new PeriscopeError('not_found', `Unknown or deleted result '${resultId}'`);
        // readers learn it at once; the next sweep stores it
        if (state && isOrphaned(manifest, state)) concludeResult(manifest, state, REPLICA_STOPPED);
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
        // The answer carries the outcome: a query cancelled as it started first turns to running, which is a
        // status change too, so the wait goes on until the query has ended.
        const wait = local ? CANCEL_WAIT_MS : REMOTE_CANCEL_WAIT_MS;
        const until = Date.now() + wait;
        let current = await this.snapshot(resultId, wait);
        while ((current.manifest.status === 'running' || current.manifest.status === 'queued') && Date.now() < until) {
            current = await this.snapshot(resultId, until - Date.now());
        }
        return current;
    }

    /**
     * Deletes expired results (filesystem store; Azure uses a lifecycle rule as well) and closes the results of
     * queries whose replica died: they are stored as failed and get their `query.end` in the audit log.
     */
    async sweep(): Promise<number> {
        let deleted = 0;
        for await (const resultId of this.#options.store.listResults()) {
            if (!isResultId(resultId) || this.#jobs.has(resultId)) continue;
            // A result that cannot be read, closed or deleted now is left for the next sweep, and does not keep
            // this one from the others.
            const removed = await this.#sweepResult(resultId).catch((error: unknown) => {
                this.#options.loggers.log.warn({ err: error, resultId }, 'failed to sweep a result');
                return false;
            });
            if (removed) deleted++;
        }
        return deleted;
    }

    /** Deletes the result if it has expired, and closes it if its replica died. Returns whether it was deleted. */
    async #sweepResult(resultId: string): Promise<boolean> {
        const { store } = this.#options;
        // a manifest that is no JSON (cut off by a crash) counts as none; any other failure to read it is passing
        const manifest = await getJson<Manifest>(store, `${resultId}/${MANIFEST_PATH}`).catch((error: unknown) => {
            if (error instanceof SyntaxError) return undefined;
            throw error;
        });
        if (manifest && Date.now() <= Date.parse(manifest.expiresAt)) {
            await this.#closeOrphan(manifest);
            return false;
        }
        if (!manifest) {
            // A query that is just starting has stored its state and not yet its manifest. Anything older without
            // a manifest is what an interrupted deletion left behind.
            const state = await getJson<JobState>(store, `${resultId}/${STATE_PATH}`);
            if (state && Date.now() - Date.parse(state.heartbeatAt) <= this.#options.retentionMs) return false;
        }
        await store.deleteResult(resultId);
        return true;
    }

    async #closeOrphan(manifest: Manifest): Promise<void> {
        if (manifest.status !== 'running' && manifest.status !== 'queued') return;
        const state = await getJson<JobState>(this.#options.store, `${manifest.resultId}/${STATE_PATH}`);
        if (!state || !isOrphaned(manifest, state, CLOSE_ORPHAN_MS)) return;
        concludeResult(manifest, state, REPLICA_STOPPED);
        await putJson(this.#options.store, `${manifest.resultId}/${STATE_PATH}`, state);
        await putJson(this.#options.store, `${manifest.resultId}/${MANIFEST_PATH}`, manifest);
        this.#auditEnd(manifest, state);
    }

    /**
     * Fails running jobs on shutdown and waits until their final manifest is stored, so
     * callers learn at once to run the query again instead of after the heartbeat expires.
     */
    async shutdown(): Promise<void> {
        this.#closing = true;
        for (const job of this.#jobs.values()) {
            if (job.manifest.status === 'running' || job.manifest.status === 'queued') job.interrupt();
        }
        await Promise.race([
            Promise.allSettled(this.#runs),
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
        ]);
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
