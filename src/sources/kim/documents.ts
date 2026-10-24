import type { FileReference } from '../adapter.ts';

/**
 * Turns a node answer (members plus a URL-keyed pool of node envelopes) into one NDJSON
 * document per member: nested values in KIM's object format, plus the shapes, the
 * withheld positions and links to offloaded contents. Nodes of other objects that the
 * pick reached through crossings are grouped under `related`.
 */

export interface NodeEnvelope {
    shape: string;
    classes?: string[];
    position?: string;
    version?: string;
    size?: number;
    withheld?: string;
    classifications?: Record<string, unknown>;
    archived?: boolean;
    anonymized?: boolean;
    deleted?: boolean;
    value?: { replace: unknown };
}

interface ObjectPart {
    values: Record<string, unknown>;
    shapes: Record<string, string>;
    withheld?: Record<string, string>;
    files?: Record<string, { file: string; size: number }>;
}

export interface MemberDocument extends ObjectPart {
    url: string;
    version?: string;
    classes?: string[];
    archived?: boolean;
    anonymized?: boolean;
    deleted?: boolean;
    related?: Record<string, ObjectPart>;
}

/** Shapes whose offloaded contents the Bytes API serves. */
const FETCHABLE = new Set(['Text', 'Bytes', 'Json', 'RichText']);

/** Splits a KIM node URL into the object URL (origin/stage/collection/object) and the node path. */
export const splitNodeUrl = (url: string): { object: string; path: string } => {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const object = segments.slice(0, 3).map((segment, i) => (i === 2 ? segment.replace(/@.*$/, '') : segment));
    return { object: `${parsed.origin}/${object.join('/')}`, path: segments.slice(3).join('/') };
};

interface TreeNode {
    envelope: NodeEnvelope | undefined;
    children: Map<string, TreeNode>;
}

const render = (node: TreeNode): unknown => {
    const shape = node.envelope?.shape;
    if (node.children.size === 0 && node.envelope?.value) return node.envelope.value.replace;
    const children = [...node.children.entries()].sort(([, a], [, b]) =>
        (a.envelope?.position ?? '').localeCompare(b.envelope?.position ?? '')
    );
    if (shape === 'List') return children.map(([, child]) => render(child));
    return Object.fromEntries(children.map(([label, child]) => [label, render(child)]));
};

const buildPart = (
    nodes: [string, NodeEnvelope][],
    fileLink: (path: string, envelope: NodeEnvelope) => string | undefined
): ObjectPart => {
    const root: TreeNode = { envelope: undefined, children: new Map() };
    const part: ObjectPart = { values: {}, shapes: {} };
    for (const [path, envelope] of nodes) {
        if (!path) continue;
        part.shapes[path] = envelope.shape;
        if (envelope.withheld) {
            const link = envelope.withheld === 'offloaded' ? fileLink(path, envelope) : undefined;
            if (link) {
                part.files = { ...part.files, [path]: { file: link, size: envelope.size ?? 0 } };
            } else {
                part.withheld = { ...part.withheld, [path]: envelope.withheld };
            }
            continue;
        }
        let node = root;
        for (const label of path.split('.')) {
            let child = node.children.get(label);
            if (!child) {
                child = { envelope: undefined, children: new Map() };
                node.children.set(label, child);
            }
            node = child;
        }
        node.envelope = envelope;
    }
    part.values = render(root) as Record<string, unknown>;
    return part;
};

/** Objects named by the Reference values among the nodes (targets of crossings). */
const referencedObjects = (nodes: [string, NodeEnvelope][]): string[] =>
    nodes.flatMap(([, envelope]) =>
        envelope.shape === 'Reference' && typeof envelope.value?.replace === 'string'
            ? [splitNodeUrl(envelope.value.replace).object]
            : []
    );

export const memberDocuments = (
    members: string[],
    pool: Record<string, NodeEnvelope>,
    fileReference: (reference: FileReference) => string
): MemberDocument[] => {
    const byObject = new Map<string, [string, NodeEnvelope][]>();
    for (const [url, envelope] of Object.entries(pool)) {
        const { object, path } = splitNodeUrl(url);
        const list = byObject.get(object) ?? [];
        list.push([path, envelope]);
        byObject.set(object, list);
    }
    return members.map((memberUrl) => {
        const { object } = splitNodeUrl(memberUrl);
        const nodes = byObject.get(object) ?? [];
        const rootEnvelope = nodes.find(([path]) => path === '')?.[1] ?? pool[memberUrl];
        const version = rootEnvelope?.version;
        const [stage, collection, objectId] = new URL(object).pathname.split('/').filter(Boolean) as [
            string,
            string,
            string,
        ];
        const link = (path: string, envelope: NodeEnvelope): string | undefined =>
            version && FETCHABLE.has(envelope.shape)
                ? fileReference({ container: stage, name: `${collection}/${objectId}/${path}`, versionId: version })
                : undefined;
        const document: MemberDocument = {
            url: memberUrl,
            ...(version ? { version } : {}),
            ...(rootEnvelope?.classes ? { classes: rootEnvelope.classes } : {}),
            ...(rootEnvelope?.archived ? { archived: true } : {}),
            ...(rootEnvelope?.anonymized ? { anonymized: true } : {}),
            ...(rootEnvelope?.deleted ? { deleted: true } : {}),
            ...buildPart(nodes, link),
        };
        const related: Record<string, ObjectPart> = {};
        const queue = referencedObjects(nodes);
        while (queue.length > 0) {
            const other = queue.pop() as string;
            const otherNodes = byObject.get(other);
            if (other === object || related[other] || !otherNodes) continue;
            related[other] = buildPart(otherNodes, () => undefined);
            queue.push(...referencedObjects(otherNodes));
        }
        if (Object.keys(related).length > 0) document.related = related;
        return document;
    });
};
