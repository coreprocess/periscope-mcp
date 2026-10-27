import { PeriscopeError } from '../../core/errors.ts';
import type { RestRequest } from './guard.ts';

/** What every hook gets: the source's `VAR_*` values, an unrestricted fetch and the abort signal. */
export interface HookContext {
    vars: Readonly<Record<string, string>>;
    fetch: typeof fetch;
    signal: AbortSignal;
}

export interface TransformContext extends HookContext {
    /** The request this response answers, as prepared. */
    request: RestRequest;
    /**
     * A file link for a `GET` URL (absolute or a path under the base URL), served by fetching it again; `name` is the
     * file name downloads use (default: the URL's last path segment).
     */
    file(url: string, name?: string): string;
}

export interface TransformOutcome {
    documents: unknown[];
    next: RestRequest | undefined;
}

/**
 * The operator's script (`SCRIPT`): an ES module exporting any of `check`, `prepare` and `transform`. It is trusted
 * configuration; its module scope is the memory that survives between calls of one process.
 */
export interface RestScript {
    /** Rejects a request by throwing; runs for every request before `prepare`. */
    check?(request: RestRequest, context: HookContext): unknown;
    /** Returns the request to send (or changes it in place): credentials, headers, a rewritten URL. */
    prepare?(request: RestRequest, context: HookContext): unknown;
    /** Turns a response into documents, and the request for the next page if there is one. */
    transform?(response: Response, context: TransformContext): unknown;
}

const HOOKS = ['check', 'prepare', 'transform'] as const;

/** Loads the script as an ES module from its source text. The source name keeps two sources' modules apart. */
export const loadScript = async (source: string, text: string): Promise<RestScript> => {
    const code = `// periscope source ${source}\n${text}`;
    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as Record<
        string,
        unknown
    >;
    const script: RestScript = {};
    for (const [name, value] of Object.entries(module)) {
        if (!(HOOKS as readonly string[]).includes(name)) {
            throw new Error(`SCRIPT exports '${name}'; only ${HOOKS.join(', ')} are allowed`);
        }
        if (typeof value !== 'function') throw new Error(`SCRIPT export '${name}' must be a function`);
        Object.assign(script, { [name]: value });
    }
    return script;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates a request a hook returned, so the guard and fetch see exactly the shape they expect. */
export const toRequest = (value: unknown, hook: string): RestRequest => {
    if (
        !isRecord(value) ||
        typeof value.method !== 'string' ||
        typeof value.url !== 'string' ||
        !isRecord(value.headers) ||
        (value.body !== undefined && typeof value.body !== 'string')
    ) {
        throw new PeriscopeError(
            'source_error',
            `SCRIPT ${hook} must give a request { method, url, headers, body? } with a string body`
        );
    }
    const headers: Record<string, string> = {};
    for (const [name, header] of Object.entries(value.headers)) {
        if (typeof header !== 'string') {
            throw new PeriscopeError('source_error', `SCRIPT ${hook} set header '${name}' to a non-string`);
        }
        headers[name.toLowerCase()] = header;
    }
    return { method: value.method.toUpperCase(), url: value.url, headers, body: value.body };
};

/** Reads what `transform` returned: an array of documents, `{ documents?, next? }`, or nothing. */
export const toOutcome = (value: unknown): TransformOutcome => {
    if (value === undefined || value === null) return { documents: [], next: undefined };
    if (Array.isArray(value)) return { documents: value, next: undefined };
    if (isRecord(value) && (value.documents === undefined || Array.isArray(value.documents))) {
        const next = value.next === undefined || value.next === null ? undefined : toRequest(value.next, 'transform');
        return { documents: (value.documents as unknown[] | undefined) ?? [], next };
    }
    throw new PeriscopeError('source_error', 'SCRIPT transform must return documents, { documents, next } or nothing');
};

/** A copy a hook may change without touching the caller's request. */
export const cloneRequest = (request: RestRequest): RestRequest => ({ ...request, headers: { ...request.headers } });
