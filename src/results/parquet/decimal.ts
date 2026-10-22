/**
 * Exact decimal handling. Decimals travel as unscaled bigints (or numbers for
 * precision <= 9) and are formatted back to exact strings for output.
 */

/** Two's-complement big-endian bytes to bigint. */
export const bytesToBigInt = (bytes: Uint8Array): bigint => {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (bytes.length > 0 && (bytes[0] as number) & 0x80) value -= 1n << BigInt(bytes.length * 8);
    return value;
};

/** Unscaled integer plus scale to an exact decimal string. */
export const formatDecimal = (unscaled: bigint, scale: number): string => {
    const negative = unscaled < 0n;
    let digits = (negative ? -unscaled : unscaled).toString();
    if (scale > 0) {
        digits = digits.padStart(scale + 1, '0');
        digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    }
    return negative ? `-${digits}` : digits;
};

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parses a decimal string into an unscaled bigint at the given scale.
 * Returns undefined if the value would lose digits or exceed the precision.
 */
export const toUnscaled = (text: string, precision: number, scale: number): bigint | undefined => {
    const match = DECIMAL.exec(text.trim());
    if (!match) return undefined;
    const [, sign, intPart = '', fracPart = '', exponent] = match;
    let digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
    let fractionDigits = fracPart.length - Number(exponent ?? 0);
    if (digits === '') digits = '0';
    if (fractionDigits < 0) {
        digits += '0'.repeat(-fractionDigits);
        fractionDigits = 0;
    }
    if (fractionDigits > scale) {
        const dropped = digits.slice(digits.length - (fractionDigits - scale));
        if (/[1-9]/.test(dropped)) return undefined;
        digits = digits.slice(0, digits.length - (fractionDigits - scale)) || '0';
    } else {
        digits += '0'.repeat(scale - fractionDigits);
    }
    const unscaled = BigInt(digits);
    if (unscaled >= 10n ** BigInt(precision)) return undefined;
    return sign === '-' ? -unscaled : unscaled;
};

export interface DecimalColumnMeta {
    scale: number;
    precision: number;
}

/** Converts a raw decimal cell as returned by hyparquet without the DECIMAL annotation. */
export const decimalCell = (value: unknown, scale: number): string | null => {
    if (value === null || value === undefined) return null;
    const unscaled = value instanceof Uint8Array ? bytesToBigInt(value) : BigInt(value as number | bigint);
    return formatDecimal(unscaled, scale);
};
