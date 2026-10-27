import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { parseSources } from '../../src/config/env.ts';
import { QueryRejectedError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { RestAdapter } from '../../src/sources/rest/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

/**
 * A write-capable HTTP API: every request outside its read endpoints changes nothing here but is recorded as a write,
 * and so is a GET on `/v1/admin/…`, which stands for an endpoint that writes on GET. The tests assert that none
 * arrive, whatever the agent or the script asks for.
 */

const PDF = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
const STREAM = Buffer.from(Array.from({ length: 5_000 }, (_, i) => (i * 7) % 256));
const PAGES = 3;

interface Mock {
    server: Server;
    origin: string;
    writes: string[];
    requests: number;
    signIns: number;
    expireTokens(): void;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
};

const startMock = async (): Promise<Mock> => {
    const tokens = new Set<string>();
    const mock = { writes: [], requests: 0, signIns: 0, expireTokens: () => tokens.clear() } as unknown as Mock;
    const json = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const ranged = (req: IncomingMessage, res: ServerResponse, data: Buffer) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (!range) {
            res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': data.length, etag: '"pdf-1"' });
            res.end(data);
            return;
        }
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), data.length - 1);
        res.writeHead(206, {
            'content-type': 'application/pdf',
            'content-range': `bytes ${start}-${end}/${data.length}`,
            'content-length': end - start + 1,
            etag: '"pdf-1"',
        });
        res.end(data.subarray(start, end + 1));
    };

    const server = createServer((req, res) => {
        void (async () => {
            mock.requests++;
            const body = await readBody(req);
            const url = new URL(req.url ?? '/', mock.origin);
            const path = url.pathname;
            const method = req.method ?? 'GET';
            if (method === 'POST' && path === '/oauth/token/') {
                const basic = Buffer.from('client:client-secret').toString('base64');
                const form = new URLSearchParams(body);
                if (req.headers.authorization !== `Basic ${basic}` || form.get('password') !== 'pw') {
                    json(res, 401, { error: 'invalid_client' });
                    return;
                }
                mock.signIns++;
                const token = `t${mock.signIns}`;
                tokens.add(token);
                json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
                return;
            }
            const isRead = method === 'GET' || method === 'HEAD' || (method === 'POST' && path === '/v1/search');
            if (!isRead || path.startsWith('/v1/admin/')) {
                mock.writes.push(`${method} ${path}`);
                json(res, 200, { changed: true });
                return;
            }
            if (path.startsWith('/v1/secure/')) {
                if (!tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) {
                    json(res, 401, { error: 'invalid_token' });
                    return;
                }
                const page = Number(url.searchParams.get('page') ?? '1');
                json(res, 200, { results: [0, 1].map((i) => ({ page, i })), page, pages: PAGES });
                return;
            }
            switch (path) {
                case '/v1/items':
                    json(res, 200, [{ id: 1 }, { id: 2 }, { id: 3 }]);
                    return;
                case '/v1/items/1':
                    json(res, 200, { id: 1, name: 'one' });
                    return;
                case '/v1/text':
                    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end('hello\nworld');
                    return;
                case '/v1/files/report.pdf':
                    ranged(req, res, PDF);
                    return;
                case '/v1/files/stream.bin':
                    res.writeHead(200, { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' });
                    res.write(STREAM.subarray(0, 2_000));
                    res.end(STREAM.subarray(2_000));
                    return;
                case '/v1/redirect':
                    res.writeHead(302, { location: '/v1/items/1' });
                    res.end();
                    return;
                case '/v1/redirect-out':
                    res.writeHead(307, { location: '/v1/admin/wipe' });
                    res.end();
                    return;
                case '/v1/fail':
                    res.writeHead(500, { 'content-type': 'text/plain' });
                    res.end('boom');
                    return;
                case '/v1/search':
                    json(res, 200, { query: JSON.parse(body) as unknown });
                    return;
                default:
                    json(res, 404, { error: 'not found' });
            }
        })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mock.server = server;
    mock.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return mock;
};

/** Signs in with the password grant, pages through `{ results, page, pages }` and signs in again on a 401. */
const SCRIPT = `
let token;
let pending;

const signIn = async ({ vars, fetch, signal }) => {
    const response = await fetch(vars.TOKEN_URL, {
        method: 'POST',
        headers: {
            authorization: 'Basic ' + btoa(vars.CLIENT_ID + ':' + vars.CLIENT_SECRET),
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'password', username: vars.USERNAME, password: vars.PASSWORD }),
        signal,
    });
    if (!response.ok) throw new Error('sign-in failed with ' + response.status);
    const body = await response.json();
    return { value: body.access_token, renewAt: Date.now() + body.expires_in * 500 };
};

export function check(request) {
    if (new URL(request.url).searchParams.get('page') === '13') throw new Error('page 13 is not allowed');
}

export async function prepare(request, context) {
    if (!token || Date.now() > token.renewAt) {
        pending ??= signIn(context).finally(() => { pending = undefined; });
        token = await pending;
    }
    request.headers.authorization = 'Bearer ' + token.value;
}

export async function transform(response, { request }) {
    if (response.status === 401 && !request.headers['x-retry']) {
        token = undefined;
        return { next: { ...request, headers: { ...request.headers, 'x-retry': '1' } } };
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const body = await response.json();
    const url = new URL(request.url);
    url.searchParams.set('page', String(body.page + 1));
    const { 'x-retry': _, ...headers } = request.headers;
    return { documents: body.results, next: body.page < body.pages ? { ...request, url: url.href, headers } : undefined };
}
`;

describe('rest source', () => {
    let mock: Mock;
    let harness: ResultHarness;
    let plain: RestAdapter;
    let scripted: RestAdapter;

    const adapterOf = async (keys: Record<string, string>): Promise<RestAdapter> => {
        const env: Record<string, string> = { PERISCOPE_SOURCE_N: '1', PERISCOPE_SOURCE_0_TYPE: 'rest' };
        for (const [key, value] of Object.entries({ NAME: 'api', BASE_URL: `${mock.origin}/v1`, ...keys })) {
            env[`PERISCOPE_SOURCE_0_${key}`] = value;
        }
        const [config] = parseSources(env, { maxQueryDurationMs: 30_000, maxResultBytes: 1024 ** 3 });
        const adapter = new RestAdapter(config as never);
        await adapter.init(nullLoggers().log);
        return adapter;
    };
    const scriptKeys = () => ({
        ALLOW: 'GET /secure/**',
        SCRIPT,
        VAR_TOKEN_URL: `${mock.origin}/oauth/token/`,
        VAR_CLIENT_ID: 'client',
        VAR_CLIENT_SECRET: 'client-secret',
        VAR_USERNAME: 'reader',
        VAR_PASSWORD: 'pw',
    });
    const manifestOf = async (adapter: RestAdapter, query: string) =>
        (await harness.service.snapshot(await harness.run(adapter, query))).manifest;

    before(async () => {
        mock = await startMock();
        harness = await createResultHarness();
        plain = await adapterOf({
            ALLOW: 'GET /items, GET /items/**, GET /text, GET /files/*, GET /redirect, GET /redirect-out, GET /fail, POST /search',
        });
        scripted = await adapterOf(scriptKeys());
    });
    after(async () => {
        mock.server.closeAllConnections();
        await new Promise((resolve) => mock.server.close(resolve));
        await harness.dispose();
        assert.deepEqual(mock.writes, []);
    });

    it('turns JSON, text and binary responses into documents', async () => {
        const items = await harness.run(plain, 'GET /items\naccept: application/json');
        assert.deepEqual((await harness.service.readRows(items, 0, 10, ['id'])).rows, [[1], [2], [3]]);
        const one = await harness.run(plain, `GET ${mock.origin}/v1/items/1`);
        assert.deepEqual((await harness.service.readRows(one, 0, 10, ['id', 'name'])).rows, [[1, 'one']]);
        const text = await harness.run(plain, 'GET /text');
        assert.deepEqual((await harness.service.readRows(text, 0, 10, ['text'])).rows, [['hello\nworld']]);
        const search = await harness.run(plain, 'POST /search\ncontent-type: application/json\n\n{"q":"x"}');
        assert.deepEqual((await harness.service.readRows(search, 0, 10, ['query'])).rows, [[{ q: 'x' }]]);
        const pdf = await harness.run(plain, 'GET /files/report.pdf');
        const [row] = (await harness.service.readRows(pdf, 0, 1, ['contentType', 'size', 'file'])).rows;
        assert.deepEqual(row?.slice(0, 2), ['application/pdf', PDF.length]);
        assert.match(String(row?.[2]), /^files\//);
    });

    it('serves linked files by fetching them again, with ranges whether or not the API supports them', async () => {
        const read = async (name: string, range?: { offset: number; length: number }) => {
            const content = await plain.openFile({ container: `${mock.origin}/v1/files/${name}`, name }, range);
            const chunks: Buffer[] = [];
            for await (const chunk of content.stream) chunks.push(chunk as Buffer);
            return { size: content.size, data: Buffer.concat(chunks), contentType: content.contentType };
        };
        const part = await read('report.pdf', { offset: 100, length: 50 });
        assert.equal(part.size, PDF.length);
        assert.deepEqual(part.data, PDF.subarray(100, 150));
        assert.deepEqual((await read('report.pdf')).data, PDF);
        const streamed = await read('stream.bin', { offset: 1_990, length: 20 });
        assert.equal(streamed.size, STREAM.length);
        assert.deepEqual(streamed.data, STREAM.subarray(1_990, 2_010));
        await assert.rejects(plain.openFile({ container: `${mock.origin}/v1/admin/wipe`, name: 'wipe' }), {
            code: 'forbidden',
        });
    });

    it('follows redirects only within the allowlist', async () => {
        const redirected = await harness.run(plain, 'GET /redirect');
        assert.deepEqual((await harness.service.readRows(redirected, 0, 1, ['id'])).rows, [[1]]);
        const blocked = await manifestOf(plain, 'GET /redirect-out');
        assert.equal(blocked.status, 'failed');
        assert.equal(blocked.error?.code, 'forbidden');
    });

    it('reports HTTP errors with the start of the body', async () => {
        const failed = await manifestOf(plain, 'GET /fail');
        assert.equal(failed.status, 'failed');
        assert.match(failed.error?.message ?? '', /HTTP 500.*boom/);
    });

    it('signs in, pages and signs in again through the script', async () => {
        const first = await manifestOf(scripted, 'GET /secure/pages');
        assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
        assert.equal(first.rowCount, PAGES * 2);
        assert.equal(mock.signIns, 1);
        mock.expireTokens();
        const second = await manifestOf(scripted, 'GET /secure/pages?page=2');
        assert.equal(second.status, 'succeeded', JSON.stringify(second.error));
        assert.equal(second.rowCount, (PAGES - 1) * 2);
        assert.equal(mock.signIns, 2);
    });

    it('rejects writes, method overrides and ambiguous paths before anything is sent', async () => {
        const sent = mock.requests;
        for (const query of [
            'DELETE /items/1',
            'PUT /items/1\ncontent-type: application/json\n\n{}',
            'PATCH /items/1\n\n{}',
            'POST /items\n\n{}',
            'GET /admin/wipe',
            'GET /items/../admin/wipe',
            'GET /items/%2e%2e/admin/wipe',
            'GET /items/1%2f..%2f..%2fadmin%2fwipe',
            'GET /items//1',
            'GET /items/1\nx-http-method-override: DELETE',
            'POST /search\nx-http-method: DELETE\n\n{}',
            'GET /items/1?_method=DELETE',
            'GET /items/1\nauthorization: Bearer stolen',
            `GET ${mock.origin}/v1/admin/wipe`,
            `GET ${mock.origin.replace('127.0.0.1', 'localhost')}/v1/items/1`,
            'GET /items/1\n\nbody',
        ]) {
            await assert.rejects(plain.validate(query, undefined, {}), QueryRejectedError, query);
        }
        await assert.rejects(scripted.validate('GET /secure/pages?page=13', undefined, {}), /page 13 is not allowed/);
        await assert.rejects(plain.validate('GET /items', { a: 1 }, {}), { code: 'invalid_argument' });
        await assert.rejects(plain.validate('GET /items', undefined, { x: 1 }), { code: 'invalid_argument' });
        assert.equal(mock.requests, sent);
    });

    it('blocks requests the script turns into anything outside the allowlist', async () => {
        const rewriting = await adapterOf({
            ALLOW: 'GET /items/**',
            SCRIPT: `export function prepare(request) { return { ...request, method: 'DELETE' }; }`,
        });
        const rewritten = await manifestOf(rewriting, 'GET /items/1');
        assert.equal(rewritten.error?.code, 'forbidden');
        const paging = await adapterOf({
            ALLOW: 'GET /items/**',
            SCRIPT: `export function transform(response, { request }) {
                return { documents: [], next: { ...request, url: request.url.replace('/items/1', '/admin/wipe') } };
            }`,
        });
        assert.equal((await manifestOf(paging, 'GET /items/1')).error?.code, 'forbidden');
        await assert.rejects(adapterOf({ SCRIPT: 'export function prepar() {}' }), /only check, prepare, transform/);
    });

    it('stops at the request and response size limits', async () => {
        const looping = await adapterOf({
            ALLOW: 'GET /items/**',
            MAX_REQUESTS: '3',
            SCRIPT: 'export function transform(response, { request }) { return { documents: [{}], next: request }; }',
        });
        const loop = await manifestOf(looping, 'GET /items/1');
        assert.equal(loop.error?.code, 'limit_exceeded');
        const small = await adapterOf({ ALLOW: 'GET /files/*', MAX_RESPONSE_BYTES: '1000' });
        assert.equal((await manifestOf(small, 'GET /files/stream.bin')).status, 'succeeded');
        await assert.rejects(small.openFile({ container: `${mock.origin}/v1/files/stream.bin`, name: 's' }), {
            code: 'too_large',
        });
    });
});
