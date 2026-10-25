import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { BlobSourceConfig } from '../../src/config/sources.ts';
import { WireGuardError } from '../../src/core/errors.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { Signer } from '../../src/core/signing.ts';
import { readFileWindow } from '../../src/results/file-window.ts';
import { decodeFileReference } from '../../src/results/files.ts';
import { BlobAdapter } from '../../src/sources/blob/adapter.ts';
import { createResultHarness, type ResultHarness } from '../helpers/results.ts';

const ACCOUNT = 'devstoreaccount1';
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

describe('blob source', () => {
    let container: StartedTestContainer;
    let admin: BlobServiceClient;
    let adapter: BlobAdapter;
    let harness: ResultHarness;
    let connectionString: string;

    before(async () => {
        container = await new GenericContainer('mcr.microsoft.com/azure-storage/azurite')
            .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'])
            .withExposedPorts(10000)
            .withWaitStrategy(Wait.forLogMessage(/Azurite Blob service successfully listens/))
            .start();
        connectionString = `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};BlobEndpoint=http://${container.getHost()}:${container.getMappedPort(10000)}/${ACCOUNT};`;
        admin = BlobServiceClient.fromConnectionString(connectionString);
        const docs = admin.getContainerClient('docs');
        await docs.create();
        const log = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
        const uploads: [string, string | Buffer, string][] = [
            ['invoices/2026/01/a.pdf', '%PDF-1.4 fake', 'application/pdf'],
            ['invoices/2026/02/b.pdf', '%PDF-1.4 fake b', 'application/pdf'],
            ['invoices/2025/c.pdf', '%PDF-1.4 old', 'application/pdf'],
            ['logs/app.log', log, 'text/plain'],
            ['logs/no-newline.txt', 'one\ntwo\nthree', 'text/plain'],
            ['images/pixel.png', PNG, 'image/png'],
        ];
        for (const [name, body, type] of uploads) {
            await docs.getBlockBlobClient(name).uploadData(Buffer.from(body), {
                blobHTTPHeaders: { blobContentType: type },
                metadata: { source: 'test' },
            });
        }
        const config: BlobSourceConfig = {
            index: 0,
            type: 'blob',
            name: 'files',
            description: undefined,
            maxQueryDurationMs: 60_000,
            maxResultBytes: 1024 ** 3,
            connectionString,
            accountUrl: undefined,
            sas: undefined,
            azureAuth: false,
            container: 'docs',
        };
        adapter = new BlobAdapter(config);
        await adapter.init(nullLoggers().log);
        harness = await createResultHarness();
    });

    after(async () => {
        await harness?.dispose();
        await container?.stop();
    });

    it('lists blobs matching a glob, with signed file references', async () => {
        const resultId = await harness.run(adapter, 'invoices/2026/**/*.pdf', undefined, { include: ['metadata'] });
        const { manifest } = await harness.service.snapshot(resultId);
        assert.equal(manifest.status, 'succeeded', JSON.stringify(manifest.error));
        assert.equal(manifest.rowCount, 2);
        assert.equal(manifest.blobCount, 2);
        const window = await harness.service.readRows(resultId, 0, 10, ['name', 'size', 'metadata', 'file']);
        assert.deepEqual(
            window.rows.map((r) => r[0]),
            ['invoices/2026/01/a.pdf', 'invoices/2026/02/b.pdf']
        );
        assert.deepEqual(window.rows[0]?.[2], { source: 'test' });
        assert.match(String(window.rows[0]?.[3]), /^files\/[A-Za-z0-9_-]{22}\/e~/);
    });

    it('reads text by line windows and images inline, pinned to the listed version', async () => {
        const resultId = await harness.run(adapter, 'logs/**');
        const window = await harness.service.readRows(resultId, 0, 10, ['name', 'file']);
        const files = Object.fromEntries(window.rows.map((r) => [r[0], String(r[1])]));
        const store = harness.service.store;
        const logRef = { container: 'docs', name: 'logs/app.log', etag: undefined as string | undefined };
        const props = await admin.getContainerClient('docs').getBlobClient('logs/app.log').getProperties();
        logRef.etag = props.etag;
        const text = await readFileWindow({
            store,
            resultId,
            file: files['logs/app.log'] as string,
            reference: logRef as never,
            provider: adapter,
            lineOffset: 1998,
            lineLimit: 4,
            maxBytes: 65_536,
        });
        assert.equal(text.kind, 'text');
        if (text.kind === 'text') {
            assert.deepEqual(text.lines, ['line 1998', 'line 1999', 'line 2000', 'line 2001']);
            assert.equal(text.nextLineOffset, 2002);
        }
        const tail = await readFileWindow({
            store,
            resultId,
            file: files['logs/no-newline.txt'] as string,
            reference: { container: 'docs', name: 'logs/no-newline.txt' },
            provider: adapter,
            lineOffset: 0,
            lineLimit: 10,
            maxBytes: 65_536,
        });
        assert.ok(tail.kind === 'text' && tail.totalLines === 3 && tail.lines[2] === 'three');

        const image = await readFileWindow({
            store,
            resultId,
            file: 'x',
            reference: { container: 'docs', name: 'images/pixel.png' },
            provider: adapter,
            lineOffset: 0,
            lineLimit: 1,
            maxBytes: 65_536,
        });
        assert.ok(image.kind === 'image' && image.mimeType === 'image/png');

        await admin.getContainerClient('docs').getBlockBlobClient('logs/app.log').uploadData(Buffer.from('changed'));
        await assert.rejects(adapter.openFile(logRef as never), /changed after the query/);
    });

    it('verifies file reference MACs per result', () => {
        const signer = new Signer(randomBytes(32));
        assert.equal(decodeFileReference(signer, 'r_x', 'files/AAAAAAAAAAAAAAAAAAAAAA/e~1/docs/a.txt'), undefined);
    });

    it('blocks every write on the wire', async () => {
        const { createBlobClient } = await import('../../src/sources/blob/client.ts');
        const { client } = createBlobClient(adapter.config);
        const docs = client.getContainerClient('docs');
        const blob = docs.getBlockBlobClient('invoices/2026/01/a.pdf');
        const attempts: [string, () => Promise<unknown>][] = [
            ['upload', () => blob.uploadData(Buffer.from('evil'))],
            ['delete', () => blob.delete()],
            ['metadata', () => blob.setMetadata({ a: 'b' })],
            ['tags', () => blob.setTags({ a: 'b' })],
            ['lease', () => blob.getBlobLeaseClient().acquireLease(15)],
            ['snapshot', () => blob.createSnapshot()],
            ['copy', () => docs.getBlobClient('copy.pdf').syncCopyFromURL(blob.url)],
            ['container create', () => client.getContainerClient('evil').create()],
            ['container delete', () => docs.delete()],
        ];
        for (const [name, attempt] of attempts) {
            await assert.rejects(
                attempt(),
                (error: unknown) => error instanceof WireGuardError || /Blocked/.test(String(error)),
                name
            );
        }
        const content = await admin
            .getContainerClient('docs')
            .getBlobClient('invoices/2026/01/a.pdf')
            .downloadToBuffer();
        assert.equal(content.toString(), '%PDF-1.4 fake');
    });

    it('describes containers and prefixes', async () => {
        const top = (await adapter.describe(undefined, undefined)) as { containers: { name: string }[] };
        assert.ok(top.containers.some((c) => c.name === 'docs'));
        const level = (await adapter.describe('docs/invoices', undefined)) as { prefixes: string[] };
        assert.deepEqual(level.prefixes.sort(), ['invoices/2025/', 'invoices/2026/']);
    });
});
