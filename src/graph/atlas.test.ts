import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_MAP, atlasBounds, atlasGlyphKind, atlasGlyphs, atlasProjectAt, atlasStep, atlasTransform, needsMeIds } from './atlas.ts';
import type { AtlasItem, AtlasProject } from './atlas.ts';

const square = (id: string, x: number, y: number, size = 400): AtlasProject => ({ id, left: x - size / 2, top: y - size / 2, right: x + size / 2, bottom: y + size / 2, center: { x, y },
  points: [{ x: x - size / 2, y: y - size / 2 }, { x: x + size / 2, y: y - size / 2 }, { x: x + size / 2, y: y + size / 2 }, { x: x - size / 2, y: y + size / 2 }] });
const item = (id: string, x: number, y: number, extra: Partial<AtlasItem> = {}): AtlasItem => ({ id, resourceId: `r-${id}`, x, y, width: 120, height: 60, ...extra });

test('atlas bounds cover projects and floating items only, never the world origin or window size', () => {
  const bounds = atlasBounds([square('p', 5000, 3000)], [item('a', 5000, 3000, { projectId: 'p' }), item('f', 6400, 3100)])!;
  assert.ok(bounds.x > 4000 && bounds.y > 2000, 'origin is not included');
  assert.ok(bounds.x <= 4800 && bounds.y <= 2800);
  assert.ok(bounds.x + bounds.width >= 6460, 'floating item is included');
  assert.ok(bounds.y + bounds.height >= 3200 && bounds.y + bounds.height < 3400);
  assert.equal(atlasBounds([], []), undefined);
});

test('atlas transform fits the bounds into the map, preserves aspect and centres the short axis', () => {
  const bounds = { x: 1000, y: 0, width: 2000, height: 500 }, fit = atlasTransform(bounds, ATLAS_MAP, 4);
  assert.equal(fit.scale, (ATLAS_MAP.width - 8) / 2000);
  assert.equal(1000 * fit.scale + fit.x, 4);
  assert.ok(Math.abs((250 * fit.scale + fit.y) - ATLAS_MAP.height / 2) < 1e-9);
});

/** Card ids that show Needs me, all Asking me unless a tier is given. */
const asking = (ids: string[], tiers: Record<string, 'asking' | 'turn' | 'finished'> = {}) => new Map(ids.map(id => [id, tiers[id] ?? 'asking'] as const));

test('glyphs classify unread Needs me before working and hide done items without attention', () => {
  const needs = asking(['n', 'done-n']);
  assert.equal(atlasGlyphKind(item('n', 0, 0, { activity: 'working' }), needs), 'needs');
  assert.equal(atlasGlyphKind(item('done-n', 0, 0, { completedAt: 'x' }), needs), 'needs');
  assert.equal(atlasGlyphKind(item('w', 0, 0, { activity: 'working' }), needs), 'working');
  assert.equal(atlasGlyphKind(item('i', 0, 0), needs), 'idle');
  assert.equal(atlasGlyphKind(item('d', 0, 0, { completedAt: 'x' }), needs), undefined);
  assert.equal(atlasGlyphKind({ id: 'project', x: 0, y: 0, width: 300, height: 48 }, needs), undefined);
});

test('needs me ids use the same unread state as the Needs me list, across aliases', () => {
  const nodes = [
    { id: 'a', title: 'A', resourceId: 'r', position: { x: 0, y: 0 }, attention: 'input' },
    { id: 'alias', title: 'A', resourceId: 'r', position: { x: 0, y: 0 }, attention: 'input' },
    { id: 'seen', title: 'S', resourceId: 's', position: { x: 0, y: 0 }, attention: 'input', attentionVersion: 2, attentionSeenVersion: 2 },
  ];
  assert.deepEqual([...needsMeIds(nodes)].sort(), [['a', 'asking'], ['alias', 'asking']]);
});

test('project under the camera is the containing one, or the nearest when between projects', () => {
  const projects = [square('left', 0, 0), square('right', 2000, 0)];
  assert.deepEqual(atlasProjectAt({ x: 100, y: 50 }, projects), { id: 'left', inside: true });
  assert.deepEqual(atlasProjectAt({ x: 1500, y: 0 }, projects), { id: 'right', inside: false });
  assert.equal(atlasProjectAt({ x: 0, y: 0 }, []), undefined);
});

test('a few projects keep idle dots and separate badges', () => {
  const projects = [square('a', 0, 0, 800), square('b', 3000, 0, 800)];
  const items = [item('a1', -200, 0, { projectId: 'a' }), item('a2', 200, 0, { projectId: 'a' }), item('b1', 3000, 0, { projectId: 'b', activity: 'working' }), item('b2', 2800, 200, { projectId: 'b' })];
  const fit = atlasTransform(atlasBounds(projects, items)!, ATLAS_MAP);
  const glyphs = atlasGlyphs(items, asking(['a1', 'a2']), fit, projects.length);
  assert.deepEqual(glyphs.map(glyph => [glyph.kind, glyph.ids.join(), glyph.count]), [['idle', 'b2', 1], ['working', 'b1', 1], ['needs', 'a1', 1], ['needs', 'a2', 1]]);
  assert.ok(glyphs.every(glyph => glyph.x >= 0 && glyph.x <= ATLAS_MAP.width && glyph.y >= 0 && glyph.y <= ATLAS_MAP.height));
});

test('overlapping badges in one project collapse into one count, floating badges never do', () => {
  const projects = [square('a', 0, 0, 800), square('b', 20000, 0, 800)];
  const items = [item('a1', -20, 0, { projectId: 'a' }), item('a2', 20, 0, { projectId: 'a' }), item('a3', 0, 20, { projectId: 'a', resourceId: 'r-a1' }), item('f1', 10000, 0), item('f2', 10040, 0)];
  const fit = atlasTransform(atlasBounds(projects, items)!, ATLAS_MAP);
  const badges = atlasGlyphs(items, asking(['a1', 'a2', 'a3', 'f1', 'f2']), fit, projects.length).filter(glyph => glyph.kind === 'needs');
  assert.deepEqual(badges.map(glyph => [glyph.projectId, glyph.ids.join(), glyph.count]), [['a', 'a1,a2,a3', 2], [undefined, 'f1', 1], [undefined, 'f2', 1]]);
});

test('a merged badge takes the highest tier and counts only Asking me and My turn; Finished dots stay single', () => {
  const projects = [square('a', 0, 0, 800), square('b', 20000, 0, 800)];
  const items = [item('a1', -20, 0, { projectId: 'a' }), item('a2', 20, 0, { projectId: 'a' }), item('a3', 0, 20, { projectId: 'a' }), item('a4', 10, 10, { projectId: 'a' })];
  const fit = atlasTransform(atlasBounds(projects, items)!, ATLAS_MAP);
  const badges = atlasGlyphs(items, asking(['a1', 'a2', 'a3', 'a4'], { a1: 'turn', a3: 'finished', a4: 'finished' }), fit, projects.length).filter(glyph => glyph.kind === 'needs');
  assert.deepEqual(badges.map(glyph => [glyph.tier, glyph.ids.join(), glyph.count]), [['finished', 'a3', 1], ['finished', 'a4', 1], ['asking', 'a1,a2', 2]]);
  const many = Array.from({ length: 20 }, (_, i) => square(`p${i}`, i * 1600, 0, 900));
  const quiet = atlasGlyphs([item('x', 0, 0, { projectId: 'p0' })], asking(['x'], { x: 'finished' }), atlasTransform(atlasBounds(many, [])!, ATLAS_MAP), many.length);
  assert.deepEqual(quiet, [], 'with many projects Finished dots go where idle dots go');
});

test('thirty projects drop idle dots and collapse badges to one count per project', () => {
  const projects = Array.from({ length: 30 }, (_, i) => square(`p${i}`, (i % 6) * 1600, Math.floor(i / 6) * 1200, 900));
  const items = projects.flatMap((project, p) => Array.from({ length: 16 }, (_, i) => item(`i${p}-${i}`, project.center.x - 300 + (i % 4) * 200, project.center.y - 300 + Math.floor(i / 4) * 200,
    { projectId: project.id, activity: i === 5 ? 'working' : undefined })));
  const needs = asking(items.filter((_, i) => i % 16 === 0 || i % 16 === 15).map(entry => entry.id));
  const glyphs = atlasGlyphs(items, needs, atlasTransform(atlasBounds(projects, items)!, ATLAS_MAP), projects.length);
  assert.equal(glyphs.filter(glyph => glyph.kind === 'idle').length, 0);
  assert.equal(glyphs.filter(glyph => glyph.kind === 'working').length, 30);
  const badges = glyphs.filter(glyph => glyph.kind === 'needs');
  assert.equal(badges.length, 30); assert.ok(badges.every(badge => badge.count === 2 && badge.ids.length === 2));
});

test('dense idle dots are dropped when their median spacing falls below three pixels', () => {
  const projects = [square('a', 0, 0, 800), square('far', 40000, 0, 800)];
  const items = Array.from({ length: 40 }, (_, i) => item(`i${i}`, -300 + (i % 8) * 80, -200 + Math.floor(i / 8) * 80, { projectId: 'a' }));
  const glyphs = atlasGlyphs(items, asking([]), atlasTransform(atlasBounds(projects, items)!, ATLAS_MAP), projects.length);
  assert.equal(glyphs.length, 0);
});

test('arrow keys step spatially to the nearest project in that direction', () => {
  const projects = [square('centre', 0, 0), square('east', 2000, 100), square('far-east', 4000, 0), square('south', 100, 1800), square('north-east', 1500, -1500)];
  assert.equal(atlasStep(projects, 'centre', 'right'), 'east');
  assert.equal(atlasStep(projects, 'east', 'right'), 'far-east');
  assert.equal(atlasStep(projects, 'centre', 'down'), 'south');
  assert.equal(atlasStep(projects, 'centre', 'up'), 'north-east');
  assert.equal(atlasStep(projects, 'centre', 'left'), undefined);
});
