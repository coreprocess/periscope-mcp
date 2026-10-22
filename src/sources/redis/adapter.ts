import { DefaultAzureCredential } from '@azure/identity';
import { createClient, createCluster, RESP_TYPES } from '@redis/client';
import { EntraIdCredentialsProviderFactory } from '@redis/entraid';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { RedisSourceConfig } from '../../config/sources.ts';
import { PeriscopeError } from '../../core/errors.ts';
import type {
    DocumentStream,
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { parseOptions } from '../common.ts';
import { installRedisWireGuard, type ParsedCommand, parseReadOnlyCommand } from './guard.ts';

const SCAN_COUNT = 1000;
const CHUNK = 1000;
const DEDUPE_LIMIT = 5_000_000;
const DESCRIBE_SAMPLE = 10_000;

const optionsSchema = z.object({ values: z.boolean().optional() }).strict();

type Reply = unknown;
interface NodeClient {
    sendCommand(args: string[]): Promise<Reply>;
}
interface ClusterRouter {
    sendCommand(key: string | undefined, readonly: boolean, args: string[]): Promise<Reply>;
}
interface AnyClient extends NodeClient {
    connect(): Promise<unknown>;
    close(): Promise<void>;
    on(event: 'error', listener: (error: Error) => void): unknown;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Converts a reply into JSON-friendly values: Buffers to text (or base64), Maps to objects. */
export const normalizeReply = (value: Reply): unknown => {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) {
        try {
            return decoder.decode(value);
        } catch {
            return { encoding: 'base64', data: value.toString('base64') };
        }
    }
    if (value instanceof Map)
        return Object.fromEntries([...value].map(([k, v]) => [String(normalizeReply(k)), normalizeReply(v)]));
    if (Array.isArray(value)) return value.map(normalizeReply);
    if (typeof value === 'object' && value.constructor === Object) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeReply(v)]));
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') return String(value);
    return value;
};

const pairs = (reply: unknown): [unknown, unknown][] => {
    if (reply !== null && typeof reply === 'object' && !Array.isArray(reply)) return Object.entries(reply as object);
    if (!Array.isArray(reply)) return [];
    if (reply.every((x) => Array.isArray(x) && x.length === 2)) return reply as [unknown, unknown][];
    const out: [unknown, unknown][] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) out.push([reply[i], reply[i + 1]]);
    return out;
};

const toNumber = (value: unknown): unknown =>
    typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;

/** Shapes a single command's reply into result rows. */
export const replyToRows = (command: ParsedCommand, raw: Reply): unknown[] => {
    const reply = normalizeReply(raw);
    const upperArgs = command.args.map((a) => a.toUpperCase());
    if (command.name === 'HGETALL') return pairs(reply).map(([field, value]) => ({ field, value }));
    if (/^Z(REV)?RANGE/.test(command.name) && upperArgs.includes('WITHSCORES')) {
        return pairs(reply).map(([member, score]) => ({ member, score: toNumber(score) }));
    }
    if (command.name === 'XRANGE' || command.name === 'XREVRANGE') {
        return (Array.isArray(reply) ? reply : []).map((entry) => {
            const [id, fields] = Array.isArray(entry) ? entry : [null, null];
            return { id, fields: Object.fromEntries(pairs(fields)) };
        });
    }
    if (Array.isArray(reply)) return reply.map((value, index) => ({ index, value }));
    if (reply !== null && typeof reply === 'object') return pairs(reply).map(([field, value]) => ({ field, value }));
    return [{ value: reply }];
};

class OpsLimiter {
    readonly #perSecond: number | undefined;
    #windowStart = Date.now();
    #count = 0;
    constructor(perSecond: number | undefined) {
        this.#perSecond = perSecond;
    }
    async take(ops: number, signal: AbortSignal): Promise<void> {
        if (!this.#perSecond) return;
        const now = Date.now();
        if (now - this.#windowStart >= 1000) {
            this.#windowStart = now;
            this.#count = 0;
        }
        this.#count += ops;
        if (this.#count > this.#perSecond) {
            const wait = 1000 - (now - this.#windowStart);
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, wait);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.#windowStart = Date.now();
            this.#count = 0;
        }
    }
}

/** Fetches a key's value by type, in chunks for large collections (never one huge blocking call). */
const fetchValue = async (client: NodeClient, key: string, type: string, limiter: OpsLimiter, signal: AbortSignal) => {
    const collect = async (fetch: (start: number) => Promise<unknown[]>): Promise<unknown[]> => {
        const items: unknown[] = [];
        for (let start = 0; ; start += CHUNK) {
            await limiter.take(1, signal);
            const chunk = await fetch(start);
            items.push(...chunk);
            if (chunk.length < CHUNK) return items;
        }
    };
    const scanAll = async (command: 'HSCAN' | 'SSCAN' | 'ZSCAN'): Promise<unknown[]> => {
        const items: unknown[] = [];
        let cursor = '0';
        do {
            await limiter.take(1, signal);
            const reply = normalizeReply(await client.sendCommand([command, key, cursor, 'COUNT', String(CHUNK)])) as [
                string,
                unknown[],
            ];
            cursor = String(reply[0]);
            items.push(...(reply[1] ?? []));
        } while (cursor !== '0');
        return items;
    };
    switch (type) {
        case 'string':
            await limiter.take(1, signal);
            return normalizeReply(await client.sendCommand(['GET', key]));
        case 'hash':
            return Object.fromEntries(pairs(await scanAll('HSCAN')));
        case 'set':
            return [...new Set(await scanAll('SSCAN'))];
        case 'zset':
            return pairs(await scanAll('ZSCAN')).map(([member, score]) => ({ member, score: toNumber(score) }));
        case 'list':
            return collect(
                async (start) =>
                    normalizeReply(
                        await client.sendCommand(['LRANGE', key, String(start), String(start + CHUNK - 1)])
                    ) as unknown[]
            );
        case 'stream': {
            const entries: unknown[] = [];
            let from = '-';
            while (true) {
                await limiter.take(1, signal);
                const reply = normalizeReply(
                    await client.sendCommand(['XRANGE', key, from, '+', 'COUNT', String(CHUNK)])
                ) as unknown[];
                const rows = reply.map((entry) => {
                    const [id, fields] = entry as [string, unknown];
                    return { id, fields: Object.fromEntries(pairs(fields)) };
                });
                entries.push(...rows);
                if (rows.length < CHUNK) return entries;
                from = `(${(rows[rows.length - 1] as { id: string }).id}`;
            }
        }
        case 'ReJSON-RL':
            await limiter.take(1, signal);
            return JSON.parse(String(normalizeReply(await client.sendCommand(['JSON.GET', key, '$'])))) as unknown;
        default:
            return null;
    }
};

const parseInfo = (text: string): Record<string, string> =>
    Object.fromEntries(
        text
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith('#') && line.includes(':'))
            .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)])
    );

/** Redis: allowlisted read-only commands, SCAN exports, guard on every command on the wire. */
export class RedisAdapter implements SourceAdapter {
    readonly config: RedisSourceConfig;
    #client: AnyClient | undefined;
    #cluster: ClusterRouter | undefined;
    #nodes: () => Promise<NodeClient[]> = async () => [];

    constructor(config: RedisSourceConfig) {
        this.config = config;
    }

    async init(log: Logger): Promise<void> {
        installRedisWireGuard();
        const c = this.config;
        const credentialsProvider = c.azureAuth
            ? EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
                  credential: new DefaultAzureCredential(),
                  scopes: ['https://redis.azure.com/.default'],
                  tokenManagerConfig: { expirationRefreshRatio: 0.8 },
              })
            : undefined;
        const base = {
            ...(c.username ? { username: c.username } : {}),
            ...(c.password ? { password: c.password } : {}),
            ...(credentialsProvider ? { credentialsProvider } : {}),
            disableClientInfo: true,
            maintNotifications: 'disabled' as const,
        };
        // Raw buffers and Maps: values are decoded by Periscope (UTF-8 or base64), never lossily.
        const commandOptions = {
            typeMapping: {
                [RESP_TYPES.BLOB_STRING]: Buffer,
                [RESP_TYPES.SIMPLE_STRING]: Buffer,
                [RESP_TYPES.VERBATIM_STRING]: Buffer,
                [RESP_TYPES.MAP]: Map,
            },
        };
        const url = c.url ?? `${c.tls ? 'rediss' : 'redis'}://${c.host}:${c.port ?? (c.tls ? 6380 : 6379)}`;
        if (c.cluster) {
            const cluster = createCluster({
                rootNodes: [{ url }],
                defaults: { ...base, commandOptions } as never,
                commandOptions: commandOptions as never,
                useReplicas: c.readFromReplicas,
            });
            this.#client = cluster as unknown as AnyClient;
            this.#cluster = cluster as unknown as ClusterRouter;
            this.#nodes = async () => {
                const nodes = c.readFromReplicas && cluster.replicas.length > 0 ? cluster.replicas : cluster.masters;
                return Promise.all(nodes.map((node) => cluster.nodeClient(node) as unknown as Promise<NodeClient>));
            };
        } else {
            const client = createClient({
                url,
                ...base,
                commandOptions: commandOptions as never,
                ...(c.database !== undefined ? { database: c.database } : {}),
            });
            this.#client = client as unknown as AnyClient;
            this.#nodes = async () => [client as unknown as NodeClient];
        }
        this.#client.on('error', (error) => log.warn({ err: error, source: c.name }, 'redis client error'));
        await this.#client.connect();
    }

    get #clientOrThrow(): AnyClient {
        if (!this.#client) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        return this.#client;
    }

    /** Sends one command; in cluster mode it is routed by its key (or to the first node if it has none). */
    #router(): NodeClient {
        const cluster = this.#cluster;
        if (!cluster) return this.#clientOrThrow;
        return {
            sendCommand: async (args) => {
                const keyless = ['DBSIZE', 'RANDOMKEY'].includes(String(args[0]).toUpperCase());
                if (keyless) return ((await this.#nodes())[0] as NodeClient).sendCommand(args);
                return cluster.sendCommand(args[1], true, args);
            },
        };
    }

    info(): SourceInfo {
        return {
            name: this.config.name,
            type: 'redis',
            description: this.config.description,
            queryLanguage: 'One read-only Redis command (redis-cli syntax)',
            dialectHints: [
                'Examples: HGETALL user:42, ZRANGE leaderboard 0 99 WITHSCORES, XRANGE events - + COUNT 100.',
                'SCAN is iterated to completion: SCAN 0 MATCH session:* COUNT 1000 [TYPE hash]. Add options.values=true to export each key with type, TTL and value.',
                'KEYS, scripts, transactions, blocking and write commands are not available.',
                this.config.cluster ? 'Cluster mode: SCAN covers all shards.' : 'Standalone mode.',
            ],
            options: { values: 'boolean: with SCAN, also fetch type, TTL (ms) and value of every key' },
            params: 'not used (arguments are part of the command)',
            readOnlyLayers: [
                'command allowlist (read-only, non-blocking commands only)',
                'wire guard on every command the client sends',
                ...(this.config.readFromReplicas ? ['reads from replicas, which reject writes'] : []),
            ],
            credential: 'unverified',
            credentialNote: 'Redis ACLs are not inspected; read-only is enforced by Periscope',
        };
    }

    async validate(query: string, _params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const command = parseReadOnlyCommand(query);
        if (opts.values && command.name !== 'SCAN') {
            throw new PeriscopeError('invalid_argument', 'options.values is only supported with SCAN');
        }
        if (command.name === 'SCAN' && this.config.cluster && this.config.database) {
            throw new PeriscopeError('invalid_argument', 'Databases are not supported in cluster mode');
        }
        return { query, params: null, options: opts, plan: command };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const command = prepared.plan as ParsedCommand;
        const client = this.#router();
        const limiter = new OpsLimiter(this.config.maxOpsPerSec);
        if (!/^(H|S|Z)?SCAN$/.test(command.name)) {
            await limiter.take(1, context.signal);
            const rows = replyToRows(command, await client.sendCommand(command.args));
            const single = async function* (): AsyncGenerator<unknown[]> {
                for (let i = 0; i < rows.length; i += 5000) yield rows.slice(i, i + 5000);
            };
            return { format: 'ndjson', batches: single() } satisfies DocumentStream;
        }
        if (command.name !== 'SCAN') return this.#collectionScan(command, client, limiter, context);

        const withValues = prepared.options.values === true;
        const nodes = await this.#nodes();
        const seen = new Set<string>();
        let overflow = false;
        const args = command.args.slice(2);
        const batches = async function* (): AsyncGenerator<unknown[]> {
            for (const node of nodes) {
                let cursor = command.args[1] ?? '0';
                do {
                    if (context.signal.aborted) return;
                    await limiter.take(1, context.signal);
                    const hasCount = args.some((a) => a.toUpperCase() === 'COUNT');
                    const reply = normalizeReply(
                        await node.sendCommand([
                            'SCAN',
                            cursor,
                            ...args,
                            ...(hasCount ? [] : ['COUNT', String(SCAN_COUNT)]),
                        ])
                    ) as [string, string[]];
                    cursor = String(reply[0]);
                    const keys: string[] = [];
                    for (const key of reply[1] ?? []) {
                        if (!overflow) {
                            if (seen.has(key)) continue;
                            if (seen.size >= DEDUPE_LIMIT) overflow = true;
                            else seen.add(key);
                        }
                        keys.push(key);
                    }
                    if (keys.length === 0) continue;
                    if (!withValues) {
                        yield keys.map((key) => ({ key }));
                        continue;
                    }
                    await limiter.take(keys.length * 2, context.signal);
                    const meta = (
                        await Promise.all(
                            keys.flatMap((key) => [node.sendCommand(['TYPE', key]), node.sendCommand(['PTTL', key])])
                        )
                    ).map(normalizeReply);
                    const rows = await Promise.all(
                        keys.map(async (key, i) => {
                            const type = String(meta[2 * i]);
                            const ttl = Number(meta[2 * i + 1]);
                            return {
                                key,
                                type,
                                ttl: ttl >= 0 ? ttl : null,
                                value: await fetchValue(node, key, type, limiter, context.signal),
                            };
                        })
                    );
                    yield rows;
                } while (cursor !== '0');
            }
        };
        return { format: 'ndjson', batches: batches(), mayContainDuplicates: () => overflow } satisfies DocumentStream;
    }

    /** HSCAN/SSCAN/ZSCAN iterated to completion over one key. */
    async #collectionScan(
        command: ParsedCommand,
        client: NodeClient,
        limiter: OpsLimiter,
        context: ExecutionContext
    ): Promise<ResultStream> {
        const [name, key, start = '0', ...rest] = command.args as [string, string, string?, ...string[]];
        const batches = async function* (): AsyncGenerator<unknown[]> {
            let cursor = start;
            do {
                if (context.signal.aborted) return;
                await limiter.take(1, context.signal);
                const reply = normalizeReply(await client.sendCommand([name, key, cursor, ...rest])) as [
                    string,
                    unknown[],
                ];
                cursor = String(reply[0]);
                const items = reply[1] ?? [];
                const upper = name.toUpperCase();
                const rows =
                    upper === 'SSCAN'
                        ? items.map((member) => ({ member }))
                        : upper === 'ZSCAN'
                          ? pairs(items).map(([member, score]) => ({ member, score: toNumber(score) }))
                          : pairs(items).map(([field, value]) => ({ field, value }));
                if (rows.length) yield rows;
            } while (cursor !== '0');
        };
        return { format: 'ndjson', batches: batches() } satisfies DocumentStream;
    }

    async describe(path: string | undefined, _filter: string | undefined): Promise<unknown> {
        const nodes = await this.#nodes();
        const first = nodes[0];
        if (!first) throw new PeriscopeError('internal', 'No Redis node available');
        if (path && !path.endsWith(':') && !path.endsWith('*')) {
            const exists = Number(normalizeReply(await this.#router().sendCommand(['EXISTS', path])));
            if (exists) return this.#describeKey(this.#router(), path);
        }
        const prefix = path ? path.replace(/\*$/, '') : '';
        const counts = new Map<string, { keys: number; types: Set<string> }>();
        const samples: string[] = [];
        let scanned = 0;
        for (const node of nodes) {
            let cursor = '0';
            do {
                const reply = normalizeReply(
                    await node.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', String(SCAN_COUNT)])
                ) as [string, string[]];
                cursor = String(reply[0]);
                for (const key of reply[1] ?? []) {
                    scanned++;
                    const rest = key.slice(prefix.length);
                    const colon = rest.indexOf(':');
                    const group = colon === -1 ? '' : `${prefix}${rest.slice(0, colon + 1)}`;
                    const entry = counts.get(group) ?? { keys: 0, types: new Set<string>() };
                    entry.keys++;
                    if (entry.types.size < 4 && entry.keys <= 20)
                        entry.types.add(String(normalizeReply(await node.sendCommand(['TYPE', key]))));
                    counts.set(group, entry);
                    if (group === '' && samples.length < 50) samples.push(key);
                }
            } while (cursor !== '0' && scanned < DESCRIBE_SAMPLE);
        }
        let server: Record<string, unknown> = {};
        if (!path) {
            const info = parseInfo(String(normalizeReply(await first.sendCommand(['INFO']))));
            server = {
                version: info.redis_version ?? info.valkey_version ?? null,
                mode: info.redis_mode ?? null,
                usedMemory: info.used_memory_human ?? null,
                keyspace: Object.fromEntries(Object.entries(info).filter(([k]) => /^db\d+$/.test(k))),
                nodes: nodes.length,
            };
        }
        return {
            level: path ? 'prefix' : 'server',
            ...(path ? { prefix } : { server }),
            sampledKeys: scanned,
            complete: scanned < DESCRIBE_SAMPLE,
            prefixes: [...counts.entries()]
                .filter(([group]) => group !== '')
                .sort((a, b) => b[1].keys - a[1].keys)
                .slice(0, 200)
                .map(([group, entry]) => ({ prefix: group, keys: entry.keys, types: [...entry.types] })),
            keys: samples,
        };
    }

    async #describeKey(client: NodeClient, key: string): Promise<unknown> {
        const type = String(normalizeReply(await client.sendCommand(['TYPE', key])));
        const ttl = Number(normalizeReply(await client.sendCommand(['PTTL', key])));
        const sizeCommand: Record<string, string> = {
            string: 'STRLEN',
            hash: 'HLEN',
            list: 'LLEN',
            set: 'SCARD',
            zset: 'ZCARD',
            stream: 'XLEN',
        };
        const size = sizeCommand[type]
            ? normalizeReply(await client.sendCommand([sizeCommand[type] as string, key]))
            : null;
        const encoding = normalizeReply(await client.sendCommand(['OBJECT', 'ENCODING', key]).catch(() => null));
        const memory = normalizeReply(await client.sendCommand(['MEMORY', 'USAGE', key]).catch(() => null));
        const groups =
            type === 'stream'
                ? normalizeReply(await client.sendCommand(['XINFO', 'GROUPS', key]).catch(() => null))
                : undefined;
        return {
            level: 'key',
            key,
            type,
            ttlMs: ttl >= 0 ? ttl : null,
            size,
            encoding,
            memoryBytes: memory,
            ...(groups !== undefined ? { consumerGroups: groups } : {}),
        };
    }

    async close(): Promise<void> {
        await this.#client?.close().catch(() => undefined);
    }
}
