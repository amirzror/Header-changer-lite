const container = document.getElementById('groups-container');
const addGroupBtn = document.getElementById('add-group-btn');
const statusBadge = document.getElementById('status');
const saveStatus = document.getElementById('save-status');
const knownHeadersList = document.getElementById('known-headers');
const knownValuesList = document.getElementById('known-values');
const optionsBtn = document.getElementById('options-btn');

let currentTabId = null;
let currentHost = null;
let debounceTimeout = null;

optionsBtn.onclick = () => chrome.runtime.openOptionsPage();

// Well-known HTTP request headers offered as name autocomplete suggestions
const COMMON_HEADERS = [
  'Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language',
  'Authorization', 'Cache-Control', 'Connection', 'Content-Length',
  'Content-Type', 'Cookie', 'DNT', 'Host', 'If-Match', 'If-Modified-Since',
  'If-None-Match', 'Origin', 'Pragma', 'Range', 'Referer', 'User-Agent',
  'X-Api-Key', 'X-Csrf-Token', 'X-Forwarded-For', 'X-Forwarded-Host',
  'X-Forwarded-Proto', 'X-Real-IP', 'X-Requested-With'
];

// Past values the user has entered, loaded from storage for value autocomplete
let valueHistory = [];

// Render the <datalist> option lists from a set of strings
function fillDatalist(el, items) {
  el.innerHTML = '';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item;
    el.appendChild(opt);
  });
}

// Seed the name datalist with common headers (custom names get merged in on save)
fillDatalist(knownHeadersList, COMMON_HEADERS);

// 1. Resolve current active tab context
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs && tabs[0]) {
    const activeTab = tabs[0];
    currentTabId = activeTab.id;
    try {
      currentHost = new URL(activeTab.url).hostname;
    } catch (e) {
      currentHost = null;
    }
    updateStatusBadge();
  }
});

// Reflect whether headers target the active tab or every tab.
function updateStatusBadge() {
  chrome.storage.local.get(['applyToAllTabs'], ({ applyToAllTabs }) => {
    if (applyToAllTabs) {
      statusBadge.textContent = 'Target: All tabs';
    } else {
      statusBadge.textContent = `Target: ${currentHost || 'Active Tab'}`;
    }
  });
}

// 2. Hydrate popup from storage. Migrates the old flat `headers` list into a
//    single "all sites" group the first time.
chrome.storage.local.get(['groups', 'headers', 'valueHistory'], (result) => {
  valueHistory = Array.isArray(result.valueHistory) ? result.valueHistory : [];
  fillDatalist(knownValuesList, valueHistory);

  let groups = result.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    const legacy = Array.isArray(result.headers) ? result.headers : [];
    groups = [{ domain: '', headers: legacy }];
  }
  groups.forEach(createGroup);
});

// 3. Debounced auto-save to avoid UI lag while typing
function triggerAutoSave() {
  saveStatus.textContent = "Saving...";
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(saveAndApply, 250);
}

// 4. Collect groups from the DOM
function readGroupsFromDom() {
  const groups = [];
  container.querySelectorAll('.group').forEach(groupEl => {
    const domain = groupEl.querySelector('.group-domain').value.trim();
    const headers = [];
    groupEl.querySelectorAll('.header-row').forEach(row => {
      const enabled = row.querySelector('.toggle-chk').checked;
      const name = row.querySelector('.header-name').value.trim();
      const value = row.querySelector('.header-value').value.trim();
      if (name) headers.push({ name, value, enabled });
    });
    groups.push({ domain, headers });
  });
  return groups;
}

// 5. Core Save & Apply
async function saveAndApply() {
  const groups = readGroupsFromDom();

  // Refresh autocomplete sources across every group
  const customNames = [];
  const newValues = [];
  groups.forEach(g => g.headers.forEach(h => {
    if (h.name) customNames.push(h.name);
    if (h.value) newValues.push(h.value);
  }));
  fillDatalist(knownHeadersList, [...new Set([...COMMON_HEADERS, ...customNames])]);
  valueHistory = [...new Set([...newValues, ...valueHistory])].slice(0, 100);
  fillDatalist(knownValuesList, valueHistory);

  chrome.storage.local.set({ groups, valueHistory }, async () => {
    const { applyToAllTabs } = await chrome.storage.local.get(['applyToAllTabs']);
    const tabId = applyToAllTabs ? null : currentTabId;

    if (!applyToAllTabs && currentTabId == null) {
      saveStatus.textContent = "Saved";
      return;
    }

    const rules = buildRulesFromGroups(groups, { tabId });
    await applyRules(rules);
    saveStatus.textContent = "Saved";
  });
}

// 6. Live plain-English explanation of a group's domain filter
function updateGroupHint(groupEl) {
  const raw = groupEl.querySelector('.group-domain').value.trim();
  const hint = groupEl.querySelector('.group-hint');

  if (!raw) {
    hint.textContent = 'Applies to all sites';
    hint.className = 'group-hint';
    return;
  }
  const d = normalizeDomain(raw);
  if (isValidDomain(d)) {
    hint.textContent = `Applies to ${d} and its subdomains (e.g. api.${d})`;
    hint.className = 'group-hint ok';
  } else {
    hint.textContent = '⚠ Enter a valid domain like domain.com — this group is paused until then';
    hint.className = 'group-hint warn';
  }
}

// 7. Build a domain-group card
function createGroup(group = { domain: '', headers: [] }) {
  const groupEl = document.createElement('div');
  groupEl.className = 'group';

  const head = document.createElement('div');
  head.className = 'group-head';

  const globe = document.createElement('span');
  globe.className = 'group-globe';
  globe.textContent = '🌐';

  const domainInput = document.createElement('input');
  domainInput.type = 'text';
  domainInput.className = 'group-domain';
  domainInput.placeholder = 'All sites — or type a domain, e.g. domain.com';
  domainInput.value = group.domain || '';
  domainInput.setAttribute('autocomplete', 'off');
  domainInput.addEventListener('input', () => {
    updateGroupHint(groupEl);
    triggerAutoSave();
  });

  const delGroupBtn = document.createElement('button');
  delGroupBtn.className = 'del-group-btn';
  delGroupBtn.textContent = '🗑';
  delGroupBtn.title = 'Remove this group';
  delGroupBtn.onclick = () => {
    groupEl.remove();
    if (container.children.length === 0) createGroup({ domain: '', headers: [] });
    saveAndApply();
  };

  head.appendChild(globe);
  head.appendChild(domainInput);
  head.appendChild(delGroupBtn);

  const hint = document.createElement('div');
  hint.className = 'group-hint';

  const rows = document.createElement('div');
  rows.className = 'group-rows';

  const addHeaderBtn = document.createElement('button');
  addHeaderBtn.className = 'add-header-btn';
  addHeaderBtn.textContent = '+ Add header';
  addHeaderBtn.onclick = () => {
    createHeaderRow(rows);
    saveAndApply();
  };

  groupEl.appendChild(head);
  groupEl.appendChild(hint);
  groupEl.appendChild(rows);
  groupEl.appendChild(addHeaderBtn);
  container.appendChild(groupEl);

  const headers = Array.isArray(group.headers) ? group.headers : [];
  if (headers.length === 0) {
    createHeaderRow(rows);
  } else {
    headers.forEach(h => createHeaderRow(rows, h.name, h.value, h.enabled ?? true));
  }

  updateGroupHint(groupEl);
  return groupEl;
}

// 8. Build a single header row inside a group's rows container
function createHeaderRow(rowsEl, name = '', value = '', enabled = true) {
  const row = document.createElement('div');
  row.className = 'header-row';
  if (!enabled) row.classList.add('disabled');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'toggle-chk';
  checkbox.checked = enabled;
  checkbox.onchange = () => {
    row.classList.toggle('disabled', !checkbox.checked);
    saveAndApply();
  };

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Header-Name';
  nameInput.value = name;
  nameInput.className = 'header-name';
  nameInput.setAttribute('list', 'known-headers');
  nameInput.setAttribute('autocomplete', 'off');
  nameInput.addEventListener('input', triggerAutoSave);

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Value';
  valueInput.value = value;
  valueInput.className = 'header-value';
  valueInput.setAttribute('list', 'known-values');
  valueInput.setAttribute('autocomplete', 'off');
  valueInput.addEventListener('input', triggerAutoSave);

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '✕';
  deleteBtn.className = 'delete-btn';
  deleteBtn.onclick = () => {
    row.remove();
    saveAndApply();
  };

  row.appendChild(checkbox);
  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(deleteBtn);
  rowsEl.appendChild(row);
}

addGroupBtn.onclick = () => {
  const groupEl = createGroup({ domain: '', headers: [] });
  groupEl.querySelector('.group-domain').focus();
  saveAndApply();
};
