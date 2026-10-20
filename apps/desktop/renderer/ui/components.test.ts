import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const renderer = join(import.meta.dirname, '..');
const css = (file: string) => readFileSync(join(renderer, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = (text: string) => [...text.matchAll(/([^{}]+)\{/g)].flatMap(match => match[1].split(/,(?![^(]*\))/).map(selector => selector.trim())).filter(Boolean);

test('legacy workspace button chrome never reaches opt-in .btn buttons', () => {
  const legacy = ['styles/base.css', 'pixel-theme.css'].flatMap(file => selectors(css(file))).filter(selector => /^\.live-workspace button\b/.test(selector));
  assert.ok(legacy.length >= 5);
  for (const selector of legacy) assert.match(selector, /^\.live-workspace button:where\(:not\(\.btn\)\)/, selector);
});

test('button chrome has no :not() opt-out chains', () => {
  for (const selector of selectors(css('pixel-theme.css'))) assert.doesNotMatch(selector, /(:not\(\.[\w-]+\)){2,}/);
});

test('every Button variant and size is styled', () => {
  const components = css('styles/components.css');
  for (const variant of ['primary', 'quiet', 'icon', 'danger', 'danger-solid', 'copper']) assert.match(components, new RegExp(`\\[data-variant=${variant}\\]`), variant);
  assert.match(components, /\.btn\[data-size=sm\]/);
  assert.match(components, /\.btn\[aria-busy=true\]\s*\{[^}]*cursor: wait/);
  assert.match(components, /\.btn:disabled\s*\{[^}]*cursor: not-allowed/);
});

test('one Chip covers every tone and variant with a pixel corner', () => {
  const components = css('styles/components.css');
  for (const tone of ['ok', 'pending', 'error', 'info', 'agent']) assert.match(components, new RegExp(`\\.act-chip\\[data-tone=${tone}\\]`), tone);
  for (const variant of ['outline', 'mono']) assert.match(components, new RegExp(`\\.act-chip\\[data-variant=${variant}\\]`), variant);
  assert.doesNotMatch(components.slice(components.indexOf('.act-chip')), /border-radius:\s*999px/);
});

test('busy buttons show a stepped pixel spinner that stops under reduced motion; disabled never shows wait', () => {
  const components = css('styles/components.css'), base = css('styles/base.css');
  assert.match(components, /\[aria-busy=true\]::before\s*\{[^}]*animation: act-spin[^}]*steps\(4\)/);
  assert.match(components, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\[aria-busy=true\]::before\s*\{[^}]*animation: none/);
  assert.doesNotMatch(base, /:disabled\s*\{[^}]*cursor: wait/);
});
