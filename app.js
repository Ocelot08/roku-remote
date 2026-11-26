// Roku Remote — talks to ECP (http://<roku-ip>:8060) directly over the LAN,
// falling back to a Home Assistant Roku entity when the Roku can't be reached.
//
// Devices, apps, and Home Assistant settings are shared across every phone:
// api.php is the source of truth, stored on your web server. The local
// cache below is only an offline fallback for when the server can't be
// reached (e.g. away from home) — it is never the primary store.

const API_URL = 'api.php';
const CACHE_KEY = 'roku-remote:cache';

// No devices ship by default: add your Roku's IP address in Settings.
function defaultState() {
  return {
    devices: [],
    activeDeviceId: null,
    apps: [
      { name: 'Netflix', id: '12' },
      { name: 'YouTube', id: '837' },
      { name: 'Prime Video', id: '13' },
      { name: 'Hulu', id: '2285' },
      { name: 'Peacock', id: '593099' },
      { name: 'HBO Max', id: '61322' },
      { name: 'Shudder', id: '59997' },
      { name: 'Crunchyroll', id: '2595' },
    ],
    ha: { url: '', token: '', entity: '' },
  };
}

async function loadState() {
  try {
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    return data;
  } catch (e) {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {}
    return defaultState();
  }
}

async function saveState() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  try {
    await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch (e) {
    // Offline or server unreachable — the change stays in the local cache
    // and in memory for this session, but won't reach other phones until
    // a save succeeds again from some device.
  }
}

let state = defaultState(); // placeholder until init() loads the real state

function activeDevice() {
  return state.devices.find(d => d.id === state.activeDeviceId) || state.devices[0] || null;
}

// ---------- ECP + Home Assistant transport ----------

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function sendEcp(path, timeoutMs = 3000) {
  const device = activeDevice();
  if (!device) throw new Error('no-device');
  const url = `http://${device.ip}:8060${path}`;
  // no-cors: we can't read the response, but the POST still reaches the Roku
  // and a network-level failure (unreachable/refused/timeout) still rejects.
  await fetchWithTimeout(url, { method: 'POST', mode: 'no-cors' }, timeoutMs);
}

async function sendHa(command) {
  const { url, token, entity } = state.ha;
  if (!url || !token || !entity) throw new Error('no-ha');
  const res = await fetchWithTimeout(`${url.replace(/\/$/, '')}/api/services/remote/send_command`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entity, command: [command] }),
  }, 6000);
  if (!res.ok) throw new Error('ha-error-' + res.status);
}

async function sendHaLaunch(appId) {
  const { url, token, entity } = state.ha;
  if (!url || !token || !entity) throw new Error('no-ha');
  const res = await fetchWithTimeout(`${url.replace(/\/$/, '')}/api/services/media_player/select_source`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entity, source: appId }),
  }, 6000);
  if (!res.ok) throw new Error('ha-error-' + res.status);
}

async function sendKey(key) {
  vibrate();
  // Waking a TV from deep standby can take much longer to respond than a
  // normal button press to an already-on device — give it real room instead
  // of reporting a false "Unreachable" while it's still booting.
  const isPower = key === 'Power' || key === 'PowerOn' || key === 'PowerOff';
  if (isPower) setStatus('', 'Waking…');
  try {
    await sendEcp(`/keypress/${encodeURIComponent(key)}`, isPower ? 12000 : 3000);
    setStatus('ok', `Direct — ${activeDevice()?.name || ''}`);
  } catch (e) {
    try {
      await sendHa(key);
      setStatus('ok', 'Via Home Assistant');
    } catch (e2) {
      setStatus('err', 'Unreachable');
    }
  }
}

async function launchApp(appId) {
  vibrate();
  try {
    await sendEcp(`/launch/${encodeURIComponent(appId)}`);
    setStatus('ok', `Direct — ${activeDevice()?.name || ''}`);
  } catch (e) {
    try {
      await sendHaLaunch(appId);
      setStatus('ok', 'Via Home Assistant');
    } catch (e2) {
      setStatus('err', 'Unreachable');
    }
  }
}

async function typeText(text) {
  for (const ch of text) {
    await sendKey(`Lit_${encodeURIComponent(ch)}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

async function searchKeyword(keyword) {
  vibrate();
  try {
    await sendEcp(`/search/browse?keyword=${encodeURIComponent(keyword)}&type=movie`);
    setStatus('ok', `Direct — ${activeDevice()?.name || ''}`);
  } catch (e) {
    setStatus('err', 'Unreachable');
  }
}

function vibrate() {
  if (navigator.vibrate) navigator.vibrate(12);
}

function setStatus(kind, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  dot.className = 'dot ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '');
  label.textContent = text;
}

// ---------- UI wiring ----------

function renderDeviceList() {
  const list = document.getElementById('deviceList');
  list.innerHTML = '';
  if (state.devices.length === 0) {
    list.innerHTML = '<div class="hint">No devices yet. Add your Roku below.</div>';
  }
  state.devices.forEach(d => {
    const row = document.createElement('div');
    row.className = 'devicerow';
    row.innerHTML = `
      <div>
        <strong>${d.name}</strong>${d.id === state.activeDeviceId ? ' ✓' : ''}
        <small>${d.ip}</small>
      </div>
      <div>
        <button class="btn ghost" data-use="${d.id}">Use</button>
        <button class="btn danger" data-remove="${d.id}">Remove</button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-use]').forEach(btn => btn.addEventListener('click', () => {
    state.activeDeviceId = btn.dataset.use;
    saveState(); renderDeviceList();
  }));
  list.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
    state.devices = state.devices.filter(d => d.id !== btn.dataset.remove);
    if (state.activeDeviceId === btn.dataset.remove) state.activeDeviceId = state.devices[0]?.id || null;
    saveState(); renderDeviceList();
  }));
}

const APP_LOGOS = {
  'netflix': 'netflix.svg',
  'youtube': 'youtube.svg',
  'prime video': 'prime-video.svg',
  'hulu': 'hulu.svg',
  'peacock': 'peacock.svg',
  'hbo max': 'max.svg',
  'shudder': 'shudder.png',
  'crunchyroll': 'crunchyroll.svg',
  'ps5': 'ps5-white.svg',
};

function renderApps() {
  const grid = document.getElementById('appsGrid');
  grid.innerHTML = '';
  state.apps.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = 'appbtn';
    const logoFile = APP_LOGOS[item.name.trim().toLowerCase()];
    if (logoFile) {
      const img = document.createElement('img');
      img.className = 'app-logo';
      img.src = `icons/apps/${logoFile}`;
      img.alt = item.name;
      img.draggable = false;
      btn.appendChild(img);
    } else {
      btn.textContent = item.name;
    }
    let pressTimer;
    btn.addEventListener('click', () => launchApp(item.id));
    btn.addEventListener('pointerdown', () => { pressTimer = setTimeout(() => openAppDialog(idx), 500); });
    ['pointerup', 'pointerleave'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(pressTimer)));
    grid.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'appbtn add-tile';
  addBtn.textContent = '+ Add';
  addBtn.addEventListener('click', () => openAppDialog(null));
  grid.appendChild(addBtn);
}

let editingAppIndex = null;
function openAppDialog(idx) {
  editingAppIndex = idx;
  const dlg = document.getElementById('appDialog');
  const nameInput = document.getElementById('appName');
  const idInput = document.getElementById('appId');
  const deleteBtn = document.getElementById('deleteAppBtn');
  if (idx === null) {
    document.getElementById('appDialogTitle').textContent = 'Add tile';
    nameInput.value = ''; idInput.value = '';
    deleteBtn.style.display = 'none';
  } else {
    document.getElementById('appDialogTitle').textContent = 'Edit tile';
    nameInput.value = state.apps[idx].name;
    idInput.value = state.apps[idx].id;
    deleteBtn.style.display = 'block';
  }
  dlg.showModal();
}

document.getElementById('saveAppBtn').addEventListener('click', () => {
  const name = document.getElementById('appName').value.trim();
  const id = document.getElementById('appId').value.trim();
  if (!name || !id) return;
  if (editingAppIndex === null) state.apps.push({ name, id });
  else state.apps[editingAppIndex] = { name, id };
  saveState(); renderApps();
  document.getElementById('appDialog').close();
});
document.getElementById('cancelAppBtn').addEventListener('click', () => document.getElementById('appDialog').close());
document.getElementById('deleteAppBtn').addEventListener('click', () => {
  if (editingAppIndex !== null) state.apps.splice(editingAppIndex, 1);
  saveState(); renderApps();
  document.getElementById('appDialog').close();
});

// Settings dialog
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('haUrl').value = state.ha.url;
  document.getElementById('haToken').value = state.ha.token;
  document.getElementById('haEntity').value = state.ha.entity;
  renderDeviceList();
  document.getElementById('settingsDialog').showModal();
});
document.getElementById('closeDevicesBtn').addEventListener('click', () => document.getElementById('settingsDialog').close());
document.getElementById('addDeviceBtn').addEventListener('click', () => {
  const name = document.getElementById('newDeviceName').value.trim();
  const ip = document.getElementById('newDeviceIp').value.trim();
  if (!name || !ip) return;
  const id = 'd_' + Date.now();
  state.devices.push({ id, name, ip });
  if (!state.activeDeviceId) state.activeDeviceId = id;
  saveState();
  document.getElementById('newDeviceName').value = '';
  document.getElementById('newDeviceIp').value = '';
  renderDeviceList();
});
document.getElementById('saveHaBtn').addEventListener('click', () => {
  state.ha = {
    url: document.getElementById('haUrl').value.trim(),
    token: document.getElementById('haToken').value.trim(),
    entity: document.getElementById('haEntity').value.trim(),
  };
  saveState();
});

// D-pad / key buttons
document.querySelectorAll('button.key[data-key]').forEach(btn => {
  btn.addEventListener('click', () => sendKey(btn.dataset.key));
});

// Type dialog
document.getElementById('keyboardBtn').addEventListener('click', () => {
  document.getElementById('typeText').value = '';
  document.getElementById('typeDialog').showModal();
});
document.getElementById('cancelTypeBtn').addEventListener('click', () => document.getElementById('typeDialog').close());
document.getElementById('sendTypeBtn').addEventListener('click', () => {
  const text = document.getElementById('typeText').value;
  document.getElementById('typeDialog').close();
  if (text) typeText(text);
});

// Search dialog
document.getElementById('searchBtn').addEventListener('click', () => {
  document.getElementById('searchText').value = '';
  document.getElementById('searchDialog').showModal();
});
document.getElementById('cancelSearchBtn').addEventListener('click', () => document.getElementById('searchDialog').close());
document.getElementById('sendSearchBtn').addEventListener('click', () => {
  const kw = document.getElementById('searchText').value;
  document.getElementById('searchDialog').close();
  if (kw) searchKeyword(kw);
});

// init
async function init() {
  setStatus('', 'Loading…');
  state = await loadState();
  renderApps();
  if (!activeDevice()) setStatus('', 'No device configured');
  else setStatus('', 'Ready');
}
init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
