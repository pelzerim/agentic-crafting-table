import type { ResourcePluginViews } from '../../types.ts';

/** Optional richer detail. The generic map bubble still comes from the definition. */
export const bookmarkViews: ResourcePluginViews = {
  mountDetail(container, resource) {
    const document = container.ownerDocument;
    const wrapper = document.createElement('div');
    const link = document.createElement('a');
    link.textContent = resource.title;
    link.href = String(resource.data.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const notes = document.createElement('p');
    notes.textContent = String(resource.data.notes ?? '');
    const status = document.createElement('small');
    status.setAttribute('aria-live', 'polite');
    wrapper.append(link, notes, status);
    container.append(wrapper);
    return { update(snapshot) { status.textContent = snapshot.label; }, dispose() { wrapper.remove(); } };
  },
};
