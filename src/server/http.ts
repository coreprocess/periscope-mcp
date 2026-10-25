import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostHeaderValidation, originValidation, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { EntraBroker } from '../auth/broker.ts';
import { authEndpoints, claimsOf, createEntraVerifier, protectedResourceMetadata } from '../auth/entra.ts';
import type { Config } from '../config/env.ts';
import type { ToolContext } from '../tools/context.ts';
import { createMcpServer } from '../tools/tools.ts';
import { type DownloadDeps, downloadHandler } from './download.ts';

const MAX_BODY = 1024 * 1024;

export interface HttpOptions {
    /** Serve the MCP endpoint (http transport); stdio mode serves only the data plane. */
    mcp: boolean;
}

/**
 * Builds the Express app: RFC 9728 metadata, the MCP endpoint (stateless Streamable HTTP,
 * POST only) behind Entra bearer auth (or Periscope's own Entra-backed authorization server),
 * the download data plane and a health check.
 * No compression middleware anywhere: SSE and stored files must pass through unchanged.
 */
export const createHttpApp = (config: Config, context: ToolContext, downloads: DownloadDeps, options: HttpOptions) => {
    const app = express();
    app.disable('x-powered-by');
    app.set('etag', false);
    app.set('trust proxy', true);

    if (config.auth.mode === 'none') {
        // No authorization (localhost only): reject requests a web page sends through DNS rebinding or cross-site.
        const local = ['localhost', '127.0.0.1', '[::1]', new URL(config.publicUrl).hostname];
        app.use(hostHeaderValidation(local), originValidation(local));
    }

    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });

    const download = downloadHandler(downloads);
    app.get('/r/:token/*rest', (req, res) => void download(req, res));
    app.head('/r/:token/*rest', (req, res) => void download(req, res));

    if (options.mcp) {
        const mcp = toNodeHandler(
            createMcpHandler(() => createMcpServer(context), { legacy: 'stateless' }),
            {
                maxRequestBodySize: MAX_BODY,
            }
        );
        const handlers: express.RequestHandler[] = [];
        const requireRole = (req: Request, res: Response, next: NextFunction) => {
            const claims = claimsOf((req as Request & { auth?: Parameters<typeof claimsOf>[0] }).auth);
            if (!claims?.roles.includes(config.auth.requiredRole)) {
                res.status(403).json({
                    error: 'insufficient_role',
                    error_description: `The app role '${config.auth.requiredRole}' is required`,
                });
                return;
            }
            next();
        };
        if (config.auth.mode === 'entra') {
            const endpoints = authEndpoints(config.auth, context.publicUrl());
            app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
                res.json(protectedResourceMetadata(endpoints));
            });
            app.get('/.well-known/oauth-protected-resource', (_req, res) => {
                res.json(protectedResourceMetadata(endpoints));
            });
            handlers.push(
                requireBearerAuth({
                    verifier: createEntraVerifier(config.auth, endpoints),
                    requiredScopes: [endpoints.scope],
                    resourceMetadataUrl: endpoints.metadataUrl,
                }) as express.RequestHandler,
                requireRole
            );
        }
        if (config.auth.mode === 'entra-broker') {
            const broker = new EntraBroker(
                config.auth,
                context.publicUrl(),
                config.download.signingKey,
                context.loggers
            );
            app.use(broker.router());
            handlers.push(
                requireBearerAuth({
                    verifier: broker.verifier(),
                    requiredScopes: [],
                    resourceMetadataUrl: broker.metadataUrl,
                }) as express.RequestHandler,
                requireRole
            );
        }
        app.post('/mcp', ...handlers, express.json({ limit: MAX_BODY }), (req, res) => void mcp(req, res, req.body));
        app.all('/mcp', (_req, res) => {
            res.status(405)
                .set('Allow', 'POST')
                .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
        });
    }

    app.use((_req, res) => {
        res.status(404).json({ error: 'not found' });
    });
    return app;
};

export const listen = (app: express.Express, host: string, port: number): Promise<{ server: Server; port: number }> =>
    new Promise((resolve, reject) => {
        const server = app.listen(port, host, (error?: Error) => {
            if (error) reject(error);
            else resolve({ server, port: (server.address() as AddressInfo).port });
        });
        server.keepAliveTimeout = 10_000;
        server.headersTimeout = 15_000;
        server.requestTimeout = 0;
    });
