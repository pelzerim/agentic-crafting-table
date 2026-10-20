import { defineResourcePlugin } from '../../define.ts';

export const linearTicket = defineResourcePlugin({
  settingsHelp: 'Keep a Linear issue on the table. Add its URL to sync its title, description and status; change its status or turn it into a local to-do.',
  id: 'linear.ticket', apiVersion: 1, schemaVersion: 1,
  name: 'Linear ticket', icon: 'circle-dashed', brand: 'linear', preferredView: 'inspector',
  connectionProvider: 'linear', todoSupport: true,
  webLink: { label: 'Open on Linear', template: 'https://linear.app/{workspaceKey}/issue/{issueId}' },
  contextMenu: [{ id: 'status', label: 'Change status', children: [], choices: { load: 'linear.status.options', apply: 'linear.status.set' } }],
  providerIdentity: (data, resource) => resource.connectionId && /^(?:[A-Z][A-Z0-9]*-[1-9]\d*|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(String(data.issueId)) ? String(data.issueId).toLowerCase() : undefined,
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 240, height: 64, minHeight: 48, summaryLines: 0, description: "Ticket identifier, title and workflow status." },
    medium: { width: 260, height: 84, summaryLines: 1, description: "Identifier, title and workflow status." },
  } },
  appearance: { tone: 'rose', shape: 'ticket', size: 'small', width: 240, showFullTitle: true },
  overview: { tally: { singular: 'ticket', plural: 'tickets' } },
  matchInput(input) {
    let url: URL;
    try { url = new URL(input); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password) return undefined;
    const match = /^\/([a-z0-9][a-z0-9_-]{0,199})\/issue\/([a-z][a-z0-9]*-[1-9]\d*)(?:\/[^/]*)?\/?$/i.exec(url.pathname);
    const issueId = match?.[2]?.toUpperCase();
    if (!issueId) return undefined;
    return { title: issueId, data: { issueId, workspaceKey: match![1] } };
  },
  fields: {
    issueId: { label: 'Issue ID', kind: 'text', required: true },
    workspaceKey: { label: 'Workspace', kind: 'text', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$' },
  },
  creation: { label: 'Attach ticket', shortLabel: 'Linear', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://linear.app/workspace/issue/TEAM-123/title' },
});
