import type { JsonObject, ResourcePluginDefinition } from './types.ts';

/** Immediate, deterministic label; saving never waits for a model. */
export function localItemTitle(plugin: Pick<ResourcePluginDefinition, 'generatedTitle'> | undefined, data: JsonObject): string | undefined {
  const field = plugin?.generatedTitle?.field;
  if (!field || typeof data[field] !== 'string') return undefined;
  const line = data[field].trim().split(/\r?\n/).find(line => line.trim())?.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  return line ? Array.from(line).slice(0, 47).join('') + (Array.from(line).length > 47 ? '…' : '') : undefined;
}

/** The last part of a path: the name of the file or folder it leads to. */
export function lastPathPart(path: unknown): string | undefined {
  return typeof path === 'string' ? path.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
}

/** The name a new item gets when its name is left empty: an item of a file after that file, an agent after its provider,
 * any other session after its folder. */
export function defaultItemTitle(plugin: { name: string; acceptsContext?: boolean; creation?: { requires?: string; titleFromPath?: string } } | undefined, data: JsonObject): string | undefined {
  if (plugin?.creation?.titleFromPath) return lastPathPart(data[plugin.creation.titleFromPath]);
  if (plugin?.creation?.requires !== 'runtime') return undefined;
  if (plugin.acceptsContext) return `${String(data.provider ?? 'Claude').replace(/^./, char => char.toUpperCase())} session`;
  const folder = lastPathPart(data.cwd);
  return folder ? `${plugin.name} · ${folder}` : plugin.name;
}
