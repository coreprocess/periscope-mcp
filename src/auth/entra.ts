import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, type JWTPayload, errors as joseErrors, jwtVerify } from 'jose';
import type { AuthConfig } from '../config/env.ts';

/**
 * OAuth 2.1 resource server for Microsoft Entra ID v2 (concept §7.2). Periscope never
 * issues OAuth tokens; it validates Entra access tokens and publishes RFC 9728 metadata.
 */

export interface AuthEndpoints {
    /** Canonical MCP resource URL, e.g. https://periscope.example.com/mcp */
    resource: string;
    metadataUrl: string;
    /** Fully qualified scope clients request: `<resource>/<scope name>` */
    scope: string;
    issuer: string;
    authorizationServer: string;
    jwksUri: string;
}

export const authEndpoints = (auth: AuthConfig, publicUrl: string): AuthEndpoints => {
    const resource = `${publicUrl}/mcp`;
    const tenant = auth.tenantId ?? 'common';
    const issuer = auth.issuer ?? `https://login.microsoftonline.com/${tenant}/v2.0`;
    return {
        resource,
        metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
        scope: `${resource}/${auth.scopeName}`,
        issuer,
        authorizationServer: auth.authorizationServer ?? issuer,
        jwksUri: auth.jwksUri ?? `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
    };
};

/** RFC 9728 Protected Resource Metadata document. */
export const protectedResourceMetadata = (endpoints: AuthEndpoints): Record<string, unknown> => ({
    resource: endpoints.resource,
    authorization_servers: [endpoints.authorizationServer],
    scopes_supported: [endpoints.scope],
    bearer_methods_supported: ['header'],
    resource_name: 'Periscope MCP',
});

export interface CallerClaims {
    oid: string;
    name: string | undefined;
    roles: string[];
    tenantId: string | undefined;
    clientId: string | undefined;
}

export const claimsOf = (auth: AuthInfo | undefined): CallerClaims | undefined => {
    const extra = auth?.extra as Partial<CallerClaims> | undefined;
    if (!extra?.oid) return undefined;
    return {
        oid: extra.oid,
        name: extra.name,
        roles: extra.roles ?? [],
        tenantId: extra.tenantId,
        clientId: extra.clientId,
    };
};

/**
 * Validates Entra v2 access tokens: signature (JWKS), issuer, tenant, audience (the app's
 * client ID GUID; v2 tokens never carry the URL), expiry, scope and roles.
 */
export const createEntraVerifier = (auth: AuthConfig, endpoints: AuthEndpoints): OAuthTokenVerifier => {
    const jwks = createRemoteJWKSet(new URL(endpoints.jwksUri));
    const audience = [auth.clientId as string, endpoints.resource];
    return {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            let payload: JWTPayload;
            try {
                ({ payload } = await jwtVerify(token, jwks, {
                    issuer: endpoints.issuer,
                    audience,
                    algorithms: ['RS256'],
                    clockTolerance: 60,
                }));
            } catch (error) {
                const reason = error instanceof joseErrors.JOSEError ? error.code : 'invalid token';
                throw new OAuthError(OAuthErrorCode.InvalidToken, reason);
            }
            if (auth.tenantId && payload.tid !== auth.tenantId) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'token from another tenant');
            }
            if (typeof payload.oid !== 'string') throw new OAuthError(OAuthErrorCode.InvalidToken, 'token without oid');
            const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean) : [];
            const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
            const claims: CallerClaims = {
                oid: payload.oid,
                name: (payload.preferred_username ?? payload.upn ?? payload.name) as string | undefined,
                roles,
                tenantId: payload.tid as string | undefined,
                clientId: (payload.azp ?? payload.appid) as string | undefined,
            };
            return {
                token,
                clientId: claims.clientId ?? '',
                // Entra puts the short scope name in `scp`; the requestable form is `<resource>/<name>`.
                scopes: scopes.map((s) => (s.includes('/') ? s : `${endpoints.resource}/${s}`)),
                ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
                extra: claims as unknown as Record<string, unknown>,
            };
        },
    };
};
