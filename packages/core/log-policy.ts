import * as z from 'zod/v4';

export const DEFAULT_LOG_POLICY = { fileMiB: 1, backups: 2 };
export const logPolicySchema = z.object({ fileMiB: z.number().int().min(1).max(16), backups: z.number().int().min(0).max(5) }).strict();
export type LogPolicy = z.infer<typeof logPolicySchema>;

/** Backend child → private diagnostic owner. No environment values or content. */
export function publishLogPolicy(policy: LogPolicy) {
  if (process.connected && process.send) process.send({ kind: 'diagnostic-policy', policy }, () => {});
}
