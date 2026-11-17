/**
 * Client-half tests: module identity, registration metadata, and the pure
 * Markdown text transforms the in-place editor relies on.
 *
 * Run with: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Load client.js with a stubbed module loader, returning its registration. */
function loadRegistration() {
  let registration;
  const react = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  };
  const requireStub = (name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  };
  const windowStub = { __ModuleLoader__: { load: (r) => { registration = r; } } };
  new Function('window', 'require', source)(windowStub, requireStub);
  assert.ok(registration, 'client half must register with __ModuleLoader__');
  return { registration, requireStub };
}

/** Slice the pure text-transform region out of client.js and evaluate it. */
function loadTextOps() {
  const start = source.indexOf('function isFenceStart');
  const endMarker = '// #endregion mdle-text-ops';
  const end = source.indexOf(endMarker);
  assert.ok(start > 0 && end > start, 'text-ops region markers must exist');
  const code = source.slice(start, end + endMarker.length);
  const sandbox = {};
  vm.runInNewContext(
    code + '\nthis.parseMarkdown = parseMarkdown; this.rebuildText = rebuildText;'
      + ' this.blockSpans = blockSpans; this.replaceBlockText = replaceBlockText;'
      + ' this.insertBlockText = insertBlockText;',
    sandbox,
  );
  return sandbox;
}

const { registration, requireStub } = loadRegistration();
const plugin = registration.factory(requireStub);
const ops = loadTextOps();

test('client module id equals the package name', () => {
  assert.equal(registration.id, pkg.name,
    'the web module system keys factories by package name; a mismatch fails to register');
});

test('apply() registers locale, preview metadata, and the keyed body slot', () => {
  const calls = {};
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => { calls.locale = { ns, dicts }; return () => {}; },
    },
    documentPreviews: { register: (d) => { calls.preview = d; return () => {}; } },
    slots: {
      inject: (name, cb) => { calls.injected = name; cb(); return () => {}; },
      register: (options, component) => { calls.slot = { options, component }; return () => {}; },
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    remote: { workspaceFiles: { read: async () => ({ ok: true, value: { offset: 1, lines: 0, text: '', eof: true } }) } },
  };

  plugin.apply(ctx);

  assert.deepEqual(plugin.inject, ['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles']);
  assert.equal(calls.locale.ns, 'mdLiveEdit');
  assert.ok(calls.locale.dicts.en && calls.locale.dicts.zh, 'both baseline locales are required');

  assert.equal(calls.preview.id, pkg.name + '/markdown');
  assert.deepEqual(calls.preview.extensions, ['md', 'markdown']);
  assert.equal(calls.preview.priority, 'extension', 'must outrank the builtin read-only renderer');
  assert.equal(calls.preview.loading, 'text-pages');
  assert.equal(typeof calls.preview.title(), 'string');

  assert.equal(calls.injected, 'sidebar.right.tab.document');
  assert.equal(calls.slot.options.name, 'sidebar.right.tab.document');
  assert.equal(calls.slot.options.key, calls.preview.id, 'slot key must equal the implementation id');
  assert.equal(typeof calls.slot.component, 'function');
});

test('parser round-trips documents byte for byte', () => {
  const samples = [
    '# Title\n\nHello **world** and *you*.\n',
    '---\ntitle: test\ntags: [a, b]\n---\n\n# Hi\n\nBody text.\n',
    '# Hi\n\ntext\n## Sub\n\n- a\n- b\n  - nested\n\n1. one\n2. two\n\n> quote\n> more\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nafter hr\n',
    'Setext title\n============\n\nSetext sub\n----------\n\npara\n',
    'no trailing newline',
    'a\n\n\n\nb\n',
    '- item with continuation\n  second line\n- other\n\ntext\n',
    'text with `code` and [link](https://x.com) and ![img](y.png)\n',
    '',
  ];
  for (const sample of samples) {
    assert.equal(ops.rebuildText(ops.parseMarkdown(sample)), sample, 'roundtrip failed for ' + JSON.stringify(sample));
  }
});

test('block spans map each block back to its exact source slice', () => {
  const sample = '# A\n\nBody **x**\n\n- one\n- two\n';
  const blocks = ops.parseMarkdown(sample);
  const spans = ops.blockSpans(blocks);
  assert.equal(spans.length, blocks.length);
  for (let i = 0; i < blocks.length; i += 1) {
    assert.equal(sample.slice(spans[i].start, spans[i].end), blocks[i].source);
  }
});

test('editing one block leaves every other byte untouched', () => {
  const text = '# Title\n\nBody **x**.\n\n- a\n';
  const blocks = ops.parseMarkdown(text);
  assert.equal(ops.replaceBlockText(text, blocks, 0, '# New Title'), '# New Title\n\nBody **x**.\n\n- a\n');
  assert.equal(
    ops.replaceBlockText(text, blocks, 2, 'Body changed.\n\nExtra para.'),
    '# Title\n\nBody changed.\n\nExtra para.\n\n- a\n',
  );
});

test('deleting a block collapses the blank line it leaves behind', () => {
  const text = '# Title\n\nBody\n';
  const blocks = ops.parseMarkdown(text);
  assert.equal(ops.replaceBlockText(text, blocks, 0, ''), 'Body\n');
  assert.equal(ops.replaceBlockText(text, blocks, 2, ''), '# Title\n\n');
  assert.equal(ops.replaceBlockText('only line', ops.parseMarkdown('only line'), 0, ''), '');
});

test('an out-of-range block index reports no change', () => {
  assert.equal(ops.replaceBlockText('x', ops.parseMarkdown('x'), 99, 'y'), null);
});

test('inserting a block keeps blank-line separation', () => {
  const text = '# A\n\nBody\n';
  const blocks = ops.parseMarkdown(text);
  assert.equal(ops.insertBlockText(text, blocks, 2, 'New'), '# A\n\nNew\n\nBody\n');
  assert.equal(ops.insertBlockText(text, blocks, 0, 'First'), 'First\n\n# A\n\nBody\n');
  assert.equal(ops.insertBlockText(text, blocks, blocks.length, 'Tail'), '# A\n\nBody\n\nTail');
  assert.equal(ops.insertBlockText('', ops.parseMarkdown(''), 0, 'First'), 'First');
});

test('insert then parse yields a standalone paragraph', () => {
  const text = '# A\n\nBody\n';
  const next = ops.insertBlockText(text, ops.parseMarkdown(text), 2, 'New');
  const types = ops.parseMarkdown(next).map((b) => b.type);
  assert.deepEqual(Array.from(types), ['heading', 'blank', 'paragraph', 'blank', 'paragraph', 'blank']);
});
