import * as z from 'zod/v4';
import { POSITION_REQUIRED, linkReveal } from './control.ts';
import type { WorkspaceCommand } from './control.ts';
import { creationAnchors, creationContext, hasContext } from '../../src/graph/creation-placement.ts';
import type { GraphNode } from '../../src/graph/graph.ts';

export const creationConnectionSchema = z.object({ id: z.string().uuid(), otherId: z.string().trim().min(1).max(200), kind: z.enum(['reference', 'context']), sourceIsNew: z.boolean(), label: z.string().max(500).optional(), reveal: linkReveal.optional() });
export type CreationConnection = z.infer<typeof creationConnectionSchema>;
export const CREATION_CONNECTION_LIMIT = 8;
/** Every connection a creation request asks for: the single `connection` first, then `connections`. */
export function requestConnections(request: { connection?: CreationConnection; connections?: readonly CreationConnection[] } | undefined): CreationConnection[] {
  return [...(request?.connection ? [request.connection] : []), ...(request?.connections ?? [])];
}
export function creationConnections(connections: CreationConnection | readonly CreationConnection[] | undefined, nodeId: string): Extract<WorkspaceCommand, { type: 'link.save' }>[] {
  const list: readonly CreationConnection[] = !connections ? [] : 'id' in connections ? [connections] : connections;
  return list.map(connection => ({ type: 'link.save', link: { id: connection.id, sourceId: connection.sourceIsNew ? nodeId : connection.otherId, targetId: connection.sourceIsNew ? connection.otherId : nodeId, kind: connection.kind, label: connection.label ?? '', ...(connection.reveal ? { reveal: connection.reveal } : {}) } }));
}


const createFields = z.object({
  requestId: z.string().uuid(), nodeId: z.string().uuid(), resourceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit it: the item is added to the current workspace. When given it must be the revision from workspace_read.'), pluginId: z.string().min(1).max(200), title: z.string().trim().min(1).max(500),
  projectId: z.string().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional().describe('Omit it: the item lands next to what it connects to, or next to you, and joins that project. Give one only when the user asked for a specific place; a position far from that context is ignored.'),
  connection: creationConnectionSchema.optional(),
  connections: z.array(creationConnectionSchema).max(CREATION_CONNECTION_LIMIT).optional().describe('Links saved with the item in the same revision; sourceIsNew true points from the new item to otherId. May be combined with connection.'),
  connectionId: z.string().min(1).max(200).optional(),
  data: z.record(z.string(), z.json()),
});
const checked = <T extends z.ZodType<{ connection?: CreationConnection; connections?: CreationConnection[] }>>(schema: T) => schema
  .refine(request => requestConnections(request).length <= CREATION_CONNECTION_LIMIT, `At most ${CREATION_CONNECTION_LIMIT} connections`)
  .refine(request => new Set(requestConnections(request).map(connection => connection.id)).size === requestConnections(request).length, 'Each connection needs its own id');
/** A creation request as an agent writes it; its transport adds who asked. */
export const agentResourceCreateSchema = checked(createFields);
/** Plugin creation actions may perform host work; persisted item.add stays pure. `placedBy` is the agent node a
 * transport created the request for: such an item is placed in that agent's context (MAP-14). `hidden` is set by a
 * first-party service for an item it keeps off the map while it works. */
export const resourceCreateSchema = checked(createFields.extend({ placedBy: z.string().min(1).max(200).optional(), hidden: z.object({ label: z.string().trim().min(1).max(60) }).optional() }));
export type ResourceCreate = z.infer<typeof resourceCreateSchema>;

/** The `near` of the command that adds an agent's item: its connections in order, then the agent. Nothing for anyone else. */
export function creationNear(request: Pick<ResourceCreate, 'connection' | 'connections' | 'placedBy'>): { near?: string[] } {
  return request.placedBy ? { near: creationAnchors(requestConnections(request).map(connection => connection.otherId), request.placedBy) } : {};
}
/** The request host work starts from: an agent's item without a project joins its anchor's project here, so a session
 * launches in the project its node lands in. A request the map cannot place is refused before anything starts. */
export function placedRequest(request: ResourceCreate, nodes: readonly GraphNode[]): ResourceCreate {
  const { near } = creationNear(request), context = near ? creationContext(nodes, near, request.projectId) : undefined;
  if (!request.position && !(context && hasContext(nodes, context))) throw new Error(POSITION_REQUIRED);
  return context?.projectId && !request.projectId ? { ...request, projectId: context.projectId } : request;
}
