# Changelog

All notable changes to `@fanfan4589/dsh-md-live-edit` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
