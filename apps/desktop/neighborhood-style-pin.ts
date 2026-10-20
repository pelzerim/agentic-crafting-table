import { NEIGHBORHOOD_STYLES } from '../../src/graph/neighborhood-fill.ts';
import type { NeighborhoodAppearance, NeighborhoodStyle } from '../../src/graph/neighborhood-fill.ts';

const style = (value: string | null | undefined) => NEIGHBORHOOD_STYLES.find(known => known === value);
/** A test run pins how neighborhoods are drawn (`ACT_TEST_NEIGHBORHOOD_STYLE=plain|biome`) whatever
 * the setting says, so screenshots of unrelated journeys do not depend on the ground. The setting
 * itself is saved and shown as usual. Outside tests the setting always decides. */
export function neighborhoodStylePin(testMode: boolean, value: string | undefined): NeighborhoodStyle | undefined {
  return testMode ? style(value) : undefined;
}
export const NEIGHBORHOOD_STYLE_PARAMETER = 'neighborhoods';
export function pinnedNeighborhoodStyle(search: string): NeighborhoodStyle | undefined { return style(new URLSearchParams(search).get(NEIGHBORHOOD_STYLE_PARAMETER)); }
export function pinNeighborhoodStyle(appearance: NeighborhoodAppearance, pin: NeighborhoodStyle | undefined): NeighborhoodAppearance {
  return pin && pin !== appearance.style ? { ...appearance, style: pin } : appearance;
}
