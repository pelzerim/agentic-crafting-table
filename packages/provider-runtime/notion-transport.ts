import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAccount } from '../core/connections.ts';

const uuid = /^[a-f0-9]{32}$|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function notionId(value: unknown) { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid Notion identity.'); return value.replaceAll('-', '').toLowerCase(); }
export interface NotionCredentials { accounts(signal: AbortSignal): Promise<ProviderAccount[]>; token(account: string, signal: AbortSignal): Promise<{ token: string; botId: string }> }
const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'notion-cli', 'config.json');
async function readConfig(signal: AbortSignal): Promise<unknown> {
  try { const path = configPath(); if ((await stat(path)).size > 256 * 1024) throw new Error(); return JSON.parse(await readFile(path, { encoding: 'utf8', signal })); }
  catch { signal.throwIfAborted(); throw new Error('Notion CLI profiles are unavailable. Sign in with notion auth login, then reconnect.'); }
}
/** Read an existing CLI credential store without changing its active profile or
 * copying credentials into app data. Only labels and bot identities leave here. */
export function notionCredentials(read: (signal: AbortSignal) => Promise<unknown> = readConfig): NotionCredentials {
  async function profiles(signal: AbortSignal) {
    signal.throwIfAborted(); const raw = await read(signal); signal.throwIfAborted();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Notion CLI profile configuration.');
    const config = raw as Record<string, any>;
    const entries = config.profiles && typeof config.profiles === 'object' && !Array.isArray(config.profiles) && Object.keys(config.profiles).length ? Object.entries(config.profiles) : [['default', config]];
    if (entries.length > 20) throw new Error('Too many Notion CLI profiles to discover.');
    return entries.flatMap(([name, value]) => {
      const profile = value as Record<string, unknown>; if (!profile || typeof profile !== 'object' || typeof name !== 'string' || name.length > 80 || /[\0-\x1f]/.test(name)) return [];
      let botId: string; try { botId = notionId(profile.bot_id); } catch { return []; }
      const token = typeof profile.token === 'string' && profile.token.length >= 10 && profile.token.length <= 4096 && !/\s/.test(profile.token) ? profile.token : undefined;
      return [{ id: JSON.stringify([name, botId]), name, botId, token, label: `${String(profile.workspace_name || name).slice(0, 100)} · ${name}`, active: name === (config.current_profile || 'default') }];
    });
  }
  return {
    async accounts(signal) { return (await profiles(signal)).map(({ id, label, token, active }) => ({ id, label, available: Boolean(token), active, credentialSource: 'Notion CLI profile' })); },
    async token(account, signal) { const profile = (await profiles(signal)).find(profile => profile.id === account); if (!profile?.token) throw new Error('The selected Notion profile changed or is unavailable. Reconnect the original account in Settings.'); return { token: profile.token, botId: profile.botId }; },
  };
}
/** `status` is the HTTP status of a refused read, so callers can degrade one optional capability. */
export class NotionReadError extends Error { status?: number; constructor(message: string, status?: number) { super(message); if (status) this.status = status; } }
export interface NotionTransport { get(path: string, signal: AbortSignal): Promise<unknown> }
export function allowedNotionRead(path: string) {
  const url = new URL(path, 'https://api.notion.com');
  if (url.origin !== 'https://api.notion.com' || url.hash || !path.startsWith('/v1/')) return false;
  const parts = url.pathname.split('/').slice(2);
  if (parts.join('/') === 'users/me') return !url.search;
  if (parts.length === 1 && parts[0] === 'comments') {
    const keys = [...url.searchParams.keys()];
    return keys.every(key => ['block_id', 'page_size', 'start_cursor'].includes(key)) && keys.length === new Set(keys).size && uuid.test(url.searchParams.get('block_id') ?? '')
      && url.searchParams.get('page_size') === '100' && (!url.searchParams.has('start_cursor') || uuid.test(url.searchParams.get('start_cursor')!));
  }
  try { notionId(parts[1]); } catch { return false; }
  const route = (parts[0] === 'pages' && (parts.length === 2 || (parts.length === 4 && parts[2] === 'properties' && /^[A-Za-z0-9_%!~.-]{1,300}$/.test(parts[3]) && !['.', '..'].includes(decodeURIComponent(parts[3])))))
    || (parts[0] === 'blocks' && parts.length === 3 && parts[2] === 'children');
  if (!route || [...url.searchParams.keys()].some(key => !['page_size', 'start_cursor'].includes(key))) return false;
  return (!url.searchParams.has('page_size') || url.searchParams.get('page_size') === '100') && url.searchParams.getAll('page_size').length <= 1 && url.searchParams.getAll('start_cursor').length <= 1 && (!url.searchParams.has('start_cursor') || uuid.test(url.searchParams.get('start_cursor')!));
}
/** Fixed origin, GET-only, no redirects; one pinned token for the whole read. */
export function notionTransport(token: string, fetcher: typeof fetch = fetch): NotionTransport {
  return { async get(path, signal) {
    signal.throwIfAborted(); if (!allowedNotionRead(path)) throw new NotionReadError('Unsupported Notion read path.');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let response: Response;
    try { response = await fetcher(`https://api.notion.com${path}`, { method: 'GET', redirect: 'error', signal: combined, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2026-03-11', Accept: 'application/json' } }); }
    catch { signal.throwIfAborted(); throw new NotionReadError('Notion is unreachable. Check your connection and retry.'); }
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) throw new NotionReadError('Notion content exceeds the response limit.'); chunks.push(chunk.value); }
      combined.throwIfAborted();
      if (response.status === 429) throw Object.assign(new NotionReadError('Notion rate limit reached. Retry after the cooldown.'), { retryAt: Date.now() + Math.max(1, Math.min(3600, Number(response.headers.get('retry-after')) || 60)) * 1000 });
      if (response.status === 401) throw new NotionReadError('Notion sign-in expired. Reconnect the selected account.');
      if (response.status === 403 || response.status === 404) throw new NotionReadError('This Notion page is unavailable or has not been shared with the selected integration.', response.status);
      if (response.status !== 200) throw new NotionReadError('Notion could not complete this read. Retry later.');
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new NotionReadError('Notion returned invalid JSON.'); }
    } catch (error) { signal.throwIfAborted(); if (error instanceof NotionReadError) throw error; throw new NotionReadError('The Notion response was interrupted. Retry later.'); } finally { await reader?.cancel().catch(() => {}); }
  } };
}
