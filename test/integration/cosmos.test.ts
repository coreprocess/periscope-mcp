import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CosmosClient } from '@azure/cosmos';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { CosmosSourceConfig } from '../../src/config/sources.ts';
import { WireGuardError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { CosmosAdapter } from '../../src/sources/cosmos/adapter.ts';
import { guardedCosmosHttpClient } from '../../src/sources/cosmos/guard.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

const KEY = 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU9DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';
const ENDPOINT = 'http://127.0.0.1:8081/';

const waitForEmulator = async (client: CosmosClient): Promise<void> => {
    for (let i = 0; i < 90; i++) {
        try {
            await client.databases.readAll().fetchAll();
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    throw new Error('Cosmos emulator did not start');
};

describe('cosmos source', () => {
    let container: StartedTestContainer;
    let admin: CosmosClient;
    let adapter: CosmosAdapter;
    let harness: ResultHarness;

    before(async () => {
        container = await new GenericContainer('mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview')
            .withExposedPorts({ container: 8081, host: 8081 })
            .withCommand(['--protocol', 'http'])
            .start();
        admin = new CosmosClient({
            endpoint: ENDPOINT,
            key: KEY,
            connectionPolicy: { enableEndpointDiscovery: false },
        });
        await waitForEmulator(admin);
        const { database } = await admin.databases.createIfNotExists({ id: 'main' });
        const { container: claims } = await database.containers.createIfNotExists({
            id: 'claims',
            partitionKey: { paths: ['/tenant'] },
        });
        for (let i = 0; i < 2500; i++) {
            await claims.items.create({
                id: `c${i}`,
                tenant: `t${i % 5}`,
                amount: i,
                status: i % 3 === 0 ? 'open' : 'closed',
                nested: { a: i },
            });
        }
        const config: CosmosSourceConfig = {
            index: 0,
            type: 'cosmos',
            name: 'docs',
            description: undefined,
            requiredRole: undefined,
            downloadRole: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            endpoint: ENDPOINT,
            key: KEY,
            azureAuth: false,
            database: 'main',
            maxRuPerSec: undefined,
            lowPriority: false,
        };
        adapter = new CosmosAdapter(config);
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness();
    });

    after(async () => {
        await adapter?.close();
        admin?.dispose();
        await harness?.dispose();
        await container?.stop();
    });

    it('exports cross-partition queries as NDJSON with an inferred schema', async () => {
        const resultId = await harness.run(
            adapter,
            'SELECT * FROM c WHERE c.status = @status ORDER BY c.amount',
            {
                '@status': 'open',
            },
            { container: 'claims' }
        );
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.format, 'ndjson');
        assert.equal(manifest.compression, 'gzip');
        assert.equal(manifest.rowCount, 834);
        const fields = manifest.schema.columns.map((c) => c.name);
        assert.ok(fields.includes('nested.a'));
        const window = await harness.service.readRows(resultId, 0, 3, ['id', 'amount', 'nested.a']);
        assert.deepEqual(window.rows, [
            ['c0', 0, 0],
            ['c3', 3, 3],
            ['c6', 6, 6],
        ]);
    });

    it('supports aggregates and partition keys', async () => {
        const count = await harness.run(adapter, 'SELECT VALUE COUNT(1) FROM c', undefined, {
            container: 'claims',
            partitionKey: 't1',
        });
        const window = await harness.service.readRows(count, 0, 10, undefined);
        assert.deepEqual(window.rows, [[500]]);
    });

    it('blocks every write on the wire, even when called directly on the SDK', async () => {
        const guarded = new CosmosClient({
            endpoint: ENDPOINT,
            key: KEY,
            httpClient: guardedCosmosHttpClient('docs'),
            connectionPolicy: { enableEndpointDiscovery: false },
        });
        const claims = guarded.database('main').container('claims');
        const attempts: [string, () => Promise<unknown>][] = [
            ['create', () => claims.items.create({ id: 'x', tenant: 't0' })],
            ['upsert', () => claims.items.upsert({ id: 'c1', tenant: 't1', amount: -1 })],
            ['replace', () => claims.item('c1', 't1').replace({ id: 'c1', tenant: 't1', amount: -1 })],
            ['patch', () => claims.item('c1', 't1').patch([{ op: 'set', path: '/amount', value: -1 }])],
            ['delete', () => claims.item('c1', 't1').delete()],
            ['batch', () => claims.items.batch([{ operationType: 'Delete', id: 'c1' }], 't1')],
            ['sproc', () => claims.scripts.storedProcedures.create({ id: 'sp', body: 'function(){}' })],
            ['container delete', () => claims.delete()],
            ['database create', () => guarded.databases.create({ id: 'evil' })],
        ];
        for (const [name, attempt] of attempts) {
            await assert.rejects(
                attempt(),
                (error: unknown) => {
                    const message = String((error as Error)?.message ?? error);
                    return error instanceof WireGuardError || /Blocked non-read request/.test(message);
                },
                name
            );
        }
        const { resource } = await admin.database('main').container('claims').item('c1', 't1').read();
        assert.equal(resource?.amount, 1);
        const { resources } = await admin.databases.readAll().fetchAll();
        assert.ok(!resources.some((d) => d.id === 'evil'));
        guarded.dispose();
    });

    it('describes databases, containers and sampled schemas', async () => {
        const databases = (await adapter.describe(undefined, undefined)) as { databases: { id: string }[] };
        assert.ok(databases.databases.some((d) => d.id === 'main'));
        const container = (await adapter.describe('main/claims', undefined)) as {
            partitionKey: { paths: string[] };
            inferredSchema: { name: string }[];
        };
        assert.deepEqual(container.partitionKey.paths, ['/tenant']);
        assert.ok(container.inferredSchema.some((c) => c.name === 'status'));
    });
});
