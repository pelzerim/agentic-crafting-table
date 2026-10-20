import { defineResourcePlugin } from '../../define.ts';

export const notionPage = defineResourcePlugin({
  settingsHelp: 'Keep a Notion page with your project. Add its URL to read its content here and connect it to an agent as context.',
  id: 'notion.page', apiVersion: 1, schemaVersion: 1,
  name: 'Notion page', icon: 'file-text', preferredView: 'inspector',
  connectionProvider: 'notion',
  webLink: { label: 'Open on Notion', template: 'https://www.notion.so/{pageId}' },
  providerIdentity: (data, resource) => resource.connectionId && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(String(data.pageId)) ? String(data.pageId).replaceAll('-', '').toLowerCase() : undefined,
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 150, height: 48, summaryLines: 0, description: "Page title and attention." },
    medium: { width: 230, height: 84, summaryLines: 1, description: "Title and saved page/sync status." },
  } },
  appearance: { tone: 'stone', shape: 'document', size: 'small' },
  matchInput(input) {
    let url: URL;
    try { url = new URL(input); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.username || url.password || !/^(?:[a-z0-9-]+\.)?notion\.(?:so|site|com)$/.test(url.hostname)) return undefined;
    const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const id = /(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(segment)?.[1];
    if (!id) return undefined;
    return { title: 'Notion page', data: { pageId: id.replaceAll('-', '').toLowerCase() } };
  },
  fields: {
    pageId: { label: 'Page ID', kind: 'text', required: true },
  },
  creation: { label: 'Attach page', shortLabel: 'Notion', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://www.notion.so/your-page-link' },
});
