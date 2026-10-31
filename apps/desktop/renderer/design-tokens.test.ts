import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const tokensFile = 'apps/desktop/renderer/tokens.css';
const debt: Record<string, Record<string, number>> = JSON.parse(readFileSync(join(import.meta.dirname, 'design-token-debt.json'), 'utf8'));

function cssFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}
const files = [...cssFiles('apps/desktop/renderer'), ...cssFiles('src/resource-plugins')].filter(file => file !== tokensFile).sort();
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, 'url()');
const source = (file: string) => strip(readFileSync(join(root, file), 'utf8'));
const normalise = (hex: string) => { const digits = hex.slice(1).toLowerCase(); return '#' + (digits.length <= 4 ? [...digits].map(digit => digit + digit).join('') : digits); };

function hexLiterals(css: string) {
  const counts: Record<string, number> = {};
  for (const [literal] of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (![4, 5, 7, 9].includes(literal.length)) continue;
    const hex = normalise(literal);
    counts[hex] = (counts[hex] ?? 0) + 1;
  }
  return counts;
}

function rules(css: string) {
  const found: { selector: string; body: string }[] = [];
  const walk = (text: string) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf('{', index);
      if (open < 0) return;
      let depth = 1, close = open + 1;
      for (; close < text.length && depth; close++) depth += text[close] === '{' ? 1 : text[close] === '}' ? -1 : 0;
      const prelude = text.slice(index, open).trim(), body = text.slice(open + 1, close - 1);
      if (prelude.startsWith('@')) walk(body);
      else found.push({ selector: prelude, body });
      index = close;
    }
  };
  walk(css);
  return found;
}

const declares = (body: string, property: RegExp) => body.split(';').some(declaration => {
  const [name, value = ''] = declaration.split(':');
  return property.test(name.trim()) && !/^(none|0)$/.test(value.trim());
});
const removesOutline = (body: string) => body.split(';').some(declaration => {
  const [property, value = ''] = declaration.split(':');
  return property.trim() === 'outline' && /^(none|0)$/.test(value.trim());
});

test('colours come from tokens.css: files add no hex literals beyond the recorded debt', () => {
  const added: string[] = [];
  for (const file of files) {
    const allowed = debt[file] ?? {};
    for (const [hex, count] of Object.entries(hexLiterals(source(file)))) {
      if (count > (allowed[hex] ?? 0)) added.push(`${file}: ${hex} ×${count - (allowed[hex] ?? 0)}`);
    }
  }
  assert.deepEqual(added, [], 'Use a --act-* token from apps/desktop/renderer/tokens.css (add a role there if none fits) instead of a new hex literal. See docs/design-tokens.md.');
});

test('outline is only removed where the same control draws a visible replacement', () => {
  const bare: string[] = [];
  for (const file of files) {
    const found = rules(source(file));
    for (const { selector, body } of found) {
      if (!removesOutline(body)) continue;
      if (declares(body, /^(box-shadow|border-image|border-image-source)$/)) continue;
      const bases = selector.split(',').map(part => part.trim().replace(/:(focus-visible|focus-within|focus|hover)\b/g, ''));
      const replaced = bases.every(base => found.some(other => other.selector.split(',').some(part => {
        const candidate = part.trim();
        return candidate.startsWith(base) && /:focus(-visible|-within)?\b/.test(candidate.slice(base.length))
          && (declares(other.body, /^(box-shadow|border-image|border-image-source)$/) || (declares(other.body, /^outline$/) && !removesOutline(other.body)));
      })));
      if (!replaced) bare.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(bare, [], 'A rule that sets outline: none/0 must draw a focus replacement (outline, box-shadow or border-image) with var(--act-focus) on the same control.');
});

const LIGHT = ':root[data-theme="light"]';
/** Custom properties declared directly in the first top-level `selector` rule of `css`. */
function declared(css: string, selector: string) {
  const values = new Map<string, string>();
  const rule = rules(css).find(found => found.selector === selector);
  for (const declaration of rule?.body.split(';') ?? []) {
    const colon = declaration.indexOf(':'); const name = declaration.slice(0, colon).trim();
    if (name.startsWith('--')) values.set(name, declaration.slice(colon + 1).trim());
  }
  return values;
}

test('the light theme redeclares every colour token whose dark value is a literal, and nothing else', () => {
  const css = source(tokensFile), dark = declared(css, ':root'), light = declared(css, LIGHT);
  const literal = [...dark].filter(([, value]) => /#[0-9a-fA-F]{3,8}\b/.test(value)).map(([name]) => name);
  assert.deepEqual(literal.filter(name => !light.has(name)), [], `Give each colour token a light value in the ${LIGHT} rule of tokens.css.`);
  assert.deepEqual([...light.keys()].filter(name => !dark.has(name)), [], 'The light block only overrides tokens the dark :root declares.');
});

test('the hex guard reads literals, not encoded data URIs or comments', () => {
  assert.deepEqual(hexLiterals(strip('a{color:#ABC;background:url("data:%23fff")}/* #123456 */')), { '#aabbcc': 1 });
  assert.deepEqual(rules('@media (x){a:focus{outline:0}}b{color:red}').map(rule => rule.selector), ['a:focus', 'b']);
});
