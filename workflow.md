# Release workflow — notes & TODO

The GitHub Action at `.github/workflows/release.yml` cuts a dated tag and a
GitHub Release with the packaged extension.

## Triggers
- **Merge to main** — a merged PR is a push to `main`, so it fires automatically.
- **Manual** — "Run workflow" button in the Actions tab (`workflow_dispatch`).

## What it produces
1. Stages a clean `dist/` (excludes `.git`, `.github`, `.idea`, `.DS_Store`,
   `*.zip`, `*.pem`, `*.crx`, `*.md`) with `manifest.json` at the root.
2. Tag = `vYYYY.MM.DD` (UTC). Two releases in one day fall back to `-2`, `-3`, …
3. `HeaderChangerLite-<tag>.zip`.
4. Best-effort `HeaderChangerLite-<tag>.crx` via Chrome's `--pack-extension`
   (the whole crx step is `continue-on-error`, so the zip still ships if it fails).
5. `gh release create` — creates the tag at the merge commit, attaches the
   artifacts, and auto-generates release notes.

## TODO / to remember

### [ ] Add the `CRX_PRIVATE_KEY` secret (for a stable .crx extension ID)
A `.crx`'s extension **ID is derived from its signing key**. Without a fixed key,
Chrome mints a throwaway key each run and the ID changes every release.

- **Skip this** if the `.crx` is only for quick sideloading/testing.
- **Do this** if you distribute the `.crx` and need a constant ID:
  1. Generate a key:
     ```
     openssl genrsa 2048
     ```
  2. Repo → Settings → Secrets and variables → Actions → New repository secret.
  3. Name: `CRX_PRIVATE_KEY`, value: the full PEM (including the
     `-----BEGIN/END PRIVATE KEY-----` lines).

  The workflow then signs with it every run, keeping the ID stable.

### [ ] Confirm workflow token permissions
The workflow sets `permissions: contents: write` so the default `GITHUB_TOKEN`
can create tags/releases — no PAT needed. If the org defaults Actions token
perms to read-only at the org/repo level, that setting still covers it, but
double-check under Settings → Actions → General → Workflow permissions.

### [ ] Remove the stale root `headerchanger.zip`
It's now redundant (the workflow builds a fresh zip each release) and is already
excluded from the package. `git rm headerchanger.zip` when convenient.

### [ ] (Optional) Bump `manifest.json` version
`version` is currently `1.0` while the last commit was tagged 0.2. The release
**tag** is date-based and independent of the manifest version, but keep the
manifest version in mind for Chrome Web Store uploads.
