import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { isResourceUrl } from './url-input.ts';

/** Library-parsed Markdown, constrained to the provider view's read-only surface. */
/** `breaks` keeps single newlines as line breaks, as on a note where each line is written by hand.
 * `images` names the image addresses the view loads itself: each stays an `img` without `src`, its address in
 * `data-image-src`, so the renderer never fetches it; every other image keeps the inert behaviour below. */
const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderMarkdown(container: HTMLElement, source: string, options: { allowHtml?: boolean; breaks?: boolean; images?: (src: string) => boolean } = {}): void {
  const document = container.ownerDocument;
  const markdown = new Marked({ gfm: true, breaks: options.breaks === true, async: false, renderer: {
    html({ text }) {
      if (options.allowHtml) return text;
      const literal = document.createElement('span'); literal.textContent = text;
      return literal.innerHTML; // Raw provider HTML remains visible, inert text.
    },
    image({ href, text, title }) {
      if (options.images?.(href)) return `<img src="${attribute(href)}" alt="${attribute(text)}"${title ? ` title="${attribute(title)}"` : ''}>`;
      // Provider images may require authentication. Keep the renderer free of
      // automatic remote requests; offer the attachment through the browser.
      const link = document.createElement('a'); link.href = href; link.textContent = `Image: ${text || 'Open attachment'}`;
      return link.outerHTML;
    },
  } });
  const purifier = createDOMPurify(document.defaultView!);
  purifier.addHook('uponSanitizeAttribute', (_node, attribute) => {
    if (attribute.attrName === 'href' && !isResourceUrl(attribute.attrValue)) attribute.keepAttr = false;
  });
  /** Runs in DOMPurify's inert document, before the fragment reaches this one, so no `src` is ever live here. */
  if (options.images) purifier.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName !== 'IMG') return;
    const src = node.getAttribute('src') ?? ''; node.removeAttribute('src');
    if (options.images!(src)) node.setAttribute('data-image-src', src); else node.setAttribute('data-image-drop', '');
  });
  const fragment = purifier.sanitize(markdown.parse(source, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'details', 'summary', ...(options.images ? ['img'] : [])],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled', 'open', ...(options.images ? ['src', 'alt', 'width', 'height'] : [])],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  // A disabled link should not reach the host's browser opener as an empty URL.
  for (const link of fragment.querySelectorAll('a:not([href])')) link.replaceWith(...link.childNodes);
  for (const image of fragment.querySelectorAll('img[data-image-drop]')) image.remove();
  for (const input of fragment.querySelectorAll('input')) { input.type = 'checkbox'; input.disabled = true; }
  container.replaceChildren(fragment);
}
