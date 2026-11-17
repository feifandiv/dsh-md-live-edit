/**
 * Locale regression: the body must resolve its labels against the registered
 * dictionary, not freeze raw keys at apply time.
 *
 * The 1.0.2 build built `labels` before `locale.register` ran, so the preview
 * showed `mode.edit`, `edit.save`, `edit.cancel`, … instead of translations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '..', 'client.js'), 'utf8');

/** Render the registered body with a locale service that actually translates. */
function renderBody(text) {
  const dictionaries = {};
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'fragment',
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  };

  let Body;
  const locale = {
    bind: (ns) => (key) => (dictionaries[ns] ? dictionaries[ns][key] : key),
    register: (ns, dicts) => {
      dictionaries[ns] = dicts.zh;
      return () => {};
    },
  };

  const registration = { id: undefined, factory: undefined };
  const windowStub = { __ModuleLoader__: { load: (r) => Object.assign(registration, r) } };
  new Function('window', 'require', source)(windowStub, (name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });
  const plugin = registration.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });

  plugin.apply({
    locale,
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, component) => { Body = component; return () => {}; },
    },
    effect: (fn) => fn(),
    remote: { workspaceFiles: {} },
  });
  assert.equal(typeof Body, 'function', 'body component must be registered');

  return Body({
    resourceAddress: 'dsh-resource://file/session/test/notes.md',
    content: { kind: 'text', text, eof: true },
  });
}

/** Every string leaf in the rendered tree. */
function stringsOf(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const child of node) stringsOf(child, out); return out; }
  if (node && typeof node === 'object' && node.children) stringsOf(node.children, out);
  return out;
}

test('renders translated labels instead of raw locale keys', () => {
  const tree = renderBody('普通段落');
  const strings = stringsOf(tree);

  assert.ok(strings.includes('可编辑'), 'status chip must read 可编辑, got ' + JSON.stringify(strings.slice(0, 12)));
  const rawKeys = strings.filter((s) => /^(?:edit|status|mode|hint|viewer)\.[a-zA-Z]+$/.test(s));
  assert.deepEqual(rawKeys, [], 'raw locale keys leaked into the UI: ' + rawKeys.join(', '));
});

test('survives a document with emphasis and lists without leaking keys', () => {
  const tree = renderBody('# 标题\n\n- **列表**\n');
  const strings = stringsOf(tree);
  assert.ok(strings.includes('可编辑'));
  assert.equal(strings.filter((s) => s === 'edit.save').length, 0);
});
