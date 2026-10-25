import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import express from 'express';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { EntraBroker, isAllowedRedirectUri } from '../../src/auth/broker.ts';
import { claimsOf } from '../../src/auth/entra.ts';
import type { AuthConfig } from '../../src/config/env.ts';
import { nullLoggers } from '../../src/core/logger.ts';

const TENANT = '11111111-2222-3333-4444-555555555555';
const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ASSERTION = 'federated-service-account-token';
const LOOPBACK = 'http://127.0.0.1:8765/callback';
const b64 = (buffer: Buffer) => buffer.toString('base64url');
const s256 = (value: string) => b64(createHash('sha256').update(value).digest());

const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** Entra stand-in: discovery, keys and a token endpoint that checks PKCE and the client assertion. */
const startEntra = async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const codes = new Map<string, { challenge: string; nonce: string; roles: string[] }>();
    const state = {
        outage: false,
        roles: ['Periscope.Reader'],
        refreshRoles: ['Periscope.Reader'],
        tokenRequests: [] as URLSearchParams[],
    };
    let origin = '';
    const idToken = (claims: Record<string, unknown>, privateKey: CryptoKey) =>
        new SignJWT({ tid: TENANT, oid: 'user-1', preferred_username: 'ada@example.com', ...claims })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(`${origin}/${TENANT}/v2.0`)
            .setAudience(APP_ID)
            .setIssuedAt()
            .setExpirationTime('10m')
            .sign(privateKey);
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            const json = (status: number, value: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            if (req.url === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
                return json(200, {
                    issuer: `${origin}/${TENANT}/v2.0`,
                    authorization_endpoint: `${origin}/${TENANT}/oauth2/v2.0/authorize`,
                    token_endpoint: `${origin}/${TENANT}/oauth2/v2.0/token`,
                    jwks_uri: `${origin}/keys`,
                });
            }
            if (req.url === '/keys') return json(200, { keys: [jwk] });
            if (req.url === `/${TENANT}/oauth2/v2.0/token`) {
                const form = new URLSearchParams(body);
                state.tokenRequests.push(form);
                if (state.outage) return json(503, { error: 'temporarily_unavailable' });
                if (form.get('client_id') !== APP_ID || form.get('client_assertion') !== ASSERTION) {
                    return json(401, { error: 'invalid_client' });
                }
                if (form.get('grant_type') === 'authorization_code') {
                    const code = codes.get(form.get('code') ?? '');
                    if (!code || s256(form.get('code_verifier') ?? '') !== code.challenge) {
                        return json(400, { error: 'invalid_grant' });
                    }
                    codes.delete(form.get('code') as string);
                    return json(200, {
                        id_token: await idToken({ nonce: code.nonce, roles: code.roles }, keys.privateKey),
                        refresh_token: 'entra-refresh-1',
                    });
                }
                if (
                    form.get('grant_type') === 'refresh_token' &&
                    form.get('refresh_token')?.startsWith('entra-refresh')
                ) {
                    return json(200, {
                        id_token: await idToken({ roles: state.refreshRoles }, keys.privateKey),
                        refresh_token: 'entra-refresh-2',
                    });
                }
                return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: bad grant' });
            }
            json(404, {});
        });
    });
    origin = await listen(server);
    /** What the user's browser does at Entra: sign in and get redirected back with a code. */
    const signIn = (authorizeUrl: URL): string => {
        const code = b64(randomBytes(12));
        codes.set(code, {
            challenge: authorizeUrl.searchParams.get('code_challenge') as string,
            nonce: authorizeUrl.searchParams.get('nonce') as string,
            roles: state.roles,
        });
        return code;
    };
    return { server, origin, signIn, state };
};

describe('entra broker (OAuth authorization server in front of Entra)', () => {
    let entra: Awaited<ReturnType<typeof startEntra>>;
    let app: Server;
    let base: string;
    let dir: string;
    let authConfig: AuthConfig;

    before(async () => {
        entra = await startEntra();
        dir = await mkdtemp(join(tmpdir(), 'periscope-broker-'));
        await writeFile(join(dir, 'token'), `${ASSERTION}\n`);
        app = createServer();
        base = await listen(app);
        const auth: AuthConfig = {
            mode: 'entra-broker',
            tenantId: TENANT,
            clientId: APP_ID,
            requiredRole: 'Periscope.Reader',
            scopeName: 'Periscope.Access',
            clientSecret: undefined,
            clientAssertionFile: join(dir, 'token'),
            assertionIdentity: undefined,
            redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
            accessTokenTtlMs: 3_600_000,
            sessionTtlMs: 30 * 86_400_000,
            issuer: `${entra.origin}/${TENANT}/v2.0`,
            jwksUri: undefined,
            authorizationServer: undefined,
        };
        authConfig = auth;
        const broker = new EntraBroker(auth, base, randomBytes(32), nullLoggers());
        const server = express();
        server.use(broker.router());
        server.post(
            '/mcp',
            requireBearerAuth({
                verifier: broker.verifier(),
                requiredScopes: [],
                resourceMetadataUrl: broker.metadataUrl,
            }),
            (req, res) => void res.json(claimsOf((req as unknown as { auth: never }).auth))
        );
        app.on('request', server);
    });

    after(async () => {
        await new Promise((resolve) => app.close(resolve));
        await new Promise((resolve) => entra.server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    });

    const register = async (body: Record<string, unknown>) =>
        fetch(`${base}/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

    const token = (form: Record<string, string>, headers: Record<string, string> = {}) =>
        fetch(`${base}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
            body: new URLSearchParams(form),
        });

    /** Runs the browser part of the flow and returns the redirect back to the client. */
    /** What the user's browser does: consent page, confirmation, Entra, callback. */
    const browserSignIn = async (authorizeUrl: string | URL) => {
        const start = await fetch(authorizeUrl, { redirect: 'manual' });
        if (start.status !== 200) return { start, back: undefined, cookie: '', toEntra: undefined, callback: '' };
        const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] as string;
        const page = await start.text();
        const request = /name="request" value="([^"]+)"/.exec(page)?.[1] as string;
        const confirm = await fetch(`${base}/oauth/authorize`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
            body: new URLSearchParams({ request }),
        });
        const toEntra = new URL(confirm.headers.get('location') as string);
        const callback = `${base}/oauth/callback?${new URLSearchParams({
            code: entra.signIn(toEntra),
            state: toEntra.searchParams.get('state') as string,
        })}`;
        const back = await fetch(callback, { redirect: 'manual', headers: { cookie } });
        return { start, page, request, confirm, back, cookie, toEntra, callback };
    };

    const authorize = (clientId: string, verifier: string, extra: Record<string, string> = {}) =>
        browserSignIn(
            `${base}/oauth/authorize?${new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: LOOPBACK,
                code_challenge: s256(verifier),
                code_challenge_method: 'S256',
                state: 'client-state',
                resource: `${base}/mcp/`,
                ...extra,
            })}`
        );

    it('publishes resource and authorization server metadata', async () => {
        const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
            string,
            unknown
        >;
        assert.deepEqual(prm.authorization_servers, [base]);
        assert.equal(prm.resource, `${base}/mcp`);
        const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<
            string,
            unknown
        >;
        assert.equal(as.token_endpoint, `${base}/oauth/token`);
        assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
        const unauthorized = await fetch(`${base}/mcp`, { method: 'POST' });
        assert.equal(unauthorized.status, 401);
        assert.match(unauthorized.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/);
    });

    it('allows only loopback and listed redirect URIs', async () => {
        assert.equal(isAllowedRedirectUri('http://localhost:33418/callback', []), true);
        assert.equal(
            isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', [
                'https://claude.ai/api/mcp/auth_callback',
            ]),
            true
        );
        for (const uri of [
            'https://evil.example.com/cb',
            'http://example.com/cb',
            'http://localhost/cb#x',
            'javascript:alert(1)',
        ]) {
            assert.equal(isAllowedRedirectUri(uri, ['https://claude.ai/api/mcp/auth_callback']), false, uri);
        }
        assert.equal((await register({ redirect_uris: ['https://evil.example.com/cb'] })).status, 400);
        assert.equal((await register({})).status, 400);
    });

    it('signs a user in through Entra and serves the MCP endpoint with its own tokens', async () => {
        const registered = (await (
            await register({ redirect_uris: [LOOPBACK], client_name: 'Claude Code' })
        ).json()) as {
            client_id: string;
        };
        const verifier = b64(randomBytes(32));
        const { toEntra, back, callback } = await authorize(registered.client_id, verifier);
        assert.equal(toEntra?.searchParams.get('client_id'), APP_ID);
        assert.equal(toEntra?.searchParams.get('redirect_uri'), `${base}/oauth/callback`);
        assert.equal(toEntra?.searchParams.get('scope'), 'openid profile offline_access');
        assert.equal(toEntra?.searchParams.has('resource'), false);
        assert.equal(back?.status, 302);
        const redirect = new URL(back?.headers.get('location') as string);
        assert.equal(`${redirect.origin}${redirect.pathname}`, LOOPBACK);
        assert.equal(redirect.searchParams.get('state'), 'client-state');
        assert.equal(redirect.searchParams.get('iss'), base);
        const code = redirect.searchParams.get('code') as string;

        // the callback only works in the browser that started the sign-in
        assert.equal((await fetch(callback as string, { redirect: 'manual' })).status, 400);

        const wrong = await token({
            grant_type: 'authorization_code',
            code,
            redirect_uri: LOOPBACK,
            client_id: registered.client_id,
            code_verifier: 'x'.repeat(43),
        });
        assert.equal(wrong.status, 400);
        const issued = (await (
            await token({
                grant_type: 'authorization_code',
                code,
                redirect_uri: LOOPBACK,
                client_id: registered.client_id,
                code_verifier: verifier,
            })
        ).json()) as { access_token: string; refresh_token: string; expires_in: number };
        assert.equal(issued.expires_in, 3600);
        const replay = await token({
            grant_type: 'authorization_code',
            code,
            redirect_uri: LOOPBACK,
            client_id: registered.client_id,
            code_verifier: verifier,
        });
        assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant');

        const call = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${issued.access_token}` },
        });
        assert.equal(call.status, 200);
        assert.deepEqual(await call.json(), {
            oid: 'user-1',
            name: 'ada@example.com',
            roles: ['Periscope.Reader'],
            tenantId: TENANT,
            clientId: (
                JSON.parse(Buffer.from(issued.access_token.split('.')[1] as string, 'base64url').toString()) as {
                    azp: string;
                }
            ).azp,
        });
        const forged = `${issued.access_token.slice(0, -4)}AAAA`;
        assert.equal(
            (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${forged}` } })).status,
            401
        );

        // refresh signs in at Entra again; a removed role ends the session
        const refreshed = await token({
            grant_type: 'refresh_token',
            refresh_token: issued.refresh_token,
            client_id: registered.client_id,
        });
        assert.equal(refreshed.status, 200);
        const renewed = (await refreshed.json()) as { access_token: string; refresh_token: string };
        assert.equal(entra.state.tokenRequests.at(-1)?.get('refresh_token'), 'entra-refresh-1');
        entra.state.refreshRoles = [];
        const revoked = await token({
            grant_type: 'refresh_token',
            refresh_token: renewed.refresh_token,
            client_id: registered.client_id,
        });
        assert.equal(((await revoked.json()) as { error: string }).error, 'invalid_grant');
        entra.state.refreshRoles = ['Periscope.Reader'];

        // tokens are bound to their client
        const other = (await (await register({ redirect_uris: [LOOPBACK] })).json()) as { client_id: string };
        const stolen = await token({
            grant_type: 'refresh_token',
            refresh_token: renewed.refresh_token,
            client_id: other.client_id,
        });
        assert.equal(((await stolen.json()) as { error: string }).error, 'invalid_grant');
    });

    it('rejects sign-ins without the app role, without PKCE and for other resources', async () => {
        const { client_id } = (await (await register({ redirect_uris: [LOOPBACK] })).json()) as { client_id: string };
        entra.state.roles = [];
        const { back } = await authorize(client_id, b64(randomBytes(32)));
        const denied = new URL(back?.headers.get('location') as string);
        assert.equal(denied.searchParams.get('error'), 'access_denied');
        assert.match(denied.searchParams.get('error_description') ?? '', /Periscope.Reader/);
        entra.state.roles = ['Periscope.Reader'];

        const noPkce = await authorize(client_id, 'v', { code_challenge_method: 'plain' });
        assert.equal(
            new URL(noPkce.start.headers.get('location') as string).searchParams.get('error'),
            'invalid_request'
        );
        const otherResource = await authorize(client_id, 'v', { resource: 'https://other.example.com/mcp' });
        assert.equal(
            new URL(otherResource.start.headers.get('location') as string).searchParams.get('error'),
            'invalid_target'
        );
        const unregistered = await fetch(
            `${base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: 'http://127.0.0.1:9/other', response_type: 'code' })}`,
            { redirect: 'manual' }
        );
        assert.equal(unregistered.status, 400);
        const forgedClient = await fetch(
            `${base}/oauth/authorize?${new URLSearchParams({ client_id: `${client_id}x`, redirect_uri: LOOPBACK, response_type: 'code' })}`,
            { redirect: 'manual' }
        );
        assert.equal(forgedClient.status, 400);
    });

    it('completes the flow of the official MCP client SDK (discovery, registration, PKCE, issuer check)', async () => {
        const stored: Record<string, unknown> = {};
        let authorizationUrl: URL | undefined;
        const provider: OAuthClientProvider = {
            get redirectUrl() {
                return LOOPBACK;
            },
            get clientMetadata() {
                return { client_name: 'sdk', redirect_uris: [LOOPBACK], token_endpoint_auth_method: 'none' };
            },
            clientInformation: () => stored.client as never,
            saveClientInformation: (info) => void (stored.client = info),
            tokens: () => stored.tokens as never,
            saveTokens: (tokens) => void (stored.tokens = tokens),
            redirectToAuthorization: (url) => void (authorizationUrl = url),
            saveCodeVerifier: (verifier) => void (stored.verifier = verifier),
            codeVerifier: () => stored.verifier as string,
        };
        assert.equal(await auth(provider, { serverUrl: `${base}/mcp` }), 'REDIRECT');
        const { back } = await browserSignIn(authorizationUrl as URL);
        const redirect = new URL(back?.headers.get('location') as string);
        const result = await auth(provider, {
            serverUrl: `${base}/mcp`,
            authorizationCode: redirect.searchParams.get('code') as string,
            iss: redirect.searchParams.get('iss') as string,
        });
        assert.equal(result, 'AUTHORIZED');
        const tokens = stored.tokens as { access_token: string };
        const call = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        assert.equal(call.status, 200);
    });

    it('withstands the attacks of the security review', async () => {
        const registered = (await (
            await register({ redirect_uris: [LOOPBACK], client_name: '<script>alert(1)</script>' })
        ).json()) as { client_id: string };
        const verifier = b64(randomBytes(32));
        const authorizeUrl = `${base}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: registered.client_id,
            redirect_uri: 'http://127.0.0.1:41999/callback', // other loopback port than registered
            code_challenge: s256(verifier),
            code_challenge_method: 'S256',
        })}`;
        const consent = await fetch(authorizeUrl, { redirect: 'manual' });
        assert.equal(consent.status, 200, 'loopback redirect on another port is accepted');
        assert.equal(consent.headers.get('x-frame-options'), 'DENY');
        assert.match(consent.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
        const page = await consent.text();
        assert.doesNotMatch(page, /<script>/);
        const request = /name="request" value="([^"]+)"/.exec(page)?.[1] as string;

        // a cross-site POST carries no cookie: another site cannot confirm for the user
        const forgedConfirm = await fetch(`${base}/oauth/authorize`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ request }),
        });
        assert.equal(forgedConfirm.status, 400);

        // the callback rejects a state with the cookie of another sign-in
        const first = await authorize(registered.client_id, b64(randomBytes(32)));
        const second = await authorize(registered.client_id, b64(randomBytes(32)));
        const crossed = await fetch(first.callback, { redirect: 'manual', headers: { cookie: second.cookie } });
        assert.equal(crossed.status, 400);

        // sealed values of one kind are never accepted as another
        const flow = await authorize(registered.client_id, verifier);
        const code = new URL(flow.back?.headers.get('location') as string).searchParams.get('code') as string;
        const issued = (await (
            await token({
                grant_type: 'authorization_code',
                code,
                redirect_uri: LOOPBACK,
                client_id: registered.client_id,
                code_verifier: verifier,
            })
        ).json()) as { refresh_token: string };
        for (const fake of [
            issued.refresh_token,
            flow.request as string,
            flow.toEntra?.searchParams.get('state') as string,
        ]) {
            const confused = await token({
                grant_type: 'authorization_code',
                code: fake,
                redirect_uri: LOOPBACK,
                client_id: registered.client_id,
                code_verifier: verifier,
            });
            assert.equal(((await confused.json()) as { error: string }).error, 'invalid_grant');
        }
        const asRefresh = await token({
            grant_type: 'refresh_token',
            refresh_token: code,
            client_id: registered.client_id,
        });
        assert.equal(((await asRefresh.json()) as { error: string }).error, 'invalid_grant');

        // a JWE with another key management algorithm is rejected without work
        const pbes2 = `${b64(Buffer.from(JSON.stringify({ alg: 'PBES2-HS256+A128KW', enc: 'A256GCM', p2c: 10_000, p2s: 'AAAAAAAAAAA' })))}.a.b.c.d`;
        const rejected = await token({
            grant_type: 'refresh_token',
            refresh_token: pbes2,
            client_id: registered.client_id,
        });
        assert.equal(((await rejected.json()) as { error: string }).error, 'invalid_grant');

        // an Entra outage is no reason to drop the session
        entra.state.outage = true;
        const outage = await token({
            grant_type: 'refresh_token',
            refresh_token: issued.refresh_token,
            client_id: registered.client_id,
        });
        assert.equal(outage.status, 503);
        assert.equal(((await outage.json()) as { error: string }).error, 'temporarily_unavailable');
        entra.state.outage = false;

        // malformed client credentials and bodies get OAuth errors
        const noColon = await token(
            { grant_type: 'refresh_token', refresh_token: 'x' },
            { authorization: `Basic ${Buffer.from('justid').toString('base64')}` }
        );
        assert.equal(noColon.status, 401);
        assert.match(noColon.headers.get('www-authenticate') ?? '', /Basic/);
        const badEncoding = await token(
            { grant_type: 'refresh_token', refresh_token: 'x' },
            { authorization: `Basic ${Buffer.from('%E0:%').toString('base64')}` }
        );
        assert.equal(badEncoding.status, 401);
        const brokenJson = await fetch(`${base}/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
        });
        assert.equal(((await brokenJson.json()) as { error: string }).error, 'invalid_request');
        const shortVerifier = await authorize(registered.client_id, b64(randomBytes(32)));
        const shortCode = new URL(shortVerifier.back?.headers.get('location') as string).searchParams.get(
            'code'
        ) as string;
        const tooShort = await token({
            grant_type: 'authorization_code',
            code: shortCode,
            redirect_uri: LOOPBACK,
            client_id: registered.client_id,
            code_verifier: 'x',
        });
        assert.equal(((await tooShort.json()) as { error: string }).error, 'invalid_grant');
    });

    it('presents a managed identity token as client assertion (Container Apps, App Service)', async () => {
        // the managed identity endpoint of Container Apps / App Service, as @azure/identity calls it
        const identityRequests: URL[] = [];
        const identity = createServer((req, res) => {
            const url = new URL(req.url as string, 'http://localhost');
            identityRequests.push(url);
            if (req.headers['x-identity-header'] !== 'identity-secret') {
                res.writeHead(401).end();
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    access_token: ASSERTION,
                    expires_on: String(Math.floor(Date.now() / 1000) + 3600),
                    resource: url.searchParams.get('resource'),
                    token_type: 'Bearer',
                })
            );
        });
        const identityBase = await listen(identity);
        const previous = { endpoint: process.env.IDENTITY_ENDPOINT, header: process.env.IDENTITY_HEADER };
        process.env.IDENTITY_ENDPOINT = `${identityBase}/msi/token`;
        process.env.IDENTITY_HEADER = 'identity-secret';
        const miApp = createServer();
        const fileBase = base;
        base = await listen(miApp);
        try {
            const broker = new EntraBroker(
                { ...authConfig, clientAssertionFile: undefined, assertionIdentity: 'mi-client-id' },
                base,
                randomBytes(32),
                nullLoggers()
            );
            const server = express();
            server.use(broker.router());
            miApp.on('request', server);
            const { client_id } = (await (await register({ redirect_uris: [LOOPBACK] })).json()) as {
                client_id: string;
            };
            const verifier = b64(randomBytes(32));
            const { back } = await authorize(client_id, verifier);
            const code = new URL(back?.headers.get('location') as string).searchParams.get('code');
            assert.ok(code, back?.headers.get('location') ?? 'no redirect');
            assert.equal(entra.state.tokenRequests.at(-1)?.get('client_assertion'), ASSERTION);
            assert.equal(identityRequests[0]?.searchParams.get('client_id'), 'mi-client-id');
            assert.equal(identityRequests[0]?.searchParams.get('resource'), 'api://AzureADTokenExchange');
        } finally {
            base = fileBase;
            process.env.IDENTITY_ENDPOINT = previous.endpoint;
            process.env.IDENTITY_HEADER = previous.header;
            if (previous.endpoint === undefined) delete process.env.IDENTITY_ENDPOINT;
            if (previous.header === undefined) delete process.env.IDENTITY_HEADER;
            await new Promise((resolve) => miApp.close(resolve));
            await new Promise((resolve) => identity.close(resolve));
        }
    });

    it('requires the client secret from confidential clients', async () => {
        const registered = (await (
            await register({
                redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
                token_endpoint_auth_method: 'client_secret_post',
            })
        ).json()) as { client_id: string; client_secret: string };
        assert.ok(registered.client_secret);
        const without = await token({
            grant_type: 'refresh_token',
            refresh_token: 'x',
            client_id: registered.client_id,
        });
        assert.equal(without.status, 401);
        const basic = Buffer.from(
            `${encodeURIComponent(registered.client_id)}:${encodeURIComponent(registered.client_secret)}`
        ).toString('base64');
        const withSecret = await token(
            { grant_type: 'refresh_token', refresh_token: 'x' },
            { authorization: `Basic ${basic}` }
        );
        assert.equal(((await withSecret.json()) as { error: string }).error, 'invalid_grant');
    });
});
