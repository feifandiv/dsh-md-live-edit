/**
 * Regression tests for the inline renderer.
 *
 * The 1.0.0/1.0.1 release shared one global /g regex across the recursive
 * emphasis call, so the recursive call reset `lastIndex` and the outer scan
 * restarted forever: rendering a document with `**bold**`, `*italic*`, or
 * `~~strike~~` exhausted the renderer heap and crashed the app on open.
 *
 * The probe runs in a child process with a watchdog: a reintroduced loop fails
 * the test instead of hanging it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, 'helpers', 'inline-probe.mjs');

test('inline rendering terminates on emphasis instead of looping forever', () => {
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 6000 });
  assert.equal(run.error, undefined,
    'probe did not finish: the inline renderer loops on emphasis again (' + (run.error && run.error.code) + ')');
  assert.equal(run.status, 0, run.stderr || 'probe failed');

  const { results } = JSON.parse(run.stdout);
  const kindsOf = (name) => results.find((r) => r.name === name).kinds;

  assert.deepEqual(kindsOf('plain text'), []);
  assert.deepEqual(kindsOf('hello **bold** world'), ['strong']);
  assert.deepEqual(kindsOf('a *italic* b'), ['em']);
  assert.deepEqual(kindsOf('~~struck~~'), ['s']);
  assert.deepEqual(kindsOf('**bold *nested* tail**'), ['strong', 'em']);
  assert.deepEqual(kindsOf('mix **a** and *b* and `c` and [d](https://x.y)'), ['strong', 'em', 'code', 'a']);
});

test('every emphasis case keeps surrounding text', () => {
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 6000 });
  assert.equal(run.status, 0, run.stderr || 'probe failed');
  const { results } = JSON.parse(run.stdout);
  for (const row of results) {
    assert.ok(row.nodes >= 1, row.name + ' produced no nodes');
    assert.ok(row.nodes < 50, row.name + ' produced suspiciously many nodes: ' + row.nodes);
  }
});
