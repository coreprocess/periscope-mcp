/**
 * Glob matching for blob names: `**` matches across `/`, `*` and `?` stay within one segment.
 * A pattern without wildcards (or ending in `/`) is treated as a prefix.
 *
 * Patterns come from callers, so matching never uses a backtracking regex: the matcher tracks the set of
 * pattern positions reachable after each character, which takes O(name × pattern) time for any pattern.
 */

type WildcardToken =
    | { kind: 'char'; value: string }
    | { kind: 'one'; crossesSlash: boolean }
    | { kind: 'star'; crossesSlash: boolean }
    /** Consumes nothing: continues both at the next position and at `skipTo` (an optional group). */
    | { kind: 'split'; skipTo: number };

export type Matcher = (name: string) => boolean;

const matcherOf = (tokens: WildcardToken[], ignoreCase: boolean): Matcher => {
    const end = tokens.length;
    const close = (states: Uint8Array): void => {
        for (let i = 0; i < end; i++) {
            if (!states[i]) continue;
            const token = tokens[i] as WildcardToken;
            if (token.kind === 'star' || token.kind === 'split') states[i + 1] = 1;
            if (token.kind === 'split') states[token.skipTo] = 1;
        }
    };
    return (input) => {
        const name = ignoreCase ? input.toLowerCase() : input;
        let states = new Uint8Array(end + 1);
        states[0] = 1;
        close(states);
        for (const char of name) {
            const next = new Uint8Array(end + 1);
            let alive = false;
            for (let i = 0; i < end; i++) {
                if (!states[i]) continue;
                const token = tokens[i] as WildcardToken;
                if (token.kind === 'split') continue;
                const fits = token.kind === 'char' ? char === token.value : token.crossesSlash || char !== '/';
                if (!fits) continue;
                next[token.kind === 'star' ? i : i + 1] = 1;
                alive = true;
            }
            if (!alive) return false;
            close(next);
            states = next;
        }
        return states[end] === 1;
    };
};

export interface CompiledGlob {
    /** Longest literal prefix, used to narrow the server-side listing. */
    prefix: string;
    matches: Matcher;
}

export const compileGlob = (pattern: string): CompiledGlob => {
    const normalized = pattern.replace(/^\/+/, '');
    const firstWildcard = normalized.search(/[*?]/);
    if (firstWildcard === -1) {
        return { prefix: normalized, matches: (name) => name.startsWith(normalized) };
    }
    const tokens: WildcardToken[] = [];
    const chars = [...normalized];
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i] as string;
        if (char === '*' && chars[i + 1] === '*') {
            // `**/` matches zero or more whole segments, a bare `**` anything
            const slashAfter = chars[i + 2] === '/';
            if (slashAfter) tokens.push({ kind: 'split', skipTo: tokens.length + 3 });
            tokens.push({ kind: 'star', crossesSlash: true });
            if (slashAfter) tokens.push({ kind: 'char', value: '/' });
            i += slashAfter ? 2 : 1;
        } else if (char === '*') {
            tokens.push({ kind: 'star', crossesSlash: false });
        } else if (char === '?') {
            tokens.push({ kind: 'one', crossesSlash: false });
        } else {
            tokens.push({ kind: 'char', value: char });
        }
    }
    return { prefix: normalized.slice(0, firstWildcard), matches: matcherOf(tokens, false) };
};

/** A `describe` filter: `*` and `?` match any characters, case-insensitive; no filter matches everything. */
export const compileFilter = (filter: string | undefined): Matcher => {
    if (!filter) return () => true;
    const tokens = [...filter.toLowerCase()].map((char): WildcardToken => {
        if (char === '*') return { kind: 'star', crossesSlash: true };
        if (char === '?') return { kind: 'one', crossesSlash: true };
        return { kind: 'char', value: char };
    });
    return matcherOf(tokens, true);
};
