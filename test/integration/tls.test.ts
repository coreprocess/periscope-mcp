import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { parseSources } from '../../src/config/env.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { trustCertificates } from '../../src/core/tls.ts';
import { RestAdapter } from '../../src/sources/rest/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

/** A self-signed certificate (test only), like an internal CA's: unknown to Node until it is trusted. */
const CERTIFICATE = readFileSync(new URL('../fixtures/tls-test.crt', import.meta.url), 'utf8');
const KEY = readFileSync(new URL('../fixtures/tls-test.key', import.meta.url), 'utf8');

describe('additional CA certificates', () => {
    let server: Server;
    let harness: ResultHarness;
    let adapter: RestAdapter;

    before(async () => {
        server = createServer({ cert: CERTIFICATE, key: KEY }, (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([{ ok: true }]));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const [config] = parseSources(
            {
                PERISCOPE_SOURCE_N: '1',
                PERISCOPE_SOURCE_0_NAME: 'internal',
                PERISCOPE_SOURCE_0_TYPE: 'rest',
                PERISCOPE_SOURCE_0_BASE_URL: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
            },
            { maxQueryDurationMs: 30_000, maxResultBytes: 1024 ** 3 }
        );
        adapter = new RestAdapter(config as never);
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness();
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await harness.dispose();
    });

    it('rejects a server certificate of an unknown CA, and accepts it once the CA is trusted', async () => {
        const untrusted = (await harness.service.snapshot(await harness.run(adapter, 'GET /items'))).manifest;
        assert.equal(untrusted.status, 'failed');
        assert.match(untrusted.error?.message ?? '', /Request failed/);

        trustCertificates([CERTIFICATE]);
        const resultId = await harness.run(adapter, 'GET /items');
        assert.equal((await harness.service.snapshot(resultId)).manifest.status, 'succeeded');
        assert.deepEqual((await harness.service.readRows(resultId, 0, 1, ['ok'])).rows, [[true]]);
    });
});
