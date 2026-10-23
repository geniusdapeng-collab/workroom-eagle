import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyRuntimeTree, verifyPortableRuntimeTree } from './portable-runtime-copy.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eagle-portable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(join(source, '.bin'), { recursive: true });
  mkdirSync(join(source, 'tool'));
  writeFileSync(join(source, 'tool/cli.mjs'), 'console.log("portable-entry-ok")\n');
  symlinkSync('../tool/cli.mjs', join(source, '.bin/tool'));
  return { root, source, output: join(root, 'payload') };
}

test('default recursive copy reproduces the build-machine link and gate rejects it', (t) => {
  const f = fixture(t);
  cpSync(f.source, f.output, { recursive: true, dereference: false });
  assert.equal(readlinkSync(join(f.output, '.bin/tool')), realpathSync(join(f.source, 'tool/cli.mjs')));
  assert.throws(() => verifyPortableRuntimeTree(f.output), /绝对符号链接/);
});

test('relative executable survives source relocation and archive extraction', (t) => {
  const f = fixture(t);
  copyRuntimeTree(f.source, f.output);
  assert.equal(readlinkSync(join(f.output, '.bin/tool')), '../tool/cli.mjs');
  assert.deepEqual(verifyPortableRuntimeTree(f.output), { files: 1, symlinks: 1, absoluteOrExternalSymlinks: 0 });
  const archive = join(f.root, 'payload.tar');
  execFileSync('tar', ['-cf', archive, '-C', f.output, '.']);
  renameSync(f.source, join(f.root, 'source-no-longer-at-build-path'));
  renameSync(f.output, join(f.root, 'original-payload'));
  mkdirSync(f.output);
  execFileSync('tar', ['-xf', archive, '-C', f.output]);
  verifyPortableRuntimeTree(f.output);
  assert.equal(execFileSync(process.execPath, [join(f.output, '.bin/tool')], { encoding: 'utf8' }).trim(), 'portable-entry-ok');
});

for (const kind of ['external-relative', 'dangling', 'cycle', 'absolute-internal']) {
  test(`archive gate rejects ${kind} links`, (t) => {
    const f = fixture(t);
    copyRuntimeTree(f.source, f.output);
    const target = kind === 'external-relative' ? '../source/tool/cli.mjs'
      : kind === 'dangling' ? 'missing' : kind === 'cycle' ? 'invalid' : join(f.output, 'tool/cli.mjs');
    symlinkSync(target, join(f.output, 'invalid'));
    assert.throws(() => verifyPortableRuntimeTree(f.output), /运行载荷/);
  });
}

test('empty tree is valid; missing root and unsupported inputs fail', (t) => {
  const f = fixture(t);
  mkdirSync(f.output);
  assert.deepEqual(verifyPortableRuntimeTree(f.output), { files: 0, symlinks: 0, absoluteOrExternalSymlinks: 0 });
  assert.throws(() => verifyPortableRuntimeTree(join(f.root, 'absent')));
  assert.throws(() => copyRuntimeTree(join(f.root, 'absent'), f.output));
});
