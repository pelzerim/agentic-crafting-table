import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { WorkspaceState } from '../../packages/core/control.ts';
import { isArchived } from '../../src/graph/archive.ts';
import { VIDEO_TYPE, parseVideoSource } from '../../src/resource-plugins/items/video/source.ts';
import { filePathToReveal } from './reveal-file.ts';

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

/** The file a video item on the map points to, by item id. Anything else, including an archived item, gets nothing. */
export function videoFilePath(state: Pick<WorkspaceState, 'nodes' | 'resources'>, resourceId: string, home: string): string | undefined {
  const resource = state.resources.find(entry => entry.id === resourceId && entry.pluginId === VIDEO_TYPE);
  if (!resource || !state.nodes.some(node => node.resourceId === resourceId && !isArchived(node, state.nodes))) return undefined;
  const source = parseVideoSource(resource.data.source);
  return source?.kind === 'file' ? filePathToReveal(source.path, home) : undefined;
}

/** The file, or the byte range a `<video>` seeks to. A link that resolves to anything but a video file is refused. */
export async function videoResponse(path: string, range: string | null): Promise<Response> {
  const real = await realpath(path), type = TYPES[extname(real).toLowerCase()];
  if (!type) return new Response('Not found', { status: 404 });
  // One handle for the check and the read, so the file cannot be swapped in between.
  const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW), info = await file.stat();
  if (!info.isFile()) { await file.close(); return new Response('Not found', { status: 404 }); }
  const size = info.size, match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : undefined;
  if (range && (!match || (!match[1] && !match[2]))) { await file.close(); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } }); }
  let start = 0, end = size - 1;
  if (match?.[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
  else if (match?.[2]) start = Math.max(0, size - Number(match[2]));
  if (match && (start > end || start >= size)) { await file.close(); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } }); }
  const body = Readable.toWeb(file.createReadStream({ start, end: Math.max(end, start) })) as ReadableStream<Uint8Array>;
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (!match) return new Response(body, { status: 200, headers });
  return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` } });
}
