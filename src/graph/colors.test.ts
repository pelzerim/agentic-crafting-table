import test from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_PAD_HUES, COLOR_PAD_SHADES, RECENT_COLORS_MAX, colorPadCell, colorPadColor, isHexColor, isLightColor, parseHexColor, withRecentColor } from './colors.ts';

test('a typed colour is read as #rrggbb in lower case, with or without # and in the short form', () => {
  assert.equal(parseHexColor('#3366CC'), '#3366cc');
  assert.equal(parseHexColor('  3366cc '), '#3366cc');
  assert.equal(parseHexColor('#36c'), '#3366cc');
  assert.equal(parseHexColor('f0a'), '#ff00aa');
  for (const text of ['', '#', '#12345', '#1234567', '#ggg000', 'red', 'rgb(1,2,3)', '##123456']) assert.equal(parseHexColor(text), undefined, text);
  assert.equal(isHexColor('#a1b2c3'), true);
  assert.equal(isHexColor('#A1B2C3'), true);
  for (const value of ['#abc', 'a1b2c3', 'mint', undefined, 3, null]) assert.equal(isHexColor(value), false, String(value));
});

test('the custom pad is 12 hues across and 8 shades down, lightest on top, each cell one stable colour', () => {
  assert.deepEqual([COLOR_PAD_HUES, COLOR_PAD_SHADES], [12, 8]);
  assert.equal(colorPadColor(0, 0), '#f3cece');
  assert.equal(colorPadColor(4, 3), '#54d454');
  assert.equal(colorPadColor(8, 7), '#121249');
  const all = Array.from({ length: COLOR_PAD_HUES * COLOR_PAD_SHADES }, (_, index) => colorPadColor(index % COLOR_PAD_HUES, Math.floor(index / COLOR_PAD_HUES)));
  assert.equal(new Set(all).size, all.length, 'no two cells share a colour');
  assert.ok(all.every(isHexColor));
  for (let hue = 0; hue < COLOR_PAD_HUES; hue++) for (let shade = 0; shade < COLOR_PAD_SHADES; shade++) assert.deepEqual(colorPadCell(colorPadColor(hue, shade)), { hue, shade }, `${hue},${shade}`);
  assert.deepEqual(colorPadCell('#ffffff'), { hue: 0, shade: 0 }, 'white is nearest the top row');
  assert.deepEqual(colorPadCell('#000000'), { hue: 0, shade: 7 }, 'black is nearest the bottom row');
  assert.deepEqual(colorPadCell('#3366cc'), { hue: 7, shade: 4 });
  assert.equal(colorPadColor(12, 0), colorPadColor(0, 0), 'hue wraps around');
  assert.equal(colorPadColor(0, 9), colorPadColor(0, 7), 'shade is held within the pad');
});

test('Your colours keeps the eight newest custom colours, newest first, each once', () => {
  assert.equal(RECENT_COLORS_MAX, 8);
  assert.deepEqual(withRecentColor([], '#3366CC'), ['#3366cc']);
  assert.deepEqual(withRecentColor(['#111111', '#222222', '#333333'], '#222222'), ['#222222', '#111111', '#333333'], 'a repeated colour moves to the front');
  const full = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007', '#000008'];
  assert.deepEqual(withRecentColor(full, '#00000a'), ['#00000a', ...full.slice(0, 7)]);
  assert.deepEqual(withRecentColor(['#111111'], 'mint'), ['#111111'], 'only #rrggbb is remembered');
});

test('a colour is light when dark ink reads better on it than light ink', () => {
  for (const color of ['#ffffff', '#c9e8d2', '#f2c94c', '#91b78b', '#6fd6cf']) assert.equal(isLightColor(color), true, color);
  for (const color of ['#000000', '#24322a', '#24387a', '#7a52b4', '#8a3a2e']) assert.equal(isLightColor(color), false, color);
});
