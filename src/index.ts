#!/usr/bin/env node
// Dates from database drivers are interpreted in the process time zone; Periscope runs in UTC.
process.env.TZ = 'UTC';

import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/env.ts';
import { errorMessage } from './core/errors.ts';
import { createLoggers } from './core/logger.ts';
import { Signer } from './core/signing.ts';
import { trustCertificates } from './core/tls.ts';
import { VERSION } from './core/version.ts';
import type { StoreDescriptor } from './results/parquet/protocol.ts';
import { ResultService } from './results/service.ts';
import { AzureBlobResultStore } from './results/store/azureblob.ts';
import { FilesystemResultStore } from './results/store/filesystem.ts';
import type { ResultStore } from './results/store/store.ts';
import { createHttpApp, listen } from './server/http.ts';
import { useThickDriver } from './sources/oracle/driver.ts';
import { SourceRegistry } from './sources/registry.ts';
import type { ToolContext } from './tools/context.ts';
import { createMcpServer } from './tools/tools.ts';

const USAGE = `periscope-mcp ${VERSION} — read-only MCP server for data sources

Usage: periscope-mcp [--env-file <path>]...

All configuration comes from environment variables (see docs/configuration.md).
  PERISCOPE_TRANSPORT=stdio|http   stdio for local use (default), http for deployments
  PERISCOPE_SOURCE_N, PERISCOPE_SOURCE_<i>_NAME, PERISCOPE_SOURCE_<i>_TYPE, …

Options:
  --env-file <path>   load variables from a dotenv file (may be repeated)
  --help              show this help
  --version           show the version
`;

const parseArgs = (argv: string[]): { envFiles: string[] } => {
    const envFiles: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === '--help' || arg === '-h') {
            process.stdout.write(USAGE);
            process.exit(0);
        }
        if (arg === '--version') {
            process.stdout.write(`${VERSION}\n`);
            process.exit(0);
        }
        if (arg === '--env-file') {
            const file = argv[++i];
            if (!file) throw new Error('--env-file needs a path');
            envFiles.push(file);
        } else if (arg.startsWith('--env-file=')) {
            envFiles.push(arg.slice('--env-file='.length));
        } else {
            throw new Error(`Unknown argument '${arg}'`);
        }
    }
    return { envFiles };
};

const main = async (): Promise<void> => {
    const { envFiles } = parseArgs(process.argv.slice(2));
    for (const file of envFiles) process.loadEnvFile(file);
    if (process.env.PERISCOPE_TRANSPORT !== 'http' && process.env.PERISCOPE_PORT === undefined) {
        process.env.PERISCOPE_PORT = '0';
    }
    const config = loadConfig();
    const loggers = createLoggers({ level: config.logLevel, auditLog: config.auditLog, transport: config.transport });
    const { log } = loggers;
    if (config.download.signingKeyGenerated) log.info('download signing key generated for this process');
    if (config.extraCaCerts.length > 0) {
        trustCertificates(config.extraCaCerts);
        log.info({ certificates: config.extraCaCerts.length }, 'additional CA certificates trusted');
    }
    if (config.oracleDriver === 'thick') {
        useThickDriver();
        log.info('oracle sources use the thick driver (Oracle Instant Client)');
    }

    const store: ResultStore =
        config.results.store === 'filesystem'
            ? new FilesystemResultStore(config.results.dir)
            : new AzureBlobResultStore({
                  accountUrl: config.results.accountUrl,
                  connectionString: config.results.connectionString,
                  container: config.results.container,
              });
    await store.init();
    const storeDescriptor: StoreDescriptor =
        config.results.store === 'filesystem'
            ? { kind: 'filesystem', dir: config.results.dir }
            : {
                  kind: 'azureblob',
                  accountUrl: config.results.accountUrl,
                  connectionString: config.results.connectionString,
                  container: config.results.container,
              };
    const signer = new Signer(config.download.signingKey);
    const service = new ResultService({
        store,
        storeDescriptor,
        retentionMs: config.results.retentionMs,
        partBytes: config.results.partBytes,
        maxConcurrentQueriesPerUser: config.maxConcurrentQueriesPerUser,
        read: config.read,
        loggers,
        signer,
    });
    const registry = new SourceRegistry(config.sources, log);
    void registry.initAll();

    let publicUrl = config.publicUrl;
    const context: ToolContext = { config, service, registry, signer, loggers, publicUrl: () => publicUrl };
    const app = createHttpApp(
        config,
        context,
        { store, signer, registry, loggers },
        { mcp: config.transport === 'http' }
    );
    const { server, port } = await listen(app, config.host, config.port);
    if (!process.env.PERISCOPE_PUBLIC_URL)
        publicUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
    log.info(
        { transport: config.transport, port, publicUrl, sources: registry.names(), store: config.results.store },
        'periscope started'
    );

    if (config.transport === 'stdio') {
        const mcp = createMcpServer(context);
        await mcp.connect(new StdioServerTransport());
        process.stdin.on('close', () => void shutdown(server, 'stdin closed'));
    }

    const timers = [
        setInterval(
            () => void service.sweep().catch((error) => log.warn({ err: error }, 'result sweep failed')),
            600_000
        ),
        setInterval(() => void service.pollRemoteCancellations().catch(() => undefined), 5_000),
    ];
    let stopping = false;
    const shutdown = async (http: Server, reason: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        log.info({ reason }, 'shutting down');
        for (const timer of timers) clearInterval(timer);
        http.close();
        await service.shutdown();
        await registry.closeAll();
        loggers.log.flush();
        loggers.audit.flush();
        setTimeout(() => process.exit(0), 200).unref();
    };
    process.on('SIGTERM', () => void shutdown(server, 'SIGTERM'));
    process.on('SIGINT', () => void shutdown(server, 'SIGINT'));
    process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'));
};

main().catch((error: unknown) => {
    process.stderr.write(`periscope-mcp: ${errorMessage(error)}\n`);
    process.exit(1);
});
