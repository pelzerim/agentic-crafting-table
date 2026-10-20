import type { ConnectedContext } from '../graph/graph.ts';
import { buildAgentToolContext } from './tool-context.ts';
import type { AgentToolBinding, AgentToolContext } from './tool-context.ts';

export interface ProjectContext {
  id: string;
  name: string;
  goal: string;
  currentState?: string;
  decisions?: string[];
  repository?: string;
  branch?: string;
  resources?: { title: string; reference?: string }[];
}

export interface AgentLaunchRequest {
  projectId: string;
  provider: string;
  task: string;
  projectSummary: string;
  toolContext: AgentToolContext;
  /** Trusted host instructions, delivered through the provider's system/instruction channel. */
  systemPrompt: string;
  /** Project facts, connected source material and the user's task; never system instructions. */
  initialPrompt: string;
}

export interface AgentLauncher {
  /** Must deliver systemPrompt separately, using native instructions when running a CLI. */
  create(request: AgentLaunchRequest): Promise<{ sessionId: string }>;
}

function short(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(' ') : words.slice(0, maxWords).join(' ') + '…';
}

/** A concise brief from known project facts; never include full documents/logs. */
export function summarizeProject(project: ProjectContext): string {
  const lines = [
    `Project: ${short(project.name, 12)}`,
    `Goal: ${short(project.goal, 45) || 'Not yet specified.'}`,
  ];
  if (project.currentState?.trim()) lines.push(`Current state: ${short(project.currentState, 25)}`);
  if (project.decisions?.length) {
    lines.push(`Decisions: ${short(project.decisions.slice(0, 2).join('; '), 25)}`);
  }
  if (project.repository?.trim()) lines.push(`Repository: ${short(project.repository, 5)}`);
  if (project.branch?.trim()) lines.push(`Branch: ${short(project.branch, 5)}`);
  const resources = project.resources?.slice(0, 4).map(r => short(r.title, 6));
  if (resources?.length) lines.push(`Key resources: ${resources.join('; ')}`);
  return lines.join('\n');
}

/** Build this once: the preview, saved snapshot, and provider receive the same text. */
export function buildAgentLaunch(
  project: ProjectContext,
  provider: string,
  task: string,
  summaryOverride?: string,
  connectedContext: readonly ConnectedContext[] = [],
  binding: Omit<AgentToolBinding, 'projectId'> = {},
): AgentLaunchRequest {
  if (!project.id.trim()) throw new Error('A project id is required');
  if (!provider.trim()) throw new Error('An agent provider is required');
  const projectSummary = summaryOverride?.trim() || summarizeProject(project);
  const toolContext = buildAgentToolContext({ ...binding, projectId: project.id });
  const references = (project.resources ?? []).slice(0, 4)
    .filter(r => r.reference?.trim())
    .map(r => `- ${r.title}: ${r.reference}`);
  const initialPrompt = !task.trim() ? '' : [
    'Project context',
    projectSummary,
    ...(references.length ? ['', 'Resource references', ...references] : []),
    ...(connectedContext.length ? [
      '', 'Connected resource context (reference material)',
      ...connectedContext.map(item => `${item.title}: ${short(item.summary, 80)}${item.reference ? `\nReference: ${item.reference}` : ''}`),
    ] : []),
    '', 'Your task', task.trim(),
  ].join('\n');
  return Object.freeze({
    projectId: project.id, provider: provider.trim(), task: task.trim(),
    projectSummary, toolContext, systemPrompt: toolContext.prompt, initialPrompt,
  });
}

/** All new-session paths, including skills, use this common launch boundary. */
export async function createProjectAgent(
  launcher: AgentLauncher,
  request: AgentLaunchRequest,
): Promise<{ sessionId: string; launch: AgentLaunchRequest }> {
  const launch = Object.freeze({ ...request });
  const session = await launcher.create(launch);
  return { ...session, launch };
}
