// Monitor updates to storage
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.headers) {
    updateRules(changes.headers.newValue || []);
  }
});

// Run initialization configuration on installation profile sync
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['headers'], (result) => {
    updateRules(result.headers || []);
  });
});

async function updateRules(headers) {
  // 1. Clear all existing dynamic rules to cleanly cycle modifications
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map(rule => rule.id);

  const addRules = [];
  
  // 2. Filter out rows that are explicitly turned OFF (enabled === false)
  const activeHeaders = headers.filter(h => h.enabled === true && h.name);

  if (activeHeaders.length > 0) {
    // 3. Map only active row variables into valid NetRequest modify configurations
    const requestHeaders = activeHeaders.map(h => ({
      header: h.name,
      operation: 'set',
      value: h.value
    }));

    addRules.push({
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: requestHeaders
      },
      condition: {
        urlFilter: '*', 
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script", "image", 
          "font", "object", "xmlhttprequest", "ping", "csp_report", 
          "media", "websocket", "other"
        ]
      }
    });
  }

  // 4. Update the browser configuration layer
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
  
  console.log(`Dynamic sync complete. Applied rules for ${activeHeaders.length} active headers.`);
}