// Isolated-world content script: derives the { domain: port } map from the user's
// stored groups and hands it to the MAIN-world patch (patch.js), which can't reach
// chrome.* itself. Reuses the helpers from rules.js (loaded before this file).
// The API-redirect rules ride along on a separate event, leaving the __port
// channel exactly as it was.
(() => {
  // A __port override is honored only for a concrete, valid domain — never for the
  // "all sites" group. Same rule the popup and the old redirect enforced.
  function buildPortMap(groups) {
    const map = {};
    (groups || []).forEach(group => {
      if (group.enabled === false) return;
      const domain = normalizeDomain(group.domain);
      if (!domain || !isValidDomain(domain)) return;
      const port = getPortOverride(group.headers);
      if (port) map[domain] = port;
    });
    return map;
  }

  // Detail is a JSON string so the object crosses the isolated→main boundary cleanly.
  function send(map) {
    window.dispatchEvent(new CustomEvent('__hcl_portmap', { detail: JSON.stringify(map) }));
  }

  function sendRedirects(rules) {
    window.dispatchEvent(new CustomEvent('__hcl_redirects', { detail: JSON.stringify(rules) }));
  }

  function load() {
    chrome.storage.local.get(
      ['groups', 'redirects', 'redirectsEnabled'],
      ({ groups, redirects, redirectsEnabled }) => {
        send(buildPortMap(groups));
        sendRedirects(redirectsEnabled ? prepareRedirects(redirects) : []);
      }
    );
  }

  // The main-world patch may init after us and request the map.
  window.addEventListener('__hcl_request', load);
  // Keep already-open tabs in sync when the popup edits config.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.groups || changes.redirects || changes.redirectsEnabled)) load();
  });

  load();
})();
