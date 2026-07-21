// Shared declarativeNetRequest helpers used by popup.js, background.js and options.js.
// Loaded via <script> in HTML pages and importScripts() in the service worker.

const RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

// Host permission requested when the user enables "apply to all tabs".
const ALL_TABS_ORIGINS = { origins: ["<all_urls>"] };

// Pseudo-header. Instead of being sent on the wire, it rewrites the port of the
// outgoing request, two ways depending on request type:
//   - fetch/XHR  -> rewritten in-page by patch.js (a redirect would break CORS).
//   - navigations-> declarativeNetRequest redirect (see buildRulesFromGroups).
// Only honored when a concrete domain is set on the group — never for "all sites".
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

// Host-permission origins needed to redirect (port-rewrite) NAVIGATIONS to a domain
// and its subdomains. declarativeNetRequest's redirect action requires host
// permission for the request being redirected.
function portOrigins(domain) {
  return { origins: [`*://${domain}/*`, `*://*.${domain}/*`] };
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

    // __port NAVIGATION redirects are NOT built here. They are a separate, global,
    // persistent rule set (buildPortRedirectRules / applyPortRedirectRules) managed
    // by the background worker — because a navigation can happen in any tab and must
    // survive independently of the active-tab header rules. fetch/XHR are handled
    // in-page by patch.js.
  });
  return rules;
}

// Header rules use ids 1..N; __port navigation-redirect rules live in a separate high
// id range so the two sets can be managed independently on the shared session-rule set.
const PORT_RULE_ID_BASE = 100000;

// Build the __port NAVIGATION redirect rules: global (no tab scoping) and limited to
// main_frame/sub_frame so they never touch fetch/XHR (which patch.js rewrites in-page;
// a redirect there would break CORS). Added unconditionally — Chrome silently ignores
// a redirect rule for a domain the extension lacks host permission for, so the rule
// simply starts firing once the user grants that domain.
function buildPortRedirectRules(groups) {
  const rules = [];
  let id = PORT_RULE_ID_BASE;
  (groups || []).forEach(group => {
    if (group.enabled === false) return;
    const domain = normalizeDomain(group.domain);
    if (!domain || !isValidDomain(domain)) return;
    const port = getPortOverride(group.headers);
    if (!port) return;
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { transform: { port } } },
      condition: { resourceTypes: ['main_frame', 'sub_frame'], requestDomains: [domain] }
    });
  });
  return rules;
}

// Replace the HEADER session rules (ids < PORT_RULE_ID_BASE), leaving the __port
// navigation-redirect rules untouched.
async function applyRules(rules) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const headerIds = existing.filter(r => r.id < PORT_RULE_ID_BASE).map(r => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: headerIds, addRules: rules });
}

// Replace the __port navigation-redirect rules (ids >= PORT_RULE_ID_BASE), leaving the
// header rules untouched.
async function applyPortRedirectRules(groups) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const portIds = existing.filter(r => r.id >= PORT_RULE_ID_BASE).map(r => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: portIds,
    addRules: buildPortRedirectRules(groups),
  });
}

async function clearAllRules() {
  await applyRules([]);
}
