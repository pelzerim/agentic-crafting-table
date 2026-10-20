/** Service-only: reads a page's title over HTTPS. Bounded in time, size and redirects; sends no
 * cookies or credentials; refuses addresses on this machine or the local network. */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type CheckState = 'ok' | 'broken' | 'unreachable' | 'skipped';
export interface CheckResult { state: CheckState; checkedAt: string; status?: number; pageTitle?: string; reason?: string }
export type PageCheck = (url: string, signal: AbortSignal) => Promise<CheckResult>;

const TIMEOUT_MS = 8_000, MAX_BYTES = 256 * 1024, MAX_REDIRECTS = 3;

/** Loopback, private, link-local, carrier-grade NAT and unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (isIP(mapped) === 4) {
    const [a, b] = mapped.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return mapped === '::' || mapped === '::1' || /^f[cd]/.test(mapped) || /^fe[89ab]/.test(mapped);
}

export function pageTitle(html: string): string | undefined {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = raw?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : undefined;
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (reader && size < MAX_BYTES) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.byteLength;
  }
  await reader?.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

/** The real check. Tests inject their own `PageCheck` instead of reaching the network. */
export const checkPage: PageCheck = async (input, caller) => {
  const checkedAt = new Date().toISOString(), signal = AbortSignal.any([caller, AbortSignal.timeout(TIMEOUT_MS)]);
  let url = new URL(input);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password) return { state: 'skipped', checkedAt, reason: 'Only https links are checked' };
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(entry => entry.address);
      if (host === 'localhost' || addresses.some(isPrivateAddress)) return { state: 'skipped', checkedAt, reason: 'Local network links are not checked' };
      const response = await fetch(url, { redirect: 'manual', signal, credentials: 'omit', headers: { accept: 'text/html' } });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) { await response.body?.cancel(); url = new URL(location, url); continue; }
      if (response.status === 404 || response.status === 410) { await response.body?.cancel(); return { state: 'broken', checkedAt, status: response.status }; }
      if (!response.ok) { await response.body?.cancel(); return { state: 'unreachable', checkedAt, status: response.status, reason: `The site answered ${response.status}` }; }
      const type = response.headers.get('content-type') ?? '';
      return { state: 'ok', checkedAt, status: response.status, ...(type.includes('html') ? { pageTitle: pageTitle(await readText(response, signal)) } : {}) };
    }
    return { state: 'unreachable', checkedAt, reason: 'Too many redirects' };
  } catch (error) {
    caller.throwIfAborted();
    return { state: 'unreachable', checkedAt, reason: (error as Error).name === 'TimeoutError' ? 'The site took too long' : 'The site could not be reached' };
  }
};
