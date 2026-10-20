import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalWheelLines } from './terminal-wheel.ts';

test('fractional wheel movement accumulates without reducing distance or dropping multiple lines', () => {
  const wheel = new TerminalWheelLines();
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => wheel.consume(-4, 0, 16, 40, i * 16)), [0, 0, 0, -1, 0, 0, 0, -1]);
  assert.equal(wheel.consume(-64, 0, 16, 40, 130), -4);
  assert.equal(wheel.consume(3, 1, 16, 40, 140), 3);
  assert.equal(wheel.consume(-1, 2, 16, 40, 150), -40);
});

test('direction changes, idle gaps and mode resets discard stale fractions', () => {
  const wheel = new TerminalWheelLines();
  wheel.consume(-12, 0, 16, 40, 0);
  assert.equal(wheel.consume(8, 0, 16, 40, 20), 0);
  assert.equal(wheel.consume(8, 0, 16, 40, 40), 1);
  wheel.consume(12, 0, 16, 40, 60);
  assert.equal(wheel.consume(4, 0, 16, 40, 500), 0);
  wheel.reset();
  assert.equal(wheel.consume(12, 0, 16, 40, 520), 0);
});

test('font size determines pixel distance, and huge/invalid events remain bounded', () => {
  const wheel = new TerminalWheelLines();
  assert.equal(wheel.consume(64, 0, 32, 30, 0), 2);
  assert.equal(wheel.consume(1e9, 0, 32, 30, 10), 30);
  assert.equal(wheel.consume(-1e9, 1, 32, 30, 20), -30);
  assert.equal(wheel.consume(NaN, 0, 32, 30, 30), 0);
  assert.equal(wheel.consume(10, 0, 0, 30, 40), 0);
});
