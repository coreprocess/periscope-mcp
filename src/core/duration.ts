import { PeriscopeError } from './errors.ts';

const PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Parses a subset of ISO 8601 durations (`P1D`, `PT15M`, `PT24H`, `P1DT2H30M`) into milliseconds. */
export const parseIsoDuration = (value: string): number => {
    const match = PATTERN.exec(value.trim().toUpperCase());
    if (!match || value.trim().toUpperCase() === 'P' || value.trim().toUpperCase().endsWith('T')) {
        throw new PeriscopeError('invalid_argument', `Invalid ISO 8601 duration: '${value}'`);
    }
    const [, days, hours, minutes, seconds] = match;
    const ms =
        Number(days ?? 0) * 86_400_000 +
        Number(hours ?? 0) * 3_600_000 +
        Number(minutes ?? 0) * 60_000 +
        Number(seconds ?? 0) * 1000;
    if (ms <= 0) throw new PeriscopeError('invalid_argument', `Duration must be positive: '${value}'`);
    return ms;
};

export const isIsoDuration = (value: string): boolean => {
    try {
        parseIsoDuration(value);
        return true;
    } catch {
        return false;
    }
};
