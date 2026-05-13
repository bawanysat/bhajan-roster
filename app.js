// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const CFG_KEY  = 'bhajan_gh_config';
const DATA_KEY = 'bhajan_roster_v4';
const SAI_BASE = 'https://sairhythms.sathyasai.org/songs?title=';

const ALL_TAGS = [
  { key: 'regular',     label: 'Regular',           cls: 'tag-regular' },
  { key: 'special',     label: 'Special occasions',  cls: 'tag-special' },
  { key: 'child',       label: 'Child',              cls: 'tag-child' },
  { key: 'beginner',    label: 'Beginner',           cls: 'tag-beginner' },
  { key: 'senior',      label: 'Senior',             cls: 'tag-senior' },
  { key: 'unavailable', label: 'Unavailable',        cls: 'tag-unavailable' },
];

const INST_AVAILABILITY = [
  { key: 'available',   label: 'Available',   badgeCls: 'badge-ok' },
  { key: 'occasional',  label: 'Occasional',  badgeCls: 'badge-occasional' },
  { key: 'unavailable', label: 'Unavailable', badgeCls: 'badge-unavail' },
];

const CSV_APP_FIELDS = [
  { key: 'name',     label: 'Singer name',         required: true },
  { key: 'lastSang', label: 'Last sang date',       required: false },
  { key: 'notes',    label: 'Notes / comments',     required: false },
  { key: '_ignore',  label: '— Ignore this column —', required: false },
];

// Default join configuration: show simple join (access code only)
// and point to the organiser's repo so members only need to paste the token.
window.BHAJAN_OWNER = window.BHAJAN_OWNER || 'bawanysat';
window.BHAJAN_REPO  = window.BHAJAN_REPO  || 'bhajan-roster';
window.BHAJAN_FILE  = window.BHAJAN_FILE  || 'roster-data.json';
window.BHAJAN_CALENDAR_FILE = window.BHAJAN_CALENDAR_FILE || 'calendar-data.json';

// ── APP STATE ─────────────────────────────────────────────────────────────────
let cfg          = null;
let state        = null;   // { singers, instrumentalists, session, groupName, nextId, nextInstId }
let fileSha      = null;
let calendarFileSha = null;
let activeFilter = null;
let editSingerId = null;
let editInstId   = null;
let editEntryIdx = null;
let currentTab   = 'roster';
let syncTimer    = null;
// CSV import
let csvHeaders = [], csvRows = [], csvMapping = {};
// Searchable dropdown
let searchDropdownCallback = null;

// ── UTILS ─────────────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const esc = s  => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function daysSince(d) {
  return !d ? 9999 : Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}
function fmtDate(d) {
  return !d ? 'Never' : new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function initials(n) {
  return n.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function toast(msg, dur = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}
function setSyncStatus(st, label) {
  const el = $('sync-pill');
  if (!el) return;
  el.className = 'sync-pill ' + st;
  const icon = st === 'busy' ? '<span class="spinner"></span>' : st === 'ok' ? '☁️' : '⚠️';
  el.innerHTML = `${icon} ${label}`;
}
function tagHtml(tags, small = false) {
  return (tags || []).map(t => {
    const td = ALL_TAGS.find(x => x.key === t);
    return td ? `<span class="tag ${td.cls}"${small ? ' style="font-size:10px;"' : ''}>${td.label}</span>` : '';
  }).join('');
}

// ── GITHUB API ────────────────────────────────────────────────────────────────
async function ghFetch(path, method = 'GET', body = null) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      'Authorization': 'token ' + cfg.token,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

async function loadFromGitHub() {
  setSyncStatus('busy', 'Loading…');
  try {
    const data = await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.filePath}`);
    fileSha = data.sha;
    state = JSON.parse(atob(data.content.replace(/\n/g, '')));
    migrateState();
    // attempt to load calendar from separate file; if present, prefer it
    await loadCalendarFromGitHub().catch(() => {});
    // If roster file contains a calendar (older versions) migrate it into calendar-data.json
    if (state.calendar && Object.keys(state.calendar).length) {
      // merge into loaded calendar (or create a new one)
      window._migratedCalendar = window._migratedCalendar || {};
      Object.keys(state.calendar).forEach(k => {
        window._migratedCalendar[k] = window._migratedCalendar[k] || [];
        (state.calendar[k] || []).forEach(item => {
          if (!window._migratedCalendar[k].some(x => x.singerId === item.singerId && x.bhajan === item.bhajan)) window._migratedCalendar[k].push(item);
        });
      });
      // clear calendar from roster state to avoid duplication when saving roster
      delete state.calendar;
    }
    saveLocal();
    setSyncStatus('ok', 'Synced');
    return true;
  } catch (e) {
    if (e.message && e.message.includes('Not Found')) {
      state = defaultState();
      await saveToGitHub('Initial data');
      return true;
    }
    setSyncStatus('err', 'Sync error');
    toast('⚠️ ' + e.message, 4000);
    return false;
  }
}

// Load calendar-data.json if present
async function loadCalendarFromGitHub() {
  if (!cfg) return;
  try {
    const data = await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${window.BHAJAN_CALENDAR_FILE}`);
    calendarFileSha = data.sha;
    const cal = JSON.parse(atob(data.content.replace(/\n/g, '')));
    // merged into a window-scoped migrated calendar if present
    state = state || defaultState();
    state.calendar = state.calendar || {};
    // prefer explicit calendar file, but if migration buffer exists, merge
    const source = cal && cal.calendar ? cal.calendar : cal;
    Object.keys(source || {}).forEach(k => {
      state.calendar[k] = state.calendar[k] || [];
      (source[k] || []).forEach(item => {
        if (!state.calendar[k].some(x => x.singerId === item.singerId && x.bhajan === item.bhajan)) state.calendar[k].push(item);
      });
    });
    // If we had migrated data from roster file earlier, merge that too
    if (window._migratedCalendar) {
      Object.keys(window._migratedCalendar).forEach(k => {
        state.calendar[k] = state.calendar[k] || [];
        (window._migratedCalendar[k] || []).forEach(item => {
          if (!state.calendar[k].some(x => x.singerId === item.singerId && x.bhajan === item.bhajan)) state.calendar[k].push(item);
        });
      });
      // clear migration buffer
      window._migratedCalendar = null;
    }
    return true;
  } catch (e) {
    // If authenticated API access failed (e.g. user didn't paste organiser token or token lacks access),
    // try an anonymous fetch from raw.githubusercontent.com — useful when the repo is public.
    try {
      const rawUrl = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/main/${window.BHAJAN_CALENDAR_FILE}`;
      const r = await fetch(rawUrl);
      if (!r.ok) return false;
      const cal = await r.json();
      // no SHA available for anonymous raw fetch
      calendarFileSha = null;
      state = state || defaultState();
      state.calendar = state.calendar || {};
      const source = (cal && cal.calendar) ? cal.calendar : cal;
      Object.keys(source || {}).forEach(k => {
        state.calendar[k] = state.calendar[k] || [];
        (source[k] || []).forEach(item => {
          if (!state.calendar[k].some(x => x.singerId === item.singerId && x.bhajan === item.bhajan)) state.calendar[k].push(item);
        });
      });
      if (window._migratedCalendar) {
        Object.keys(window._migratedCalendar).forEach(k => {
          state.calendar[k] = state.calendar[k] || [];
          (window._migratedCalendar[k] || []).forEach(item => {
            if (!state.calendar[k].some(x => x.singerId === item.singerId && x.bhajan === item.bhajan)) state.calendar[k].push(item);
          });
        });
        window._migratedCalendar = null;
      }
      return true;
    } catch (e2) {
      // calendar file missing or inaccessible — we'll create it when saving
      return false;
    }
  }
}

// Save calendar object into calendar-data.json (separate file)
async function saveCalendarToGitHub(msg) {
  if (!cfg) return false;
  setSyncStatus('busy', 'Saving calendar…');
  try {
    const payload = { calendar: state.calendar || {} };
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    const body = { message: msg || 'Update calendar', content, branch: 'main' };
    if (calendarFileSha) body.sha = calendarFileSha;
    const res = await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${window.BHAJAN_CALENDAR_FILE}`, 'PUT', body);
    calendarFileSha = res.content.sha;
    saveLocal();
    setSyncStatus('ok', 'Calendar saved ✓');
    return true;
  } catch (e) {
    setSyncStatus('err', 'Calendar save failed');
    toast('⚠️ ' + e.message, 4000);
    return false;
  }
}

async function saveToGitHub(msg) {
  setSyncStatus('busy', 'Saving…');
  try {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(state, null, 2))));
    const body = { message: msg || 'Update roster', content, branch: 'main' };
    if (fileSha) body.sha = fileSha;
    const res = await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.filePath}`, 'PUT', body);
    fileSha = res.content.sha;
    saveLocal();
    setSyncStatus('ok', 'Saved ✓');
    return true;
  } catch (e) {
    setSyncStatus('err', 'Save failed');
    toast('⚠️ ' + e.message, 4000);
    return false;
  }
}

function scheduleSave(msg) {
  clearTimeout(syncTimer);
  setSyncStatus('busy', 'Saving…');
  syncTimer = setTimeout(() => saveToGitHub(msg || 'Update roster'), 1500);
}

// ── STATE HELPERS ─────────────────────────────────────────────────────────────
function defaultState() {
  return {
    singers: [],
    instrumentalists: [],
    session: { date: new Date().toISOString().split('T')[0], entries: [] },
    // calendar: map of date -> [{ singerId, singerName, bhajan, link, lyrics }, ...]
    calendar: {},
    groupName: 'Bhajan Kirtan Group',
    nextId: 1,
    nextInstId: 1,
  };
}

function migrateState() {
  // Ensure all fields exist (for older saved data)
  if (!state.nextId) state.nextId = (state.singers.reduce((m, s) => Math.max(m, s.id), 0)) + 1;
  if (!state.instrumentalists) state.instrumentalists = [];
  if (!state.calendar) state.calendar = {};
  if (!state.nextInstId) state.nextInstId = 1;
  state.session.entries.forEach(e => {
    if (!e.link) e.link = '';
    if (!e.lyrics) e.lyrics = '';
  });
}

// ── LOCAL CACHE ───────────────────────────────────────────────────────────────
function saveLocal() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify({ state, fileSha })); } catch (e) {}
}
function loadLocal() {
  try {
    const r = localStorage.getItem(DATA_KEY);
    if (r) { const p = JSON.parse(r); state = p.state; fileSha = p.fileSha; migrateState(); return true; }
  } catch (e) {}
  return false;
}
function loadCfg() {
  try { const r = localStorage.getItem(CFG_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
function saveCfg(c) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
}

// ── JOIN SCREEN ───────────────────────────────────────────────────────────────
function renderJoin(errMsg) {
  $('shell').innerHTML = `
    <div class="join-wrap">
      <div class="join-logo">🎵</div>
      <div class="join-title">Bhajan Kirtan Roster</div>
      <div class="join-subtitle">Enter the access code shared by your committee organiser.</div>
      ${errMsg ? `<div class="warn-box" style="text-align:left;">⚠️ ${esc(errMsg)}</div>` : ''}
      <div class="join-card">
        <div class="field">
          <label>Access code</label>
          <input class="join-token-input" type="password" id="join-token" placeholder="Paste your access code here" />
          <div class="hint" style="margin-top:6px;">Looks like: <code>ghp_xxxxxxxxxxxx</code></div>
        </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
              <label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="join-remember" /> Remember this device</label>
            </div>
            <button class="btn btn-primary btn-full" onclick="joinWithToken()" id="join-btn">Join →</button>
      </div>
      <div class="join-help">
        🔒 Stored only on this device, never shared.<br><br>
        Are you the <strong>organiser</strong> setting this up?
        <button class="btn btn-sm" style="margin-top:8px;width:100%;justify-content:center;" onclick="renderSetup()">Admin setup →</button>
      </div>
    </div>
  `;
  setTimeout(() => {
    const el = $('join-token');
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') joinWithToken(); });
  }, 0);
}

async function joinWithToken() {
  const token = ($('join-token').value || '').trim();
  if (!token) { toast('Please paste your access code first'); return; }
  const btn = $('join-btn');
  btn.innerHTML = '<span class="spinner"></span> Checking…'; btn.disabled = true;
  const owner    = window.BHAJAN_OWNER || null;
  const repo     = window.BHAJAN_REPO  || null;
  const filePath = window.BHAJAN_FILE  || 'roster-data.json';
  if (!owner || !repo) {
    btn.innerHTML = 'Join →'; btn.disabled = false;
    renderJoinFull('');
    return;
  }
  cfg = { owner, repo, token, filePath };
  try {
    await ghFetch(`/repos/${owner}/${repo}`);
    // Persist config only if user chose to remember this device
    const remember = !!(document.getElementById('join-remember') && document.getElementById('join-remember').checked);
    if (remember) saveCfg(cfg);
    state = defaultState(); await loadFromGitHub(); renderApp();
  } catch (e) {
    btn.innerHTML = 'Join →'; btn.disabled = false;
    renderJoin('Invalid access code. Please check and try again.');
  }
}

function renderJoinFull(errMsg) {
  $('shell').innerHTML = `
    <div class="join-wrap" style="max-width:440px;">
      <div class="join-logo">🎵</div>
      <div class="join-title">Bhajan Kirtan Roster</div>
      <div class="join-subtitle">Enter the details shared by your organiser.</div>
      ${errMsg ? `<div class="warn-box" style="text-align:left;">⚠️ ${esc(errMsg)}</div>` : ''}
      <div class="join-card">
        <div class="field"><label>GitHub username of organiser</label><input type="text" id="jf-owner" placeholder="e.g. john-smith" /></div>
        <div class="field"><label>Repository name</label><input type="text" id="jf-repo" placeholder="e.g. bhajan-roster" /></div>
        <div class="field">
          <label>Access code</label>
          <input class="join-token-input" type="password" id="jf-token" placeholder="ghp_xxxxxxxxxxxx" />
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
          <label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="jf-remember" /> Remember this device</label>
        </div>
        <button class="btn btn-primary btn-full" onclick="joinFull()" id="jf-btn">Join →</button>
      </div>
      <div class="join-help">
        Are you the <strong>organiser</strong>?
        <button class="btn btn-sm" style="margin-top:8px;width:100%;justify-content:center;" onclick="renderSetup()">Admin setup →</button>
      </div>
    </div>
  `;
}

async function joinFull() {
  const owner    = ($('jf-owner').value || '').trim();
  const repo     = ($('jf-repo').value  || '').trim();
  const token    = ($('jf-token').value || '').trim();
  const filePath = 'roster-data.json';
  if (!owner || !repo || !token) { toast('Please fill in all fields'); return; }
  const btn = $('jf-btn');
  btn.innerHTML = '<span class="spinner"></span> Checking…'; btn.disabled = true;
  cfg = { owner, repo, token, filePath };
  try {
    await ghFetch(`/repos/${owner}/${repo}`);
    const remember = !!(document.getElementById('jf-remember') && document.getElementById('jf-remember').checked);
    if (remember) saveCfg(cfg);
    state = defaultState(); await loadFromGitHub(); renderApp();
  } catch (e) {
    btn.innerHTML = 'Join →'; btn.disabled = false;
    renderJoinFull('Could not connect: ' + e.message);
  }
}

// ── ADMIN SETUP ───────────────────────────────────────────────────────────────
function renderSetup(errMsg) {
  $('shell').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1.5rem;">
      <button class="btn btn-sm" onclick="renderJoin('')">← Back</button>
      <div><h1>🎵 Admin setup</h1><div class="subtitle">One-time setup for the organiser</div></div>
    </div>
    ${errMsg ? `<div class="warn-box">${esc(errMsg)}</div>` : ''}
    <div class="info-box">Complete this once. Then share the app URL + access token with committee members — they paste the token once to join.</div>

    <div class="setup-step">
      <div class="setup-title"><span class="setup-num">1</span>Create a GitHub repository</div>
      <p>Go to <a href="https://github.com/new" target="_blank">github.com/new</a>. Name it <code>bhajan-roster</code>. Set it to <strong>Public</strong>. Tick <em>"Add a README file"</em> then click Create.</p>
    </div>
    <div class="setup-step">
      <div class="setup-title"><span class="setup-num">2</span>Enable GitHub Pages</div>
      <p>In the repo go to <strong>Settings → Pages</strong>. Under Source select <strong>Deploy from a branch</strong>, choose <strong>main</strong> and <strong>/ (root)</strong>. Your URL will be <code>https://YOUR-USERNAME.github.io/bhajan-roster/</code></p>
    </div>
    <div class="setup-step">
      <div class="setup-title"><span class="setup-num">3</span>Upload the app files</div>
      <p>Upload <code>index.html</code>, <code>style.css</code>, and <code>app.js</code> to the repo root via <strong>Add file → Upload files</strong>.</p>
    </div>
    <div class="setup-step">
      <div class="setup-title"><span class="setup-num">4</span>Create a Personal Access Token</div>
      <p>Go to <a href="https://github.com/settings/tokens/new" target="_blank">github.com/settings/tokens/new</a>. Name it <code>bhajan-roster</code>. Set expiry to <strong>No expiration</strong>. Tick <strong>repo</strong>. Copy the token immediately.</p>
    </div>
    <div class="setup-step">
      <div class="setup-title"><span class="setup-num">5</span>Share with committee</div>
      <p>Send them: 1) the app URL, and 2) the access token privately via WhatsApp. They paste it once on their device.</p>
    </div>

    <div class="card" style="margin-bottom:1rem;">
      <div style="font-size:16px;font-weight:600;margin-bottom:1rem;">Connect your GitHub repository</div>
      <div class="field"><label>GitHub username</label><input type="text" id="cfg-owner" placeholder="e.g. john-smith" /></div>
      <div class="field"><label>Repository name</label><input type="text" id="cfg-repo" placeholder="e.g. bhajan-roster" /></div>
      <div class="field"><label>Personal Access Token</label><input type="password" id="cfg-token" placeholder="ghp_xxxxxxxxxxxx" /></div>
      <div class="field"><label>Data filename</label><input type="text" id="cfg-path" value="roster-data.json" /></div>
      <button class="btn btn-primary btn-full" onclick="connectGH()" id="connect-btn">Connect &amp; continue →</button>
    </div>
    <p style="font-size:12px;color:var(--text3);text-align:center;line-height:1.5;">Token stored only in your browser's local storage, sent only to GitHub API over HTTPS.</p>
  `;
}

async function connectGH() {
  const owner    = ($('cfg-owner').value || '').trim();
  const repo     = ($('cfg-repo').value  || '').trim();
  const token    = ($('cfg-token').value || '').trim();
  const filePath = ($('cfg-path').value  || 'roster-data.json').trim();
  if (!owner || !repo || !token) { toast('Please fill in all fields'); return; }
  const btn = $('connect-btn');
  btn.innerHTML = '<span class="spinner"></span> Connecting…'; btn.disabled = true;
  cfg = { owner, repo, token, filePath };
  try {
    await ghFetch(`/repos/${owner}/${repo}`);
    saveCfg(cfg); state = defaultState(); await loadFromGitHub(); renderApp();
  } catch (e) {
    btn.innerHTML = 'Connect &amp; continue →'; btn.disabled = false;
    renderSetup('Could not connect: ' + e.message);
  }
}

// ── MAIN APP SHELL ────────────────────────────────────────────────────────────
function renderApp() {
  $('shell').innerHTML = `
    <div class="top-bar">
      <div><h1>🎵 Bhajan Kirtan Roster</h1><div class="subtitle">Singer management &amp; session planner</div></div>
      <div class="top-bar-right">
        <span id="sync-pill" class="sync-pill" onclick="manualSync()" title="Click to sync">☁️ …</span>
        <button class="btn btn-sm" onclick="showSettings()" style="font-size:11px;">⚙️ Settings</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" onclick="showTab('calendar',this)">🗓️ Calendar</button>
      <button class="tab active" onclick="showTab('roster',this)">👥 Singers</button>
      <button class="tab" onclick="showTab('instruments',this)">🎶 Instruments</button>
      <button class="tab" onclick="showTab('plan',this)">� Plan</button>
      <button class="tab" onclick="showTab('whatsapp',this)">💬 WhatsApp</button>
    </div>

    <!-- SINGERS TAB -->
    <div id="tab-roster" class="section active">
      <div class="stat-grid" id="stats"></div>
      <div class="sec-hdr">
        <div class="sec-title" style="margin:0;">Filter by tag</div>
        <div class="sec-hdr-actions">
          <button class="btn btn-sm" onclick="openImport()">⬆ Import CSV</button>
          <button class="btn btn-primary btn-sm" onclick="openSingerModal()">+ Add singer</button>
        </div>
      </div>
      <div class="filter-row" id="filter-row"></div>
      <div id="singer-list"></div>
    </div>

    <!-- INSTRUMENTS TAB -->
    <div id="tab-instruments" class="section">
      <div class="sec-hdr">
        <div class="sec-title" style="margin:0;">Instrumentalists</div>
        <button class="btn btn-primary btn-sm" onclick="openInstModal()">+ Add instrumentalist</button>
      </div>
      <div class="filter-row" id="inst-filter-row"></div>
      <div id="inst-list"></div>
    </div>

    <!-- PLAN TAB -->
    <div id="tab-plan" class="section">
      <div class="card" style="margin-bottom:1rem;">
        <div class="sec-title" style="margin-bottom:8px;">Session date</div>
        <input type="date" id="session-date" />
      </div>
      <div class="sec-title">Suggested singers (haven't sung recently)</div>
      <div id="suggested-list" style="margin-bottom:1.5rem;"></div>
      <div class="sec-title">Add singer to programme</div>
      <div style="margin-bottom:1.5rem;">
        <button class="search-trigger" id="singer-search-trigger" onclick="openSearchDropdown()">
          <span class="st-icon">🔍</span>
          <span class="st-value placeholder" id="singer-search-value">Search and select a singer…</span>
          <span class="st-icon">▾</span>
        </button>
      </div>
      <div class="sec-title">Session programme</div>
      <div class="card" style="padding:0 0 4px;" id="session-table-wrap"></div>
      <div style="margin-top:1rem;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-success" onclick="finaliseSession()">✓ Finalise &amp; update dates</button>
        <button class="btn btn-danger"  onclick="clearSession()">✕ Clear session</button>
      </div>
    </div>

    <!-- CALENDAR TAB -->
    <div id="tab-calendar" class="section">
      <div class="sec-hdr">
        <div class="sec-title">Calendar</div>
        <div class="sec-hdr-actions">
          <div style="font-size:13px;color:var(--text3);">Click a date to view planned singers</div>
        </div>
      </div>
      <div id="calendar-wrap" style="display:flex;gap:16px;flex-wrap:wrap;">
        <div id="calendar-grid" style="min-width:280px;"></div>
        <div style="flex:1;min-width:320px;">
          <div class="sec-title">Planned singers for <span id="cal-selected-date">—</span></div>
          <div class="card" id="cal-entries" style="min-height:120px;">Select a date to see planned singers.</div>
        </div>
      </div>
    </div>

    <!-- WHATSAPP TAB -->
    <div id="tab-whatsapp" class="section">
      <div class="sec-title">Message preview</div>
      <div class="wa-box" id="wa-preview"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1rem;">
        <button class="btn btn-primary" onclick="copyWA()">📋 Copy message</button>
        <button class="btn" onclick="refreshWA()">↺ Refresh</button>
      </div>
      <div class="divider"></div>
      <div class="sec-title">Customise</div>
      <div class="input-row">
        <input type="text" id="group-name" placeholder="Group name e.g. Sai Bhajan Group" style="flex:1;" />
        <button class="btn btn-sm" onclick="updateGroupName()">Update</button>
      </div>
    </div>
  `;

  $('session-date').value = state.session.date || new Date().toISOString().split('T')[0];
  $('session-date').addEventListener('change', e => {
    const val = e.target.value;
    state.session.date = val;
    // If there are planned singers for this date, load them into the session programme (replace existing entries)
    if (state.calendar && state.calendar[val] && state.calendar[val].length) {
      // deep-copy entries from calendar into session.entries
      state.session.entries = state.calendar[val].map(x => ({ singerId: x.singerId, singerName: x.singerName, bhajan: x.bhajan || '', link: x.link || '', lyrics: x.lyrics || '' }));
      toast(`Loaded ${state.session.entries.length} planned singer(s) for ${fmtDate(val)}`);
    } else {
      // No planned singers — clear the session programme
      state.session.entries = [];
      toast(`Cleared session programme for ${fmtDate(val)}`);
    }
    renderSession();
    scheduleSave('Update session date');
  });

  // Immediately load any planned singers for the current session date (so users see saved lists without changing the date)
  try {
    const cur = $('session-date').value;
    if (cur && state.calendar && state.calendar[cur] && state.calendar[cur].length) {
      state.session.entries = state.calendar[cur].map(x => ({ singerId: x.singerId, singerName: x.singerName, bhajan: x.bhajan || '', link: x.link || '', lyrics: x.lyrics || '' }));
      // Only show a toast when there are entries to avoid noisy messages on every load
      toast(`Loaded ${state.session.entries.length} planned singer(s) for ${fmtDate(cur)}`);
      renderSession();
    }
  } catch (e) { /* ignore in case DOM not ready */ }

  renderRoster();
  setSyncStatus('ok', 'Synced');
}

function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('tab-' + name).classList.add('active');
  el.classList.add('active');
  currentTab = name;
  if (name === 'whatsapp')    refreshWA();
  if (name === 'plan')        renderSession();
  if (name === 'calendar')    renderCalendar();
  if (name === 'roster')      renderRoster();
  if (name === 'instruments') renderInstrumentalists();
}

async function manualSync() {
  await loadFromGitHub();
  if (currentTab === 'roster')      renderRoster();
  if (currentTab === 'session')     renderSession();
  if (currentTab === 'whatsapp')    refreshWA();
  if (currentTab === 'instruments') renderInstrumentalists();
  toast('Synced ✓');
}

function showSettings() {
  const m = document.createElement('div');
  m.className = 'modal-bg open'; m.id = 'settings-modal';
  m.innerHTML = `<div class="modal">
    <div class="modal-title">⚙️ Settings</div>
    <div class="info-box">Connected: <strong>${esc(cfg.owner)}/${esc(cfg.repo)}</strong><br>Data file: <strong>${esc(cfg.filePath)}</strong></div>
    <div class="field"><label>Group name</label><input type="text" id="s-group" value="${esc(state.groupName || '')}" /></div>
    <div class="field"><label>Share with committee members</label>
      <div class="info-box" style="margin-bottom:0;word-break:break-all;">
        <strong>App URL:</strong> ${esc(window.location.href.split('?')[0])}<br><br>
        <strong>Access code:</strong> ${esc(cfg.token)}<br><br>
        <span style="font-size:11px;">Send both privately via WhatsApp. They paste the code once on their device.</span>
      </div>
    </div>
    <div class="field"><label>Export data</label><button class="btn btn-full" onclick="exportJSON()">⬇ Download roster-data.json</button></div>
    <div class="divider"></div>
    <button class="btn btn-danger btn-full" onclick="disconnect()">Disconnect (sign out of this device)</button>
    <div class="modal-footer"><button class="btn btn-primary" onclick="closeSettings()">Done</button></div>
  </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m) closeSettings(); });
}
function closeSettings() {
  const m = $('settings-modal'); if (!m) return;
  const g = $('s-group'); if (g) { state.groupName = g.value.trim(); scheduleSave('Update group name'); }
  m.remove();
}
function exportJSON() {
  const b = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'roster-data.json'; a.click();
}
function disconnect() {
  if (!confirm('Sign out of this device? Data stays safe in GitHub.')) return;
  localStorage.removeItem(CFG_KEY); localStorage.removeItem(DATA_KEY); location.reload();
}

// ── SEARCHABLE DROPDOWN ───────────────────────────────────────────────────────
function openSearchDropdown() {
  const overlay = $('search-dropdown');
  overlay.style.display = 'flex';
  const input = $('search-dropdown-input');
  input.value = '';
  renderSearchDropdownList('');
  setTimeout(() => input.focus(), 50);
}

function closeSearchDropdown() {
  $('search-dropdown').style.display = 'none';
}

function filterSearchDropdown() {
  renderSearchDropdownList($('search-dropdown-input').value);
}

function renderSearchDropdownList(query) {
  const q = query.toLowerCase().trim();
  const singers = state.singers.filter(s => {
    if (state.session.entries.some(e => e.singerId === s.id)) return false; // already added
    if (!q) return true;
    return s.name.toLowerCase().includes(q) ||
      (s.tags || []).some(t => t.includes(q)) ||
      (s.notes || '').toLowerCase().includes(q);
  });

  const list = $('search-dropdown-list');
  if (!singers.length) {
    list.innerHTML = `<div class="search-dropdown-empty">${q ? 'No singers match "' + esc(q) + '"' : 'All singers have been added to this session'}</div>`;
    return;
  }

  list.innerHTML = singers.map(s => {
    const days = daysSince(s.lastSang);
    const isUnavail = s.tags && s.tags.includes('unavailable');
    const meta = isUnavail ? 'Unavailable'
      : !s.lastSang ? 'Never sung'
      : days >= 60 ? `Due — last sang ${days} days ago`
      : `Last sang ${days} days ago`;
    const metaCls = isUnavail ? 'color:var(--red)' : days >= 60 && !isUnavail && s.lastSang ? 'color:#993C1D' : '';
    return `<div class="search-dropdown-item" onclick="selectSingerFromDropdown(${s.id})">
      <div class="avatar" style="width:30px;height:30px;font-size:11px;">${initials(s.name)}</div>
      <div style="flex:1;min-width:0;">
        <div class="sd-name">${esc(s.name)}</div>
        <div class="sd-meta" style="${metaCls}">${meta}</div>
        <div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px;">${tagHtml(s.tags, true)}</div>
      </div>
    </div>`;
  }).join('');
}

function selectSingerFromDropdown(id) {
  const s = state.singers.find(x => x.id === id);
  if (!s) return;
  closeSearchDropdown();
  // Update trigger button label
  const val = $('singer-search-value');
  if (val) { val.textContent = s.name; val.classList.remove('placeholder'); }
  // Add to session and open bhajan modal
  if (!state.session.entries.some(e => e.singerId === id)) {
    state.session.entries.push({ singerId: id, singerName: s.name, bhajan: '', link: '', lyrics: '' });
    scheduleSave('Add singer to session');
    renderSession();
    openBhajanModal(state.session.entries.length - 1);
  } else {
    toast(`${s.name} is already in the session`);
  }
  // Reset trigger
  setTimeout(() => {
    const val2 = $('singer-search-value');
    if (val2) { val2.textContent = 'Search and select a singer…'; val2.classList.add('placeholder'); }
  }, 100);
}

// Close dropdown on overlay click or Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearchDropdown(); });
$('search-dropdown').addEventListener('click', e => { if (e.target === $('search-dropdown')) closeSearchDropdown(); });

// ── ROSTER ────────────────────────────────────────────────────────────────────
function renderFilterRow() {
  const row = $('filter-row'); if (!row) return;
  let h = `<button class="filter-btn ${activeFilter === null ? 'on' : ''}" onclick="setFilter(null)">All</button>`;
  ALL_TAGS.forEach(t => {
    if (state.singers.some(s => s.tags && s.tags.includes(t.key)))
      h += `<button class="filter-btn ${activeFilter === t.key ? 'on' : ''}" onclick="setFilter('${t.key}')">${t.label}</button>`;
  });
  row.innerHTML = h;
}
function setFilter(f) { activeFilter = f; renderRoster(); }

function renderRoster() {
  renderFilterRow();
  let singers = [...state.singers].sort((a, b) => daysSince(a.lastSang) - daysSince(b.lastSang)).reverse();
  if (activeFilter) singers = singers.filter(s => s.tags && s.tags.includes(activeFilter));
  const all = state.singers;
  const statsEl = $('stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="stat"><div class="stat-label">Total singers</div><div class="stat-val">${all.length}</div></div>
    <div class="stat"><div class="stat-label">Sung recently</div><div class="stat-val">${all.filter(s => daysSince(s.lastSang) < 60).length}</div></div>
    <div class="stat"><div class="stat-label">Due to sing</div><div class="stat-val">${all.filter(s => daysSince(s.lastSang) >= 60 && !(s.tags && s.tags.includes('unavailable'))).length}</div></div>
    <div class="stat"><div class="stat-label">Instrumentalists</div><div class="stat-val">${state.instrumentalists.length}</div></div>
  `;
  const list = $('singer-list'); if (!list) return;
  if (!singers.length) { list.innerHTML = '<div class="empty">No singers yet. Add one or import from CSV.</div>'; return; }
  list.innerHTML = singers.map(s => {
    const days = daysSince(s.lastSang);
    const isUnavail = s.tags && s.tags.includes('unavailable');
    const badge = isUnavail
      ? '<span class="badge badge-unavail">Unavailable</span>'
      : !s.lastSang ? '<span class="badge badge-new">New</span>'
      : days >= 60  ? `<span class="badge badge-overdue">Due — ${days}d ago</span>`
      :               `<span class="badge badge-ok">${days}d ago</span>`;
    const visibleTags = (s.tags || []).filter(t => t !== 'unavailable');
    return `<div class="card"><div class="singer-row">
      <div class="avatar">${initials(s.name)}</div>
      <div class="singer-info">
        <div class="singer-name">${esc(s.name)}${badge}</div>
        <div class="singer-meta">Last sang: ${fmtDate(s.lastSang)}</div>
        ${visibleTags.length ? `<div class="tags-row">${tagHtml(visibleTags)}</div>` : ''}
        ${s.notes ? `<div class="singer-notes">📝 ${esc(s.notes)}</div>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn btn-sm" onclick="openSingerModal(${s.id})">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="removeSinger(${s.id})">✕</button>
      </div>
    </div></div>`;
  }).join('');
}

function openSingerModal(id) {
  editSingerId = id || null;
  $('singer-modal-title').textContent = id ? 'Edit singer' : 'Add singer';
  const s = id ? state.singers.find(x => x.id === id) : null;
  $('m-name').value  = s ? s.name     : '';
  $('m-date').value  = s ? s.lastSang || '' : '';
  $('m-notes').value = s ? s.notes    || '' : '';
  document.querySelectorAll('#singer-modal .tags-check input').forEach(cb => {
    cb.checked = s && s.tags ? s.tags.includes(cb.value) : false;
  });
  $('singer-modal').classList.add('open');
}
function closeSingerModal() { $('singer-modal').classList.remove('open'); editSingerId = null; }

function saveSinger() {
  const name = ($('m-name').value || '').trim();
  if (!name) { toast('Please enter a name'); return; }
  const date  = $('m-date').value;
  const notes = ($('m-notes').value || '').trim();
  const tags  = [...document.querySelectorAll('#singer-modal .tags-check input:checked')].map(cb => cb.value);
  if (editSingerId) {
    const s = state.singers.find(x => x.id === editSingerId);
    s.name = name; s.lastSang = date || null; s.notes = notes; s.tags = tags;
  } else {
    state.singers.push({ id: state.nextId++, name, lastSang: date || null, tags, notes });
  }
  scheduleSave(editSingerId ? 'Edit singer' : 'Add singer');
  closeSingerModal(); renderRoster();
  toast(editSingerId ? 'Singer updated ✓' : 'Singer added ✓');
}

function removeSinger(id) {
  if (!confirm('Remove this singer?')) return;
  state.singers = state.singers.filter(s => s.id !== id);
  state.session.entries = state.session.entries.filter(e => e.singerId !== id);
  scheduleSave('Remove singer'); renderRoster();
}

// ── INSTRUMENTALISTS ──────────────────────────────────────────────────────────
function renderInstrumentalists() {
  const list = $('inst-list'); if (!list) return;

  // Filter row by availability
  const instFilterRow = $('inst-filter-row');
  if (instFilterRow) {
    const avails = [...new Set(state.instrumentalists.map(i => i.availability || 'available'))];
    let h = `<button class="filter-btn on" id="inst-filter-all" onclick="setInstFilter(null, this)">All</button>`;
    INST_AVAILABILITY.forEach(a => {
      if (avails.includes(a.key))
        h += `<button class="filter-btn" onclick="setInstFilter('${a.key}', this)">${a.label}</button>`;
    });
    instFilterRow.innerHTML = h;
  }

  if (!state.instrumentalists.length) {
    list.innerHTML = '<div class="empty">No instrumentalists yet. Add one above.</div>';
    return;
  }
  renderInstList(state.instrumentalists);
}

function setInstFilter(val, el) {
  document.querySelectorAll('#inst-filter-row .filter-btn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  const filtered = val ? state.instrumentalists.filter(i => (i.availability || 'available') === val) : state.instrumentalists;
  renderInstList(filtered);
}

function renderInstList(instrumentalists) {
  const list = $('inst-list'); if (!list) return;
  if (!instrumentalists.length) { list.innerHTML = '<div class="empty">No instrumentalists match this filter.</div>'; return; }
  list.innerHTML = instrumentalists.map(inst => {
    const avail = INST_AVAILABILITY.find(a => a.key === (inst.availability || 'available'));
    const badge = avail ? `<span class="badge ${avail.badgeCls}">${avail.label}</span>` : '';
    return `<div class="card"><div class="inst-card">
      <div class="avatar">🎵</div>
      <div class="singer-info">
        <div class="singer-name">${esc(inst.name)}${badge}</div>
        <div class="inst-instrument">🎸 ${esc(inst.instrument || 'Instrument not specified')}</div>
        ${inst.notes ? `<div class="singer-notes">📝 ${esc(inst.notes)}</div>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn btn-sm" onclick="openInstModal(${inst.id})">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="removeInst(${inst.id})">✕</button>
      </div>
    </div></div>`;
  }).join('');
}

function openInstModal(id) {
  editInstId = id || null;
  $('inst-modal-title').textContent = id ? 'Edit instrumentalist' : 'Add instrumentalist';
  const inst = id ? state.instrumentalists.find(x => x.id === id) : null;
  $('im-name').value         = inst ? inst.name       || '' : '';
  $('im-instrument').value   = inst ? inst.instrument  || '' : '';
  $('im-notes').value        = inst ? inst.notes       || '' : '';
  $('im-availability').value = inst ? inst.availability || 'available' : 'available';
  $('inst-modal').classList.add('open');
}
function closeInstModal() { $('inst-modal').classList.remove('open'); editInstId = null; }

function saveInstrumentalist() {
  const name         = ($('im-name').value || '').trim();
  const instrument   = ($('im-instrument').value || '').trim();
  const notes        = ($('im-notes').value || '').trim();
  const availability = $('im-availability').value;
  if (!name) { toast('Please enter a name'); return; }
  if (editInstId) {
    const inst = state.instrumentalists.find(x => x.id === editInstId);
    inst.name = name; inst.instrument = instrument; inst.notes = notes; inst.availability = availability;
  } else {
    state.instrumentalists.push({ id: state.nextInstId++, name, instrument, notes, availability });
  }
  scheduleSave(editInstId ? 'Edit instrumentalist' : 'Add instrumentalist');
  closeInstModal(); renderInstrumentalists();
  toast(editInstId ? 'Instrumentalist updated ✓' : 'Instrumentalist added ✓');
}

function removeInst(id) {
  if (!confirm('Remove this instrumentalist?')) return;
  state.instrumentalists = state.instrumentalists.filter(i => i.id !== id);
  scheduleSave('Remove instrumentalist'); renderInstrumentalists();
}

// ── SESSION ───────────────────────────────────────────────────────────────────
function renderSession() {
  const di = $('session-date');
  if (di && !di.value) di.value = state.session.date || new Date().toISOString().split('T')[0];

  const suggested = [...state.singers]
    .filter(s => daysSince(s.lastSang) >= 45 && !(s.tags && s.tags.includes('unavailable')) && !(s.tags && s.tags.includes('special')))
    .sort((a, b) => daysSince(b.lastSang) - daysSince(a.lastSang))
    .slice(0, 5);

  const sugEl = $('suggested-list');
  if (sugEl) {
    if (!suggested.length) {
      sugEl.innerHTML = '<div class="empty" style="padding:.75rem;">All singers have sung recently 🙏</div>';
    } else {
      sugEl.innerHTML = suggested.map(s => {
        const days   = daysSince(s.lastSang);
        const inSess = state.session.entries.some(e => e.singerId === s.id);
        return `<div class="sug-card">
          <div class="avatar">${initials(s.name)}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:500;">${esc(s.name)}</div>
            <div class="tags-row" style="margin-top:3px;">${tagHtml(s.tags, true)}</div>
            <div class="singer-meta">${s.lastSang ? `Last sang ${days} days ago` : 'Never sung'}${s.notes ? ` · ${esc(s.notes)}` : ''}</div>
          </div>
          ${inSess
            ? '<span class="badge badge-ok" style="flex-shrink:0;">✓ Added</span>'
            : `<button class="btn btn-sm btn-success" style="flex-shrink:0;" onclick="quickAddSinger(${s.id})">+ Add</button>`
          }
        </div>`;
      }).join('');
    }
  }

  renderProgrammeTable();
}

// ── CALENDAR ─────────────────────────────────────────────────────────────────
function renderCalendar(monthDate) {
  // monthDate = Date string YYYY-MM-DD or Date object; default = today
  let ref;
  if (monthDate) {
    if (typeof monthDate === 'string') {
      const [y, m] = monthDate.split('-'); ref = new Date(Number(y), Number(m) - 1, 1);
    } else ref = new Date(monthDate);
  } else {
    ref = new Date();
  }
  const year = ref.getFullYear(), month = ref.getMonth();
  const first = new Date(year, month, 1);
  const startDay = first.getDay(); // 0..6 (Sun..Sat)
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = $('calendar-grid'); if (!grid) return;
  const pad = n => String(n).padStart(2, '0');
  const prevYear = month === 0 ? year - 1 : year;
  const prevMonth = month === 0 ? 12 : month;
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 1 : month + 2;
  const prevIso = `${prevYear}-${pad(prevMonth)}-01`;
  const nextIso = `${nextYear}-${pad(nextMonth)}-01`;
  let h = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
    <button class="btn btn-sm" onclick="renderCalendar('${prevIso}')">◀</button>
    <div style="font-weight:600;">${ref.toLocaleString('en-AU', { month: 'long' })} ${year}</div>
    <button class="btn btn-sm" onclick="renderCalendar('${nextIso}')">▶</button>
  </div>`;
  h += `<div style="display:grid;grid-template-columns:repeat(7,40px);gap:6px;margin-bottom:6px;font-size:12px;color:var(--text3);">
    <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
  </div>`;
  h += `<div style="display:grid;grid-template-columns:repeat(7,40px);gap:6px;">`;
  // blanks
  for (let i = 0; i < startDay; i++) h += `<div></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${pad(month + 1)}-${pad(d)}`;
    const has = state.calendar && state.calendar[iso] && state.calendar[iso].length;
    h += `<button class="cal-day" style="padding:6px;border-radius:6px;border:1px solid transparent;${has ? 'background:rgba(0,123,255,0.06);' : ''}" onclick="calSelectDate('${iso}')">${d}${has ? ' •' : ''}</button>`;
  }
  h += `</div>`;
  grid.innerHTML = h;
  // set selected date display
  $('cal-selected-date').textContent = '—';
  $('cal-entries').innerHTML = 'Select a date to see planned singers.';
}

function calSelectDate(iso) {
  $('cal-selected-date').textContent = fmtDate(iso);
  const arr = (state.calendar && state.calendar[iso]) || [];
  const wrap = $('cal-entries'); if (!wrap) return;
  if (!arr.length) { wrap.innerHTML = '<div class="empty">No singers planned for this date.</div>'; return; }
  wrap.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;">${arr.map((e, i) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-weight:600;">${esc(e.singerName)}</div>
        <div style="font-size:12px;color:var(--text3);">${esc(e.bhajan || '—')}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn btn-xs" onclick="openCalEdit('${iso}', ${i})">✏️</button>
        <button class="btn btn-xs btn-danger" onclick="removeCalEntry('${iso}', ${i})">✕</button>
      </div>
    </div>`).join('')}</div>`;
}

function removeCalEntry(iso, idx) {
  if (!confirm('Remove this planned singer?')) return;
  state.calendar[iso].splice(idx, 1);
  if (!state.calendar[iso].length) delete state.calendar[iso];
  scheduleSave('Update calendar'); renderCalendar(iso); calSelectDate(iso);
}

function openCalEdit(iso, idx) {
  const e = state.calendar[iso][idx];
  const modal = document.createElement('div');
  modal.className = 'modal-bg open'; modal.id = 'calendar-edit-modal';
  modal.innerHTML = `<div class="modal" style="max-width:520px;">
    <div class="modal-title">Edit planned singer — ${esc(e.singerName)}</div>
    <div class="field"><label>Bhajan</label><input type="text" id="cal-bhajan" value="${esc(e.bhajan || '')}" /></div>
    <div class="field"><label>Link</label><input type="url" id="cal-link" value="${esc(e.link || '')}" /></div>
    <div class="field"><label>Lyrics / notes</label><textarea id="cal-lyrics" rows="6">${esc(e.lyrics || '')}</textarea></div>
    <div class="modal-footer"><button class="btn" onclick="closeCalEdit()">Cancel</button><button class="btn btn-primary" onclick="saveCalEdit('${iso}', ${idx})">Save</button></div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', ev => { if (ev.target === modal) closeCalEdit(); });
}

function closeCalEdit() { const m = document.getElementById('calendar-edit-modal'); if (m) m.remove(); }

function saveCalEdit(iso, idx) {
  const bhajan = ($('cal-bhajan').value || '').trim();
  const link = ($('cal-link').value || '').trim();
  const lyrics = ($('cal-lyrics').value || '').trim();
  state.calendar[iso][idx] = Object.assign({}, state.calendar[iso][idx], { bhajan, link, lyrics });
  scheduleSave('Update calendar'); closeCalEdit(); renderCalendar(iso); calSelectDate(iso); toast('Calendar entry saved ✓');
}

function renderProgrammeTable() {
  const wrap = $('session-table-wrap'); if (!wrap) return;
  const entries = state.session.entries;
  if (!entries.length) {
    wrap.innerHTML = '<div class="empty">No singers added to this session yet.</div>';
    return;
  }
  wrap.innerHTML = `<div class="prog-wrap"><table class="prog-table">
    <thead><tr>
      <th style="width:32px;">#</th>
      <th style="min-width:120px;">Singer</th>
      <th style="min-width:130px;">Bhajan</th>
      <th style="min-width:180px;">Links &amp; Lyrics</th>
      <th style="width:70px;text-align:right;"></th>
    </tr></thead>
    <tbody>
    ${entries.map((e, i) => {
      const s = state.singers.find(x => x.id === e.singerId);
      const saiPill = e.link
        ? `<a href="${esc(e.link)}" target="_blank" class="pill pill-blue">🎵 Sai Rhythms ↗</a>`
        : `<a href="${SAI_BASE + encodeURIComponent(e.bhajan || '')}" target="_blank" class="pill pill-blue" style="opacity:.65;">🔍 Search Sai Rhythms</a>`;
      const lyrPill = e.lyrics
        ? `<button class="pill pill-green" onclick="toggleLyrics(${i})" id="lbtn-${i}">📄 Show lyrics</button>`
        : `<button class="pill pill-amber" onclick="openBhajanModal(${i})" id="lbtn-${i}">+ Add lyrics</button>`;
      const lyrBlock = e.lyrics
        ? `<div class="lyrics-block" id="lyrics-${i}" style="display:none;">${esc(e.lyrics)}</div>`
        : `<div id="lyrics-${i}"></div>`;
      return `<tr data-idx="${i}"
          ondragover="progDragOver(event, ${i})"
          ondrop="progDrop(event, ${i})"
          ondragleave="progDragLeave(event, ${i})">
        <td style="width:48px;display:flex;align-items:center;gap:8px;">
          <button class="drag-handle" draggable="true" ondragstart="progDragStart(event, ${i})" ondragend="progDragEnd(event, ${i})" title="Drag to reorder">☰</button>
          <span style="font-size:13px;font-weight:600;color:var(--text2);">${i + 1}</span>
        </td>
        <td>
          <div class="prog-name">${esc(e.singerName)}</div>
          ${s ? `<div class="tags-row" style="margin-top:4px;">${tagHtml(s.tags, true)}</div>` : ''}
        </td>
        <td><span style="font-size:13px;">${esc(e.bhajan || '—')}</span></td>
        <td>
          <div class="prog-links-wrap">${saiPill}${lyrPill}</div>
          ${lyrBlock}
        </td>
        <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end;align-items:center;">
          <button class="btn btn-xs" onclick="moveEntryUp(${i})" title="Move up">▲</button>
          <button class="btn btn-xs" onclick="moveEntryDown(${i})" title="Move down">▼</button>
          <button class="btn btn-xs" onclick="openBhajanModal(${i})" title="Edit">✏️</button>
          <button class="btn btn-xs btn-danger" onclick="removeFromSession(${i})" title="Remove">✕</button>
        </td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

function toggleLyrics(i) {
  const block = $(`lyrics-${i}`), btn = $(`lbtn-${i}`);
  if (!block || !btn) return;
  const shown = block.style.display === 'block';
  block.style.display = shown ? 'none' : 'block';
  btn.textContent = shown ? '📄 Show lyrics' : '📄 Hide lyrics';
}

function quickAddSinger(id) {
  const s = state.singers.find(x => x.id === id);
  if (state.session.entries.some(e => e.singerId === id)) { toast(`${s.name} is already in the session`); return; }
  state.session.entries.push({ singerId: id, singerName: s.name, bhajan: '', link: '', lyrics: '' });
  scheduleSave('Add singer to session');
  renderSession();
  openBhajanModal(state.session.entries.length - 1);
}

function removeFromSession(i) { state.session.entries.splice(i, 1); scheduleSave('Remove from session'); renderProgrammeTable(); }

function moveEntry(from, to) {
  const entries = state.session.entries;
  if (!entries || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return;
  // swap entries
  const tmp = entries[to]; entries[to] = entries[from]; entries[from] = tmp;
  // adjust editEntryIdx if modal is open for an entry being moved
  if (typeof editEntryIdx === 'number') {
    if (editEntryIdx === from) editEntryIdx = to;
    else if (editEntryIdx === to) editEntryIdx = from;
  }
  scheduleSave('Reorder session'); renderProgrammeTable();
}

function moveEntryUp(i) { moveEntry(i, i - 1); }
function moveEntryDown(i) { moveEntry(i, i + 1); }

function moveEntryTo(from, to) {
  const entries = state.session.entries;
  if (!entries || from < 0 || to < 0 || from >= entries.length || to > entries.length) return;
  if (from === to) return;
  // remove from
  const [item] = entries.splice(from, 1);
  // adjust target when removing earlier item
  const tgt = from < to ? to - 1 : to;
  entries.splice(tgt, 0, item);
  // update editEntryIdx if needed
  if (typeof editEntryIdx === 'number') {
    if (editEntryIdx === from) editEntryIdx = tgt;
    else if (from < editEntryIdx && tgt >= editEntryIdx) editEntryIdx -= 1;
    else if (from > editEntryIdx && tgt <= editEntryIdx) editEntryIdx += 1;
  }
  scheduleSave('Reorder session'); renderProgrammeTable();
}

// Drag & drop handlers for programme rows
function ensureProgDragStyles() {
  if (window._progDragStylesAdded) return;
  const css = `
    #session-table-wrap tr.dragging { opacity: 0.6; }
    #session-table-wrap tr.drag-over-above td { background: rgba(0,123,255,0.04); }
    #session-table-wrap tr.drag-over-above td::before { content: ''; display:block; height:3px; background: rgba(0,123,255,0.9); margin-top:-3px; }
    #session-table-wrap tr.drag-over-below td { background: rgba(0,123,255,0.04); }
    #session-table-wrap tr.drag-over-below td::after { content: ''; display:block; height:3px; background: rgba(0,123,255,0.9); margin-bottom:-3px; }
    .drag-handle { cursor: grab; padding:4px 6px; border-radius:4px; background:transparent; border:1px solid transparent; }
    .drag-handle:active { cursor:grabbing; }
    .drag-handle:hover { background: rgba(0,0,0,0.03); }
  `;
  const s = document.createElement('style'); s.setAttribute('data-generated','prog-drag-styles'); s.appendChild(document.createTextNode(css));
  document.head.appendChild(s);
  window._progDragStylesAdded = true;
}

function progDragStart(e, idx) {
  ensureProgDragStyles();
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) {}
  window._progDragSrc = idx;
  // e.currentTarget is the handle; find the row and mark it
  const row = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('tr') : null;
  if (row) row.classList.add('dragging');
}

function progDragOver(e, idx) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const tr = e.currentTarget;
  if (!tr) return;
  // clear any previous indicators on all rows
  document.querySelectorAll('#session-table-wrap tr.drag-over-above, #session-table-wrap tr.drag-over-below').forEach(r => r.classList.remove('drag-over-above','drag-over-below'));
  const rect = tr.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  if (e.clientY < mid) tr.classList.add('drag-over-above'); else tr.classList.add('drag-over-below');
}

function progDrop(e, idx) {
  e.preventDefault();
  const from = window._progDragSrc !== undefined ? window._progDragSrc : parseInt(e.dataTransfer.getData('text/plain'));
  const tr = e.currentTarget;
  let to = idx;
  if (tr && tr.classList.contains('drag-over-below')) to = idx + 1; // insert after
  if (typeof from === 'number' && !isNaN(from)) moveEntryTo(from, to);
  // cleanup classes
  const trs = document.querySelectorAll('#session-table-wrap tr'); trs.forEach(t => t.classList.remove('drag-over-above','drag-over-below','dragging'));
  window._progDragSrc = undefined;
}

function progDragLeave(e, idx) { const tr = e.currentTarget; if (tr) { tr.classList.remove('drag-over-above','drag-over-below'); } }
function progDragEnd(e, idx) { const row = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('tr') : null; if (row) row.classList.remove('dragging'); window._progDragSrc = undefined; }

async function finaliseSession() {
  if (!state.session.entries.length) { toast('No singers in session'); return; }
  const date = state.session.date || new Date().toISOString().split('T')[0];
  // update lastSang for singers
  state.session.entries.forEach(e => { const s = state.singers.find(x => x.id === e.singerId); if (s) s.lastSang = date; });
  // prepare programme to save into calendar (append to existing plans for the date)
  const list = state.session.entries.map(e => ({ singerId: e.singerId, singerName: e.singerName, bhajan: e.bhajan || '', link: e.link || '', lyrics: e.lyrics || '' }));
  state.calendar = state.calendar || {};
  if (!state.calendar[date]) state.calendar[date] = [];
  list.forEach(item => {
    if (!state.calendar[date].some(x => x.singerId === item.singerId && x.bhajan === item.bhajan)) state.calendar[date].push(item);
  });
  // reset session date to today
  state.session.date = new Date().toISOString().split('T')[0];
  // save both roster and calendar files (calendar first to capture migration)
  const calOk = await saveCalendarToGitHub('Finalise session — calendar');
  const rosterOk = await saveToGitHub('Finalise session');
  renderSession(); renderRoster();
  if (calOk && rosterOk) toast('Session finalised! All dates updated 🙏');
  else toast('Session finalised locally; could not save to GitHub.');
}
function clearSession() {
  if (!confirm('Clear all singers from this session?')) return;
  state.session.entries = []; scheduleSave('Clear session'); renderSession();
}

// ── BHAJAN MODAL ──────────────────────────────────────────────────────────────
function updateSaiSearch() {
  const btn = $('bm-search-btn');
  if (btn) btn.href = SAI_BASE + encodeURIComponent(($('bm-bhajan').value || '').trim());
}

function openBhajanModal(idx) {
  editEntryIdx = idx;
  const e = state.session.entries[idx];
  $('bhajan-modal-title').textContent = `Bhajan details — ${esc(e.singerName)}`;
  $('bm-bhajan').value = e.bhajan || '';
  $('bm-link').value   = e.link   || '';
  $('bm-lyrics').value = e.lyrics || '';
  $('bm-search-btn').href = SAI_BASE + encodeURIComponent(e.bhajan || '');
  $('bhajan-modal').classList.add('open');
}
function closeBhajanModal() { $('bhajan-modal').classList.remove('open'); editEntryIdx = null; }

function saveBhajan() {
  if (editEntryIdx === null) return;
  const e = state.session.entries[editEntryIdx];
  e.bhajan = ($('bm-bhajan').value || '').trim();
  e.link   = ($('bm-link').value   || '').trim();
  e.lyrics = ($('bm-lyrics').value || '').trim();
  scheduleSave('Update bhajan details');
  closeBhajanModal(); renderProgrammeTable();
  toast('Bhajan details saved ✓');
}

// ── CSV IMPORT ────────────────────────────────────────────────────────────────
function openImport() { csvHeaders = []; csvRows = []; csvMapping = {}; renderImportStep1(); $('import-modal').classList.add('open'); }
function closeImport() { $('import-modal').classList.remove('open'); }

function renderImportStep1() {
  $('import-modal-inner').innerHTML = `
    <div class="modal-title">⬆ Import from CSV</div>
    <div class="step-indicator">
      <div class="step-dot active">1 Upload</div><div class="step-dot">2 Map columns</div><div class="step-dot">3 Preview &amp; import</div>
    </div>
    <div class="info-box"><strong>Export from your spreadsheet:</strong><br>
      Google Sheets: <em>File → Download → Comma-separated values (.csv)</em><br>
      Excel: <em>File → Save As → CSV (Comma delimited)</em></div>
    <div class="drop-zone" id="drop-zone" onclick="$('csv-file-input').click()"
         ondragover="handleDragOver(event)" ondragleave="handleDragLeave()" ondrop="handleDrop(event)">
      <input type="file" id="csv-file-input" accept=".csv,.txt" onchange="handleFileSelect(event)" />
      <div style="font-size:32px;margin-bottom:8px;">📂</div>
      <div style="font-size:14px;font-weight:500;color:var(--text2);">Click to choose your CSV file</div>
      <div style="font-size:12px;color:var(--text3);margin-top:4px;">or drag and drop it here</div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeImport()">Cancel</button></div>
  `;
}

function handleDragOver(e) { e.preventDefault(); $('drop-zone').classList.add('over'); }
function handleDragLeave()  { $('drop-zone').classList.remove('over'); }
function handleDrop(e)      { e.preventDefault(); $('drop-zone').classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readCSVFile(f); }
function handleFileSelect(e){ const f = e.target.files[0]; if (f) readCSVFile(f); }

function readCSVFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = parseCSV(e.target.result);
      if (parsed.length < 2) { toast('CSV appears empty'); return; }
      csvHeaders = parsed[0];
      csvRows    = parsed.slice(1).filter(r => r.some(c => c.trim()));
      autoMapColumns();
      renderImportStep2();
    } catch (err) { toast('Could not read CSV: ' + err.message); }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuote) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(field.trim()); field = ''; }
      else if (ch === '\r' && next === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; i++; }
      else if (ch === '\n' || ch === '\r') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
      else { field += ch; }
    }
  }
  if (field || row.length) row.push(field.trim());
  if (row.length) rows.push(row);
  return rows;
}

function autoMapColumns() {
  csvMapping = {};
  csvHeaders.forEach((h, i) => {
    const l = h.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    if (l.includes('name') && !l.includes('bhajan')) csvMapping[i] = 'name';
    else if (l.includes('last') || l.includes('date') || l.includes('sang')) csvMapping[i] = 'lastSang';
    else if (l.includes('note') || l.includes('comment') || l.includes('remark')) csvMapping[i] = 'notes';
    else csvMapping[i] = '_ignore';
  });
  if (!Object.values(csvMapping).includes('name') && csvHeaders.length > 0) csvMapping[0] = 'name';
}

function renderImportStep2() {
  const previewRows = csvRows.slice(0, 3);
  $('import-modal-inner').innerHTML = `
    <div class="modal-title">⬆ Import from CSV</div>
    <div class="step-indicator">
      <div class="step-dot done">1 Upload</div><div class="step-dot active">2 Map columns</div><div class="step-dot">3 Preview &amp; import</div>
    </div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:1rem;">Found <strong>${csvHeaders.length} columns</strong> and <strong>${csvRows.length} rows</strong>. Check the mappings:</p>
    <table class="map-table">
      <thead><tr><th>Your column</th><th>Sample data</th><th>Maps to</th></tr></thead>
      <tbody>
        ${csvHeaders.map((h, i) => `<tr>
          <td><strong>${esc(h)}</strong></td>
          <td style="color:var(--text2);font-size:12px;">${esc(previewRows.map(r => r[i] || '').filter(Boolean).slice(0, 2).join(', '))}</td>
          <td><select onchange="csvMapping[${i}]=this.value">
            ${CSV_APP_FIELDS.map(f => `<option value="${f.key}" ${csvMapping[i] === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}
          </select></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="modal-footer">
      <button class="btn" onclick="renderImportStep1()">← Back</button>
      <button class="btn btn-primary" onclick="renderImportStep3()">Preview →</button>
    </div>
  `;
}

function renderImportStep3() {
  const nameIdx = Object.entries(csvMapping).find(([_, v]) => v === 'name')?.[0];
  if (nameIdx === undefined) { toast('Please map a column to "Singer name"'); return; }
  const imported = [];
  csvRows.forEach(row => {
    const obj = { name: '', lastSang: null, notes: '', tags: [] };
    Object.entries(csvMapping).forEach(([i, field]) => {
      if (field === '_ignore') return;
      const val = (row[i] || '').trim(); if (!val) return;
      if (field === 'name') obj.name = val;
      else if (field === 'lastSang') obj.lastSang = parseFlexDate(val);
      else if (field === 'notes') obj.notes = val;
    });
    if (obj.name) imported.push(obj);
  });
  $('import-modal-inner').innerHTML = `
    <div class="modal-title">⬆ Import from CSV</div>
    <div class="step-indicator">
      <div class="step-dot done">1 Upload</div><div class="step-dot done">2 Map columns</div><div class="step-dot active">3 Preview &amp; import</div>
    </div>
    ${imported.length === 0 ? `<div class="warn-box">No valid rows found. Go back and check column mapping.</div>` : `
    <div class="green-box">✓ Ready to import <strong>${imported.length} singers</strong></div>
    <div style="overflow-x:auto;margin-bottom:1rem;">
      <table class="preview-table">
        <thead><tr><th>Name</th><th>Last sang</th><th>Notes</th></tr></thead>
        <tbody>
          ${imported.slice(0, 5).map(s => `<tr><td>${esc(s.name)}</td><td>${s.lastSang ? fmtDate(s.lastSang) : '—'}</td><td>${esc(s.notes || '—')}</td></tr>`).join('')}
          ${imported.length > 5 ? `<tr><td colspan="3" style="color:var(--text3);font-style:italic;">… and ${imported.length - 5} more</td></tr>` : ''}
        </tbody>
      </table>
    </div>
    <div class="field">
      <label>What to do with existing singers?</label>
      <select id="import-mode">
        <option value="merge">Merge — add new singers, skip duplicates (recommended)</option>
        <option value="replace">Replace — clear all existing singers first</option>
      </select>
    </div>`}
    <div class="modal-footer">
      <button class="btn" onclick="renderImportStep2()">← Back</button>
      ${imported.length > 0 ? `<button class="btn btn-primary" onclick='doImport(${JSON.stringify(imported)})'>⬆ Import ${imported.length} singers</button>` : ''}
    </div>
  `;
}

function doImport(imported) {
  const mode = ($('import-mode') || {}).value || 'merge';
  if (mode === 'replace') {
    if (!confirm(`Delete all ${state.singers.length} existing singers and replace?`)) return;
    state.singers = []; state.nextId = 1;
  }
  let added = 0, skipped = 0;
  imported.forEach(imp => {
    if (mode === 'merge' && state.singers.some(s => s.name.toLowerCase() === imp.name.toLowerCase())) { skipped++; return; }
    state.singers.push({ id: state.nextId++, name: imp.name, lastSang: imp.lastSang, tags: [], notes: imp.notes || '' });
    added++;
  });
  saveToGitHub(`Import ${added} singers from CSV`);
  closeImport(); renderRoster();
  toast(`✓ Imported ${added} singers${skipped ? `, skipped ${skipped} duplicates` : ''}`);
}

function parseFlexDate(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy;
    const date = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    if (!isNaN(date)) return date.toISOString().split('T')[0];
  }
  const parsed = new Date(s);
  return !isNaN(parsed) ? parsed.toISOString().split('T')[0] : null;
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
function updateGroupName() {
  const el = $('group-name'); if (el) { state.groupName = el.value.trim(); scheduleSave('Update group name'); }
  refreshWA();
}
function buildWA() {
  const gName  = ($('group-name') || {}).value || state.groupName || 'Bhajan Kirtan Group';
  const date   = state.session.date ? fmtDate(state.session.date) : fmtDate(new Date().toISOString().split('T')[0]);
  const entries = state.session.entries;
  if (!entries.length) return `🙏 *${gName}*\n\nNo singers have been added to this session yet.`;
  let msg = `🙏 *${gName}*\n📅 *${date}*\n\n*Programme:*\n\n`;
  entries.forEach((e, i) => {
    msg += `${i + 1}. *${e.singerName}*`;
    if (e.bhajan) msg += ` — _${e.bhajan}_`;
    if (e.link)   msg += `\n   🎵 ${e.link}`;
    msg += '\n';
  });
  msg += `\n_Jai Sairam_ 🙏`;
  return msg;
}
function refreshWA() {
  const gi = $('group-name'); if (gi && !gi.value) gi.value = state.groupName || '';
  const p  = $('wa-preview'); if (p) p.textContent = buildWA();
}
function copyWA() {
  const msg = buildWA();
  navigator.clipboard.writeText(msg)
    .then(() => toast('Copied! 📋'))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = msg; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Copied! 📋');
    });
}

// ── MODAL CLOSE ON BACKGROUND CLICK ──────────────────────────────────────────
$('singer-modal').addEventListener('click', e => { if (e.target === $('singer-modal')) closeSingerModal(); });
$('bhajan-modal').addEventListener('click', e => { if (e.target === $('bhajan-modal')) closeBhajanModal(); });
$('import-modal').addEventListener('click', e => { if (e.target === $('import-modal')) closeImport(); });
$('inst-modal').addEventListener('click',   e => { if (e.target === $('inst-modal'))   closeInstModal(); });

// ── BOOT ──────────────────────────────────────────────────────────────────────
(async function boot() {
  cfg = loadCfg();
  if (!cfg) {
    window.BHAJAN_OWNER ? renderJoin('') : renderJoinFull('');
    return;
  }
  if (loadLocal()) renderApp();
  const ok = await loadFromGitHub();
  if (ok) {
    if (currentTab === 'roster')      renderRoster();
    if (currentTab === 'session')     renderSession();
    if (currentTab === 'whatsapp')    refreshWA();
    if (currentTab === 'instruments') renderInstrumentalists();
  }
})();
