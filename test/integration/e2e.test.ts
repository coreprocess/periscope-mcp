import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const TENANT = '11111111-2222-3333-4444-555555555555';
const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const freePort = (): Promise<number> =>
    new Promise((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });

const text = (result: unknown): Record<string, unknown> => {
    const content = (result as { content: { type: string; text?: string }[] }).content;
    return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}') as Record<string, unknown>;
};

describe('end to end (http + entra auth, stdio)', () => {
    let container: StartedTestContainer;
    let jwks: Server;
    let jwksUrl: string;
    let privateKey: CryptoKey;
    let periscope: ChildProcess;
    let base: string;
    let dir: string;
    let sourceEnv: Record<string, string>;

    const mint = (claims: Record<string, unknown> = {}, audience = APP_ID): Promise<string> =>
        new SignJWT({
            scp: 'Periscope.Access',
            roles: ['Periscope.Reader'],
            tid: TENANT,
            oid: 'user-1',
            preferred_username: 'ada@example.com',
            ver: '2.0',
            ...claims,
        })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
            .setAudience(audience)
            .setIssuedAt()
            .setExpirationTime('10m')
            .sign(privateKey);

    const connect = async (token: string): Promise<Client> => {
        const client = new Client({ name: 'e2e', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
            })
        );
        return client;
    };

    before(async () => {
        container = await new GenericContainer('pgvector/pgvector:pg17')
            .withEnvironment({ POSTGRES_PASSWORD: 'pw' })
            .withExposedPorts(5432)
            .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
            .start();
        const url = `postgres://postgres:pw@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
        const admin = new pg.Client({ connectionString: url });
        await admin.connect();
        await admin.query(
            `CREATE TABLE items AS SELECT i AS id, 'item-' || i AS name, (i * 0.5)::numeric(10,2) AS price FROM generate_series(1, 20000) i`
        );
        await admin.end();

        const keys = await generateKeyPair('RS256', { extractable: true });
        privateKey = keys.privateKey;
        const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
        jwks = createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
        await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
        jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/keys`;

        dir = await mkdtemp(join(tmpdir(), 'periscope-e2e-'));
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        sourceEnv = {
            PERISCOPE_SOURCE_N: '1',
            PERISCOPE_SOURCE_0_NAME: 'shop',
            PERISCOPE_SOURCE_0_TYPE: 'postgres',
            PERISCOPE_SOURCE_0_URL: url,
            PERISCOPE_SOURCE_0_SSL: 'disable',
            PERISCOPE_SOURCE_0_DESCRIPTION: 'Shop items',
        };
        periscope = spawn(process.execPath, ['src/index.ts'], {
            env: {
                ...process.env,
                ...sourceEnv,
                PERISCOPE_TRANSPORT: 'http',
                PERISCOPE_HOST: '127.0.0.1',
                PERISCOPE_PORT: String(port),
                PERISCOPE_PUBLIC_URL: base,
                PERISCOPE_AUTH_TENANT_ID: TENANT,
                PERISCOPE_AUTH_CLIENT_ID: APP_ID,
                PERISCOPE_AUTH_JWKS_URI: jwksUrl,
                PERISCOPE_RESULTS_STORE: 'filesystem',
                PERISCOPE_RESULTS_DIR: join(dir, 'http'),
                PERISCOPE_RESULTS_PART_BYTES: '50000',
                PERISCOPE_DOWNLOAD_SIGNING_KEY: 'e2e-signing-key-that-is-long-enough-123',
                PERISCOPE_AUDIT_LOG: join(dir, 'audit.log'),
                PERISCOPE_LOG_LEVEL: 'warn',
            },
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        for (let i = 0; i < 100; i++) {
            const ok = await fetch(`${base}/healthz`).then(
                (r) => r.ok,
                () => false
            );
            if (ok) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    });

    after(async () => {
        periscope?.kill('SIGTERM');
        jwks?.close();
        await container?.stop();
        await rm(dir, { recursive: true, force: true });
    });

    it('publishes protected resource metadata and challenges unauthenticated requests', async () => {
        const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
            string,
            unknown
        >;
        assert.equal(metadata.resource, `${base}/mcp`);
        assert.deepEqual(metadata.scopes_supported, [`${base}/mcp/Periscope.Access`]);
        assert.deepEqual(metadata.authorization_servers, [`https://login.microsoftonline.com/${TENANT}/v2.0`]);

        const unauthenticated = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(unauthenticated.status, 401);
        const challenge = unauthenticated.headers.get('www-authenticate') ?? '';
        assert.match(challenge, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
        assert.match(challenge, new RegExp(`scope="${base}/mcp/Periscope.Access"`));

        const wrongAudience = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${await mint({}, 'someone-else')}`, 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(wrongAudience.status, 401);
        const noRole = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${await mint({ roles: [] })}`, 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(noRole.status, 403);
        assert.equal((await fetch(`${base}/mcp`)).status, 405);
    });

    it('runs the full flow: list, describe, query, get_result, read_result, download', async () => {
        const client = await connect(await mint());
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
            'cancel_query',
            'describe',
            'get_result',
            'list_sources',
            'query',
            'read_result',
        ]);
        assert.ok(tools.tools.every((t) => t.annotations?.readOnlyHint === true));

        const sources = text(await client.callTool({ name: 'list_sources', arguments: {} })) as {
            sources: { name: string }[];
        };
        assert.deepEqual(
            sources.sources.map((s) => s.name),
            ['shop']
        );

        const rejected = await client.callTool({
            name: 'query',
            arguments: { source: 'shop', query: 'DELETE FROM items' },
        });
        assert.equal(rejected.isError, true);
        assert.equal((text(rejected).error as { code: string }).code, 'query_rejected');

        const unknown = await client.callTool({ name: 'query', arguments: { source: 'nope', query: 'SELECT 1' } });
        assert.equal((text(unknown).error as { code: string }).code, 'unknown_source');

        const described = text(
            await client.callTool({ name: 'describe', arguments: { source: 'shop', path: 'public.items' } })
        );
        assert.ok((described.columns as { name: string }[]).some((c) => c.name === 'price'));

        const started = text(
            await client.callTool({
                name: 'query',
                arguments: { source: 'shop', query: 'SELECT * FROM items ORDER BY id' },
            })
        );
        const resultId = started.resultId as string;
        let result = text(await client.callTool({ name: 'get_result', arguments: { resultId, wait: 10 } }));
        while (result.status === 'running' || result.status === 'queued') {
            result = text(await client.callTool({ name: 'get_result', arguments: { resultId, wait: 10 } }));
        }
        assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
        assert.equal(result.rowCount, 20000);
        const download = result.download as { manifestUrl: string; fileCount: number; bytes: number; format: string };
        assert.equal(download.format, 'parquet');
        assert.ok(download.fileCount >= 2);

        const window = text(
            await client.callTool({ name: 'read_result', arguments: { resultId, offset: 9999, limit: 2 } })
        );
        assert.deepEqual(window.rows, [
            [10000, 'item-10000', '5000.00'],
            [10001, 'item-10001', '5000.50'],
        ]);

        const manifestResponse = await fetch(download.manifestUrl);
        assert.equal(manifestResponse.status, 200);
        assert.equal(manifestResponse.headers.get('content-encoding'), null);
        assert.match(manifestResponse.headers.get('cache-control') ?? '', /no-transform/);
        const manifest = (await manifestResponse.json()) as {
            files: { path: string; sha256: string; rowCount: number; bytes: number }[];
        };
        const root = download.manifestUrl.replace(/manifest\.json$/, '');
        let rows = 0;
        for (const file of manifest.files) {
            const response = await fetch(`${root}${file.path}`);
            assert.equal(response.headers.get('content-type'), 'application/vnd.apache.parquet');
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
            const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const objects = await parquetReadObjects({
                file: arrayBuffer,
                metadata: parquetMetadata(arrayBuffer),
                compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdDecompressSync(input)) },
            });
            rows += objects.length;
        }
        assert.equal(rows, 20000);

        const first = manifest.files[0] as { path: string; bytes: number };
        const ranged = await fetch(`${root}${first.path}`, { headers: { range: 'bytes=4-13' } });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.headers.get('content-range'), `bytes 4-13/${first.bytes}`);
        assert.equal((await ranged.arrayBuffer()).byteLength, 10);

        const tampered = download.manifestUrl.replace(/\/r\/([^/]+)\.([^/]+)\//, '/r/$1.AAAA$2/');
        assert.equal((await fetch(tampered)).status, 403);
        assert.equal((await fetch(`${root}state.json`)).status, 404);
        await client.close();
    });

    it('works over stdio with a local download endpoint', async () => {
        const client = new Client({ name: 'e2e-stdio', version: '1.0.0' });
        await client.connect(
            new StdioClientTransport({
                command: process.execPath,
                args: ['src/index.ts'],
                env: {
                    ...(process.env as Record<string, string>),
                    ...sourceEnv,
                    PERISCOPE_TRANSPORT: 'stdio',
                    PERISCOPE_RESULTS_DIR: join(dir, 'stdio'),
                    PERISCOPE_LOG_LEVEL: 'warn',
                    PERISCOPE_AUDIT_LOG: join(dir, 'audit-stdio.log'),
                },
                stderr: 'inherit',
            })
        );
        const sources = text(await client.callTool({ name: 'list_sources', arguments: {} })) as { sources: unknown[] };
        assert.equal(sources.sources.length, 1);
        const started = text(
            await client.callTool({
                name: 'query',
                arguments: { source: 'shop', query: 'SELECT id FROM items WHERE id <= 5' },
            })
        );
        let result = text(
            await client.callTool({ name: 'get_result', arguments: { resultId: started.resultId, wait: 10 } })
        );
        while (result.status === 'running' || result.status === 'queued') {
            result = text(
                await client.callTool({ name: 'get_result', arguments: { resultId: started.resultId, wait: 10 } })
            );
        }
        assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
        const manifestUrl = (result.download as { manifestUrl: string }).manifestUrl;
        assert.match(manifestUrl, /^http:\/\/127\.0\.0\.1:\d+\/r\//);
        const manifest = (await (await fetch(manifestUrl)).json()) as { rowCount: number };
        assert.equal(manifest.rowCount, 5);
        await client.close();
    });
});
