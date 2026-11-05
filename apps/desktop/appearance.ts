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
type BackgroundSurface = { setBackgroundColor(color: string): void };
/** Fills both surfaces. When the page's top edge lands on half a device pixel, the row above it
 * belongs to neither the menu bar nor the page, and only the content view's own fill covers it. */
export function fillWindowBackground(window: BackgroundSurface & { contentView: BackgroundSurface }, scheme: ColorScheme): void {
  for (const surface of [window, window.contentView]) surface.setBackgroundColor(WINDOW_BACKGROUND[scheme]);
}
/** The scheme a window opens in reaches the page in its address; later changes come over IPC. */
export const COLOR_SCHEME_PARAMETER = 'theme';
export function openingColorScheme(search: string): ColorScheme { return new URLSearchParams(search).get(COLOR_SCHEME_PARAMETER) === 'light' ? 'light' : 'dark'; }
