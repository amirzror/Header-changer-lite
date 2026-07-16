chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId]
  });
});