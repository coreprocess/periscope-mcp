import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PeriscopeError } from '../core/errors.ts';
import { isTextual } from '../core/media.ts';
import type { FileProvider, FileReference } from '../sources/adapter.ts';
import { getJson, putJson, type ResultStore } from './store/store.ts';
import type { BlockIndex } from './types.ts';

/**
 * Inline windows into blob contents referenced by a result (concept §5.4, §6.2):
 * text files by line range through a lazily built line index, images as image content.
 */

export const LINES_PER_CHUNK = 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface LineIndex extends BlockIndex {
    complete: boolean;
    scannedBytes: number;
    totalLines?: number;
}

export type FileWindow =
    | {
          kind: 'text';
          file: string;
          lineOffset: number;
          lines: string[];
          nextLineOffset: number | null;
          totalLines: number | null;
          truncatedByBytes: boolean;
      }
    | { kind: 'image'; file: string; mimeType: string; data: string; bytes: number };

const indexPath = (resultId: string, file: string): string =>
    `${resultId}/index/files/${createHash('sha256').update(file).digest('hex').slice(0, 32)}.json`;

const readAll = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
};

/** Extends the line index until it covers `untilLine` (or the end of the file). */
const extendIndex = async (
    provider: FileProvider,
    reference: FileReference,
    index: LineIndex,
    size: number,
    untilLine: number
): Promise<void> => {
    const last = index.blocks[index.blocks.length - 1];
    let lineStart = last ? last[0] + last[1] : 0;
    const byteOffset = last ? last[2] + last[3] : 0;
    if (byteOffset >= size) {
        index.complete = true;
        index.totalLines = lineStart;
        return;
    }
    const content = await provider.openFile(reference, { offset: byteOffset, length: size - byteOffset });
    let lines = 0;
    let chunkStart = byteOffset;
    let position = byteOffset;
    let endsWithNewline = true;
    try {
        for await (const chunk of content.stream) {
            const buffer = chunk as Buffer;
            let from = 0;
            while (true) {
                const newline = buffer.indexOf(10, from);
                if (newline === -1) break;
                lines++;
                from = newline + 1;
                if (lines === LINES_PER_CHUNK) {
                    const end = position + from;
                    index.blocks.push([lineStart, lines, chunkStart, end - chunkStart]);
                    lineStart += lines;
                    chunkStart = end;
                    lines = 0;
                }
            }
            position += buffer.length;
            if (buffer.length > 0) endsWithNewline = buffer[buffer.length - 1] === 10;
            index.scannedBytes = position;
            if (lineStart > untilLine && lines === 0) {
                content.stream.destroy();
                return;
            }
        }
    } catch (error) {
        if (lineStart <= untilLine) throw error;
        return;
    }
    // End of file: the remainder (possibly without trailing newline) forms the last chunk.
    if (chunkStart < size) {
        const tail = size - chunkStart;
        const remainderLines = lines + (endsWithNewline ? 0 : 1);
        index.blocks.push([lineStart, remainderLines, chunkStart, tail]);
        lineStart += remainderLines;
    }
    index.scannedBytes = size;
    index.complete = true;
    index.totalLines = lineStart;
};

export const readFileWindow = async (options: {
    store: ResultStore;
    resultId: string;
    file: string;
    reference: FileReference;
    provider: FileProvider;
    lineOffset: number;
    lineLimit: number;
    maxBytes: number;
}): Promise<FileWindow> => {
    const { store, resultId, file, reference, provider } = options;
    const head = await provider.openFile(reference, { offset: 0, length: 1 });
    head.stream.destroy();
    const name = reference.name;
    if (IMAGE_TYPES.has(head.contentType)) {
        if (head.size > MAX_IMAGE_BYTES) {
            throw new PeriscopeError('too_large', `Image is ${head.size} bytes; download it instead`);
        }
        const content = await provider.openFile(reference);
        const data = await readAll(content.stream);
        return { kind: 'image', file, mimeType: head.contentType, data: data.toString('base64'), bytes: data.length };
    }
    if (!isTextual(head.contentType, name)) {
        throw new PeriscopeError(
            'invalid_argument',
            `'${name}' is binary (${head.contentType}); it can only be downloaded through the manifest URL`
        );
    }

    const path = indexPath(resultId, file);
    const index: LineIndex = (await getJson<LineIndex>(store, path)) ?? {
        version: 1,
        file,
        unit: 'lines',
        columns: ['lineStart', 'lineCount', 'byteOffset', 'byteLength'],
        blocks: [],
        complete: false,
        scannedBytes: 0,
    };
    const end = options.lineOffset + options.lineLimit;
    const known = (): number => index.blocks.reduce((max, b) => Math.max(max, b[0] + b[1]), 0);
    if (!index.complete && known() < end) {
        await extendIndex(provider, reference, index, head.size, end);
        await putJson(store, path, index);
    }

    const needed = index.blocks.filter(([start, count]) => start < end && start + count > options.lineOffset);
    const lines: string[] = [];
    let bytes = 0;
    let truncatedByBytes = false;
    let next = options.lineOffset;
    if (needed.length > 0) {
        const first = needed[0] as [number, number, number, number];
        const last = needed[needed.length - 1] as [number, number, number, number];
        const content = await provider.openFile(reference, { offset: first[2], length: last[2] + last[3] - first[2] });
        const text = (await readAll(content.stream)).toString('utf8');
        const all = text.split('\n');
        if (all[all.length - 1] === '') all.pop();
        for (let i = 0; i < all.length; i++) {
            const lineNumber = first[0] + i;
            if (lineNumber < options.lineOffset || lineNumber >= end) continue;
            const line = (all[i] as string).replace(/\r$/, '');
            if (lines.length > 0 && bytes + line.length > options.maxBytes) {
                truncatedByBytes = true;
                break;
            }
            bytes += line.length + 1;
            lines.push(line);
            next = lineNumber + 1;
        }
    }
    const total = index.complete ? (index.totalLines ?? known()) : null;
    return {
        kind: 'text',
        file,
        lineOffset: options.lineOffset,
        lines,
        nextLineOffset: total !== null && next >= total ? null : next,
        totalLines: total,
        truncatedByBytes,
    };
};
