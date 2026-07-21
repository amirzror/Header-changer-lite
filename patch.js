// MAIN-world content script: rewrites the PORT of outgoing fetch/XHR requests whose
// host matches a user-configured __port domain, by pointing the request straight at
// the new port. This replaces the old declarativeNetRequest redirect.
//
// Why in-page instead of a redirect: a port change is an origin change, so a 307
// port-rewrite redirect is subject to a CORS check and must itself carry
// Access-Control-Allow-Origin — which a declarativeNetRequest-synthesized redirect
// cannot. The browser therefore refuses to follow it and aborts every cross-origin
// XHR. Requesting the new port directly has no redirect hop, so that check never
// applies; the request is a single plain cross-origin call the server's normal CORS
// headers already cover.
//
// This world can't use chrome.* — the { domain: port } map is delivered from the
// isolated-world bridge.js via a CustomEvent carrying a JSON string.
(() => {
  let portMap = {};              // { "domain.com": "4791" }
  let gotConfig = false;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  // Never hang the page if the bridge is silent: proceed with an empty map (no-op).
  setTimeout(() => resolveReady(), 1500);

  // Match a host against a configured domain: exact host or a subdomain of it,
  // mirroring declarativeNetRequest's requestDomains subdomain matching.
  function portFor(hostname) {
    const h = hostname.toLowerCase();
    for (const domain in portMap) {
      if (h === domain || h.endsWith('.' + domain)) return portMap[domain];
    }
    return null;
  }

  function rewrite(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const port = portFor(url.hostname);
      if (port && url.port !== String(port)) {
        url.port = String(port);
        return url.toString();
      }
    } catch (e) { /* relative/opaque/non-URL input — leave untouched */ }
    return rawUrl;
  }

  // Receive the port map from the bridge (isolated world). Detail is a JSON string
  // so it crosses the world boundary cleanly.
  window.addEventListener('__hcl_portmap', (e) => {
    try { portMap = JSON.parse(e.detail) || {}; } catch { portMap = {}; }
    gotConfig = true;
    resolveReady();
  });
  // Ask the bridge to (re)send the map — covers either script initializing first.
  window.dispatchEvent(new CustomEvent('__hcl_request'));

  // ── fetch ──────────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (input, init) {
      if (!gotConfig) await ready;   // fetch already returns a promise, so this is free
      if (typeof input === 'string') {
        return origFetch.call(this, rewrite(input), init);
      }
      if (input instanceof Request) {
        const url = rewrite(input.url);
        return origFetch.call(this, url === input.url ? input : new Request(url, input), init);
      }
      return origFetch.call(this, input, init);
    };
  }

  // ── XMLHttpRequest (axios uses this) ─────────────────────────────────────────
  // Patch the prototype so it applies even to XHR references captured before us.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return origOpen.call(this, method, rewrite(url), ...rest);
  };
})();
