import pg from 'pg';
import { PeriscopeError } from '../../core/errors.ts';
import {
    dateColumn,
    decimalColumn,
    listColumn,
    MAX_DECIMAL_PRECISION,
    type ParquetColumn,
    type ScalarKind,
    scalarColumn,
    timestampColumn,
} from '../../results/parquet/columns.ts';
import { toUnscaled } from '../../results/parquet/decimal.ts';

/**
 * Postgres type handling. The driver's default parsers lose data silently (timestamps to
 * milliseconds and local time, big JSON numbers, numeric arrays to floats), so every
 * type that matters is parsed exactly here. Sessions run with TimeZone=UTC and ISO styles.
 */

export const SESSION_SETTINGS =
    "SET TimeZone='UTC'; SET DateStyle='ISO, YMD'; SET IntervalStyle='iso_8601'; SET extra_float_digits=3";

const textArray = (pg.types.getTypeParser as (oid: number) => unknown)(1009) as (value: string) => (string | null)[];

const rejectSpecial = (value: string): void => {
    if (value === 'infinity' || value === '-infinity' || value.endsWith(' BC')) {
        throw new PeriscopeError('source_error', `Unsupported value '${value}'; cast the column to text in the query`);
    }
};

/** '2020-01-01 00:00:00.123456+00' (or without offset) to microseconds since epoch. */
export const timestampToMicros = (value: string): bigint => {
    rejectSpecial(value);
    if (value[4] !== '-') throw new PeriscopeError('source_error', `Unsupported timestamp '${value}'`);
    const millis = Date.UTC(
        Number(value.slice(0, 4)),
        Number(value.slice(5, 7)) - 1,
        Number(value.slice(8, 10)),
        Number(value.slice(11, 13)),
        Number(value.slice(14, 16)),
        Number(value.slice(17, 19))
    );
    let fraction = 0;
    if (value[19] === '.') {
        let end = 20;
        while (end < value.length && value[end] !== undefined && /\d/.test(value[end] as string)) end++;
        fraction = Number(value.slice(20, end).padEnd(6, '0').slice(0, 6));
    }
    return BigInt(millis) * 1000n + BigInt(fraction);
};

export const dateToDays = (value: string): number => {
    rejectSpecial(value);
    return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))) / 86_400_000;
};

const identity = (value: string): string => value;

/** Exact text parsers per type OID. Anything not listed keeps the driver default. */
const PARSERS: Record<number, (value: string) => unknown> = {
    20: (v) => BigInt(v),
    1016: (v) => textArray(v).map((x) => (x === null ? null : BigInt(x))),
    1700: identity,
    1231: (v) => textArray(v),
    1184: timestampToMicros,
    1114: timestampToMicros,
    1082: dateToDays,
    114: identity,
    3802: identity,
    1186: identity,
    1083: identity,
    1266: identity,
    199: identity,
    3807: identity,
    // Arrays of time types: the default parsers convert to local-time Dates; keep exact text.
    1115: (v) => textArray(v),
    1185: (v) => textArray(v),
    1182: (v) => textArray(v),
    1183: (v) => textArray(v),
    1270: (v) => textArray(v),
    1187: (v) => textArray(v),
};

/** Type OIDs of extension types, resolved per connection (e.g. pgvector's `vector`). */
export interface ExtensionTypes {
    vector: Set<number>;
}

export const typeParsers = (extension: ExtensionTypes) => ({
    getTypeParser: (oid: number, format?: string): ((value: string) => unknown) => {
        if (format !== 'binary') {
            if (extension.vector.has(oid)) return (v: string) => (JSON.parse(v) as number[]).map(Number);
            const parser = PARSERS[oid];
            if (parser) return parser;
        }
        return pg.types.getTypeParser(oid, format as 'text' | 'binary') as (value: string) => unknown;
    },
});

export interface FieldDescription {
    name: string;
    dataTypeID: number;
    dataTypeModifier: number;
}

export interface MappedColumn {
    column: ParquetColumn;
    convert: ((value: unknown) => unknown) | undefined;
}

const ARRAY_ELEMENTS: Record<number, ScalarKind> = {
    1005: 'int32',
    1007: 'int32',
    1016: 'int64',
    1021: 'double',
    1022: 'double',
    1000: 'boolean',
    1009: 'string',
    1015: 'string',
    1014: 'string',
    1231: 'string',
    2951: 'string',
    1115: 'string',
    1185: 'string',
    1182: 'string',
    1183: 'string',
    1270: 'string',
    1187: 'string',
};

const SCALARS: Record<number, ScalarKind> = {
    16: 'boolean',
    17: 'binary',
    20: 'int64',
    21: 'int32',
    23: 'int32',
    26: 'int64',
    700: 'double',
    701: 'double',
    114: 'json',
    3802: 'json',
};

const toBigIntList = (value: unknown): unknown =>
    Array.isArray(value) ? value.map((x) => (x === null || x === undefined ? null : BigInt(x as number))) : value;

const decimalConverter =
    (name: string, precision: number, scale: number) =>
    (value: unknown): unknown => {
        if (value === null || value === undefined) return null;
        const unscaled = toUnscaled(String(value), precision, scale);
        if (unscaled === undefined) {
            throw new PeriscopeError(
                'source_error',
                `Value '${String(value)}' in column '${name}' does not fit NUMERIC(${precision},${scale}); cast it to text`
            );
        }
        return unscaled;
    };

/** Maps a result field to a Parquet column plus an optional value converter. */
export const mapField = (field: FieldDescription, typeName: string, extension: ExtensionTypes): MappedColumn => {
    const { name, dataTypeID: oid, dataTypeModifier: modifier } = field;
    const extra = { sourceType: typeName };
    const scalar = SCALARS[oid];
    if (scalar) {
        const convert =
            scalar === 'int64' && oid === 26 ? (v: unknown) => (v === null ? null : BigInt(v as number)) : undefined;
        return { column: scalarColumn(name, scalar, extra), convert };
    }
    switch (oid) {
        case 1700: {
            if (modifier >= 4) {
                const precision = ((modifier - 4) >> 16) & 0xffff;
                const scale = (modifier - 4) & 0xffff;
                if (precision <= MAX_DECIMAL_PRECISION) {
                    return {
                        column: decimalColumn(name, precision, scale, extra),
                        convert: decimalConverter(name, precision, scale),
                    };
                }
            }
            return {
                column: scalarColumn(name, 'string', {
                    ...extra,
                    note: 'unconstrained numeric has no fixed scale; stored as exact decimal text',
                }),
                convert: undefined,
            };
        }
        case 1082:
            return { column: dateColumn(name, extra), convert: undefined };
        case 1184:
            return { column: timestampColumn(name, true, extra), convert: undefined };
        case 1114:
            return { column: timestampColumn(name, false, extra), convert: undefined };
    }
    if (extension.vector.has(oid)) return { column: listColumn(name, 'double', extra), convert: undefined };
    const element = ARRAY_ELEMENTS[oid];
    if (element) {
        return {
            column: listColumn(name, element, extra),
            convert: element === 'int64' ? toBigIntList : undefined,
        };
    }
    return {
        column: scalarColumn(name, 'string', extra),
        convert: (v: unknown) => {
            if (v === null || v === undefined) return null;
            if (typeof v === 'string') return v;
            if (v instanceof Date) return v.toISOString();
            if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
            return String(v);
        },
    };
};
