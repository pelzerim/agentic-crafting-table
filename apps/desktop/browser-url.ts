/** The same narrow boundary protects terminal links in renderer and main. */
export function browserUrl(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid URL');
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP browser links are supported');
  return url.href;
}

/** What Copy URL puts on the clipboard: one browser URL, or up to 200 of them, one per line. */
export function clipboardUrls(input: unknown): string {
  const urls = Array.isArray(input) ? input : [input];
  if (!urls.length || urls.length > 200) throw new Error('Invalid URL');
  return urls.map(browserUrl).join('\n');
}
