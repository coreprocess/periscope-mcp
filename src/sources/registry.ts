import type { Logger } from 'pino';
import type { SourceConfig } from '../config/sources.ts';
import { errorMessage, PeriscopeError, summaryOf } from '../core/errors.ts';
import type { SourceAdapter } from './adapter.ts';
import { BlobAdapter } from './blob/adapter.ts';
import { CosmosAdapter } from './cosmos/adapter.ts';
import { KimAdapter } from './kim/adapter.ts';
import { LogAnalyticsAdapter } from './loganalytics/adapter.ts';
import { MssqlAdapter } from './mssql/adapter.ts';
import { OracleAdapter } from './oracle/adapter.ts';
import { PostgresAdapter } from './postgres/adapter.ts';
import { RedisAdapter } from './redis/adapter.ts';

export const createAdapter = (config: SourceConfig): SourceAdapter => {
    switch (config.type) {
        case 'postgres':
            return new PostgresAdapter(config);
        case 'oracle':
            return new OracleAdapter(config);
        case 'mssql':
            return new MssqlAdapter(config);
        case 'cosmos':
            return new CosmosAdapter(config);
        case 'blob':
            return new BlobAdapter(config);
        case 'loganalytics':
            return new LogAnalyticsAdapter(config);
        case 'redis':
            return new RedisAdapter(config);
        case 'kim':
            return new KimAdapter(config);
    }
};

interface Entry {
    adapter: SourceAdapter;
    ready: Promise<void> | undefined;
    settled: boolean;
    error: string | undefined;
}

const RETRY_MS = 60_000;

/**
 * Holds all configured sources. A source that fails to initialize (unreachable, bad
 * credentials) does not stop the server: it is reported as unavailable and retried
 * on next use or status report, at most once per RETRY_MS.
 */
export class SourceRegistry {
    readonly #entries = new Map<string, Entry>();
    readonly #log: Logger;
    #retryAt = new Map<string, number>();

    constructor(
        configs: SourceConfig[],
        log: Logger,
        factory: (config: SourceConfig) => SourceAdapter = createAdapter
    ) {
        this.#log = log;
        for (const config of configs) {
            this.#entries.set(config.name, {
                adapter: factory(config),
                ready: undefined,
                settled: false,
                error: undefined,
            });
        }
    }

    names(): string[] {
        return [...this.#entries.keys()];
    }

    configs(): SourceConfig[] {
        return [...this.#entries.values()].map((e) => e.adapter.config);
    }

    #start(name: string, entry: Entry): Promise<void> {
        entry.settled = false;
        entry.ready = entry.adapter.init(this.#log.child({ source: name })).then(
            () => {
                entry.error = undefined;
                entry.settled = true;
            },
            (error: unknown) => {
                entry.error = summaryOf(error);
                entry.settled = true;
                this.#retryAt.set(name, Date.now() + RETRY_MS);
                this.#log.error({ source: name, error: errorMessage(error) }, 'source initialization failed');
                throw error;
            }
        );
        entry.ready.catch(() => undefined);
        return entry.ready;
    }

    #due(name: string, entry: Entry): boolean {
        return !entry.ready || (entry.error !== undefined && Date.now() >= (this.#retryAt.get(name) ?? 0));
    }

    /** Retries failed sources whose retry time has come, so a status report is current. */
    retryDue(): void {
        for (const [name, entry] of this.#entries) if (this.#due(name, entry)) this.#start(name, entry);
    }

    /** Initializes all sources in parallel; failures are logged, not thrown. */
    async initAll(): Promise<void> {
        await Promise.allSettled([...this.#entries].map(([name, entry]) => this.#start(name, entry)));
    }

    status(name: string): { available: boolean; error?: string } {
        const entry = this.#entries.get(name);
        if (!entry) return { available: false, error: 'unknown source' };
        if (!entry.settled) return { available: false, error: 'still connecting' };
        return entry.error ? { available: false, error: entry.error } : { available: true };
    }

    /** Waits until every source has finished (or failed) initializing, at most `ms`. */
    async settle(ms: number): Promise<void> {
        const pending = [...this.#entries.values()].map((e) => e.ready?.catch(() => undefined));
        await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, ms).unref())]);
    }

    peek(name: string): SourceAdapter | undefined {
        return this.#entries.get(name)?.adapter;
    }

    /** Returns an initialized adapter, retrying initialization after a failure. */
    async get(name: string): Promise<SourceAdapter> {
        const entry = this.#entries.get(name);
        if (!entry) throw new PeriscopeError('unknown_source', `Unknown source '${name}'`);
        if (this.#due(name, entry)) this.#start(name, entry);
        try {
            await entry.ready;
        } catch (error) {
            throw new PeriscopeError('source_error', `Source '${name}' is unavailable: ${summaryOf(error)}`);
        }
        return entry.adapter;
    }

    async closeAll(): Promise<void> {
        await Promise.allSettled([...this.#entries.values()].map((e) => e.adapter.close()));
    }
}
