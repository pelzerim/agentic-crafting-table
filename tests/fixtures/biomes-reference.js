/* The biome design reference as drawn: 12 px cells in 2 px units. biomes.test.ts evaluates this script and compares
 * the production grounds, flat colours, sprites and hash with it at half the scale. */
const MAP = '#101713', G = 12, U = 2;
const imul = Math.imul;
function hash(x, y, s = 0) { let n = imul(x | 0, 374761393) ^ imul(y | 0, 668265263) ^ imul(s | 0, 1274126177); n = imul(n ^ (n >>> 13), 1103515245); n ^= n >>> 16; return (n >>> 0) / 4294967296; }
function noise(x, y, s) { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi; const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s); const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy; }
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => { const p = rgb(a), q = rgb(b); return '#' + p.map((v, i) => Math.round(v + (q[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const shade = (hex, by) => by >= 0 ? mix(hex, '#ffffff', by) : mix(hex, '#000000', -by);
const box = (c, color, x, y, w, h) => { c.fillStyle = color; c.fillRect(x, y, w, h); };
function sprite(c, s, x, y, scale = U, flip = false) {
  const w = s.rows[0].length;
  s.rows.forEach((row, j) => { for (let i = 0; i < w; i++) { const ch = row[flip ? w - 1 - i : i]; if (ch !== '.') box(c, s.pal[ch], x + i * scale, y + j * scale, scale, scale); } });
}
const specks = (c, x, y, i, j, seed, count, colors, w, h) => { for (let k = 0; k < count; k++) { const a = hash(i, j, seed + k * 3), b = hash(i, j, seed + k * 3 + 1); box(c, colors[Math.floor(hash(i, j, seed + k * 3 + 2) * colors.length)], x + Math.floor(a * (G - w) / U) * U, y + Math.floor(b * (G - h) / U) * U, w, h); } };

const S = (rows, pal) => ({ rows, pal });
const ANIMALS = {
  sheep: { gait: 'walk', s: S(['..wwwww..', '.wwwwwwwk', '.wwwwwwkk', '.wwwwwww.', '..l...l..'], { w: '#dff3e4', k: '#33423a', l: '#33423a' }) },
  fox: { gait: 'walk', s: S(['.......o.o', 'w.....oooo', 'wooooooook', '.oooooooo.', '..l....l..'], { o: '#e0813a', w: '#f4ece0', k: '#2e2a26', l: '#5a3a22' }) },
  goat: { gait: 'walk', s: S(['.......h.h', '..gggggggg', '.ggggggggk', '.gggggggw.', '..l....l..'], { g: '#cfd2d2', h: '#8b7b62', k: '#3a3a3a', w: '#f1f1f1', l: '#4a4a4a' }) },
  penguin: { gait: 'walk', s: S(['.kkk.', 'kkwko', 'kwwwk', 'kwwwk', '.kwk.', '.o.o.'], { k: '#232a33', w: '#f3f7f8', o: '#f0a03c' }) },
  duck: { gait: 'swim', s: S(['.....gg.', '.....gky', 'bbbbbgg.', 'wbbbbbb.', '.wwwww..'], { g: '#2f7d4f', k: '#16201a', y: '#f2c94c', b: '#8a6a4a', w: '#e9e2d4' }) },
  bat: { gait: 'fly', s: S(['k.....k', 'kk.k.kk', 'kkkpkkk', '.k.k.k.'], { k: '#2a2036', p: '#f0a8e0' }) },
  armadillo: { gait: 'walk', s: S(['..bbbbb..', '.bdbdbdbp', 'pbdbdbdbk', '.l.....l.'], { b: '#b98a6a', d: '#8f6248', p: '#e8b8a0', k: '#3a2a22', l: '#6a4636' }) },
  camel: { gait: 'walk', s: S(['...ss...ss', '..ssss..sk', '.ssssssss.', '.sssssss..', '.l.....l..', '.l.....l..'], { s: '#c99a52', k: '#3a2a16', l: '#8f6a34' }) },
  frog: { gait: 'hop', s: S(['.g...g.', 'gkgggkg', 'ggggggg', 'gg.g.gg'], { g: '#7ccf5a', k: '#16201a' }) },
  strider: { gait: 'walk', s: S(['.rrrrr.', 'rkrrrkr', 'rrrrrrr', '.l...l.', '.l...l.'], { r: '#c8473c', k: '#2a1414', l: '#7a2a26' }) },
};

const BIOMES = [
  { id: 'grass', name: 'Grassland', preset: 'Grass', base: '#91b78b', animal: 'sheep',
    says: { Ground: 'Short blades in two greens', Growth: 'Tufts, daisies, low bushes', Weather: 'Butterflies', Animal: 'Sheep' },
    ground(c, x, y, i, j) { box(c, shade('#91b78b', (hash(i, j, 1) - .5) * .1), x, y, G, G); specks(c, x, y, i, j, 5, 3, ['#7da877', '#a9cba1'], 2, 4); },
    props: [S(['g.g.g', '.ggg.'], { g: '#5f9458' }), S(['.w.', 'wyw', '.w.', '.g.'], { w: '#f6f6ee', y: '#f2c94c', g: '#5f9458' }), S(['.ddd.', 'dDdDd', 'ddddd'], { d: '#5f9458', D: '#7fb376' })],
    weather: { kind: 'drift', n: 4, colors: ['#fff6c8', '#ffffff'], w: 2, h: 2, vx: 10, vy: 0, wobble: 8, blink: 7 } },
  { id: 'oak', flat: '#a58f5c', name: 'Woodland', preset: 'Oak planks', base: '#b8945f', animal: 'fox',
    says: { Ground: 'Leaf litter with moss patches', Growth: 'Trees, mushrooms, logs', Weather: 'Falling leaves', Animal: 'Fox' },
    ground(c, x, y, i, j) { const moss = noise(i / 2.2, j / 2.2, 3) > .6; box(c, shade(moss ? '#8fa868' : '#a98a58', (hash(i, j, 1) - .5) * .12), x, y, G, G); specks(c, x, y, i, j, 5, 3, moss ? ['#7b9656'] : ['#cfa35e', '#8a6c3e', '#c27a3a'], 2, 2); },
    props: [S(['.ddd.', 'dDDdd', 'dDdDd', 'ddDdd', '.ddd.'], { d: '#3f6f3a', D: '#5d9150' }), S(['.ddd.', 'dDDdd', 'dDdDd', 'ddDdd', '.ddd.'], { d: '#4d7a3a', D: '#79a84f' }), S(['.rrr.', 'rwrwr', '..s..'], { r: '#c8473c', w: '#f4ece0', s: '#e9dcc4' }), S(['bbbbb', 'bBBBo'], { b: '#6a4a2a', B: '#8a6436', o: '#d6b77e' })],
    weather: { kind: 'drift', n: 9, colors: ['#d98a3a', '#c2582e', '#e3b54a'], w: 2, h: 2, vx: 7, vy: 11, wobble: 5 } },
  { id: 'stone', name: 'Mountain', preset: 'Stone', base: '#9a9a9a', animal: 'goat',
    says: { Ground: 'Rock slabs with cracks', Growth: 'Boulders, coal and iron specks', Weather: 'Thin mist', Animal: 'Goat' },
    ground(c, x, y, i, j) { box(c, shade('#9a9a9a', (hash(i, j, 1) - .5) * .18), x, y, G, G); if (hash(i, j, 2) < .32) { box(c, '#7c7c7c', x + 2, y + 4, 6, U); box(c, '#7c7c7c', x + 6, y + 4, U, 6); } specks(c, x, y, i, j, 5, 1, ['#b6b6b6'], 2, 2); },
    props: [S(['.ggg.', 'gGGgg', 'ggGgd', '.ddd.'], { g: '#b9b9b9', G: '#d2d2d2', d: '#767676' }), S(['k.k', '.k.', 'k..'], { k: '#2e2e2e' }), S(['o.o', '.o.'], { o: '#d9a987' })],
    weather: { kind: 'drift', n: 6, colors: ['#e6e9e8'], w: 8, h: 2, vx: 5, vy: 0, wobble: 2, alpha: .35 } },
  { id: 'diamond', flat: '#a9e0db', name: 'Tundra', preset: 'Diamond', base: '#6fd6cf', animal: 'penguin',
    says: { Ground: 'Ice sheets and snow patches', Growth: 'Ice spikes, snow piles, a snowman', Weather: 'Snowfall', Animal: 'Penguin' },
    ground(c, x, y, i, j) { const snow = noise(i / 2.4, j / 2.4, 3) > .5; box(c, snow ? shade('#e6f3f2', (hash(i, j, 1) - .5) * .06) : shade('#8adbd5', (hash(i, j, 1) - .5) * .12), x, y, G, G); if (!snow && hash(i, j, 2) < .5) { box(c, '#c9f2ee', x + 2, y + 6, U, U); box(c, '#c9f2ee', x + 4, y + 4, U, U); box(c, '#c9f2ee', x + 6, y + 2, U, U); } if (snow) specks(c, x, y, i, j, 5, 1, ['#c7e2e4'], 2, 2); },
    props: [S(['..w..', '..c..', '.wc..', '.cCc.', 'cCCCc'], { w: '#ffffff', c: '#a8ece6', C: '#5cc4bd' }), S(['.www.', 'wwwww'], { w: '#ffffff' }), S(['.ww.', '.wo.', 'wwww', 'wkww'], { w: '#ffffff', o: '#f0a03c', k: '#33423a' })],
    weather: { kind: 'drift', n: 30, colors: ['#ffffff'], w: 2, h: 2, vx: 3, vy: 16, wobble: 4 } },
  { id: 'lapis', name: 'Ocean', preset: 'Lapis', base: '#5b7fd6', animal: 'duck',
    says: { Ground: 'Deep and shallow water, wave lines', Growth: 'Lily pads, rocks, coral', Weather: 'Glints on the waves', Animal: 'Duck' },
    ground(c, x, y, i, j) { box(c, shade('#5b7fd6', (noise(i / 3, j / 3, 3) - .55) * .34), x, y, G, G); if (hash(i, j, 2) < .6) box(c, '#86a4ec', x + (j % 2 ? 0 : 4), y + 4 + (hash(i, j, 4) < .5 ? 0 : 4), 6, U); },
    props: [S(['.ggg.', 'ggggg', 'gg.gg'], { g: '#5fae6a' }), S(['.ggg.', 'gGGgd'], { g: '#9aa3ad', G: '#c2c9d0', d: '#6a727c' }), S(['p.p', 'ppp', '.p.'], { p: '#f08aa8' })],
    weather: { kind: 'twinkle', n: 26, colors: ['#d8e6ff'], w: 6, h: 2, speed: 1.6 } },
  { id: 'amethyst', flat: '#7558a4', name: 'Geode', preset: 'Amethyst', base: '#a884d8', animal: 'bat',
    says: { Ground: 'Dark rock with crystal facets', Growth: 'Crystal clusters', Weather: 'Sparkles', Animal: 'Bat' },
    ground(c, x, y, i, j) { box(c, mix('#a884d8', '#2b1f47', .38 + hash(i, j, 1) * .2), x, y, G, G); if (hash(i, j, 2) < .45) { box(c, '#c3a4ee', x + 4, y + 2, U, U); box(c, '#c3a4ee', x + 2, y + 4, 6, U); box(c, '#8b68c2', x + 4, y + 6, U, U); } },
    props: [S(['..p..', '.pPp.', '.pPp.', 'pPwPp'], { p: '#b78fe8', P: '#dcc4fa', w: '#ffffff' }), S(['.p.', 'pPp', 'pPp'], { p: '#9a72d4', P: '#dcc4fa' })],
    weather: { kind: 'twinkle', n: 16, colors: ['#ffffff', '#f6c8ff'], w: 2, h: 2, speed: 2.4, cross: true } },
  { id: 'redstone', flat: '#c96a48', name: 'Badlands', preset: 'Redstone', base: '#d0564c', animal: 'armadillo',
    says: { Ground: 'Terracotta strata in bands', Growth: 'Dead bushes, redstone torches', Weather: 'Redstone dust pulsing', Animal: 'Armadillo' },
    ground(c, x, y, i, j) { const band = (j + Math.floor(noise(i / 3, j / 6, 3) * 3)) % 6; box(c, shade(['#c8623f', '#d98a4f', '#e2c29c', '#b9523f', '#a5503e', '#d0564c'][band], (hash(i, j, 1) - .5) * .06), x, y, G, G); },
    props: [S(['b.b.b', '.bbb.', '..b..'], { b: '#6a4636' }), S(['r', 'b', 'b'], { r: '#ff5a4a', b: '#6a4636' }), S(['b.b', '.b.'], { b: '#7a3a30' })],
    weather: { kind: 'twinkle', n: 10, colors: ['#ff6a58'], w: 2, h: 2, speed: 1.2 } },
  { id: 'gold', name: 'Desert', preset: 'Gold', base: '#e3c55a', animal: 'camel',
    says: { Ground: 'Sand with dune ripples', Growth: 'Cacti, dead bushes, bones', Weather: 'Blowing sand, a tumbleweed', Animal: 'Camel' },
    ground(c, x, y, i, j) { box(c, shade('#e3c55a', (noise(i / 4, j / 2, 3) - .5) * .16), x, y, G, G); if ((i + j) % 2 === 0) { box(c, '#cfae48', x + 2, y + 8, 4, U); box(c, '#cfae48', x + 6, y + 6, 4, U); } },
    props: [S(['..g..', 'g.g.g', 'ggggg', '..g..', '..g..'], { g: '#5f9a54' }), S(['b.b.b', '.bbb.', '..b..'], { b: '#8a6a3a' }), S(['w.w', '.w.', 'w.w'], { w: '#f4ecd8' })],
    weather: { kind: 'drift', n: 12, colors: ['#f6e7a8'], w: 4, h: 2, vx: 34, vy: 2, wobble: 2, tumble: true } },
  { id: 'prismarine', flat: '#63a391', name: 'Swamp', preset: 'Prismarine', base: '#63a99c', animal: 'frog',
    says: { Ground: 'Murky water between moss banks', Growth: 'Reeds, lily pads, roots', Weather: 'Fireflies', Animal: 'Frog' },
    ground(c, x, y, i, j) { const n = noise(i / 2.6, j / 2.6, 3); box(c, shade(n > .56 ? '#84ad6c' : n > .4 ? '#63a99c' : '#3f7f78', (hash(i, j, 1) - .5) * .1), x, y, G, G); specks(c, x, y, i, j, 5, 2, n > .56 ? ['#6b9458'] : ['#57998c'], 2, 2); },
    props: [S(['b.b', 'b.b', 'g.g', 'g.g'], { b: '#6a4a2a', g: '#4f8a52' }), S(['.ggg.', 'ggggg', 'gg.gg'], { g: '#9fd37a' }), S(['.bb.', 'b..b', 'b..b'], { b: '#5a4030' })],
    weather: { kind: 'twinkle', n: 12, colors: ['#e8ff8a'], w: 2, h: 2, speed: 1.4, roam: 10 } },
  { id: 'netherrack', flat: '#8f4a48', name: 'Nether', preset: 'Netherrack', base: '#9a4e4e', animal: 'strider',
    says: { Ground: 'Netherrack with lava seams', Growth: 'Lava pools, fire, soul torches', Weather: 'Rising embers', Animal: 'Strider' },
    ground(c, x, y, i, j) { const lava = noise(i / 2.2, j / 2.2, 3) > .68; box(c, lava ? '#e8862e' : shade('#8a4444', (hash(i, j, 1) - .5) * .16), x, y, G, G); specks(c, x, y, i, j, 5, 2, lava ? ['#ffd45a'] : ['#6a3034', '#a85a56'], 2, 2); },
    props: [S(['.oyo.', 'oyYyo', '.oyo.'], { o: '#e8862e', y: '#ffd45a', Y: '#fff2a8' }), S(['.y.', 'yoy', 'oro'], { y: '#ffd45a', o: '#e8862e', r: '#c8473c' }), S(['c', 'b', 'b'], { c: '#6fe3e6', b: '#3a2a26' })],
    weather: { kind: 'drift', n: 18, colors: ['#ffb24a', '#ffe08a'], w: 2, h: 2, vx: 2, vy: -18, wobble: 5 } },
];
