import type { ColumnInfo, NormalizedType } from './types.ts';

type JsonKind = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

const MAX_DEPTH = 3;
const MAX_PATHS = 500;

const kindOf = (value: unknown): JsonKind => {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    switch (typeof value) {
        case 'string':
            return 'string';
        case 'boolean':
            return 'boolean';
        case 'bigint':
            return 'integer';
        case 'number':
            return Number.isInteger(value) ? 'integer' : 'number';
        default:
            return 'object';
    }
};

const normalize = (kinds: Set<JsonKind>): NormalizedType => {
    const nonNull = [...kinds].filter((k) => k !== 'null');
    if (nonNull.length === 0) return 'null';
    if (nonNull.length === 2 && nonNull.includes('integer') && nonNull.includes('number')) return 'number';
    if (nonNull.length > 1) return 'mixed';
    const only = nonNull[0] as JsonKind;
    return only === 'array' ? 'list' : (only as NormalizedType);
};

/**
 * Streaming schema inference for documents (Cosmos, blob listings, Redis rows).
 * Tracks top-level fields and nested object fields as dotted paths, with types and presence.
 */
export class SchemaInferrer {
    readonly #paths = new Map<string, { kinds: Set<JsonKind>; count: number }>();
    #rows = 0;
    #overflow = false;

    observe(document: unknown): void {
        this.#rows++;
        if (document === null || typeof document !== 'object' || Array.isArray(document)) {
            this.#record('value', document);
            return;
        }
        this.#walk(document as Record<string, unknown>, '', 1);
    }

    #walk(object: Record<string, unknown>, prefix: string, depth: number): void {
        for (const [key, value] of Object.entries(object)) {
            const path = prefix ? `${prefix}.${key}` : key;
            this.#record(path, value);
            if (depth < MAX_DEPTH && value !== null && typeof value === 'object' && !Array.isArray(value)) {
                this.#walk(value as Record<string, unknown>, path, depth + 1);
            }
        }
    }

    #record(path: string, value: unknown): void {
        let entry = this.#paths.get(path);
        if (!entry) {
            if (this.#paths.size >= MAX_PATHS) {
                this.#overflow = true;
                return;
            }
            entry = { kinds: new Set(), count: 0 };
            this.#paths.set(path, entry);
        }
        entry.kinds.add(kindOf(value));
        entry.count++;
    }

    get truncated(): boolean {
        return this.#overflow;
    }

    columns(): ColumnInfo[] {
        const rows = Math.max(this.#rows, 1);
        return [...this.#paths.entries()].map(([name, { kinds, count }]) => ({
            name,
            type: normalize(kinds),
            sourceType: [...kinds].sort().join('|'),
            nullable: kinds.has('null') || count < this.#rows,
            presence: Math.round((count / rows) * 10_000) / 10_000,
        }));
    }
}

/** Reads a dotted path from a document. */
export const getPath = (document: unknown, path: string): unknown => {
    if (path === 'value' && (document === null || typeof document !== 'object' || Array.isArray(document))) {
        return document;
    }
    let current: unknown = document;
    for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
};
