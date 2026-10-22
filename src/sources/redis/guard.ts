import { createRequire } from 'node:module';
import { PeriscopeError, QueryRejectedError } from '../../core/errors.ts';

/**
 * Read-only enforcement for Redis (concept §7.1 B):
 * 1. a tokenizer plus a strict allowlist for the user's command;
 * 2. a wire guard on @redis/client's RESP encoder, so every command any client in this
 *    process writes to a socket (including handshake and internal ones) is checked.
 * Redis's own command flags are not sufficient (PFCOUNT, TOUCH, EVAL_RO and XREAD are
 * flagged readonly but modify state, run scripts or block), hence a static list.
 */

/** Commands accepted in user queries. Container commands are listed with their subcommand. */
export const QUERY_COMMANDS = new Set([
    'GET',
    'MGET',
    'GETRANGE',
    'STRLEN',
    'EXISTS',
    'TYPE',
    'TTL',
    'PTTL',
    'EXPIRETIME',
    'PEXPIRETIME',
    'RANDOMKEY',
    'DBSIZE',
    'HGET',
    'HMGET',
    'HGETALL',
    'HKEYS',
    'HVALS',
    'HLEN',
    'HEXISTS',
    'HSTRLEN',
    'HRANDFIELD',
    'LRANGE',
    'LINDEX',
    'LLEN',
    'LPOS',
    'SMEMBERS',
    'SISMEMBER',
    'SMISMEMBER',
    'SCARD',
    'SRANDMEMBER',
    'SINTER',
    'SUNION',
    'SDIFF',
    'SINTERCARD',
    'ZRANGE',
    'ZRANGEBYSCORE',
    'ZRANGEBYLEX',
    'ZREVRANGE',
    'ZREVRANGEBYSCORE',
    'ZREVRANGEBYLEX',
    'ZSCORE',
    'ZMSCORE',
    'ZRANK',
    'ZREVRANK',
    'ZCARD',
    'ZCOUNT',
    'ZLEXCOUNT',
    'ZRANDMEMBER',
    'XRANGE',
    'XREVRANGE',
    'XLEN',
    'XINFO STREAM',
    'XINFO GROUPS',
    'XINFO CONSUMERS',
    'XPENDING',
    'BITCOUNT',
    'BITPOS',
    'GETBIT',
    'BITFIELD_RO',
    'GEOSEARCH',
    'GEOPOS',
    'GEODIST',
    'GEOHASH',
    'GEORADIUS_RO',
    'GEORADIUSBYMEMBER_RO',
    'SORT_RO',
    'JSON.GET',
    'JSON.MGET',
    'JSON.TYPE',
    'JSON.OBJKEYS',
    'JSON.OBJLEN',
    'JSON.ARRLEN',
    'JSON.STRLEN',
    'MEMORY USAGE',
    'OBJECT ENCODING',
    'OBJECT IDLETIME',
    'OBJECT FREQ',
    'SCAN',
    'HSCAN',
    'SSCAN',
    'ZSCAN',
]);

/** Additional commands the client itself needs on the wire (handshake, topology, introspection). */
const WIRE_ONLY = new Set([
    'HELLO',
    'AUTH',
    'SELECT',
    'PING',
    'READONLY',
    'ASKING',
    'CLIENT SETNAME',
    'CLIENT SETINFO',
    'CLUSTER SLOTS',
    'CLUSTER SHARDS',
    'INFO',
]);

const CONTAINER_COMMANDS = new Set([
    'CLIENT',
    'CLUSTER',
    'COMMAND',
    'OBJECT',
    'MEMORY',
    'XINFO',
    'CONFIG',
    'FUNCTION',
    'SCRIPT',
    'ACL',
    'MODULE',
    'LATENCY',
    'SLOWLOG',
    'PUBSUB',
    'DEBUG',
    'XGROUP',
]);

export const commandName = (args: ReadonlyArray<string | Buffer>): string => {
    const first = args[0]?.toString().toUpperCase() ?? '';
    if (CONTAINER_COMMANDS.has(first) && args.length > 1) return `${first} ${args[1]?.toString().toUpperCase()}`;
    return first;
};

/** Arguments that would turn an allowlisted command into a write or a blocking call. */
const FORBIDDEN_ARGUMENTS: Record<string, RegExp> = {
    GEOSEARCH: /^STORE(DIST)?$/i,
};

export const isAllowedOnWire = (args: ReadonlyArray<string | Buffer>): boolean => {
    const name = commandName(args);
    if (!QUERY_COMMANDS.has(name) && !WIRE_ONLY.has(name)) return false;
    const forbidden = FORBIDDEN_ARGUMENTS[name];
    return !forbidden || !args.slice(1).some((a) => forbidden.test(a.toString()));
};

let installed = false;

/** Patches @redis/client's RESP encoder once per process (pinned version, covered by tests). */
export const installRedisWireGuard = (): void => {
    if (installed) return;
    const require = createRequire(import.meta.url);
    const encoder = require('@redis/client/dist/lib/RESP/encoder.js') as {
        default: (args: ReadonlyArray<string | Buffer>) => unknown;
    };
    const original = encoder.default;
    encoder.default = (args) => {
        if (!isAllowedOnWire(args)) {
            throw new PeriscopeError('forbidden', `Redis command blocked by the read-only guard: ${commandName(args)}`);
        }
        return original(args);
    };
    installed = true;
};

/** Splits a redis-cli style command line, honouring double quotes (with escapes) and single quotes. */
export const tokenize = (line: string): string[] => {
    const tokens: string[] = [];
    let i = 0;
    while (i < line.length) {
        const char = line[i] as string;
        if (/\s/.test(char)) {
            i++;
            continue;
        }
        let token = '';
        if (char === '"') {
            i++;
            let closed = false;
            while (i < line.length) {
                const c = line[i] as string;
                if (c === '\\') {
                    const next = line[i + 1];
                    const escapes: Record<string, string> = {
                        n: '\n',
                        r: '\r',
                        t: '\t',
                        b: '\b',
                        a: '\x07',
                        '"': '"',
                        '\\': '\\',
                    };
                    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
                        token += String.fromCharCode(Number.parseInt(line.slice(i + 2, i + 4), 16));
                        i += 4;
                    } else if (next !== undefined && escapes[next] !== undefined) {
                        token += escapes[next];
                        i += 2;
                    } else {
                        token += next ?? '';
                        i += 2;
                    }
                } else if (c === '"') {
                    closed = true;
                    i++;
                    break;
                } else {
                    token += c;
                    i++;
                }
            }
            if (!closed) throw new QueryRejectedError('Unterminated double-quoted string');
        } else if (char === "'") {
            i++;
            const end = line.indexOf("'", i);
            if (end === -1) throw new QueryRejectedError('Unterminated single-quoted string');
            token = line.slice(i, end);
            i = end + 1;
        } else {
            while (i < line.length && !/\s/.test(line[i] as string)) token += line[i++];
        }
        if (i < line.length && !/\s/.test(line[i] as string)) {
            throw new QueryRejectedError('Quoted strings must be followed by whitespace');
        }
        tokens.push(token);
    }
    return tokens;
};

export interface ParsedCommand {
    name: string;
    args: string[];
}

export const parseReadOnlyCommand = (query: string): ParsedCommand => {
    if (/[\r\n]/.test(query.trim())) throw new QueryRejectedError('Exactly one command is allowed');
    const args = tokenize(query);
    if (args.length === 0) throw new QueryRejectedError('Empty command');
    const name = commandName(args);
    if (!QUERY_COMMANDS.has(name)) {
        throw new QueryRejectedError(`Command '${name}' is not allowed; only read-only, non-blocking commands are`);
    }
    if (!isAllowedOnWire(args)) throw new QueryRejectedError(`Command '${name}' with these arguments is not allowed`);
    return { name, args };
};
