import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sequenceEditorRuntimePrefix } from '../src/git.js';

test('packaged Electron runs the rebase plan editor as Node, not as a second app window', () => {
  assert.equal(sequenceEditorRuntimePrefix({ node: '22.0.0', electron: '39.8.10' }), 'ELECTRON_RUN_AS_NODE=1 ');
});

test('plain Node needs no runtime override for the rebase plan editor', () => {
  assert.equal(sequenceEditorRuntimePrefix({ node: '22.0.0' }), '');
});

test('the prefix scopes the variable to the editor command only, as Git runs it through sh', () => {
  const editor = `${sequenceEditorRuntimePrefix({ electron: '39.8.10' })}'${process.execPath}' -e "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? 'unset')"`;
  const result = spawnSync('sh', ['-c', `${editor}; echo " after=\${ELECTRON_RUN_AS_NODE:-unset}"`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.stdout.trim(), '1 after=unset');
});
