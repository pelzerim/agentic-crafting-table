import { defineResourcePlugin } from '../../define.ts';
import type { ResourceDraft, ResourceSnapshot } from '../../types.ts';

const workspacePattern = '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.slack\\.com$';
const timestampPattern = '^\\d{10}\\.\\d{6}$';

/** Keep the selected reply and its thread root as distinct, exact string IDs. */
export function parseSlackLink(input: string): ResourceDraft | undefined {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !new RegExp(workspacePattern).test(url.hostname)) return undefined;
  const message = /^\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{1,6})\/?$/.exec(url.pathname);
  if (!message) return undefined;
  const [, channelId, seconds, fraction] = message;
  const messageTs = `${seconds}.${fraction.padStart(6, '0')}`;
  const threadTs = url.searchParams.get('thread_ts');
  if (url.searchParams.getAll('thread_ts').length > 1
    || (threadTs !== null && !new RegExp(timestampPattern).test(threadTs))) return undefined;
  const cid = url.searchParams.get('cid');
  if (cid !== null && cid !== channelId) return undefined;
  return {
    title: threadTs ? 'Slack thread' : 'Slack message',
    data: { workspaceHost: url.hostname, channelId, messageTs,
      scope: threadTs ? 'thread' : 'message', ...(threadTs ? { threadTs } : {}) },
  };
}

/** The selected message, preceded by its thread root when the item is a thread. */
export function slackTitleEvidence(snapshot: ResourceSnapshot) {
  const detail = snapshot.detail, messages = Array.isArray(detail?.messages) ? detail.messages as { text?: unknown; selected?: unknown }[] : [];
  const selected = messages.find(message => message.selected === true), thread = detail?.scope === 'thread';
  const chosen = [...new Set([thread ? messages[0] : undefined, selected].filter(message => message !== undefined))];
  const text = chosen.map(message => typeof message.text === 'string' ? message.text.trim() : '').filter(Boolean).join('\n\n');
  return text ? { kind: thread ? 'Slack thread' : 'Slack message', text } : undefined;
}

export const slackMessage = defineResourcePlugin({
  settingsHelp: 'Bring a Slack message or thread into your project. Add its link to read the conversation and connect it to related work.',
  id: 'slack.message', apiVersion: 1, schemaVersion: 1,
  name: 'Slack', icon: 'messages-square', brand: 'slack', preferredView: 'inspector',
  connectionProvider: 'slack',
  webLink: { label: 'Open in Slack', template: ['https://{workspaceHost}/archives/{channelId}/p{messageTs:digits}?thread_ts={threadTs}&cid={channelId}', 'https://{workspaceHost}/archives/{channelId}/p{messageTs:digits}'] },
  providerIdentity: (data, resource) => resource.connectionId ? JSON.stringify([data.workspaceHost, data.channelId, data.messageTs, data.scope]) : undefined,
  mapSizes: { defaultSize: 'small', sizes: {
    small: { width: 210, height: 48, summaryLines: 0, description: "Message/thread title and attention." },
    medium: { width: 260, height: 104, summaryLines: 1, fields: ['workspaceHost'], fieldLines: 1, description: "Saved scope/message count and workspace." },
  } },
  appearance: { tone: 'violet', shape: 'rounded', size: 'small', width: 210, showFullTitle: true },
  matchInput: parseSlackLink,
  attachTitle: { evidence: slackTitleEvidence },
  fields: {
    workspaceHost: { label: 'Workspace host', kind: 'text', required: true, pattern: workspacePattern },
    channelId: { label: 'Channel ID', kind: 'text', required: true, pattern: '^[CGD][A-Z0-9]+$' },
    messageTs: { label: 'Selected message timestamp', kind: 'text', required: true, pattern: timestampPattern },
    scope: { label: 'Content', kind: 'select', required: true, options: ['message', 'thread'] },
    threadTs: { label: 'Thread root timestamp', kind: 'text', pattern: timestampPattern },
  },
  validateData: data => data.scope !== 'thread' || typeof data.threadTs === 'string',
  creation: { label: 'Attach Slack', action: 'resource.attach', mode: 'url', urlPlaceholder: 'https://workspace.slack.com/archives/C0123456789/p1727172000000001' },
});
