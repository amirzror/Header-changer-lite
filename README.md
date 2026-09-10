# Header Changer Lite 2

A small Chrome (Manifest V3) extension that does three things to the requests your
browser makes:

1. **Sets HTTP request headers** on the sites you choose.
2. **Redirects a domain's traffic to a different port** via a special `__port`
   pseudo-header (great for pointing a live web app at a local/dev backend without
   touching the app's code).
3. **Redirects a domain's API calls to a different domain** based on hostname
   conditions (e.g. `api.perception-point.io` → `api-internal.perception-point.io`),
   from the popup's "Domain mapping" tab.

---

## Part 1 — The "for dummies" version

Imagine every time your browser talks to a website, it sends a little envelope with
the request. This extension lets you **write extra things on that envelope** (headers)
or **change the address it's mailed to** (the port) — before it's sent.

### The two features, in plain words

**a) Add/replace headers.**
You give it a domain (e.g. `api.example.com`) and some header name/value pairs
(e.g. `Authorization: Bearer abc`). From then on, every request your browser sends to
that domain gets those headers attached. Handy for testing APIs, adding auth tokens,
spoofing a `User-Agent`, etc.

**b) Redirect a domain to a different port (`__port`).**
Say your web app normally calls `https://api.example.com` (port 443, the default), but
you're running a dev copy of that API on your machine at port `4791`. Add a header
named `__port` with value `4791` to that domain's group, click **Grant** once, and now
the app's calls quietly go to `https://api.example.com:4791` instead — **without editing
the app**. The app doesn't know; it thinks it's talking to the normal address.

**c) Redirect a domain's API calls to a different domain.**
The popup has two tabs: **Headers** and **Domain mapping**. In the redirects tab, each
rule reads *if the hostname \<equals / starts with / ends with / contains\>
\<pattern\>, send the request to \<new domain\>*. Example: `equals
api.perception-point.io → api-internal.perception-point.io` makes the app you enabled
call `api-internal.perception-point.io` instead — **without editing the app**. Turn on
the toggle, click **Grant on \<your site\>** once, reload, and the app's `fetch`/XHR
calls are rewritten. Path, query and port are kept — only the hostname changes.

### Is it magic? What's the catch?

- The port feature covers the two ways you reach that domain: **calls the page's
  JavaScript makes** (`fetch` / axios / `XMLHttpRequest` — how web apps talk to APIs)
  **and direct visits** (typing the address / a full-page navigation). It does not touch
  things like image or script tags.
- You have to click **Grant** (or **Enable**) once per app site, and **reload the tab**
  for it to kick in.
- The dev server on the new port still has to allow your app to talk to it (CORS) — the
  extension doesn't fake that.

That's really it. Set a domain, add headers (and optionally `__port`), grant, reload.

---

## Part 2 — Is this a proxy?

**No.** This is a common point of confusion, so here's the distinction.

A **proxy** is a *separate server* that sits in the middle: your browser sends the
request to the proxy, the proxy forwards it to the real destination, gets the response,
and passes it back. Traffic physically flows **through** another machine/process, which
can inspect, log, cache, or rewrite anything.

This extension is **not** that. Nothing is routed through any server. It's a
**client-side request modifier** that changes requests *in your own browser* right
before they go out, using two built-in browser mechanisms:

- **Headers** are changed by Chrome's own **declarativeNetRequest** engine (a rule you
  give the browser: "when you send a request to X, also set header Y").
- **The port** is changed by **rewriting the URL inside the page** before the request
  is handed to the network stack.

In both cases the browser still opens a **direct** connection to the destination. There
is no man-in-the-middle server.

| | This extension | A proxy (e.g. Charles, mitmproxy, corporate proxy) |
|---|---|---|
| Extra server in the path? | No | Yes |
| Where changes happen | In your browser, before send | On the proxy server, in transit |
| Can it see/modify response bodies? | No (only sets request headers / URL) | Yes, anything |
| Can it decrypt HTTPS? | No — never sees the encrypted stream | Yes (with its own cert installed) |
| Affects other apps on your machine? | No — only this browser profile | Often yes (system-wide) |
| Setup | Install extension, click Grant | Configure system/network proxy + trust cert |

Think of it as **"editing the outgoing envelope"**, not **"mailing everything through a
middleman."**

The closest well-known cousins are extensions like **ModHeader** or **Requestly** —
same category (client-side request modifiers), not proxies.

---

## Part 3 — How it works (in depth)

The extension has **three independent subsystems**. They share a few helpers but solve
different problems with different browser APIs.

### Subsystem A — Header modification (declarativeNetRequest)

This is the classic path and uses no content scripts.

- You define **groups** in the popup. A group = one domain (blank = "all sites") + a
  list of header rows (`name`, `value`, `enabled`).
- `rules.js#buildRulesFromGroups()` turns enabled groups into
  [`declarativeNetRequest`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
  **session rules** with a `modifyHeaders` action (`operation: "set"`).
- `rules.js#buildRequestHeaders()` maps header rows to specs, **skipping** the reserved
  `__port` name and any **malformed header name** (an invalid name would make Chrome
  reject the whole rule batch).
- Scope:
  - Default: rules are scoped to the **active tab** (`condition.tabIds`), matching the
    manifest description "for the active tab only."
  - Optional **"apply to all tabs"** (in Options): requests the `<all_urls>` host
    permission and applies rules with no tab scope. `background.js#reapplyGlobalRules()`
    re-applies these on browser startup, since session rules are cleared on restart.

The browser's own network engine enforces these rules — the extension just declares
them.

### Subsystem B — `__port` port rewrite (in-page fetch/XHR override)

This is the interesting one, and it went through a redesign. Read the "why" — it
explains a real browser-security constraint.

#### Why not just redirect the port?

The obvious approach is a `declarativeNetRequest` **redirect** that rewrites the port
(`transform: { port }`). **This does not work for a web app's API calls**, and here's
the exact reason:

- A **port is part of the web origin.** `https://api.example.com` (443) and
  `https://api.example.com:4791` are *different origins*.
- So a redirect from one to the other is an **origin-changing redirect**, and for a
  cross-origin `fetch`/`XHR` the browser applies a **CORS check to the redirect
  response itself** — that 307 must carry `Access-Control-Allow-Origin`.
- A declarativeNetRequest-**synthesized** redirect carries only a `Location` header — no
  CORS headers, and the extension **cannot** add them to it. So the browser refuses to
  follow the redirect and **aborts the request** (`net::ERR_ABORTED`). Every API call
  dies. (It *looks* fine for top-level navigations, which aren't CORS — which is why the
  bug is sneaky.)

#### What actually works: rewrite the URL in the page

Instead of redirecting, we change the URL **before the request leaves the page**, so
there is **no redirect hop** and therefore no redirect-CORS check. The request is a
single, ordinary cross-origin call that the server's normal CORS headers already cover.

The only way to intercept an outgoing request's URL from an extension (short of a
network redirect) is to **override the page's own `fetch` and `XMLHttpRequest`**. That
requires running code in the page's **MAIN world** (its real JS environment), which a
normal "isolated world" content script can't touch.

> **Navigations are the exception.** A *top-level navigation* (typing the URL, a
> full-page nav) isn't made by page JavaScript, so the content script can't catch it —
> but a navigation is **not** a CORS request, so the redirect-CORS problem doesn't apply
> to it. For that case we keep a `declarativeNetRequest` **redirect** rule scoped to
> `resourceTypes: ['main_frame','sub_frame']` (see `rules.js#buildRulesFromGroups`). It
> never touches `xmlhttprequest`, so it can't reintroduce the CORS breakage. Net result:
> **fetch/XHR → in-page rewrite; direct visits → 307 redirect.**

So the fetch/XHR half is split across two content scripts plus the background worker:

| File | World | Job |
|---|---|---|
| `patch.js` | **MAIN** | Overrides `window.fetch` and `XMLHttpRequest.prototype.open`. Rewrites any request whose host matches a `__port` domain (exact host or subdomain) or an API-redirect rule (see Subsystem C). Can't use `chrome.*`. |
| `bridge.js` | **ISOLATED** | Can use `chrome.*`. Reads the groups, redirect rules and master toggle from storage, builds the `{ ports, redirects }` config, and hands it to `patch.js`. |
| `background.js` | Service worker | Decides **where** those scripts get injected and registers/unregisters them dynamically. |

**Config delivery (MAIN ⇄ ISOLATED):** MAIN-world code has no `chrome.*` access, so
`bridge.js` (isolated) reads `chrome.storage.local`, builds the port map, and sends it
to `patch.js` via a `CustomEvent` whose `detail` is a **JSON string** (strings cross the
world boundary cleanly). `patch.js` `await`s that map before letting the first `fetch`
through (with a 1.5s fallback so it never hangs the page), and patches the XHR
**prototype** so it works even for XHR references captured before it ran.

#### The permission model (scoped, on-demand)

The port rewrite must run in the page that **makes** the calls — your **frontend app**
(e.g. `xray.example.com`), *not* the API domain you type into the group. But we don't
want the scary "read and change all your data on all websites" prompt at install. So:

- The manifest declares **no static content scripts** and only
  `optional_host_permissions: ["<all_urls>"]` plus the `scripting` API permission.
- When a group has a valid `__port`, the popup shows a **"Grant on `<current-site>`"**
  button. In one prompt it requests **two** things: the **app host** you're on (so the
  content script can be injected for the fetch/XHR rewrite) **and** the **API domain**
  itself (so the `declarativeNetRequest` navigation redirect is allowed). Both are
  specific origins — never `<all_urls>`.
- The background then registers the content scripts for **only that app origin** and
  applies the navigation-redirect rule. Nothing happens until you explicitly grant.

#### Lifecycle / registration (`background.js`)

- `portInjectHosts` (in `chrome.storage.local`) is the list of app origins you've
  enabled the rewrite on — shared by `__port` and the API redirects.
- `reconcilePortScripts()` is the single source of truth. It:
  1. keeps only hosts you still hold permission for (prunes revoked ones),
  2. clears the extension's existing registrations,
  3. if any enabled group has a valid `__port` **or** active API-redirect rules,
     **and** there's ≥1 granted host, registers `hcl-bridge` (isolated) and
     `hcl-patch` (MAIN) for those origins, `runAt: document_start`,
     `persistAcrossSessions: true`.
- It's **serialized** (chained promises) and **self-healing** (retry once on collision)
  so overlapping triggers can't cause "Duplicate script ID".
- It's triggered by: `onStartup`/`onInstalled`, `storage.onChanged` (groups,
  `portInjectHosts`, `redirects` or `redirectsEnabled`), and
  `permissions.onAdded`/`onRemoved`.

**The popup-closes-on-prompt gotcha (important):** Chrome's native permission prompt
**closes the popup**, destroying its JavaScript before any code after
`chrome.permissions.request()` can run. So the real work is done in the **background**
via `permissions.onAdded` → `onPortHostsGranted()`: it derives the host from the granted
origin, records it in `portInjectHosts`, registers the scripts, and **reloads matching
tabs** (content scripts only inject on page load). When the permission is *already*
held, no prompt shows, the popup survives, and it finishes the job itself (and asks the
background to reconcile before reloading).

### Subsystem C — API redirects (hostname rewrite in the page)

Configured in the popup's **Domain mapping** tab: a master toggle plus condition rows
(*hostname \<equals / starts with / ends with / contains\> \<pattern\> →
\<new domain\>*). Applies **only to the `fetch`/XHR calls made by pages on sites you
explicitly enabled** — there is deliberately no navigation redirect and no
`declarativeNetRequest` involvement:

- A DNR redirect of a fetch/XHR is an origin-changing redirect that fails CORS
  (Subsystem B explains why). Rewriting the URL **in the page before the request goes
  out** avoids the redirect hop entirely, so the call is a single ordinary
  cross-origin request that the target server's normal CORS headers cover.
- Storage: `redirects` = `[{ match, from, to, enabled }]`, `redirectsEnabled` (master
  toggle). Rows have their own on/off toggle; toggled-off rows stay saved but aren't
  applied. `rules.js#prepareRedirects()` validates/normalizes the entries before
  they're shipped to the page; unusable rows are dropped (and flagged red in the popup).
- `bridge.js` sends `{ ports, redirects }` to `patch.js` (rules only while the master
  toggle is on); `patch.js` applies the **first matching rule's** target host, then
  the `__port` port map against the *new* host — so a host redirect and a port
  override compose. Path, query and explicit port are preserved. The rewrite happens
  once per request in the page, so a rule whose target also matches its pattern is
  just a no-op — no redirect loops.
- **Injection/permissions:** same model as `__port`. The rewrite must run in the page
  that makes the calls, so the popup's redirects tab shows a **"Grant on
  \<current-site\>"** button requesting only that site's origin (`optional_host_permissions`
  — nothing static). Granted sites are tracked in `portInjectHosts`;
  `background.js#reconcilePortScripts()` registers `hcl-bridge`/`hcl-patch` for
  those sites whenever a `__port` override or active redirect rules exist, and
  unregisters otherwise. The background's `permissions.onAdded` handler finishes the
  job (record host, register, reload matching tabs) when the prompt closes the popup.
- Mock defaults (`DEFAULT_REDIRECTS` in `rules.js`) are seeded once on first run so
  the tab isn't empty; edit or replace them freely.

### File map

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `declarativeNetRequest`, `storage`, `activeTab`, `scripting`; optional `<all_urls>`. |
| `popup.html` / `popup.js` | Main UI, two tabs: **Headers** (domain groups, header rows with autocomplete, the `__port` status/grant notice) and **Domain mapping** (redirect rules + master toggle + per-site Grant). |
| `options.html` / `options.js` | The "apply headers to all tabs" toggle + its `<all_urls>` permission request. |
| `background.js` | Service worker: re-applies header rules on startup; owns dynamic content-script registration for the in-page rewrite (`__port` and API redirects). |
| `rules.js` | Shared helpers (rule building, domain normalize/validate, port parsing, header-name validation, redirect-rule normalize/validate). Loaded in the popup/options pages, `importScripts()`'d in the worker, **and** injected as part of the isolated content script. |
| `patch.js` | MAIN-world content script — the actual `fetch`/XHR rewrite (ports + hostnames). |
| `bridge.js` | ISOLATED-world content script — feeds the port map to `patch.js`. |

### Permissions, explained

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Set request headers via browser rules. |
| `storage` | Persist your groups / settings. |
| `activeTab` | Scope header rules to the current tab by default. |
| `scripting` | Dynamically register the `__port` content scripts. (This alone grants **no** site access.) |
| `optional_host_permissions: <all_urls>` | Lets the extension **request** access to a specific site at runtime — the "apply to all tabs" toggle and the per-site `__port` Grant. Nothing is granted until you click. |

### Limitations / things to know

- **`__port` covers `fetch`/XHR and top-level navigations** — not `<img>`/`<script>`
  subresources, `EventSource`, or WebSockets. That matches the intended use (redirecting
  an app's API traffic and direct visits).
- **What you see in the Network tab differs by request type.** A `fetch`/XHR call goes
  **directly** to the new port (single `200`, no redirect row) — the in-page rewrite. A
  **direct navigation** shows a `307` redirect to the new port — the declarativeNetRequest
  rule. Both are expected.
- **Domain redirects cover `fetch`/XHR only, on sites you enabled** — typing a
  matching domain in the address bar navigates normally (by design: no navigation
  redirect). The rewrite applies to the first matching rule per request.
- **CORS is still the server's job.** The target domain must return proper CORS
  headers for your app's origin. The extension removes the *redirect* problem, not
  the server's CORS responsibility.
- **Reload after granting.** Content scripts inject on page load; the Grant flow reloads
  the tab for you, but an already-open tab needs a reload to pick it up.
- A group domain like `fortimail.io` matches **all** its subdomains. Use the full host
  (`api.foo.fortimail.io`) to be precise.
