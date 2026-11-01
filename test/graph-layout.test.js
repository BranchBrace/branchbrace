import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { layoutGraph } from '../src/graph-layout.js';
import { GitService } from '../src/git.js';

const commit = (hash, ...parents) => ({ hash, parents });
const has = (row, from, to) => row.segments.some((segment) => segment.from.join() === from.join() && segment.to.join() === to.join());

test('a linear history stays in a single lane', () => {
  const { rows, width } = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')]);
  assert.deepEqual(rows.map((row) => row.column), [0, 0, 0]);
  assert.equal(width, 1);
  assert.ok(has(rows[1], [0, 'top'], [0, 'mid']) && has(rows[1], [0, 'mid'], [0, 'bottom']));
  assert.ok(!rows[2].segments.some((segment) => segment.to[1] === 'bottom'), 'the root commit has no outgoing line');
});

test('a merge opens a lane for its second parent and the fork closes it', () => {
  // m merges feature (f) into main (b); both branch from a.
  const { rows, width } = layoutGraph([commit('m', 'b', 'f'), commit('f', 'a'), commit('b', 'a'), commit('a')]);
  const [m, f, b, a] = rows;
  assert.equal(width, 2);
  assert.equal(m.column, 0);
  assert.ok(has(m, [0, 'mid'], [1, 'bottom']), 'merge edge goes to the second-parent lane');
  assert.equal(f.column, 1);
  assert.ok(has(f, [0, 'top'], [0, 'mid']) && has(f, [0, 'mid'], [0, 'bottom']), 'main passes through the feature row');
  assert.equal(b.column, 0);
  assert.equal(a.column, 0);
  assert.ok(has(a, [1, 'top'], [0, 'mid']), 'the feature lane converges into the fork point');
});

test('independent branch tips get distinct lanes and freed lanes are reused', () => {
  const { rows } = layoutGraph([commit('x', 'a'), commit('y', 'a'), commit('a', 'r'), commit('z', 'r'), commit('r')]);
  assert.deepEqual(rows.map((row) => row.column), [0, 1, 0, 1, 0]);
});

test('graph() lists every branch with decorations and excludes recovery refs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchbrace-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.invalid');
  await writeFile(path.join(root, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '--quiet', '-m', 'base');
  git('tag', 'v1');
  git('switch', '--quiet', '-c', 'feature');
  await writeFile(path.join(root, 'b.txt'), 'b\n'); git('add', '.'); git('commit', '--quiet', '-m', 'feature work');
  git('switch', '--quiet', 'main');
  git('update-ref', 'refs/branchbrace/recovery/test', 'HEAD');

  const service = new GitService(root);
  await service.verifyRepository();
  const graph = await service.graph();
  assert.equal(graph.head, git('rev-parse', 'HEAD'));
  assert.deepEqual(graph.commits.map((item) => item.subject), ['feature work', 'base']);
  const base = graph.commits[1];
  assert.deepEqual(base.refs.map((ref) => `${ref.type}:${ref.name}:${ref.head}`).sort(), ['local:main:true', 'tag:v1:false']);
  assert.equal(base.author, 'Ada Lovelace');

  const details = await service.commitDetails(graph.commits[0].hash);
  assert.deepEqual(details.files, [{ status: 'A', originalPath: null, path: 'b.txt', binary: false, additions: 1, deletions: 0 }]);
  assert.match(await service.commitFileDiff(graph.commits[0].hash, 'b.txt'), /\+b/);

  // Un renommage suivi d'un ajout : les statistiques doivent rester alignées sur le bon fichier.
  git('mv', 'a.txt', 'renamed.txt');
  await writeFile(path.join(root, 'c.txt'), 'c1\nc2\n'); git('add', '.'); git('commit', '--quiet', '-m', 'rename');
  const renamed = await service.commitDetails(git('rev-parse', 'HEAD'));
  assert.deepEqual(renamed.files.map(({ status, originalPath, path: file, additions, deletions }) => [status, originalPath, file, additions, deletions]), [['A', null, 'c.txt', 2, 0], ['R', 'a.txt', 'renamed.txt', 0, 0]]);
});

test('references(), stageAll() and createBranch() at a start point', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchbrace-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.invalid');
  await writeFile(path.join(root, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('tag', '-a', 'v1', '-m', 'annotated');
  await writeFile(path.join(root, 'a.txt'), 'b\n'); git('commit', '--quiet', '-am', 'second');

  const service = new GitService(root);
  await service.verifyRepository();
  await service.createBranch('from-base', base.slice(0, 7));
  assert.equal(git('branch', '--show-current'), 'main', 'creating at a start point does not switch branch');
  const refs = await service.references();
  assert.deepEqual(refs.local.map(({ name, current, hash }) => [name, current, hash === base]), [['from-base', false, true], ['main', true, false]]);
  assert.deepEqual(refs.tags, [{ name: 'v1', hash: base }], 'annotated tags resolve to their commit');

  await writeFile(path.join(root, 'a.txt'), 'c\n');
  await writeFile(path.join(root, 'new.txt'), 'n\n');
  assert.ok((await service.stageAll()).files.every((file) => file.staged));
  assert.ok((await service.unstageAll()).files.every((file) => !file.staged));
});

test('the status --branch header gives the branch and its upstream in a single Git call', async () => {
  const { parseBranchHeader } = await import('../src/git.js');
  assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 1, behind 2]'), { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2 });
  assert.deepEqual(parseBranchHeader('## feature/x'), { branch: 'feature/x', upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader('## topic...origin/topic [gone]'), { branch: 'topic', upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader('## HEAD (no branch)'), { branch: '(HEAD détachée)', upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader('## No commits yet on main'), { branch: 'main', upstream: null, ahead: 0, behind: 0 });
});
