import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * HMAC helpers for download tokens and blob file references.
 * Separate subkeys are derived per purpose, so a value signed for one purpose
 * never verifies for another.
 */
export class Signer {
    readonly #tokenKey: Buffer;
    readonly #fileKey: Buffer;

    constructor(secret: Buffer) {
        this.#tokenKey = Buffer.from(hkdfSync('sha256', secret, 'periscope', 'download-token', 32));
        this.#fileKey = Buffer.from(hkdfSync('sha256', secret, 'periscope', 'file-reference', 32));
    }

    /** Encodes a payload as `base64url(json).base64url(hmac)`. */
    signToken(payload: Record<string, unknown>): string {
        const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${body}.${this.#mac(this.#tokenKey, body)}`;
    }

    /** Returns the payload if the signature is valid, otherwise undefined. */
    verifyToken(token: string): Record<string, unknown> | undefined {
        const dot = token.indexOf('.');
        if (dot <= 0 || dot !== token.lastIndexOf('.')) return undefined;
        const body = token.slice(0, dot);
        if (!safeEqual(token.slice(dot + 1), this.#mac(this.#tokenKey, body))) return undefined;
        try {
            const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Short MAC binding a file reference to one result. */
    fileMac(resultId: string, reference: string): string {
        return this.#mac(this.#fileKey, `${resultId}\n${reference}`).slice(0, 22);
    }

    verifyFileMac(resultId: string, reference: string, mac: string): boolean {
        return safeEqual(mac, this.fileMac(resultId, reference));
    }

    #mac(key: Buffer, value: string): string {
        return createHmac('sha256', key).update(value).digest('base64url');
    }
}

const safeEqual = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};
