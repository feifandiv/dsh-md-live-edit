# Changelog

All notable changes to `@fanfan4589/dsh-md-live-edit` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.5 — 2026-11-17

### Docs

- Split the README into English (`README.md`) and Chinese (`README.zh.md`), with
  honest limitations, a capability matrix, both install paths, and the test map.
- Added `CONTRIBUTING.md` (ground rules: no Host bypass, admission gate, sandbox
  policy, module-id contract) and `RELEASING.md` (version, changelog, dry-run,
  publish, tag, push, verification).
- Added a one-image plugin detail page: `docs/DETAIL.md`,
  `docs/DETAIL.zh.md`, and a text-free `docs/preview.svg`, declared through
  `meta.detail` in both locales.
- Added annotated how-it-works diagrams (English and Chinese) referenced by the
  READMEs.

## 1.0.4 — 2026-11-17

### Fixed

- **Saving was denied inside the session's own workspace.** The write route
  called `fs.writeText` without a sandbox policy, so the enforcing filesystem
  fell back to the deployment default root and rejected files under the
  session cwd with `file access denied under workspace-write mode`. The route
  now resolves the policy the way the model-facing file tools do —
  `sandboxPolicy.resolve({ session })` — which carries the session's logged
  mode and uses its cwd as the workspace-write boundary, then passes it to
  `writeText`. A `read-only` session is still refused; nothing is widened.

### Added

- Gate tests now assert the resolved policy reaches `writeText`, that a
  rejected request never resolves one, that a cold session falls back to the
  deployment policy, and that a `read-only` policy is passed through unchanged.

## 1.0.3 — 2026-11-17

### Fixed

- **Editor buttons showed raw locale keys.** `labels` were resolved during
  `apply()`, before `locale.register` installed the dictionary, so the preview
  rendered `edit.save`, `edit.cancel`, `edit.insertBefore`, `edit.insertAfter`
  and `edit.delete` instead of translations (and `mode.edit` for the status
  chip). Labels are now resolved on every render against the registered
  dictionary, which also makes them follow a live locale switch.

### Added

- `test/labels.test.mjs` renders the body with a translating locale service and
  fails if any raw key reaches the UI.

## 1.0.2 — 2026-11-17

Critical: this release fixes a renderer crash loop that made the desktop app
unusable whenever a Markdown preview containing emphasis was restored.

### Fixed

- **Infinite loop in the inline renderer.** `inlineNodes` recursed for
  `**bold**`, `*italic*`, and `~~strike~~` while sharing one global `/g`
  regular expression: the recursive call reset `lastIndex`, so the outer scan
  restarted at the same match forever. Every iteration appended React
  elements, the renderer heap grew until V8 aborted (`EXC_BREAKPOINT` /
  `SIGTRAP`, "renderer exited: crashed"), and the app relaunched into the same
  loop — a crash-restart cycle roughly every 12 seconds on open.
  The scan now builds a fresh RegExp per call and caps recursion depth, so
  emphasis renders once and returns.
- **Lists rendered without their text.** The item regex exposes the text as
  its third group; the renderer read a fourth, so any bullet or numbered list
  threw during render.
- Bold and strike now accept nested emphasis (`**bold *nested* tail**`).

### Added

- `test/render.test.mjs` renders the registered body end to end (emphasis,
  nesting, lists, tables, quotes, a 1000-paragraph document) under a VM
  timeout, and `test/inline.test.mjs` runs the inline renderer in a watched
  child process, so a reintroduced loop fails the suite instead of hanging it.

## 1.0.1 — 2026-11-17

Security, following the catalog review of the plugin's write route.

### Security

- **The write route now applies DSH's own admission check.** `POST /dsh-md-live-edit/api/write`
  asks `ctx.connection.requestRejection(req)` before doing anything else and returns the
  Host/Origin fence's answer immediately: `403` for an untrusted authority, `401` for a
  request without a live browser session or API credential. `authorizeIndex` was the wrong
  gate — it only serves `index.html` with a launch token and applies neither the Host/Origin
  fence nor browser authentication to an API route.
- **Fails closed.** On a Host that does not expose `requestRejection`, the route answers `401`
  instead of serving an unauthenticated write endpoint.
- Requests rejected by the fence are not read and not dispatched: the body is never consumed,
  `fs.resolve` never runs, and no file is written.

### Fixed

- **Large documents are completed before editing.** The preview streams text one page at a
  time (5000 lines per page by default). When the first page was not the whole file, saving
  would have written back only the loaded prefix and truncated the rest. The body now reads
  the remaining pages first and stays read-only until it has the complete text.
- **Editing a block no longer degrades its rendering.** Saving a source that contains several
  Markdown blocks re-parses the document instead of keeping only the first block's shape.
- **Inserting a block keeps blank-line separation**, so new text becomes its own paragraph
  instead of merging into the adjacent one; deleting a block collapses the blank line it left
  behind instead of doubling it.
- Removed the no-op `expectedVersion` field: it was passed as `{ version }`, which
  `fs.writeText` ignores, so it promised concurrency protection it did not provide.

### Added

- A status chip that states `可编辑 / 只读`, an explicit failure line when the document cannot
  be loaded completely, and inline save/conflict feedback in the preview header.
- `test/` with 20 `node:test` cases: the admission gate (rejected requests consume no body and
  touch no file), registration metadata, Markdown round-trip, and the edit/insert/delete text
  transforms. Run with `npm test`.

### Changed

- `engines.dsh` is now `>=0.2.2-rc.1 <0.4.0`, the release line whose `connection` service
  exposes `requestRejection`.

## 1.0.0 — 2026-11-13

- First public release: an editable Markdown preview for the right-sidebar document viewer.
  Renders the document as blocks, edits one block in place, and writes the whole document
  back through a small Host endpoint, keeping the Harness sandbox policy on writes.
