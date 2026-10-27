import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { RestSourceConfig } from '../../config/sources.ts';
import { isPeriscopeError, PeriscopeError, QueryRejectedError, summaryOf, WireGuardError } from '../../core/errors.ts';
import { isTextual } from '../../core/media.ts';
import type {
    DocumentStream,
    ExecutionContext,
    FileContent,
    FileProvider,
    FileReference,
    PreparedQuery,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { parseOptions, remaining } from '../common.ts';
import {
    type AllowRule,
    compileRules,
    DEFAULT_AGENT_HEADERS,
    parseRequestText,
    type RestRequest,
    rejectionOf,
    resolveTarget,
} from './guard.ts';
import { cloneRequest, type HookContext, loadScript, type RestScript, toOutcome, toRequest } from './script.ts';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** How long the script's `check` may take while a query is validated. */
const CHECK_TIMEOUT_MS = 30_000;
const ERROR_BODY_CHARS = 300;

/** Fails the body stream once it exceeds `maxBytes`, so no response can exhaust memory. */
const limitBody = (response: Response, maxBytes: number): Response => {
    if (!response.body || NULL_BODY_STATUSES.has(response.status)) return response;
    let seen = 0;
    const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                seen += chunk.byteLength;
                if (seen > maxBytes) {
                    controller.error(
                        new PeriscopeError('too_large', `The response exceeds MAX_RESPONSE_BYTES (${maxBytes})`)
                    );
                } else {
                    controller.enqueue(chunk);
                }
            },
        })
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** Bytes `[offset, offset + length)` of a stream that starts at byte 0. */
async function* sliceStream(stream: AsyncIterable<Buffer>, offset: number, length: number): AsyncGenerator<Buffer> {
    const end = offset + length;
    let position = 0;
    for await (const chunk of stream) {
        const from = Math.max(offset - position, 0);
        const to = Math.min(end - position, chunk.length);
        if (to > from) yield chunk.subarray(from, to);
        position += chunk.length;
        if (position >= end) return;
    }
}

const mediaTypeOf = (response: Response): string =>
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

const contentLengthOf = (response: Response): number | null => {
    const value = Number(response.headers.get('content-length') ?? Number.NaN);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/** Decodes percent-encoding, keeping the text as it is where it is not valid. */
const decodeLenient = (text: string): string => {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
};

/**
 * The name a linked file is served under: the given name, or else the last path segment of its URL. Path separators
 * and control characters become `_`, so the name stays one segment of the link.
 */
const fileNameOf = (url: string, name?: string): string => {
    const given =
        name ??
        new URL(url).pathname
            .split('/')
            .filter((segment) => segment.length > 0)
            .at(-1);
    const clean = [...decodeLenient(given ?? '')]
        .map((char) => (char === '/' || char === '\\' || char.charCodeAt(0) < 0x20 || char === '\x7f' ? '_' : char))
        .join('')
        .trim()
        .slice(0, 255);
    return clean || 'file';
};

/** The file name a response declares in `Content-Disposition` (`filename*` before `filename`), if any. */
const dispositionName = (response: Response): string | undefined => {
    const header = response.headers.get('content-disposition') ?? '';
    const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
    if (extended) return decodeLenient(extended.trim());
    return /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header)?.slice(1).find(Boolean)?.trim();
};

/**
 * Any HTTP API, read through an operator-declared allowlist of `METHOD pattern` rules and an optional script that
 * signs requests in, pages and shapes responses (concept §7.1 C).
 */
export class RestAdapter implements SourceAdapter, FileProvider {
    readonly config: RestSourceConfig;
    readonly #rules: AllowRule[];
    readonly #agentHeaders: ReadonlySet<string>;
    readonly #vars: Readonly<Record<string, string>>;
    #script: RestScript = {};

    constructor(config: RestSourceConfig) {
        this.config = config;
        this.#rules = compileRules(config.baseUrl, config.allow);
        this.#agentHeaders = new Set([...DEFAULT_AGENT_HEADERS, ...config.allowHeaders]);
        this.#vars = Object.freeze({ ...config.vars });
    }

    async init(_log: Logger): Promise<void> {
        if (this.config.script) this.#script = await loadScript(this.config.name, this.config.script);
    }

    get files(): FileProvider {
        return this;
    }

    info(): SourceInfo {
        return {
            name: this.config.name,
            type: 'rest',
            description: this.config.description,
            queryLanguage: 'HTTP request: a request line (METHOD URL), optional header lines, a blank line, a body',
            dialectHints: [
                `Write paths starting with / to address ${this.config.baseUrl}/…; absolute URLs are taken as they are.`,
                `Allowed requests: ${this.config.allow.join(', ')} (HEAD wherever GET is allowed).`,
                `Headers you may set: ${[...this.#agentHeaders].join(', ')}. Credentials are added by Periscope.`,
                this.#script.transform
                    ? 'A script shapes the responses and pages through them; describe explains this API.'
                    : 'JSON responses: an array becomes one document per element, anything else one document. Text becomes { text }; binary content of a GET becomes a file link.',
                ...(this.config.guide ? ['describe returns the usage guide for this API.'] : []),
            ],
            options: {},
            params: 'not used; write the request into the query',
            readOnlyLayers: [
                `request allowlist on every request, page, redirect hop and file read: ${this.config.allow.join(', ')}`,
                'no method override (headers or query parameters), no dot segments, encoded slashes or user info',
                ...(this.#script.check ? ['script check of every request'] : []),
            ],
            credential: 'unverified',
            credentialNote: 'The API grants what its credential may do; the allowlist keeps requests to reads',
        };
    }

    async describe(): Promise<unknown> {
        return {
            baseUrl: this.config.baseUrl,
            allow: this.config.allow,
            headers: [...this.#agentHeaders],
            guide: this.config.guide ?? null,
        };
    }

    async validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        parseOptions(z.object({}).strict(), options);
        const empty = params === undefined || params === null || (Array.isArray(params) && params.length === 0);
        if (!empty && !(typeof params === 'object' && Object.keys(params as object).length === 0)) {
            throw new PeriscopeError(
                'invalid_argument',
                'REST queries take no params; write the request into the query'
            );
        }
        let request: RestRequest;
        try {
            request = parseRequestText(this.config.baseUrl, query);
        } catch (error) {
            throw new QueryRejectedError(summaryOf(error));
        }
        const reason = await this.#rejection(request, AbortSignal.timeout(CHECK_TIMEOUT_MS), this.#agentHeaders);
        if (reason) throw new QueryRejectedError(reason);
        return { query, params: undefined, options: {}, plan: request };
    }

    #context(signal: AbortSignal): HookContext {
        return { vars: this.#vars, fetch: globalThis.fetch, signal };
    }

    /** Runs a script hook; its own errors become source errors, cancellation passes through. */
    async #hook<T>(name: string, signal: AbortSignal, call: () => T): Promise<Awaited<T>> {
        try {
            return await call();
        } catch (error) {
            if (signal.aborted || isPeriscopeError(error)) throw error;
            throw new PeriscopeError('source_error', `SCRIPT ${name} failed: ${summaryOf(error)}`, undefined, {
                cause: error,
            });
        }
    }

    /** Why the allowlist or the script's `check` refuses a request, or undefined. */
    async #rejection(
        request: RestRequest,
        signal: AbortSignal,
        agentHeaders?: ReadonlySet<string>
    ): Promise<string | undefined> {
        const reason = rejectionOf(this.#rules, request, agentHeaders);
        if (reason) return reason;
        const check = this.#script.check;
        if (!check) return undefined;
        try {
            await check(cloneRequest(request), this.#context(signal));
            return undefined;
        } catch (error) {
            if (signal.aborted) throw error;
            return summaryOf(error);
        }
    }

    /** Checks a request, lets the script prepare it, and checks what it prepared: the wire guard. */
    async #prepare(request: RestRequest, signal: AbortSignal): Promise<RestRequest> {
        const reason = await this.#rejection(request, signal);
        if (reason) throw new WireGuardError(this.config.name, reason);
        const prepare = this.#script.prepare;
        let prepared = request;
        if (prepare) {
            const draft = cloneRequest(request);
            const returned = await this.#hook('prepare', signal, () => prepare(draft, this.#context(signal)));
            prepared = toRequest(returned ?? draft, 'prepare');
        }
        const after = rejectionOf(this.#rules, prepared);
        if (after) throw new WireGuardError(this.config.name, after);
        return prepared;
    }

    /** Sends a request through the wire guard, following redirects hop by hop, each one guarded and prepared again. */
    async #send(request: RestRequest, signal: AbortSignal): Promise<Response> {
        let current = request;
        for (let hop = 0; ; hop++) {
            const prepared = await this.#prepare(current, signal);
            let response: Response;
            try {
                response = await fetch(prepared.url, {
                    method: prepared.method,
                    headers: prepared.headers,
                    ...(prepared.body === undefined ? {} : { body: prepared.body }),
                    redirect: 'manual',
                    signal,
                });
            } catch (error) {
                if (signal.aborted) throw error;
                throw new PeriscopeError('source_error', `Request failed: ${summaryOf(error)}`, undefined, {
                    cause: error,
                });
            }
            const location = response.headers.get('location');
            if (!REDIRECTS.has(response.status) || !location) return response;
            await response.body?.cancel();
            if (hop >= MAX_REDIRECTS) throw new PeriscopeError('source_error', 'Too many redirects');
            const keepMethod = response.status === 307 || response.status === 308 || current.method === 'HEAD';
            const { 'content-type': _, ...headers } = current.headers;
            current = keepMethod
                ? { ...current, url: new URL(location, prepared.url).href }
                : { method: 'GET', url: new URL(location, prepared.url).href, headers, body: undefined };
        }
    }

    /** Documents of a response without a `transform`: JSON as is, text as `{ text }`, binary as a file link. */
    async #documents(
        response: Response,
        request: RestRequest,
        link: (url: string, size: number | null, name?: string) => string
    ): Promise<unknown[]> {
        if (!response.ok) {
            const text = (await response.text()).trim().slice(0, ERROR_BODY_CHARS);
            throw new PeriscopeError(
                'source_error',
                `HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`.trim()
            );
        }
        const contentType = mediaTypeOf(response);
        if (request.method === 'HEAD' || NULL_BODY_STATUSES.has(response.status)) {
            return [{ status: response.status, contentType: contentType || null, size: contentLengthOf(response) }];
        }
        if (contentType === 'application/json' || contentType.endsWith('+json')) {
            const text = await response.text();
            if (text.trim() === '') return [];
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch (error) {
                throw new PeriscopeError('source_error', `The response is not valid JSON: ${summaryOf(error)}`);
            }
            return Array.isArray(body) ? body : [body];
        }
        if (isTextual(contentType, new URL(request.url).pathname)) return [{ text: await response.text() }];
        if (request.method !== 'GET') {
            throw new PeriscopeError(
                'invalid_argument',
                `The ${request.method} response is binary (${contentType || 'no content type'}); only GET responses are linked as files`
            );
        }
        await response.body?.cancel();
        const size = contentLengthOf(response);
        return [{ contentType: contentType || null, size, file: link(request.url, size, dispositionName(response)) }];
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<DocumentStream> {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(remaining(context.deadline))]);
        let files = 0;
        let fileBytes = 0;
        const link = (url: string, size: number | null, name?: string): string => {
            const target = resolveTarget(this.config.baseUrl, url);
            const reason = target
                ? rejectionOf(this.#rules, { method: 'GET', url: target, headers: {}, body: undefined })
                : `'${url}' must be a path starting with / or an absolute http(s) URL`;
            if (!target || reason) throw new PeriscopeError('source_error', `Cannot link the file: ${reason}`);
            files++;
            fileBytes += size ?? 0;
            return context.fileReference({
                container: Buffer.from(target).toString('base64url'),
                name: fileNameOf(target, name),
            });
        };
        const transform = this.#script.transform;
        const { maxRequests, maxResponseBytes } = this.config;
        const respond = async (request: RestRequest, response: Response) => {
            if (!transform) return { documents: await this.#documents(response, request, link), next: undefined };
            const file = (url: string, name?: unknown, size?: unknown) =>
                link(
                    url,
                    Number.isSafeInteger(size) && (size as number) >= 0 ? (size as number) : null,
                    typeof name === 'string' && name !== '' ? name : undefined
                );
            const transformContext = { ...this.#context(signal), request, file };
            return toOutcome(await this.#hook('transform', signal, () => transform(response, transformContext)));
        };
        const send = (request: RestRequest) => this.#send(request, signal);
        const batches = async function* (): AsyncGenerator<unknown[]> {
            let request: RestRequest | undefined = prepared.plan as RestRequest;
            for (let count = 0; request; count++) {
                if (count >= maxRequests) {
                    throw new PeriscopeError(
                        'limit_exceeded',
                        `The query needs more than MAX_REQUESTS (${maxRequests})`
                    );
                }
                const response = limitBody(await send(request), maxResponseBytes);
                context.addCost({ requests: 1 });
                // a body left unread (or a transform that failed halfway) still releases its connection
                const outcome = await respond(request, response).finally(() =>
                    response.bodyUsed ? undefined : response.body?.cancel().catch(() => undefined)
                );
                if (outcome.documents.length > 0) yield outcome.documents;
                request = outcome.next;
            }
        };
        return { format: 'ndjson', batches: batches(), blobTotals: () => ({ count: files, bytes: fileBytes }) };
    }

    /**
     * Serves a linked file by fetching its URL again through the wire guard; ranges are honored either way. The
     * reference holds the URL base64url-encoded, so a link has no encoded slash a gateway could decode.
     */
    async openFile(reference: FileReference, range?: { offset: number; length: number }): Promise<FileContent> {
        const url = Buffer.from(reference.container, 'base64url').toString();
        const signal = AbortSignal.timeout(this.config.maxQueryDurationMs);
        const headers: Record<string, string> = { 'accept-encoding': 'identity' };
        if (range) headers.range = `bytes=${range.offset}-${range.offset + Math.max(range.length, 1) - 1}`;
        const response = await this.#send({ method: 'GET', url, headers, body: undefined }, signal);
        if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404 || response.status === 410) {
                throw new PeriscopeError('not_found', 'The file no longer exists at the source');
            }
            if (response.status === 416)
                throw new PeriscopeError('invalid_argument', 'Requested range not satisfiable');
            throw new PeriscopeError('source_error', `HTTP ${response.status} ${response.statusText}`.trim());
        }
        const contentType = mediaTypeOf(response) || 'application/octet-stream';
        const etag =
            response.headers.get('etag') ?? `"${createHash('sha256').update(url).digest('base64url').slice(0, 22)}"`;
        const body = response.body
            ? Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
            : Readable.from([] as Buffer[]);
        const partial = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
        if (response.status === 206 && partial) {
            const [, start, end, total] = partial as unknown as [string, string, string, string];
            return {
                size: total === '*' ? Number(end) + 1 : Number(total),
                contentType,
                etag,
                stream: body,
                range: { start: Number(start), end: Number(end) },
            };
        }
        if (response.status === 206) {
            body.destroy();
            throw new PeriscopeError(
                'source_error',
                'The source answered a range request without a valid Content-Range'
            );
        }
        let size = contentLengthOf(response);
        let stream: Readable = body;
        if (size === null) {
            // without a length the size is only known once the whole content is read
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of body as AsyncIterable<Buffer>) {
                total += chunk.length;
                if (total > this.config.maxResponseBytes) {
                    body.destroy();
                    throw new PeriscopeError('too_large', 'The file has no length and exceeds MAX_RESPONSE_BYTES');
                }
                chunks.push(chunk);
            }
            size = total;
            stream = Readable.from([Buffer.concat(chunks)]);
        }
        if (!range) return { size, contentType, etag, stream };
        const end = Math.min(range.offset + Math.max(range.length, 1), size);
        return {
            size,
            contentType,
            etag,
            stream: Readable.from(sliceStream(stream, range.offset, end - range.offset)),
            range: { start: range.offset, end: end - 1 },
        };
    }

    async close(): Promise<void> {
        // nothing to close: every request is a fetch of its own
    }
}
