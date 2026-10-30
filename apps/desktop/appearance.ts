import type { Appearance } from '../../packages/core/settings.ts';

type ThemeSource = Appearance;
/** What Electron's `nativeTheme.themeSource` is set to. An explicit Light or Dark setting always
 * applies. In a test run System never follows the machine: it is dark unless the run pins
 * `ACT_TEST_APPEARANCE=light`, so screenshots stay the same everywhere. */
export function themeSource(testMode: boolean, pinned: string | undefined, setting: Appearance): ThemeSource {
  if (!testMode || setting !== 'system') return setting;
  return pinned === 'light' ? 'light' : 'dark';
}
/** The window's fill before the page paints, matching `--act-bg` in each theme. */
export const WINDOW_BACKGROUND = { dark: '#141a17', light: '#eef2ee' } as const;
export type ColorScheme = keyof typeof WINDOW_BACKGROUND;
/** The scheme a window opens in reaches the page in its address; later changes come over IPC. */
export const COLOR_SCHEME_PARAMETER = 'theme';
export function openingColorScheme(search: string): ColorScheme { return new URLSearchParams(search).get(COLOR_SCHEME_PARAMETER) === 'light' ? 'light' : 'dark'; }
