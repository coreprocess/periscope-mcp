import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import oracledb from 'oracledb';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { OracleSourceConfig } from '../../src/config/sources.ts';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { OracleAdapter } from '../../src/sources/oracle/adapter.ts';
import { useThickDriver } from '../../src/sources/oracle/driver.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

// PERISCOPE_TEST_ORACLE_DRIVER=thick runs every case through Oracle's client libraries (Instant Client on the
// library path), as PERISCOPE_ORACLE_DRIVER=thick does in the image.
if (process.env.PERISCOPE_TEST_ORACLE_DRIVER === 'thick') useThickDriver();

const IMAGE = process.env.PERISCOPE_TEST_ORACLE_IMAGE ?? 'gvenzl/oracle-free:23-slim';
const SERVICE = IMAGE.includes('oracle-xe') ? 'XEPDB1' : 'FREEPDB1';

const SETUP = [
    `CREATE TABLE orders (id NUMBER(10) PRIMARY KEY, amount NUMBER(14,2), ratio NUMBER, flt BINARY_DOUBLE,
        created DATE, ts TIMESTAMP(6), tstz TIMESTAMP(6) WITH TIME ZONE, name VARCHAR2(100), notes CLOB, raw_id RAW(8), doc BLOB)`,
    `INSERT INTO orders SELECT LEVEL, LEVEL * 1.25, LEVEL / 3, LEVEL / 4, DATE '2024-01-01' + LEVEL,
        TIMESTAMP '2024-01-01 12:00:00.123456', TIMESTAMP '2024-01-01 12:00:00.5 +02:00', 'name-' || LEVEL,
        RPAD('x', 50, 'y'), HEXTORAW('00FF'), HEXTORAW('CAFE') FROM dual CONNECT BY LEVEL <= 12000`,
    `CREATE TABLE audit_log (msg VARCHAR2(100))`,
    `CREATE SEQUENCE seq`,
    `CREATE OR REPLACE FUNCTION f_plain RETURN NUMBER IS BEGIN RETURN 42; END;`,
    `CREATE OR REPLACE FUNCTION f_auto RETURN NUMBER IS PRAGMA AUTONOMOUS_TRANSACTION;
        BEGIN INSERT INTO audit_log VALUES ('auto'); COMMIT; RETURN 1; END;`,
    `CREATE OR REPLACE FUNCTION f_dyn RETURN NUMBER IS BEGIN EXECUTE IMMEDIATE 'SELECT 1 FROM dual'; RETURN 1; END;`,
    `CREATE OR REPLACE FUNCTION f_wrap RETURN NUMBER IS BEGIN RETURN f_auto; END;`,
    `CREATE OR REPLACE PACKAGE pkg AS FUNCTION f RETURN NUMBER; END;`,
    `CREATE OR REPLACE PACKAGE BODY pkg AS FUNCTION f RETURN NUMBER IS PRAGMA AUTONOMOUS_TRANSACTION;
        BEGIN INSERT INTO audit_log VALUES ('pkg'); COMMIT; RETURN 1; END; END;`,
    `CREATE OR REPLACE VIEW v_auto AS SELECT f_auto AS x FROM dual`,
    `CREATE OR REPLACE VIEW v_indirect AS SELECT f_wrap AS x FROM dual`,
    `CREATE OR REPLACE VIEW v_plain AS SELECT f_plain AS x FROM dual`,
];

const ATTACKS = [
    'CREATE TABLE t2 (a NUMBER)',
    'DROP TABLE orders',
    'SELECT 1 FROM dual --c\u2028DROP TABLE orders',
    'TRUNCATE TABLE orders',
    'ALTER TABLE orders ADD (z NUMBER)',
    'RENAME orders TO orders2',
    'GRANT SELECT ON orders TO PUBLIC',
    'FLASHBACK TABLE orders TO BEFORE DROP',
    'PURGE RECYCLEBIN',
    "COMMENT ON TABLE orders IS 'x'",
    'ANALYZE TABLE orders COMPUTE STATISTICS',
    'INSERT INTO orders (id) VALUES (-1)',
    'UPDATE orders SET name = NULL',
    'DELETE FROM orders',
    'MERGE INTO orders o USING dual ON (1 = 0) WHEN NOT MATCHED THEN INSERT (id) VALUES (-2)',
    'BEGIN NULL; END;',
    'DECLARE x NUMBER; BEGIN NULL; END;',
    'CALL dbms_output.put_line(1)',
    'SELECT 1 FROM dual; DROP TABLE orders',
    "SELECT 'a' FROM dual; DELETE FROM orders",
    'WITH FUNCTION f RETURN NUMBER IS PRAGMA AUTONOMOUS_TRANSACTION; BEGIN INSERT INTO audit_log VALUES (1); COMMIT; RETURN 1; END; SELECT f FROM dual',
    'SELECT * FROM orders FOR UPDATE',
    'SELECT seq.NEXTVAL FROM dual',
    'SELECT f_auto FROM dual',
    'SELECT f_auto() FROM dual',
    'SELECT * FROM v_auto',
    'SELECT * FROM v_indirect',
    'SELECT f_wrap FROM dual',
    'SELECT pkg.f FROM dual',
    'SELECT f_dyn FROM dual',
    "SELECT DBMS_PIPE.SEND_MESSAGE('x') FROM dual",
    "SELECT UTL_HTTP.REQUEST('http://example.com') FROM dual",
    'SELECT sys.dbms_lock.request(1) FROM dual',
    'SELECT * FROM orders@remote',
    "SELECT 'unterminated FROM dual",
    'SELECT 1 FROM dual /* unterminated',
];

describe('oracle source', () => {
    let container: StartedTestContainer;
    let admin: oracledb.Connection;
    let host: string;
    let checksum: () => Promise<string>;
    let harness: ResultHarness;
    const adapters: OracleAdapter[] = [];

    const makeAdapter = async (
        user: string,
        password: string,
        allowRoutines: string[] = []
    ): Promise<OracleAdapter> => {
        const config: OracleSourceConfig = {
            index: 0,
            type: 'oracle',
            name: `ora_${user.toLowerCase()}`,
            description: undefined,
            maxQueryDurationMs: 120_000,
            maxResultBytes: 1024 ** 3,
            connectString: `${host}/${SERVICE}`,
            user,
            password,
            allowRoutines,
            allowDbLinks: false,
        };
        const adapter = new OracleAdapter(config);
        await adapter.init(nullLoggers().log);
        adapters.push(adapter);
        return adapter;
    };

    before(async () => {
        container = await new GenericContainer(IMAGE)
            .withEnvironment({ ORACLE_PASSWORD: 'pw', APP_USER: 'app', APP_USER_PASSWORD: 'app' })
            .withExposedPorts(1521)
            .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE/).withStartupTimeout(600_000))
            .start();
        host = `${container.getHost()}:${container.getMappedPort(1521)}`;
        const app = await oracledb.getConnection({ user: 'app', password: 'app', connectString: `${host}/${SERVICE}` });
        for (const statement of SETUP) await app.execute(statement);
        await app.commit();
        await app.close();
        // Read-only transactions refuse tables whose definition changed moments before (ORA-01466).
        await new Promise((resolve) => setTimeout(resolve, 8000));
        admin = await oracledb.getConnection({ user: 'system', password: 'pw', connectString: `${host}/${SERVICE}` });
        for (const statement of [
            'CREATE USER cat IDENTIFIED BY cat',
            'GRANT CREATE SESSION, SELECT_CATALOG_ROLE TO cat',
            'GRANT SELECT ON app.orders TO cat',
            'GRANT EXECUTE ON app.f_plain TO cat',
            'GRANT EXECUTE ON app.f_auto TO cat',
            'GRANT SELECT ON app.v_plain TO cat',
            'GRANT SELECT ON app.v_auto TO cat',
            'GRANT SELECT ANY DICTIONARY TO cat',
        ]) {
            await admin.execute(statement);
        }
        checksum = async () => {
            const result = await admin.execute<[number, number, number, number]>(
                `SELECT (SELECT COUNT(*) FROM app.orders), (SELECT COUNT(*) FROM app.audit_log),
                        (SELECT last_number FROM all_sequences WHERE sequence_owner = 'APP' AND sequence_name = 'SEQ'),
                        (SELECT COUNT(*) FROM all_objects WHERE owner = 'APP') FROM dual`
            );
            return JSON.stringify(result.rows?.[0]);
        };
        harness = await createResultHarness({ partBytes: 150_000 });
    });

    after(async () => {
        for (const adapter of adapters) await adapter.close();
        await admin?.close().catch(() => undefined);
        await harness?.dispose();
        await container?.stop();
    });

    it('rejects every attack before execution (conservative inventory)', async () => {
        const adapter = await makeAdapter('app', 'app');
        assert.match(adapter.info().readOnlyLayers.join(' '), /conservative/);
        assert.equal(adapter.info().credential, 'write-capable');
        const before = await checksum();
        for (const sql of ATTACKS) {
            await assert.rejects(adapter.validate(sql, [], {}), QueryRejectedError, sql);
        }
        await assert.rejects(adapter.validate('SELECT f_plain FROM dual', [], {}), QueryRejectedError);
        assert.equal(await checksum(), before);
    });

    it('allows reviewed routines and uses precise analysis with catalog access', async () => {
        const allowed = await makeAdapter('app', 'app', ['APP.F_PLAIN']);
        await allowed.validate('SELECT f_plain FROM dual', [], {});
        await allowed.validate('SELECT * FROM v_plain', [], {});
        const precise = await makeAdapter('cat', 'cat');
        assert.match(precise.info().readOnlyLayers.join(' '), /precise/);
        await precise.validate('SELECT app.f_plain FROM dual', [], {});
        await precise.validate('SELECT * FROM app.v_plain', [], {});
        for (const sql of ['SELECT app.f_auto FROM dual', 'SELECT * FROM app.v_auto', 'SELECT app.pkg.f FROM dual']) {
            await assert.rejects(precise.validate(sql, [], {}), QueryRejectedError, sql);
        }
    });

    it('blocks DML at the engine when the guard is bypassed', async () => {
        const adapter = adapters[0] as OracleAdapter;
        const before = await checksum();
        const sql = 'INSERT INTO orders (id) VALUES (-5)';
        const resultId = await harness.service.start(
            adapter,
            { query: sql, params: [], options: {}, plan: { sql, explain: false } },
            { oid: 'attacker', roles: new Set() }
        );
        let snapshot = await harness.service.snapshot(resultId, 10_000);
        while (snapshot.manifest.status === 'running') snapshot = await harness.service.snapshot(resultId, 10_000);
        assert.equal(snapshot.manifest.status, 'failed');
        assert.match(snapshot.manifest.error?.message ?? '', /ORA-01456|read-only/i);
        assert.equal(await checksum(), before);
    });

    it('exports with exact numbers, dates and LOBs', async () => {
        const adapter = adapters[0] as OracleAdapter;
        const resultId = await harness.run(adapter, 'SELECT * FROM orders ORDER BY id;');
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, 12_000);
        assert.ok(manifest.files.length >= 2);
        const types = Object.fromEntries(manifest.schema.columns.map((c) => [c.name, c.parquetType]));
        assert.equal(types.AMOUNT, 'DECIMAL(14,2)');
        assert.equal(types.ID, 'DECIMAL(10,0)');
        assert.equal(types.RATIO, 'STRING');
        assert.equal(types.CREATED, 'TIMESTAMP(MICROS, local)');
        assert.equal(types.TSTZ, 'TIMESTAMP(MICROS, UTC)');
        assert.equal(types.DOC, 'BINARY');
        const window = await harness.service.readRows(resultId, 2, 1, undefined);
        const row = Object.fromEntries(window.columns.map((c, i) => [c, window.rows[0]?.[i]]));
        assert.equal(row.ID, '3');
        assert.equal(row.AMOUNT, '3.75');
        assert.equal(row.RATIO, '1');
        assert.equal(row.CREATED, '2024-01-04T00:00:00.000000');
        assert.equal(row.TS, '2024-01-01T12:00:00.123000');
        assert.equal(row.TSTZ, '2024-01-01T10:00:00.500000Z');
        assert.equal(row.NOTES, 'x'.padEnd(50, 'y'));
    });

    it('binds parameters and explains plans with catalog access', async () => {
        const adapter = adapters[0] as OracleAdapter;
        const bound = await harness.run(adapter, 'SELECT id FROM orders WHERE id <= :max', { max: 3 });
        assert.equal((await harness.service.snapshot(bound)).manifest.rowCount, 3);
        const precise = adapters.find((a) => a.config.user === 'cat') as OracleAdapter;
        const explained = await harness.run(precise, 'SELECT * FROM app.orders WHERE id = 1', [], { explain: true });
        const plan = await harness.service.readRows(explained, 0, 100, undefined);
        assert.ok(
            plan.rows.some((r) => /INDEX UNIQUE SCAN|TABLE ACCESS/.test(String(r[0]))),
            JSON.stringify(plan.rows)
        );
    });

    it('describes owners, objects and columns', async () => {
        const adapter = adapters[0] as OracleAdapter;
        const owners = (await adapter.describe(undefined, undefined)) as { owners: { OWNER: string }[] };
        assert.ok(owners.owners.some((o) => o.OWNER === 'APP'));
        const table = (await adapter.describe('APP.ORDERS', undefined)) as { columns: { NAME: string }[] };
        assert.ok(table.columns.some((c) => c.NAME === 'TSTZ'));
    });
});
