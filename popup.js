const container = document.getElementById('headers-container');
const addBtn = document.getElementById('add-row-btn');
const saveBtn = document.getElementById('save-btn');

// 1. Fetch saved headers from local storage
chrome.storage.local.get(['headers'], (result) => {
  const headers = result.headers || [];
  if (headers.length === 0) {
    createHeaderRow('', '', true); // Default empty row (Enabled)
  } else {
    headers.forEach(h => createHeaderRow(h.name, h.value, h.enabled ?? true));
  }
});

// 2. Generate a row UI layout with an active toggle checkbox
function createHeaderRow(name = '', value = '', enabled = true) {
  const row = document.createElement('div');
  row.className = 'header-row';
  if (!enabled) row.classList.add('disabled');

  // Create Checkbox Toggle
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'toggle-chk';
  checkbox.checked = enabled;
  checkbox.onchange = () => {
    if (checkbox.checked) {
      row.classList.remove('disabled');
    } else {
      row.classList.add('disabled');
    }
  };

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Header-Name';
  nameInput.value = name;
  nameInput.className = 'header-name';

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Value';
  valueInput.value = value;
  valueInput.className = 'header-value';

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '✕';
  deleteBtn.className = 'delete-btn';
  deleteBtn.onclick = () => row.remove();

  row.appendChild(checkbox);
  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(deleteBtn);
  container.appendChild(row);
}

// 3. UI Actions & Save Parser
addBtn.onclick = () => createHeaderRow();

saveBtn.onclick = () => {
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

  // Save full configuration states to local engine profile
  chrome.storage.local.set({ headers }, () => {
    const originalText = saveBtn.textContent;
    saveBtn.textContent = 'Saved & Applied!';
    saveBtn.style.backgroundColor = '#28a745';
    setTimeout(() => {
      saveBtn.textContent = originalText;
      saveBtn.style.backgroundColor = '#007bff';
    }, 1500);
  });
};