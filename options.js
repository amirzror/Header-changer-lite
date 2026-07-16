const toggle = document.getElementById('all-tabs-toggle');
const status = document.getElementById('status');

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

// Reflect current setting + permission state on load.
async function init() {
  const { applyToAllTabs } = await chrome.storage.local.get(['applyToAllTabs']);
  const granted = await chrome.permissions.contains(ALL_TABS_ORIGINS);
  const on = !!applyToAllTabs && granted;
  toggle.checked = on;

  if (applyToAllTabs && !granted) {
    setStatus('Permission was revoked — re-enable to apply headers to all tabs.', 'warn');
    await chrome.storage.local.set({ applyToAllTabs: false });
  } else if (on) {
    setStatus('Enabled — headers apply to every tab.', 'ok');
  } else {
    setStatus('Headers apply to the active tab only.');
  }
}

toggle.addEventListener('change', async () => {
  if (toggle.checked) {
    // chrome.permissions.request only shows Chrome's prompt when it is the FIRST
    // call in the user-gesture handler. Any await before it (e.g. reading storage)
    // consumes the gesture and Chrome silently refuses to prompt — so request first.
    const granted = await chrome.permissions.request(ALL_TABS_ORIGINS);
    if (!granted) {
      toggle.checked = false;
      setStatus('Permission denied — still applying to the active tab only.', 'warn');
      return;
    }
    const { groups } = await chrome.storage.local.get(['groups']);
    await chrome.storage.local.set({ applyToAllTabs: true });
    await applyRules(buildRulesFromGroups(groups || [], { tabId: null }));
    setStatus('Enabled — headers apply to every tab.', 'ok');
  } else {
    await chrome.storage.local.set({ applyToAllTabs: false });
    await clearAllRules();
    // Revoke the broad host permission — no longer needed.
    const removed = await chrome.permissions.remove(ALL_TABS_ORIGINS);
    if (removed) {
      setStatus('Headers apply to the active tab only. All-sites permission revoked.');
    } else {
      setStatus('Headers apply to the active tab only.', 'warn');
    }
  }
});

init();
