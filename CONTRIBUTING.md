# Contributing

Thanks for taking a look. This is a small plugin; the fastest way to help is a
focused bug report or a small, tested change.

## Ground rules

- **Keep the patch restrained.** The plugin adds one preview implementation and
  one write route. Do not replace built-in slots or layout, change kernel
  behaviour, or touch other plugins' data.
- **Never bypass the Host.** The write route must ask
  `connection.requestRejection(req)` before anything else and fail closed when
  the Host does not expose it. Writes must go through `ctx.fs.writeText` with a
  policy resolved by `sandboxPolicy.resolve({ session })`; do not write to disk
  directly, and do not widen a `read-only` session.
- **No new runtime dependencies.** The client half is plain JavaScript served by
  the DSH module loader (React comes from the loader).
- **The client module id must equal the package name.**
  `window.__ModuleLoader__.load({ id })` is keyed by the package name; a mismatch
  fails to register.
- **Every fix needs a test that fails before it.** Prefer a test that exercises
  the real code path over a mock of it.

## Develop

```bash
git clone https://github.com/feifandiv/dsh-md-live-edit.git
cd dsh-md-live-edit
npm test
```

Add the directory as a bundle in a DSH profile to try it in the app. Changing
`client.js` needs a page refresh; changing `index.js` needs the plugin to reload
(toggle the bundle, or restart DSH).

## Tests

`npm test` runs `node --test test/*.test.mjs` — 34 cases:

| File | Covers |
| --- | --- |
| `gate.test.mjs` | admission first (403/401), no body read and no fs work on rejection, session-scoped sandbox policy, read-only pass-through, malformed requests |
| `client.test.mjs` | module id == package name, registration metadata, Markdown round-trip, block spans, edit/insert/delete text transforms |
| `render.test.mjs` | the registered body renders end to end (emphasis, nesting, lists, tables, 1000 paragraphs) under a VM timeout |
| `inline.test.mjs` | the inline renderer terminates on emphasis (watched child process, so a regression fails instead of hanging) |
| `labels.test.mjs` | labels are translated; no raw locale keys reach the UI |

## Reporting a bug

Include:

1. DSH version (`Settings → About`, or `dsh --version`) and platform.
2. The plugin version (`npm view @fanfan4589/dsh-md-live-edit version`, or the
   bundle row).
3. The session permission mode (read-only / workspace-write / full access) —
   saves follow it.
4. A minimal Markdown document that reproduces it, and what you expected.
5. For a crash, the newest file in `~/Library/Logs/DeepSeek Harness/` and the
   matching `.ips` from `~/Library/Logs/DiagnosticReports/` (macOS).

## Pull requests

- Conventional commit subject (`fix:`, `feat:`, `docs:`), imperative mood.
- Keep `npm test` green and add a `CHANGELOG.md` entry under an unreleased
  heading.
- If behaviour changes, update both `README.md` and `README.zh.md`, and the
  one-image detail documents in `docs/` when the illustration no longer matches.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
