import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
    createRemoteJWKSet,
    EncryptJWT,
    type JWTPayload,
    errors as joseErrors,
    jwtDecrypt,
    jwtVerify,
    SignJWT,
} from 'jose';
import type { AuthConfig } from '../config/env.ts';
import type { Loggers } from '../core/logger.ts';
import type { CallerClaims } from './entra.ts';

/**
 * OAuth 2.1 authorization server in front of Microsoft Entra ID (`PERISCOPE_AUTH=entra-broker`,
 * concept §7.2). MCP clients send the MCP URL as RFC 8707 `resource`, which Entra only accepts
 * on an Application ID URI of a verified domain. The broker takes the client's OAuth flow
 * itself, signs the user in at Entra as an ordinary web login (no identifier URI, no exposed
 * scope) and issues its own short-lived tokens:
 *
 *   client → /oauth/register         stateless dynamic registration (signed client id)
 *   client → GET /oauth/authorize    PKCE S256, allowed redirect URI, resource = the MCP URL;
 *                                    answers with a consent page naming the client
 *   user   → POST /oauth/authorize   confirmation, bound to a cookie of this browser (no CSRF)
 *   Periscope → Entra /authorize      own PKCE, nonce, sealed state bound to the same cookie
 *   Entra → /oauth/callback           code redeemed with the client assertion (workload identity)
 *                                    or secret; ID token verified; app role required
 *   client ← code (single use, 2 min)
 *   client → /oauth/token             access token (HS256, 1 h) and refresh token (sealed, carries
 *                                    the Entra refresh token: every refresh signs in at Entra again
 *                                    and re-reads the roles, so revocations take effect)
 *
 * Everything the broker hands out is signed or encrypted with keys derived from the signing
 * key; nothing is stored except a short-lived replay cache for authorization codes.
 */

const SCOPE = 'periscope';
const ENTRA_SCOPES = 'openid profile offline_access';
const REQUEST_TTL_S = 600;
const CODE_TTL_S = 120;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];
/** Entra errors that mean "this grant is refused", as opposed to an outage. */
const REFUSALS = new Set(['invalid_grant', 'interaction_required', 'login_required', 'consent_required']);
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

interface RegisteredClient {
    id: string;
    hash: string;
    redirectUris: string[];
    authMethod: ClientAuthMethod;
    name: string | undefined;
}

interface Identity {
    oid: string;
    name: string | undefined;
    roles: string[];
    tid: string | undefined;
}

interface EntraEndpoints {
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    issuer: string;
}

/**
 * An OAuth error. `invalid_grant` doubles as "Entra refused the user" (the token endpoint
 * answers it as is; the callback turns it into `access_denied`), `temporarily_unavailable`
 * marks outages, so clients keep their refresh tokens.
 */
class OAuthFailure extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, description: string, status = code === 'temporarily_unavailable' ? 503 : 400) {
        super(description);
        this.code = code;
        this.status = status;
    }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url');

const safeEqual = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const param = (source: Record<string, unknown>, name: string): string | undefined => {
    const value = source[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const isLoopback = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK.has(url.hostname);

/** Loopback redirects (any port) are always allowed; everything else must be listed exactly. */
export const isAllowedRedirectUri = (uri: string, allowed: string[]): boolean => {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    if (url.hash || url.username || url.password) return false;
    if (isLoopback(url)) return true;
    return url.protocol === 'https:' && allowed.includes(uri);
};

/** RFC 8252 §7.3: a loopback redirect matches a registered one on any port. */
export const matchesRegisteredRedirect = (uri: string, registered: string[]): boolean => {
    if (registered.includes(uri)) return true;
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    if (!isLoopback(url) || url.hash || url.username || url.password) return false;
    return registered.some((entry) => {
        const candidate = new URL(entry);
        return (
            isLoopback(candidate) &&
            candidate.hostname === url.hostname &&
            candidate.pathname === url.pathname &&
            candidate.search === url.search
        );
    });
};

export class EntraBroker {
    readonly #auth: AuthConfig;
    readonly #issuer: string;
    readonly #resource: string;
    readonly #callback: string;
    readonly #cookiePath: string;
    readonly #secure: boolean;
    readonly #loggers: Loggers;
    readonly #accessKey: Uint8Array;
    readonly #sealKey: Uint8Array;
    readonly #clientKey: Buffer;
    readonly #usedCodes = new Map<string, number>();
    #entra: Promise<{ endpoints: EntraEndpoints; jwks: ReturnType<typeof createRemoteJWKSet> }> | undefined;

    constructor(auth: AuthConfig, publicUrl: string, signingKey: Buffer, loggers: Loggers) {
        this.#auth = auth;
        this.#issuer = publicUrl;
        this.#resource = `${publicUrl}/mcp`;
        this.#callback = `${publicUrl}/oauth/callback`;
        this.#cookiePath = `${new URL(publicUrl).pathname.replace(/\/+$/, '')}/oauth`;
        this.#secure = publicUrl.startsWith('https://');
        this.#loggers = loggers;
        const derive = (purpose: string) => new Uint8Array(hkdfSync('sha256', signingKey, 'periscope', purpose, 32));
        this.#accessKey = derive('oauth-access-token');
        this.#sealKey = derive('oauth-seal');
        this.#clientKey = Buffer.from(derive('oauth-client'));
    }

    get metadataUrl(): string {
        return `${this.#issuer}/.well-known/oauth-protected-resource/mcp`;
    }

    /** RFC 9728: this server is its own authorization server. */
    protectedResourceMetadata(): Record<string, unknown> {
        return {
            resource: this.#resource,
            authorization_servers: [this.#issuer],
            scopes_supported: [SCOPE],
            bearer_methods_supported: ['header'],
            resource_name: 'Periscope MCP',
        };
    }

    /** RFC 8414 authorization server metadata. */
    authorizationServerMetadata(): Record<string, unknown> {
        return {
            issuer: this.#issuer,
            authorization_endpoint: `${this.#issuer}/oauth/authorize`,
            token_endpoint: `${this.#issuer}/oauth/token`,
            registration_endpoint: `${this.#issuer}/oauth/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
            scopes_supported: [SCOPE],
            authorization_response_iss_parameter_supported: true,
        };
    }

    router(): express.Router {
        const router = express.Router();
        const noStore = (_req: Request, res: Response, next: NextFunction) => {
            res.set('Cache-Control', 'no-store');
            next();
        };
        for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
            router.get(path, (_req, res) => void res.json(this.protectedResourceMetadata()));
        }
        router.get('/.well-known/oauth-authorization-server', (_req, res) => {
            res.json(this.authorizationServerMetadata());
        });
        router.post('/oauth/register', noStore, express.json({ limit: '16kb' }), (req, res) => {
            this.#respond(res, async () => void res.status(201).json(this.#register(req.body ?? {})));
        });
        router.get('/oauth/authorize', noStore, (req, res) => void this.#consentPage(req, res));
        router.post(
            '/oauth/authorize',
            noStore,
            express.urlencoded({ extended: false, limit: '16kb' }),
            (req, res) => void this.#confirm(req, res)
        );
        router.get('/oauth/callback', noStore, (req, res) => void this.#callbackHandler(req, res));
        router.post(
            '/oauth/token',
            noStore,
            express.urlencoded({ extended: false, limit: '64kb' }),
            express.json({ limit: '64kb' }),
            (req, res) => void this.#respond(res, () => this.#token(req, res))
        );
        // malformed bodies get an OAuth error, not Express's HTML page
        router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
            if (res.headersSent) return next(error);
            res.status(400).json({ error: 'invalid_request', error_description: 'Malformed request body' });
        });
        return router;
    }

    verifier(): OAuthTokenVerifier {
        return {
            verifyAccessToken: async (token: string): Promise<AuthInfo> => {
                let payload: JWTPayload;
                try {
                    ({ payload } = await jwtVerify(token, this.#accessKey, {
                        issuer: this.#issuer,
                        audience: this.#resource,
                        algorithms: ['HS256'],
                        typ: 'at+jwt',
                    }));
                } catch (error) {
                    const reason = error instanceof joseErrors.JOSEError ? error.code : 'invalid token';
                    throw new OAuthError(OAuthErrorCode.InvalidToken, reason);
                }
                const claims: CallerClaims = {
                    oid: payload.sub as string,
                    name: payload.name as string | undefined,
                    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
                    tenantId: payload.tid as string | undefined,
                    clientId: payload.azp as string | undefined,
                };
                return {
                    token,
                    clientId: claims.clientId ?? '',
                    scopes: [SCOPE],
                    ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
                    extra: claims as unknown as Record<string, unknown>,
                };
            },
        };
    }

    // --- registration -----------------------------------------------------------------------

    #register(body: Record<string, unknown>): Record<string, unknown> {
        const redirectUris = body.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
            throw new OAuthFailure('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
        }
        for (const uri of redirectUris) {
            if (typeof uri !== 'string' || uri.length > 500 || !isAllowedRedirectUri(uri, this.#auth.redirectUris)) {
                throw new OAuthFailure('invalid_redirect_uri', 'A redirect URI is not allowed');
            }
        }
        const method = (param(body, 'token_endpoint_auth_method') ?? 'none') as ClientAuthMethod;
        if (!CLIENT_AUTH_METHODS.includes(method)) {
            throw new OAuthFailure('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
        }
        const name = param(body, 'client_name')?.slice(0, 100);
        const issuedAt = Math.floor(Date.now() / 1000);
        const encoded = Buffer.from(JSON.stringify({ r: redirectUris, m: method, n: name, t: issuedAt })).toString(
            'base64url'
        );
        const clientId = `${encoded}.${this.#mac('client', encoded)}`;
        const hosts = [...new Set(redirectUris.map((uri: string) => new URL(uri).host))];
        this.#loggers.audit.info({ event: 'oauth_register', client: name, hosts }, 'oauth_register');
        return {
            client_id: clientId,
            client_id_issued_at: issuedAt,
            ...(method === 'none' ? {} : { client_secret: this.#mac('secret', clientId), client_secret_expires_at: 0 }),
            redirect_uris: redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: method,
            ...(name ? { client_name: name } : {}),
        };
    }

    #client(clientId: string | undefined): RegisteredClient {
        const [encoded, mac, extra] = (clientId ?? '').split('.');
        if (!encoded || !mac || extra !== undefined || !safeEqual(mac, this.#mac('client', encoded))) {
            throw new OAuthFailure('invalid_client', 'Unknown client', 401);
        }
        const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
            r: string[];
            m: ClientAuthMethod;
            n?: string;
        };
        const id = clientId as string;
        return { id, hash: sha256(id), redirectUris: data.r, authMethod: data.m, name: data.n };
    }

    #mac(purpose: string, value: string): string {
        return createHmac('sha256', this.#clientKey).update(`${purpose}\n${value}`).digest('base64url');
    }

    // --- authorization ----------------------------------------------------------------------

    /** Validates the client's request and shows the consent page; nothing reaches Entra yet. */
    async #consentPage(req: Request, res: Response): Promise<void> {
        const query = req.query as Record<string, unknown>;
        const redirectUri = param(query, 'redirect_uri');
        let client: RegisteredClient;
        try {
            client = this.#client(param(query, 'client_id'));
            if (!redirectUri || !matchesRegisteredRedirect(redirectUri, client.redirectUris)) {
                throw new OAuthFailure('invalid_request', 'redirect_uri is not registered for this client');
            }
        } catch (error) {
            // never redirect to an unverified URI
            this.#page(res, 400, 'Sign-in request rejected', (error as Error).message);
            return;
        }
        const state = param(query, 'state');
        try {
            if (param(query, 'response_type') !== 'code') {
                throw new OAuthFailure('unsupported_response_type', 'Only response_type=code is supported');
            }
            const challenge = param(query, 'code_challenge');
            if (!challenge || !PKCE_CHALLENGE.test(challenge) || param(query, 'code_challenge_method') !== 'S256') {
                throw new OAuthFailure('invalid_request', 'PKCE with code_challenge_method=S256 is required');
            }
            const resource = param(query, 'resource');
            if (resource && !this.#isResource(resource)) {
                throw new OAuthFailure('invalid_target', 'Unknown resource');
            }
            const { endpoints } = await this.#entraEndpoints();
            const cookieName = `periscope_oauth_${randomBytes(6).toString('hex')}`;
            const cookie = randomBytes(24).toString('base64url');
            const request = await this.#seal(
                'consent',
                { ch: client.hash, ru: redirectUri, cc: challenge, st: state, k: cookieName, b: sha256(cookie) },
                REQUEST_TTL_S
            );
            res.cookie(cookieName, cookie, {
                httpOnly: true,
                secure: this.#secure,
                // not sent on cross-site POSTs: another site cannot confirm for the user
                sameSite: 'lax',
                path: this.#cookiePath,
                maxAge: REQUEST_TTL_S * 1000,
            });
            const target = new URL(redirectUri);
            const who = client.name
                ? `${escapeHtml(client.name)} (${escapeHtml(target.host)})`
                : escapeHtml(target.host);
            this.#page(
                res,
                200,
                'Sign in to Periscope',
                `<p><strong>${who}</strong> asks for read access to the data sources of this Periscope with your Microsoft account.</p>
<p>Only continue if you started this sign-in yourself.</p>
<form method="post" action="${escapeHtml(new URL(this.#issuer).pathname.replace(/\/+$/, ''))}/oauth/authorize">
<input type="hidden" name="request" value="${request}">
<button type="submit">Continue with Microsoft</button>
</form>`,
                new URL(endpoints.authorization_endpoint).origin
            );
        } catch (error) {
            this.#redirectError(res, redirectUri, state, error);
        }
    }

    /** The user confirmed: continue at Entra. */
    async #confirm(req: Request, res: Response): Promise<void> {
        let request: JWTPayload;
        try {
            request = await this.#unseal('consent', param((req.body ?? {}) as Record<string, unknown>, 'request'));
            this.#checkCookie(req, request);
        } catch (error) {
            this.#page(res, 400, 'Sign-in failed', `${(error as Error).message}. Start again from Claude.`);
            return;
        }
        const redirectUri = request.ru as string;
        const clientState = request.st as string | undefined;
        try {
            const { endpoints } = await this.#entraEndpoints();
            const verifier = randomBytes(32).toString('base64url');
            const nonce = randomBytes(16).toString('base64url');
            const { iat: _iat, exp: _exp, iss: _iss, typ: _typ, ...carried } = request;
            const state = await this.#seal('state', { ...carried, v: verifier, n: nonce }, REQUEST_TTL_S);
            const target = new URL(endpoints.authorization_endpoint);
            target.search = new URLSearchParams({
                client_id: this.#auth.clientId as string,
                response_type: 'code',
                response_mode: 'query',
                redirect_uri: this.#callback,
                scope: ENTRA_SCOPES,
                state,
                nonce,
                code_challenge: sha256(verifier),
                code_challenge_method: 'S256',
            }).toString();
            res.redirect(303, target.toString());
        } catch (error) {
            this.#redirectError(res, redirectUri, clientState, error);
        }
    }

    async #callbackHandler(req: Request, res: Response): Promise<void> {
        const query = req.query as Record<string, unknown>;
        let state: JWTPayload;
        try {
            state = await this.#unseal('state', param(query, 'state'));
            this.#checkCookie(req, state);
        } catch (error) {
            this.#page(res, 400, 'Sign-in failed', `${(error as Error).message}. Start again from Claude.`);
            return;
        }
        res.clearCookie(state.k as string, { path: this.#cookiePath });
        const redirectUri = state.ru as string;
        const clientState = state.st as string | undefined;
        try {
            const upstreamError = param(query, 'error');
            if (upstreamError) {
                throw new OAuthFailure(
                    'access_denied',
                    param(query, 'error_description')?.split('\r\n')[0] ?? upstreamError
                );
            }
            const code = param(query, 'code');
            if (!code) throw new OAuthFailure('access_denied', 'Entra returned no authorization code');
            const tokens = await this.#entraToken({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.#callback,
                code_verifier: state.v as string,
            });
            const identity = await this.#identity(tokens.id_token, state.n as string);
            const authCode = await this.#seal(
                'code',
                {
                    ch: state.ch,
                    ru: redirectUri,
                    cc: state.cc,
                    id: identity,
                    ...(tokens.refresh_token ? { ert: tokens.refresh_token } : {}),
                    jti: randomUUID(),
                },
                CODE_TTL_S
            );
            this.#loggers.audit.info(
                { event: 'oauth_signin', user: identity.oid, userName: identity.name, roles: identity.roles },
                'oauth_signin'
            );
            const target = new URL(redirectUri);
            target.searchParams.set('code', authCode);
            if (clientState) target.searchParams.set('state', clientState);
            target.searchParams.set('iss', this.#issuer);
            res.redirect(302, target.toString());
        } catch (error) {
            const refused = error instanceof OAuthFailure && error.code === 'invalid_grant';
            this.#redirectError(
                res,
                redirectUri,
                clientState,
                refused ? new OAuthFailure('access_denied', error.message) : error
            );
        }
    }

    #isResource(value: string): boolean {
        try {
            const url = new URL(value);
            const expected = new URL(this.#resource);
            return (
                url.origin === expected.origin && url.pathname.replace(/\/+$/, '') === expected.pathname && !url.search
            );
        } catch {
            return false;
        }
    }

    #checkCookie(req: Request, sealed: JWTPayload): void {
        const cookie = this.#cookie(req, sealed.k as string);
        if (!cookie || !safeEqual(sha256(cookie), sealed.b as string)) {
            throw new OAuthFailure('access_denied', 'This sign-in was not started in this browser');
        }
    }

    #cookie(req: Request, name: string): string | undefined {
        for (const part of (req.headers.cookie ?? '').split(';')) {
            const [key, ...value] = part.trim().split('=');
            if (key === name) return value.join('=');
        }
        return undefined;
    }

    #page(res: Response, status: number, title: string, body: string, formTarget?: string): void {
        res.status(status)
            .set({
                'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'${formTarget ? ` ${formTarget}` : ''}`,
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
            })
            .type('html')
            .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1.2rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body.startsWith('<') ? body : `<p>${escapeHtml(body)}</p>`}</body></html>`);
    }

    #redirectError(res: Response, redirectUri: string, state: string | undefined, error: unknown): void {
        const failure = error instanceof OAuthFailure ? error : new OAuthFailure('server_error', 'Sign-in failed');
        if (!(error instanceof OAuthFailure))
            this.#loggers.log.error({ error: (error as Error).message }, 'oauth error');
        const target = new URL(redirectUri);
        target.searchParams.set('error', failure.code);
        target.searchParams.set('error_description', failure.message);
        if (state) target.searchParams.set('state', state);
        target.searchParams.set('iss', this.#issuer);
        res.redirect(302, target.toString());
    }

    // --- token endpoint ---------------------------------------------------------------------

    async #token(req: Request, res: Response): Promise<void> {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const client = this.#authenticate(req, body);
        const grant = param(body, 'grant_type');
        let identity: Identity;
        let entraRefresh: string | undefined;
        let sessionExpiresAt: number;
        if (grant === 'authorization_code') {
            const code = await this.#unseal('code', param(body, 'code'), 'invalid_grant');
            if (code.ch !== client.hash) throw new OAuthFailure('invalid_grant', 'Code was issued to another client');
            if (param(body, 'redirect_uri') !== code.ru)
                throw new OAuthFailure('invalid_grant', 'redirect_uri mismatch');
            const verifier = param(body, 'code_verifier');
            if (!verifier || !PKCE_VERIFIER.test(verifier) || !safeEqual(sha256(verifier), code.cc as string)) {
                throw new OAuthFailure('invalid_grant', 'PKCE verification failed');
            }
            this.#consume(code.jti as string, code.exp as number);
            identity = code.id as Identity;
            entraRefresh = code.ert as string | undefined;
            sessionExpiresAt = Math.floor((Date.now() + this.#auth.sessionTtlMs) / 1000);
        } else if (grant === 'refresh_token') {
            const refresh = await this.#unseal('refresh', param(body, 'refresh_token'), 'invalid_grant');
            if (refresh.ch !== client.hash) throw new OAuthFailure('invalid_grant', 'Token of another client');
            // sign in at Entra again: a disabled account or a removed role ends the session here
            const tokens = await this.#entraToken({
                grant_type: 'refresh_token',
                refresh_token: refresh.ert as string,
            });
            identity = await this.#identity(tokens.id_token, undefined);
            entraRefresh = tokens.refresh_token ?? (refresh.ert as string);
            sessionExpiresAt = refresh.exp as number;
        } else {
            throw new OAuthFailure('unsupported_grant_type', 'Use authorization_code or refresh_token');
        }
        const ttl = Math.floor(this.#auth.accessTokenTtlMs / 1000);
        const accessToken = await new SignJWT({
            name: identity.name,
            roles: identity.roles,
            tid: identity.tid,
            azp: client.hash.slice(0, 16),
            scope: SCOPE,
        })
            .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
            .setIssuer(this.#issuer)
            .setAudience(this.#resource)
            .setSubject(identity.oid)
            .setIssuedAt()
            .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
            .setJti(randomUUID())
            .sign(this.#accessKey);
        const refreshToken = entraRefresh
            ? await this.#seal(
                  'refresh',
                  { ch: client.hash, ert: entraRefresh },
                  sessionExpiresAt - Math.floor(Date.now() / 1000)
              )
            : undefined;
        res.json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: ttl,
            scope: SCOPE,
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
        });
    }

    #authenticate(req: Request, body: Record<string, unknown>): RegisteredClient {
        let clientId = param(body, 'client_id');
        let secret = param(body, 'client_secret');
        const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
        if (basic) {
            const decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
            const colon = decoded.indexOf(':');
            if (colon < 0) throw new OAuthFailure('invalid_client', 'Malformed Basic credentials', 401);
            try {
                clientId = decodeURIComponent(decoded.slice(0, colon));
                secret = decodeURIComponent(decoded.slice(colon + 1));
            } catch {
                throw new OAuthFailure('invalid_client', 'Malformed Basic credentials', 401);
            }
        }
        const client = this.#client(clientId);
        if (client.authMethod !== 'none' && (!secret || !safeEqual(secret, this.#mac('secret', client.id)))) {
            throw new OAuthFailure('invalid_client', 'Client authentication failed', 401);
        }
        return client;
    }

    /**
     * Authorization codes are single use. The cache only has to outlive a code (2 min); it is per
     * replica, so with several replicas a code could be redeemed once per replica (still only by
     * the client holding the PKCE verifier).
     */
    #consume(jti: string, expiresAt: number): void {
        const now = Date.now() / 1000;
        for (const [key, exp] of this.#usedCodes) if (exp < now) this.#usedCodes.delete(key);
        if (this.#usedCodes.has(jti)) throw new OAuthFailure('invalid_grant', 'Authorization code already used');
        this.#usedCodes.set(jti, expiresAt);
    }

    // --- Entra --------------------------------------------------------------------------------

    #entraEndpoints() {
        this.#entra ??= (async () => {
            const issuer = this.#auth.issuer ?? `https://login.microsoftonline.com/${this.#auth.tenantId}/v2.0`;
            const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
                signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`discovery answered ${response.status}`);
            const endpoints = (await response.json()) as EntraEndpoints;
            return { endpoints, jwks: createRemoteJWKSet(new URL(this.#auth.jwksUri ?? endpoints.jwks_uri)) };
        })().catch((error: unknown) => {
            this.#entra = undefined;
            this.#loggers.log.warn({ error: (error as Error).message }, 'entra discovery failed');
            throw new OAuthFailure('temporarily_unavailable', 'Entra ID is not reachable');
        });
        return this.#entra;
    }

    async #entraToken(grant: Record<string, string>): Promise<{ id_token: string; refresh_token?: string }> {
        const { endpoints } = await this.#entraEndpoints();
        const body = new URLSearchParams({ ...grant, client_id: this.#auth.clientId as string, scope: ENTRA_SCOPES });
        if (this.#auth.clientSecret) {
            body.set('client_secret', this.#auth.clientSecret);
        } else {
            body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
            body.set('client_assertion', (await readFile(this.#auth.clientAssertionFile as string, 'utf8')).trim());
        }
        let response: globalThis.Response;
        try {
            response = await fetch(endpoints.token_endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(15_000),
            });
        } catch {
            throw new OAuthFailure('temporarily_unavailable', 'Entra ID is not reachable');
        }
        const result = (await response.json().catch(() => ({}))) as {
            id_token?: string;
            refresh_token?: string;
            error?: string;
            error_description?: string;
        };
        if (response.ok && result.id_token) {
            return {
                id_token: result.id_token,
                ...(result.refresh_token ? { refresh_token: result.refresh_token } : {}),
            };
        }
        this.#loggers.log.warn({ status: response.status, error: result.error }, 'entra token request failed');
        if (response.status >= 500 || response.status === 429) {
            throw new OAuthFailure('temporarily_unavailable', 'Entra ID is temporarily unavailable');
        }
        const description = result.error_description?.split('\r\n')[0] ?? 'Entra refused the sign-in';
        if (REFUSALS.has(result.error ?? '')) throw new OAuthFailure('invalid_grant', description);
        // invalid_client and the like: Periscope's own registration is wrong, not the user's grant
        throw new OAuthFailure(
            'server_error',
            `Entra rejected Periscope's request: ${result.error ?? response.status}`,
            500
        );
    }

    async #identity(idToken: string, nonce: string | undefined): Promise<Identity> {
        const { endpoints, jwks } = await this.#entraEndpoints();
        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(idToken, jwks, {
                issuer: endpoints.issuer,
                audience: this.#auth.clientId as string,
                algorithms: ['RS256'],
                clockTolerance: 60,
            }));
        } catch (error) {
            if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) {
                throw new OAuthFailure('temporarily_unavailable', 'Entra signing keys are not reachable');
            }
            throw new OAuthFailure('invalid_grant', 'Entra returned an invalid ID token');
        }
        if (nonce !== undefined && payload.nonce !== nonce) throw new OAuthFailure('invalid_grant', 'Nonce mismatch');
        if (payload.tid !== this.#auth.tenantId) throw new OAuthFailure('invalid_grant', 'Account of another tenant');
        if (typeof payload.oid !== 'string') throw new OAuthFailure('invalid_grant', 'ID token without oid');
        const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
        if (!roles.includes(this.#auth.requiredRole)) {
            throw new OAuthFailure('invalid_grant', `The app role '${this.#auth.requiredRole}' is required`);
        }
        return {
            oid: payload.oid,
            name: (payload.preferred_username ?? payload.upn ?? payload.name) as string | undefined,
            roles,
            tid: payload.tid as string | undefined,
        };
    }

    // --- sealing ------------------------------------------------------------------------------

    #seal(type: string, payload: Record<string, unknown>, ttlSeconds: number): Promise<string> {
        return new EncryptJWT({ ...payload, typ: type })
            .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
            .setIssuer(this.#issuer)
            .setIssuedAt()
            .setExpirationTime(Math.floor(Date.now() / 1000) + Math.max(ttlSeconds, 1))
            .encrypt(this.#sealKey);
    }

    async #unseal(type: string, token: string | undefined, code = 'access_denied'): Promise<JWTPayload> {
        if (!token) throw new OAuthFailure(code === 'invalid_grant' ? 'invalid_request' : code, `Missing ${type}`);
        try {
            const { payload } = await jwtDecrypt(token, this.#sealKey, {
                issuer: this.#issuer,
                keyManagementAlgorithms: ['dir'],
                contentEncryptionAlgorithms: ['A256GCM'],
            });
            if (payload.typ !== type) throw new Error('wrong type');
            return payload;
        } catch {
            throw new OAuthFailure(code, `Invalid or expired ${type}`);
        }
    }

    async #respond(res: Response, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            if (error instanceof OAuthFailure) {
                if (error.code === 'invalid_client') res.set('WWW-Authenticate', 'Basic realm="periscope"');
                res.status(error.status).json({ error: error.code, error_description: error.message });
                return;
            }
            this.#loggers.log.error({ error: (error as Error).message }, 'oauth error');
            res.status(500).json({ error: 'server_error', error_description: 'Internal error' });
        }
    }
}
