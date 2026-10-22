/**
 * Error types that cross module boundaries. Every error that reaches an MCP client
 * or an HTTP response is a PeriscopeError with a stable code.
 */

export type ErrorCode =
    | 'config_invalid'
    | 'invalid_argument'
    | 'unknown_source'
    | 'forbidden'
    | 'unauthorized'
    | 'query_rejected'
    | 'not_found'
    | 'expired'
    | 'precondition_failed'
    | 'too_large'
    | 'timeout'
    | 'cancelled'
    | 'source_error'
    | 'limit_exceeded'
    | 'internal';

export class PeriscopeError extends Error {
    readonly code: ErrorCode;
    readonly details: Record<string, unknown> | undefined;

    constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
        super(message, options);
        this.name = 'PeriscopeError';
        this.code = code;
        this.details = details;
    }
}

/** Raised by read-only guards. Always synchronous, before any result exists. */
export class QueryRejectedError extends PeriscopeError {
    constructor(reason: string, details?: Record<string, unknown>) {
        super('query_rejected', reason, details);
        this.name = 'QueryRejectedError';
    }
}

/** Raised by wire guards when code tries to send a non-read request to a source. */
export class WireGuardError extends PeriscopeError {
    constructor(source: string, description: string) {
        super('forbidden', `Blocked non-read request to source '${source}': ${description}`, { source });
        this.name = 'WireGuardError';
    }
}

export const isPeriscopeError = (error: unknown): error is PeriscopeError => error instanceof PeriscopeError;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const toPeriscopeError = (error: unknown, fallback: ErrorCode = 'internal'): PeriscopeError => {
    if (isPeriscopeError(error)) return error;
    return new PeriscopeError(fallback, errorMessage(error), undefined, { cause: error });
};
