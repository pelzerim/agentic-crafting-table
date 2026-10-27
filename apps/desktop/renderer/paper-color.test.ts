import test from 'node:test';
import assert from 'node:assert/strict';
import { paperPaint } from './paper-color.ts';

test('a named paper is drawn in its token, a custom #rrggbb as it is; slate and dark custom papers take light ink', () => {
  assert.deepEqual(paperPaint('sky'), { color: 'var(--act-paper-sky)', dark: false });
  assert.deepEqual(paperPaint('moss'), { color: 'var(--act-paper-moss)', dark: false });
  assert.deepEqual(paperPaint('slate'), { color: 'var(--act-paper-slate)', dark: true });
  assert.deepEqual(paperPaint('#F2C4CC'), { color: '#f2c4cc', dark: false });
  assert.deepEqual(paperPaint('#24387a'), { color: '#24387a', dark: true });
  for (const unknown of [undefined, '', 'yellow', '#abc']) assert.deepEqual(paperPaint(unknown), { color: 'var(--act-paper-mint)', dark: false }, String(unknown));
});
