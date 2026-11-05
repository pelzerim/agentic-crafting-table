import test from 'node:test';
import assert from 'node:assert/strict';
import { aimsAtSubmenu } from './menu-aim.ts';

const leftSubmenu = { left: 320, top: 340, right: 540, bottom: 440 }, rightSubmenu = { left: 760, top: 340, right: 980, bottom: 440 };

test('a pointer moving diagonally toward a submenu on the left is heading for it, across the rows on the way', () => {
  const from = { x: 600, y: 362 };
  assert.equal(aimsAtSubmenu(from, { x: 580, y: 372 }, leftSubmenu), true);
  assert.equal(aimsAtSubmenu(from, { x: 560, y: 400 }, leftSubmenu), true);
  assert.equal(aimsAtSubmenu(from, { x: 560, y: 345 }, leftSubmenu), true);
});

test('a pointer moving down the menu, or away from the submenu, is choosing another row', () => {
  const from = { x: 600, y: 362 };
  assert.equal(aimsAtSubmenu(from, { x: 598, y: 400 }, leftSubmenu), false, 'straight down the menu');
  assert.equal(aimsAtSubmenu(from, { x: 620, y: 372 }, leftSubmenu), false, 'away from it');
  assert.equal(aimsAtSubmenu(from, { x: 580, y: 480 }, leftSubmenu), false, 'below the submenu');
});

test('the same holds for a submenu on the right', () => {
  const from = { x: 700, y: 362 };
  assert.equal(aimsAtSubmenu(from, { x: 720, y: 390 }, rightSubmenu), true);
  assert.equal(aimsAtSubmenu(from, { x: 680, y: 390 }, rightSubmenu), false);
  assert.equal(aimsAtSubmenu(from, { x: 702, y: 420 }, rightSubmenu), false);
});
