import { DefaultAzureCredential } from '@azure/identity';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ResourceGraphSourceConfig } from '../../config/sources.ts';
import { PeriscopeError, WireGuardError } from '../../core/errors.ts';
import { compileFilter } from '../../core/glob.ts';
import type {
    DocumentStream,
    ExecutionContext,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { parseOptions, remaining } from '../common.ts';

/**
 * Azure Resource Graph through its query REST API. The API has no write operations; Periscope
 * only ever POSTs to the query endpoint (concept §7.1 A). The token is an Azure Resource Manager
 * token, so the identity should hold read roles only.
 */

const API_VERSION = '2024-04-01';
const QUERY_PATH = '/providers/Microsoft.ResourceGraph/resources';
const PAGE_ROWS = 1000;
const MAX_THROTTLE_RETRIES = 5;
const DEFAULT_THROTTLE_WAIT_MS = 5_000;

/** The tables agents usually need; Resource Graph has a few more for niche services. */
export const RESOURCE_GRAPH_TABLES: Record<string, string> = {
    resources: 'Resources of all types with their properties, tags, SKU, identity and location',
    resourcecontainers: 'Subscriptions, resource groups and management groups',
    securityresources:
        'Microsoft Defender for Cloud: alerts, assessments (recommendations), sub-assessments such as image vulnerabilities, secure scores, pricings, discovered API endpoints',
    resourcechanges: 'Changes to resources in the last 14 days: what changed, when and by whom',
    resourcecontainerchanges: 'Changes to subscriptions and resource groups in the last 14 days',
    authorizationresources: 'Role assignments and role definitions',
    policyresources: 'Azure Policy assignments, definitions and compliance states',
    advisorresources: 'Azure Advisor recommendations',
    alertsmanagementresources: 'Azure Monitor alerts',
    healthresources: 'Resource health and availability',
    servicehealthresources: 'Azure service health events',
    networkresources: 'Network Manager configurations and effective rules',
    kubernetesconfigurationresources: 'Kubernetes cluster extensions and Flux configurations',
    appserviceresources: 'App Service configuration details',
};

const optionsSchema = z.object({}).strict();

export type TokenProvider = () => Promise<string>;

interface GraphPage {
    data?: Record<string, unknown>[];
    resultTruncated?: string;
    $skipToken?: string;
    error?: { code?: string; message?: string; details?: GraphErrorDetail[] };
}
interface GraphErrorDetail {
    code?: string;
    message?: string;
    line?: number;
    characterPositionInLine?: number;
    token?: string;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });

/** How long a throttled request has to wait: the quota reset (`hh:mm:ss`), `Retry-After` (seconds) or a default. */
export const throttleWaitMs = (headers: Headers): number => {
    const reset = /^(\d+):(\d+):(\d+)$/.exec(headers.get('x-ms-user-quota-resets-after') ?? '');
    if (reset) return (Number(reset[1]) * 3600 + Number(reset[2]) * 60 + Number(reset[3])) * 1000 || 1000;
    const retryAfter = Number(headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return DEFAULT_THROTTLE_WAIT_MS;
};

/** The useful part of a Resource Graph error: the details, with the position of parser failures. */
export const errorText = (error: GraphPage['error'], status: number): string => {
    const details = (error?.details ?? []).map((d) =>
        d.token !== undefined ? `${d.code} at ${d.line}:${d.characterPositionInLine} near '${d.token}'` : d.message
    );
    const text = details.filter(Boolean).join('; ');
    return text || error?.message || `Resource Graph returned ${status}`;
};

export class ResourceGraphAdapter implements SourceAdapter {
    readonly config: ResourceGraphSourceConfig;
    readonly #tokenProvider: TokenProvider | undefined;
    #token: TokenProvider | undefined;

    constructor(config: ResourceGraphSourceConfig, options: { tokenProvider?: TokenProvider } = {}) {
        this.config = config;
        this.#tokenProvider = options.tokenProvider;
    }

    async init(_log: Logger): Promise<void> {
        if (this.#tokenProvider) {
            this.#token = this.#tokenProvider;
            return;
        }
        const credential = new DefaultAzureCredential();
        const scope = `${this.config.endpoint}/.default`;
        this.#token = async () => (await credential.getToken(scope)).token;
    }

    /** The only network call this source makes: one page of a query, retried while throttled. */
    async #page(
        query: string,
        skipToken: string | undefined,
        signal: AbortSignal,
        deadline: number
    ): Promise<GraphPage> {
        const url = new URL(`${this.config.endpoint}${QUERY_PATH}?api-version=${API_VERSION}`);
        if (url.pathname !== QUERY_PATH || url.search !== `?api-version=${API_VERSION}`) {
            throw new WireGuardError(this.config.name, `POST ${url}`);
        }
        if (!this.#token) throw new PeriscopeError('internal', `Source '${this.config.name}' is not initialized`);
        const body = JSON.stringify({
            query,
            ...(this.config.subscriptions.length > 0 ? { subscriptions: this.config.subscriptions } : {}),
            ...(this.config.managementGroups.length > 0 ? { managementGroups: this.config.managementGroups } : {}),
            options: { resultFormat: 'objectArray', $top: PAGE_ROWS, ...(skipToken ? { $skipToken: skipToken } : {}) },
        });
        for (let attempt = 0; ; attempt++) {
            const response = await fetch(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${await this.#token()}`, 'content-type': 'application/json' },
                body,
                signal: AbortSignal.any([signal, AbortSignal.timeout(remaining(deadline))]),
            });
            const page = (await response.json().catch(() => ({}))) as GraphPage;
            if (response.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
                const wait = throttleWaitMs(response.headers);
                if (Date.now() + wait >= deadline)
                    throw new PeriscopeError(
                        'source_error',
                        'Resource Graph is throttling this identity; try again later'
                    );
                await sleep(wait, signal);
                continue;
            }
            if (!response.ok || page.error)
                throw new PeriscopeError('source_error', errorText(page.error, response.status));
            return page;
        }
    }

    /** All rows of a query, page by page. */
    async *#rows(query: string, signal: AbortSignal, deadline: number): AsyncGenerator<Record<string, unknown>[]> {
        let skipToken: string | undefined;
        do {
            if (signal.aborted) return;
            const page = await this.#page(query, skipToken, signal, deadline);
            if (page.resultTruncated === 'true' && !page.$skipToken) {
                throw new PeriscopeError(
                    'too_large',
                    `Resource Graph cut the result off and cannot page it (a take or limit above ${PAGE_ROWS} rows); remove the take or limit, or aggregate further`
                );
            }
            if (page.data && page.data.length > 0) yield page.data;
            skipToken = page.$skipToken;
        } while (skipToken);
    }

    info(): SourceInfo {
        const scope =
            this.config.subscriptions.length > 0
                ? `subscriptions ${this.config.subscriptions.join(', ')}`
                : this.config.managementGroups.length > 0
                  ? `management groups ${this.config.managementGroups.join(', ')}`
                  : 'every subscription the identity may read';
        return {
            name: this.config.name,
            type: 'resourcegraph',
            description: this.config.description,
            queryLanguage: 'KQL (Azure Resource Graph subset)',
            dialectHints: [
                `Scope: ${scope}.`,
                'Tables: resources, resourcecontainers, securityresources (Defender for Cloud), resourcechanges (last 14 days), authorizationresources, policyresources, advisorresources, …; describe lists them, describe(table) lists the types in one.',
                "Filter by type first: securityresources | where type == 'microsoft.security/locations/alerts'.",
                `Results are paged automatically. A take or limit above ${PAGE_ROWS} rows cannot be paged and fails; leave it out instead.`,
                'There is no time range option: filter on the table’s own timestamps (e.g. properties.changeAttributes.timestamp in resourcechanges).',
            ],
            options: {},
            params: 'not used',
            readOnlyLayers: [
                'query API only (it has no write operations)',
                'single hard-coded endpoint: POST …/providers/Microsoft.ResourceGraph/resources',
            ],
            credential: 'unverified',
            credentialNote:
                'Azure Resource Manager token: assign read roles only (Reader, Security Reader); Periscope sends it to the Resource Graph query endpoint only',
        };
    }

    async validate(query: string, _params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        parseOptions(optionsSchema, options);
        const trimmed = query.trim();
        if (!trimmed) throw new PeriscopeError('invalid_argument', 'query must not be empty');
        return { query: trimmed, params: null, options: {} };
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        return {
            format: 'ndjson',
            batches: this.#rows(prepared.query, context.signal, context.deadline),
        } satisfies DocumentStream;
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const matches = compileFilter(filter);
        if (!path) {
            return {
                level: 'tables',
                tables: Object.entries(RESOURCE_GRAPH_TABLES)
                    .filter(([table]) => matches(table))
                    .map(([table, contents]) => ({ table, contents })),
            };
        }
        const table = path.toLowerCase();
        if (!/^[a-z]+$/.test(table)) throw new PeriscopeError('invalid_argument', `Invalid table name '${path}'`);
        const types: { type: unknown; rows: unknown }[] = [];
        const deadline = Date.now() + 120_000;
        for await (const rows of this.#rows(
            `${table} | summarize rows = count() by type | order by rows desc`,
            AbortSignal.timeout(120_000),
            deadline
        )) {
            for (const row of rows) if (matches(String(row.type))) types.push({ type: row.type, rows: row.rows });
        }
        return { level: 'table', table, types };
    }

    async close(): Promise<void> {
        // stateless HTTP calls; nothing to close
    }
}
