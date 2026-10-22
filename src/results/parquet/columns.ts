import type { SchemaElement } from 'hyparquet';
import type { ColumnInfo, NormalizedType } from '../types.ts';

/**
 * Column definitions for Parquet results. Source adapters describe each result
 * column with a `ParquetColumn` and deliver values in the form its `kind` expects:
 *
 * | kind      | value                                   |
 * |-----------|-----------------------------------------|
 * | int32     | number                                  |
 * | int64     | bigint                                  |
 * | double    | number                                  |
 * | boolean   | boolean                                 |
 * | string    | string                                  |
 * | binary    | Uint8Array                              |
 * | json      | string (raw JSON text)                  |
 * | decimal   | bigint (unscaled value)                 |
 * | date      | number (days since epoch)               |
 * | timestamp | bigint (microseconds since epoch)       |
 * | list      | array of element values (or null)       |
 */
export type ScalarKind = 'int32' | 'int64' | 'double' | 'boolean' | 'string' | 'binary' | 'json';
export type ColumnKind = ScalarKind | 'decimal' | 'date' | 'timestamp' | 'list';

export interface ParquetColumn {
    name: string;
    kind: ColumnKind;
    /** Plain, structured-cloneable schema elements (one, or three for lists). */
    elements: SchemaElement[];
    precision?: number;
    scale?: number;
    utc?: boolean;
    elementKind?: ScalarKind;
    info: ColumnInfo;
}

const optional = (name: string): SchemaElement => ({ name, repetition_type: 'OPTIONAL' }) as SchemaElement;

const scalarElement = (name: string, kind: ScalarKind): SchemaElement => {
    const base = optional(name);
    switch (kind) {
        case 'int32':
            return { ...base, type: 'INT32' };
        case 'int64':
            return { ...base, type: 'INT64' };
        case 'double':
            return { ...base, type: 'DOUBLE' };
        case 'boolean':
            return { ...base, type: 'BOOLEAN' };
        case 'string':
            return { ...base, type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' } };
        // JSON is written as plain bytes and annotated in the footer at finish (raw text pass-through).
        case 'binary':
        case 'json':
            return { ...base, type: 'BYTE_ARRAY' };
    }
};

const PARQUET_LABEL: Record<ScalarKind, string> = {
    int32: 'INT32',
    int64: 'INT64',
    double: 'DOUBLE',
    boolean: 'BOOLEAN',
    string: 'STRING',
    binary: 'BINARY',
    json: 'STRING (JSON)',
};

const NORMALIZED: Record<ScalarKind, NormalizedType> = {
    int32: 'integer',
    int64: 'integer',
    double: 'number',
    boolean: 'boolean',
    string: 'string',
    binary: 'binary',
    json: 'json',
};

type Extra = { sourceType: string; note?: string | undefined };

const info = (name: string, type: NormalizedType, parquetType: string, extra: Extra): ColumnInfo => ({
    name,
    type,
    sourceType: extra.sourceType,
    parquetType,
    nullable: true,
    ...(extra.note ? { note: extra.note } : {}),
});

export const scalarColumn = (name: string, kind: ScalarKind, extra: Extra): ParquetColumn => ({
    name,
    kind,
    elements: [scalarElement(name, kind)],
    info: info(name, NORMALIZED[kind], PARQUET_LABEL[kind], extra),
});

/** Largest precision written as DECIMAL; wider values fall back to strings. */
export const MAX_DECIMAL_PRECISION = 38;

export const decimalColumn = (name: string, precision: number, scale: number, extra: Extra): ParquetColumn => {
    const physical =
        precision <= 9
            ? { type: 'INT32' }
            : precision <= 18
              ? { type: 'INT64' }
              : { type: 'FIXED_LEN_BYTE_ARRAY', type_length: 16 };
    return {
        name,
        kind: 'decimal',
        precision,
        scale,
        elements: [
            {
                ...optional(name),
                ...physical,
                converted_type: 'DECIMAL',
                precision,
                scale,
                logical_type: { type: 'DECIMAL', precision, scale },
            } as SchemaElement,
        ],
        info: info(name, 'decimal', `DECIMAL(${precision},${scale})`, extra),
    };
};

export const dateColumn = (name: string, extra: Extra): ParquetColumn => ({
    name,
    kind: 'date',
    elements: [
        { ...optional(name), type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' } } as SchemaElement,
    ],
    info: info(name, 'date', 'DATE', extra),
});

export const timestampColumn = (name: string, utc: boolean, extra: Extra): ParquetColumn => ({
    name,
    kind: 'timestamp',
    utc,
    elements: [
        {
            ...optional(name),
            type: 'INT64',
            logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: utc, unit: 'MICROS' },
        } as SchemaElement,
    ],
    info: info(name, 'datetime', `TIMESTAMP(MICROS, ${utc ? 'UTC' : 'local'})`, extra),
});

export const listColumn = (name: string, elementKind: ScalarKind, extra: Extra): ParquetColumn => ({
    name,
    kind: 'list',
    elementKind,
    elements: [
        { ...optional(name), converted_type: 'LIST', logical_type: { type: 'LIST' }, num_children: 1 } as SchemaElement,
        { name: 'list', repetition_type: 'REPEATED', num_children: 1 } as SchemaElement,
        scalarElement('element', elementKind),
    ],
    info: info(name, 'list', `LIST<${PARQUET_LABEL[elementKind]}>`, extra),
});

/** Full file schema: root element plus all column elements. */
export const fileSchema = (columns: ParquetColumn[]): SchemaElement[] => [
    { name: 'root', num_children: columns.length } as SchemaElement,
    ...columns.flatMap((c) => c.elements),
];
