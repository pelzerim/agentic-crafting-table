import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { parseWebUrl } from './definition.ts';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const publicIPv6 = new BlockList();
publicIPv6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && publicIPv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function decodeTitle(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
  }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Page content is read as text only, never executed. Prefer the document title. */
export function extractPageTitle(html: string): string | undefined {
  const head = html.split(/<\/head\s*>|<body\b/i)[0]
    .replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  if (title && decodeTitle(title)) return decodeTitle(title);
  for (const meta of head.match(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) ?? []) {
    const attributes = Object.fromEntries([...meta.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare]));
    if (['og:title', 'twitter:title'].includes((attributes.property ?? attributes.name ?? '').toLowerCase())) {
      const value = decodeTitle(attributes.content ?? '');
      if (value) return value;
    }
  }
  return undefined;
}

/** Metadata reads are bounded, credential-free, and pinned to public DNS answers. */
interface MetadataTransport {
  resolve(hostname: string): Promise<LookupAddress[]>;
  request(url: URL, options: RequestOptions, response: (response: IncomingMessage) => void): ClientRequest;
  timeoutMs?: number;
}
const nativeTransport: MetadataTransport = {
  resolve: hostname => lookup(hostname, { all: true }),
  request: (url, options, response) => (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response),
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createPublicPageTitleReader(transport: MetadataTransport = nativeTransport) {
  return async (input: string, signal: AbortSignal): Promise<string | undefined> => {
    const timed = AbortSignal.any([signal, AbortSignal.timeout(transport.timeoutMs ?? 5000)]);
    let url = parseWebUrl(input);
    if (!url) throw new Error('Use an HTTP or HTTPS URL without embedded credentials');
    for (let redirects = 0; redirects <= 4; redirects++) {
      timed.throwIfAborted();
      if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Metadata lookup is limited to standard web ports');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(transport.resolve(hostname), timed);
      timed.throwIfAborted();
      if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('Metadata lookup requires a public address');
      const address = addresses[0];
      const result = await new Promise<{ redirect?: string; title?: string }>((resolve, reject) => {
        const request = transport.request(url!, {
          signal: timed,
          lookup: (_hostname, options, callback) => options.all
            ? callback(null, [address]) : callback(null, address.address, address.family),
          headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'AgentCraftingTable/1.0 (page title)' },
        }, response => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            resolve({ redirect: response.headers.location }); response.destroy(); return;
          }
          if (status < 200 || status >= 300 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] ?? '')
            || !['identity', undefined].includes(response.headers['content-encoding'])) {
            resolve({}); response.destroy(); return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          const finish = () => resolve({ title: extractPageTitle(Buffer.concat(chunks).toString('utf8')) });
          response.on('data', (chunk: Buffer) => {
            const remaining = 131072 - size;
            chunks.push(chunk.subarray(0, remaining)); size += Math.min(chunk.length, remaining);
            if (size >= 131072 || /<\/head\s*>/i.test(Buffer.concat(chunks).toString('utf8'))) { finish(); response.destroy(); }
          });
          response.on('end', finish);
          response.on('error', reject);
        });
        request.on('error', reject);
        request.end();
      });
      if (!result.redirect) return result.title;
      const next = parseWebUrl(new URL(result.redirect, url).href);
      if (!next) throw new Error('Invalid page redirect');
      url = next;
    }
    throw new Error('Too many page redirects');
  };
}

export const readPublicPageTitle = createPublicPageTitleReader();
