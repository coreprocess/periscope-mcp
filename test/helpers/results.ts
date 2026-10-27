import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Loggers, nullLoggers } from '../../src/core/logger.ts';
import { Signer } from '../../src/core/signing.ts';
import { type Caller, ResultService } from '../../src/results/service.ts';
import { FilesystemResultStore } from '../../src/results/store/filesystem.ts';
import type { SourceAdapter } from '../../src/sources/adapter.ts';

export const testCaller: Caller = { oid: 'test-user', name: 'Test User', roles: new Set(['Periscope.Reader']) };

export interface ResultHarness {
    service: ResultService;
    signer: Signer;
    dir: string;
    run(adapter: SourceAdapter, query: string, params?: unknown, options?: Record<string, unknown>): Promise<string>;
    dispose(): Promise<void>;
}

export const createResultHarness = async (
    overrides: { partBytes?: number; loggers?: Loggers } = {}
): Promise<ResultHarness> => {
    const dir = await mkdtemp(join(tmpdir(), 'periscope-results-'));
    const store = new FilesystemResultStore(dir);
    const signer = new Signer(randomBytes(32));
    await store.init();
    const service = new ResultService({
        store,
        storeDescriptor: { kind: 'filesystem', dir },
        retentionMs: 3_600_000,
        partBytes: overrides.partBytes ?? 100 * 1024 * 1024,
        maxConcurrentQueriesPerUser: 8,
        read: { maxRows: 500, maxBytes: 65_536, maxValueChars: 2000 },
        loggers: overrides.loggers ?? nullLoggers(),
        signer,
    });
    return {
        service,
        signer,
        dir,
        async run(adapter, query, params, options = {}) {
            const prepared = await adapter.validate(query, params, options);
            const resultId = await service.start(adapter, prepared, testCaller);
            for (let i = 0; i < 120; i++) {
                const { manifest } = await service.snapshot(resultId, 10_000);
                if (manifest.status !== 'running' && manifest.status !== 'queued') return resultId;
            }
            throw new Error('query did not finish');
        },
        dispose: async () => {
            await service.shutdown();
            await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        },
    };
};
