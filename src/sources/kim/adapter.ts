import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { KimSourceConfig } from '../../config/sources.ts';
import { PeriscopeError } from '../../core/errors.ts';
import type {
    DocumentStream,
    ExecutionContext,
    FileContent,
    FileProvider,
    FileReference,
    PreparedQuery,
    ResultStream,
    SourceAdapter,
    SourceInfo,
} from '../adapter.ts';
import { filterRegex, parseOptions, remaining } from '../common.ts';
import { KimClient } from './client.ts';
import { memberDocuments, type NodeEnvelope } from './documents.ts';
import { analyzeKimQuery } from './guard.ts';
import { type KimPlan, literalOf, nodePage, planKimQuery, recordPage } from './query.ts';

const WINDOW_MAX = 500;
const DESCRIBE_LIMIT = 500;

const optionsSchema = z.object({ snapshotId: z.string().min(1).optional() }).strict();

interface QuerySection {
    records?: { hydrate?: Record<string, Record<string, unknown>> };
    membership?: { hydrate?: Record<string, number> };
    stats?: { filtered?: { after?: number } };
    error?: { code?: string; size?: number; budget?: number };
}

interface LiveAnswer {
    clock?: { snapshot?: { to?: string } };
    queries: Record<string, QuerySection>;
    nodes?: { update?: Record<string, NodeEnvelope> };
}

interface Collection {
    id: string;
    name: string | null;
    parent: string | null;
}

interface TypeProperty {
    id: string;
    title?: string;
    value?: { type?: string; args?: Record<string, unknown> };
    isRequired?: boolean;
    isTitle?: boolean;
    isSensitive?: string;
    isSecret?: string;
}

interface TypeDefinition {
    title?: string;
    content?: { value?: { args?: { properties?: TypeProperty[] } } };
}

/** A query section that exceeded KIM's result budget; the page is retried smaller. */
class BudgetExceeded extends Error {}

/** KIM (node and record query language) over its HTTP API, with a wire allowlist. */
export class KimAdapter implements SourceAdapter {
    readonly config: KimSourceConfig;
    readonly #client: KimClient;
    readonly #typeTitles = new Map<string, Promise<string>>();

    constructor(config: KimSourceConfig) {
        this.config = config;
        this.#client = new KimClient(config);
    }

    async init(_log: Logger): Promise<void> {
        // Exchanges the key and proves the stage is reachable for this account.
        await this.#collections(null);
    }

    info(): SourceInfo {
        return {
            name: this.config.name,
            type: 'kim',
            description: this.config.description,
            queryLanguage: 'KIM node or record query language (one query)',
            dialectHints: [
                `Address collections as ${this.config.url}/${this.config.stage}/<collection alias or id>.`,
                'Node query: from <collection url> [where …] [order by …] [pick …] → one document per object, typed.',
                'Record query: from … [where …] select a = $.x, … | summarize n = count() by $.y | distinct … → one document per record.',
                'Omit the window: Periscope pages through all matches at one snapshot. A written first/last N returns exactly that window.',
                'Node queries without a window can only be ordered by plain fields ($.field) or $::position.',
                'Literals: "text", 12.5, true, PreciseNumber(1.25), Instant(2026-01-01T00:00:00Z), LocalDate(2026-01-01), Reference(<url>).',
                'Record values that KIM offloads (large text, bytes) arrive as null; node queries link them as files.',
                'Withheld (sensitive, secret, permission) values are left out of records and listed under `withheld` in node documents.',
            ],
            options: { snapshotId: 'string: read at this snapshot (KIM snapshot id) instead of the latest' },
            params: 'not used; write literals into the query',
            readOnlyLayers: [
                'service account key with only the Reader role (KIM access model)',
                'wire allowlist: only query, collection listing, capabilities, key exchange, type definitions and Bytes reads',
                `query check: one query from/at/referrers, no reveal${this.config.allowReveal ? ' (reveal allowed)' : ''}, no foreign origins, no drafts`,
            ],
            credential: 'unverified',
            credentialNote: 'KIM grants what the service account is assigned; assign only the Reader role',
        };
    }

    async validate(query: string, params: unknown, options: Record<string, unknown>): Promise<PreparedQuery> {
        const opts = parseOptions(optionsSchema, options);
        const empty = params === undefined || params === null || (Array.isArray(params) && params.length === 0);
        if (!empty && !(typeof params === 'object' && Object.keys(params as object).length === 0)) {
            throw new PeriscopeError('invalid_argument', 'KIM queries take no params; write literals into the query');
        }
        const analysis = analyzeKimQuery(query, { origin: this.config.url, allowReveal: this.config.allowReveal });
        return { query, params: undefined, options: opts, plan: planKimQuery(analysis) };
    }

    async #query(text: string, snapshotId: string | undefined, context: ExecutionContext): Promise<LiveAnswer> {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(remaining(context.deadline))]);
        const answer = await this.#client.rpc<LiveAnswer>(
            '/rpc/live/query',
            { stage: this.config.stage, ...(snapshotId ? { clock: { snapshotId } } : {}), queries: { q: text } },
            signal
        );
        context.addCost({ kimQueries: 1 });
        const section = answer.queries.q;
        if (section?.error?.code === 'resultBudget') throw new BudgetExceeded();
        if (!section || section.error) {
            throw new PeriscopeError('source_error', `KIM query failed: ${JSON.stringify(section?.error ?? {})}`);
        }
        return answer;
    }

    async execute(prepared: PreparedQuery, context: ExecutionContext): Promise<ResultStream> {
        const plan = prepared.plan as KimPlan;
        const options = prepared.options as z.infer<typeof optionsSchema>;
        let snapshotId = options.snapshotId;
        const run = async (text: string): Promise<LiveAnswer> => {
            const answer = await this.#query(text, snapshotId, context);
            snapshotId ??= answer.clock?.snapshot?.to;
            return answer;
        };
        let files = 0;
        let fileBytes = 0;
        const toDocuments = (answer: LiveAnswer): unknown[] => {
            const section = answer.queries.q as QuerySection;
            if (section.records) return ranked(section.records.hydrate ?? {});
            const members = ranked(section.membership?.hydrate ?? {}, true) as string[];
            const documents = memberDocuments(members, answer.nodes?.update ?? {}, context.fileReference);
            for (const document of documents) {
                for (const file of Object.values(document.files ?? {})) {
                    files++;
                    fileBytes += file.size;
                }
            }
            return documents;
        };
        /** Runs one page, halving the page size while KIM's result budget is exceeded. */
        const page = async (build: (size: number) => string, size: number): Promise<[LiveAnswer, number]> => {
            for (let current = size; ; current = Math.floor(current / 2)) {
                try {
                    return [await run(build(current)), current];
                } catch (error) {
                    if (!(error instanceof BudgetExceeded)) throw error;
                    if (current <= 1)
                        throw new PeriscopeError('too_large', 'A single KIM result exceeds the result budget');
                }
            }
        };
        const batches = async function* (): AsyncGenerator<unknown[]> {
            if (plan.mode === 'single') {
                try {
                    yield toDocuments(await run(plan.text));
                } catch (error) {
                    if (error instanceof BudgetExceeded) {
                        throw new PeriscopeError(
                            'too_large',
                            'The KIM result exceeds the result budget; narrow the window'
                        );
                    }
                    throw error;
                }
                return;
            }
            if (plan.mode === 'records') {
                let size = WINDOW_MAX;
                for (let skip = 0; ; ) {
                    const [answer, used] = await page((n) => recordPage(plan.text, n, skip), size);
                    const rows = toDocuments(answer);
                    if (rows.length > 0) yield rows;
                    if (rows.length < used) return;
                    skip += rows.length;
                    size = used;
                }
            }
            let size = WINDOW_MAX;
            let anchor: string | undefined;
            for (;;) {
                const [answer, used] = await page((n) => nodePage(plan, n, anchor), size);
                const section = answer.queries.q as QuerySection;
                const members = ranked(section.membership?.hydrate ?? {}, true) as string[];
                if (members.length > 0) yield toDocuments(answer);
                const last = members.at(-1);
                if (!last || (section.stats?.filtered?.after ?? 0) === 0) return;
                anchor = anchorOf(plan, last, answer.nodes?.update ?? {});
                size = used;
            }
        };
        return {
            format: 'ndjson',
            batches: batches(),
            blobTotals: () => ({ count: files, bytes: fileBytes }),
        } satisfies DocumentStream;
    }

    async #collections(parent: string | null): Promise<Collection[]> {
        const entries: Collection[] = [];
        let after: string | undefined;
        do {
            const page = await this.#client.rpc<{ entries: Collection[]; next?: string }>(
                '/rpc/collection/listCollections',
                { stage: this.config.stage, parent, ...(after ? { after } : {}) }
            );
            entries.push(...page.entries);
            after = page.next;
        } while (after && entries.length < DESCRIBE_LIMIT);
        return entries;
    }

    /** Resolves a dotted collection alias (`claims.hail`) or an id to the collection. */
    async #resolveCollection(spec: string): Promise<Collection> {
        let parent: string | null = null;
        let found: Collection | undefined;
        const byId = (await this.#collections(null)).find((c) => c.id === spec);
        if (byId) return byId;
        for (const label of spec.split('.')) {
            const children: Collection[] = await this.#collections(parent);
            found = children.find((c) => c.name === label || c.id === label);
            if (!found) throw new PeriscopeError('not_found', `Collection '${spec}' not found`);
            parent = found.id;
        }
        return found as Collection;
    }

    #typeTitle(url: string): Promise<string> {
        let title = this.#typeTitles.get(url);
        if (!title) {
            title = this.#client
                .typeDefinition<TypeDefinition>(url)
                .then((definition) => definition.title ?? url)
                .catch(() => url);
            this.#typeTitles.set(url, title);
        }
        return title;
    }

    async describe(path: string | undefined, filter: string | undefined): Promise<unknown> {
        const matches = filterRegex(filter);
        const [collectionSpec, typeSpec] = (path ?? '').split('/').filter(Boolean);
        if (!collectionSpec) {
            const collections = (await this.#collections(null)).filter((c) => matches.test(c.name ?? c.id));
            return { level: 'collections', stage: this.config.stage, collections };
        }
        const collection = await this.#resolveCollection(collectionSpec);
        const collectionUrl = `${this.config.url}/${this.config.stage}/${collection.id}`;
        const census = await this.#client.rpc<LiveAnswer>('/rpc/live/query', {
            stage: this.config.stage,
            queries: {
                q: `from ${collectionUrl} summarize n = count() by app = $::descriptor order by n desc first ${WINDOW_MAX}`,
            },
        });
        const types = await Promise.all(
            ranked(census.queries.q?.records?.hydrate ?? {}).map(async (row) => {
                const record = row as { app?: { type?: string }; n?: number };
                const url = record.app?.type ?? '';
                return { type: url ? await this.#typeTitle(url) : null, typeUrl: url || null, objects: record.n ?? 0 };
            })
        );
        if (!typeSpec) {
            return {
                level: 'collection',
                collection: { ...collection, url: collectionUrl },
                collections: (await this.#collections(collection.id)).filter((c) => matches.test(c.name ?? c.id)),
                types: types.filter((t) => matches.test(t.type ?? '')),
            };
        }
        const type = types.find((t) => t.type === typeSpec || t.typeUrl?.includes(`/${typeSpec}@`));
        if (!type?.typeUrl)
            throw new PeriscopeError('not_found', `Type '${typeSpec}' not found in '${collectionSpec}'`);
        const definition = await this.#client.typeDefinition<TypeDefinition>(type.typeUrl);
        const properties = await Promise.all(
            (definition.content?.value?.args?.properties ?? [])
                .filter((p) => matches.test(p.id))
                .map(async (p) => ({
                    id: p.id,
                    title: p.title ?? null,
                    type: p.value?.type ? await this.#typeTitle(p.value.type) : null,
                    args: p.value?.args ?? {},
                    ...(p.isRequired ? { required: true } : {}),
                    ...(p.isTitle ? { titleField: true } : {}),
                    ...(p.isSensitive ? { sensitive: p.isSensitive } : {}),
                    ...(p.isSecret ? { secret: p.isSecret } : {}),
                }))
        );
        return {
            level: 'type',
            type: definition.title ?? typeSpec,
            typeUrl: type.typeUrl,
            objects: type.objects,
            properties,
        };
    }

    get files(): FileProvider {
        return this;
    }

    async openFile(reference: FileReference, range?: { offset: number; length: number }): Promise<FileContent> {
        const [collection, object, ...path] = reference.name.split('/');
        const objectPath = `${reference.container}/${collection}/${object}@${reference.versionId}`;
        const headers: Record<string, string> = range
            ? { range: `bytes=${range.offset}-${range.offset + Math.max(range.length, 1) - 1}` }
            : {};
        const response = await this.#client.bytes('GET', `${objectPath}/${path.join('/')}`, headers);
        const size = Number(response.headers.get('kim-byte-size') ?? response.headers.get('content-length') ?? 0);
        const contentRange = /bytes (\d+)-(\d+)\//.exec(response.headers.get('content-range') ?? '');
        let contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        if (contentType === 'application/octet-stream' && path.join('/') === 'content') {
            contentType = (await this.#mediaType(objectPath)) ?? contentType;
        }
        return {
            size,
            contentType,
            etag: response.headers.get('etag') ?? '',
            stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
            ...(contentRange ? { range: { start: Number(contentRange[1]), end: Number(contentRange[2]) } } : {}),
        };
    }

    /** The media type a File object declares next to its content. */
    async #mediaType(objectPath: string): Promise<string | undefined> {
        const url = `${this.config.url}/${objectPath}`;
        const answer = await this.#client.rpc<LiveAnswer>('/rpc/live/query', {
            stage: this.config.stage,
            queries: { q: `at ${url} pick $.mediaType` },
        });
        const node = Object.entries(answer.nodes?.update ?? {}).find(([key]) => key.endsWith('/mediaType'))?.[1];
        const value = node?.value?.replace;
        return typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : undefined;
    }

    async close(): Promise<void> {
        // fetch keeps no connections that need closing
    }
}

/** Values of a rank-keyed map (`{"0": …, "1": …}`), in rank order; `keys` returns the keys by rank. */
const ranked = (hydrate: Record<string, unknown>, keys = false): unknown[] =>
    keys
        ? Object.entries(hydrate as Record<string, number>)
              .sort(([, a], [, b]) => a - b)
              .map(([key]) => key)
        : Object.entries(hydrate)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, value]) => value);

/** The `after` anchor for the next node page: the last member's order keys and its position. */
const anchorOf = (
    plan: Extract<KimPlan, { mode: 'nodes' }>,
    member: string,
    pool: Record<string, NodeEnvelope>
): string => {
    const root = pool[member];
    if (!root?.position) throw new PeriscopeError('source_error', 'KIM answer lacks the member position for paging');
    const literals = plan.keys.map((key) => {
        if (!key.path) return JSON.stringify(root.position);
        const node = pool[`${member}/${key.path}`];
        if (!node) return 'undefined';
        if (node.withheld) {
            throw new PeriscopeError(
                'source_error',
                `Cannot page past an object whose order key '$.${key.path}' is withheld (${node.withheld}); add your own window`
            );
        }
        return literalOf(node.shape, node.value ? node.value.replace : null);
    });
    return [...literals, JSON.stringify(root.position)].join(', ');
};
