import type { ResourcePluginViews } from '../../types.ts';
import { emptyState, mountViewHeader } from '../../view-header.ts';
import { parseVideoSource } from './source.ts';

/** A file plays in a `<video>` from the app's `/video/<item>` route, which serves only the file a video item on the
 * map names. A YouTube video plays in the host's embedded `youtube` site. */
export const videoViews: ResourcePluginViews = {
  mountDetail(container, resource, services) {
    const document = container.ownerDocument, source = parseVideoSource(resource.data.source);
    const root = document.createElement('section'), stage = document.createElement('div');
    root.className = 'video-view'; stage.className = 'video-stage';
    container.append(root);
    const header = mountViewHeader(document, services, root);
    root.append(stage);
    const youtube = source?.kind === 'youtube' ? source : undefined;
    header.update(youtube ? { meta: ['YouTube'], link: { url: youtube.url, provider: 'YouTube' } } : { meta: [source?.kind === 'file' ? source.path : 'No video file'] });

    let player: HTMLVideoElement | undefined;
    if (source?.kind === 'file') {
      player = document.createElement('video');
      player.className = 'video-player'; player.controls = true; player.preload = 'metadata';
      player.onerror = () => stage.replaceChildren(emptyState(document, 'This video cannot be played', { detail: 'The file is missing, has moved, or is in a format the app cannot play.' }));
      player.src = `/video/${encodeURIComponent(resource.id)}`;
      stage.append(player);
    } else if (!youtube) stage.append(emptyState(document, 'No video file or YouTube link'));

    // The host keeps a closed view mounted but hidden: a file pauses, a YouTube page is held only while open.
    let page: { dispose(): void } | undefined;
    const show = (shown: boolean) => {
      if (!shown) player?.pause();
      if (!youtube || shown === Boolean(page)) return;
      if (!shown) { page!.dispose(); page = undefined; return; }
      page = services.mountWebPage?.(stage, { site: 'youtube', url: youtube.embedUrl });
      if (!page) stage.replaceChildren(emptyState(document, 'YouTube videos cannot play here'));
    };
    return {
      update() {},
      setActive: show,
      dispose() { show(false); player?.removeAttribute('src'); player?.load(); header.dispose(); root.remove(); },
    };
  },
};
