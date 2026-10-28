#!/usr/bin/env node
/** node scripts/public-safety.mjs [file …]
 * Scans the git-tracked files of this checkout (or the files named) for what must not be
 * published here: credentials, cloud account ids, personal home paths, internal hostnames,
 * real email addresses and agent session links. Exits 1 and lists every hit. CI runs it on
 * every push and pull request. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATTERNS = [
  { rule: 'credential', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws-account', pattern: /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:|\b\d{12}\.dkr\.ecr\./i },
  { rule: 'home-path', pattern: /\/(?:Users|home)\/(?!(?:example|someone|me|runner|user|…)(?:\/|\b))[A-Za-z0-9._-]+/ },
  { rule: 'internal-host', pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|intranet|lan)\b(?!\.)/i },
  { rule: 'email', pattern: /\b[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net|test|invalid)|example|test|invalid|localhost)\b)(?!users\.noreply\.github\.com\b)(?!(?:noreply|anthropic)\.[a-z.]+\b)(?!github\.com\b)(?!claude\.ai\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { rule: 'session-link', pattern: /claude\.ai\/code\/session/i },
];
/** A test's fake credential sits on a line ending in this comment; it allows no other rule. */
const FAKE_MARK = 'public-safety: fake';
const ALLOWED = [/\bi@izs\.me\b/, /\bicon_\d+x\d+@2x\.png\b/];
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|zip|gz|tgz|pdf|mp4|mov|wasm|node|sqlite)$/i;

/** Every hit in one text, with its 1-based line. */
export function scanText(text) {
  const hits = [];
  text.split('\n').forEach((raw, index) => {
    const line = ALLOWED.reduce((rest, allowed) => rest.replace(new RegExp(allowed.source, 'g'), ''), raw);
    const fake = line.includes(FAKE_MARK);
    for (const { rule, pattern } of PATTERNS) { if (fake && rule === 'credential') continue; const match = pattern.exec(line); if (match) hits.push({ rule, line: index + 1, match: match[0] }); }
  });
  return hits;
}

export function scanFiles(files) {
  const hits = [];
  for (const file of files) {
    if (BINARY.test(file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    for (const hit of scanText(readFileSync(file, 'utf8'))) hits.push({ file, ...hit });
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const named = process.argv.slice(2);
  const files = named.length ? named : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = scanFiles(files);
  for (const hit of hits) console.log(`${hit.file}:${hit.line} [${hit.rule}] ${hit.match}`);
  if (hits.length) { console.error(`public-safety: ${hits.length} hits. Remove them before committing; see AGENTS.md.`); process.exit(1); }
  console.log(`public-safety: ${files.length} files, no hits.`);
}
