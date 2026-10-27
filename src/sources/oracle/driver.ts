import oracledb from 'oracledb';

/**
 * Switches node-oracledb to Thick mode for the whole process, before the first connection: Oracle's client libraries
 * (Instant Client, found through the dynamic linker) then handle the connections, which Thin mode cannot do for
 * databases that require Native Network Encryption or checksumming.
 */
export const useThickDriver = (): void => {
    oracledb.initOracleClient();
};
