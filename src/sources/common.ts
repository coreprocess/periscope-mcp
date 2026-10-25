import type { z } from 'zod';
import { PeriscopeError, QueryRejectedError } from '../core/errors.ts';

/** Validates per-type query options, rejecting unknown keys. */
export const parseOptions = <T extends z.ZodType>(schema: T, options: Record<string, unknown>): z.infer<T> => {
    const parsed = schema.safeParse(options);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const at = issue?.path.length ? ` (options.${issue.path.join('.')})` : '';
        throw new PeriscopeError('invalid_argument', `${issue?.message ?? 'Invalid options'}${at}`);
    }
    return parsed.data;
};

/** Converts a `describe` filter (`*` and `?` wildcards, case-insensitive) into a SQL LIKE pattern. */
export const likePattern = (filter: string | undefined): string =>
    filter
        ? filter
              .replace(/[%_\\]/g, '\\$&')
              .replace(/\*/g, '%')
              .replace(/\?/g, '_')
        : '%';

/**
 * End of a `--` line comment for the SQL lexers: the first CR or LF, because SQL Server ends a line comment at a
 * lone CR. Other characters that some engine might read as a line break are rejected (fail closed).
 */
export const lineCommentEnd = (sql: string, start: number): number => {
    const match = /[\r\n\v\f\u0085\u2028\u2029]/.exec(sql.slice(start));
    if (!match) return sql.length;
    if (match[0] !== '\r' && match[0] !== '\n') {
        throw new QueryRejectedError('Unsupported line break character in a comment');
    }
    return start + match.index;
};

/** Milliseconds left until the deadline, at least 1. */
export const remaining = (deadline: number): number => Math.max(deadline - Date.now(), 1);

/** Splits `schema.table` style paths; quoted segments keep dots and case. */
export const splitPath = (path: string | undefined): string[] => {
    if (!path) return [];
    const parts: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < path.length; i++) {
        const char = path[i] as string;
        if (char === '"') {
            if (quoted && path[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if ((char === '.' || char === '/') && !quoted) {
            parts.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    parts.push(current);
    return parts.filter((p) => p.length > 0);
};
