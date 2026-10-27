import { compileGlob, type Matcher } from '../../core/glob.ts';

/**
 * The read-only guard of the rest source (concept §7.1 C). Every request — the agent's, each further page, each
 * redirect hop and each file read — must match a configured `METHOD pattern` rule, after the script prepared it.
 * Whatever the guard does not fully understand is rejected: dot segments, encoded slashes and dots, backslashes,
 * user info, fragments and every way of overriding the method.
 */

export interface RestRequest {
    method: string;
    /** Absolute `http(s)` URL. */
    url: string;
    /** Header names in lower case. */
    headers: Record<string, string>;
    body: string | undefined;
}

export interface AllowRule {
    text: string;
    method: string;
    origin: string;
    matches: Matcher;
}

/** Headers an agent may set without `ALLOW_HEADERS`. */
export const DEFAULT_AGENT_HEADERS = [
    'accept',
    'accept-language',
    'content-type',
    'if-none-match',
    'if-modified-since',
];

/** Headers and query parameters that make servers treat a request as another method. Never allowed. */
const METHOD_OVERRIDES = new Set(['x-http-method-override', 'x-http-method', 'x-method-override', '_method']);

const METHOD = /^[A-Z]+$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** Resolves a request target: absolute `http(s)` URLs as they are, paths starting with `/` appended to the base URL. */
export const resolveTarget = (baseUrl: string, target: string): string | undefined => {
    if (/^https?:\/\//i.test(target)) return target;
    return target.startsWith('/') ? `${baseUrl}${target}` : undefined;
};

/** Compiles `METHOD pattern` rules. Patterns are paths under the base URL or absolute URLs; `*` and `**` are wildcards. */
export const compileRules = (baseUrl: string, rules: string[]): AllowRule[] =>
    rules.map((text) => {
        const match = /^([A-Z]+)\s+(\S+)$/.exec(text);
        if (!match) throw new Error(`ALLOW rule '${text}' must be 'METHOD pattern'`);
        const [, method, pattern] = match as unknown as [string, string, string];
        const target = resolveTarget(baseUrl, pattern);
        if (!target) throw new Error(`ALLOW rule '${text}' needs a path starting with / or an absolute URL`);
        const parts = splitUrl(target);
        if (!parts || parts.query !== undefined || parts.fragment !== undefined || parts.authority.includes('@')) {
            throw new Error(`ALLOW rule '${text}' may only hold an origin and a path`);
        }
        if (unsafePath(parts.path)) throw new Error(`ALLOW rule '${text}' has an ambiguous path`);
        const url = new URL(target);
        const path = url.pathname;
        const glob = compileGlob(path);
        const matches: Matcher = path.includes('*')
            ? (pathname) => glob.matches(pathname.slice(1))
            : (pathname) => pathname === path;
        return { text, method, origin: url.origin, matches };
    });

/** The parts of an absolute `http(s)` URL as written, before any normalization. */
const splitUrl = (
    url: string
): { authority: string; path: string; query: string | undefined; fragment: string | undefined } | undefined => {
    // spaces and control characters: URL parsers strip or encode them, which changes the path that was checked
    if ([...url].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) return undefined;
    const match = /^https?:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
    if (!match) return undefined;
    return { authority: match[1] ?? '', path: match[2] || '/', query: match[3], fragment: match[4] };
};

/** Dot segments, empty segments, backslashes and encoded slashes, backslashes or dots, which servers may decode. */
const unsafePath = (path: string): boolean =>
    !path.startsWith('/') ||
    path.includes('\\') ||
    /%(2f|5c|2e)/i.test(path) ||
    path
        .slice(1)
        .split('/')
        .some((segment, i, all) => segment === '.' || segment === '..' || (segment === '' && i < all.length - 1));

/**
 * Why a request is not allowed, or undefined if it is. `agentHeaders` limits the headers to those an agent may set;
 * requests the script prepared carry its headers and are checked without it.
 */
export const rejectionOf = (
    rules: AllowRule[],
    request: RestRequest,
    agentHeaders?: ReadonlySet<string>
): string | undefined => {
    if (!METHOD.test(request.method)) return `invalid method '${request.method}'`;
    const parts = splitUrl(request.url);
    if (!parts) return 'the URL must be absolute http(s), without spaces or control characters';
    if (parts.fragment !== undefined) return 'the URL must not have a fragment';
    if (parts.authority.includes('@')) return 'the URL must not carry user info';
    if (unsafePath(parts.path)) {
        return 'the path must not contain dot or empty segments, backslashes or encoded slashes and dots';
    }
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return 'invalid URL';
    }
    for (const name of url.searchParams.keys()) {
        if (METHOD_OVERRIDES.has(name.toLowerCase())) return `the query parameter '${name}' overrides the method`;
    }
    for (const [name, value] of Object.entries(request.headers)) {
        if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) return `invalid header '${name}'`;
        if (METHOD_OVERRIDES.has(name)) return `the header '${name}' overrides the method`;
        if (agentHeaders && !agentHeaders.has(name)) return `the header '${name}' is not allowed`;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && request.body !== undefined) {
        return `${request.method} requests have no body`;
    }
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const allowed = rules.some(
        (rule) => rule.method === method && rule.origin === url.origin && rule.matches(url.pathname)
    );
    return allowed ? undefined : `${request.method} ${url.origin}${url.pathname} matches no allowed request`;
};

/**
 * Parses an agent's query: a request line (`METHOD target`, an optional `HTTP/x` version), header lines, and after a
 * blank line the body.
 */
export const parseRequestText = (baseUrl: string, text: string): RestRequest => {
    const normalized = text.replace(/^\s+/, '').replace(/\r\n/g, '\n');
    const split = normalized.indexOf('\n\n');
    const head = split === -1 ? normalized.trimEnd() : normalized.slice(0, split);
    const body = split === -1 ? '' : normalized.slice(split + 2);
    const [line = '', ...headerLines] = head.split('\n');
    const requestLine = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(line);
    if (!requestLine) throw new Error('the first line must be METHOD URL, e.g. GET /items?page=1');
    const [, method, target] = requestLine as unknown as [string, string, string];
    const url = resolveTarget(baseUrl, target);
    if (!url) throw new Error(`'${target}' must be a path starting with / or an absolute http(s) URL`);
    const headers: Record<string, string> = {};
    for (const headerLine of headerLines) {
        const colon = headerLine.indexOf(':');
        if (colon <= 0) throw new Error(`'${headerLine}' is not a header line (name: value)`);
        const name = headerLine.slice(0, colon).trim().toLowerCase();
        if (name in headers) throw new Error(`duplicate header '${name}'`);
        headers[name] = headerLine.slice(colon + 1).trim();
    }
    return { method: method.toUpperCase(), url, headers, body: body.length > 0 ? body : undefined };
};
