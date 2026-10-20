import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Every attention signal names its trigger's reason in Needs me. This scans the
 * shipped sources for the literals that raise attention and requires a note next
 * to each: attention.set commands, node.update/status objects with non-none
 * attention, and snapshots with an attentionReason. */
const root = join(import.meta.dirname, '..', '..');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
/** Matching brace ranges, skipping quoted text (template substitutions are code). */
function literals(text: string) {
  const ranges: [number, number][] = [], open: number[] = [], templates: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; continue; }
    if (char === '\'' || char === '"' || (char === '`') || (char === '}' && templates.at(-1) === open.length)) {
      if (char === '}') templates.pop();
      const quote = char === '}' ? '`' : char;
      for (i++; i < text.length && text[i] !== quote; i++) {
        if (text[i] === '\\') i++;
        else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') { templates.push(open.length); i++; break; }
      }
      continue;
    }
    if (char === '{') open.push(i);
    else if (char === '}' && open.length) ranges.push([open.pop()!, i]);
  }
  return ranges;
}
function violations(name: string, text: string) {
  const ranges = literals(text), found: string[] = [];
  const literal = (at: number) => {
    const [start, end] = ranges.filter(([start, end]) => start < at && at < end).sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]))[0] ?? [at, at];
    return text.slice(start, end + 1);
  };
  const report = (at: number, rule: string) => found.push(`${name}:${text.slice(0, at).split('\n').length} ${rule}`);
  for (const match of text.matchAll(/type: 'attention\.set'/g)) {
    const body = literal(match.index);
    if (!/\bnote\b/.test(body) && !/reason: null\b/.test(body)) report(match.index, 'attention.set without note');
  }
  for (const match of text.matchAll(/type: 'node\.update'/g)) {
    const body = literal(match.index), value = /[{,]\s*attention\s*(?::\s*([^,}]+))?\s*[,}]/.exec(body);
    if (value && value[1]?.trim() !== `'none'` && !/\battentionNote\b/.test(body)) report(match.index, 'node.update raises attention without attentionNote');
  }
  for (const match of text.matchAll(/[{,]\s*attention:\s*([^,}]+)/g)) {
    if (/'(input|error|review)'/.test(match[1]) && !/\battentionNote\b/.test(literal(match.index + match[0].indexOf('attention')))) report(match.index, 'attention status without attentionNote');
  }
  for (const match of text.matchAll(/[{,]\s*attentionReason\s*(?::\s*([^,}]+))?\s*[,}]/g)) {
    if (!/^(null|undefined)$/.test(match[1]?.trim() ?? '') && !/\battentionNote\b/.test(literal(match.index + match[0].indexOf('attentionReason')))) report(match.index, 'snapshot attentionReason without attentionNote');
  }
  return found;
}

test('every attention-raising literal in shipped sources carries a short note', () => {
  const files = ['src', 'packages', 'apps'].flatMap(directory => sources(join(root, directory)));
  assert.ok(files.length > 100);
  assert.deepEqual(files.flatMap(file => violations(relative(root, file), readFileSync(file, 'utf8'))), []);
});

test('the note scan flags each kind of attention without a note', () => {
  const fixtures: [string, number][] = [
    [`commands.push({ type: 'attention.set', id, source, reason: 'error' });`, 1],
    [`commands.push({ type: 'attention.set', id, source, reason: 'error', note: 'Rollout failed' });`, 0],
    [`commands.push({ type: 'attention.set', id, source, reason: null });`, 0],
    [`const next = { activity: 'idle', attention: ready ? 'none' : 'input', summary: \`\${a} {\` };`, 1],
    [`const next = { activity: 'idle', attention: ready ? 'none' : 'input', attentionNote: 'Agent waiting' };`, 0],
    [`commands.push({ type: 'node.update', id, activity, attention, summary });`, 1],
    [`commands.push({ type: 'node.update', id, activity, attention: 'none' });`, 0],
    [`return { label, attentionReason: status.reason, attentionEventId };`, 1],
    [`return { label, attentionReason: null };`, 0],
  ];
  for (const [source, expected] of fixtures) assert.equal(violations('fixture', source).length, expected, source);
});
