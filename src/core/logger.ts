import { type Logger, pino } from 'pino';

/**
 * Two streams: an operational log and an audit log. In stdio mode both go to stderr,
 * because stdout carries the MCP protocol.
 */
export interface Loggers {
    log: Logger;
    audit: Logger;
}

const destinationFor = (target: string): number | string => {
    if (target === 'stdout') return 1;
    if (target === 'stderr') return 2;
    return target;
};

export const createLoggers = (options: { level: string; auditLog: string; transport: 'stdio' | 'http' }): Loggers => {
    const logDestination = options.transport === 'stdio' ? 2 : 1;
    const log = pino(
        { level: options.level, base: { service: 'periscope' } },
        pino.destination({ dest: logDestination, sync: false })
    );
    const audit = pino(
        { level: 'info', base: { service: 'periscope', stream: 'audit' }, messageKey: 'event' },
        pino.destination({ dest: destinationFor(options.auditLog), sync: false, mkdir: true })
    );
    return { log, audit };
};

/** Silent loggers for tests. */
export const nullLoggers = (): Loggers => ({ log: pino({ level: 'silent' }), audit: pino({ level: 'silent' }) });
