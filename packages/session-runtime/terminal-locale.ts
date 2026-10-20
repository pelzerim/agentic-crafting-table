/** Finder/Dock does not supply a shell locale. Native macOS clipboard tools
 * otherwise decode UTF-8 CLI output as legacy text. Keep explicit locale choices
 * and category overrides; only supply the missing LANG default for child tools. */
export function terminalLocale(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return { ...environment, LANG: environment.LANG || (platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8') };
}
