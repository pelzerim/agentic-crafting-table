/** GitHub attachments in Markdown point at github.com, which serves them only to a signed-in browser.
 * The API's rendered HTML of the same body carries a signed copy of each one that expires within
 * minutes, so the copy is looked up when the image is shown and never saved. Pure: the renderer uses it too. */
const ATTACHMENT = /^https:\/\/github\.com\/(?:user-attachments\/assets|[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+\/assets\/[1-9]\d*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SIGNED_HOSTS = new Set(['private-user-images.githubusercontent.com', 'user-images.githubusercontent.com']);
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Below the 8 MB service frame once base64 encoded. */
export const IMAGE_BYTES = 4 * 1024 * 1024;

/** The attachment's id, or undefined for every other address. */
export function attachmentId(src: string): string | undefined {
  return ATTACHMENT.exec(src.trim())?.[1].toLowerCase();
}

export function isSignedImageUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && SIGNED_HOSTS.has(url.hostname); } catch { return false; }
}

/** The signed address of attachment `id` in GitHub's rendered HTML of a body. */
export function signedImage(html: string, id: string): string | undefined {
  for (const match of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/gi)) {
    const value = match[1].replace(/&amp;/g, '&');
    if (isSignedImageUrl(value) && new URL(value).pathname.toLowerCase().includes(id)) return value;
  }
  return undefined;
}

export function isImageData(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
}
