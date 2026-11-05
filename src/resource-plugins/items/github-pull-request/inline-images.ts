import { attachmentId, isImageData } from '../../../../packages/provider-runtime/github-media.ts';
import type { ResourceViewServices } from '../../types.ts';

/** GitHub attachments are shown inline; every other image keeps the shared Markdown behaviour. */
export const isAttachment = (src: string) => attachmentId(src) !== undefined;

/** Loads each waiting image in `container` once, through the service, as a data URL; the renderer
 * never fetches it. An image that cannot be loaded becomes the attachment link it was before. */
export function loadImages(container: HTMLElement, location: { kind: string; commentId?: number }, services: Pick<ResourceViewServices, 'runAction'>) {
  for (const image of container.querySelectorAll<HTMLImageElement>('img[data-image-src]')) {
    const src = image.dataset.imageSrc!; delete image.dataset.imageSrc;
    image.setAttribute('aria-busy', 'true');
    const input = { kind: location.kind, src, ...(location.commentId === undefined ? {} : { commentId: String(location.commentId) }) };
    void services.runAction('resource.action', { actionId: 'image', input }).then(result => {
      const data = (result as { src?: unknown } | undefined)?.src;
      if (!isImageData(data)) throw new Error('GitHub returned no image.');
      image.src = data; image.removeAttribute('aria-busy');
    }).catch((error: unknown) => {
      const link = container.ownerDocument.createElement('a');
      link.href = src; link.textContent = `Image: ${image.alt || 'Open attachment'}`; link.title = (error as Error).message;
      image.replaceWith(link);
    });
  }
}
