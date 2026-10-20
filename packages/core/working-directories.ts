/** Distinct launch directories remembered for working-directory fields. */
export const MAX_RECENT_DIRECTORIES = 10;

export interface DirectoryDefaults { project?: string; global?: string; recent: readonly string[] }

/** The folder a new launch starts in when none is given: project, global default, most recent. */
export function defaultDirectory({ project, global, recent }: DirectoryDefaults): string {
  return project || global || recent[0] || '';
}

/** Choices for a working-directory field, each default labelled and every path listed once. */
export function directoryOptions({ project, global, recent }: DirectoryDefaults) {
  const options: { value: string; label: string; group: string }[] = [];
  const add = (path: string | undefined, group: string) => { if (path && !options.some(option => option.value === path)) options.push({ value: path, label: path, group }); };
  add(project, 'Project default'); add(global, 'Global default');
  for (const path of recent) add(path, 'Recent');
  return options;
}

/** The folder name and everything before it; joined they give the path back unchanged. */
export function splitDirectory(path: string): { parent: string; name: string } {
  const at = path.length < 2 ? -1 : Math.max(path.lastIndexOf('/', path.length - 2), path.lastIndexOf('\\', path.length - 2));
  return at < 0 ? { parent: '', name: path } : { parent: path.slice(0, at + 1), name: path.slice(at + 1) };
}
