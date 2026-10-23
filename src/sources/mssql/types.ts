import { PeriscopeError } from '../../core/errors.ts';
import {
    dateColumn,
    decimalColumn,
    MAX_DECIMAL_PRECISION,
    type ParquetColumn,
    type ScalarKind,
    scalarColumn,
    timestampColumn,
} from '../../results/parquet/columns.ts';
import { toUnscaled } from '../../results/parquet/decimal.ts';

/**
 * SQL Server column mapping. Decimal and money values arrive as exact strings (the
 * patched driver, see patches/tedious@*.patch); datetime2, datetimeoffset and time carry
 * their sub-millisecond part in `nanosecondsDelta`, so microseconds stay exact.
 */

export interface MssqlColumnMetadata {
    name: string;
    type?: { declaration?: string } | ((...args: never[]) => unknown);
    precision?: number;
    scale?: number;
}

export interface MappedColumn {
    column: ParquetColumn;
    convert: (value: unknown) => unknown;
}

type NanoDate = Date & { nanosecondsDelta?: number };

/** Sub-millisecond part in units of 100 ns (0–9999). */
const hundredNanos = (date: NanoDate): number => Math.round((date.nanosecondsDelta ?? 0) * 1e7);

export const toMicros = (value: unknown): bigint | null => {
    if (value === null || value === undefined) return null;
    const date = value as NanoDate;
    return BigInt(date.getTime()) * 1000n + BigInt(Math.floor(hundredNanos(date) / 10));
};

const toDays = (value: unknown): number | null =>
    value === null || value === undefined ? null : Math.floor((value as Date).getTime() / 86_400_000);

const toTime = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const date = value as NanoDate;
    const ticks =
        BigInt(((date.getTime() % 86_400_000) + 86_400_000) % 86_400_000) * 10_000n + BigInt(hundredNanos(date));
    const seconds = ticks / 10_000_000n;
    const pad = (n: bigint, width = 2): string => n.toString().padStart(width, '0');
    return `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}.${pad(ticks % 10_000_000n, 7)}`;
};

const toText = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const declarationOf = (metadata: MssqlColumnMetadata): string => {
    const type = metadata.type as { declaration?: string } | undefined;
    return (type?.declaration ?? 'unknown').toLowerCase();
};

const decimal = (name: string, precision: number, scale: number, sourceType: string): MappedColumn => ({
    column: decimalColumn(name, precision, scale, { sourceType }),
    convert: (value) => {
        if (value === null || value === undefined) return null;
        const unscaled = toUnscaled(String(value), precision, scale);
        if (unscaled === undefined) {
            throw new PeriscopeError(
                'source_error',
                `Value '${String(value)}' in '${name}' does not fit ${sourceType}`
            );
        }
        return unscaled;
    },
});

const scalar = (
    name: string,
    kind: ScalarKind,
    sourceType: string,
    convert: (v: unknown) => unknown
): MappedColumn => ({
    column: scalarColumn(name, kind, { sourceType }),
    convert,
});

export const mapMssqlColumn = (metadata: MssqlColumnMetadata, index: number): MappedColumn => {
    const name = metadata.name || `column${index + 1}`;
    const declaration = declarationOf(metadata);
    const precision = metadata.precision ?? 0;
    const scale = metadata.scale ?? 0;
    const identity = (v: unknown): unknown => (v === undefined ? null : v);
    switch (declaration) {
        case 'bit':
            return scalar(name, 'boolean', declaration, (v) => (v === null || v === undefined ? null : Boolean(v)));
        case 'tinyint':
        case 'smallint':
        case 'int':
            return scalar(name, 'int32', declaration, identity);
        case 'bigint':
            return scalar(name, 'int64', declaration, (v) =>
                v === null || v === undefined ? null : BigInt(v as string | number)
            );
        case 'decimal':
        case 'numeric':
            if (precision > 0 && precision <= MAX_DECIMAL_PRECISION) {
                return decimal(name, precision, scale, `${declaration}(${precision},${scale})`);
            }
            return scalar(name, 'string', declaration, toText);
        case 'money':
            return decimal(name, 19, 4, 'money');
        case 'smallmoney':
            return decimal(name, 10, 4, 'smallmoney');
        case 'float':
        case 'real':
            return scalar(name, 'double', declaration, (v) => (v === null || v === undefined ? null : Number(v)));
        case 'date':
            return { column: dateColumn(name, { sourceType: declaration }), convert: toDays };
        case 'datetime':
        case 'smalldatetime':
        case 'datetime2':
            return { column: timestampColumn(name, false, { sourceType: declaration }), convert: toMicros };
        case 'datetimeoffset':
            return { column: timestampColumn(name, true, { sourceType: declaration }), convert: toMicros };
        case 'time':
            return scalar(name, 'string', declaration, toTime);
        case 'binary':
        case 'varbinary':
        case 'image':
        case 'timestamp':
        case 'rowversion':
            return scalar(name, 'binary', declaration, (v) =>
                v === null || v === undefined ? null : new Uint8Array(v as Buffer)
            );
        case 'json':
            return scalar(name, 'json', declaration, toText);
        default:
            return scalar(name, 'string', declaration, toText);
    }
};
