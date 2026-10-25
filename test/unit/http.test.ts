import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config/env.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { Signer } from '../../src/core/signing.ts';
import { createHttpApp } from '../../src/server/http.ts';
import { SourceRegistry } from '../../src/sources/registry.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

/** Raw request, so the Host and Origin headers can be set like a DNS-rebinding page would send them. */
const status = (port: number, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/healthz', headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        })
            .on('error', reject)
            .end();
    });

describe('http app without authorization (localhost)', () => {
    let harness: ResultHarness;
    let server: Server;
    let port: number;

    before(async () => {
        harness = await createResultHarness();
        const config = loadConfig({
            PERISCOPE_TRANSPORT: 'http',
            PERISCOPE_HOST: '127.0.0.1',
            PERISCOPE_PORT: '0',
            PERISCOPE_AUTH: 'none',
            PERISCOPE_RESULTS_STORE: 'filesystem',
        });
        const loggers = nullLoggers();
        const signer = new Signer(config.download.signingKey);
        const registry = new SourceRegistry([], loggers.log);
        const context = { config, service: harness.service, registry, signer, loggers, publicUrl: () => '' };
        const app = createHttpApp(
            config,
            context,
            { store: harness.service.store, signer, registry, loggers },
            { mcp: true }
        );
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        port = (server.address() as AddressInfo).port;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await harness.dispose();
    });

    it('serves localhost clients, with or without a localhost origin', async () => {
        assert.equal(await status(port, { host: `127.0.0.1:${port}` }), 200);
        assert.equal(await status(port, { host: `localhost:${port}`, origin: `http://localhost:${port}` }), 200);
    });

    it('rejects DNS rebinding and cross-site requests', async () => {
        assert.equal(await status(port, { host: `rebind.example.com:${port}` }), 403);
        assert.equal(await status(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example.com' }), 403);
    });
});
