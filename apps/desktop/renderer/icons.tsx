import brands from './brand-paths.json' with { type: 'json' };
import { PIXEL_GLYPHS, glyphPath } from '../../../src/resource-plugins/pixel-glyphs.ts';
import type { GlyphName, GlyphSize } from '../../../src/resource-plugins/pixel-glyphs.ts';

/** Item, menu and control icon names drawn from the 12×12 UI and type glyphs. */
const UI_GLYPHS: Record<string, GlyphName<12>> = {
  terminal: 'terminal', 'square-terminal': 'terminal', 'message-square': 'message', 'messages-square': 'messages',
  'git-pull-request': 'git-pull-request', 'git-merge': 'git-merge', project: 'folder', sparkles: 'sparkles', grid: 'grid',
  server: 'server', link: 'link', unlink: 'unlink', globe: 'globe', square: 'square', 'square-check': 'square-check',
  check: 'check', seen: 'check', settings: 'settings', file: 'file', 'file-text': 'file', note: 'file', review: 'search',
  workflow: 'workflow', bookmark: 'bookmark', circle: 'circle', 'circle-dashed': 'circle-dashed', open: 'open',
  external: 'external', copy: 'copy', refresh: 'refresh', undermap: 'undermap', archive: 'archive', plus: 'plus', minus: 'minus',
  inbox: 'inbox', 'chevron-left': 'chevron-left', rocket: 'rocket', box: 'box', remote: 'remote', clock: 'clock',
  bell: 'bell', x: 'close', 'alert-triangle': 'alert', bang: 'bang',
};

/** Status and small-control names drawn from the 8×8 glyphs: one distinct shape per indicator so state reads in greyscale. */
const STATUS_GLYPHS: Record<string, GlyphName> = {
  check: 'check', seen: 'check', x: 'close', clock: 'clock', 'alert-triangle': 'alert', 'git-merge': 'git-merge',
  'git-pull-request': 'git-pull-request', 'message-square': 'message', working: 'working', plus: 'plus', minus: 'minus',
  review: 'search', unlink: 'unlink', archive: 'archive', 'chevron-left': 'chevron-left', 'tier-board': 'tier-board',
  'tier-icon': 'tier-icon', 'tier-card': 'tier-card', open: 'open', external: 'external', remote: 'remote',
  undermap: 'undermap', refresh: 'refresh', inbox: 'inbox',
};
const VIEW_BOX: Record<GlyphSize, string> = { 8: '-.5 -.5 9 9', 12: '0 0 12 12' };

const uiGlyph = (icon: string): GlyphName<12> => UI_GLYPHS[icon]
  ?? (icon.includes('terminal') ? 'terminal' : icon.includes('server') ? 'server' : icon.includes('link') ? 'link' : icon.includes('globe') ? 'globe'
    : icon.includes('check') ? 'square-check' : icon.includes('settings') ? 'settings' : 'file');

export function StatusGlyph({ icon, tone }: { icon: string; tone?: string }) {
  const glyph = STATUS_GLYPHS[icon];
  if (!glyph) return <span className="status-glyph" data-tone={tone}><ItemIcon icon={icon} /></span>;
  return <svg className="status-glyph" data-tone={tone} data-glyph={icon} aria-hidden="true" viewBox={VIEW_BOX[8]} shapeRendering="crispEdges"><path fill="currentColor" d={glyphPath(PIXEL_GLYPHS[8][glyph])} /></svg>;
}

/** A pixel icon: 12×12 for item types and controls, `size={8}` for status cues and 8px marks.
 * Provider logos keep their brand path; `tint` keeps the type icon and only takes the brand's colour. */
export function ItemIcon({ icon = 'item', brand, tint = false, size = 12, className = '' }: { icon?: string; brand?: string; tint?: boolean; size?: GlyphSize; className?: string }) {
  const path = tint ? undefined : brands[brand as keyof typeof brands];
  if (path) return <svg className={`item-icon brand-${brand} ${className}`} data-icon={icon} aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d={path} /></svg>;
  const small = size === 8 ? STATUS_GLYPHS[icon] : undefined;
  return <svg className={`item-icon pixel-icon ${brand ? `brand-${brand}` : ''} ${className}`} aria-hidden="true" data-icon={icon} viewBox={VIEW_BOX[small ? 8 : 12]} shapeRendering="crispEdges">
    <path fill="currentColor" d={glyphPath(small ? PIXEL_GLYPHS[8][small] : PIXEL_GLYPHS[12][uiGlyph(icon)])} />
  </svg>;
}
