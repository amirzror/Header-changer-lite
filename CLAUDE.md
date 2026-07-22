# CLAUDE.md — working notes for this repo

> **Standing rule for this repo:** Keep this file up to date. Whenever a code change
> affects architecture, storage keys, UI modes, permissions, or the mental model of how
> the extension works, update the relevant section below **in the same session** so
> future work can ramp up fast instead of re-deriving it. Prefer editing the reference
> sections in place; append a dated line to the "Change log" for anything notable. Don't
> let this file drift from the code.

> **Permissions rule:** Never add a new **static** permission or `host_permissions`
> entry to `manifest.json` unless it is absolutely necessary — broad static permissions
> widen the extension's footprint and scare users at install time. Prefer requesting
> access **programmatically at runtime** (`chrome.permissions.request`, gated behind a
> user gesture) via `optional_permissions` / `optional_host_permissions`. Runtime
> requests are fine, but **always tell the user up front — before making the change —
> that you are adding a permission and why.**

## What this is

A Chrome **Manifest V3** extension ("Header Changer Lite 2") that (1) sets HTTP request
headers on chosen sites via `declarativeNetRequest`, and (2) redirects a domain's
traffic to a different port via a `__port` pseudo-header. See `README.md` for the
user-facing explanation of features and the `__port` mechanism.

No build step, no framework — plain HTML + vanilla JS + DOM API. Each page loads the
shared `rules.js` then its own script.

## Files

- `manifest.json` — MV3. `permissions`: `declarativeNetRequest`, `storage`, `activeTab`,
  `scripting`. `optional_host_permissions`: `<all_urls>` (requested at runtime for
  all-tabs mode). No static host permissions.
- `rules.js` — **shared** helper module (loaded via `<script>` in pages and
  `importScripts()` in the worker). DNR rule building/applying, domain normalization/
  validation, `__port` helpers, `ALL_TABS_ORIGINS`. Header rules use session-rule ids
  `< 100000`; `__port` navigation-redirect rules use ids `>= 100000` (`PORT_RULE_ID_BASE`)
  so the two sets are managed independently.
- `popup.js` / `popup.html` — the toolbar popup UI (header editing).
- `options.js` / `options.html` — options dialog; **home of the "Apply headers to all
  tabs" toggle** (`applyToAllTabs`), which requests/revokes the `<all_urls>` permission.
- `background.js` — service worker: re-applies global rules on startup, and manages the
  `__port` content-script registration + navigation-redirect rules.
- `bridge.js` / `patch.js` — injected content scripts for the `__port` in-page fetch/XHR
  rewrite (ISOLATED bridge + MAIN-world patch).
- Icons: `icon16/32/48/128.png`. Corners are **transparent** (blue rounded-square body,
  white gear+arrow interior). Regenerate smaller sizes from `icon128.png`.

## Two modes (the core mental model)

The `applyToAllTabs` storage flag (set only from the **options page**) picks the mode:

- **OFF = active-tab mode (default).** Header rules are DNR session rules scoped to
  `tabIds:[currentTabId]`, authorized only by the temporary `activeTab` grant. Chrome
  **revokes that grant on cross-origin navigation**, so headers stop applying the moment
  you browse to a new site — this is inherent, not a bug to "fix" in the rules.
- **ON = all-tabs mode.** Rules apply across every tab (`tabId: null`); requires the
  `<all_urls>` permission.

The popup reads `applyToAllTabs` on open and renders accordingly (`renderMode` =
`'active'` | `'all'`).

## popup.js structure

- `init()` (bottom) is the entry point: `resolveTabContext()` (promisified
  `chrome.tabs.query`, sets `currentTabId`/`currentHost`) → read storage → set
  `renderMode` from `applyToAllTabs` → `renderPopup()`.
- `renderPopup(groups, siteChanged)`:
  - `'all'`: full domain-groups UI (`createGroup` per group), show `#add-group-btn`,
    hide flat button + footer.
  - `'active'`: **flat header list** (one `.group-rows`, `createHeaderRow` rows, no
    domain field/globe/delete-group), hide `#add-group-btn`, show `#add-header-flat-btn`
    and `#footer-warning`. Edits a single all-sites group; other domain-specific groups
    are stashed in the module var `hiddenGroups` and re-appended on save so switching
    modes is **non-destructive**.
- `readGroupsFromDom()` is mode-aware (flat list → `[{domain:'',headers}, ...hiddenGroups]`).
- **Reset-on-new-domain:** `saveAndApply` records `lastAppliedContext` `{tabId, host}` on
  each active-tab apply. On popup open in active mode, if `lastAppliedContext.host` !==
  current `currentHost`, all header toggles are forced off (+ `saveAndApply`) and the
  footer reads "Turned off — new site." No new permissions — relies on `activeTab`.
- `updateFooterWarning()` renders the active-mode footer with an "Open Options" button.
- `updatePortNotice(groupEl)` early-returns on `null` (flat rows have no `.group` parent).

## Storage keys (`chrome.storage.local`)

- `groups` — `[{ domain, headers:[{name,value,enabled}] }]`; source of truth. Empty
  `domain` = all sites. Legacy flat `headers` migrates into one group on first load.
- `applyToAllTabs` — boolean mode flag (written from options page only).
- `lastAppliedContext` — `{ tabId, host }`; where active-tab headers were last applied,
  used for reset-on-new-domain.
- `portInjectHosts` — app hostnames granted for `__port` content-script injection.
- `savedHeaders`, `valueHistory` — autocomplete UI state.

## Testing (live browser via Playwright)

There is no unit-test suite; verify changes by driving a real headed Chromium with
Playwright and inspecting the rendered popup/options + `chrome.storage.local`.

Setup:

- Launch a persistent context with the extension loaded:
  `chromium.launchPersistentContext(profileDir, { headless: false, executablePath:
  <your Playwright Chromium build>, args: ['--disable-extensions-except=<EXT_DIR>',
  '--load-extension=<EXT_DIR>'] })`.
- Grab the service worker via `ctx.serviceWorkers()[0]` (or
  `await ctx.waitForEvent('serviceworker')`). `sw.evaluate(fn)` runs in the SW global
  scope, so `rules.js`/`background.js` globals (`buildRulesFromGroups`,
  `reconcilePortScripts`, …) are directly callable, and you can seed state with
  `sw.evaluate(() => chrome.storage.local.set({...}))`.
- The extension id is the host of the service-worker URL; the popup is
  `chrome-extension://<id>/popup.html`.

Gotchas (each has cost hours):

- **Stale service-worker code is the #1 time-sink.** Relaunching `--load-extension` into
  an *existing* persistent profile keeps running the OLD cached `background.js`/`rules.js`
  — a `manifest.version` bump does NOT bust it (symptom: `sw.evaluate` throws
  `ReferenceError: <newFn> is not defined`). Fix: use a **fresh profile dir**, or with the
  browser closed delete `<profile>/Default/Service Worker` and `<profile>/Default/Code
  Cache`. Confirm fresh code by evaluating `typeof <newFn>` in the SW before trusting a
  result. (In real Chrome, reloading the unpacked extension busts the cache normally.)
- **Never hard-kill the browser** (`pkill`/SIGKILL) — an abrupt kill corrupts/wipes the
  persistent profile's `chrome.storage.local` and granted optional permissions. Handle
  SIGTERM/SIGINT and `await ctx.close()` to flush.
- If you must bump `manifest.version`, each dot segment must be **0–65535** (e.g.
  `Date.now()` overflows it and the extension silently fails to load).
- **Chrome's native optional-permission prompt can't be clicked by Playwright.** To test
  permission-gated paths, either pre-grant by adding `host_permissions` to a throwaway
  manifest copy, or seed `chrome.storage.local` and call the relevant background function
  directly.
- **Popup host context:** opening `popup.html` directly as a tab yields
  `currentHost === null` (no `activeTab` grant, so `tab.url` is hidden). To exercise the
  host-dependent paths (e.g. reset-on-new-domain), load a **test-only copy** of the
  extension with the `tabs` permission added so `tab.url` is readable — do not add `tabs`
  to the shipped `manifest.json`.

Pattern that works well for the popup: seed `chrome.storage.local` (`groups`,
`applyToAllTabs`, `lastAppliedContext`), open `popup.html`, then assert on the DOM
(group cards vs flat rows, button/footer visibility, toggle checked-state) and read back
`chrome.storage.local` to confirm persistence.

## Change log

- **2026-07-22** — Active-tab (toggle-OFF) popup UX: hide domain groups + "Add Domain
  Group" when `applyToAllTabs` is off (flat header list instead); reset all header
  toggles when the popup opens on a different site than headers were last applied to
  (new `lastAppliedContext` key, `activeTab`-only, no new perms); add an active-mode
  footer warning pointing to the all-tabs option. Files: `popup.js`, `popup.html`.
- **2026-07-22** — Icons: removed the white background (made the rounded corners
  transparent) via a 4-corner flood-fill on `icon128.png`, then regenerated
  `icon48/32/16.png` from it.
</content>
