import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RESULT_ID = /^r_[0-9A-Za-z]{22}$/;

/** 128 random bits, base62-encoded, prefixed with `r_`. Unguessable and URL-safe. */
export const newResultId = (): string => {
    let n = BigInt(`0x${randomBytes(16).toString('hex')}`);
    let out = '';
    for (let i = 0; i < 22; i++) {
        out = ALPHABET[Number(n % 62n)] + out;
        n /= 62n;
    }
    return `r_${out}`;
};

export const isResultId = (value: string): boolean => RESULT_ID.test(value);
