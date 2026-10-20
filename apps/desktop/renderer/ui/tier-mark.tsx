import { Fragment } from 'react';
import { attentionTierInfo, attentionTiers } from '../../../../src/graph/attention.ts';
import type { AttentionCounts, AttentionTier } from '../../../../src/graph/attention.ts';
import { PIXEL_GLYPHS, glyphPath } from '../../../../src/resource-plugins/pixel-glyphs.ts';
import { StatusGlyph } from '../icons.tsx';

const TIER_PATHS = Object.fromEntries(attentionTiers.map(tier => [tier, glyphPath(PIXEL_GLYPHS[8][attentionTierInfo[tier].glyph])])) as Record<AttentionTier, string>;

/** The shape of a Needs me tier (diamond, triangle, dot) on the amber ramp. Decorative: the
 * caller names the tier in words or in its accessible name, so the tier is never colour or shape alone. */
export function TierMark({ tier, className }: { tier: AttentionTier; className?: string }) {
  return <svg className={className ? `tier-mark ${className}` : 'tier-mark'} data-tier={tier} data-glyph={attentionTierInfo[tier].glyph} aria-hidden="true" viewBox="0 0 8 8" shapeRendering="crispEdges"><path fill="currentColor" d={TIER_PATHS[tier]} /></svg>;
}

/** Counts as marks and numbers, tiers in order then Working, zeros omitted: "3 asking · 3 my turn ·
 * 2 finished · 4 working". Without `words` only marks and numbers are drawn; the words stay in the
 * text for assistive technology, so a count is never a shape alone. */
export function TierCounts({ counts, working = 0, words = false, className }: { counts: Pick<AttentionCounts, AttentionTier>; working?: number; words?: boolean; className?: string }) {
  const parts = [...attentionTiers.filter(tier => counts[tier] > 0).map(tier => <span key={tier} className="tier-count" data-tier={tier}><TierMark tier={tier} />{counts[tier]}<span className="tier-count-words"> {attentionTierInfo[tier].count}</span></span>),
    ...(working > 0 ? [<span key="working" className="tier-count" data-kind="working"><StatusGlyph icon="working" tone="mint" />{working}<span className="tier-count-words"> working</span></span>] : [])];
  if (!parts.length) return null;
  return <span className={className ? `tier-counts ${className}` : 'tier-counts'} data-compact={!words || undefined}>{parts.map((part, index) => <Fragment key={part.key}>{index > 0 && <span className="tier-count-gap"> · </span>}{part}</Fragment>)}</span>;
}
