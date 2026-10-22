/**
 * Glob matching for blob names: `**` matches across `/`, `*` and `?` stay within one segment.
 * A pattern without wildcards (or ending in `/`) is treated as a prefix.
 */

const escape = (char: string): string => char.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export interface CompiledGlob {
    /** Longest literal prefix, used to narrow the server-side listing. */
    prefix: string;
    matches(name: string): boolean;
}

export const compileGlob = (pattern: string): CompiledGlob => {
    const normalized = pattern.replace(/^\/+/, '');
    const firstWildcard = normalized.search(/[*?]/);
    if (firstWildcard === -1) {
        return { prefix: normalized, matches: (name) => name.startsWith(normalized) };
    }
    let regex = '^';
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i] as string;
        if (char === '*') {
            if (normalized[i + 1] === '*') {
                const slashAfter = normalized[i + 2] === '/';
                regex += slashAfter ? '(?:.*/)?' : '.*';
                i += slashAfter ? 2 : 1;
            } else {
                regex += '[^/]*';
            }
        } else if (char === '?') {
            regex += '[^/]';
        } else {
            regex += escape(char);
        }
    }
    const compiled = new RegExp(`${regex}$`, 's');
    return { prefix: normalized.slice(0, firstWildcard), matches: (name) => compiled.test(name) };
};
