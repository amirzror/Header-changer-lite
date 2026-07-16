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
