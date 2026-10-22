import type { z } from 'zod';
import { PeriscopeError } from '../core/errors.ts';

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

/** Converts a `describe` filter into a RegExp. */
export const filterRegex = (filter: string | undefined): RegExp => {
    if (!filter) return /^/;
    const source = filter
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${source}$`, 'i');
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
