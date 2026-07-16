const container = document.getElementById('headers-container');
const addBtn = document.getElementById('add-row-btn');
const statusBadge = document.getElementById('status');
const saveStatus = document.getElementById('save-status');

let currentTabId = null;
let debounceTimeout = null;

// 1. Resolve current active tab context
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs && tabs[0]) {
    const activeTab = tabs[0];
    currentTabId = activeTab.id;
    try {
      const url = new URL(activeTab.url);
      statusBadge.textContent = `Target: ${url.hostname}`;
    } catch (e) {
      statusBadge.textContent = `Target: Active Tab`;
    }
  }
});

// 2. Hydrate popup DOM from local storage on load
chrome.storage.local.get(['headers'], (result) => {
  const headers = result.headers || [];
  if (headers.length === 0) {
    createHeaderRow('', '', true); 
  } else {
    headers.forEach(h => createHeaderRow(h.name, h.value, h.enabled ?? true));
  }
});

// 3. Debounced auto-save triggers to block UI lag while typing
function triggerAutoSave() {
  saveStatus.textContent = "Saving...";
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(saveAndApply, 250); 
}

// 4. Core Save & Apply execution block
async function saveAndApply() {
  if (!currentTabId) return;

  const rows = container.querySelectorAll('.header-row');
  const headers = [];

  rows.forEach(row => {
    const enabled = row.querySelector('.toggle-chk').checked;
    const name = row.querySelector('.header-name').value.trim();
    const value = row.querySelector('.header-value').value.trim();
    if (name) {
      headers.push({ name, value, enabled });
    }
  });

  // Persist to storage profile
  chrome.storage.local.set({ headers }, async () => {
    const activeHeaders = headers.filter(h => h.enabled && h.name);

    if (activeHeaders.length > 0) {
      const requestHeaders = activeHeaders.map(h => ({
        header: h.name,
        operation: 'set',
        value: h.value
      }));

      const tabRule = {
        id: currentTabId,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          tabIds: [currentTabId],
          resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"]
        }
      };

      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [currentTabId],
        addRules: [tabRule]
      });
    } else {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [currentTabId]
      });
    }
    saveStatus.textContent = "Saved";
  });
}

// 5. Generate row layout structure with attached reactive auto-save hooks
function createHeaderRow(name = '', value = '', enabled = true) {
  const row = document.createElement('div');
  row.className = 'header-row';
  if (!enabled) row.classList.add('disabled');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'toggle-chk';
  checkbox.checked = enabled;
  checkbox.onchange = () => {
    row.classList.toggle('disabled', !checkbox.checked);
    saveAndApply(); // Checkbox states trigger instantly
  };

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Header-Name';
  nameInput.value = name;
  nameInput.className = 'header-name';
  nameInput.addEventListener('input', triggerAutoSave);

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Value';
  valueInput.value = value;
  valueInput.className = 'header-value';
  valueInput.addEventListener('input', triggerAutoSave);

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '✕';
  deleteBtn.className = 'delete-btn';
  deleteBtn.onclick = () => {
    row.remove();
    saveAndApply(); // Removals trigger instantly
  };

  row.appendChild(checkbox);
  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(deleteBtn);
  container.appendChild(row);
}

addBtn.onclick = () => {
  createHeaderRow('', '', true);
  saveAndApply();
};