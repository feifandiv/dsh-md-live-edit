/**
 * Client half of the Markdown live-edit bundle.
 *
 * Registers a Markdown preview implementation that renders the document as
 * blocks and edits each block in place: click a block, edit its source in an
 * inline editor, and the complete document is written back through the Host
 * half's authenticated endpoint. No code mode.
 *
 * Important: the module id below must equal the package name in package.json,
 * because the web module system keys factories by the boot-graph entry id.
 */
window.__ModuleLoader__.load({
  id: '@fanfan4589/dsh-md-live-edit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    /** Implementation id; also the keyed slot key the owner dispatches. */
    const BODY_ID = '@fanfan4589/dsh-md-live-edit/markdown';
    const NS = 'mdLiveEdit';
    const WRITE_ROUTE = '/dsh-md-live-edit/api/write';
    const FILE_PREFIX = 'dsh-resource://file/';
    /** Page budget for completing a document that arrived partially loaded. */
    const MAX_FOLLOW_PAGES = 200;

    // ---------------------------------------------------------------------
    // File address grammar (mirrors dsh-util-workspace-path).
    // ---------------------------------------------------------------------
    function parseFileAddress(address) {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const rest = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end);
        const slash = rest.indexOf('/');
        if (slash === -1) return undefined;
        if (rest.slice(0, slash) !== 'session') return undefined;
        const body = rest.slice(slash + 1);
        const first = body.indexOf('/');
        if (first === -1) return undefined;
        const sessionId = body.slice(0, first);
        const path = body.slice(first + 1);
        if (!sessionId || !path) return undefined;
        return {
          sessionId: decodeURIComponent(sessionId),
          path: path.split('/').map(decodeURIComponent).join('/'),
        };
      } catch {
        return undefined;
      }
    }

    // ---------------------------------------------------------------------
    // Markdown block parser. Every block keeps its exact source lines so the
    // document rebuilds byte-for-byte when one block changes.
    // ---------------------------------------------------------------------
    function isFenceStart(line) {
      const m = /^ {0,3}(```+|~~~+)/.exec(line);
      return m ? m[1] : undefined;
    }
    function isFenceEnd(line, fence) {
      const ch = fence[0];
      const re = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
      return re.test(line);
    }
    function isAtx(line) { return /^ {0,3}#{1,6}(\s|$)/.test(line); }
    function isHr(line) { return /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line); }
    function isBlank(line) { return /^\s*$/.test(line); }
    function isQuote(line) { return /^ {0,3}>/.test(line); }
    function isListItem(line) { return /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)/.test(line); }
    function listIndentOf(line) {
      const m = /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)/.exec(line);
      return m ? m[1].replace(/\t/g, '  ').length : 0;
    }
    function isTableDelimiter(line) {
      return /^\s*\|?[\s\-:|]+\|?\s*$/.test(line) && line.includes('-');
    }
    function looksTableRow(line) { return line.includes('|') && !isBlank(line); }
    function isSetext1(line) { return /^ {0,3}=+\s*$/.test(line); }
    function isSetext2(line) { return /^ {0,3}-+\s*$/.test(line); }
    function splitFrontmatter(lines) {
      if (lines.length < 3 || lines[0].trim() !== '---') return undefined;
      for (let i = 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '---' || t === '...') return { end: i };
      }
      return undefined;
    }

    function parseMarkdown(text) {
      const lines = String(text).split('\n');
      const blocks = [];
      const fm = splitFrontmatter(lines);
      let cursor = 0;
      if (fm) {
        blocks.push({ type: 'frontmatter', lines: lines.slice(0, fm.end + 1) });
        cursor = fm.end + 1;
        if (cursor < lines.length && isBlank(lines[cursor])) {
          blocks.push({ type: 'blank', lines: [lines[cursor]] });
          cursor += 1;
        }
      }
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (isBlank(line)) {
          const start = cursor;
          while (cursor < lines.length && isBlank(lines[cursor])) cursor++;
          blocks.push({ type: 'blank', lines: lines.slice(start, cursor) });
          continue;
        }
        const fence = isFenceStart(line);
        if (fence) {
          const start = cursor;
          cursor++;
          while (cursor < lines.length) {
            if (isFenceEnd(lines[cursor], fence)) { cursor++; break; }
            cursor++;
          }
          blocks.push({
            type: 'code',
            lines: lines.slice(start, cursor),
            language: /^ {0,3}(?:```+|~~~+)(.*)$/.exec(line)[1].trim(),
          });
          continue;
        }
        if (isAtx(line)) {
          blocks.push({ type: 'heading', level: /^ {0,3}(#{1,6})/.exec(line)[1].length, lines: [line] });
          cursor++;
          continue;
        }
        if (isHr(line)) { blocks.push({ type: 'hr', lines: [line] }); cursor++; continue; }
        if (looksTableRow(line) && cursor + 1 < lines.length && isTableDelimiter(lines[cursor + 1])) {
          const start = cursor;
          cursor += 2;
          while (cursor < lines.length && looksTableRow(lines[cursor]) && !isBlank(lines[cursor])) cursor++;
          blocks.push({ type: 'table', lines: lines.slice(start, cursor) });
          continue;
        }
        if (isQuote(line)) {
          const start = cursor;
          while (cursor < lines.length && (isQuote(lines[cursor]) ||
            (isBlank(lines[cursor]) && cursor + 1 < lines.length && isQuote(lines[cursor + 1])))) cursor++;
          blocks.push({ type: 'quote', lines: lines.slice(start, cursor) });
          continue;
        }
        if (isListItem(line)) {
          const start = cursor;
          cursor++;
          while (cursor < lines.length) {
            const l = lines[cursor];
            if (isBlank(l)) {
              let peek = cursor + 1;
              while (peek < lines.length && isBlank(lines[peek])) peek++;
              if (peek < lines.length && (isListItem(lines[peek]) || /^\s{1,}\S/.test(lines[peek]))) {
                cursor = peek;
                continue;
              }
              break;
            }
            if (isListItem(l)) { cursor++; continue; }
            if (/^\s+\S/.test(l) && !isAtx(l) && !isQuote(l)) { cursor++; continue; }
            break;
          }
          blocks.push({ type: 'list', lines: lines.slice(start, cursor) });
          continue;
        }
        const start = cursor;
        cursor++;
        while (cursor < lines.length) {
          const l = lines[cursor];
          if (isBlank(l)) break;
          if (isAtx(l) || isHr(l) || isQuote(l) || isListItem(l) || isFenceStart(l)) break;
          if (looksTableRow(l) && cursor + 1 < lines.length && isTableDelimiter(lines[cursor + 1])) break;
          if (isSetext1(l) || isSetext2(l)) { cursor++; break; }
          cursor++;
        }
        const para = lines.slice(start, cursor);
        const last = para[para.length - 1];
        const kind = isSetext1(last) ? { type: 'heading', level: 1 }
          : isSetext2(last) ? { type: 'heading', level: 2 }
            : { type: 'paragraph' };
        blocks.push({ ...kind, lines: para });
      }
      return blocks.map((b) => ({ ...b, source: b.lines.join('\n') }));
    }

    function rebuildText(blocks) {
      return blocks.map((b) => b.source).join('\n');
    }

    /** Character spans of each block inside the joined document text. */
    function blockSpans(blocks) {
      let offset = 0;
      return blocks.map((b) => {
        const span = { start: offset, end: offset + b.source.length };
        offset = span.end + 1;
        return span;
      });
    }

    // #region mdle-text-ops
    /**
     * Replace one block's source, or delete it when the source is empty.
     * A deletion also consumes the adjacent separator and collapses a blank
     * neighbour, so removing a paragraph does not leave a doubled blank line.
     * @param text - complete document text.
     * @param blocks - the parsed blocks `text` came from.
     * @param index - block index to replace.
     * @param source - new block source; empty deletes the block.
     * @returns the next document text, or null when the index is out of range.
     */
    function replaceBlockText(text, blocks, index, source) {
      const spans = blockSpans(blocks);
      const span = spans[index];
      if (!span) return null;
      if (source !== '') return text.slice(0, span.start) + source + text.slice(span.end);
      let startCut = span.start;
      let endCut = span.end;
      if (endCut + 1 <= text.length) endCut += 1;
      else if (startCut > 0) startCut -= 1;
      const previousBlank = index === 0 || (blocks[index - 1] && blocks[index - 1].type === 'blank');
      const following = blocks[index + 1];
      if (previousBlank && following && following.type === 'blank' && spans[index + 1]) {
        const blank = spans[index + 1];
        endCut = blank.end + 1 <= text.length ? blank.end + 1 : blank.end;
      }
      return text.slice(0, startCut) + text.slice(endCut);
    }

    /**
     * Insert one block at a boundary, separated by blank lines so the new text
     * becomes its own paragraph instead of merging into a neighbour.
     * @param text - complete document text.
     * @param blocks - the parsed blocks `text` came from.
     * @param index - boundary index; equal to the block count appends.
     * @param source - block source to insert.
     * @returns the next document text.
     */
    function insertBlockText(text, blocks, index, source) {
      const spans = blockSpans(blocks);
      const at = index < spans.length ? spans[index].start : text.length;
      const before = text.slice(0, at);
      const after = text.slice(at);
      const lead = before === '' || before.endsWith('\n\n')
        ? ''
        : before.endsWith('\n') ? '\n' : '\n\n';
      const trail = after === '' || after.startsWith('\n\n')
        ? ''
        : after.startsWith('\n') ? '\n' : '\n\n';
      return before + lead + source + trail + after;
    }
    // #endregion mdle-text-ops

    // ---------------------------------------------------------------------
    // Inline renderer: images, links, code, bold, strike, italic.
    // ---------------------------------------------------------------------
    // Inline syntax source. The RegExp is built per call: `inlineNodes` recurses
    // for emphasis, and a shared /g instance would have its `lastIndex` reset by
    // the recursive call, restarting the outer scan forever (renderer OOM crash).
    const INLINE_SOURCE = '(!\\[([^\\]]*)\\]\\(([^)\\s]+)\\))|(\\[([^\\]]+)\\]\\(([^)\\s]+)\\))|(`([^`]+)`)|(\\*\\*(.+?)\\*\\*)|(~~(.+?)~~)|(\\*([^*]+)\\*)|(_([^_]+)_)';
    /** Bounds recursion for adversarial emphasis nesting. */
    const MAX_INLINE_DEPTH = 24;

    function inlineNodes(text, keyPrefix, depth = 0) {
      const out = [];
      if (depth > MAX_INLINE_DEPTH) { out.push(text); return out; }
      const rx = new RegExp(INLINE_SOURCE, 'g');
      let last = 0;
      let k = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1] !== undefined) {
          out.push(h('img', { key: keyPrefix + k++, src: m[3], alt: m[2], className: 'mdle-img' }));
        } else if (m[4] !== undefined) {
          out.push(h('a', { key: keyPrefix + k++, href: m[6], target: '_blank', rel: 'noreferrer' }, m[5]));
        } else if (m[7] !== undefined) {
          out.push(h('code', { key: keyPrefix + k++, className: 'mdle-code' }, m[8]));
        } else if (m[9] !== undefined) {
          out.push(h('strong', { key: keyPrefix + k++ }, inlineNodes(m[10], keyPrefix + 'b' + k, depth + 1)));
        } else if (m[11] !== undefined) {
          out.push(h('s', { key: keyPrefix + k++ }, inlineNodes(m[12], keyPrefix + 's' + k, depth + 1)));
        } else if (m[13] !== undefined) {
          out.push(h('em', { key: keyPrefix + k++ }, inlineNodes(m[14], keyPrefix + 'i' + k, depth + 1)));
        } else if (m[15] !== undefined) {
          out.push(h('em', { key: keyPrefix + k++ }, inlineNodes(m[16], keyPrefix + 'e' + k, depth + 1)));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    // ---------------------------------------------------------------------
    // Block renderers.
    // ---------------------------------------------------------------------
    function renderHeading(block, key) {
      const m = /^ {0,3}(#{1,6})\s+(.*)$/.exec(block.lines[0]);
      const body = m ? m[2].replace(/\s+#+\s*$/, '') : block.lines[0];
      return h('h' + block.level, { key, className: 'mdle-h mdle-h' + block.level }, inlineNodes(body, key + 'i'));
    }

    function renderCode(block, key) {
      const body = block.lines.slice(1, block.lines.length - (block.lines.length > 1 ? 1 : 0));
      return h('div', { key, className: 'mdle-codeblock' },
        block.language ? h('div', { className: 'mdle-codeblock-lang' }, block.language) : null,
        h('pre', { className: 'mdle-pre' }, h('code', {}, body.join('\n'))));
    }

    function splitRow(line) {
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map((c) => c.trim());
    }

    function renderTable(block, key) {
      const header = splitRow(block.lines[0]);
      const rows = block.lines.slice(2).map(splitRow);
      return h('table', { key, className: 'mdle-table' },
        h('thead', {}, h('tr', {}, header.map((c, i) => h('th', { key: i }, inlineNodes(c, key + 'h' + i))))),
        h('tbody', {}, rows.map((r, ri) => h('tr', { key: ri }, r.map((c, ci) =>
          h('td', { key: ci }, inlineNodes(c, key + 'r' + ri + 'c' + ci)))))));
    }

    function renderList(block, key) {
      const items = [];
      for (const line of block.lines) {
        const m = /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line);
        if (m && m[1].replace(/\t/g, '  ').length <= 3) {
          items.push({ ordered: /^\d/.test(line.trim()), text: m[3] });
        } else if (items.length) {
          items[items.length - 1].text += '\n' + line.trim();
        }
      }
      const ordered = items.length > 0 && items.every((i) => i.ordered);
      return h(ordered ? 'ol' : 'ul', { key, className: 'mdle-list' },
        items.map((it, i) => h('li', { key: i }, it.text.split('\n').map((seg, si) =>
          h(React.Fragment, { key: si }, si > 0 ? h('br') : null,
            inlineNodes(seg, key + 'li' + i + 's' + si))))));
    }

    function renderQuote(block, key) {
      const body = block.lines.map((l) => l.replace(/^ {0,3}> ?/, '')).join('\n');
      return h('blockquote', { key, className: 'mdle-quote' },
        body.split(/\n{2,}/).map((seg, i) =>
          h('p', { key: i, className: 'mdle-quote-p' }, inlineNodes(seg.replace(/\n/g, ' '), key + 'q' + i))));
    }

    function renderParagraph(block, key) {
      return h('p', { key, className: 'mdle-p' },
        block.lines.map((l, i) => h(React.Fragment, { key: i }, i > 0 ? h('br') : null, inlineNodes(l, key + 'p' + i))));
    }

    function renderBlock(block, key) {
      switch (block.type) {
        case 'blank': return null;
        case 'frontmatter': return h('div', { key, className: 'mdle-frontmatter' }, block.lines.join('\n'));
        case 'heading': return renderHeading(block, key);
        case 'code': return renderCode(block, key);
        case 'table': return renderTable(block, key);
        case 'list': return renderList(block, key);
        case 'quote': return renderQuote(block, key);
        case 'hr': return h('hr', { key, className: 'mdle-hr' });
        default: return renderParagraph(block, key);
      }
    }

    // ---------------------------------------------------------------------
    // Inline block editor.
    // ---------------------------------------------------------------------
    function BlockEditor({ initial, isNew, labels, onSave, onCancel, onInsertBefore, onInsertAfter, onDelete }) {
      const [value, setValue] = useState(initial);
      const ref = useRef(null);
      useEffect(() => {
        const ta = ref.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, []);
      const autosize = useCallback(() => {
        const ta = ref.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 48), 460) + 'px';
      }, []);
      useEffect(autosize, [value, autosize]);
      const save = useCallback(() => { onSave(value); }, [value, onSave]);
      return h('div', {
        className: 'mdle-editor',
        onKeyDown: (e) => {
          e.stopPropagation();
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        },
      },
        h('textarea', {
          ref,
          className: 'mdle-textarea',
          value,
          placeholder: labels.placeholder,
          spellCheck: false,
          onChange: (e) => setValue(e.target.value),
        }),
        h('div', {
          className: 'mdle-editor-bar',
          // Keep focus in the textarea so a toolbar click cannot fire a blur save first.
          onMouseDown: (e) => e.preventDefault(),
        },
          h('button', { type: 'button', className: 'mdle-btn mdle-btn-primary', onClick: save }, labels.save + ' ⌘↩'),
          h('button', { type: 'button', className: 'mdle-btn', onClick: onCancel }, labels.cancel),
          h('span', { className: 'mdle-bar-spacer' }),
          h('button', { type: 'button', className: 'mdle-btn', onClick: onInsertBefore }, labels.insertBefore),
          h('button', { type: 'button', className: 'mdle-btn', onClick: onInsertAfter }, labels.insertAfter),
          !isNew && h('button', { type: 'button', className: 'mdle-btn mdle-btn-danger', onClick: onDelete }, labels.delete)));
    }

    // ---------------------------------------------------------------------
    // Styles: host theme tokens only.
    // ---------------------------------------------------------------------
    const CSS = `
.mdle-root { position: relative; font-family: var(--dsw-font, inherit); color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.7; }
.mdle-doc { padding: 8px 14px 56px; }
.mdle-block { position: relative; border-radius: 6px; }
.mdle-block-blank { min-height: 10px; }
.mdle-blank-line { min-height: 10px; cursor: text; border-radius: 4px; }
.mdle-blank-line:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.mdle-view { cursor: text; border-radius: 6px; padding: 1px 6px; margin: 0 -6px; }
.mdle-block:not(.mdle-block-active):hover .mdle-view { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.mdle-block-active { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); padding: 4px 6px; margin: 0 -6px; }
.mdle-p { margin: 4px 0; white-space: normal; overflow-wrap: anywhere; }
.mdle-h { margin: 14px 0 6px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.mdle-h1 { font-size: 1.55em; } .mdle-h2 { font-size: 1.35em; } .mdle-h3 { font-size: 1.18em; }
.mdle-h4 { font-size: 1.05em; } .mdle-h5 { font-size: .95em; } .mdle-h6 { font-size: .88em; color: var(--dsw-alias-label-secondary); }
.mdle-code { font-family: var(--dsw-font-mono, ui-monospace, monospace); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.15)); border-radius: 4px; padding: 0 4px; font-size: .92em; }
.mdle-codeblock { margin: 8px 0; border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 8px; overflow: hidden; }
.mdle-codeblock-lang { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); padding: 3px 10px; border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); }
.mdle-pre { margin: 0; padding: 10px 12px; overflow: auto; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.mdle-pre code { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; line-height: 1.55; white-space: pre; }
.mdle-table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: .95em; }
.mdle-table th, .mdle-table td { border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); padding: 4px 8px; text-align: left; vertical-align: top; }
.mdle-table th { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); font-weight: 600; }
.mdle-list { margin: 4px 0; padding-left: 22px; }
.mdle-quote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--dsw-alias-border-accent, #4f8cff); color: var(--dsw-alias-label-secondary); }
.mdle-quote-p { margin: 4px 0; }
.mdle-hr { border: none; border-top: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); margin: 12px 0; }
.mdle-img { max-width: 100%; border-radius: 6px; display: block; margin: 6px 0; }
.mdle-frontmatter { white-space: pre-wrap; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 8px; padding: 8px 10px; margin: 4px 0 10px; }
.mdle-editor { display: flex; flex-direction: column; gap: 6px; margin: 4px 0; }
.mdle-textarea { width: 100%; box-sizing: border-box; resize: none; border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12.5px; line-height: 1.55; padding: 8px 10px; outline: none; }
.mdle-textarea:focus { border-color: var(--dsw-alias-border-accent, #4f8cff); }
.mdle-editor-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mdle-bar-spacer { flex: 1; }
.mdle-btn { font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.mdle-btn:hover { background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)); }
.mdle-btn-primary { background: var(--dsw-alias-interactive-bg-accent, #4f8cff); border-color: transparent; color: var(--dsw-alias-label-on-accent, #fff); }
.mdle-btn-primary:hover { background: var(--dsw-alias-interactive-bg-accent, #4f8cff); filter: brightness(1.08); }
.mdle-btn-danger { color: var(--dsw-alias-label-red, #d5484f); }
.mdle-status { position: sticky; top: 0; z-index: 3; display: flex; flex-direction: column; gap: 4px; padding: 6px 14px 0; }
.mdle-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); display: flex; align-items: center; gap: 8px; }
.mdle-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); color: var(--dsw-alias-label-secondary); }
.mdle-chip-live { background: var(--dsw-alias-interactive-bg-accent, #4f8cff); color: var(--dsw-alias-label-on-accent, #fff); }
.mdle-notice { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 6px; padding: 4px 10px; margin-top: 4px; }
.mdle-notice-error { color: var(--dsw-alias-label-red, #d5484f); border-color: var(--dsw-alias-label-red, #d5484f); }
.mdle-notice-ok { color: var(--dsw-alias-label-green, #30a46c); }
.mdle-add { margin: 12px 14px 0; padding: 8px; text-align: center; color: var(--dsw-alias-label-tertiary); border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 8px; cursor: pointer; }
.mdle-add:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.mdle-root a { color: var(--dsw-alias-label-link, #4f8cff); }
`;

    // ---------------------------------------------------------------------
    // The document body.
    // ---------------------------------------------------------------------
    function createBody({ labels, remote }) {
      function Body(props) {
        const { content, resourceAddress } = props;
        const parsed = useMemo(() => parseFileAddress(resourceAddress), [resourceAddress]);
        const contentText = content && content.kind === 'text' ? content.text : '';
        const complete = !!content && content.kind === 'text' && content.eof === true;

        const [docText, setDocText] = useState(complete ? contentText : '');
        const [ready, setReady] = useState(complete);
        const [busyText, setBusyText] = useState(false);
        const [loadError, setLoadError] = useState(null);
        const [editing, setEditing] = useState(null); // { index, isNew }
        const [status, setStatus] = useState({ kind: 'idle' });
        const [conflict, setConflict] = useState(false);

        const seenRef = useRef(contentText);
        const editingRef = useRef(null);
        editingRef.current = editing;
        const loadingRef = useRef(false);

        // Complete a partially loaded document before allowing any edit, so a
        // save can never truncate the file to the first page.
        useEffect(() => {
          if (complete || !parsed || loadingRef.current) return;
          loadingRef.current = true;
          setBusyText(true);
          const controller = new AbortController();
          (async () => {
            try {
              let text = contentText;
              let offset = 1;
              const pages = (content && content.pages) || [];
              if (pages.length > 0) {
                const last = pages[pages.length - 1];
                offset = (last.offset || 1) + (last.lines || 0);
              } else if (text) {
                offset = text.split('\n').length + 1;
              }
              let followed = 0;
              let done = false;
              while (followed < MAX_FOLLOW_PAGES) {
                const res = await remote.workspaceFiles.read(parsed.sessionId, parsed.path, { offset }, controller.signal);
                if (!res || res.ok !== true) throw new Error((res && res.error && res.error.message) || 'read failed');
                const page = res.value;
                if (page.lines > 0) text = text ? text + '\n' + page.text : page.text;
                followed += 1;
                if (page.eof) { done = true; break; }
                offset = (page.offset || offset) + page.lines;
              }
              if (controller.signal.aborted) return;
              if (!done) throw new Error('document too large to load completely');
              setDocText(text);
              seenRef.current = text;
              setLoadError(null);
              setReady(true);
            } catch (error) {
              if (!controller.signal.aborted) setLoadError(String((error && error.message) || error));
            } finally {
              if (!controller.signal.aborted) { setBusyText(false); loadingRef.current = false; }
            }
          })();
          return () => controller.abort();
        }, [complete, parsed, contentText]);

        // Adopt external changes unless an edit is in progress.
        useEffect(() => {
          if (!complete) return;
          if (contentText === seenRef.current) return;
          seenRef.current = contentText;
          if (editingRef.current !== null) { setConflict(true); return; }
          setDocText(contentText);
          setReady(true);
        }, [contentText, complete]);

        const blocks = useMemo(() => parseMarkdown(docText), [docText]);

        const persist = useCallback(async (nextText, prevText) => {
          setDocText(nextText);
          if (!parsed) return;
          setStatus({ kind: 'saving' });
          try {
            const res = await fetch(WRITE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: parsed.sessionId, path: parsed.path, content: nextText }),
            });
            const data = await res.json().catch(() => ({}));
            if (data && data.ok) {
              seenRef.current = nextText;
              setStatus({ kind: 'saved', at: Date.now() });
              setConflict(false);
            } else {
              setDocText(prevText);
              setStatus({ kind: 'error', message: (data && (data.error || data.code)) || ('HTTP ' + res.status) });
            }
          } catch (error) {
            setDocText(prevText);
            setStatus({ kind: 'error', message: String((error && error.message) || error) });
          }
        }, [parsed]);

        const editable = !!parsed && ready && !busyText;

        const saveExisting = useCallback((index, newSource) => {
          const next = replaceBlockText(docText, blocks, index, newSource);
          setEditing(null);
          if (next !== null && next !== docText) persist(next, docText);
        }, [blocks, docText, persist]);

        const insertAt = useCallback((index, source) => {
          setEditing(null);
          persist(insertBlockText(docText, blocks, index, source), docText);
        }, [blocks, docText, persist]);

        if (content && content.kind !== 'text') return null;

        const editProps = (index, isNew, initial) => ({
          initial,
          isNew,
          labels,
          onSave: (source) => {
            if (source.trim() === '') {
              if (isNew) { setEditing(null); return; }
              saveExisting(index, '');
              return;
            }
            if (isNew) insertAt(index, source);
            else saveExisting(index, source);
          },
          onCancel: () => setEditing(null),
          onInsertBefore: () => setEditing({ index, isNew: true }),
          onInsertAfter: () => setEditing({ index: index + 1, isNew: true }),
          onDelete: () => saveExisting(index, ''),
        });

        const children = [];
        blocks.forEach((block, index) => {
          const activeExisting = editing && !editing.isNew && editing.index === index;
          const showNewBefore = editing && editing.isNew && editing.index === index;
          if (showNewBefore) children.push(h(BlockEditor, { key: 'new-' + index, ...editProps(index, true, '') }));
          if (block.type === 'blank') {
            children.push(h('div', {
              key: 'b' + index,
              className: 'mdle-block mdle-block-blank',
            }, editable
              ? h('div', {
                className: 'mdle-blank-line',
                title: labels.clickToAdd,
                onClick: () => { if (!editing) setEditing({ index, isNew: true }); },
              })
              : null));
            return;
          }
          children.push(h('div', {
            key: 'b' + index,
            className: 'mdle-block' + (activeExisting ? ' mdle-block-active' : ''),
            'data-mdle-type': block.type,
          }, activeExisting
            ? h(BlockEditor, editProps(index, false, block.source))
            : h('div', {
              className: 'mdle-view',
              title: editable ? labels.clickToEdit : undefined,
              onClick: (e) => {
                if (!editable || editing) return;
                if (e.target.closest('a,img,button,textarea')) return;
                setEditing({ index, isNew: false });
              },
            }, renderBlock(block, 'b' + index))));
        });
        if (editing && editing.isNew && editing.index >= blocks.length) {
          children.push(h(BlockEditor, { key: 'new-end', ...editProps(blocks.length, true, '') }));
        }

        return h('div', { className: 'mdle-root', 'data-mdle-root': true, 'data-mdle-mode': editable ? 'edit' : 'readonly' },
          h('style', {}, CSS),
          h('div', { className: 'mdle-status' },
            h('div', { className: 'mdle-hint' },
              h('span', { className: 'mdle-chip' + (editable ? ' mdle-chip-live' : '') },
                editable ? labels.modeEdit : labels.modeReadonly),
              h('span', {}, editable ? labels.hint : ''),
              status.kind === 'saving' ? h('span', {}, labels.saving) : null,
              status.kind === 'saved' ? h('span', {}, '· ' + labels.saved) : null),
            conflict ? h('div', { className: 'mdle-notice' },
              h('span', {}, labels.conflict),
              h('button', {
                type: 'button', className: 'mdle-btn',
                onClick: () => {
                  setDocText(contentText);
                  seenRef.current = contentText;
                  setConflict(false);
                  setEditing(null);
                },
              }, labels.reload),
              h('button', {
                type: 'button', className: 'mdle-btn',
                onClick: () => setConflict(false),
              }, labels.keepMine)) : null,
            status.kind === 'error' ? h('div', { className: 'mdle-notice mdle-notice-error' },
              h('span', {}, labels.saveFailed + '：' + status.message),
              h('button', {
                type: 'button', className: 'mdle-btn',
                onClick: () => { setStatus({ kind: 'idle' }); persist(docText, docText); },
              }, labels.retry)) : null,
            loadError ? h('div', { className: 'mdle-notice mdle-notice-error' },
              h('span', {}, labels.loadFailed + '：' + loadError)) : null,
            status.kind === 'saved' && Date.now() - status.at > 4000 ? null : null),
          h('div', {
            className: 'mdle-doc',
            onMouseDown: (e) => {
              // Clicking empty document space closes an untouched new-block editor.
              if (!editing || !editing.isNew) return;
              if (e.target.closest('.mdle-editor')) return;
              setEditing(null);
            },
          }, children),
          editable ? h('div', {
            className: 'mdle-add',
            onClick: () => { if (!editing) setEditing({ index: blocks.length, isNew: true }); },
          }, '+ ' + labels.addBlock) : null);
      }
      return Body;
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries.
    // ---------------------------------------------------------------------
    const dictionaries = {
      en: {
        'viewer.label': 'Editable Markdown',
        'mode.edit': 'Editable',
        'mode.readonly': 'Read-only',
        'hint': 'Click any block to edit it in place · ⌘↩ saves',
        'edit.placeholder': 'Markdown source of this block…',
        'edit.save': 'Save',
        'edit.cancel': 'Cancel',
        'edit.insertBefore': 'Insert above',
        'edit.insertAfter': 'Insert below',
        'edit.delete': 'Delete',
        'edit.addBlock': 'Add block',
        'edit.clickToEdit': 'Click to edit this block',
        'edit.clickToAdd': 'Click to add a block',
        'status.saving': 'Saving…',
        'status.saved': 'Saved',
        'status.failed': 'Save failed',
        'status.retry': 'Retry',
        'status.loadFailed': 'Could not load the full document',
        'status.conflict': 'This file changed on disk while you were editing.',
        'status.reload': 'Discard mine and reload',
        'status.keepMine': 'Keep mine',
      },
      zh: {
        'viewer.label': 'Markdown 可编辑',
        'mode.edit': '可编辑',
        'mode.readonly': '只读',
        'hint': '点击任意段落就地编辑 · ⌘↩ 保存',
        'edit.placeholder': '该块的 Markdown 源码…',
        'edit.save': '保存',
        'edit.cancel': '取消',
        'edit.insertBefore': '上方插入',
        'edit.insertAfter': '下方插入',
        'edit.delete': '删除',
        'edit.addBlock': '添加块',
        'edit.clickToEdit': '点击编辑此块',
        'edit.clickToAdd': '点击在此添加段落',
        'status.saving': '保存中…',
        'status.saved': '已保存',
        'status.failed': '保存失败',
        'status.retry': '重试',
        'status.loadFailed': '完整文档读取失败',
        'status.conflict': '该文件在编辑期间被外部修改。',
        'status.reload': '放弃我的修改并重载',
        'status.keepMine': '保留我的',
      },
    };

    function buildLabels(t) {
      return {
        modeEdit: t('mode.edit'),
        modeReadonly: t('mode.readonly'),
        hint: t('hint'),
        placeholder: t('edit.placeholder'),
        save: t('edit.save'),
        cancel: t('edit.cancel'),
        insertBefore: t('edit.insertBefore'),
        insertAfter: t('edit.insertAfter'),
        delete: t('edit.delete'),
        addBlock: t('edit.addBlock'),
        clickToEdit: t('edit.clickToEdit'),
        clickToAdd: t('edit.clickToAdd'),
        saving: t('status.saving'),
        saved: t('status.saved'),
        saveFailed: t('status.failed'),
        retry: t('status.retry'),
        loadFailed: t('status.loadFailed'),
        conflict: t('status.conflict'),
        reload: t('status.reload'),
        keepMine: t('status.keepMine'),
      };
    }

    // ---------------------------------------------------------------------
    // Plugin assembly.
    // ---------------------------------------------------------------------
    return {
      inject: ['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        const labels = buildLabels(t);
        const Body = createBody({ labels, remote: ctx.remote });

        ctx.effect(() => ctx.locale.register(NS, {
          en: dictionaries.en,
          zh: dictionaries.zh,
        }), 'md-live-edit: locale');

        ctx.effect(() => ctx.documentPreviews.register({
          id: BODY_ID,
          extensions: ['md', 'markdown'],
          priority: 'extension',
          title: () => t('viewer.label'),
          loading: 'text-pages',
          wrap: false,
        }), 'md-live-edit: preview metadata');

        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
          name: 'sidebar.right.tab.document',
          key: BODY_ID,
        }, Body)), 'md-live-edit: body');
      },
    };
  },
});
