import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { PostgresSourceConfig } from '../../src/config/sources.ts';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { PostgresAdapter } from '../../src/sources/postgres/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

const SETUP = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE orders (
    id bigint PRIMARY KEY, amount numeric(14,2), ratio numeric, created timestamptz, local_ts timestamp,
    day date, doc jsonb, tags int[], big_tags bigint[], blob bytea, name text, flag boolean, embedding vector(3)
);
INSERT INTO orders
SELECT i, (i * 1.25)::numeric(14,2), i / 3.0, '2024-01-01 00:00:00.123456+00'::timestamptz + i * interval '1 second',
       '2024-01-01 12:00:00.5'::timestamp, '2024-01-01'::date + i, jsonb_build_object('i', i, 'big', 12345678901234567890),
       ARRAY[i, i + 1], ARRAY[9007199254740993::bigint], decode('00ff', 'hex'), 'name-' || i, i % 2 = 0, '[1,2,3]'
FROM generate_series(1, 30000) AS i;
CREATE SEQUENCE seq;
CREATE FUNCTION write_it() RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO orders(id) VALUES (-1); RETURN 1; END $$;
CREATE VIEW advisory_view AS SELECT pg_try_advisory_lock(42) AS locked;
CREATE ROLE app LOGIN PASSWORD 'app';
GRANT ALL ON ALL TABLES IN SCHEMA public TO app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app;
GRANT EXECUTE ON FUNCTION write_it() TO app;
`;

const ATTACKS = [
    'INSERT INTO orders(id) VALUES (-2)',
    'UPDATE orders SET name = NULL',
    'DELETE FROM orders',
    'TRUNCATE orders',
    'DROP TABLE orders',
    'CREATE TABLE t2 (a int)',
    'SELECT 1; DELETE FROM orders',
    'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
    'WITH x AS (UPDATE orders SET name = $$x$$ RETURNING *) SELECT 1',
    'SELECT * INTO t3 FROM orders',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT * FROM (SELECT * FROM orders FOR SHARE) s',
    "SELECT nextval('seq')",
    "SELECT setval('seq', 100)",
    'SELECT pg_advisory_lock(1)',
    "SELECT pg_notify('c', 'x')",
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    'SELECT pg_terminate_backend(1)',
    'SELECT lo_create(0)',
    'SELECT * FROM advisory_view',
    "SELECT query_to_xml('DELETE FROM orders RETURNING id', true, false, '')",
    "SELECT query_to_xml('SELECT pg_terminate_backend(pid) FROM pg_stat_activity', true, false, '')",
    "SELECT table_to_xml('advisory_view', true, false, '')",
    "SELECT ts_stat('SELECT to_tsvector(name) FROM orders WHERE pg_advisory_lock(1) IS NULL')",
    'SELECT pg_stat_statements_reset()',
    'COPY orders TO STDOUT',
    'CALL some_proc()',
    'DO $$ BEGIN DELETE FROM orders; END $$',
    'SET default_transaction_read_only = off',
    'EXPLAIN ANALYZE DELETE FROM orders',
    'BEGIN',
    'COMMIT',
];

describe('postgres source', () => {
    let container: StartedTestContainer;
    let admin: pg.Client;
    let adapter: PostgresAdapter;
    let harness: ResultHarness;
    let checksum: () => Promise<string>;

    before(async () => {
        container = await new GenericContainer('pgvector/pgvector:pg17')
            .withEnvironment({ POSTGRES_PASSWORD: 'pw' })
            .withExposedPorts(5432)
            .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
            .start();
        const url = `postgres://postgres:pw@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
        admin = new pg.Client({ connectionString: url });
        await admin.connect();
        await admin.query(SETUP);
        checksum = async () =>
            (
                await admin.query(
                    "SELECT md5(string_agg(o::text, ',' ORDER BY id)) || (SELECT last_value FROM seq)::text AS h FROM orders o"
                )
            ).rows[0].h;
        const config: PostgresSourceConfig = {
            index: 0,
            type: 'postgres',
            name: 'pg',
            description: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            url: `postgres://app:app@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
            host: undefined,
            port: undefined,
            database: undefined,
            user: undefined,
            password: undefined,
            azureAuth: false,
            ssl: 'disable',
            searchPath: undefined,
            allowRoutines: [],
        };
        adapter = new PostgresAdapter(config);
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness({ partBytes: 200_000 });
    });

    after(async () => {
        await adapter?.close();
        await admin?.end();
        await harness?.dispose();
        await container?.stop();
    });

    it('reports a write-capable credential as information only', () => {
        const info = adapter.info();
        assert.equal(info.credential, 'write-capable');
        assert.equal(info.type, 'postgres');
    });

    it('rejects every write attempt in the corpus before execution', async () => {
        const before = await checksum();
        for (const sql of ATTACKS) {
            await assert.rejects(adapter.validate(sql, [], {}), QueryRejectedError, `should reject: ${sql}`);
        }
        assert.equal(await checksum(), before);
    });

    it('blocks writes at the engine even if the guard is bypassed', async () => {
        const before = await checksum();
        for (const sql of ['INSERT INTO orders(id) VALUES (-3)', "SELECT nextval('seq')", 'SELECT write_it()']) {
            const resultId = await harness.service.start(
                adapter,
                { query: sql, params: [], options: {}, plan: { sql } },
                {
                    oid: 'attacker',
                    roles: new Set(),
                }
            );
            let snapshot = await harness.service.snapshot(resultId, 10_000);
            while (snapshot.manifest.status === 'running') snapshot = await harness.service.snapshot(resultId, 10_000);
            assert.equal(snapshot.manifest.status, 'failed', sql);
            assert.match(snapshot.manifest.error?.message ?? '', /read-only transaction/);
        }
        assert.equal(await checksum(), before);
    });

    it('exports a query with exact types into parts and reads windows', async () => {
        const resultId = await harness.run(adapter, 'SELECT * FROM orders ORDER BY id');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.format, 'parquet');
        assert.equal(manifest.rowCount, 30_000);
        assert.ok(manifest.files.length >= 2, 'small part size forces several parts');
        const types = Object.fromEntries(manifest.schema.columns.map((c) => [c.name, c.parquetType]));
        assert.equal(types.amount, 'DECIMAL(14,2)');
        assert.equal(types.ratio, 'STRING');
        assert.equal(types.created, 'TIMESTAMP(MICROS, UTC)');
        assert.equal(types.embedding, 'LIST<DOUBLE>');
        assert.equal(types.doc, 'STRING (JSON)');

        const window = await harness.service.readRows(resultId, 0, 2, undefined);
        const row = Object.fromEntries(window.columns.map((c, i) => [c, window.rows[0]?.[i]]));
        assert.equal(row.amount, '1.25');
        assert.equal(row.created, '2024-01-01T00:00:01.123456Z');
        assert.equal(row.local_ts, '2024-01-01T12:00:00.500000');
        assert.equal(row.day, '2024-01-02');
        assert.deepEqual(row.tags, [1, 2]);
        assert.deepEqual(row.big_tags, ['9007199254740993']);
        assert.deepEqual(row.embedding, [1, 2, 3]);

        const deep = await harness.service.readRows(resultId, 29_998, 10, ['id', 'name']);
        assert.deepEqual(deep.rows, [
            [29_999, 'name-29999'],
            [30_000, 'name-30000'],
        ]);
        assert.equal(deep.nextOffset, null);
    });

    it('supports parameters and explain', async () => {
        const resultId = await harness.run(adapter, 'SELECT id FROM orders WHERE id <= $1', [3]);
        assert.equal((await harness.service.snapshot(resultId)).manifest.rowCount, 3);
        const explained = await harness.run(adapter, 'SELECT * FROM orders WHERE id = 1', [], { explain: true });
        const plan = await harness.service.readRows(explained, 0, 50, undefined);
        assert.match(String(plan.rows[0]?.[0]), /Index Scan|Seq Scan/);
    });

    it('switches to strict mode when dblink is reachable and blocks wrappers and their views', async () => {
        await admin.query('CREATE DATABASE strictdb');
        const strictUrl = `postgres://postgres:pw@${container.getHost()}:${container.getMappedPort(5432)}/strictdb`;
        const strictAdmin = new pg.Client({ connectionString: strictUrl });
        await strictAdmin.connect();
        await strictAdmin.query(`
            CREATE EXTENSION dblink;
            CREATE TABLE target (a int);
            CREATE FUNCTION harmless() RETURNS int LANGUAGE sql AS 'SELECT 1';
            CREATE FUNCTION sneaky() RETURNS text LANGUAGE plpgsql AS $$
                BEGIN RETURN dblink_exec('dbname=strictdb user=postgres password=pw', 'INSERT INTO target VALUES (1)'); END $$;
            CREATE VIEW sneaky_view AS SELECT sneaky() AS s;
            CREATE VIEW indirect_view AS SELECT * FROM sneaky_view;
            GRANT SELECT ON ALL TABLES IN SCHEMA public TO app;`);
        const strict = new PostgresAdapter({
            ...adapter.config,
            name: 'strict',
            url: `postgres://app:app@${container.getHost()}:${container.getMappedPort(5432)}/strictdb`,
        } as PostgresSourceConfig);
        await strict.init(nullLoggers().log);
        try {
            assert.match(strict.info().readOnlyLayers.join(' '), /strict/);
            for (const sql of [
                'SELECT sneaky()',
                'SELECT * FROM sneaky_view',
                'SELECT * FROM indirect_view',
                'SELECT harmless()',
            ]) {
                await assert.rejects(strict.validate(sql, [], {}), QueryRejectedError, sql);
            }
            const allowed = new PostgresAdapter({
                ...strict.config,
                name: 'allowed',
                allowRoutines: ['public.harmless'],
            } as PostgresSourceConfig);
            await allowed.init(nullLoggers().log);
            await allowed.validate('SELECT harmless()', [], {});
            await allowed.close();
            assert.equal((await strictAdmin.query('SELECT count(*)::int AS n FROM target')).rows[0].n, 0);
        } finally {
            await strict.close();
            await strictAdmin.end();
        }
    });

    it('describes schemas, relations and columns', async () => {
        const schemas = (await adapter.describe(undefined, undefined)) as { schemas: { schema: string }[] };
        assert.ok(schemas.schemas.some((s) => s.schema === 'public'));
        const relation = (await adapter.describe('public.orders', undefined)) as { columns: { name: string }[] };
        assert.ok(relation.columns.some((c) => c.name === 'embedding'));
    });
});
