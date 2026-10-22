/**
 * Value handling for JSON output: safe serialization (bigint, binary) and the
 * truncation applied to `read_result` windows. Downloads always keep full values.
 */

/** JSON.stringify replacer: bigint as number when safe, otherwise string; binary as base64. */
export const jsonReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (value !== null && typeof value === 'object' && (value as { type?: string }).type === 'Buffer') {
        const data = (value as { data?: number[] }).data;
        if (Array.isArray(data)) return Buffer.from(data).toString('base64');
    }
    return value;
};

export const toJson = (value: unknown): string => JSON.stringify(value, jsonReplacer);

export interface TruncationOptions {
    maxValueChars: number;
}

export interface Truncator {
    render(value: unknown): unknown;
    readonly truncated: number;
}

const isNumberArray = (value: unknown[]): boolean =>
    value.length > 0 && value.every((v) => typeof v === 'number' || typeof v === 'bigint');

/** Creates a truncator that counts how many values it shortened. */
export const createTruncator = ({ maxValueChars }: TruncationOptions): Truncator => {
    let truncated = 0;
    const shorten = (text: string, label: string): string => {
        truncated++;
        return `${text.slice(0, maxValueChars)}… [${label} truncated, ${text.length} chars]`;
    };
    const render = (value: unknown): unknown => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'bigint') return jsonReplacer('', value);
        if (typeof value === 'string') return value.length > maxValueChars ? shorten(value, 'string') : value;
        if (value instanceof Uint8Array) {
            truncated++;
            return `<binary ${value.length} bytes>`;
        }
        if (value instanceof Date) return value.toISOString();
        if (Array.isArray(value)) {
            if (value.length > 32 && isNumberArray(value)) {
                truncated++;
                return `<vector dim=${value.length}>`;
            }
            const json = toJson(value);
            return json.length > maxValueChars ? shorten(json, 'array') : value.map(render);
        }
        if (typeof value === 'object') {
            const json = toJson(value);
            if (json.length > maxValueChars) return shorten(json, 'object');
            return JSON.parse(json, (_k, v) => (typeof v === 'string' && v.length > maxValueChars ? render(v) : v));
        }
        return value;
    };
    return {
        render,
        get truncated() {
            return truncated;
        },
    };
};
