import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Cosmos DB gateway that speaks just enough of the REST protocol for
 * `@azure/cosmos` to run cross-partition queries: account, container, partition key
 * ranges, query plan and one page per partition key range. Tests script the pages, so
 * they can reproduce what an emulator never does: empty pages, 429, 410 after a split
 * and requests that are never answered.
 */

export interface MockRange {
    id: string;
    minInclusive: string;
    maxExclusive: string;
}

export interface MockReply {
    status?: number;
    headers?: Record<string, string>;
    documents?: unknown[];
    /** Continuation token for the next page of this range. */
    continuation?: string;
    message?: string;
    /** Never answer: the request stays open until the client gives up. */
    hang?: boolean;
}

export interface MockPageRequest {
    rangeId: string;
    continuation: string | undefined;
    /** 1 for the first request to this range, counting up. */
    call: number;
    query: string;
}

export interface MockCosmosOptions {
    /** Evaluated on every read, so a test can replace the ranges to play a split. */
    ranges: () => MockRange[];
    /** The `queryInfo` part of the query plan (the gateway's rewrite of the query). */
    queryInfo: Record<string, unknown>;
    page: (request: MockPageRequest) => MockReply;
    /** Overrides the answer to a query plan or range list request, e.g. to throttle it or leave it open. */
    metadata?: (kind: 'plan' | 'ranges') => MockReply | undefined;
}

export interface MockCosmos {
    endpoint: string;
    /** Requests seen so far, by kind. `pages` counts per partition key range. */
    counts: { plan: number; ranges: number; pages: Record<string, number> };
    close(): Promise<void>;
}

/** The query plan of a query that needs no client-side work: pages are passed through. */
export const PLAIN_QUERY_INFO = {
    distinctType: 'None',
    top: null,
    offset: null,
    limit: null,
    orderBy: [],
    orderByExpressions: [],
    groupByExpressions: [],
    groupByAliases: [],
    aggregates: [],
    groupByAliasToAggregateType: {},
    rewrittenQuery: '',
    hasSelectValue: false,
    dCountInfo: null,
    hasNonStreamingOrderBy: false,
};

/** `count` ranges that split the hash space evenly, with ids `0` to `count - 1`. */
export const evenRanges = (count: number): MockRange[] =>
    Array.from({ length: count }, (_, i) => {
        const bound = (n: number): string =>
            n === 0
                ? ''
                : n === count
                  ? 'FF'
                  : Math.floor((n * 255) / count)
                        .toString(16)
                        .toUpperCase()
                        .padStart(2, '0');
        return { id: String(i), minInclusive: bound(i), maxExclusive: bound(i + 1) };
    });

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
};

const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'x-ms-request-charge': '1', ...headers });
    response.end(JSON.stringify(body));
};

export const startMockCosmos = async (options: MockCosmosOptions): Promise<MockCosmos> => {
    const counts: MockCosmos['counts'] = { plan: 0, ranges: 0, pages: {} };
    const open = new Set<ServerResponse>();
    let endpoint = '';

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const path = (request.url ?? '/').split('?')[0] ?? '/';
        const header = (name: string): string | undefined => {
            const value = request.headers[name];
            return Array.isArray(value) ? value[0] : value;
        };
        if (request.method === 'GET' && path === '/') {
            const location = [{ name: 'Mock', databaseAccountEndpoint: endpoint }];
            send(response, 200, {
                id: 'mock',
                _rid: 'mock',
                _self: '',
                media: '//media/',
                addresses: '//addresses/',
                _dbs: '//dbs/',
                enableMultipleWriteLocations: false,
                writableLocations: location,
                readableLocations: location,
                userConsistencyPolicy: { defaultConsistencyLevel: 'Session' },
                userReplicationPolicy: { minReplicaSetSize: 1, maxReplicasetSize: 1, asyncReplication: false },
                systemReplicationPolicy: { minReplicaSetSize: 1, maxReplicasetSize: 1 },
                readPolicy: { primaryReadCoefficient: 1, secondaryReadCoefficient: 1 },
                queryEngineConfiguration: '{}',
            });
            return;
        }
        if (request.method === 'GET' && /^\/dbs\/[^/]+\/colls\/[^/]+$/.test(path)) {
            const id = path.split('/')[4];
            send(response, 200, { id, _rid: 'coll', partitionKey: { paths: ['/pk'], kind: 'Hash', version: 2 } });
            return;
        }
        const overridden = (kind: 'plan' | 'ranges'): boolean => {
            const reply = options.metadata?.(kind);
            if (!reply) return false;
            if (!reply.hang) {
                const status = reply.status ?? 500;
                send(response, status, { code: String(status), message: reply.message ?? '' }, reply.headers);
            }
            return true;
        };
        if (request.method === 'GET' && path.endsWith('/pkranges')) {
            counts.ranges++;
            if (overridden('ranges')) return;
            const ranges = options.ranges().map((range) => ({ ...range, _rid: `r${range.id}`, status: 'online' }));
            send(response, 200, { _rid: 'coll', PartitionKeyRanges: ranges, _count: ranges.length });
            return;
        }
        if (request.method !== 'POST' || !path.endsWith('/docs')) {
            send(response, 405, { code: 'MethodNotAllowed', message: `${request.method} ${path}` });
            return;
        }
        const query = (JSON.parse(await readBody(request)) as { query: string }).query;
        if (header('x-ms-cosmos-is-query-plan-request')?.toLowerCase() === 'true') {
            counts.plan++;
            if (overridden('plan')) return;
            send(response, 200, {
                partitionedQueryExecutionInfoVersion: 2,
                queryInfo: options.queryInfo,
                queryRanges: [{ min: '', max: 'FF', isMinInclusive: true, isMaxInclusive: false }],
            });
            return;
        }
        const rangeId = header('x-ms-documentdb-partitionkeyrangeid');
        if (rangeId === undefined) {
            // what the gateway answers to a cross-partition query it cannot serve on its own
            send(
                response,
                400,
                {
                    code: 'BadRequest',
                    message: 'The provided cross partition query can not be directly served by the gateway.',
                    additionalErrorInfo: '{}',
                },
                { 'x-ms-substatus': '1004' }
            );
            return;
        }
        const call = (counts.pages[rangeId] ?? 0) + 1;
        counts.pages[rangeId] = call;
        const reply = options.page({ rangeId, continuation: header('x-ms-continuation'), call, query });
        if (reply.hang) return;
        const status = reply.status ?? 200;
        const headers = {
            ...(reply.continuation ? { 'x-ms-continuation': reply.continuation } : {}),
            ...reply.headers,
        };
        if (status >= 400) {
            send(response, status, { code: String(status), message: reply.message ?? `status ${status}` }, headers);
            return;
        }
        const documents = reply.documents ?? [];
        send(response, 200, { _rid: 'coll', Documents: documents, _count: documents.length }, headers);
    };

    const server = createServer((request, response) => {
        open.add(response);
        response.on('close', () => open.delete(response));
        handle(request, response).catch((error: unknown) => send(response, 500, { message: String(error) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    return {
        endpoint,
        counts,
        close: async () => {
            for (const response of open) response.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};

/** Replies of a partition that throttles: 429 with the wait the service asks for. */
export const throttled = (retryAfterMs: number): MockReply => ({
    status: 429,
    message: 'Request rate is large',
    headers: { 'x-ms-retry-after-ms': String(retryAfterMs), 'x-ms-substatus': '3200' },
});

/** Reply of a partition key range that no longer exists after a split. */
export const GONE: MockReply = {
    status: 410,
    message: 'Partition key range is gone',
    headers: { 'x-ms-substatus': '1002' },
};
