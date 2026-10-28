/** Plain JavaScript with no imports, so the updater helper still starts after an interrupted `npm ci`. */
const release = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parse = tag => { const match = release.exec(tag ?? ''); return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined; };
const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

/** After `npm run update`: installed when the app carries the tag's version; rebuild when an earlier run left the checkout on that tag or a newer one without installing it. */
export function afterUpdate({ tag, installed, tagsAtHead }) {
  const want = parse(tag), have = parse(installed);
  if (want && have && atLeast(have, want)) return 'installed';
  return want && tagsAtHead.some(name => { const at = parse(name); return at && atLeast(at, want); }) ? 'rebuild' : 'failed';
}
