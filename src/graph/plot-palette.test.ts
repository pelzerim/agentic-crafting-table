import test from 'node:test';
import assert from 'node:assert/strict';
import { PLOT_PALETTES, plotPalette, plotSwatch, signTone } from './plot-palette.ts';
import { PLOT_COLORS } from './plots.ts';
import { PROJECT_COLORS } from './project-colors.ts';

const named = (color: string) => plotPalette(color).map(swatch => [swatch.name, swatch.color]);

test('each neighborhood preset has its own six plot colors, in slot order', () => {
  assert.deepEqual(Object.keys(PLOT_PALETTES), PROJECT_COLORS.map(preset => preset.id));
  assert.deepEqual(named('#91b78b'), [['Buttercup', '#f2c94c'], ['Daisy', '#f6f6ee'], ['Fern', '#4f8a52'], ['Bluebell', '#8fa8e8'], ['Bark', '#a07a4a'], ['Sage', '#c4dcb4']]);
  assert.deepEqual(named('#b8945f'), [['Moss', '#8fa868'], ['Acorn', '#c27a3a'], ['Pine', '#3f6f3a'], ['Birch', '#f4ece0'], ['Toadstool', '#c8473c'], ['Honey', '#e6c27e']]);
  assert.deepEqual(named('#9a9a9a'), [['Quartz', '#f0f0f0'], ['Slate', '#6f8296'], ['Lichen', '#a8b878'], ['Iron', '#d9a987'], ['Flint', '#4a4a52'], ['Granite', '#c8a8a0']]);
  assert.deepEqual(named('#6fd6cf'), [['Snow', '#ffffff'], ['Glacier', '#3fa9a2'], ['Aurora', '#b8a0f0'], ['Fox', '#f0a03c'], ['Fjord', '#3f6f9a'], ['Frost', '#c9f2ee']]);
  assert.deepEqual(named('#5b7fd6'), [['Foam', '#dce6fb'], ['Lagoon', '#6fd6cf'], ['Coral', '#f08aa8'], ['Kelp', '#5fae6a'], ['Sandbar', '#e8d8a8'], ['Abyss', '#24387a']]);
  assert.deepEqual(named('#a884d8'), [['Crystal', '#ecdcfd'], ['Violet', '#7a52b4'], ['Rose quartz', '#f0a8c8'], ['Citrine', '#f0d878'], ['Obsidian', '#2e2442'], ['Opal', '#a8e0e0']]);
  assert.deepEqual(named('#d0564c'), [['Sandstone', '#ecd2ac'], ['Ochre', '#e09a4f'], ['Rust', '#8a3a2e'], ['Sagebrush', '#9aa878'], ['Bone', '#f6efe4'], ['Mesa', '#d97a6a']]);
  assert.deepEqual(named('#e3c55a'), [['Dune', '#f8f0d8'], ['Cactus', '#5f9a54'], ['Terracotta', '#c8623f'], ['Turquoise', '#4fb6b0'], ['Dusk', '#b88ab8'], ['Driftwood', '#9a7a4a']]);
  assert.deepEqual(named('#63a99c'), [['Lily', '#a8dc7a'], ['Murk', '#2f6a64'], ['Reed', '#d4c47a'], ['Mud', '#6a4a32'], ['Bloom', '#ec9cc4'], ['Mist', '#d6ece4']]);
  assert.deepEqual(named('#9a4e4e'), [['Lava', '#ff9a3a'], ['Ember', '#ffd45a'], ['Ash', '#8a7a78'], ['Soul', '#6fe3e6'], ['Crimson', '#d8303a'], ['Bone', '#eee2cc']]);
  assert.deepEqual(plotPalette('#91b78b').map(swatch => swatch.slot), [...PLOT_COLORS], 'the stored ids are the slots');
  assert.deepEqual(named('#E3C55A'), named('#e3c55a'), 'a preset matches in any case');
  assert.deepEqual(named('not a color'), named('#91b78b'), 'an invalid color is the default neighborhood');
  assert.deepEqual(plotSwatch('#e3c55a', 'sky'), { slot: 'sky', name: 'Cactus', color: '#5f9a54', tone: '#8bbb82' });
});

test('a custom neighborhood color fans its hue out, lifted to stay visible, each named for its hue', () => {
  assert.deepEqual(named('#3366cc'), [['Sky', '#64bbd8'], ['Blue', '#6e64d8'], ['Teal', '#64d8bb'], ['Violet', '#a864d8'], ['Green', '#64d877'], ['Magenta', '#d864c5']]);
  assert.deepEqual(named('#808080'), [['Rose', '#ca7297'], ['Orange', '#ca9772'], ['Magenta', '#ca72c2'], ['Yellow', '#cac272'], ['Violet', '#9e72ca'], ['Lime', '#9eca72']], 'grey takes the saturation floor');
  assert.deepEqual(named('#ffeeee'), [['Rose', '#ff7ab2'], ['Orange', '#ffb27a'], ['Magenta', '#ff7af4'], ['Yellow', '#fff47a'], ['Violet', '#bd7aff'], ['Lime', '#bdff7a']], 'lightness is capped');
  for (const color of ['#000000', '#ffffff', '#123456', '#fedcba', '#e3c55b']) assert.equal(new Set(plotPalette(color).map(swatch => swatch.name)).size, 6, `${color}: six different names`);
});

test('a dark slot color is lifted for the sign bar and sprout; a light one is kept', () => {
  assert.equal(signTone('#3f6f3a'), '#85bc80');
  assert.equal(signTone('#2e2442'), '#9582bb');
  assert.equal(signTone('#24387a'), '#6982d3');
  assert.equal(signTone('#2f6a64'), '#79c3bc');
  assert.equal(signTone('#6a4a32'), '#c1997b');
  assert.equal(signTone('#f2c94c'), '#f2c94c');
  assert.equal(signTone('#7a52b4'), '#7a52b4', 'at lightness .5 or more the color stays');
  assert.deepEqual(plotPalette('#5b7fd6').map(swatch => swatch.tone), ['#dce6fb', '#6fd6cf', '#f08aa8', '#5fae6a', '#e8d8a8', '#6982d3']);
});
