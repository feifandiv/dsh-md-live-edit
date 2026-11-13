/**
 * Client half of the Markdown live-edit bundle.
 *
 * Registers an `extension`-band Markdown preview implementation whose body
 * renders the document as blocks and lets the reader edit each block in
 * place: click a block, edit its source in a small overlay, and the whole
 * document is written back to the workspace file through the Host half's
 * authenticated endpoint. No code mode, no separate editor.
 */
window.__ModuleLoader__.load({
  id: '@feifan/dsh-md-live-edit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const BODY_ID = '@feifan/dsh-md-live-edit/markdown';
    const NS = 'mdLiveEdit';
    const WRITE_ROUTE = '/dsh-md-live-edit/api/write';
    const FILE_PREFIX = 'dsh-resource://file/';

    // ---------------------------------------------------------------------
    // File address grammar (mirrors dsh-util-workspace-path).
    // ---------------------------------------------------------------------
    function parseFileAddress(address) {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const scope = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end);
        const slash = scope.indexOf('/');
        if (slash === -1) return undefined;
        const kind = scope.slice(0, slash);
        const rest = scope.slice(slash + 1);
        if (kind !== 'session') return undefined;
        const first = rest.indexOf('/');
        if (first === -1) return undefined;
        const id = rest.slice(0, first);
        const path = rest.slice(first + 1);
        if (!id || !path) return undefined;
        return { sessionId: decodeURIComponent(id), path: path.split('/').map(decodeURIComponent).join('/') };
      } catch {
        return undefined;
      }
    }

    // ---------------------------------------------------------------------
    // Markdown block parser. Every block keeps its exact source lines so the
    // document rebuilds byte-for-byte after one block changes.
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
        // Absorb one blank line after the frontmatter into the marker.
        if (cursor < lines.length && isBlank(lines[cursor])) { blocks.push({ type: 'blank', lines: [lines[cursor]] }); cursor += 1; }
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
          blocks.push({ type: 'code', lines: lines.slice(start, cursor), language: /^ {0,3}(?:```+|~~~+)(.*)$/.exec(line)[1].trim() });
          continue;
        }
        if (isAtx(line)) { blocks.push({ type: 'heading', level: /^ {0,3}(#{1,6})/.exec(line)[1].length, lines: [line] }); cursor++; continue; }
        if (isHr(line)) { blocks.push({ type: 'hr', lines: [line] }); cursor++; continue; }
        // Table: current row + delimiter next.
        if (looksTableRow(line) && cursor + 1 < lines.length && isTableDelimiter(lines[cursor + 1])) {
          const start = cursor;
          cursor += 2;
          while (cursor < lines.length && looksTableRow(lines[cursor]) && !isBlank(lines[cursor])) cursor++;
          blocks.push({ type: 'table', lines: lines.slice(start, cursor) });
          continue;
        }
        if (isQuote(line)) {
          const start = cursor;
          while (cursor < lines.length && (isQuote(lines[cursor]) || (isBlank(lines[cursor]) && cursor + 1 < lines.length && isQuote(lines[cursor + 1])))) cursor++;
          blocks.push({ type: 'quote', lines: lines.slice(start, cursor) });
          continue;
        }
        if (isListItem(line)) {
          const start = cursor;
          const base = listIndentOf(line);
          cursor++;
          while (cursor < lines.length) {
            const l = lines[cursor];
            if (isBlank(l)) {
              // A blank inside a list continues only when an indented item follows.
              let peek = cursor + 1;
              while (peek < lines.length && isBlank(lines[peek])) peek++;
              if (peek < lines.length && (isListItem(lines[peek]) || /^\s{1,}\S/.test(lines[peek]))) { cursor = peek; continue; }
              break;
            }
            if (isListItem(l)) { cursor++; continue; }
            if (/^\s+\S/.test(l) && !isAtx(l) && !isQuote(l)) { cursor++; continue; } // continuation / nested
            break;
          }
          blocks.push({ type: 'list', lines: lines.slice(start, cursor) });
          continue;
        }
        // Paragraph, with Setext underline joining.
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
        const joined = isSetext1(last) ? { type: 'heading', level: 1 } : isSetext2(last) ? { type: 'heading', level: 2 } : { type: 'paragraph' };
        blocks.push({ ...joined, lines: para });
      }
      return blocks.map((b) => ({ ...b, source: b.lines.join('\n') }));
    }

    function rebuildText(blocks) {
      return blocks.map((b) => b.source).join('\n');
    }

    // ---------------------------------------------------------------------
    // Inline renderer: images, links, code, bold, strike, italic.
    // ---------------------------------------------------------------------
    const INLINE_RX = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(\*([^*]+)\*)|(_([^_]+)_)/g;

    function inlineNodes(text, keyPrefix) {
      const out = [];
      let last = 0;
      let k = 0;
      INLINE_RX.lastIndex = 0;
      let m;
      while ((m = INLINE_RX.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1] !== undefined) {
          out.push(h('img', { key: keyPrefix + k++, src: m[3], alt: m[2], className: 'mdle-img' }));
        } else if (m[4] !== undefined) {
          out.push(h('a', { key: keyPrefix + k++, href: m[6], target: '_blank', rel: 'noreferrer' }, m[5]));
        } else if (m[7] !== undefined) {
          out.push(h('code', { key: keyPrefix + k++, className: 'mdle-code' }, m[8]));
        } else if (m[9] !== undefined) {
          out.push(h('strong', { key: keyPrefix + k++ }, inlineNodes(m[10], keyPrefix + 'b' + k)));
        } else if (m[11] !== undefined) {
          out.push(h('s', { key: keyPrefix + k++ }, inlineNodes(m[12], keyPrefix + 's' + k)));
        } else if (m[13] !== undefined) {
          out.push(h('em', { key: keyPrefix + k++ }, inlineNodes(m[14], keyPrefix + 'i' + k)));
        } else if (m[15] !== undefined) {
          out.push(h('em', { key: keyPrefix + k++ }, inlineNodes(m[16], keyPrefix + 'e' + k)));
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
        h('tbody', {}, rows.map((r, ri) => h('tr', { key: ri }, r.map((c, ci) => h('td', { key: ci }, inlineNodes(c, key + 'r' + ri + 'c' + ci)))))));
    }

    function renderList(block, key) {
      const items = [];
      for (const line of block.lines) {
        const m = /^(\s*)(?:[-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line);
        if (m && m[1].replace(/\t/g, '  ').length <= 3) items.push({ ordered: /^\d/.test(line.trim()), text: m[4] });
        else if (items.length) items[items.length - 1].text += '\n' + line.trim();
      }
      const ordered = items.length > 0 && items.every((i) => i.ordered);
      return h(ordered ? 'ol' : 'ul', { key, className: 'mdle-list' },
        items.map((it, i) => h('li', { key: i }, it.text.split('\n').map((seg, si) => h(React.Fragment, { key: si }, si > 0 ? h('br') : null, inlineNodes(seg, key + 'li' + i + 's' + si))))));
    }

    function renderQuote(block, key) {
      const body = block.lines.map((l) => l.replace(/^ {0,3}> ?/, '')).join('\n');
      return h('blockquote', { key, className: 'mdle-quote' },
        body.split(/\n{2,}/).map((seg, i) => h('p', { key: i, className: 'mdle-quote-p' }, inlineNodes(seg.replace(/\n/g, ' '), key + 'q' + i))));
    }

    function renderParagraph(block, key) {
      return h('p', { key, className: 'mdle-p' }, block.lines.map((l, i) => h(React.Fragment, { key: i }, i > 0 ? h('br') : null, inlineNodes(l, key + 'p' + i))));
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

    function isEmptySource(source) { return source.trim() === ''; }

    // ---------------------------------------------------------------------
    // Block editor: textarea + toolbar, saves with Cmd/Ctrl+Enter or blur.
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
        ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 44), 480) + 'px';
      }, []);
      useEffect(autosize, [value, autosize]);
      const save = useCallback(() => { onSave(value); }, [value, onSave]);
      return h('div', { className: 'mdle-editor', onKeyDown: (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      } },
        h('textarea', {
          ref, className: 'mdle-textarea', value,
          placeholder: labels.placeholder,
          onChange: (e) => setValue(e.target.value),
          onBlur: () => { if (value !== initial || isNew) save(); },
        }),
        h('div', { className: 'mdle-editor-bar' },
          h('button', { type: 'button', className: 'mdle-btn mdle-btn-primary', onClick: save, title: '⌘↩' }, labels.save),
          h('button', { type: 'button', className: 'mdle-btn', onClick: onCancel }, labels.cancel),
          h('span', { className: 'mdle-bar-spacer' }),
          h('button', { type: 'button', className: 'mdle-btn', onClick: onInsertBefore, title: labels.insertBeforeTip }, labels.insertBefore),
          h('button', { type: 'button', className: 'mdle-btn', onClick: onInsertAfter, title: labels.insertAfterTip }, labels.insertAfter),
          !isNew && h('button', { type: 'button', className: 'mdle-btn mdle-btn-danger', onClick: onDelete }, labels.delete)));
    }

    // ---------------------------------------------------------------------
    // The document body: rendered blocks + in-place block editing.
    // ---------------------------------------------------------------------
    function MarkdownEditBody({ content, resourceAddress, t }) {
      const labels = useMemo(() => buildLabels(t), [t]);
      const parsed = useMemo(() => parseFileAddress(resourceAddress), [resourceAddress]);
      const text = content && content.kind === 'text' ? content.text : '';
      const [blocks, setBlocks] = useState(() => parseMarkdown(text));
      const [editing, setEditing] = useState(null); // { index, isNew }
      const [conflict, setConflict] = useState(false);
      const [saveState, setSaveState] = useState({ kind: 'idle' });
      const lastSavedRef = useRef(text);
      const lastExternalRef = useRef(text);
      const editingRef = useRef(null);
      editingRef.current = editing;

      // Sync external content changes without clobbering an active edit.
      useEffect(() => {
        if (text === lastSavedRef.current || text === lastExternalRef.current) return;
        if (editingRef.current !== null) { setConflict(true); return; }
        lastExternalRef.current = text;
        lastSavedRef.current = text;
        setBlocks(parseMarkdown(text));
      }, [text]);

      const persist = useCallback(async (nextBlocks) => {
        const nextText = rebuildText(nextBlocks);
        setBlocks(nextBlocks);
        if (!parsed) { setSaveState({ kind: 'error', message: 'Bad file address' }); return; }
        setSaveState({ kind: 'saving' });
        try {
          const res = await fetch(WRITE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: parsed.sessionId, path: parsed.path, content: nextText }),
          });
          const data = await res.json();
          if (data && data.ok) {
            lastSavedRef.current = nextText;
            lastExternalRef.current = nextText;
            setSaveState({ kind: 'saved', at: Date.now() });
            setConflict(false);
          } else {
            setSaveState({ kind: 'error', message: (data && (data.error || data.code)) || ('HTTP ' + res.status) });
          }
        } catch (error) {
          setSaveState({ kind: 'error', message: String(error && error.message || error) });
        }
      }, [parsed]);

      const saveBlock = useCallback((index, source, isNew) => {
        const next = blocks.slice();
        if (isEmptySource(source)) {
          if (isNew) { setEditing(null); return; }
          next.splice(index, 1);
        } else {
          next[index] = { ...parseMarkdown(source)[0], source };
        }
        setEditing(null);
        persist(next);
      }, [blocks, persist]);

      const insertBlock = useCallback((index) => {
        const para = { type: 'paragraph', lines: [''], source: '' };
        const next = blocks.slice();
        next.splice(index, 0, para);
        setBlocks(next);
        setEditing({ index, isNew: true });
      }, [blocks]);

      const deleteBlock = useCallback((index) => {
        const next = blocks.slice();
        next.splice(index, 1);
        setEditing(null);
        persist(next);
      }, [blocks, persist]);

      const retry = useCallback(() => { persist(blocks); }, [blocks, persist]);
      const acceptExternal = useCallback(() => {
        lastExternalRef.current = text;
        lastSavedRef.current = text;
        setBlocks(parseMarkdown(text));
        setConflict(false);
        setEditing(null);
      }, [text]);

      if (content && content.kind !== 'text') return null;

      return h('div', { className: 'mdle-root', 'data-mdle-document': true },
        h('style', {}, CSS),
        h('div', { className: 'mdle-toolbar' },
          conflict && h('div', { className: 'mdle-notice' },
            h('span', {}, labels.conflict),
            h('button', { type: 'button', className: 'mdle-btn', onClick: acceptExternal }, labels.useExternal),
            h('button', { type: 'button', className: 'mdle-btn', onClick: () => setConflict(false) }, labels.keepMine)),
          !conflict && saveState.kind === 'error' && h('div', { className: 'mdle-notice mdle-notice-error' },
            h('span', {}, labels.saveFailed + '：' + saveState.message),
            h('button', { type: 'button', className: 'mdle-btn', onClick: retry }, labels.retry)),
          !conflict && saveState.kind === 'saved' && h('div', { className: 'mdle-notice mdle-notice-ok' }, labels.saved),
          !conflict && saveState.kind === 'saving' && h('div', { className: 'mdle-notice' }, labels.saving)),
        h('div', { className: 'mdle-doc' },
          blocks.map((block, index) => {
            const active = editing && editing.index === index;
            return h('div', {
              key: index,
              className: 'mdle-block' + (block.type === 'blank' ? ' mdle-block-blank' : '') + (active ? ' mdle-block-active' : ''),
              'data-mdle-type': block.type,
            },
              block.type === 'blank'
                ? h('div', { className: 'mdle-blank-line', onClick: () => !editing && insertBlock(index), title: labels.clickToAdd })
                : active
                  ? h(BlockEditor, {
                      initial: block.source,
                      isNew: editing.isNew,
                      labels,
                      onSave: (source) => saveBlock(index, source, editing.isNew),
                      onCancel: () => editing.isNew ? (() => { const next = blocks.slice(); next.splice(index, 1); setBlocks(next); setEditing(null); })() : setEditing(null),
                      onInsertBefore: () => insertBlock(index),
                      onInsertAfter: () => insertBlock(index + 1),
                      onDelete: () => deleteBlock(index),
                    })
                  : h('div', {
                      className: 'mdle-view',
                      onClick: (e) => {
                        if (editing) return;
                        if (e.target.closest('a,img,button')) return;
                        setEditing({ index, isNew: false });
                      },
                      title: labels.clickToEdit,
                    }, renderBlock(block, 'b' + index)));
          }),
          h('div', { className: 'mdle-add', onClick: () => !editing && insertBlock(blocks.length) }, '+ ' + labels.addBlock)));
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries.
    // ---------------------------------------------------------------------
    const dictionaries = {
      en: {
        'viewer.label': 'Editable Markdown',
        'edit.hint': 'Click any text to edit it in place',
        'edit.placeholder': 'Markdown source of this block…',
        'edit.save': 'Save',
        'edit.cancel': 'Cancel',
        'edit.insertBefore': 'Insert above',
        'edit.insertAfter': 'Insert below',
        'edit.delete': 'Delete',
        'edit.addBlock': 'Add block',
        'edit.clickToEdit': 'Click to edit this block',
        'edit.clickToAdd': 'Click to add a block',
        'edit.insertBeforeTip': 'Insert a block above',
        'edit.insertAfterTip': 'Insert a block below',
        'status.saving': 'Saving…',
        'status.saved': 'Saved',
        'status.failed': 'Save failed',
        'status.retry': 'Retry',
        'status.conflict': 'This file changed on disk while you were editing.',
        'status.useExternal': 'Discard my edits and reload',
        'status.keepMine': 'Keep my edits',
      },
      zh: {
        'viewer.label': 'Markdown 可编辑',
        'edit.hint': '点击任意文本即可就地编辑',
        'edit.placeholder': '该块的 Markdown 源码…',
        'edit.save': '保存',
        'edit.cancel': '取消',
        'edit.insertBefore': '上方插入',
        'edit.insertAfter': '下方插入',
        'edit.delete': '删除',
        'edit.addBlock': '添加块',
        'edit.clickToEdit': '点击编辑此块',
        'edit.clickToAdd': '点击添加块',
        'edit.insertBeforeTip': '在此块上方插入',
        'edit.insertAfterTip': '在此块下方插入',
        'status.saving': '保存中…',
        'status.saved': '已保存',
        'status.failed': '保存失败',
        'status.retry': '重试',
        'status.conflict': '文件已在其他地方被修改。',
        'status.useExternal': '放弃本地修改并重新加载',
        'status.keepMine': '保留我的编辑',
      },
    };

    function buildLabels(t) {
      return {
        placeholder: t('edit.placeholder'),
        save: t('edit.save'),
        cancel: t('edit.cancel'),
        insertBefore: t('edit.insertBefore'),
        insertAfter: t('edit.insertAfter'),
        insertBeforeTip: t('edit.insertBeforeTip'),
        insertAfterTip: t('edit.insertAfterTip'),
        delete: t('edit.delete'),
        addBlock: t('edit.addBlock'),
        clickToEdit: t('edit.clickToEdit'),
        clickToAdd: t('edit.clickToAdd'),
        saving: t('status.saving'),
        saved: t('status.saved'),
        saveFailed: t('status.failed'),
        retry: t('status.retry'),
        conflict: t('status.conflict'),
        useExternal: t('status.useExternal'),
        keepMine: t('status.keepMine'),
      };
    }

    // ---------------------------------------------------------------------
    // Styles: host theme tokens only.
    // ---------------------------------------------------------------------
    const CSS = `
.mdle-root { position: relative; font-family: var(--dsw-font, inherit); color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.7; }
.mdle-doc { padding: 10px 14px 48px; }
.mdle-block { position: relative; border-radius: 6px; }
.mdle-block-blank { min-height: 8px; cursor: text; }
.mdle-blank-line { height: 100%; min-height: 8px; }
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
.mdle-editor { display: flex; flex-direction: column; gap: 6px; }
.mdle-textarea { width: 100%; box-sizing: border-box; resize: none; border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12.5px; line-height: 1.55; padding: 8px 10px; outline: none; }
.mdle-textarea:focus { border-color: var(--dsw-alias-border-accent, #4f8cff); }
.mdle-editor-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mdle-bar-spacer { flex: 1; }
.mdle-btn { font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.mdle-btn:hover { background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)); }
.mdle-btn-primary { background: var(--dsw-alias-interactive-bg-accent, #4f8cff); border-color: transparent; color: var(--dsw-alias-label-on-accent, #fff); }
.mdle-btn-primary:hover { filter: brightness(1.08); background: var(--dsw-alias-interactive-bg-accent, #4f8cff); }
.mdle-btn-danger { color: var(--dsw-alias-label-red, #d5484f); }
.mdle-toolbar { position: sticky; top: 0; z-index: 3; display: flex; flex-direction: column; gap: 4px; padding: 0 14px; }
.mdle-notice { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 6px; padding: 4px 10px; margin-top: 6px; }
.mdle-notice-error { color: var(--dsw-alias-label-red, #d5484f); border-color: var(--dsw-alias-label-red, #d5484f); }
.mdle-notice-ok { color: var(--dsw-alias-label-green, #30a46c); }
.mdle-add { margin-top: 10px; padding: 8px; text-align: center; color: var(--dsw-alias-label-tertiary); border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 8px; cursor: pointer; }
.mdle-add:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
a { color: var(--dsw-alias-label-link, #4f8cff); }
`;

    // ---------------------------------------------------------------------
    // Plugin assembly.
    // ---------------------------------------------------------------------
    return {
      inject: ['slots', 'locale', 'documentPreviews'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        const Body = (props) => MarkdownEditBody({ ...props, t });
        ctx.effect(() => ctx.locale.register(NS, {
          'en': dictionaries.en,
          'zh': dictionaries.zh,
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
