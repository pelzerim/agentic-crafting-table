import type { JsonObject, ResourcePluginDefinition } from './types.ts';

/** Immediate, deterministic label; saving never waits for a model. */
export function localItemTitle(plugin: Pick<ResourcePluginDefinition, 'generatedTitle'> | undefined, data: JsonObject): string | undefined {
  const field = plugin?.generatedTitle?.field;
  if (!field || typeof data[field] !== 'string') return undefined;
  const line = data[field].trim().split(/\r?\n/).find(line => line.trim())?.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  return line ? Array.from(line).slice(0, 47).join('') + (Array.from(line).length > 47 ? '…' : '') : undefined;
}

/** The name a new session gets when its name is left empty: an agent after its provider, any other session after its folder. */
export function defaultItemTitle(plugin: { name: string; acceptsContext?: boolean; creation?: { requires?: string } } | undefined, data: JsonObject): string | undefined {
  if (plugin?.creation?.requires !== 'runtime') return undefined;
  if (plugin.acceptsContext) return `${String(data.provider ?? 'Claude').replace(/^./, char => char.toUpperCase())} session`;
  const folder = typeof data.cwd === 'string' ? data.cwd.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
  return folder ? `${plugin.name} · ${folder}` : plugin.name;
}
