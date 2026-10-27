import { NOTE_PAPERS } from '../../../src/resource-plugins/items/note/definition.ts';
import { isHexColor, isLightColor } from '../../../src/graph/colors.ts';

/** What a note's paper is drawn in: a named paper's token or a custom `#rrggbb`, and whether it is dark enough to take light ink.
 * An unknown value is mint, the default paper. */
export function paperPaint(paper: string | undefined): { color: string; dark: boolean } {
  if (isHexColor(paper)) { const color = paper.toLowerCase(); return { color, dark: !isLightColor(color) }; }
  const name: string = paper && (NOTE_PAPERS as readonly string[]).includes(paper) ? paper : 'mint';
  return { color: `var(--act-paper-${name})`, dark: name === 'slate' };
}
