/** Sol models are named `gpt-<version>-sol`. The catalog decides which exist, so no version is written here. */
const SOL_MODEL = /^gpt-(\d+(?:\.\d+)*)-sol$/;
export const DEFAULT_CODEX_EFFORT = 'high';

const newer = (a: readonly number[], b: readonly number[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
};

/** The Sol model with the highest version; versions compare by number, so 5.10 is newer than 5.6. */
export function latestSolModel(models: readonly string[]) {
  let latest: { model: string; version: number[] } | undefined;
  for (const model of models) {
    const version = SOL_MODEL.exec(model)?.[1].split('.').map(Number);
    if (version && (!latest || newer(version, latest.version))) latest = { model, version };
  }
  return latest?.model;
}
