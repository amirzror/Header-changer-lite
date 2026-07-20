// Shared declarativeNetRequest helpers used by popup.js, background.js and options.js.
// Loaded via <script> in HTML pages and importScripts() in the service worker.

const RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

// Host permission requested when the user enables "apply to all tabs".
const ALL_TABS_ORIGINS = { origins: ["<all_urls>"] };

// Pseudo-header. Instead of being sent on the wire, it rewrites the port of the
// outgoing request. The rewrite happens in-page (patch.js overrides fetch/XHR),
// not via a redirect — see buildRulesFromGroups. Only honored when a concrete
// domain is set on the group — never for the "all sites" group.
const PORT_HEADER = '__port';

// A pseudo/reserved header controls the extension rather than being sent as an
// actual HTTP header, so it must be excluded from modifyHeaders specs.
function isReservedHeader(name) {
  return String(name || '').trim().toLowerCase() === PORT_HEADER;
}

// A valid HTTP header name is an RFC 7230 "token". Anything else — a space, a
// colon, a partially-typed name — makes declarativeNetRequest reject the ENTIRE
// updateSessionRules call ("must specify a valid header name"), which would other-
// wise throw in saveAndApply and, with "apply to all tabs" on, at worker startup.
function isValidHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(name || ''));
}

// Map stored header entries to declarativeNetRequest modifyHeaders specs. Skips
// reserved (__port) and malformed names, and coerces the value to a string.
function buildRequestHeaders(headers) {
  return (headers || [])
    .filter(h => h.enabled && h.name && !isReservedHeader(h.name) && isValidHeaderName(h.name))
    .map(h => ({ header: h.name, operation: 'set', value: String(h.value == null ? '' : h.value) }));
}

// Pull a valid port (1-65535) from an enabled __port header, or null.
function getPortOverride(headers) {
  const h = (headers || []).find(
    x => x.enabled && x.name && x.name.trim().toLowerCase() === PORT_HEADER
  );
  if (!h) return null;
  const port = String(h.value == null ? '' : h.value).trim();
  if (!/^\d{1,5}$/.test(port)) return null;
  const n = Number(port);
  if (n < 1 || n > 65535) return null;
  return port;
}

// Clean up whatever the user typed/pasted into a domain field:
// strip scheme, path, query, port, userinfo, surrounding dots/spaces; lowercase.
// "https://api.domain.com/path?x=1" -> "api.domain.com"
function normalizeDomain(input) {
  if (!input) return '';
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme://
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.split('@').pop();                        // strip user:pass@
  d = d.split(':')[0];                           // strip :port
  d = d.replace(/^\.+|\.+$/g, '');               // strip leading/trailing dots
  return d;
}

// Loose sanity check so we never feed Chrome an invalid domain (which throws).
function isValidDomain(d) {
  if (!d) return false;
  if (d === 'localhost') return true;
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d);
}

// Build the full set of session rules from the user's domain groups.
// tabId != null  -> scope every rule to that tab (active-tab mode)
// tabId == null  -> apply across all tabs (needs the all-tabs permission)
function buildRulesFromGroups(groups, { tabId = null } = {}) {
  const rules = [];
  let id = 1;
  (groups || []).forEach(group => {
    if (group.enabled === false) return;

    const domain = normalizeDomain(group.domain);
    // A non-empty but invalid domain pauses the group rather than silently
    // widening its scope to every site.
    if (group.domain && !isValidDomain(domain)) return;

    const requestHeaders = buildRequestHeaders(group.headers);
    if (requestHeaders.length > 0) {
      const condition = { resourceTypes: RESOURCE_TYPES };
      if (domain) condition.requestDomains = [domain];
      if (tabId != null) condition.tabIds = [tabId];

      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition
      });
    }

    // __port is handled in-page by patch.js (a fetch/XHR URL rewrite), not here.
    // A declarativeNetRequest redirect can't change the port for cross-origin
    // XHR: the resulting 307 fails the CORS check because it carries no
    // Access-Control-Allow-Origin, and the browser aborts the request.
  });
  return rules;
}

// Replace all of our session rules with a fresh set (this extension owns every
// session rule it creates, so clearing them all is safe and avoids id bookkeeping).
async function applyRules(rules) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map(r => r.id),
    addRules: rules
  });
}

async function clearAllRules() {
  await applyRules([]);
}
