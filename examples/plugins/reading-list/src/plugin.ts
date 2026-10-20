/** Definitions entry: platform-neutral (no node:*, no DOM). Loaded by the service, the MCP bridge
 * and the window, so it holds data and pure functions only. */
import * as z from 'zod/v4';
import type { PluginDefinitionsModule } from '@agent-crafting-table/plugin-sdk/index.ts';
import { READ_STATE, readingLink, TYPE_ID, UNREAD } from './definition.ts';

const plugin: PluginDefinitionsModule = {
  definitions: [readingLink],
  runtimeOperations: [
    // Agents may list the choices, but only a person marks a link read.
    { id: READ_STATE, description: 'Shows or sets whether a reading link is read.', agentPolicy: { operations: { options: 'allow' }, otherwise: 'humanOnly' } },
    { id: UNREAD, description: 'Lists unread reading links, optionally in one project.', agentPolicy: 'allow' },
  ],
  mcpTools: [{
    name: 'reading_list_unread',
    description: 'List reading links the user has not read yet: node ID, title, URL and tags. Pass projectId to limit it to one project. Read-only.',
    inputSchema: z.object({ projectId: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    request: (input, binding) => ({ action: UNREAD, nodeId: String(input.projectId ?? binding.projectId ?? 'reading-list'), arguments: input }),
  }],
  agentGuide: [{ id: 'reading-list.guide', text: 'Reading links (reading-list.link) hold an https URL, an optional note and up to five comma-separated tags. Add one with item.add when the user asks to save a page for later. List unread links with reading_list_unread. Never mark a link read: only the user can.' }],
  settings: { typeId: TYPE_ID, label: 'Link checks', fields: {
    checkLinks: { label: 'Check links online', kind: 'boolean', default: true, description: 'Reads each page title over HTTPS when you open the link and about every six hours. Off: nothing leaves this computer.' },
  } },
};
export default plugin;
