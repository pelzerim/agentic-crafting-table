import type { ResourcePluginViews } from '../../types.ts';
import { emptyState, mountViewHeader } from '../../view-header.ts';
import { parseVideoSource } from './source.ts';
import { mountVideoNotes } from './notes.ts';

/** The one video that plays on while its view is closed; another one taking its place stops it, so at most one hidden player holds memory. */
let behind: { stop(): void } | undefined;

/** A file plays in a `<video>` from the app's `/video/<item>` route, which serves only the file a video item on the
 * map names. A YouTube video plays in the host's embedded `youtube` site. */
export const videoViews: ResourcePluginViews = {
  // Saving notes changes the item's data; only another video remounts the view.
  identity: resource => String(resource.data.source ?? ''),
  mountDetail(container, resource, services) {
    const document = container.ownerDocument, source = parseVideoSource(resource.data.source);
    const root = document.createElement('section'), body = document.createElement('div'), stage = document.createElement('div');
    root.className = 'video-view'; body.className = 'video-body'; stage.className = 'video-stage';
    container.append(root);
    const header = mountViewHeader(document, services, root);
    body.append(stage); root.append(body);
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

    // The host keeps a closed view mounted but hidden: a file pauses and a YouTube page is let go, unless it plays in the background.
    let page: ReturnType<NonNullable<typeof services.mountWebPage>>, keep = false, active = false;
    const release = () => { player?.pause(); page?.dispose(); page = undefined; };
    const holder = { stop() { if (behind === holder) behind = undefined; release(); } };
    const notes = mountVideoNotes(document, resource, services, {
      time: async () => player ? player.currentTime : page?.media?.time(),
      seek: async seconds => { if (player) player.currentTime = seconds; else if (page?.media) await page.media.seek(seconds); else throw new Error('No player'); },
    });
    body.append(notes.element);
    const notesToggle = document.createElement('button');
    let notesOpen = services.viewState?.().notes === true;
    notesToggle.type = 'button'; notesToggle.className = 'video-notes-toggle'; notesToggle.textContent = 'Notes';
    const showNotes = () => { notes.element.hidden = !notesOpen; notesToggle.setAttribute('aria-pressed', String(notesOpen)); notes.setActive(active && notesOpen); };
    notesToggle.onclick = () => { notesOpen = !notesOpen; services.saveViewState?.({ notes: notesOpen || null }); showNotes(); if (notesOpen) notes.text.focus(); };
    header.actions.append(notesToggle); showNotes();
    const show = (shown: boolean) => {
      active = shown; showNotes();
      if (shown) {
        if (behind === holder) behind = undefined;
        if (youtube && !page) {
          page = services.mountWebPage?.(stage, { site: 'youtube', url: youtube.embedUrl });
          if (!page) stage.replaceChildren(emptyState(document, 'YouTube videos cannot play here'));
        }
        return;
      }
      if (!keep || (player && player.paused)) { release(); return; }
      if (behind !== holder) behind?.stop();
      behind = holder;
    };
    if (player || youtube) {
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'video-keep'; toggle.textContent = 'Play in background'; toggle.setAttribute('aria-pressed', 'false');
      toggle.title = 'Keep playing after the item closes. Only one video plays in the background at a time.';
      toggle.onclick = () => { keep = !keep; toggle.setAttribute('aria-pressed', String(keep)); };
      header.actions.append(toggle);
    }
    return {
      update() {},
      setActive: show,
      // A failed save keeps the view open with the panel showing why.
      async confirmClose() {
        if (await notes.flush()) return true;
        if (!notesOpen) { notesOpen = true; showNotes(); }
        return false;
      },
      dispose() { notes.dispose(); holder.stop(); player?.removeAttribute('src'); player?.load(); header.dispose(); root.remove(); },
    };
  },
};
