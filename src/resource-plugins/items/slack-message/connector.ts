import type { ResourcePluginConnector, ResourceRecord } from '../../types.ts';
import type { SlackClient } from '../../../../packages/provider-runtime/slack.ts';
export function slackMessageConnector(clientFor: (resource: ResourceRecord, signal: AbortSignal) => Promise<SlackClient>): ResourcePluginConnector {
  const read = async (resource: ResourceRecord, signal: AbortSignal) => (await clientFor(resource, signal)).thread({ workspaceHost: String(resource.data.workspaceHost), channelId: String(resource.data.channelId), messageTs: String(resource.data.messageTs), scope: resource.data.scope as 'message' | 'thread', ...(typeof resource.data.threadTs === 'string' ? { threadTs: resource.data.threadTs } : {}) }, signal);
  return {
    async load(resource, signal) {
      const thread = await read(resource, signal);
      return { title: thread.title, activity: 'idle', attention: 'none', connection: 'connected', observedAt: new Date().toISOString(), label: `Slack ${thread.scope} · ${thread.messages.length} ${thread.messages.length === 1 ? 'message' : 'messages'}${thread.incomplete ? ' · attachments in Slack' : ''}`,
        resolution: { data: { ...resource.data, threadTs: thread.threadTs }, aliases: [] }, detail: { ...thread, messages: thread.messages.map(message => ({ ...message })) } };
    },
    async getContext(resource, signal) {
      const thread = await read(resource, signal), messages = thread.scope === 'thread' ? thread.messages : thread.messages.filter(message => message.selected);
      const content = [`Slack ${thread.scope} · #${thread.channel}`, `Selected message: ${thread.selectedTs} · Thread: ${thread.threadTs}`, ...messages.map(message => `${message.author} (${message.userId}) · ${message.ts}${message.selected ? ' · selected' : ''}${message.edited ? ' · edited' : ''}\n${message.text}${message.incomplete ? '\n[Attachments or rich content require Slack.]' : ''}`)].join('\n\n');
      return { resourceId: resource.id, title: thread.title, sourceUrl: thread.url, content: content.length > 32_000 ? content.slice(0, 31_940) + '\n[Context excerpt ends here; open Slack for the rest.]' : content };
    },
  };
}
