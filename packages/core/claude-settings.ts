/** Retain explicit legacy modes while producing exactly one native permission
 * flag. UI and launch use the same interpretation of split/inline arguments. */
export function claudePermissionSettings(settings: { autoMode: boolean; arguments: string[] }) {
  const args: string[] = [];
  let override: string | undefined;
  for (let i = 0; i < settings.arguments.length; i++) {
    const arg = settings.arguments[i];
    if (arg.startsWith('--permission-mode=')) override = arg.slice('--permission-mode='.length);
    else if (arg === '--permission-mode') {
      if (settings.arguments[i + 1] && !settings.arguments[i + 1].startsWith('-')) override = settings.arguments[++i];
    } else args.push(arg);
  }
  return { mode: override || (settings.autoMode ? 'auto' : 'default'), override, arguments: args };
}
