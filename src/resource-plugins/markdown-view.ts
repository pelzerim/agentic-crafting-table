import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { isResourceUrl } from './url-input.ts';

/** Library-parsed Markdown, constrained to the provider view's read-only surface. */
/** `breaks` keeps single newlines as line breaks, as on a note where each line is written by hand. */
export function renderMarkdown(container: HTMLElement, source: string, options: { allowHtml?: boolean; breaks?: boolean } = {}): void {
  const document = container.ownerDocument;
  const markdown = new Marked({ gfm: true, breaks: options.breaks === true, async: false, renderer: {
    html({ text }) {
      if (options.allowHtml) return text;
      const literal = document.createElement('span'); literal.textContent = text;
      return literal.innerHTML; // Raw provider HTML remains visible, inert text.
    },
    image({ href, text }) {
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
  const fragment = purifier.sanitize(markdown.parse(source, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'details', 'summary'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled', 'open'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  // A disabled link should not reach the host's browser opener as an empty URL.
  for (const link of fragment.querySelectorAll('a:not([href])')) link.replaceWith(...link.childNodes);
  for (const input of fragment.querySelectorAll('input')) { input.type = 'checkbox'; input.disabled = true; }
  container.replaceChildren(fragment);
}
