import { QueryRejectedError } from '../../core/errors.ts';

/**
 * Strict Oracle lexer and statement filter (concept §7.1 B). On 19c this is the only
 * guard against DDL, because DDL commits implicitly and ends a READ ONLY transaction.
 * Anything the lexer does not recognise is rejected.
 */

export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'bind' | 'punct';

export interface Token {
    type: TokenType;
    value: string;
}

const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };
const WORD_START = /[A-Za-zÀ-￿]/;
const WORD_PART = /[A-Za-z0-9_$#À-￿]/;
const WHITESPACE = /[ \t\r\n\f\v]/;
const PUNCTUATION = new Set([
    '(',
    ')',
    ',',
    '.',
    '*',
    '+',
    '-',
    '/',
    '=',
    '<',
    '>',
    '!',
    '|',
    '%',
    '^',
    '~',
    '[',
    ']',
    ';',
    '@',
    ':',
    '?',
    '&',
]);

export const lex = (sql: string): Token[] => {
    const tokens: Token[] = [];
    const n = sql.length;
    let i = 0;
    while (i < n) {
        const ch = sql[i] as string;
        const next = sql[i + 1];
        if (WHITESPACE.test(ch)) {
            i++;
            continue;
        }
        if (ch === '-' && next === '-') {
            const end = sql.indexOf('\n', i);
            i = end === -1 ? n : end + 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            // Oracle comments do not nest.
            const end = sql.indexOf('*/', i + 2);
            if (end === -1) throw new QueryRejectedError('Unterminated comment');
            i = end + 2;
            continue;
        }
        const qQuote = /^[nN]?[qQ]'/.exec(sql.slice(i, i + 3));
        if (qQuote) {
            const start = i + qQuote[0].length;
            const delimiter = sql[start];
            if (!delimiter || WHITESPACE.test(delimiter)) throw new QueryRejectedError('Invalid q-quote delimiter');
            const close = `${Q_CLOSE[delimiter] ?? delimiter}'`;
            const end = sql.indexOf(close, start + 1);
            if (end === -1) throw new QueryRejectedError('Unterminated q-quoted string');
            tokens.push({ type: 'string', value: sql.slice(i, end + 2) });
            i = end + 2;
            continue;
        }
        if (ch === "'" || ((ch === 'n' || ch === 'N') && next === "'")) {
            let j = i + (ch === "'" ? 1 : 2);
            while (true) {
                if (j >= n) throw new QueryRejectedError('Unterminated string literal');
                if (sql[j] === "'") {
                    if (sql[j + 1] === "'") {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j++;
            }
            tokens.push({ type: 'string', value: sql.slice(i, j + 1) });
            i = j + 1;
            continue;
        }
        if (ch === '"') {
            const end = sql.indexOf('"', i + 1);
            if (end === -1) throw new QueryRejectedError('Unterminated quoted identifier');
            tokens.push({ type: 'quoted', value: sql.slice(i + 1, end) });
            i = end + 1;
            continue;
        }
        if (WORD_START.test(ch)) {
            let j = i + 1;
            while (j < n && WORD_PART.test(sql[j] as string)) j++;
            tokens.push({ type: 'word', value: sql.slice(i, j).toUpperCase() });
            i = j;
            continue;
        }
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next ?? ''))) {
            const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?/.exec(sql.slice(i));
            const text = match?.[0] ?? ch;
            tokens.push({ type: 'number', value: text });
            i += text.length;
            continue;
        }
        if (ch === ':') {
            const bind = /^:(?:[A-Za-z][A-Za-z0-9_$#]*|\d+|"[^"]+")/.exec(sql.slice(i));
            if (bind) {
                tokens.push({ type: 'bind', value: bind[0] });
                i += bind[0].length;
                continue;
            }
        }
        if (PUNCTUATION.has(ch)) {
            tokens.push({ type: 'punct', value: ch });
            i++;
            continue;
        }
        throw new QueryRejectedError(`Unexpected character '${ch}' at position ${i}`);
    }
    return tokens;
};

/** System packages whose functions may be called from queries. Everything else under DBMS_/UTL_ is blocked. */
const ALLOWED_SYSTEM_PACKAGES = new Set(['DBMS_LOB', 'DBMS_METADATA', 'DBMS_XPLAN']);
const SYSTEM_PACKAGE = /^(DBMS|UTL|OWA|HTP|HTF|DEBUG|OUTLN)_/;

export interface CheckedStatement {
    /** The SQL to send: the input with one trailing `;` or `/` removed. */
    sql: string;
    /** Upper-cased identifiers, used to match blocked routines and views. */
    identifiers: Set<string>;
}

export interface CheckOptions {
    allowDbLinks: boolean;
}

export const checkReadOnlyStatement = (input: string, options: CheckOptions): CheckedStatement => {
    let sql = input.trim();
    if (sql.endsWith('/') && /\n\s*\/$/.test(sql)) sql = sql.replace(/\n\s*\/$/, '').trimEnd();
    const tokens = lex(sql);
    if (tokens.at(-1)?.value === ';') {
        tokens.pop();
        sql = sql.replace(/;\s*$/, '');
    }
    if (tokens.length === 0) throw new QueryRejectedError('Empty statement');
    if (tokens.some((t) => t.type === 'punct' && t.value === ';')) {
        throw new QueryRejectedError('Only one statement is allowed (no ";" inside the statement)');
    }
    let k = 0;
    while (tokens[k]?.value === '(') k++;
    const first = tokens[k];
    if (first?.type !== 'word' || (first.value !== 'SELECT' && first.value !== 'WITH')) {
        throw new QueryRejectedError(`Only SELECT queries are allowed (statement starts with '${first?.value ?? ''}')`);
    }
    if (first.value === 'WITH' && ['FUNCTION', 'PROCEDURE'].includes(tokens[k + 1]?.value ?? '')) {
        throw new QueryRejectedError('Inline PL/SQL (WITH FUNCTION/PROCEDURE) is not allowed');
    }
    const identifiers = new Set<string>();
    for (let j = 0; j < tokens.length; j++) {
        const token = tokens[j] as Token;
        const nextToken = tokens[j + 1];
        if (token.type === 'word' && token.value === 'FOR' && nextToken?.value === 'UPDATE') {
            throw new QueryRejectedError('Row locking (FOR UPDATE) is not allowed');
        }
        if (token.type === 'word' && (token.value === 'BEGIN' || token.value === 'DECLARE')) {
            throw new QueryRejectedError('PL/SQL blocks are not allowed');
        }
        if (token.type === 'word' && token.value === 'NEXTVAL') {
            throw new QueryRejectedError('Sequence NEXTVAL changes the sequence and is not allowed');
        }
        if (token.type === 'punct' && token.value === '@' && !options.allowDbLinks) {
            throw new QueryRejectedError('Database links (@) are not allowed on this source');
        }
        if (token.type === 'word' || token.type === 'quoted') {
            const name = token.type === 'quoted' ? token.value : token.value;
            if (SYSTEM_PACKAGE.test(name.toUpperCase()) && !ALLOWED_SYSTEM_PACKAGES.has(name.toUpperCase())) {
                throw new QueryRejectedError(`System package '${name}' is not allowed in queries`);
            }
            identifiers.add(token.type === 'quoted' ? name : name.toUpperCase());
        }
    }
    return { sql, identifiers };
};
