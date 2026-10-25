import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { KimSourceConfig } from '../../src/config/sources.ts';
import { QueryRejectedError, WireGuardError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { readFileWindow } from '../../src/results/file-window.ts';
import { KimAdapter } from '../../src/sources/kim/adapter.ts';
import { KimClient } from '../../src/sources/kim/client.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

/**
 * A mock of the KIM HTTP API with the request and answer shapes of a real kim-server:
 * oRPC `{ json }` envelopes, rank-keyed records, URL-keyed node pools with `{ replace }`
 * values, offloaded and withheld nodes, `first N skip M` and `after (…)` windows, the
 * result budget, snapshot pinning and one-hour tokens. Requests outside the read
 * allowlist are answered 403 and recorded; the tests assert that none arrive.
 */

const KEY = `kim_sk_${'a'.repeat(64)}`;
const STAGE = 'acme.app.test';
const STAGE_ID = '20000-0000-0000h';
const ORDERS = '20000-0000-00012';
const BIG = '20000-0000-00013';
const FILES = '20000-0000-0001k';
const ORDER_TYPE = '20000-0000-00012';
const COUNT = 1200;
const TEXT_FILE = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

interface Mock {
    server: Server;
    origin: string;
    queries: { text: string; snapshotId: string | undefined }[];
    unexpected: string[];
    expireTokens(): void;
    exchanges: number;
}

const startMock = async (): Promise<Mock> => {
    const queries: Mock['queries'] = [];
    const unexpected: string[] = [];
    let generation = 1;
    let valid = new Set<string>();
    const mock = { queries, unexpected, exchanges: 0 } as unknown as Mock;
    let origin = '';
    const typeUrl = (id: string) => `${origin}/${STAGE_ID}/9zzzz-0000-0000v/${id}@1`;
    const objectUrl = (collection: string, i: number) => `${origin}/${STAGE_ID}/${collection}/o${i}`;
    const position = (i: number) => `p${String(i).padStart(5, '0')}`;
    const order = (i: number) => ({
        number: { shape: 'Text', value: `ORD-${String(i).padStart(5, '0')}` },
        amount: { shape: 'PreciseNumber', value: (i * 1.25).toFixed(2) },
        placedAt: {
            shape: 'Instant',
            value: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString().replace('.000', ''),
        },
        customer: { shape: 'Reference', value: `${origin}/${STAGE_ID}/20000-0000-0000c/c${i % 3}` },
        email: { shape: 'Text', withheld: 'sensitive' },
        ...(i === 1 ? { notes: { shape: 'Text', withheld: 'offloaded', size: TEXT_FILE.length } } : {}),
    });

    const json = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const authorized = (req: IncomingMessage) => valid.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    /** Answers one query text the way kim-server does, for the fixtures above. */
    const answer = (text: string): Record<string, unknown> => {
        const collection = /\/(20000-0000-000\w\w|orders|big|files)\b/.exec(text)?.[1];
        const ids =
            ({ orders: ORDERS, big: BIG, files: FILES } as Record<string, string>)[collection ?? ''] ??
            collection ??
            ORDERS;
        if (/summarize n = count\(\) by app = \$::descriptor/.test(text)) {
            return {
                records: { hydrate: { 0: { app: { type: typeUrl(ORDER_TYPE) }, n: COUNT } } },
                stats: { size: 80 },
            };
        }
        if (/^at /.test(text) && text.includes('pick $.mediaType')) {
            const object = /^at (\S+)/.exec(text)?.[1] as string;
            const media = object.includes('/o2') ? 'image/png' : 'text/plain';
            return {
                membership: { hydrate: { [object]: 0 } },
                nodes: { [`${object}/mediaType`]: { shape: 'Text', value: { replace: media } } },
            };
        }
        if (ids === FILES) {
            const pool: Record<string, unknown> = {};
            const membership: Record<string, number> = {};
            for (const [i, name, size] of [
                [1, 'large.txt', TEXT_FILE.length],
                [2, 'pixel.png', PNG.length],
            ] as const) {
                const url = objectUrl(FILES, i);
                membership[url] = i - 1;
                pool[url] = {
                    shape: 'Details',
                    classes: [typeUrl('9zzzz-0000-40405')],
                    position: position(i),
                    version: '1',
                };
                pool[`${url}/name`] = { shape: 'Text', value: { replace: name } };
                pool[`${url}/content`] = { shape: 'Bytes', size, withheld: 'offloaded' };
            }
            return { membership: { hydrate: membership }, stats: { filtered: { after: 0 } }, nodes: pool };
        }
        const records = /\b(select|summarize)\b/.test(text);
        const window = /first (\d+)(?: skip (\d+))?(?: after \((.*)\))?/.exec(text.split('\n').slice(-3).join('\n'));
        const size = Number(window?.[1] ?? 500);
        if (ids === BIG && size > 100) return { error: { code: 'resultBudget', size: 5_000_000, budget: 4_194_304 } };
        let start = Number(window?.[2] ?? 0);
        const anchor = window?.[3];
        if (anchor) start = Number(/"p(\d+)"$/.exec(anchor)?.[1]);
        const page = Array.from({ length: Math.max(Math.min(size, COUNT - start), 0) }, (_, k) => start + k + 1);
        if (records) {
            return {
                records: {
                    hydrate: Object.fromEntries(
                        page.map((i, rank) => [rank, { n: order(i).number.value, amount: order(i).amount.value }])
                    ),
                },
                stats: { size: page.length * 40 },
            };
        }
        const all = text.includes('pick $*');
        const picked = [...(text.split(/\bpick\b/)[1] ?? '').matchAll(/\$\.(\w+)/g)].map((m) => m[1] as string);
        const pool: Record<string, unknown> = {};
        const membership: Record<string, number> = {};
        for (const [rank, i] of page.entries()) {
            const url = objectUrl(ids, i);
            membership[url] = rank;
            pool[url] = { shape: 'Details', classes: [typeUrl(ORDER_TYPE)], position: position(i), version: '1' };
            for (const [field, node] of Object.entries(order(i))) {
                if (!all && !picked.includes(field)) continue;
                const { value, ...rest } = node as { value?: unknown };
                pool[`${url}/${field}`] = { ...rest, ...(value !== undefined ? { value: { replace: value } } : {}) };
            }
        }
        return {
            membership: { hydrate: membership },
            stats: {
                filtered: { total: COUNT, before: start, window: page.length, after: COUNT - start - page.length },
            },
            nodes: pool,
        };
    };

    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            const path = req.url ?? '';
            if (req.method === 'POST' && path === '/rpc/identity/exchangeApiKey') {
                if ((JSON.parse(body) as { json: { key: string } }).json.key !== KEY) {
                    return json(res, 401, { json: { code: 'unauthenticated', data: { refusal: 'unauthorizedKey' } } });
                }
                mock.exchanges++;
                const token = `token-${generation}-${mock.exchanges}`;
                valid.add(token);
                return json(res, 200, { json: { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
            }
            if (!authorized(req)) return json(res, 401, { code: 'unauthenticated', message: 'bearer' });
            if (req.method === 'POST' && path === '/rpc/live/query') {
                const input = (
                    JSON.parse(body) as {
                        json: { stage: string; clock?: { snapshotId: string }; queries: { q: string } };
                    }
                ).json;
                assert.equal(input.stage, STAGE);
                queries.push({ text: input.queries.q, snapshotId: input.clock?.snapshotId });
                return json(res, 200, {
                    json: {
                        clock: { snapshot: { from: 'snap-7', to: input.clock?.snapshotId ?? 'snap-7' } },
                        queries: { q: answer(input.queries.q) },
                        nodes: { update: (answer(input.queries.q).nodes as object) ?? {} },
                    },
                });
            }
            if (req.method === 'POST' && path === '/rpc/collection/listCollections') {
                const { parent } = (JSON.parse(body) as { json: { parent: string | null } }).json;
                const entries =
                    parent === null
                        ? [
                              { id: ORDERS, name: 'orders', parent: null },
                              { id: BIG, name: 'big', parent: null },
                              { id: FILES, name: 'files', parent: null },
                          ]
                        : [];
                return json(res, 200, { json: { entries } });
            }
            if (req.method === 'GET' && path.startsWith(`/${STAGE_ID}/9zzzz-0000-0000v/`)) {
                const id = path.split('/')[3]?.replace(/@.*$/, '');
                if (id === ORDER_TYPE) {
                    return json(res, 200, {
                        title: 'order',
                        content: {
                            value: {
                                args: {
                                    properties: [
                                        {
                                            id: 'number',
                                            title: 'Number',
                                            value: { type: typeUrl('9zzzz-0000-00406') },
                                            isTitle: true,
                                        },
                                        {
                                            id: 'amount',
                                            value: { type: typeUrl('9zzzz-0000-0041s'), args: { decimals: 2 } },
                                        },
                                        {
                                            id: 'email',
                                            value: { type: typeUrl('9zzzz-0000-00406') },
                                            isSensitive: 'always',
                                        },
                                    ],
                                },
                            },
                        },
                    });
                }
                return json(res, 200, { title: id === '9zzzz-0000-00406' ? 'Text' : 'PreciseNumber' });
            }
            const bytes = /^\/bytes\/[^/]+\/[^/]+\/o(\d)@1\/(content|notes)$/.exec(path);
            if (req.method === 'GET' && bytes) {
                const content = bytes[1] === '2' && bytes[2] === 'content' ? PNG : Buffer.from(TEXT_FILE);
                const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
                const start = range ? Number(range[1]) : 0;
                const end = range ? Math.min(Number(range[2]), content.length - 1) : content.length - 1;
                res.writeHead(range ? 206 : 200, {
                    'content-type': 'application/octet-stream',
                    'kim-byte-size': String(content.length),
                    etag: '"v1"',
                    ...(range ? { 'content-range': `bytes ${start}-${end}/${content.length}` } : {}),
                });
                return res.end(content.subarray(start, end + 1));
            }
            unexpected.push(`${req.method} ${path}`);
            return json(res, 403, { json: { code: 'forbidden' } });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mock.server = server;
    mock.origin = origin;
    mock.expireTokens = () => {
        generation++;
        valid = new Set();
    };
    return mock;
};

describe('kim source (mock API)', () => {
    let mock: Mock;
    let adapter: KimAdapter;
    let config: KimSourceConfig;
    let harness: ResultHarness;

    before(async () => {
        mock = await startMock();
        config = {
            index: 0,
            type: 'kim',
            name: 'app',
            description: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            url: mock.origin,
            stage: STAGE,
            apiKey: KEY,
            identityUrl: mock.origin,
            allowReveal: false,
        };
        adapter = new KimAdapter(config);
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness({ partBytes: 150_000 });
    });

    after(async () => {
        await harness?.dispose();
        await new Promise((resolve) => mock?.server.close(resolve));
        assert.deepEqual(mock.unexpected, []);
    });

    const orders = () => `${mock.origin}/${STAGE}/orders`;

    it('describes collections, the types in a collection and a type', async () => {
        const root = (await adapter.describe(undefined, undefined)) as { collections: { name: string }[] };
        assert.deepEqual(
            root.collections.map((c) => c.name),
            ['orders', 'big', 'files']
        );
        const collection = (await adapter.describe('orders', undefined)) as {
            types: { type: string; objects: number }[];
        };
        assert.deepEqual(collection.types, [
            { type: 'order', typeUrl: `${mock.origin}/${STAGE_ID}/9zzzz-0000-0000v/${ORDER_TYPE}@1`, objects: COUNT },
        ]);
        const type = (await adapter.describe('orders/order', undefined)) as {
            properties: { id: string; type: string }[];
        };
        assert.deepEqual(
            type.properties.map((p) => [p.id, p.type]),
            [
                ['number', 'Text'],
                ['amount', 'PreciseNumber'],
                ['email', 'Text'],
            ]
        );
    });

    it('pages a record query at one snapshot', async () => {
        const before = mock.queries.length;
        const resultId = await harness.run(adapter, `from ${orders()} select n = $.number, amount = $.amount`);
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.format, 'ndjson');
        assert.equal(manifest.rowCount, COUNT);
        const sent = mock.queries.slice(before);
        assert.deepEqual(
            sent.map((q) => /first (\d+) skip (\d+)$/.exec(q.text)?.slice(1)),
            [
                ['500', '0'],
                ['500', '500'],
                ['500', '1000'],
            ]
        );
        assert.deepEqual(
            sent.map((q) => q.snapshotId),
            [undefined, 'snap-7', 'snap-7']
        );
        const last = await harness.service.readRows(resultId, COUNT - 1, 1, undefined);
        assert.deepEqual(last.rows[0], ['ORD-01200', '1500.00']);
    });

    it('pages a node query with typed anchors and picks the order keys', async () => {
        const before = mock.queries.length;
        const resultId = await harness.run(
            adapter,
            `from ${orders()} where $.amount > 0 order by $.placedAt asc pick $.number`
        );
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, COUNT);
        const sent = mock.queries.slice(before).map((q) => q.text);
        assert.equal(sent.length, 3);
        assert.match(sent[0] as string, /first 500\n?pick \$\.number, \$\.placedAt$/);
        assert.match(sent[1] as string, /first 500 after \(Instant\(2026-01-21T20:00:00Z\), "p00500"\)/);
        const window = await harness.service.readRows(resultId, 0, 1, [
            'url',
            'version',
            'values',
            'shapes',
            'withheld',
            'files',
        ]);
        const [url, version, values, shapes, withheld, files] = window.rows[0] as [
            string,
            string,
            Record<string, unknown>,
            Record<string, string>,
            Record<string, string>,
            Record<string, { file: string; size: number }>,
        ];
        assert.equal(url, `${mock.origin}/${STAGE_ID}/${ORDERS}/o1`);
        assert.equal(version, '1');
        assert.deepEqual(values, { number: 'ORD-00001', placedAt: '2026-01-01T01:00:00Z' });
        assert.deepEqual(shapes, { number: 'Text', placedAt: 'Instant' });
        assert.equal(withheld, null);
        assert.equal(files, null);
    });

    it('returns written windows as they are and reports withheld and offloaded nodes', async () => {
        const before = mock.queries.length;
        const resultId = await harness.run(adapter, `from ${orders()} first 2 pick $*`);
        assert.equal(mock.queries.length - before, 1);
        const window = await harness.service.readRows(resultId, 0, 1, ['values', 'withheld', 'files']);
        const [values, withheld, files] = window.rows[0] as [
            Record<string, unknown>,
            Record<string, string>,
            Record<string, { file: string; size: number }>,
        ];
        assert.equal(values.amount, '1.25');
        assert.equal(values.customer, `${mock.origin}/${STAGE_ID}/20000-0000-0000c/c1`);
        assert.deepEqual(withheld, { email: 'sensitive' });
        assert.match(files.notes?.file ?? '', /^files\/[\w-]{22}\/v~1\//);
        assert.equal(files.notes?.size, TEXT_FILE.length);
    });

    it('halves the page size while the result budget is exceeded', async () => {
        const before = mock.queries.length;
        const resultId = await harness.run(adapter, `from ${mock.origin}/${STAGE}/big select n = $.number`);
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, COUNT);
        const sizes = mock.queries.slice(before).map((q) => Number(/first (\d+)/.exec(q.text)?.[1]));
        assert.deepEqual(sizes.slice(0, 4), [500, 250, 125, 62]);
        assert.ok(sizes.slice(3).every((s) => s === 62));
    });

    it('reads referenced files through the Bytes API, pinned to the object version', async () => {
        const resultId = await harness.run(adapter, `from ${mock.origin}/${STAGE}/files pick $*`);
        const window = await harness.service.readRows(resultId, 0, 2, ['files']);
        const links = window.rows.map((r) => (r[0] as { content: { file: string } }).content.file);
        const text = await readFileWindow({
            store: harness.service.store,
            resultId,
            file: links[0] as string,
            reference: { container: STAGE_ID, name: `${FILES}/o1/content`, versionId: '1' },
            provider: adapter,
            lineOffset: 2998,
            lineLimit: 5,
            maxBytes: 65_536,
        });
        assert.ok(text.kind === 'text', JSON.stringify(text));
        assert.deepEqual(text.kind === 'text' && text.lines, ['line 2998', 'line 2999']);
        const image = await readFileWindow({
            store: harness.service.store,
            resultId,
            file: links[1] as string,
            reference: { container: STAGE_ID, name: `${FILES}/o2/content`, versionId: '1' },
            provider: adapter,
            lineOffset: 0,
            lineLimit: 1,
            maxBytes: 65_536,
        });
        assert.ok(image.kind === 'image' && image.mimeType === 'image/png');
    });

    it('exchanges the key again when the token is no longer accepted', async () => {
        const exchanges = mock.exchanges;
        mock.expireTokens();
        const resultId = await harness.run(adapter, `from ${orders()} first 1 select n = $.number`);
        assert.equal((await harness.service.snapshot(resultId)).manifest.status, 'succeeded');
        assert.equal(mock.exchanges, exchanges + 1);
    });

    it('rejects reveal, foreign origins, params and non-queries before anything is sent', async () => {
        const before = mock.queries.length;
        for (const query of [
            `from ${orders()} first 5 pick $* reveal $.email`,
            'from https://other.example.com/x/orders first 5',
            `from ${orders()} where $.customer == Reference(https://other.example.com/x/c/1) first 5`,
            'select n = 1',
        ]) {
            await assert.rejects(adapter.validate(query, undefined, {}), QueryRejectedError, query);
        }
        await assert.rejects(adapter.validate(`from ${orders()} first 1`, ['x'], {}), /no params/);
        await assert.rejects(
            adapter.validate(`from ${orders()} order by $.customer::version pick $*`, undefined, {}),
            /plain fields/
        );
        assert.equal(mock.queries.length, before);
    });

    it('blocks every request outside the read allowlist on the wire', async () => {
        const client = new KimClient(config);
        for (const path of [
            '/rpc/resource/createDraft',
            '/rpc/live/register',
            '/rpc/identity/exchangeToken',
            '/rpc/stage/backupStage',
        ]) {
            await assert.rejects(client.rpc(path, { stage: STAGE }), WireGuardError, path);
        }
        assert.deepEqual(mock.unexpected, []);
    });
});
