/** Colour values a person can choose: `#rrggbb`, the custom pad's cells and the shared Your colours list. */
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && HEX_COLOR_PATTERN.test(value);

/** A typed colour as lower-case `#rrggbb`: the leading `#` is optional and `#rgb` is expanded. */
export function parseHexColor(text: string): string | undefined {
  const digits = text.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(digits)) return undefined;
  return `#${(digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits).toLowerCase()}`;
}

export function hexToHsl(hex: string): [hue: number, saturation: number, lightness: number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  return [60 * (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4), s, l];
}
export function hslToHex(hue: number, saturation: number, lightness: number) {
  const h = (hue % 360 + 360) % 360, s = Math.max(0, Math.min(1, saturation)), l = Math.max(0, Math.min(1, lightness)), a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return Math.max(0, Math.min(255, Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255))); };
  return '#' + [0, 8, 4].map(n => channel(n).toString(16).padStart(2, '0')).join('');
}

/** The custom pad: hues 30° apart across, shades from light to dark down. */
export const COLOR_PAD_HUES = 12, COLOR_PAD_SHADES = 8;
const PAD_SATURATION = .6, PAD_TOP_LIGHTNESS = .88, PAD_LIGHTNESS_STEP = .1;
const padShade = (shade: number) => Math.max(0, Math.min(COLOR_PAD_SHADES - 1, Math.round(shade)));
export function colorPadColor(hue: number, shade: number) {
  return hslToHex((Math.round(hue) % COLOR_PAD_HUES) * 360 / COLOR_PAD_HUES, PAD_SATURATION, PAD_TOP_LIGHTNESS - padShade(shade) * PAD_LIGHTNESS_STEP);
}
/** The pad cell nearest a colour, where the pad opens for it. */
export function colorPadCell(hex: string): { hue: number; shade: number } {
  const [h, , l] = hexToHsl(hex);
  return { hue: Math.round(h / (360 / COLOR_PAD_HUES)) % COLOR_PAD_HUES, shade: padShade((PAD_TOP_LIGHTNESS - l) / PAD_LIGHTNESS_STEP) };
}

/** Your colours: the custom colours a person chose last, in any picker. */
export const RECENT_COLORS_MAX = 8;
export function withRecentColor(recent: readonly string[], color: string): string[] {
  if (!isHexColor(color)) return [...recent];
  const chosen = color.toLowerCase();
  return [chosen, ...recent.filter(other => other.toLowerCase() !== chosen)].slice(0, RECENT_COLORS_MAX);
}

/** Whether dark ink reads better on the colour than light ink (WCAG relative luminance). */
export function isLightColor(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b > .179;
}
