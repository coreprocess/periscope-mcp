import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { isAllowedCosmosRequest } from '../../src/sources/cosmos/guard.ts';
import { isAllowedKimRequest } from '../../src/sources/kim/client.ts';
import { analyzeKimQuery, lexKim } from '../../src/sources/kim/guard.ts';
import { literalOf, nodePage, planKimQuery, recordPage } from '../../src/sources/kim/query.ts';
import { checkReadOnlyStatement as checkTsql, lex as lexTsql } from '../../src/sources/mssql/lexer.ts';
import { checkReadOnlyStatement, lex } from '../../src/sources/oracle/lexer.ts';
import { collectReferences, ensureParser, parseReadOnlyQuery } from '../../src/sources/postgres/guard.ts';
import { isAllowedOnWire, parseReadOnlyCommand } from '../../src/sources/redis/guard.ts';
import {
    compileRules,
    DEFAULT_AGENT_HEADERS,
    parseRequestText,
    type RestRequest,
    rejectionOf,
} from '../../src/sources/rest/guard.ts';

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
            "SELECT query_to_xml('SELECT pg_terminate_backend(pid) FROM pg_stat_activity', true, false, '')",
            "SELECT pg_catalog.query_to_xml_and_xmlschema('SELECT 1', true, false, '')",
            "SELECT cursor_to_xml('c', 1, true, false, '')",
            "SELECT table_to_xml('blocked_view', true, false, '')",
            "SELECT ts_stat('SELECT dblink_exec(''x'', ''DELETE FROM t'')')",
            'SELECT pg_stat_statements_reset()',
            "SELECT pg_logical_slot_get_changes('s', NULL, NULL)",
            "SELECT pg_replication_origin_advance('o', '0/0')",
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
        // a line comment ends at a lone CR as well
        assert.deepEqual(
            lex('SELECT 1 --c\rFROM dual').map((t) => t.value),
            ['SELECT', '1', 'FROM', 'DUAL']
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
            // statement keywords only as parts of names, quoted, in strings or comments
            'SELECT update_date, deleted, "DELETE", savepoint FROM t',
            "SELECT 'DELETE FROM t' FROM dual -- DROP TABLE t",
            'SELECT /*+ MERGE(v) */ * FROM v',
            'SELECT * FROM t MODEL DIMENSION BY (a) MEASURES (b) RULES UPSERT (b[1] = 0)',
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
            'SELECT 1 FROM dual --c\u2028DROP TABLE t',
            'SELECT a\u2028b FROM dual',
            'SELECT a\u200bb FROM dual',
            'MERGE INTO t USING dual ON (1=0) WHEN NOT MATCHED THEN INSERT (a) VALUES (1)',
            // statement keywords after a SELECT, without a ";"
            'SELECT 1 FROM dual --x\nDELETE FROM t',
            'SELECT 1 FROM dual --x\rDELETE FROM t',
            'SELECT 1 FROM dual DELETE FROM t',
            'SELECT 1 FROM dual /* x */ DROP TABLE t',
            'WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a INSERT INTO t VALUES (1)',
            'SELECT * FROM (SELECT 1 FROM dual) TRUNCATE TABLE t',
            'SELECT 1 FROM dual\nCREATE TABLE t (a NUMBER)',
            'SELECT 1 FROM dual LOCK TABLE t IN EXCLUSIVE MODE',
            'SELECT 1 FROM dual GRANT SELECT ON t TO PUBLIC',
            "SELECT 1 FROM dual COMMENT ON TABLE t IS 'x'",
            'SELECT 1 FROM dual EXPLAIN PLAN FOR SELECT 1 FROM dual',
            'SELECT 1 FROM dual CALL p()',
            'SELECT * FROM t MODEL DIMENSION BY (a) MEASURES (b) RULES UPDATE (b[1] = 0)',
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
            'SELECT 1 AS a -- note\r\nFROM t',
            'SELECT [Größe] FROM t',
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
            'SELECT 1 --c\rDELETE FROM t',
            'SELECT 1 --c\u2028DELETE FROM t',
            'SELECT a\u2028DELETE FROM t',
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

describe('kim query check and wire allowlist', () => {
    const origin = 'https://kim.example.com';
    const check = (text: string, allowReveal = false) => analyzeKimQuery(text, { origin, stage: 's', allowReveal });

    it('lexes URLs, strings and comments', () => {
        assert.deepEqual(
            lexKim('from https://kim.example.com/s/a--b -- comment\nwhere $.x == "a -- b" first 5').map((t) => t.type),
            ['word', 'url', 'word', 'punct', 'punct', 'word', 'punct', 'string', 'word', 'number']
        );
    });

    it('takes constructor payloads verbatim and names in backticks', () => {
        const tokens = lexKim('where $.d == MonthDay(--06-15) and $.t == Text(a -- b \\) c) and `at` == 1');
        assert.deepEqual(
            tokens.filter((t) => t.type === 'string' || t.type === 'name').map((t) => t.value),
            ['--06-15', 'a -- b \\) c', '`at`']
        );
        check(`from ${origin}/s/o where $.x == Text(reveal) first 5`);
    });

    it('plans paging: record windows, node anchors, written windows as is', () => {
        const records = planKimQuery(check(`from ${origin}/s/o select n = $.n -- end`));
        assert.equal(records.mode, 'records');
        assert.equal(
            recordPage(records.mode === 'records' ? records.text : '', 500, 1000)
                .split('\n')
                .at(-1),
            'first 500 skip 1000'
        );
        const nodes = planKimQuery(
            check(`from ${origin}/s/o order by $.at desc, $::position pick $.n reveal $.m`, true)
        );
        assert.ok(nodes.mode === 'nodes');
        assert.equal(
            nodePage(nodes, 250, 'Instant(2026-01-01T00:00:00Z), "b8", "b8"'),
            `from ${origin}/s/o order by $.at desc, $::position\nfirst 250 after (Instant(2026-01-01T00:00:00Z), "b8", "b8")\npick $.n, $.at reveal $.m`
        );
        const unpicked = planKimQuery(check(`from ${origin}/s/o order by $.at`));
        assert.ok(unpicked.mode === 'nodes');
        assert.equal(nodePage(unpicked, 500, undefined), `from ${origin}/s/o order by $.at\nfirst 500 pick $.at`);
        assert.equal(planKimQuery(check(`from ${origin}/s/o first 10`)).mode, 'single');
        assert.equal(planKimQuery(check(`at ${origin}/s/o/x pick $*`)).mode, 'single');
        assert.throws(() => planKimQuery(check(`from ${origin}/s/o order by [$.c].name`)), QueryRejectedError);
    });

    it('spells anchor values in their own comparison domain', () => {
        assert.equal(literalOf('Instant', '2026-01-01T00:00:00Z'), 'Instant(2026-01-01T00:00:00Z)');
        assert.equal(literalOf('PreciseNumber', '1500.00'), 'PreciseNumber(1500.00)');
        assert.equal(literalOf('Text', 'a "b"'), '"a \\"b\\""');
        assert.equal(literalOf('Number', 2.5), '2.5');
        assert.equal(literalOf('Number', null), 'Number()');
        assert.equal(literalOf('Link', 'https://x/(a)'), 'Link(https://x/(a\\))');
        assert.equal(literalOf('MultiOption', ['a', 'b']), 'MultiOption(a, b)');
    });

    it('accepts node and record queries and tells them apart', () => {
        assert.equal(check(`from ${origin}/s/orders where $.status == "open" first 50 pick $*`).records, false);
        assert.equal(check(`at ${origin}/s/orders/a, ${origin}/s/orders/b pick $*`).head, 'at');
        assert.equal(check(`referrers of ${origin}/s/c/x order by $::position first 5`).head, 'referrers');
        assert.equal(
            check(`from ${origin}/s/orders summarize n = count() by $.region order by n desc first 5`).records,
            true
        );
        check(`from ${origin}/s/orders where $.a == Instant(2026-06-30T12:00:00Z) first 5 reveal $.mail`, true);
    });

    it('rejects everything else', () => {
        for (const text of [
            '',
            'select 1',
            'referrers x',
            `from ${origin}/s/orders first 5 reveal $.mail`,
            'from https://other.example.com/s/orders first 5',
            'from HTTPS://other.example.com/s/orders first 5',
            `from ${origin}/other-stage/orders first 5`,
            `from ${origin}/s/../other-stage/orders first 5`,
            `from ${origin}/s/%2e%2e/other-stage/orders first 5`,
            `from ${origin}/s/orders where $.r == Reference( https://other.example.com/s/x/y) first 5`,
            `from ${origin}/s/orders where $.r == Reference(${origin}/other-stage/x/y) first 5`,
            `from ${origin}/s/orders -- c\rreveal $.mail first 5`,
            `from ${origin}/s/orders where $.a == "open first 5`,
            `from ${origin}/s/orders where ($.a == 1 first 5`,
            `from ${origin}/s/orders; first 5`,
        ]) {
            assert.throws(() => check(text), QueryRejectedError, JSON.stringify(text));
        }
    });

    it('lets only the query, listing, capabilities, key exchange and byte reads through', () => {
        const config = { url: origin, identityUrl: 'https://id.example.com' };
        assert.equal(isAllowedKimRequest(config, 'POST', `${origin}/rpc/live/query`), true);
        assert.equal(isAllowedKimRequest(config, 'POST', `${origin}/rpc/collection/listCollections`), true);
        assert.equal(isAllowedKimRequest(config, 'POST', 'https://id.example.com/rpc/identity/exchangeApiKey'), true);
        assert.equal(isAllowedKimRequest(config, 'GET', `${origin}/bytes/s/c/o@3/content`), true);
        assert.equal(isAllowedKimRequest(config, 'GET', `${origin}/s/9zzzz-0000-0000v/20000-0000-00012@1`), true);
        for (const [method, url] of [
            ['POST', `${origin}/rpc/resource/createDraft`],
            ['POST', `${origin}/rpc/live/register`],
            ['POST', `${origin}/rpc/identity/exchangeToken`],
            ['POST', `${origin}/rpc/identity/exchangeApiKey`],
            ['POST', `${origin}/rpc/stage/backupStage`],
            ['POST', `${origin}/rpc/file/readFile`],
            ['POST', `${origin}/bytes/s/drafts/d/blobs`],
            ['PUT', `${origin}/s/c/o`],
            ['DELETE', `${origin}/s/c/o`],
            ['GET', `${origin}/interchange/s`],
            ['GET', 'https://other.example.com/bytes/s/c/o'],
            ['GET', `${origin}/s/c/o`],
            ['GET', `${origin}/s/9zzzz-0000-0000v/t?reveal=x`],
            ['GET', `${origin}/s/9zzzz-0000-0000v/t/content`],
        ] as const) {
            assert.equal(isAllowedKimRequest(config, method, url), false, `${method} ${url}`);
        }
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

describe('rest request allowlist', () => {
    const base = 'https://api.example.com/v1';
    const rules = compileRules(base, [
        'GET /items/**',
        'GET /users/*/',
        'POST /search',
        'GET https://files.example.com/**',
    ]);
    const agent = new Set(DEFAULT_AGENT_HEADERS);
    const get = (url: string, headers: Record<string, string> = {}): RestRequest => ({
        method: 'GET',
        url,
        headers,
        body: undefined,
    });
    const allowed = (request: RestRequest, headers?: ReadonlySet<string>) =>
        rejectionOf(rules, request, headers) === undefined;

    it('parses a request text with headers and body', () => {
        assert.deepEqual(
            parseRequestText(base, '\nPOST /search HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"q":1}'),
            {
                method: 'POST',
                url: `${base}/search`,
                headers: { 'content-type': 'application/json' },
                body: '{"q":1}',
            }
        );
        assert.deepEqual(parseRequestText(base, 'get https://files.example.com/a'), get('https://files.example.com/a'));
        assert.throws(() => parseRequestText(base, 'GET items'), /starting with \//);
        assert.throws(() => parseRequestText(base, 'GET /a\nAccept: x\naccept: y'), /duplicate header/);
        assert.throws(() => parseRequestText(base, 'GET /a\nno colon'), /not a header line/);
        assert.throws(() => parseRequestText(base, 'GET'), /METHOD URL/);
    });

    it('allows the configured methods, origins and paths', () => {
        assert.ok(allowed(get(`${base}/items/`)));
        assert.ok(allowed(get(`${base}/items/7/parts?page=2`)));
        assert.ok(allowed({ ...get(`${base}/items/7`), method: 'HEAD' }));
        assert.ok(allowed(get(`${base}/users/7/`)));
        assert.ok(allowed({ method: 'POST', url: `${base}/search`, headers: {}, body: '{}' }));
        assert.ok(allowed(get('https://files.example.com/x/y.pdf')));
        assert.ok(allowed(get(`${base}/items/1`, { accept: 'application/json' }), agent));
    });

    it('rejects other methods, paths and origins', () => {
        assert.ok(!allowed({ method: 'DELETE', url: `${base}/items/7`, headers: {}, body: undefined }));
        assert.ok(!allowed({ method: 'POST', url: `${base}/items/7`, headers: {}, body: '{}' }));
        assert.ok(!allowed({ method: 'POST', url: `${base}/search/x`, headers: {}, body: '{}' }));
        assert.ok(!allowed(get(`${base}/users/7/delete/`)));
        assert.ok(!allowed(get(`${base}/users/7`)));
        assert.ok(!allowed(get(`${base}/admin`)));
        assert.ok(!allowed(get('https://api.example.com/admin')));
        assert.ok(!allowed(get('http://api.example.com/v1/items/1')));
        assert.ok(!allowed(get('https://api.example.com:8443/v1/items/1')));
        assert.ok(!allowed(get('https://evil.example.com/v1/items/1')));
        assert.ok(!allowed(get('ftp://api.example.com/v1/items/1')));
    });

    it('rejects ambiguous paths that servers may resolve differently', () => {
        for (const path of [
            '/items/../admin',
            '/items/./1',
            '/items/%2e%2e/admin',
            '/items/%2E%2e/admin',
            '/items/a%2fb',
            '/items/a%5Cb',
            '/items/a\\b',
            '/items//1',
            '/items/.\t./admin',
            '/items/a b',
            '/items/1#x',
        ]) {
            assert.ok(!allowed(get(`${base}${path}`)), path);
        }
        assert.ok(!allowed(get('https://user:pw@api.example.com/v1/items/1')));
        assert.ok(!allowed(get('https://api.example.com@evil.example.com/v1/items/1')));
    });

    it('rejects every way of overriding the method', () => {
        for (const header of ['x-http-method-override', 'x-http-method', 'x-method-override']) {
            assert.ok(!allowed(get(`${base}/items/1`, { [header]: 'DELETE' })), header);
        }
        assert.ok(!allowed(get(`${base}/items/1?_method=DELETE`)));
        assert.ok(!allowed(get(`${base}/items/1?X-HTTP-Method-Override=DELETE`)));
    });

    it('limits agent headers and bodies', () => {
        assert.ok(!allowed(get(`${base}/items/1`, { authorization: 'Bearer x' }), agent));
        assert.ok(!allowed(get(`${base}/items/1`, { cookie: 'a=b' }), agent));
        assert.ok(allowed(get(`${base}/items/1`, { authorization: 'Bearer x' })));
        assert.ok(!allowed(get(`${base}/items/1`, { accept: 'a\rb' })));
        assert.ok(!allowed({ ...get(`${base}/items/1`), body: 'x' }));
    });

    it('rejects malformed rules', () => {
        for (const rule of [
            'GET',
            'get /a',
            'GET a',
            'GET /a?x=1',
            'GET /a/../b',
            'GET /a/%2fb',
            'GET https://u@h/a',
        ]) {
            assert.throws(() => compileRules(base, [rule]), /ALLOW rule/, rule);
        }
    });
});
