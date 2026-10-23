import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { isAllowedCosmosRequest } from '../../src/sources/cosmos/guard.ts';
import { checkReadOnlyStatement as checkTsql, lex as lexTsql } from '../../src/sources/mssql/lexer.ts';
import { checkReadOnlyStatement, lex } from '../../src/sources/oracle/lexer.ts';
import { collectReferences, ensureParser, parseReadOnlyQuery } from '../../src/sources/postgres/guard.ts';
import { isAllowedOnWire, parseReadOnlyCommand } from '../../src/sources/redis/guard.ts';

describe('postgres syntax-tree guard', () => {
    before(() => ensureParser());

    it('accepts single reading statements', () => {
        for (const sql of [
            'SELECT 1',
            'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
            'SELECT * FROM (SELECT 1) s UNION ALL SELECT 2',
            'VALUES (1), (2)',
            'TABLE pg_class',
            'EXPLAIN SELECT 1',
            'EXPLAIN (ANALYZE, BUFFERS) SELECT 1',
            "SELECT 'DELETE FROM x; DROP TABLE y'",
            'SELECT now(), current_user',
        ]) {
            parseReadOnlyQuery(sql);
        }
        assert.equal(parseReadOnlyQuery('EXPLAIN ANALYZE SELECT 1').analyze, true);
    });

    it('rejects writes, locks, multiple statements and side-effect functions', () => {
        for (const sql of [
            'SELECT 1; SELECT 2',
            'INSERT INTO t VALUES (1)',
            'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
            'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1',
            'SELECT * FROM (WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x) s',
            'SELECT * INTO t2 FROM t',
            'SELECT * FROM t FOR UPDATE',
            'SELECT * FROM t FOR KEY SHARE',
            'SELECT * FROM (SELECT * FROM t FOR NO KEY UPDATE) s',
            'EXPLAIN ANALYZE INSERT INTO t VALUES (1)',
            'CREATE TABLE t AS SELECT 1',
            'COPY t TO STDOUT',
            'SET search_path = x',
            'SELECT pg_advisory_lock(1)',
            'SELECT pg_catalog.pg_terminate_backend(1)',
            "SELECT dblink_exec('x', 'DELETE FROM t')",
            "SELECT public.dblink('x', 'SELECT 1')",
            "SELECT oracle_execute('srv', 'DELETE FROM t')",
            "SELECT cron.schedule('* * * * *', 'DELETE FROM t')",
            "SELECT nextval('s')",
            'SELECT lo_unlink(1)',
            "SELECT pg_logical_emit_message(true, 'x', 'y')",
            'SELECT 1 FROM t WHERE pg_sleep(100) IS NULL',
            'DO $$ BEGIN END $$',
            'NOT EVEN SQL',
        ]) {
            assert.throws(() => parseReadOnlyQuery(sql), QueryRejectedError, sql);
        }
    });

    it('collects functions and relations of view definitions', () => {
        const found = collectReferences('SELECT f(1), s.g(x) FROM a JOIN b.c ON true');
        assert.deepEqual(found.functions, ['f', 's.g']);
        assert.deepEqual(found.relations.sort(), ['a', 'b.c']);
    });
});

describe('oracle lexer and statement filter', () => {
    const check = (sql: string) => checkReadOnlyStatement(sql, { allowDbLinks: false });

    it('handles quoting, comments and binds', () => {
        assert.deepEqual(
            lex("SELECT q'[it's ; ]' , 'a;b', \"Weird;Name\", :p1 /* ; */ FROM dual -- ;").map((t) => t.type),
            ['word', 'string', 'punct', 'string', 'punct', 'quoted', 'punct', 'bind', 'word', 'word']
        );
    });

    it('accepts reading statements and strips one terminator', () => {
        assert.equal(check('SELECT 1 FROM dual;').sql, 'SELECT 1 FROM dual');
        assert.equal(check('SELECT 1 FROM dual\n/').sql, 'SELECT 1 FROM dual');
        for (const sql of [
            "SELECT q'{a}'';' FROM dual",
            'WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a',
            '(SELECT 1 FROM dual)',
            'SELECT /*+ FULL(d) */ 1 FROM dual d',
            'SELECT DBMS_LOB.GETLENGTH(c) FROM t',
            "SELECT * FROM t AS OF TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR",
            'SELECT seq.CURRVAL FROM dual',
        ]) {
            check(sql);
        }
    });

    it('rejects everything else', () => {
        for (const sql of [
            'SELECT 1 FROM dual; DROP TABLE t',
            'CREATE TABLE t (a NUMBER)',
            'TRUNCATE TABLE t',
            'RENAME t TO u',
            'BEGIN NULL; END;',
            'WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual',
            'WITH PROCEDURE p IS BEGIN NULL; END; SELECT 1 FROM dual',
            'SELECT * FROM t FOR UPDATE NOWAIT',
            'SELECT s.NEXTVAL FROM dual',
            "SELECT DBMS_PIPE.SEND_MESSAGE('x') FROM dual",
            "SELECT UTL_HTTP.REQUEST('x') FROM dual",
            'SELECT * FROM t@remote',
            "SELECT 'open FROM dual",
            "SELECT q'[open FROM dual",
            'SELECT 1 /* open',
            'SELECT\u00a01 FROM dual',
            'MERGE INTO t USING dual ON (1=0) WHEN NOT MATCHED THEN INSERT (a) VALUES (1)',
            '',
        ]) {
            assert.throws(() => check(sql), QueryRejectedError, JSON.stringify(sql));
        }
    });

    it('allows database links only when configured', () => {
        checkReadOnlyStatement('SELECT * FROM t@remote', { allowDbLinks: true });
    });
});

describe('sql server lexer and statement filter', () => {
    const check = (sql: string) => checkTsql(sql, { allowLinkedServers: false });

    it('handles brackets, nested comments, N-strings and variables', () => {
        assert.deepEqual(
            lexTsql("SELECT [a;]]b], N'x;''y', @p /* ; /* ; */ ; */ FROM t -- ;").map((t) => t.type),
            ['word', 'quoted', 'punct', 'string', 'punct', 'variable', 'word', 'word']
        );
    });

    it('accepts reading statements and strips one terminator', () => {
        assert.equal(check('SELECT 1;').sql, 'SELECT 1');
        for (const sql of [
            'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
            '(SELECT 1) UNION ALL (SELECT 2)',
            'SELECT 1 UNION SELECT 2 EXCEPT SELECT 3',
            'SELECT TOP (10) * FROM dbo.t WITH (NOLOCK) ORDER BY id OFFSET 0 ROWS',
            'SELECT * FROM app.dbo.t',
            'SELECT * FROM app..t',
            "SELECT JSON_VALUE(doc, '$.a') FROM t CROSS APPLY OPENJSON(doc)",
            'SELECT * FROM t WHERE id = @id AND x = 0x1F',
            'SELECT COUNT(*) OVER (PARTITION BY a) FROM #temp',
        ]) {
            check(sql);
        }
    });

    it('rejects everything else', () => {
        for (const sql of [
            'SELECT 1 SELECT 2',
            'SELECT 1 DELETE FROM t',
            'SELECT 1; DROP TABLE t',
            'WITH a AS (SELECT 1 AS x) DELETE FROM t',
            'SELECT * INTO t2 FROM t',
            "EXEC('SELECT 1')",
            'xp_cmdshell',
            'SELECT NEXT VALUE FOR s',
            'SELECT * FROM t WITH (XLOCK)',
            "SELECT * FROM OPENROWSET(BULK 'x', SINGLE_CLOB) AS f",
            'SELECT * FROM srv.app.dbo.t',
            'SELECT * FROM [srv].[app].[dbo].[t]',
            'SELECT * FROM srv...t',
            "SELECT 'open",
            'SELECT [open',
            'SELECT 1 /* open /* nested */',
            'SELECT\u00a01',
            'SET ROWCOUNT 1',
            '',
        ]) {
            assert.throws(() => check(sql), QueryRejectedError, JSON.stringify(sql));
        }
    });

    it('allows linked servers only when configured', () => {
        checkTsql('SELECT * FROM srv.app.dbo.t', { allowLinkedServers: true });
    });
});

describe('redis command allowlist', () => {
    it('accepts read-only commands and rejects writes, scripts and blocking commands', () => {
        assert.equal(parseReadOnlyCommand('hgetall user:1').name, 'HGETALL');
        assert.equal(parseReadOnlyCommand('XINFO GROUPS events').name, 'XINFO GROUPS');
        for (const command of [
            'SET a 1',
            'EVAL "x" 0',
            'XINFO HELP',
            'CLIENT LIST',
            'KEYS *',
            'GEOSEARCH g FROMLONLAT 0 0 BYRADIUS 1 km STORE x',
        ]) {
            assert.throws(() => parseReadOnlyCommand(command), QueryRejectedError, command);
        }
    });

    it('lets the client handshake through on the wire, but not writes', () => {
        assert.equal(isAllowedOnWire(['HELLO', '3']), true);
        assert.equal(isAllowedOnWire(['CLIENT', 'SETNAME', 'x']), true);
        assert.equal(isAllowedOnWire(['CLUSTER', 'SLOTS']), true);
        assert.equal(isAllowedOnWire(['SET', 'a', '1']), false);
        assert.equal(isAllowedOnWire(['CLIENT', 'KILL', 'x']), false);
        assert.equal(isAllowedOnWire(['MULTI']), false);
    });
});

describe('cosmos wire guard', () => {
    const request = (method: string, headers: Record<string, string>) => ({
        method: method as 'GET',
        headers: { get: (name: string) => headers[name.toLowerCase()] } as never,
    });

    it('allows reads and queries only', () => {
        assert.equal(isAllowedCosmosRequest(request('GET', {})), true);
        assert.equal(
            isAllowedCosmosRequest(
                request('POST', { 'x-ms-documentdb-isquery': 'True', 'content-type': 'application/query+json' })
            ),
            true
        );
        assert.equal(isAllowedCosmosRequest(request('POST', { 'content-type': 'application/json' })), false);
        assert.equal(
            isAllowedCosmosRequest(
                request('POST', { 'x-ms-documentdb-isquery': 'true', 'content-type': 'application/json' })
            ),
            false
        );
        for (const method of ['PUT', 'PATCH', 'DELETE'])
            assert.equal(isAllowedCosmosRequest(request(method, {})), false);
    });
});
