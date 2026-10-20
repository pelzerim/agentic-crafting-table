/** Service entry (Node): the connector and the two runtime operations. Runs in the workspace service. */
import type { JsonObject, ResourceChoices, RuntimeOperationContext, ServiceModule, WorkspaceServices } from '@agent-crafting-table/plugin-sdk/index.ts';
import { checkPage } from './check.ts';
import { linkRecord, readingLinkConnector, saveLinkRecord } from './connector.ts';
import { READ_STATE, TYPE_ID, UNREAD, parseTags } from './definition.ts';

/** `options` lists the read-state choices; `set` applies one (people only, see plugin.ts). */
export async function readState(context: RuntimeOperationContext, workspace: WorkspaceServices): Promise<ResourceChoices | { readAt: string | null }> {
  const resource = context.resource;
  if (resource?.pluginId !== TYPE_ID) throw new Error('This works on reading links only.');
  const current = linkRecord(workspace.storage, resource.id).readAt ? 'read' : 'unread', { operation, value } = context.arguments;
  if (operation === 'options') return { current, context: {}, options: [{ id: 'unread', label: 'Unread' }, { id: 'read', label: 'Read' }] };
  if (operation !== 'set' || (value !== 'read' && value !== 'unread')) throw new Error('Choose Read or Unread.');
  const readAt = value === 'read' ? new Date().toISOString() : undefined;
  await context.execute(async () => { saveLinkRecord(workspace.storage, resource.id, { readAt }); });
  // Re-read so the map card and any open view show the new state; a fresh check is reused.
  await workspace.resources.read(context.nodeId, true, context.signal);
  return { readAt: readAt ?? null };
}

/** Unread links on the map (not archived or done), optionally in one project. */
export async function unreadLinks(args: JsonObject, workspace: Pick<WorkspaceServices, 'control' | 'storage'>) {
  const state = await workspace.control.read(), limit = typeof args.limit === 'number' ? args.limit : 20;
  const links = state.nodes.flatMap(node => {
    const resource = state.resources.find(record => record.id === node.resourceId);
    if (resource?.pluginId !== TYPE_ID || node.archivedAt || node.completedAt) return [];
    if (typeof args.projectId === 'string' && node.projectId !== args.projectId) return [];
    if (linkRecord(workspace.storage, resource.id).readAt) return [];
    return [{ nodeId: node.id, title: node.title, url: String(resource.data.url), tags: parseTags(resource.data.tags) }];
  });
  return { links: links.slice(0, limit), total: links.length };
}

const service: ServiceModule = {
  activate(host) {
    // Register everything here, during activate: the host applies registrations when activate returns.
    // The workspace (storage, control, resources) arrives later through onWorkspace.
    let workspace: WorkspaceServices | undefined;
    const ready = () => { if (!workspace) throw new Error('The workspace is still starting. Try again.'); return workspace; };
    host.connector(TYPE_ID, readingLinkConnector({ check: checkPage, storage: () => workspace?.storage, settings: () => host.settings() }));
    host.runtimeOperation(READ_STATE, context => readState(context, ready()));
    host.runtimeOperation(UNREAD, context => unreadLinks(context.arguments, ready()), { requiresNode: false });
    host.onWorkspace(services => { workspace = services; });
  },
};
export default service;
