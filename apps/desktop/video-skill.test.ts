import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const SCRIPT = resolve('apps/desktop/video-skill/scripts/animatic.mjs');
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/** A tools folder with everything installed and the voice model cached without its completion marker; the loader is a stub. */
function fixture(onnx: string) {
  const root = mkdtempSync(join(tmpdir(), 'video-skill-')), home = join(root, 'animatic'), bin = join(root, 'bin'), model = join(home, 'models', MODEL), downloads = join(root, 'downloads.log');
  const module = (name: string, source: string) => { mkdirSync(join(home, 'node_modules', name), { recursive: true }); writeFileSync(join(home, 'node_modules', name, 'index.js'), source); };
  mkdirSync(bin, { recursive: true }); mkdirSync(join(model, 'onnx'), { recursive: true });
  for (const tool of ['ffmpeg', 'ffprobe']) { writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, tool), 0o755); }
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "cuda=$ONNXRUNTIME_NODE_INSTALL_CUDA $@" >> ${JSON.stringify(join(root, 'npm.log'))}\n`); chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(home, 'package.json'), '{}');
  writeFileSync(join(home, 'rates.json'), JSON.stringify({ 'kokoro:': 2.5 }));
  for (const file of FILES) writeFileSync(join(model, file), file.endsWith('.onnx') ? onnx : '{}');
  module('playwright', 'module.exports = { chromium: { executablePath: () => __filename } };');
  module('shiki', 'module.exports = {};');
  module('@huggingface/transformers', 'module.exports = { env: {} };');
  module('kokoro-js', `const fs = require('node:fs'), path = require('node:path'), { env } = require('@huggingface/transformers');
const files = ${JSON.stringify(FILES)};
exports.KokoroTTS = { from_pretrained: async id => {
  const dir = path.join(env.cacheDir, id);
  if (env.allowRemoteModels) {
    fs.appendFileSync(${JSON.stringify(downloads)}, id + '\\n');
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), file.endsWith('.onnx') ? 'whole' : '{}'); }
  } else if (fs.readFileSync(path.join(dir, 'onnx/model_quantized.onnx'), 'utf8') !== 'whole') throw new Error('Protobuf parsing failed');
  return { generate: async () => ({}) };
} };`);
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--engine', 'kokoro'], { encoding: 'utf8', env: { ...process.env, ANIMATIC_HOME: home, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':') } });
  const ok = (result: ReturnType<typeof run>, status = 0) => assert.equal(result.status, status, result.stdout + result.stderr);
  return { run, ok, home, npm: () => existsSync(join(root, 'npm.log')) ? readFileSync(join(root, 'npm.log'), 'utf8').trim() : '', onnx: () => readFileSync(join(model, 'onnx/model_quantized.onnx'), 'utf8'), downloads: () => existsSync(downloads) ? readFileSync(downloads, 'utf8').trim().split('\n').length : 0, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a truncated voice model is never ready: check lists it and the agreed setup evicts and refetches it', { skip: process.platform === 'win32' }, () => {
  const { run, ok, onnx, downloads, done } = fixture('trunc');
  try {
    const before = run('check');
    ok(before, 3);
    assert.match(before.stdout, /Kokoro voice model/);
    ok(run('setup'));
    assert.equal(onnx(), 'whole');
    assert.equal(downloads(), 1);
    const after = run('check');
    ok(after);
    assert.match(after.stdout, /^Ready/);
  } finally { done(); }
});

test('setup adopts a working cached voice model without downloading it again', { skip: process.platform === 'win32' }, () => {
  const { run, ok, downloads, done } = fixture('whole');
  try {
    ok(run('setup'));
    assert.equal(downloads(), 0);
    ok(run('check'));
  } finally { done(); }
});

test('setup installs exactly the packages check listed, at their pinned versions, never the unlisted CUDA binaries', { skip: process.platform === 'win32' }, () => {
  const { run, ok, home, npm, done } = fixture('whole'), inherited = process.env.ONNXRUNTIME_NODE_INSTALL_CUDA;
  process.env.ONNXRUNTIME_NODE_INSTALL_CUDA = 'v12';
  try {
    rmSync(join(home, 'node_modules', 'shiki'), { recursive: true });
    const listed = run('check');
    ok(listed, 3);
    assert.match(listed.stdout, /Node packages shiki@\d/);
    ok(run('setup'));
    assert.match(npm(), /^cuda=skip install .*--save-exact shiki@\d+\.\d+\.\d+$/, 'only the missing package, pinned, with CUDA skipped over an inherited setting');
  } finally { if (inherited === undefined) delete process.env.ONNXRUNTIME_NODE_INSTALL_CUDA; else process.env.ONNXRUNTIME_NODE_INSTALL_CUDA = inherited; done(); }
});
