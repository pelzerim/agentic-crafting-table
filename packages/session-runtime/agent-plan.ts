import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import type { PreparedSession } from '../workspace-service/sessions.ts';

/** Frozen plans make retries use the original provider, context and native identity. */
export function readAgentPlan(directory: string, requestId: string): PreparedSession | undefined {
  z.string().uuid().parse(requestId);
  try { return JSON.parse(readFileSync(join(directory, 'agent-launches', requestId, 'plan.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export const RECOVERY_PROMPT = 'Agentic Crafting Table has reopened after closing interrupted your work. Resume the unfinished user task from this conversation. First check the current repository and table state and reconcile any tool or external action whose outcome was uncertain; do not repeat completed actions. Keep the crafting table in sync. Preserve existing permissions and ask for any decision still needed.';

export interface HostedLaunch { prompt: string; data: Record<string, import('../../src/resource-plugins/types.ts').JsonValue> }
export interface AgentCapability { executable: string; version: string; remoteControl?: boolean; autoMode?: boolean; structuredOutput?: boolean }
export interface AgentPreparation {
  request: import('../core/resource-creation.ts').ResourceCreate;
  state: import('../core/control.ts').WorkspaceState;
  directory: string;
  runtime: import('./client.ts').RuntimeOptions;
  capability: AgentCapability;
  resumeNodeId?: string;
  originRequest?: import('../core/resource-creation.ts').ResourceCreate;
  native?: { nativeSessionId: string; cwd: string };
  /** Used by a new session when neither the request nor its project names a folder. */
  fallbackDirectory?: string;
  continueWork?: boolean;
  /** Host-resolved invocation, never an arbitrary renderer-provided prompt. */
  skill?: import('../core/skills.ts').SkillInvocation;
  /** A host-built opening prompt and saved provenance (e.g. a PR architecture run). */
  hosted?: HostedLaunch;
}
