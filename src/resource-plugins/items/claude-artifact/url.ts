export interface ClaudeArtifactUrl { kind: 'code' | 'chat'; id: string; url: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Syntax only: an https claude.ai artifact page, never a lookalike host, port,
 * credential or nested asset path. Query and fragment are dropped from the canonical URL. */
export function parseClaudeArtifactUrl(input: unknown): ClaudeArtifactUrl | undefined {
  if (typeof input !== 'string' || input.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(input.trim()); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password) return undefined;
  const code = /^\/code\/artifact\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (code !== undefined) {
    if (!UUID.test(code)) return undefined;
    const id = code.toLowerCase();
    return { kind: 'code', id, url: `https://claude.ai/code/artifact/${id}` };
  }
  const chat = /^\/artifact\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (chat === undefined || !SHORT_ID.test(chat)) return undefined;
  return { kind: 'chat', id: chat, url: `https://claude.ai/artifact/${chat}` };
}

/** Finds artifact page URLs inside free text, validating each with the parser above. */
export function findClaudeArtifactUrls(text: string): ClaudeArtifactUrl[] {
  const found = new Map<string, ClaudeArtifactUrl>();
  // A nested path (an uploaded asset of the page) is not the artifact page itself.
  for (const [candidate] of text.slice(0, 65_536).matchAll(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+(?!\/[^\s"'<>)\]}]|[A-Za-z0-9_-])/gi)) {
    const parsed = parseClaudeArtifactUrl(candidate);
    if (parsed) found.set(parsed.url, parsed);
  }
  return [...found.values()];
}

export const defaultArtifactTitle = (id: string) => `Claude artifact · ${id.slice(0, 8)}`;
