// Shared declarativeNetRequest helpers used by popup.js, background.js and options.js.
// Loaded via <script> in HTML pages and importScripts() in the service worker.

const RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

// Host permission requested when the user enables "apply to all tabs".
const ALL_TABS_ORIGINS = { origins: ["<all_urls>"] };

// Map stored header entries to declarativeNetRequest modifyHeaders specs.
function buildRequestHeaders(headers) {
  return (headers || [])
    .filter(h => h.enabled && h.name)
    .map(h => ({ header: h.name, operation: 'set', value: h.value }));
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
    const requestHeaders = buildRequestHeaders(group.headers);
    if (requestHeaders.length === 0) return;

    const domain = normalizeDomain(group.domain);
    // A non-empty but invalid domain pauses the group rather than silently
    // widening its scope to every site.
    if (group.domain && !isValidDomain(domain)) return;

    const condition = { resourceTypes: RESOURCE_TYPES };
    if (domain) condition.requestDomains = [domain];
    if (tabId != null) condition.tabIds = [tabId];

    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition
    });
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
