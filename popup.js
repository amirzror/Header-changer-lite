const container = document.getElementById('groups-container');
const addGroupBtn = document.getElementById('add-group-btn');
const statusBadge = document.getElementById('status');
const saveStatus = document.getElementById('save-status');
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
const COMMON_SET = new Set(COMMON_HEADERS.map(h => h.toLowerCase()));

// Past values the user has entered, loaded from storage for value autocomplete
let valueHistory = [];
// Custom header names the user has explicitly pinned ("saved for later")
let savedHeaders = [];

function isWellKnown(name) { return COMMON_SET.has(String(name).trim().toLowerCase()); }
function isSaved(name) {
  const l = String(name).trim().toLowerCase();
  return savedHeaders.some(s => s.toLowerCase() === l);
}

// Render the <datalist> option lists from a set of strings
function fillDatalist(el, items) {
  el.innerHTML = '';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item;
    el.appendChild(opt);
  });
}

// ── Saved custom headers ────────────────────────────────────────────────────

function persistSavedHeaders() {
  chrome.storage.local.set({ savedHeaders });
}

function pinHeader(name) {
  const n = String(name).trim();
  if (!n || isWellKnown(n) || isSaved(n)) return;
  savedHeaders.push(n);
  persistSavedHeaders();
}

function unpinHeader(name) {
  const l = String(name).trim().toLowerCase();
  savedHeaders = savedHeaders.filter(s => s.toLowerCase() !== l);
  persistSavedHeaders();
}

// Custom names currently typed across all groups (not well-known), so they can
// be surfaced and pinned even before they've been saved.
function getInUseCustomNames() {
  const seen = new Set();
  const out = [];
  container.querySelectorAll('.header-name').forEach(inp => {
    const n = inp.value.trim();
    if (!n) return;
    const l = n.toLowerCase();
    if (COMMON_SET.has(l) || seen.has(l)) return;
    seen.add(l);
    out.push(n);
  });
  return out;
}

// Build the ordered, de-duplicated suggestion list for a header-name query.
function buildNameSuggestions(query) {
  const q = query.trim();
  const lq = q.toLowerCase();
  const seen = new Set();
  const items = [];
  const push = (name) => {
    const l = name.toLowerCase();
    if (seen.has(l)) return;
    if (lq && !l.includes(lq)) return;
    seen.add(l);
    items.push({ name, saved: isSaved(name), wellKnown: isWellKnown(name) });
  };
  // The exact typed value first, when it's a brand-new custom name.
  if (q && !isWellKnown(q) && !isSaved(q)) push(q);
  savedHeaders.forEach(push);
  getInUseCustomNames().forEach(push);
  COMMON_HEADERS.forEach(push);
  return items;
}

// Custom dropdown for a header-name input: well-known names are plain, custom
// names get a "+" to pin them for later (or "−" to unpin ones already saved).
function attachNameAutocomplete(input) {
  const wrap = document.createElement('div');
  wrap.className = 'hname-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const dd = document.createElement('div');
  dd.className = 'hname-dropdown';
  dd.style.display = 'none';
  wrap.appendChild(dd);

  function hide() { dd.style.display = 'none'; }

  function render() {
    const items = buildNameSuggestions(input.value);
    dd.innerHTML = '';
    if (items.length === 0) { hide(); return; }

    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'hname-opt';

      const label = document.createElement('span');
      label.className = 'hname-label';
      label.textContent = it.name;
      // mousedown (not click) + preventDefault keeps the input focused so the
      // blur-hide doesn't fire before the selection is applied.
      label.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = it.name;
        hide();
        triggerAutoSave();
      });
      row.appendChild(label);

      if (!it.wellKnown) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hname-pin';
        if (it.saved) {
          btn.textContent = '−';
          btn.title = 'Remove from saved headers';
          btn.addEventListener('mousedown', (e) => { e.preventDefault(); unpinHeader(it.name); render(); });
        } else {
          btn.textContent = '+';
          btn.title = 'Save this header for later';
          btn.addEventListener('mousedown', (e) => { e.preventDefault(); pinHeader(it.name); render(); });
        }
        row.appendChild(btn);
      }
      dd.appendChild(row);
    });
    dd.style.display = 'block';
  }

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(hide, 120));
}

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
chrome.storage.local.get(['groups', 'headers', 'valueHistory', 'savedHeaders'], (result) => {
  valueHistory = Array.isArray(result.valueHistory) ? result.valueHistory : [];
  savedHeaders = Array.isArray(result.savedHeaders) ? result.savedHeaders : [];
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

  // Refresh value autocomplete from everything currently in use.
  const newValues = [];
  groups.forEach(g => g.headers.forEach(h => { if (h.value) newValues.push(h.value); }));
  valueHistory = [...new Set([...newValues, ...valueHistory])].slice(0, 100);
  fillDatalist(knownValuesList, valueHistory);

  chrome.storage.local.set({ groups, valueHistory }, async () => {
    const { applyToAllTabs } = await chrome.storage.local.get(['applyToAllTabs']);
    const tabId = applyToAllTabs ? null : currentTabId;

    if (!applyToAllTabs && currentTabId == null) {
      saveStatus.textContent = "Saved";
      refreshPortNotices();
      return;
    }

    const rules = buildRulesFromGroups(groups, { tabId });
    await applyRules(rules);
    saveStatus.textContent = "Saved";
    refreshPortNotices();
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

// 6b. Port-rewrite (__port) status + permission prompt for a group.
async function updatePortNotice(groupEl) {
  const notice = groupEl.querySelector('.port-notice');
  const domainRaw = groupEl.querySelector('.group-domain').value.trim();
  const domain = normalizeDomain(domainRaw);

  const headers = [];
  groupEl.querySelectorAll('.header-row').forEach(row => {
    const enabled = row.querySelector('.toggle-chk').checked;
    const name = row.querySelector('.header-name').value.trim();
    const value = row.querySelector('.header-value').value.trim();
    if (name) headers.push({ name, value, enabled });
  });
  const port = getPortOverride(headers);

  notice.innerHTML = '';
  notice.className = 'port-notice';
  notice.style.display = 'none';

  if (!port) return;

  // __port is only honored for a concrete domain, never for "all sites".
  if (!domainRaw || !isValidDomain(domain)) {
    notice.textContent = '⚠ __port needs a valid domain set above — port rewrite is ignored for “all sites”.';
    notice.className = 'port-notice warn';
    notice.style.display = 'block';
    return;
  }

  const origins = portOrigins(domain);
  const { applyToAllTabs } = await chrome.storage.local.get(['applyToAllTabs']);
  const granted = applyToAllTabs
    ? await chrome.permissions.contains(ALL_TABS_ORIGINS)
    : await chrome.permissions.contains(origins);

  if (granted) {
    notice.textContent = `✓ Requests to ${domain} are redirected to port ${port}.`;
    notice.className = 'port-notice ok';
    notice.style.display = 'block';
    return;
  }

  const txt = document.createElement('span');
  txt.textContent = `Rewriting ${domain} to port ${port} needs permission. `;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'grant-btn';
  btn.textContent = 'Grant';
  // permissions.request must be the first call in the gesture handler, so no
  // awaits precede it here.
  btn.addEventListener('click', () => {
    chrome.permissions.request(origins).then(async (ok) => {
      if (ok) await saveAndApply();
      updatePortNotice(groupEl);
    });
  });
  notice.appendChild(txt);
  notice.appendChild(btn);
  notice.className = 'port-notice warn';
  notice.style.display = 'block';
}

function refreshPortNotices() {
  container.querySelectorAll('.group').forEach(updatePortNotice);
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
    updatePortNotice(groupEl);
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

  const portNotice = document.createElement('div');
  portNotice.className = 'port-notice';
  portNotice.style.display = 'none';

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
  groupEl.appendChild(portNotice);
  groupEl.appendChild(addHeaderBtn);
  container.appendChild(groupEl);

  const headers = Array.isArray(group.headers) ? group.headers : [];
  if (headers.length === 0) {
    createHeaderRow(rows);
  } else {
    headers.forEach(h => createHeaderRow(rows, h.name, h.value, h.enabled ?? true));
  }

  updateGroupHint(groupEl);
  updatePortNotice(groupEl);
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
    updatePortNotice(row.closest('.group'));
    saveAndApply();
  };

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Header-Name';
  nameInput.value = name;
  nameInput.className = 'header-name';
  nameInput.setAttribute('autocomplete', 'off');
  nameInput.addEventListener('input', () => {
    updatePortNotice(row.closest('.group'));
    triggerAutoSave();
  });

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Value';
  valueInput.value = value;
  valueInput.className = 'header-value';
  valueInput.setAttribute('list', 'known-values');
  valueInput.setAttribute('autocomplete', 'off');
  valueInput.addEventListener('input', () => {
    updatePortNotice(row.closest('.group'));
    triggerAutoSave();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '✕';
  deleteBtn.className = 'delete-btn';
  deleteBtn.onclick = () => {
    const groupEl = row.closest('.group');
    row.remove();
    updatePortNotice(groupEl);
    saveAndApply();
  };

  row.appendChild(checkbox);
  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(deleteBtn);
  rowsEl.appendChild(row);

  // Custom name dropdown (wraps nameInput) — attach after it's in the DOM.
  attachNameAutocomplete(nameInput);
}

addGroupBtn.onclick = () => {
  const groupEl = createGroup({ domain: '', headers: [] });
  groupEl.querySelector('.group-domain').focus();
  saveAndApply();
};
