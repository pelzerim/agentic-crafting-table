import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/** Claude Code's own config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export const claudeConfigFile = (env: NodeJS.ProcessEnv = process.env, home = homedir()) => join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');

type ClaudeConfig = { projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>> } & Record<string, unknown>;
const trusted = (config: ClaudeConfig, folder: string) => {
  for (let path = folder; ; path = dirname(path)) {
    if (config.projects?.[path]?.hasTrustDialogAccepted === true) return true;
    if (dirname(path) === path) return false;
  }
};

/** Marks `folder` as trusted in Claude Code's config, as answering its folder-trust question does, so an interactive session the app
 * starts there does not wait on it. Only for folders the app creates and fills itself. Writes nothing when the folder or a parent is
 * already trusted, or when the config is missing or does not parse; the file is replaced in one rename and keeps its mode. */
export function trustClaudeFolder(folder: string, file = claudeConfigFile()): boolean {
  let config: ClaudeConfig, mode: number;
  try { config = JSON.parse(readFileSync(file, 'utf8')) as ClaudeConfig; mode = statSync(file).mode & 0o777; } catch { return false; }
  if (!config || typeof config !== 'object' || trusted(config, folder.replace(new RegExp(`\\${sep}+$`), '') || sep)) return false;
  const projects = { ...(config.projects ?? {}) };
  projects[folder] = { ...(projects[folder] ?? {}), hasTrustDialogAccepted: true };
  const temporary = `${file}.act-${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ ...config, projects }, null, 2), { mode });
  renameSync(temporary, file);
  return true;
}
