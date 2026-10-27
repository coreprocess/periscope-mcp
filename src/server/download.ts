import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { isPeriscopeError, type PeriscopeError } from '../core/errors.ts';
import type { Loggers } from '../core/logger.ts';
import type { Signer } from '../core/signing.ts';
import { decodeFileReference } from '../results/files.ts';
import { getJson, type ResultStore } from '../results/store/store.ts';
import { MANIFEST_PATH, type Manifest } from '../results/types.ts';
import type { SourceRegistry } from '../sources/registry.ts';

/**
 * Data plane (concept §6.4): `GET|HEAD /r/<token>/<path>`. Files are served exactly as
 * stored with strong ETags and single-range support; nothing is compressed in transit.
 * Only the manifest, parts, indexes and referenced blob contents are reachable.
 */

const SERVABLE =
    /^(manifest\.json|part-\d{4}\.(parquet|ndjson\.gz)|index\/part-\d{4}\.json|index\/files\/[0-9a-f]{32}\.json)$/;

const contentTypeOf = (path: string): string => {
    if (path.endsWith('.parquet')) return 'application/vnd.apache.parquet';
    if (path.endsWith('.ndjson.gz')) return 'application/gzip';
    return 'application/json';
};

/** RFC 6266: an ASCII `filename` for old clients and the exact name as UTF-8 in `filename*`. */
const contentDisposition = (name: string): string => {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

interface ByteRange {
    start: number;
    end: number;
}

/** Parses a single `bytes=` range. Returns 'unsatisfiable' or undefined (serve whole file). */
export const parseRange = (header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined => {
    if (!header) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return undefined; // multi-range or malformed: serve the whole file
    const [, from, to] = match;
    if (from === '' && to === '') return undefined;
    let start: number;
    let end: number;
    if (from === '') {
        const suffix = Number(to);
        if (suffix === 0) return 'unsatisfiable';
        start = Math.max(size - suffix, 0);
        end = size - 1;
    } else {
        start = Number(from);
        end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
    }
    if (start >= size || start > end) return 'unsatisfiable';
    return { start, end };
};

const statusOf = (error: PeriscopeError): number => {
    switch (error.code) {
        case 'not_found':
            return 404;
        case 'expired':
            return 410;
        case 'precondition_failed':
            return 412;
        case 'forbidden':
        case 'unauthorized':
            return 403;
        case 'invalid_argument':
            return 400;
        default:
            return 500;
    }
};

export interface DownloadDeps {
    store: ResultStore;
    signer: Signer;
    registry: SourceRegistry;
    loggers: Loggers;
}

export const downloadHandler =
    (deps: DownloadDeps) =>
    async (req: Request, res: Response): Promise<void> => {
        const params = req.params as unknown as { token: string };
        // the path as sent, still percent-encoded: file references decode their segments themselves, and a
        // decoded `%2F` or `%25` would change them (`/r/<token>/<rest>`)
        const rest = req.path.split('/').slice(3).join('/');
        const payload = deps.signer.verifyToken(params.token);
        const deny = (status: number, message: string): void => {
            res.status(status)
                .type('application/json')
                .send(`${JSON.stringify({ error: message })}\n`);
        };
        if (!payload || typeof payload.r !== 'string' || typeof payload.e !== 'number') {
            deny(403, 'invalid download token');
            return;
        }
        if (payload.e * 1000 < Date.now()) {
            deny(403, 'download URL expired; call get_result for a fresh one');
            return;
        }
        const resultId = payload.r;
        res.setHeader('Cache-Control', 'private, no-store, no-transform');
        res.setHeader('Accept-Ranges', 'bytes');
        try {
            const manifest = await getJson<Manifest>(deps.store, `${resultId}/${MANIFEST_PATH}`);
            if (!manifest) {
                deny(404, 'result not found');
                return;
            }
            if (Date.now() > Date.parse(manifest.expiresAt)) {
                deny(410, 'result expired');
                return;
            }

            let size: number;
            let etag: string;
            let contentType: string;
            let open: (range?: ByteRange) => Promise<Readable>;
            let fileName = basename(rest);
            if (rest.startsWith('files/')) {
                const reference = decodeFileReference(deps.signer, resultId, rest);
                const adapter = reference ? await deps.registry.get(manifest.source) : undefined;
                if (!reference || !adapter?.files) {
                    deny(404, 'file not found');
                    return;
                }
                const files = adapter.files;
                fileName = basename(reference.name);
                const head = await files.openFile(reference, { offset: 0, length: 1 });
                head.stream.destroy();
                size = head.size;
                etag = head.etag;
                contentType = head.contentType;
                open = async (range) =>
                    (
                        await files.openFile(
                            reference,
                            range ? { offset: range.start, length: range.end - range.start + 1 } : undefined
                        )
                    ).stream;
            } else if (SERVABLE.test(rest)) {
                const path = `${resultId}/${rest}`;
                if (
                    rest !== MANIFEST_PATH &&
                    !manifest.files.some((p) => p.path === rest || p.index === rest) &&
                    !rest.startsWith('index/files/')
                ) {
                    deny(404, 'file not found');
                    return;
                }
                const info = await deps.store.head(path);
                if (!info) {
                    deny(404, 'file not found');
                    return;
                }
                size = info.size;
                etag = info.etag.startsWith('"') ? info.etag : `"${info.etag}"`;
                contentType = contentTypeOf(rest);
                open = (range) =>
                    deps.store.stream(
                        path,
                        range ? { offset: range.start, length: range.end - range.start + 1 } : undefined
                    );
            } else {
                deny(404, 'file not found');
                return;
            }

            res.setHeader('ETag', etag);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', contentDisposition(fileName));
            if (req.headers['if-none-match'] === etag) {
                res.status(304).end();
                return;
            }
            const ifRange = req.headers['if-range'];
            const range = ifRange && ifRange !== etag ? undefined : parseRange(req.headers.range, size);
            if (range === 'unsatisfiable') {
                res.setHeader('Content-Range', `bytes */${size}`);
                res.status(416).end();
                return;
            }
            if (range) {
                res.status(206);
                res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
                res.setHeader('Content-Length', String(range.end - range.start + 1));
            } else {
                res.status(200);
                res.setHeader('Content-Length', String(size));
            }
            deps.loggers.audit.info(
                {
                    resultId,
                    source: manifest.source,
                    issuedTo: payload.u,
                    path: rest.startsWith('files/') ? rest.split('/').slice(3).join('/') : rest,
                    bytes: range ? range.end - range.start + 1 : size,
                    range: req.headers.range ?? null,
                    client: req.ip,
                },
                'download'
            );
            if (req.method === 'HEAD' || size === 0) {
                res.end();
                return;
            }
            await pipeline(await open(range), res);
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (isPeriscopeError(error)) deny(statusOf(error), error.message);
            else {
                deps.loggers.log.error({ err: error, resultId }, 'download failed');
                deny(500, 'Download failed');
            }
        }
    };
