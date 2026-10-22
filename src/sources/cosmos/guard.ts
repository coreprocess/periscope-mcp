import { createDefaultHttpClient, type HttpClient, type PipelineRequest } from '@azure/core-rest-pipeline';
import { WireGuardError } from '../../core/errors.ts';

/**
 * Wire guard for Cosmos DB (concept §7.1 A2), attached through the SDK's public
 * `httpClient` option, so every request (data plane, metadata, account discovery)
 * passes through it. Only reads and queries reach the network:
 * - GET/HEAD (metadata, point reads, feeds, partition key ranges)
 * - POST with content-type application/query+json that is a query or a query-plan request
 * Everything else (create, upsert, replace, patch, delete, batch, stored procedures) is
 * rejected before it is sent.
 */
export const isAllowedCosmosRequest = (request: Pick<PipelineRequest, 'method' | 'headers'>): boolean => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    if (method !== 'POST') return false;
    const header = (name: string): string => request.headers.get(name)?.toLowerCase() ?? '';
    const isQuery =
        header('x-ms-documentdb-isquery') === 'true' || header('x-ms-cosmos-is-query-plan-request') === 'true';
    return isQuery && header('content-type').startsWith('application/query+json');
};

export const guardedCosmosHttpClient = (source: string, inner: HttpClient = createDefaultHttpClient()): HttpClient => ({
    sendRequest(request) {
        if (!isAllowedCosmosRequest(request)) {
            const path = new URL(request.url).pathname;
            return Promise.reject(new WireGuardError(source, `${request.method} ${path}`));
        }
        return inner.sendRequest(request);
    },
});
