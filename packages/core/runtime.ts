import * as z from 'zod/v4';
import type { WorkspaceState } from './control.ts';
import { humanOnlyMessage } from '../../src/resource-plugins/host.ts';
import { createPluginPackageRegistry } from '../../src/resource-plugins/builtins.ts';
import type { AgentPolicy, RuntimeOperationDeclaration } from '../plugin-sdk/host.ts';

/** Operations the host provides itself. Packages declare their own in act-plugin.json;
 * choosing who fixes review findings is the user's, and reports go through their own tool. */
export const hostRuntimeOperations: readonly RuntimeOperationDeclaration[] = [
  { id: 'agent.start' }, { id: 'agent.resume' }, { id: 'agent.reply' }, { id: 'agent.context' }, { id: 'agent.context.ack' }, { id: 'agent.context.inject' },
  { id: 'agent.title', agentPolicy: 'humanOnly' },
  { id: 'terminal.start' }, { id: 'terminal.startup' }, { id: 'terminal.input' }, { id: 'session.read' }, { id: 'skill.run' },
  { id: 'pr.comments' }, { id: 'pr.review.options' }, { id: 'pr.review.status' }, { id: 'review.result' }, { id: 'review.retry' },
  { id: 'review.findings', agentPolicy: { operations: { report: { redirect: 'Report fixed review findings with workspace_report_review_fixes.' }, list: 'allow', options: 'allow', preview: 'allow' }, otherwise: 'humanOnly' } },
  { id: 'pr.review.codex' }, { id: 'pr.review.claude' }, { id: 'pr.review.workflow' },
  // Arming spends review and agent runs on a person's behalf; agents may read its status and options.
  { id: 'review.loop', agentPolicy: { operations: { status: 'allow', options: 'allow' }, otherwise: 'humanOnly' } },
  // Launching spends a model run and publishes to claude.ai; agents may prepare and read status.
  { id: 'pr.architecture', agentPolicy: { operations: { options: 'allow', prepare: 'allow', status: 'allow' }, otherwise: 'humanOnly' } },
  { id: 'resource.read' }, { id: 'resource.actions' }, { id: 'resource.action' }, { id: 'resource.content' }, { id: 'resource.context' }, { id: 'resource.viewed' },
  { id: 'resource.opened', agentPolicy: 'humanOnly' },
  { id: 'plot', agentPolicy: 'humanOnly' },
];

/** Host operations followed by every bundled package's declared operations. */
export function runtimeOperationDeclarations(packages = createPluginPackageRegistry()): RuntimeOperationDeclaration[] {
  const declarations = [...hostRuntimeOperations, ...packages.runtimeOperations().map(({ owner, ...declaration }) => declaration)];
  const ids = declarations.map(declaration => declaration.id), duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Runtime operation declared twice: ${duplicate}`);
  return declarations;
}

export function runtimeRequestSchema(declarations: readonly RuntimeOperationDeclaration[]) {
  const [first, ...rest] = declarations.map(declaration => declaration.id);
  return z.object({ action: z.enum([first, ...rest]), nodeId: z.string().min(1), arguments: z.record(z.string(), z.json()).default({}) });
}

const declarations = runtimeOperationDeclarations();
/** Host and bundled operations. Processes that load installed packages build theirs with
 * `runtimeRequestSchema(runtimeOperationDeclarations())` once those packages are loaded. */
export const runtimeSchema = runtimeRequestSchema(declarations);
export type RuntimeRequest = z.infer<typeof runtimeSchema>;
/** Any well-formed operation id, for transports that load no plugin code; the service refuses
 * operations nothing handles. */
export const runtimeTransportSchema = z.object({ action: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,199}$/), nodeId: z.string().min(1), arguments: z.record(z.string(), z.json()).default({}) });
export interface RuntimeExecutionContext { agentInstructions?: Readonly<{ systemPrompt: string; version: string; delivery: 'system' | 'resume' }> }
export interface RuntimeAdapter { execute(request: RuntimeRequest, state: WorkspaceState, context: RuntimeExecutionContext): Promise<unknown> }

function agentRule(policy: AgentPolicy | undefined, operation: unknown) {
  if (!policy || typeof policy === 'string' || 'redirect' in policy) return policy ?? 'allow';
  return typeof operation === 'string' && Object.hasOwn(policy.operations, operation) ? policy.operations[operation] : policy.otherwise;
}

/** Why an agent may not run this operation through workspace_run, from its declared policy. */
export function agentRuntimeRefusal(request: { action: string; arguments?: RuntimeRequest['arguments'] }, known: readonly RuntimeOperationDeclaration[] = runtimeOperationDeclarations()) {
  const rule = agentRule(known.find(declaration => declaration.id === request.action)?.agentPolicy, request.arguments?.operation);
  if (rule === 'allow') return undefined;
  return rule === 'humanOnly' ? humanOnlyMessage : rule.redirect;
}
