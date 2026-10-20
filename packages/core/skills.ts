import * as z from 'zod/v4';
import { creationConnectionSchema } from './resource-creation.ts';

/** Metadata only. Skill bodies and native resolution remain owned by each provider. */
export interface ProjectSkill { id: string; name: string; description: string; argumentHint?: string; source?: string; unavailable?: string }
export interface ProjectSkillCatalog { cwd: string; skills: ProjectSkill[]; warnings: string[] }
export const skillListSchema = z.object({ projectId: z.string().min(1).max(200), provider: z.string().min(1).max(100), cwd: z.string().max(4096).optional() });
export const skillRunSchema = skillListSchema.omit({ projectId: true }).extend({
  requestId: z.string().uuid(), nodeId: z.string().uuid(), resourceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit it: the run is added to the current workspace. When given it must be the revision from workspace_read.'),
  skillId: z.string().min(1).max(4096), model: z.string().trim().min(1).max(100), arguments: z.string().max(32_000).default(''),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  connection: creationConnectionSchema.optional(),
});
export type SkillRun = z.infer<typeof skillRunSchema>;
export interface SkillInvocation { id: string; name: string; prompt: string }
