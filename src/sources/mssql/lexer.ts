import { QueryRejectedError } from '../../core/errors.ts';
import { lineCommentEnd } from '../common.ts';

/**
 * Strict T-SQL lexer and statement filter. T-SQL runs several statements in one batch
 * even without semicolons (`SELECT 1 DELETE FROM t`), so besides the first keyword the
 * filter rejects every statement keyword anywhere and allows a second top-level SELECT
 * only after a set operator. Anything the lexer does not recognise is rejected.
 */

export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'variable' | 'punct';

export interface Token {
    type: TokenType;
    value: string;
    depth: number;
}

const WHITESPACE = /[ \t\r\n\f\v]/;
const WORD_START = /[A-Za-z_#\p{L}]/u;
const WORD_PART = /[A-Za-z0-9_#$@\p{L}\p{M}\p{Nd}]/u;
const PUNCTUATION = new Set([
    '(',
    ')',
    ',',
    '.',
    '*',
    '+',
    '-',
    '/',
    '%',
    '=',
    '<',
    '>',
    '!',
    '&',
    '|',
    '^',
    '~',
    ';',
    ':',
]);

export const lex = (sql: string): Token[] => {
    const tokens: Token[] = [];
    const n = sql.length;
    let depth = 0;
    let i = 0;
    while (i < n) {
        const ch = sql[i] as string;
        const next = sql[i + 1];
        if (WHITESPACE.test(ch)) {
            i++;
            continue;
        }
        if (ch === '-' && next === '-') {
            i = lineCommentEnd(sql, i);
            continue;
        }
        if (ch === '/' && next === '*') {
            // T-SQL block comments nest.
            let level = 1;
            i += 2;
            while (i < n && level > 0) {
                if (sql[i] === '/' && sql[i + 1] === '*') {
                    level++;
                    i += 2;
                } else if (sql[i] === '*' && sql[i + 1] === '/') {
                    level--;
                    i += 2;
                } else {
                    i++;
                }
            }
            if (level > 0) throw new QueryRejectedError('Unterminated comment');
            continue;
        }
        if (ch === "'" || ((ch === 'N' || ch === 'n') && next === "'")) {
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
            tokens.push({ type: 'string', value: sql.slice(i, j + 1), depth });
            i = j + 1;
            continue;
        }
        if (ch === '[') {
            let j = i + 1;
            let name = '';
            while (true) {
                if (j >= n) throw new QueryRejectedError('Unterminated bracketed identifier');
                if (sql[j] === ']') {
                    if (sql[j + 1] === ']') {
                        name += ']';
                        j += 2;
                        continue;
                    }
                    break;
                }
                name += sql[j];
                j++;
            }
            tokens.push({ type: 'quoted', value: name, depth });
            i = j + 1;
            continue;
        }
        if (ch === '"') {
            const end = sql.indexOf('"', i + 1);
            if (end === -1) throw new QueryRejectedError('Unterminated quoted identifier');
            tokens.push({ type: 'quoted', value: sql.slice(i + 1, end), depth });
            i = end + 1;
            continue;
        }
        if (ch === '@') {
            const match = /^@@?[A-Za-z_#$@0-9À-￿]+/.exec(sql.slice(i));
            if (!match) throw new QueryRejectedError(`Unexpected '@' at position ${i}`);
            tokens.push({ type: 'variable', value: match[0], depth });
            i += match[0].length;
            continue;
        }
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next ?? ''))) {
            const match = /^(?:0x[0-9A-Fa-f]*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(i));
            const text = match?.[0] ?? ch;
            tokens.push({ type: 'number', value: text, depth });
            i += text.length;
            continue;
        }
        if (WORD_START.test(ch)) {
            let j = i + 1;
            while (j < n && WORD_PART.test(sql[j] as string)) j++;
            tokens.push({ type: 'word', value: sql.slice(i, j).toUpperCase(), depth });
            i = j;
            continue;
        }
        if (PUNCTUATION.has(ch)) {
            if (ch === '(') {
                tokens.push({ type: 'punct', value: ch, depth });
                depth++;
            } else if (ch === ')') {
                depth--;
                if (depth < 0) throw new QueryRejectedError('Unbalanced parentheses');
                tokens.push({ type: 'punct', value: ch, depth });
            } else {
                tokens.push({ type: 'punct', value: ch, depth });
            }
            i++;
            continue;
        }
        throw new QueryRejectedError(`Unexpected character '${ch}' at position ${i}`);
    }
    if (depth !== 0) throw new QueryRejectedError('Unbalanced parentheses');
    return tokens;
};

/** Statement keywords and constructs that never belong in a reading query (all reserved in T-SQL). */
const DENIED_WORDS = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'EXEC',
    'EXECUTE',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'DENY',
    'BACKUP',
    'RESTORE',
    'DBCC',
    'KILL',
    'SHUTDOWN',
    'RECONFIGURE',
    'BULK',
    'WAITFOR',
    'SET',
    'USE',
    'DECLARE',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SAVE',
    'TRAN',
    'TRANSACTION',
    'PRINT',
    'RAISERROR',
    'THROW',
    'CHECKPOINT',
    'READTEXT',
    'WRITETEXT',
    'UPDATETEXT',
    'SETUSER',
    'REVERT',
    'GOTO',
    'RETURN',
    'WHILE',
    'IF',
    'BREAK',
    'CONTINUE',
    'OPEN',
    'FETCH',
    'CLOSE',
    'DEALLOCATE',
    'RECEIVE',
    'SEND',
    'MOVE',
    'GO',
    'INTO',
    'OPENQUERY',
    'OPENROWSET',
    'OPENDATASOURCE',
    // locking hints that hold or escalate locks for the whole export
    'UPDLOCK',
    'XLOCK',
    'TABLOCK',
    'TABLOCKX',
    'HOLDLOCK',
    'PAGLOCK',
    'SERIALIZABLE',
    'REPEATABLEREAD',
]);

const SET_OPERATORS = new Set(['UNION', 'EXCEPT', 'INTERSECT', 'ALL']);

export interface CheckedStatement {
    /** The SQL to send: the input with one trailing `;` removed. */
    sql: string;
    /** Upper-cased names (all parts of qualified names), for matching blocked routines and views. */
    identifiers: Set<string>;
}

export const checkReadOnlyStatement = (input: string, options: { allowLinkedServers: boolean }): CheckedStatement => {
    let sql = input.trim();
    const tokens = lex(sql);
    if (tokens.at(-1)?.value === ';' && tokens.at(-1)?.type === 'punct') {
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

    const identifiers = new Set<string>();
    let topLevelSelects = 0;
    for (let j = 0; j < tokens.length; j++) {
        const token = tokens[j] as Token;
        if (token.type === 'word') {
            if (DENIED_WORDS.has(token.value)) {
                throw new QueryRejectedError(`'${token.value}' is not allowed in a read-only query`);
            }
            if (token.value === 'NEXT' && tokens[j + 1]?.value === 'VALUE' && tokens[j + 2]?.value === 'FOR') {
                throw new QueryRejectedError('Sequence NEXT VALUE FOR changes the sequence and is not allowed');
            }
            if (token.value === 'SELECT' && token.depth === 0) {
                topLevelSelects++;
                const previous = tokens[j - 1];
                if (topLevelSelects > 1 && !(previous?.type === 'word' && SET_OPERATORS.has(previous.value))) {
                    throw new QueryRejectedError('Only one statement is allowed (found a second SELECT)');
                }
            }
        }
        if (token.type === 'word' || token.type === 'quoted') identifiers.add(token.value.toUpperCase());
    }

    // Four-part names (server.database.schema.object) reach linked servers.
    if (!options.allowLinkedServers) {
        let parts = 0;
        let expectName = true;
        for (const token of tokens) {
            const isName = token.type === 'word' || token.type === 'quoted';
            if (token.type === 'punct' && token.value === '.') {
                if (expectName) parts++; // empty part, as in db..table
                expectName = true;
                continue;
            }
            if (isName && expectName) {
                parts++;
                expectName = false;
                if (parts >= 4)
                    throw new QueryRejectedError(
                        'Linked-server names (four-part names) are not allowed on this source'
                    );
                continue;
            }
            parts = isName ? 1 : 0;
            expectName = !isName;
        }
    }
    return { sql, identifiers };
};
