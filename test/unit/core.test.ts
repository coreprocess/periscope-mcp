import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it, mock } from 'node:test';
import type { SourceConfig } from '../../src/config/sources.ts';
import { parseIsoDuration } from '../../src/core/duration.ts';
import { summaryOf, toPeriscopeError } from '../../src/core/errors.ts';
import { compileFilter, compileGlob } from '../../src/core/glob.ts';
import { isResultId, newResultId } from '../../src/core/ids.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { Signer } from '../../src/core/signing.ts';
import { createTruncator, toJson } from '../../src/core/values.ts';
import { decodeFileReference, encodeFileReference } from '../../src/results/files.ts';
import { parseRange } from '../../src/server/download.ts';
import type { SourceAdapter } from '../../src/sources/adapter.ts';
import { SourceRegistry } from '../../src/sources/registry.ts';

describe('durations', () => {
    it('parses ISO 8601 durations', () => {
        assert.equal(parseIsoDuration('PT24H'), 86_400_000);
        assert.equal(parseIsoDuration('P1DT30M'), 88_200_000);
        assert.equal(parseIsoDuration('PT0.5S'), 500);
        assert.throws(() => parseIsoDuration('P'));
        assert.throws(() => parseIsoDuration('1h'));
    });
});

describe('globs', () => {
    it('matches like the concept describes', () => {
        const pdfs = compileGlob('invoices/2026/**/*.pdf');
        assert.equal(pdfs.prefix, 'invoices/2026/');
        assert.equal(pdfs.matches('invoices/2026/a.pdf'), true);
        assert.equal(pdfs.matches('invoices/2026/01/02/a.pdf'), true);
        assert.equal(pdfs.matches('invoices/2026/a.txt'), false);
        assert.equal(compileGlob('logs/app-?.log').matches('logs/app-1.log'), true);
        assert.equal(compileGlob('logs/*.log').matches('logs/x/y.log'), false);
        assert.equal(compileGlob('exports/').matches('exports/a/b'), true);
        assert.equal(compileGlob('**/').matches('a/b/'), true);
        assert.equal(compileGlob('**/').matches('a/b'), false);
        assert.equal(compileGlob('a/**').matches('a/b/c'), true);
    });

    it('matches describe filters case-insensitively', () => {
        assert.equal(compileFilter('Order?')('orders'), true);
        assert.equal(compileFilter('*_log')('app.events_LOG'), true);
        assert.equal(compileFilter('*_log')('app.events'), false);
        assert.equal(compileFilter(undefined)('anything'), true);
    });

    it('matches hostile patterns in linear time', () => {
        const started = performance.now();
        assert.equal(compileFilter(`${'*a'.repeat(25)}b`)('a'.repeat(1000)), false);
        assert.equal(compileGlob(`${'**a'.repeat(25)}**b`).matches('a'.repeat(1000)), false);
        assert.ok(performance.now() - started < 1000);
    });
});

describe('ids and signing', () => {
    it('creates unguessable result ids', () => {
        const id = newResultId();
        assert.equal(isResultId(id), true);
        assert.notEqual(id, newResultId());
    });

    it('signs and verifies tokens and rejects tampering', () => {
        const signer = new Signer(randomBytes(32));
        const token = signer.signToken({ r: 'r_x', e: 1 });
        assert.deepEqual(signer.verifyToken(token), { r: 'r_x', e: 1 });
        assert.equal(signer.verifyToken(`${token}x`), undefined);
        assert.equal(new Signer(randomBytes(32)).verifyToken(token), undefined);
    });

    it('binds file references to one result', () => {
        const signer = new Signer(randomBytes(32));
        const reference = { container: 'docs', name: 'a dir/ü file.pdf', etag: '"0x8D1"' };
        const path = encodeFileReference(signer, 'r_one', reference);
        assert.deepEqual(decodeFileReference(signer, 'r_one', path), reference);
        assert.equal(decodeFileReference(signer, 'r_two', path), undefined);
        assert.equal(decodeFileReference(signer, 'r_one', path.replace('docs', 'other')), undefined);
        const version = encodeFileReference(signer, 'r_one', {
            container: 'c',
            name: 'n',
            versionId: '2026-01-01T00:00:00.0000000Z',
        });
        assert.equal(decodeFileReference(signer, 'r_one', version)?.versionId, '2026-01-01T00:00:00.0000000Z');
        // a linked file's announced size is signed with the reference
        const sized = { container: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9h', name: 'a.eml', size: 4312319 };
        const sizedPath = encodeFileReference(signer, 'r_one', sized);
        assert.deepEqual(decodeFileReference(signer, 'r_one', sizedPath), sized);
        assert.equal(decodeFileReference(signer, 'r_one', sizedPath.replace('z~4312319', 'z~1')), undefined);
    });
});

describe('values', () => {
    it('serializes bigint and binary', () => {
        assert.equal(
            toJson({ a: 1n, b: 2n ** 64n, c: new Uint8Array([1, 2]) }),
            '{"a":1,"b":"18446744073709551616","c":"AQI="}'
        );
    });

    it('truncates long values in windows and counts them', () => {
        const truncator = createTruncator({ maxValueChars: 5 });
        assert.match(String(truncator.render('abcdefgh')), /^abcde… \[string truncated, 8 chars\]$/);
        assert.equal(truncator.render(Array.from({ length: 64 }, () => 0.5)), '<vector dim=64>');
        assert.equal(truncator.render(new Uint8Array(3)), '<binary 3 bytes>');
        assert.equal(truncator.render('abc'), 'abc');
        assert.equal(truncator.truncated, 3);
    });
});

describe('download ranges', () => {
    it('parses single byte ranges', () => {
        assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
        assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
        assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
        assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
        assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
        assert.equal(parseRange('bytes=0-1,5-6', 100), undefined);
        assert.equal(parseRange(undefined, 100), undefined);
    });
});

describe('errors for clients', () => {
    it('shows the first line of a foreign error and keeps the rest as cause', () => {
        const sdk = new Error('Resource Not Found\r\nActivityId: 1, Request URI: /apps/x/services/y, RequestStats: …');
        assert.equal(summaryOf(sdk), 'Resource Not Found');
        assert.equal(summaryOf(new Error('x'.repeat(400))).length, 300);
        const wrapped = toPeriscopeError(sdk, 'source_error');
        assert.equal(wrapped.message, 'Resource Not Found');
        assert.equal(wrapped.cause, sdk);
    });
});

describe('source registry', () => {
    /** A source whose first `failures` initializations fail with a multi-line error. */
    const flakyAdapter = (failures: number): SourceAdapter => {
        let attempts = 0;
        return {
            config: { name: 'flaky', type: 'redis' } as SourceConfig,
            init: async () => {
                attempts++;
                if (attempts > failures) return;
                throw new Error('token request failed\nat credential chain, host internal.example.com');
            },
            info: () => ({ name: 'flaky', type: 'redis' }) as ReturnType<SourceAdapter['info']>,
            describe: async () => ({}),
            validate: async (query) => ({ query, params: null, options: {} }),
            execute: async () => {
                throw new Error('not used');
            },
            close: async () => undefined,
        };
    };

    it('reports a short reason and retries a failed source once its retry time has come', async () => {
        mock.timers.enable({ apis: ['Date'] });
        try {
            const registry = new SourceRegistry([{ name: 'flaky' } as SourceConfig], nullLoggers().log, () =>
                flakyAdapter(1)
            );
            await registry.initAll();
            assert.deepEqual(registry.status('flaky'), { available: false, error: 'token request failed' });
            registry.retryDue();
            await registry.settle(1000);
            assert.equal(registry.status('flaky').available, false, 'no retry before the retry time');
            mock.timers.tick(60_001);
            registry.retryDue();
            await registry.settle(1000);
            assert.deepEqual(registry.status('flaky'), { available: true });
        } finally {
            mock.timers.reset();
        }
    });
});
