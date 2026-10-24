import { PeriscopeError, QueryRejectedError } from '../../core/errors.ts';
import type { KimQueryAnalysis, KimToken } from './guard.ts';

/**
 * How a KIM query is paged. KIM answers at most one window (≤ 500) per query and keeps
 * no cursor, so Periscope pages itself, always at one pinned snapshot:
 * - record queries: `first <n> skip <m>` appended after the projection;
 * - node queries without a window: `first <n> after (<keys…>, "<position>")` inserted
 *   before `pick`, with anchors built from the last member's order keys;
 * - node queries with their own window, and `at` queries: one request, as written.
 */

export interface OrderKey {
    /** The key's node path below the member (`a.b` for `$.a.b`), or undefined for `$::position`. */
    path: string | undefined;
}

export type KimPlan =
    | { mode: 'single'; text: string; records: boolean }
    | { mode: 'records'; text: string }
    | { mode: 'nodes'; head: string; tail: string; keys: OrderKey[]; pickKeys: string };

const isWord = (token: KimToken | undefined, word: string): boolean =>
    token?.type === 'word' && token.value.toLowerCase() === word;

const firstClause = (analysis: KimQueryAnalysis, words: string[]): number | undefined => {
    const indexes = words.flatMap((word) => analysis.clauses.get(word) ?? []);
    return indexes.length > 0 ? Math.min(...indexes) : undefined;
};

/** Parses `order by` keys; only plain paths (`$.a.b`) and `$::position` can be anchored. */
const parseOrderKeys = (analysis: KimQueryAnalysis): OrderKey[] => {
    const order = analysis.clauses.get('order')?.[0];
    if (order === undefined) return [];
    const { tokens } = analysis;
    if (!isWord(tokens[order + 1], 'by')) throw new QueryRejectedError("Expected 'order by'");
    const end = firstClause(analysis, ['first', 'last', 'pick', 'reveal']) ?? tokens.length;
    const keys: OrderKey[] = [];
    let current: KimToken[] = [];
    const finish = (): void => {
        const parts = current.filter((t) => !['asc', 'desc', 'collated'].includes(t.value.toLowerCase()));
        const spelled = parts.map((t) => t.value).join('');
        current = [];
        if (spelled === '$::position') {
            keys.push({ path: undefined });
            return;
        }
        if (!/^\$(\.[A-Za-z0-9_]+)+$/.test(spelled)) {
            throw new QueryRejectedError(
                `Periscope pages node queries ordered by plain fields ($.field) only, not by '${spelled}'. ` +
                    'Add your own window (first N) or write a record query, which pages without this limit.'
            );
        }
        keys.push({ path: spelled.slice(2) });
    };
    for (let i = order + 2; i < end; i++) {
        const token = tokens[i] as KimToken;
        if (token.type === 'punct' && token.value === ',' && token.depth === 0) finish();
        else current.push(token);
    }
    finish();
    return keys;
};

export const planKimQuery = (analysis: KimQueryAnalysis): KimPlan => {
    const { text, tokens, records } = analysis;
    if (records) return { mode: 'records', text };
    if (analysis.head === 'at' || firstClause(analysis, ['first', 'last']) !== undefined) {
        return { mode: 'single', text, records: false };
    }
    const keys = parseOrderKeys(analysis);
    const pick = analysis.clauses.get('pick')?.[0];
    const reveal = analysis.clauses.get('reveal')?.[0];
    const windowAt = (tokens[pick ?? reveal ?? tokens.length]?.start ?? text.length) as number;
    const paths = keys.flatMap((k) => (k.path ? [`$.${k.path}`] : []));
    // The anchor values must be in the answer, so the order keys are always picked.
    let tail = text.slice(windowAt);
    let pickKeys = '';
    if (paths.length > 0) {
        if (pick === undefined) {
            pickKeys = ` pick ${paths.join(', ')}`;
        } else {
            const pickEnd = reveal !== undefined ? (tokens[reveal] as KimToken).start : text.length;
            tail = `${text.slice(windowAt, pickEnd).trimEnd()}, ${paths.join(', ')} ${text.slice(pickEnd)}`;
        }
    }
    return { mode: 'nodes', head: text.slice(0, windowAt).trimEnd(), tail: tail.trim(), keys, pickKeys };
};

/** The text of one record page. */
export const recordPage = (text: string, size: number, skip: number): string => `${text}\nfirst ${size} skip ${skip}`;

/** The text of one node page; `anchor` is the literal list after `after`, if any. */
export const nodePage = (plan: Extract<KimPlan, { mode: 'nodes' }>, size: number, anchor: string | undefined): string =>
    `${plan.head}\nfirst ${size}${anchor ? ` after (${anchor})` : ''}${plan.pickKeys}${plan.tail ? `\n${plan.tail}` : ''}`;

const escapePayload = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');

/**
 * Spells a node value as a query literal of its own shape. A bare string would compare
 * in the text domain (an instant anchor written as "2026-…" silently restarts at page 1),
 * so every shape except Text, Number and Checkbox uses its constructor.
 */
export const literalOf = (shape: string, value: unknown): string => {
    if (value === null) return `${shape}()`;
    switch (shape) {
        case 'Text':
            return JSON.stringify(value);
        case 'Number':
            return typeof value === 'number' ? String(value) : `Number(${String(value)})`;
        case 'Checkbox':
            return value ? 'true' : 'false';
        case 'Link':
        case 'Regex':
            return `${shape}(${escapePayload(String(value))})`;
        case 'MultiOption':
            return `MultiOption(${(value as string[]).join(', ')})`;
        case 'Json':
        case 'RichText':
            return `${shape}(${JSON.stringify(value)})`;
        case 'PreciseNumber':
        case 'Instant':
        case 'DateTime':
        case 'LocalDateTime':
        case 'LocalDate':
        case 'LocalTime':
        case 'YearMonth':
        case 'MonthDay':
        case 'Duration':
        case 'Bytes':
        case 'Reference':
        case 'SingleOption':
            return `${shape}(${String(value)})`;
        default:
            throw new PeriscopeError('source_error', `Cannot page by a ${shape} order key; add your own window`);
    }
};
