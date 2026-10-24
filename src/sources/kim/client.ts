import type { KimSourceConfig } from '../../config/sources.ts';
import { PeriscopeError, WireGuardError } from '../../core/errors.ts';

/**
 * The only way the kim source talks to KIM. Every request passes `isAllowedKimRequest`
 * first: the API-key exchange, the one-shot query, the collection listing, the
 * capabilities, GET/HEAD on the Bytes API and GET on type definitions. Everything else KIM offers (drafts, live
 * sessions, agents, file processing, backups, interchange, token exchange that can
 * register users) is blocked before it leaves the process (concept §7.1 A).
 */

const ALLOWED_RPC = new Set(['/rpc/live/query', '/rpc/collection/listCollections', '/rpc/resource/capabilities']);
const EXCHANGE_PATH = '/rpc/identity/exchangeApiKey';
/** Type definitions in a stage's well-known types collection (read for `describe`). */
const TYPE_DEFINITION_PATH = /^\/[^/]+\/9zzzz-0000-0000v\/[^/]+$/;
/** Re-exchange the key this long before the token expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export const isAllowedKimRequest = (
    config: Pick<KimSourceConfig, 'url' | 'identityUrl'>,
    method: string,
    target: string
): boolean => {
    const url = new URL(target);
    if (url.username || url.password) return false;
    const verb = method.toUpperCase();
    if (url.origin === config.identityUrl && verb === 'POST' && url.pathname === EXCHANGE_PATH) return true;
    if (url.origin !== config.url) return false;
    if (verb === 'POST') return ALLOWED_RPC.has(url.pathname);
    if (verb !== 'GET' && verb !== 'HEAD') return false;
    return url.pathname.startsWith('/bytes/') || (TYPE_DEFINITION_PATH.test(url.pathname) && url.search === '');
};

/** A KIM error answer: `{ json: { defined, code, status, message, data } }`, sometimes unwrapped. */
interface KimErrorBody {
    code?: string;
    status?: number;
    message?: string;
    data?: Record<string, unknown>;
}

export class KimRequestError extends PeriscopeError {
    readonly status: number;
    readonly kimCode: string | undefined;

    constructor(status: number, body: KimErrorBody | undefined, fallback: string) {
        const kimCode = body?.code;
        const message = `KIM ${status}${kimCode ? ` ${kimCode}` : ''}: ${body?.message ?? fallback}`;
        super(status === 404 ? 'not_found' : 'source_error', message, body?.data ? { kim: body.data } : undefined);
        this.status = status;
        this.kimCode = kimCode;
    }
}

const errorBody = (text: string): KimErrorBody | undefined => {
    try {
        const parsed = JSON.parse(text) as { json?: KimErrorBody } & KimErrorBody;
        return parsed.json ?? parsed;
    } catch {
        return undefined;
    }
};

export class KimClient {
    readonly #config: KimSourceConfig;
    #token: { value: string; renewAt: number } | undefined;
    #exchanging: Promise<string> | undefined;

    constructor(config: KimSourceConfig) {
        this.#config = config;
    }

    async #send(method: string, url: string, init: RequestInit): Promise<Response> {
        if (!isAllowedKimRequest(this.#config, method, url)) {
            throw new WireGuardError(this.#config.name, `${method} ${new URL(url).pathname}`);
        }
        return fetch(url, { ...init, method, redirect: 'error' });
    }

    async #exchange(): Promise<string> {
        const response = await this.#send('POST', `${this.#config.identityUrl}${EXCHANGE_PATH}`, {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ json: { key: this.#config.apiKey } }),
        });
        const text = await response.text();
        if (!response.ok) throw new KimRequestError(response.status, errorBody(text), 'API key exchange failed');
        const { json } = JSON.parse(text) as { json: { token: string; expiresAt: string } };
        const expiresAt = Date.parse(json.expiresAt);
        this.#token = { value: json.token, renewAt: expiresAt - TOKEN_MARGIN_MS };
        return json.token;
    }

    async #bearer(renew = false): Promise<string> {
        if (!renew && this.#token && Date.now() < this.#token.renewAt) return this.#token.value;
        this.#exchanging ??= this.#exchange().finally(() => {
            this.#exchanging = undefined;
        });
        return this.#exchanging;
    }

    /** Sends an authorized request; a 401 triggers one key exchange and a retry. */
    async #authorized(method: string, url: string, init: RequestInit): Promise<Response> {
        const attempt = async (renew: boolean): Promise<Response> =>
            this.#send(method, url, {
                ...init,
                headers: {
                    ...(init.headers as Record<string, string>),
                    authorization: `Bearer ${await this.#bearer(renew)}`,
                },
            });
        const response = await attempt(false);
        if (response.status !== 401) return response;
        await response.body?.cancel();
        return attempt(true);
    }

    /** Calls an oRPC procedure: the input and the output are wrapped in `{ json }`. */
    async rpc<T>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
        const response = await this.#authorized('POST', `${this.#config.url}${path}`, {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ json: input }),
            ...(signal ? { signal } : {}),
        });
        const text = await response.text();
        if (!response.ok) throw new KimRequestError(response.status, errorBody(text), response.statusText);
        return (JSON.parse(text) as { json: T }).json;
    }

    /** Reads a type definition (object format) by its URL. */
    async typeDefinition<T>(url: string): Promise<T> {
        const response = await this.#authorized('GET', url, { headers: { accept: 'application/json' } });
        const text = await response.text();
        if (!response.ok) throw new KimRequestError(response.status, errorBody(text), response.statusText);
        return JSON.parse(text) as T;
    }

    /** GET or HEAD on the Bytes API (`/bytes/<stage>/…`). */
    async bytes(method: 'GET' | 'HEAD', path: string, headers: Record<string, string> = {}): Promise<Response> {
        const response = await this.#authorized(method, `${this.#config.url}/bytes/${path}`, { headers });
        if (response.ok) return response;
        const text = await response.text();
        throw new KimRequestError(response.status, errorBody(text), response.statusText);
    }
}
