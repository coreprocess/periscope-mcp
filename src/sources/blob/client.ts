import { DefaultAzureCredential } from '@azure/identity';
import {
    AnonymousCredential,
    BlobServiceClient,
    newPipeline,
    type RequestPolicy,
    type RequestPolicyFactory,
    StorageSharedKeyCredential,
} from '@azure/storage-blob';
import type { BlobSourceConfig } from '../../config/sources.ts';
import { WireGuardError } from '../../core/errors.ts';
import type { CredentialState } from '../adapter.ts';

/**
 * Builds the only BlobServiceClient the blob source uses. A legacy request policy
 * factory appended to the pipeline blocks every request that is not GET or HEAD
 * (concept §7.1 A2). Child clients (containers, blobs) inherit the pipeline.
 */
export const readOnlyPolicyFactory = (source: string): RequestPolicyFactory => ({
    create: (next: RequestPolicy): RequestPolicy => ({
        sendRequest: (request) => {
            const method = request.method.toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') {
                const path = new URL(request.url).pathname;
                return Promise.reject(new WireGuardError(source, `${method} ${path}`));
            }
            return next.sendRequest(request);
        },
    }),
});

interface ParsedConnectionString {
    url: string;
    accountName?: string;
    accountKey?: string;
    sas?: string;
}

const parseConnectionString = (value: string): ParsedConnectionString => {
    const parts = new Map<string, string>();
    for (const segment of value.split(';')) {
        const eq = segment.indexOf('=');
        if (eq > 0) parts.set(segment.slice(0, eq).trim().toLowerCase(), segment.slice(eq + 1).trim());
    }
    const accountName = parts.get('accountname');
    const protocol = parts.get('defaultendpointsprotocol') ?? 'https';
    const suffix = parts.get('endpointsuffix') ?? 'core.windows.net';
    const url = parts.get('blobendpoint') ?? (accountName ? `${protocol}://${accountName}.blob.${suffix}` : undefined);
    if (!url) throw new Error('connection string needs BlobEndpoint or AccountName');
    return {
        url: url.replace(/\/+$/, ''),
        ...(accountName ? { accountName } : {}),
        ...(parts.get('accountkey') ? { accountKey: parts.get('accountkey') as string } : {}),
        ...(parts.get('sharedaccesssignature') ? { sas: parts.get('sharedaccesssignature') as string } : {}),
    };
};

const SAS_WRITE_PERMISSIONS = /[acdwxyuim]/;

export interface BlobClientSetup {
    client: BlobServiceClient;
    credential: CredentialState;
    credentialNote: string;
}

export const createBlobClient = (config: BlobSourceConfig): BlobClientSetup => {
    let url: string;
    let credential: StorageSharedKeyCredential | AnonymousCredential | DefaultAzureCredential;
    let state: CredentialState = 'unverified';
    let note = 'managed identity; assign Storage Blob Data Reader for a read-only credential';
    let sas: string | undefined;
    if (config.connectionString) {
        const parsed = parseConnectionString(config.connectionString);
        url = parsed.url;
        if (parsed.accountKey && parsed.accountName) {
            credential = new StorageSharedKeyCredential(parsed.accountName, parsed.accountKey);
            state = 'write-capable';
            note = 'account key; read-only is enforced by Periscope';
        } else {
            credential = new AnonymousCredential();
            sas = parsed.sas;
        }
    } else {
        url = (config.accountUrl as string).replace(/\/+$/, '');
        if (config.azureAuth) {
            credential = new DefaultAzureCredential();
        } else {
            credential = new AnonymousCredential();
            sas = config.sas;
        }
    }
    if (sas !== undefined) {
        const permissions = new URLSearchParams(sas.replace(/^\?/, '')).get('sp') ?? '';
        state = SAS_WRITE_PERMISSIONS.test(permissions) ? 'write-capable' : 'read-only verified';
        note = `SAS with permissions '${permissions}'`;
        url = `${url}?${sas.replace(/^\?/, '')}`;
    }
    const pipeline = newPipeline(credential, { retryOptions: { maxTries: 3 } });
    pipeline.factories.push(readOnlyPolicyFactory(config.name));
    return { client: new BlobServiceClient(url, pipeline), credential: state, credentialNote: note };
};
