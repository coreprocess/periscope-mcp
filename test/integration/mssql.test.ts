import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import sql from 'mssql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { MssqlSourceConfig } from '../../src/config/sources.ts';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { MssqlAdapter } from '../../src/sources/mssql/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

// SQL Server 2022 is amd64 only; Azure SQL Edge runs the same engine on arm64.
const IMAGE = process.env.PERISCOPE_TEST_MSSQL_IMAGE ?? 'mcr.microsoft.com/azure-sql-edge:latest';
const SA_PASSWORD = 'Periscope-Test-1';

const SERVER_SETUP = [
    'CREATE DATABASE app',
    "CREATE LOGIN writer WITH PASSWORD = 'Writer-Test-1', CHECK_POLICY = OFF",
    "CREATE LOGIN reader WITH PASSWORD = 'Reader-Test-1', CHECK_POLICY = OFF",
];

const DATABASE_SETUP = [
    'CREATE USER writer FOR LOGIN writer',
    'ALTER ROLE db_owner ADD MEMBER writer',
    'CREATE USER reader FOR LOGIN reader',
    'ALTER ROLE db_datareader ADD MEMBER reader',
    'GRANT VIEW DEFINITION TO reader',
    'GRANT SHOWPLAN TO reader',
    `CREATE TABLE dbo.orders (id int PRIMARY KEY, big bigint, amount decimal(38,10), price money, small smallmoney,
        ratio float, created date, ts datetime2(7), legacy datetime, tsz datetimeoffset(7), at time(7), flag bit,
        name nvarchar(100), notes nvarchar(max), doc varbinary(max), guid uniqueidentifier, x xml)`,
    `WITH n AS (SELECT TOP (12000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_columns a CROSS JOIN sys.all_columns b)
     INSERT INTO dbo.orders SELECT i, CAST(i AS bigint) * 1000000000000, i * 1.25, i * 0.0001, 1.5, i / 4.0,
        DATEADD(day, i, '2024-01-01'), '2024-01-01T12:00:00.1234567', '2024-01-01T12:00:00.123',
        '2024-01-01T12:00:00.5+02:00', '13:14:15.1234567', i % 2, CONCAT('name-', i), REPLICATE('xy', 25),
        0xCAFE, '6F9619FF-8B86-D011-B42D-00CF4FC964FF', '<a>1</a>' FROM n`,
    `INSERT INTO dbo.orders (id, big, amount, price) VALUES
        (-1, 9223372036854775807, -1234567890123456789012345678.1234567891, 922337203685477.5807)`,
    "EXEC sp_addextendedproperty 'MS_Description', 'Customer orders', 'SCHEMA', 'dbo', 'TABLE', 'orders'",
    'CREATE TABLE dbo.audit_log (msg nvarchar(100))',
    'CREATE SEQUENCE dbo.seq START WITH 1',
    'CREATE FUNCTION dbo.f_plain() RETURNS int AS BEGIN RETURN 42 END',
    'CREATE FUNCTION dbo.f_xp() RETURNS int AS BEGIN EXEC master.dbo.xp_msver; RETURN 1 END',
    'CREATE FUNCTION dbo.f_wrap() RETURNS int AS BEGIN RETURN dbo.f_xp() END',
    'CREATE VIEW dbo.v_xp AS SELECT dbo.f_xp() AS x',
    'CREATE VIEW dbo.v_indirect AS SELECT dbo.f_wrap() AS x',
    'CREATE VIEW dbo.v_plain AS SELECT dbo.f_plain() AS x',
];

const ATTACKS = [
    'CREATE TABLE t2 (a int)',
    'DROP TABLE orders',
    'TRUNCATE TABLE orders',
    'ALTER TABLE orders ADD z int',
    'GRANT SELECT ON orders TO public',
    'INSERT INTO orders (id) VALUES (-5)',
    'UPDATE orders SET name = NULL',
    'DELETE FROM orders',
    'MERGE orders AS t USING (SELECT 1 AS id) s ON t.id = s.id WHEN MATCHED THEN DELETE;',
    'SELECT * INTO orders_copy FROM orders',
    'SELECT 1 DELETE FROM orders',
    'SELECT 1; DROP TABLE orders',
    'SELECT 1 SELECT 2',
    "EXEC sp_executesql N'DELETE FROM orders'",
    'EXECUTE xp_msver',
    'xp_msver',
    'WITH x AS (SELECT 1 AS a) DELETE FROM orders',
    'DECLARE @a int',
    'SET NOCOUNT ON',
    'BEGIN TRAN',
    "WAITFOR DELAY '00:00:10'",
    'SELECT NEXT VALUE FOR dbo.seq',
    'SELECT * FROM orders WITH (UPDLOCK)',
    'SELECT * FROM orders WITH (TABLOCKX, HOLDLOCK)',
    "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')",
    "SELECT * FROM OPENQUERY(remote, 'SELECT 1')",
    'SELECT * FROM remote.app.dbo.orders',
    'SELECT dbo.f_xp()',
    'SELECT dbo.f_wrap()',
    'SELECT * FROM dbo.v_xp',
    'SELECT * FROM v_indirect',
    'DBCC CHECKDB',
    'USE master',
    "SELECT 'unterminated",
    'SELECT 1 /* open /* nested */',
];

describe('mssql source', () => {
    let container: StartedTestContainer;
    let admin: sql.ConnectionPool;
    let server: string;
    let port: number;
    let checksum: () => Promise<string>;
    let harness: ResultHarness;
    const adapters = new Map<string, MssqlAdapter>();

    const makeAdapter = async (user: string, password: string, allowRoutines: string[] = []): Promise<MssqlAdapter> => {
        const config: MssqlSourceConfig = {
            index: 0,
            type: 'mssql',
            name: `mssql_${user}`,
            description: undefined,
            maxQueryDurationMs: 120_000,
            maxResultBytes: 1024 ** 3,
            connectionString: undefined,
            host: server,
            port,
            database: 'app',
            user,
            password,
            azureAuth: false,
            encrypt: true,
            trustServerCertificate: true,
            readIntent: false,
            allowRoutines,
            allowLinkedServers: false,
        };
        const adapter = new MssqlAdapter(config);
        await adapter.init(nullLoggers().log);
        adapters.set(`${user}:${allowRoutines.join(',')}`, adapter);
        return adapter;
    };

    before(async () => {
        container = await new GenericContainer(IMAGE)
            .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: SA_PASSWORD })
            .withExposedPorts(1433)
            .withWaitStrategy(
                Wait.forLogMessage(/SQL Server is now ready for client connections/).withStartupTimeout(300_000)
            )
            .start();
        server = container.getHost();
        port = container.getMappedPort(1433);
        const connect = (database: string) =>
            new sql.ConnectionPool({
                server,
                port,
                database,
                user: 'sa',
                password: SA_PASSWORD,
                options: { encrypt: true, trustServerCertificate: true },
            }).connect();
        let master: sql.ConnectionPool | undefined;
        for (let attempt = 0; !master; attempt++) {
            master = await connect('master').catch(async (error: unknown) => {
                if (attempt >= 30) throw error;
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return undefined;
            });
        }
        for (const statement of SERVER_SETUP) await master.request().batch(statement);
        await master.close();
        admin = await connect('app');
        for (const statement of DATABASE_SETUP) await admin.request().batch(statement);
        checksum = async () => {
            const result = await admin.request().query(
                `SELECT (SELECT COUNT(*) FROM dbo.orders) AS orders, (SELECT COUNT(*) FROM dbo.audit_log) AS audit,
                            (SELECT CAST(current_value AS bigint) FROM sys.sequences WHERE name = 'seq') AS seq,
                            (SELECT COUNT(*) FROM sys.objects) AS objects, (SELECT SUM(amount) FROM dbo.orders) AS total`
            );
            return JSON.stringify(result.recordset[0]);
        };
        harness = await createResultHarness({ partBytes: 150_000 });
    });

    after(async () => {
        for (const adapter of adapters.values()) await adapter.close();
        await admin?.close().catch(() => undefined);
        await harness?.dispose();
        await container?.stop();
    });

    it('rejects every attack before execution', async () => {
        const adapter = await makeAdapter('writer', 'Writer-Test-1');
        assert.equal(adapter.info().credential, 'write-capable');
        assert.match(adapter.info().readOnlyLayers.join(' '), /standard/);
        const before = await checksum();
        for (const statement of ATTACKS) {
            await assert.rejects(adapter.validate(statement, {}, {}), QueryRejectedError, statement);
        }
        assert.equal(await checksum(), before);
    });

    it('allows plain functions in standard mode and blocks all unreviewed functions in strict mode', async () => {
        const writer = adapters.get('writer:') as MssqlAdapter;
        await writer.validate('SELECT dbo.f_plain()', {}, {});
        await writer.validate('SELECT * FROM dbo.v_plain', {}, {});
        const strict = await makeAdapter('sa', SA_PASSWORD);
        assert.match(strict.info().readOnlyLayers.join(' '), /strict: sysadmin login/);
        for (const statement of ['SELECT dbo.f_plain()', 'SELECT * FROM dbo.v_plain', 'SELECT * FROM dbo.v_xp']) {
            await assert.rejects(strict.validate(statement, {}, {}), QueryRejectedError, statement);
        }
        const reviewed = await makeAdapter('sa', SA_PASSWORD, ['dbo.f_plain']);
        await reviewed.validate('SELECT * FROM dbo.v_plain', {}, {});
        const reader = await makeAdapter('reader', 'Reader-Test-1');
        assert.equal(reader.info().credential, 'read-only verified');
    });

    it('rolls back writes at the engine when the guard is bypassed', async () => {
        const adapter = adapters.get('writer:') as MssqlAdapter;
        const before = await checksum();
        for (const statement of [
            "INSERT INTO dbo.audit_log VALUES (N'bypass')",
            'UPDATE dbo.orders SET amount = 0',
            'CREATE TABLE dbo.bypass (a int)',
            "INSERT INTO dbo.audit_log VALUES (N'x'); SELECT * FROM dbo.audit_log",
        ]) {
            const resultId = await harness.service.start(
                adapter,
                { query: statement, params: {}, options: {}, plan: { sql: statement, explain: false } },
                { oid: 'attacker', roles: new Set() }
            );
            let snapshot = await harness.service.snapshot(resultId, 10_000);
            while (snapshot.manifest.status === 'running' || snapshot.manifest.status === 'queued') {
                snapshot = await harness.service.snapshot(resultId, 10_000);
            }
            assert.equal(await checksum(), before, statement);
        }
    });

    it('exports with exact decimals, money, bigint and sub-millisecond times', async () => {
        const adapter = adapters.get('reader:') as MssqlAdapter;
        const resultId = await harness.run(adapter, 'SELECT * FROM dbo.orders ORDER BY id;');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, 12_001);
        assert.ok(manifest.files.length >= 2);
        const types = Object.fromEntries(manifest.schema.columns.map((c) => [c.name, c.parquetType]));
        assert.equal(types.amount, 'DECIMAL(38,10)');
        assert.equal(types.price, 'DECIMAL(19,4)');
        assert.equal(types.small, 'DECIMAL(10,4)');
        assert.equal(types.big, 'INT64');
        assert.equal(types.ts, 'TIMESTAMP(MICROS, local)');
        assert.equal(types.tsz, 'TIMESTAMP(MICROS, UTC)');
        assert.equal(types.doc, 'BINARY');
        const read = async (offset: number) => {
            const window = await harness.service.readRows(resultId, offset, 1, undefined);
            return Object.fromEntries(window.columns.map((c, i) => [c, window.rows[0]?.[i]]));
        };
        const extreme = await read(0);
        assert.equal(extreme.big, '9223372036854775807');
        assert.equal(extreme.amount, '-1234567890123456789012345678.1234567891');
        assert.equal(extreme.price, '922337203685477.5807');
        const row = await read(3);
        assert.equal(row.id, 3);
        assert.equal(row.big, 3000000000000);
        assert.equal(row.amount, '3.7500000000');
        assert.equal(row.price, '0.0003');
        assert.equal(row.created, '2024-01-04');
        assert.equal(row.ts, '2024-01-01T12:00:00.123456');
        assert.equal(row.legacy, '2024-01-01T12:00:00.123000');
        assert.equal(row.tsz, '2024-01-01T10:00:00.500000Z');
        assert.equal(row.at, '13:14:15.1234567');
        assert.equal(row.flag, true);
        assert.equal(row.guid, '6F9619FF-8B86-D011-B42D-00CF4FC964FF');
        assert.equal(row.notes, 'xy'.repeat(25));
    });

    it('binds parameters and explains plans', async () => {
        const adapter = adapters.get('reader:') as MssqlAdapter;
        const bound = await harness.run(
            adapter,
            'SELECT id FROM dbo.orders WHERE id BETWEEN @lo AND @hi AND name LIKE @p',
            {
                lo: 1,
                hi: 3,
                p: 'name-%',
            }
        );
        assert.equal((await harness.service.snapshot(bound)).manifest.rowCount, 3);
        const explained = await harness.run(
            adapter,
            'SELECT * FROM dbo.orders WHERE id = @id',
            { id: 1 },
            { explain: true }
        );
        const plan = await harness.service.readRows(explained, 0, 100, undefined);
        assert.ok(
            plan.rows.some((r) => /Clustered Index Seek/.test(String(r[0]))),
            JSON.stringify(plan.rows)
        );
        await assert.rejects(adapter.validate('SELECT @x', [1], {}), /params must be an object/);
    });

    it('cancels a running export and frees the connection', async () => {
        const adapter = adapters.get('reader:') as MssqlAdapter;
        const prepared = await adapter.validate(
            'SELECT a.id, b.name FROM dbo.orders a CROSS JOIN dbo.orders b',
            {},
            {}
        );
        const resultId = await harness.service.start(adapter, prepared, { oid: 'test', roles: new Set() });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await harness.service.cancel(resultId);
        let snapshot = await harness.service.snapshot(resultId, 10_000);
        while (snapshot.manifest.status === 'running') snapshot = await harness.service.snapshot(resultId, 10_000);
        assert.equal(snapshot.manifest.status, 'cancelled');
        const after = await harness.run(adapter, 'SELECT COUNT(*) AS n FROM dbo.orders');
        assert.equal((await harness.service.readRows(after, 0, 1, undefined)).rows[0]?.[0], 12_001);
    });

    it('describes schemas, objects and columns', async () => {
        const adapter = adapters.get('reader:') as MssqlAdapter;
        const schemas = (await adapter.describe(undefined, undefined)) as { schemas: { name: string }[] };
        assert.ok(schemas.schemas.some((s) => s.name === 'dbo'));
        const objects = (await adapter.describe('dbo', 'ord*')) as { objects: { name: string; comment: string }[] };
        assert.deepEqual(
            objects.objects.map((o) => [o.name, o.comment]),
            [['orders', 'Customer orders']]
        );
        const table = (await adapter.describe('dbo.orders', undefined)) as {
            columns: { name: string }[];
            keys: { kind: string }[];
        };
        assert.ok(table.columns.some((c) => c.name === 'tsz'));
        assert.equal(table.keys[0]?.kind, 'PRIMARY_KEY_CONSTRAINT');
        const view = (await adapter.describe('dbo.v_plain', undefined)) as { viewDefinition: string };
        assert.match(view.viewDefinition, /f_plain/);
    });
});
