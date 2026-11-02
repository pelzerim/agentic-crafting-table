/** Plain JavaScript with no imports, so the updater helper still starts after an interrupted `npm ci`. */
const release = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parse = tag => { const match = release.exec(tag ?? ''); return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined; };
const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

/** Marks a refusal in `npm run update`'s stderr. A refusal can span many lines, so a fixed tail of the output could lose its reason. */
export const UPDATE_REFUSED = 'Update refused: ';
/** What `npm run update`'s stderr says went wrong: a refusal whole, a thrown error's line without its stack, or else the end of the output. */
export function failureReason(stderr) {
  const lines = stderr.trim().split('\n'), refused = lines.findLastIndex(line => line.startsWith(UPDATE_REFUSED));
  if (refused >= 0) return lines.slice(refused).join('\n').slice(UPDATE_REFUSED.length);
  const error = lines.findLastIndex(line => /^\w*Error: /.test(line));
  return error >= 0 ? lines[error].replace(/^\w*Error: /, '') : lines.slice(-12).join('\n');
}

/** After `npm run update`: installed when the app carries the tag's version; rebuild when an earlier run left the checkout on that tag or a newer one without installing it. */
export function afterUpdate({ tag, installed, tagsAtHead }) {
  const want = parse(tag), have = parse(installed);
  if (want && have && atLeast(have, want)) return 'installed';
  return want && tagsAtHead.some(name => { const at = parse(name); return at && atLeast(at, want); }) ? 'rebuild' : 'failed';
}
