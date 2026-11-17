# Releasing

The plugin ships as an npm package (`@fanfan4589/dsh-md-live-edit`) and a DSH
bundle (row `md-live-edit`, patch `cordis.patch.yml`). A release updates both.

## Checklist

1. **Version.** Bump `version` in `package.json` (semver: patch for fixes, minor
   for behaviour, major for a breaking contract).
2. **Changelog.** Add an entry at the top of `CHANGELOG.md` under the new
   version, grouped as Added / Fixed / Security / Docs.
3. **Docs.** Update `README.md` and `README.zh.md` when behaviour, limitations,
   or install steps changed. Update `docs/preview.svg` when the feature
   illustration no longer matches the UI.
4. **Tests.** Run `npm test` — all 34 cases must pass. A release with a red test
   is not a release.
5. **Pack check.** `npm publish --dry-run` and confirm the tarball contains the
   runtime files, `locale/*.json`, `docs/` (both detail documents and the
   illustration), `README*.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
   `RELEASING.md`, and `LICENSE`.
6. **Publish.**

   ```bash
   npm publish --access public
   ```

7. **Verify the registry.** Propagation takes 1–5 minutes; a 404 right after
   publish is normal. Do not republish.

   ```bash
   npm view @fanfan4589/dsh-md-live-edit version
   ```

   Then pull the published tarball once and inspect it:

   ```bash
   npm pack @fanfan4589/dsh-md-live-edit@<version>
   tar -xzf fanfan4589-dsh-md-live-edit-<version>.tgz
   node --check package/index.js && node --check package/client.js
   ```

8. **Commit and tag.**

   ```bash
   git add -A
   git commit -m "release: <version>"
   git tag -a v<version> -m "<version>"
   git push origin main --tags
   ```

9. **Verify the push.** `git ls-remote origin` must show the new `main` head and
   the annotated tag; the repository page must return HTTP 200.

## Local profile

The development profile links this directory (`link:`), so a release does not
need reinstalling there: `npm publish` ships the package, and the linked
directory keeps serving the same files. Reload the bundle (toggle it, or restart
DSH) after changing `index.js`; refresh the page after changing `client.js`.

## Notes

- Publishing is a public action: restate the target version before running it.
- Use only the machine's logged-in npm credentials; never extract or paste
  tokens into files.
- `engines.dsh` must include the DSH version you tested against. The write route
  depends on `connection.requestRejection`, available since `0.2.2-rc.1`.
