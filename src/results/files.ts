import type { Signer } from '../core/signing.ts';
import type { FileReference } from '../sources/adapter.ts';

/**
 * Blob contents are referenced, never copied (concept §6.1). A reference path is
 *
 *     files/<mac>/<pin>/<container>/<blob name segments…>
 *
 * where `pin` is `e~<etag>`, `v~<versionId>`, `s~<snapshot>` or `z~<size>` (a linked
 * file whose size the source announced) and `mac` binds the reference to one result. A
 * download token for a result therefore only reaches the blobs that are actually in its
 * listing.
 */

const pinOf = (reference: FileReference): string => {
    if (reference.versionId) return `v~${reference.versionId}`;
    if (reference.snapshot) return `s~${reference.snapshot}`;
    if (reference.size !== undefined && !reference.etag) return `z~${reference.size}`;
    return `e~${(reference.etag ?? '').replace(/^"|"$/g, '')}`;
};

const canonical = (pin: string, container: string, name: string): string => `${pin}\n${container}\n${name}`;

export const encodeFileReference = (signer: Signer, resultId: string, reference: FileReference): string => {
    const pin = pinOf(reference);
    const mac = signer.fileMac(resultId, canonical(pin, reference.container, reference.name));
    const name = reference.name.split('/').map(encodeURIComponent).join('/');
    return `files/${mac}/${encodeURIComponent(pin)}/${encodeURIComponent(reference.container)}/${name}`;
};

/** Parses and verifies a reference path (with or without the `files/` prefix). */
export const decodeFileReference = (signer: Signer, resultId: string, path: string): FileReference | undefined => {
    const segments = path.replace(/^files\//, '').split('/');
    if (segments.length < 4) return undefined;
    const [mac, rawPin, rawContainer, ...rawName] = segments as [string, string, string, ...string[]];
    let pin: string;
    let container: string;
    let name: string;
    try {
        pin = decodeURIComponent(rawPin);
        container = decodeURIComponent(rawContainer);
        name = rawName.map(decodeURIComponent).join('/');
    } catch {
        return undefined;
    }
    if (!signer.verifyFileMac(resultId, canonical(pin, container, name), mac)) return undefined;
    const value = pin.slice(2);
    if (pin.startsWith('v~')) return { container, name, versionId: value };
    if (pin.startsWith('s~')) return { container, name, snapshot: value };
    if (pin.startsWith('e~')) return { container, name, etag: `"${value}"` };
    if (pin.startsWith('z~') && /^\d{1,15}$/.test(value)) return { container, name, size: Number(value) };
    return undefined;
};
