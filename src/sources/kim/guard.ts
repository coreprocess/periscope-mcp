import { QueryRejectedError } from '../../core/errors.ts';
import { lineCommentEnd } from '../common.ts';

/**
 * Lexer and statement check for KIM queries (node and record query language). Neither
 * language has a writing clause, so the check is about shape: one query text, starting
 * with `from`, `at` or `referrers of`, no `reveal` unless the source allows it, and URLs
 * only on the configured origin. The analysis also tells the adapter how to page.
 */

export type KimTokenType = 'word' | 'name' | 'string' | 'url' | 'number' | 'punct';

export interface KimToken {
    type: KimTokenType;
    value: string;
    /** Offset in the query text. */
    start: number;
    end: number;
    depth: number;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** Any `scheme://` (any case) is a URL, so a spelling the origin check does not expect cannot slip through as words. */
const URL_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s(),\]\[;"']+/iy;
const PUNCT = [
    '::',
    '==',
    '!=',
    '<=',
    '>=',
    '=',
    '<',
    '>',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    ',',
    '.',
    ':',
    '$',
    '*',
    '+',
    '-',
    '/',
    '@',
];

/**
 * Constructor payloads are never quoted (spec: wire formats §6). Text, Regex and Link
 * payloads are free-form up to the first unescaped `)`; temporal, numeric, option, bytes
 * and reference payloads are single lexemes up to `)` (a `MonthDay(--06-15)` is not a
 * comment). JSON and container payloads are ordinary tokens.
 */
const FREE_FORM_PAYLOADS = new Set(['Text', 'Regex', 'Link']);
const VERBATIM_PAYLOADS = new Set([
    ...FREE_FORM_PAYLOADS,
    'Number',
    'PreciseNumber',
    'Checkbox',
    'Instant',
    'DateTime',
    'LocalDateTime',
    'LocalDate',
    'LocalTime',
    'YearMonth',
    'MonthDay',
    'Duration',
    'Bytes',
    'Reference',
    'SingleOption',
    'MultiOption',
    'Version',
]);

const payloadEnd = (text: string, from: number, escapes: boolean): number => {
    for (let j = from; j < text.length; j++) {
        if (escapes && text[j] === '\\' && (text[j + 1] === ')' || text[j + 1] === '\\')) {
            j++;
            continue;
        }
        if (text[j] === ')') return j;
    }
    return -1;
};

export const lexKim = (text: string): KimToken[] => {
    const tokens: KimToken[] = [];
    let depth = 0;
    let i = 0;
    const match = (pattern: RegExp): string | undefined => {
        pattern.lastIndex = i;
        return pattern.exec(text)?.[0];
    };
    while (i < text.length) {
        const ch = text[i] as string;
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        const url = match(URL_TOKEN);
        if (url) {
            tokens.push({ type: 'url', value: url, start: i, end: i + url.length, depth });
            i += url.length;
            continue;
        }
        if (ch === '-' && text[i + 1] === '-') {
            i = lineCommentEnd(text, i);
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            if (j >= text.length) throw new QueryRejectedError('Unterminated string literal');
            tokens.push({ type: 'string', value: text.slice(i, j + 1), start: i, end: j + 1, depth });
            i = j + 1;
            continue;
        }
        if (ch === '`') {
            // a field name spelled with backticks, e.g. a reserved word: `at`
            const end = text.indexOf('`', i + 1);
            if (end === -1) throw new QueryRejectedError('Unterminated `name`');
            tokens.push({ type: 'name', value: text.slice(i, end + 1), start: i, end: end + 1, depth });
            i = end + 1;
            continue;
        }
        const word = match(WORD);
        if (word) {
            tokens.push({ type: 'word', value: word, start: i, end: i + word.length, depth });
            i += word.length;
            if (text[i] === '(' && VERBATIM_PAYLOADS.has(word)) {
                const end = payloadEnd(text, i + 1, FREE_FORM_PAYLOADS.has(word));
                if (end === -1) throw new QueryRejectedError(`Unterminated ${word}(…) literal`);
                tokens.push({ type: 'punct', value: '(', start: i, end: i + 1, depth });
                tokens.push({ type: 'string', value: text.slice(i + 1, end), start: i + 1, end, depth: depth + 1 });
                tokens.push({ type: 'punct', value: ')', start: end, end: end + 1, depth });
                i = end + 1;
            }
            continue;
        }
        const number = /[0-9-]/.test(ch) ? match(NUMBER) : undefined;
        if (number && number !== '-') {
            tokens.push({ type: 'number', value: number, start: i, end: i + number.length, depth });
            i += number.length;
            continue;
        }
        const punct = PUNCT.find((p) => text.startsWith(p, i));
        if (!punct) throw new QueryRejectedError(`Unexpected character '${ch}' at position ${i}`);
        if (punct === '(' || punct === '[' || punct === '{') depth++;
        if (punct === ')' || punct === ']' || punct === '}') {
            depth--;
            if (depth < 0) throw new QueryRejectedError('Unbalanced brackets');
        }
        tokens.push({ type: 'punct', value: punct, start: i, end: i + punct.length, depth });
        i += punct.length;
    }
    if (depth !== 0) throw new QueryRejectedError('Unbalanced brackets');
    return tokens;
};

export type KimHead = 'from' | 'at' | 'referrers';

export interface KimQueryAnalysis {
    text: string;
    tokens: KimToken[];
    head: KimHead;
    /** Record query: it projects with select, summarize, distinct or join. */
    records: boolean;
    /** Index of the first top-level clause token of each kind (lower-case keyword). */
    clauses: Map<string, number[]>;
}

const RECORD_CLAUSES = new Set(['select', 'summarize', 'distinct', 'join']);
const CLAUSE_WORDS = new Set([
    'from',
    'at',
    'referrers',
    'where',
    'order',
    'first',
    'last',
    'after',
    'before',
    'skip',
    'pick',
    'reveal',
    'select',
    'summarize',
    'distinct',
    'join',
]);

/**
 * A URL or reference in a query must address this source's stage on its origin, spelled exactly: KIM resolves the
 * URL text itself, so no case variants, dot segments or encoded dots.
 */
const checkStageUrl = (raw: string, options: { origin: string; stage: string }): void => {
    const base = `${options.origin}/${options.stage}`;
    const rest = raw.startsWith(`${base}/`) ? raw.slice(base.length) : raw === base ? '' : undefined;
    if (rest === undefined || /\/\.\.?(?:\/|$)|%2e|\\/i.test(rest)) {
        throw new QueryRejectedError(`URL '${raw}' is not on this source's KIM stage ${base}`);
    }
};

export const analyzeKimQuery = (
    input: string,
    options: { origin: string; stage: string; allowReveal: boolean }
): KimQueryAnalysis => {
    const text = input.trim();
    const tokens = lexKim(text);
    const first = tokens[0];
    if (!first) throw new QueryRejectedError('Empty query');
    const keyword = first.type === 'word' ? first.value.toLowerCase() : '';
    if (keyword !== 'from' && keyword !== 'at' && keyword !== 'referrers') {
        throw new QueryRejectedError(`A KIM query starts with 'from', 'at' or 'referrers of' (found '${first.value}')`);
    }
    if (keyword === 'referrers' && tokens[1]?.value.toLowerCase() !== 'of') {
        throw new QueryRejectedError("Expected 'referrers of'");
    }
    const clauses = new Map<string, number[]>();
    tokens.forEach((token, index) => {
        if (token.type !== 'word' || token.depth !== 0) return;
        const word = token.value.toLowerCase();
        if (!CLAUSE_WORDS.has(word)) return;
        clauses.set(word, [...(clauses.get(word) ?? []), index]);
    });
    tokens.forEach((token, index) => {
        if (token.type === 'string' && tokens[index - 2]?.value === 'Reference' && token.value.includes(':')) {
            checkStageUrl(token.value.trim(), options);
        }
        if (token.type === 'word' && token.value.toLowerCase() === 'reveal' && !options.allowReveal) {
            throw new QueryRejectedError(
                "'reveal' discloses masked values and is audited by KIM; it is not allowed on this source (ALLOW_REVEAL)"
            );
        }
        if (token.type === 'url') checkStageUrl(token.value, options);
    });
    return {
        text,
        tokens,
        head: keyword,
        records: [...clauses.keys()].some((word) => RECORD_CLAUSES.has(word)),
        clauses,
    };
};
