import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createClient } from '@redis/client';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { RedisSourceConfig } from '../../src/config/sources.ts';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { RedisAdapter } from '../../src/sources/redis/adapter.ts';
import { tokenize } from '../../src/sources/redis/guard.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

const ATTACKS = [
    'SET a 1',
    'DEL a',
    'GETEX str:1 EX 10',
    'GETDEL str:1',
    'GETSET str:1 x',
    'SPOP set:1',
    'LPOP big:list',
    'RPOP big:list',
    'ZPOPMIN zset:1',
    'PFCOUNT hll:1',
    'TOUCH str:1',
    'KEYS *',
    'SORT big:list STORE x',
    'SORT big:list',
    'GEORADIUS geo 0 0 100 km STORE x',
    'GEOSEARCHSTORE x geo FROMLONLAT 0 0 BYRADIUS 1 km',
    'ZRANGESTORE x zset:1 0 -1',
    'XREADGROUP GROUP g c STREAMS events >',
    'XREAD BLOCK 0 STREAMS events $',
    'XREAD STREAMS events 0',
    'BLPOP big:list 0',
    'EVAL "return redis.call(\'del\', KEYS[1])" 1 str:1',
    'EVAL_RO "return 1" 0',
    'FCALL_RO f 0',
    'MULTI',
    'EXEC',
    'FLUSHALL',
    'FLUSHDB',
    'CONFIG SET maxmemory 1',
    'CLIENT KILL TYPE normal',
    'SUBSCRIBE c',
    'MONITOR',
    'SELECT 1',
    'SCRIPT FLUSH',
    'DEBUG SLEEP 1',
    'GET a\nDEL a',
    '"SET" k v',
    "'DEL' k",
    'XGROUP CREATE events g $',
    'XAUTOCLAIM events g c 0 0',
    'OBJECT HELP',
];

describe('redis source', () => {
    let container: StartedTestContainer;
    let adapter: RedisAdapter;
    let harness: ResultHarness;
    let url: string;
    const writesSinceSave = async (): Promise<number> => {
        const { output } = await container.exec(['redis-cli', '-a', 'pw', '--no-auth-warning', 'INFO', 'persistence']);
        return Number(/rdb_changes_since_last_save:(\d+)/.exec(output)?.[1]);
    };

    before(async () => {
        container = await new GenericContainer('redis:8')
            .withCommand(['redis-server', '--requirepass', 'pw', '--save', ''])
            .withExposedPorts(6379)
            .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
            .start();
        url = `redis://default:pw@${container.getHost()}:${container.getMappedPort(6379)}`;
        // Seed before the adapter installs the process-wide wire guard.
        const seed = createClient({ url });
        await seed.connect();
        for (let i = 0; i < 300; i++) await seed.set(`str:${i}`, `value-${i}`);
        await seed.hSet('user:1', { name: 'Ada', role: 'admin' });
        await seed.hSet('user:2', { name: 'Linus', role: 'dev' });
        await seed.rPush(
            'big:list',
            Array.from({ length: 2500 }, (_, i) => `item-${i}`)
        );
        await seed.sAdd('set:1', ['a', 'b', 'c']);
        await seed.zAdd('zset:1', [
            { score: 1, value: 'x' },
            { score: 2.5, value: 'y' },
        ]);
        await seed.pfAdd('hll:1', ['a', 'b']);
        await seed.xAdd('events', '*', { kind: 'created', id: '1' });
        await seed.xAdd('events', '*', { kind: 'updated', id: '1' });
        await seed.sendCommand(['JSON.SET', 'doc:1', '$', '{"a":1,"b":[1,2]}']);
        await seed.set('bin:1', Buffer.from([0xff, 0x00, 0xfe]));
        await seed.expire('str:0', 3600);
        await seed.sendCommand(['SAVE']);
        await seed.close();

        const config: RedisSourceConfig = {
            index: 0,
            type: 'redis',
            name: 'cache',
            description: undefined,
            requiredRole: undefined,
            downloadRole: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            url,
            host: undefined,
            port: undefined,
            username: undefined,
            password: undefined,
            tls: false,
            azureAuth: false,
            database: undefined,
            cluster: false,
            readFromReplicas: false,
            maxOpsPerSec: undefined,
        };
        adapter = new RedisAdapter(config);
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness();
    });

    after(async () => {
        await adapter?.close();
        await harness?.dispose();
        await container?.stop();
    });

    it('tokenizes redis-cli syntax', () => {
        assert.deepEqual(tokenize('HGET "user:1" \'name\''), ['HGET', 'user:1', 'name']);
        assert.deepEqual(tokenize('GET "a\\x41\\n"'), ['GET', 'aA\n']);
        assert.throws(() => tokenize('GET "open'), QueryRejectedError);
    });

    it('rejects every write, blocking or scripted command', async () => {
        for (const command of ATTACKS) {
            await assert.rejects(adapter.validate(command, null, {}), QueryRejectedError, command);
        }
    });

    it('blocks non-allowlisted commands on the wire, for any client in the process', async () => {
        const client = createClient({ url });
        await assert.rejects(
            client.connect().then(() => client.set('a', '1')),
            /blocked by the read-only guard/
        );
        await client.close().catch(() => undefined);
        assert.equal(await writesSinceSave(), 0);
    });

    it('runs single commands and shapes their replies', async () => {
        const hash = await harness.run(adapter, 'HGETALL user:1');
        assert.deepEqual((await harness.service.readRows(hash, 0, 10, ['field', 'value'])).rows.sort(), [
            ['name', 'Ada'],
            ['role', 'admin'],
        ]);
        const zset = await harness.run(adapter, 'ZRANGE zset:1 0 -1 WITHSCORES');
        assert.deepEqual((await harness.service.readRows(zset, 0, 10, ['member', 'score'])).rows, [
            ['x', 1],
            ['y', 2.5],
        ]);
        const stream = await harness.run(adapter, 'XRANGE events - +');
        const events = await harness.service.readRows(stream, 0, 10, ['fields']);
        assert.deepEqual(events.rows[1], [{ kind: 'updated', id: '1' }]);
    });

    it('exports keys with types, TTLs and complete values via SCAN', async () => {
        const resultId = await harness.run(adapter, 'SCAN 0 MATCH * COUNT 100', null, { values: true });
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, 300 + 2 + 7);
        const rows = await harness.service.readRows(resultId, 0, 500, ['key', 'type', 'ttl', 'value']);
        const byKey = new Map(rows.rows.map((r) => [r[0], r]));
        assert.equal(String(byKey.get('big:list')?.[3]).startsWith('['), true, 'large list is summarized in windows');
        assert.deepEqual(byKey.get('doc:1')?.[3], [{ a: 1, b: [1, 2] }]);
        assert.deepEqual(byKey.get('bin:1')?.[3], { encoding: 'base64', data: '/wD+' });
        assert.ok(Number(byKey.get('str:0')?.[2]) > 0);
        assert.equal(await writesSinceSave(), 0);
    });

    it('describes prefixes and keys', async () => {
        const server = (await adapter.describe(undefined, undefined)) as {
            prefixes: { prefix: string; keys: number }[];
        };
        assert.equal(server.prefixes.find((p) => p.prefix === 'str:')?.keys, 300);
        const key = (await adapter.describe('events', undefined)) as { type: string; size: number };
        assert.equal(key.type, 'stream');
        assert.equal(key.size, 2);
    });
});
