import { lastPathPart } from '../../generated-title.ts';

export const VIDEO_TYPE = 'workspace.video';

export type VideoSource = { kind: 'file'; path: string } | { kind: 'youtube'; id: string; url: string; embedUrl: string };

/** An absolute or `~/` path on one line that ends in a video extension. */
const VIDEO_PATH = /^(?:~\/|\/(?![/*]))[^\x00-\x1f\x7f]*\.(?:mp4|mov|m4v|webm)$/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Seconds from a `t` or `start` value such as `754`, `754s` or `12m34s`. */
function startSeconds(url: URL): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(url.searchParams.get('t') ?? url.searchParams.get('start') ?? '');
  const seconds = match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 0;
  return seconds > 0 ? seconds : undefined;
}

/** Syntax only: the `watch?v=`, `youtu.be/`, `shorts/` and `embed/` forms, never a lookalike host, port or credential. */
function youTubeVideo(input: string): { id: string; start?: number } | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
  const id = host === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(url.pathname)?.[1]
    : host === 'youtube.com' ? url.pathname.replace(/\/$/, '') === '/watch' ? url.searchParams.get('v') ?? undefined : /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1]
    : undefined;
  return id && YOUTUBE_ID.test(id) ? { id, start: startSeconds(url) } : undefined;
}

export function parseVideoSource(input: unknown): VideoSource | undefined {
  if (typeof input !== 'string' || input.length > 4096) return undefined;
  const value = input.trim();
  if (VIDEO_PATH.test(value)) return { kind: 'file', path: value };
  const video = youTubeVideo(value);
  if (!video) return undefined;
  const { id, start } = video;
  return { kind: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}` };
}

export const videoTitle = (source: VideoSource) => source.kind === 'file' ? lastPathPart(source.path) ?? 'Video' : 'YouTube video';
