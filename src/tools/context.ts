import type { Config } from '../config/env.ts';
import type { SourceConfig } from '../config/sources.ts';
import { PeriscopeError } from '../core/errors.ts';
import type { Loggers } from '../core/logger.ts';
import type { Signer } from '../core/signing.ts';
import type { Caller, ResultService } from '../results/service.ts';
import type { SourceRegistry } from '../sources/registry.ts';

/** Everything the tools need. One instance per server. */
export interface ToolContext {
    config: Config;
    service: ResultService;
    registry: SourceRegistry;
    signer: Signer;
    loggers: Loggers;
    /** Base URL for download links; may be resolved after the HTTP listener starts. */
    publicUrl: () => string;
}

/** Callers without a token (stdio, or http with auth disabled on localhost) hold every role. */
export const LOCAL_CALLER: Caller = { oid: 'local', name: 'local user', roles: new Set(['*']) };

export const hasRole = (caller: Caller, role: string | undefined): boolean =>
    role === undefined || caller.roles.has('*') || caller.roles.has(role);

export const canUseSource = (caller: Caller, source: SourceConfig): boolean => hasRole(caller, source.requiredRole);

export const canDownload = (caller: Caller, source: SourceConfig): boolean =>
    canUseSource(caller, source) && hasRole(caller, source.downloadRole);

export const requireSource = (context: ToolContext, caller: Caller, name: string): SourceConfig => {
    const source = context.registry.configs().find((c) => c.name === name);
    // Unknown and forbidden sources look the same, so names of hidden sources do not leak.
    if (!source || !canUseSource(caller, source)) {
        throw new PeriscopeError('unknown_source', `Unknown source '${name}'; call list_sources`);
    }
    return source;
};

/** Signed, expiring base URL for one result: `<public>/r/<token>`. */
export const downloadBase = (
    context: ToolContext,
    caller: Caller,
    resultId: string,
    resultExpiresAt: string
): { base: string; expiresAt: string } => {
    const expires = Math.min(Date.now() + context.config.download.urlTtlMs, Date.parse(resultExpiresAt));
    const token = context.signer.signToken({ r: resultId, u: caller.oid, e: Math.floor(expires / 1000) });
    return { base: `${context.publicUrl()}/r/${token}`, expiresAt: new Date(expires).toISOString() };
};
