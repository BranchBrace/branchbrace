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
  // Un alias « ! » est exécuté par le sh de Git, le même qui lance GIT_SEQUENCE_EDITOR : aucun `sh` requis dans le
  // PATH (absent sous Windows hors Git Bash).
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync('git', ['-c', `alias.probe=!${editor}; echo " after=\${ELECTRON_RUN_AS_NODE:-unset}"`, 'probe'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1 after=unset');
});
