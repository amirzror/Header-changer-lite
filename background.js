importScripts('rules.js');

// Session rules are cleared on browser restart. If "apply to all tabs" is on,
// re-apply the domain-group rules so background/non-active tabs are covered again.
async function reapplyGlobalRules() {
  const { applyToAllTabs, groups } = await chrome.storage.local.get(['applyToAllTabs', 'groups']);
  if (!applyToAllTabs) return;
  const granted = await chrome.permissions.contains(ALL_TABS_ORIGINS);
  if (granted) {
    await applyRules(buildRulesFromGroups(groups || [], { tabId: null }));
  }
}

chrome.runtime.onStartup.addListener(reapplyGlobalRules);
chrome.runtime.onInstalled.addListener(reapplyGlobalRules);

// ── __port in-page rewrite: dynamic, per-site content-script registration ─────
// The port rewrite (patch.js) must run in the page that *makes* the requests — the
// user's app — so we inject only on origins the user has explicitly granted
// (tracked in storage as `portInjectHosts`). Scripts are registered only while at
// least one enabled group actually has a valid __port, so nothing is injected until
// the feature is in use.

const PORT_SCRIPT_IDS = ['hcl-bridge', 'hcl-patch'];

function anyGroupWantsPort(groups) {
  return (groups || []).some(g => {
    if (g.enabled === false) return false;
    const d = normalizeDomain(g.domain);
    return d && isValidDomain(d) && getPortOverride(g.headers);
  });
}

// Serialize reconcile: several events (a grant firing permissions.onAdded plus the
// portInjectHosts storage write, say) can call this near-simultaneously, and two
// overlapping runs collide on register/unregister ("Duplicate script ID"). Chaining
// guarantees one runs at a time.
let portReconcileChain = Promise.resolve();
function reconcilePortScripts() {
  portReconcileChain = portReconcileChain
    .then(doReconcilePortScripts)
    .catch(e => console.error('reconcilePortScripts failed:', e));
  return portReconcileChain;
}

// Remove our registrations if present. Tolerates "not registered" so it's safe to
// call unconditionally.
async function unregisterPortScripts() {
  try {
    const all = await chrome.scripting.getRegisteredContentScripts();
    const ids = all.filter(s => PORT_SCRIPT_IDS.includes(s.id)).map(s => s.id);
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch (e) { /* nothing registered / transient — ignore */ }
}

function portScriptSpecs(matches) {
  return [
    { id: 'hcl-bridge', matches, js: ['rules.js', 'bridge.js'], runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true },
    { id: 'hcl-patch', matches, js: ['patch.js'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true },
  ];
}

async function doReconcilePortScripts() {
  const { groups, portInjectHosts } = await chrome.storage.local.get(['groups', 'portInjectHosts']);

  // Keep only hosts we still hold permission for (the user may have revoked one).
  const hosts = Array.isArray(portInjectHosts) ? portInjectHosts : [];
  const granted = [];
  for (const host of hosts) {
    if (await chrome.permissions.contains({ origins: [`*://${host}/*`] })) granted.push(host);
  }

  // Clear our registrations up front so the state is always rebuilt from scratch.
  await unregisterPortScripts();

  // Prune revoked hosts. The write re-triggers reconcile, which then does the
  // registration with the pruned list — so return here rather than register twice.
  if (granted.length !== hosts.length) {
    await chrome.storage.local.set({ portInjectHosts: granted });
    return;
  }

  if (!anyGroupWantsPort(groups) || granted.length === 0) return;

  const specs = portScriptSpecs(granted.map(h => `*://${h}/*`));
  try {
    await chrome.scripting.registerContentScripts(specs);
  } catch (e) {
    // Lost a race with a persisted/concurrent registration: clear and retry once.
    await unregisterPortScripts();
    await chrome.scripting.registerContentScripts(specs);
  }
}

chrome.runtime.onStartup.addListener(reconcilePortScripts);
chrome.runtime.onInstalled.addListener(reconcilePortScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.groups || changes.portInjectHosts)) reconcilePortScripts();
});
// When the permission is already held, no prompt shows and the popup survives; it
// then awaits this so it can reload the tab only after the script is registered.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'reconcilePortScripts') {
    reconcilePortScripts().then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for the async response
  }
});
// When a specific-host permission is granted, the BACKGROUND must finish the job.
// The popup's Grant button calls chrome.permissions.request(), whose native prompt
// closes the popup — so any code after it resolves in the popup never runs. Here we
// record the host, register the content script, and reload matching tabs so the
// rewrite takes effect. Fires in the service worker, which outlives the popup.
async function onPortHostsGranted(origins) {
  // Concrete hosts only: "*://host/*". Skips <all_urls> and "*://*.domain/*"
  // (wildcard-subdomain grants from the old redirect flow), which aren't app hosts.
  const hosts = (origins || [])
    .map(o => { const m = /^\*:\/\/([^/*][^/]*)\/\*$/.exec(o); return m ? m[1] : null; })
    .filter(Boolean);
  if (!hosts.length) { await reconcilePortScripts(); return; }

  const { portInjectHosts } = await chrome.storage.local.get('portInjectHosts');
  const list = Array.isArray(portInjectHosts) ? portInjectHosts : [];
  for (const h of hosts) if (!list.includes(h)) list.push(h);
  await chrome.storage.local.set({ portInjectHosts: list });
  await reconcilePortScripts();

  // Content scripts inject only on load, so reload tabs already open on the host.
  for (const h of hosts) {
    try {
      const tabs = await chrome.tabs.query({ url: `*://${h}/*` });
      for (const tb of tabs) chrome.tabs.reload(tb.id);
    } catch (e) { /* no matching tabs / no permission — ignore */ }
  }
}

chrome.permissions.onAdded.addListener((perms) => onPortHostsGranted(perms.origins));
chrome.permissions.onRemoved.addListener(reconcilePortScripts);
