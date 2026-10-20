import test from 'node:test';
import assert from 'node:assert/strict';
import { titleLines } from './title-fit.ts';

test('a title takes the lines left under the card’s last row', () => {
  assert.equal(titleLines({ title: 34, label: 34, heading: 34, rowsBottom: 83, contentBottom: 120 }, 17), 4);
  assert.equal(titleLines({ title: 34, label: 34, heading: 34, rowsBottom: 47, contentBottom: 72 }, 17), 3);
});

test('room inside a taller heading counts, so a fixed-height row gives its title every line it holds', () => {
  assert.equal(titleLines({ title: 30, label: 30, heading: 54, rowsBottom: 63, contentBottom: 63 }, 15), 3);
  assert.equal(titleLines({ title: 45, label: 45, heading: 54, rowsBottom: 63, contentBottom: 63 }, 15), 3);
});

test('the count does not depend on how many lines the title shows now', () => {
  const card = (lines: number) => ({ title: lines * 17, label: lines * 17, heading: lines * 17, rowsBottom: 13 + lines * 17 + 18, contentBottom: 120 });
  assert.deepEqual([2, 3, 4].map(lines => titleLines(card(lines), 17)), [5, 5, 5]);
});

test('a full or overflowing card keeps the stylesheet’s two lines', () => {
  assert.equal(titleLines({ title: 30, label: 30, heading: 30, rowsBottom: 39, contentBottom: 39 }, 15), 2);
  assert.equal(titleLines({ title: 34, label: 34, heading: 34, rowsBottom: 90, contentBottom: 72 }, 17), 2);
  assert.equal(titleLines({ title: 15, label: 15, heading: 15, rowsBottom: 20, contentBottom: 20 }, 15, 1), 1);
});

test('half-pixel layout still counts a line that fits', () => {
  assert.equal(titleLines({ title: 34, label: 34, heading: 34, rowsBottom: 50.6, contentBottom: 67 }, 17), 2);
  assert.equal(titleLines({ title: 34, label: 34, heading: 34, rowsBottom: 50, contentBottom: 66.6 }, 17), 3);
  assert.equal(titleLines({ title: 34, label: 34, heading: 34, rowsBottom: 0, contentBottom: 0 }, 0), 2);
});
