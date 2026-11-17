/**
 * Child-process probe for the inline renderer.
 *
 * `inlineNodes` recurses for emphasis. A shared /g regex made the recursive
 * call reset `lastIndex`, so the outer scan restarted forever and the renderer
 * died of heap exhaustion (the app then relaunched and crashed again). Running
 * the probe in its own process keeps a regression from hanging the test run:
 * the parent enforces a timeout.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '..', '..', 'client.js'), 'utf8');

const start = source.indexOf('const INLINE_SOURCE');
const end = source.indexOf('// Block renderers.');
if (start < 0 || end < 0) {
  console.error('inline renderer anchors missing');
  process.exit(2);
}

const sandbox = {
  h: (type, props, ...children) => ({ type, props, children }),
  React: { Fragment: 'Fragment' },
};
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end) + '\nthis.inlineNodes = inlineNodes;', sandbox);

const cases = [
  ['plain text', 'plain text'],
  ['hello **bold** world', 'hello **bold** world'],
  ['a *italic* b', 'a *italic* b'],
  ['~~struck~~', '~~struck~~'],
  ['**bold *nested* tail**', '**bold *nested* tail**'],
  ['mix **a** and *b* and `c` and [d](https://x.y)', 'mix **a** and *b* and `c` and [d](https://x.y)'],
];

const results = [];
for (const [name, input] of cases) {
  const nodes = sandbox.inlineNodes(input, 'k');
  const kinds = [];
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (value && typeof value === 'object' && value.type) {
      kinds.push(value.type);
      collect(value.children);
    }
  };
  collect(nodes);
  results.push({ name, nodes: nodes.length, kinds });
}

process.stdout.write(JSON.stringify({ results }));
