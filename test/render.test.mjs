/** Exercise the registered document body, including its recursive renderer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function loadBody() {
  const sandbox = vm.createContext({});
  vm.runInContext(`
    const react = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: 'fragment',
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useCallback: (fn) => fn,
    };
    const window = { __ModuleLoader__: { load: (registration) => {
      const plugin = registration.factory((name) => {
        if (name === 'react') return react;
        throw new Error('unexpected require: ' + name);
      });
      plugin.apply({
        locale: { bind: () => (key) => key, register: () => () => {} },
        documentPreviews: { register: () => () => {} },
        slots: {
          inject: (_name, callback) => callback(),
          register: (_options, component) => { globalThis.Body = component; return () => {}; },
        },
        effect: (fn) => fn(),
        remote: { workspaceFiles: {} },
      });
    } } };
  `, sandbox);
  vm.runInContext(source, sandbox, { timeout: 1000 });
  return (text) => {
    sandbox.input = text;
    // A regression must fail promptly instead of hanging the test process or
    // allocating until V8 runs out of memory, as the original renderer did.
    return vm.runInContext(`Body({
      resourceAddress: 'dsh-resource://file/session/test/notes.md',
      content: { kind: 'text', text: input, eof: true },
    })`, sandbox, { timeout: 1000 });
  };
}

function documentTree(tree) {
  return tree.children.find((node) => node?.props?.className === 'mdle-doc');
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return node?.children ? textOf(node.children) : '';
}

function nodesOfType(node, type) {
  if (Array.isArray(node)) return node.flatMap((child) => nodesOfType(child, type));
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...nodesOfType(node.children, type)];
}

for (const [markdown, type, visible] of [
  ['**粗体**', 'strong', '粗体'],
  ['*斜体*', 'em', '斜体'],
  ['_斜体_', 'em', '斜体'],
  ['~~删除线~~', 's', '删除线'],
]) {
  test(`renders ${markdown} once and terminates`, () => {
    const doc = documentTree(loadBody()(markdown));
    assert.equal(textOf(doc), visible);
    assert.equal(nodesOfType(doc, type).length, 1);
  });
}

test('nested and adjacent formatting preserves the parent match position', () => {
  const render = loadBody();
  for (let i = 0; i < 3; i++) {
    const doc = documentTree(render('前 **粗体 _斜体_** 中 ~~删去 *词*~~ 后 **第二处**'));
    assert.equal(textOf(doc), '前 粗体 斜体 中 删去 词 后 第二处');
    assert.equal(nodesOfType(doc, 'strong').length, 2);
    assert.equal(nodesOfType(doc, 'em').length, 2);
    assert.equal(nodesOfType(doc, 's').length, 1);
  }
});

test('all inline-rendering block types can contain formatting', () => {
  const render = loadBody();
  for (const markdown of [
    '# **标题**',
    '> **引用**',
    '- **列表**\n- *第二项*',
    '| **列名** |\n| --- |\n| ~~单元格~~ |',
  ]) {
    const doc = documentTree(render(markdown));
    assert.equal(nodesOfType(doc, 'strong').length, 1);
  }
});

test('plain text, code, links and images keep their rendering', () => {
  const doc = documentTree(loadBody()('普通 `code` [链接](https://example.com) ![图片](image.png)'));
  assert.equal(textOf(doc), '普通 code 链接 ');
  assert.equal(nodesOfType(doc, 'code').length, 1);
  assert.equal(nodesOfType(doc, 'a')[0].props.href, 'https://example.com');
  assert.equal(nodesOfType(doc, 'img')[0].props.src, 'image.png');
});

test('a document with many formatted paragraphs completes without duplicates', () => {
  const paragraph = '正文 **粗体 _嵌套_** 和 ~~删除线~~';
  const doc = documentTree(loadBody()(Array(1000).fill(paragraph).join('\n\n')));
  assert.equal(nodesOfType(doc, 'strong').length, 1000);
  assert.equal(nodesOfType(doc, 's').length, 1000);
});
