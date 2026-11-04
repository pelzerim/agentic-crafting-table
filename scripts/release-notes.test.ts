import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from './release-notes.mjs';

const changelog = `# Changelog

Intro.

## Unreleased

### Map
- Not yet.

## 0.16.0 — 2026-11-02

### Map
- **Find an item**: ⌘F.

## 0.15.0 — 2026-11-02

### Platform
- **Windows**: no console. (#14, @someone)
`;

test(`the notes are the version's changelog section, then how to open the downloads`, () => {
  const notes = releaseNotes(changelog, '0.16.0');
  assert.ok(notes.startsWith('### Map\n- **Find an item**: ⌘F.\n'), notes);
  assert.ok(!notes.includes('0.15.0') && !notes.includes('Not yet'), notes);
  assert.match(notes, /xattr -dr com\.apple\.quarantine/);
  assert.match(notes, /SmartScreen/);
});

test('a version the changelog does not name, or names without entries, is refused', () => {
  assert.throws(() => releaseNotes(changelog, '0.17.0'), /no section for 0\.17\.0/);
  assert.throws(() => releaseNotes('## 0.17.0 — 2026-11-03\n\n## 0.16.0\n- x\n', '0.17.0'), /no entries for 0\.17\.0/);
});
