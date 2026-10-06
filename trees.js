// =====================================================
//  STEP 1: Replace the firebaseConfig block below with
//  YOUR config from the Firebase console.
//  See SETUP-GUIDE.md for step-by-step instructions.
// =====================================================

import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getAuth,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'PASTE_YOUR_API_KEY_HERE',
  authDomain: 'PASTE_YOUR_AUTH_DOMAIN_HERE',
  projectId: 'PASTE_YOUR_PROJECT_ID_HERE',
  storageBucket: 'PASTE_YOUR_STORAGE_BUCKET_HERE',
  messagingSenderId: 'PASTE_YOUR_MESSAGING_SENDER_ID_HERE',
  appId: 'PASTE_YOUR_APP_ID_HERE',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const COL = 'planting2025';
const ACCESS_DOC = 'config/access'; // Firestore path where password lives

// ── state ──────────────────────────────────────────────
let records = [];
let editingId = null;
let noteTargetId = null;
let sortMode = 'status';

const STATUS_ORDER = [
  'Ready to plant',
  'Tree selected',
  'Confirmed request',
  'Interested – contacted',
  'Awaiting response',
  'Letter returned',
  'Letter sent',
  'Planted',
  'Not interested',
  'No response',
  'Hold',
  'Cannot plant',
  'Complete',
  '',
];
const EXPORT_EXCLUDE = new Set(['Hold', 'Cannot plant', 'Complete']);
const COMPLETE_STATUS = 'Complete';
const STATUS_COLORS = {
  'Letter sent': {bg: '#E6F1FB', color: '#0C447C'},
  'Letter returned': {bg: '#FAEEDA', color: '#633806'},
  'Interested – contacted': {bg: '#EAF3DE', color: '#27500A'},
  'Awaiting response': {bg: '#FAEEDA', color: '#854F0B'},
  'Confirmed request': {bg: '#E1F5EE', color: '#0F6E56'},
  'Tree selected': {bg: '#9FE1CB', color: '#085041'},
  'Ready to plant': {bg: '#C0DD97', color: '#3B6D11'},
  Planted: {bg: '#EAF3DE', color: '#3B6D11'},
  'Not interested': {bg: '#F1EFE8', color: '#5F5E5A'},
  'No response': {bg: '#F1EFE8', color: '#5F5E5A'},
  Hold: {bg: '#EDE8F5', color: '#4B3A8C'},
  'Cannot plant': {bg: '#F5E8E8', color: '#8C2B2B'},
  Complete: {bg: '#E8EEE8', color: '#3A5A3A'},
};

let showComplete = false;

// ── season helpers ─────────────────────────────────────
function seasonOptions() {
  const yr = new Date().getFullYear();
  const opts = [];
  for (let y = yr - 2; y <= yr + 2; y++) {
    opts.push('Spring ' + y, 'Fall ' + y);
  }
  return opts;
}

function seasonSelectHTML(id, includeAll, includeUntagged) {
  const opts = seasonOptions();
  const allOpt = includeAll
    ? '<option value="">All seasons</option>'
    : '<option value="">— select season —</option>';
  const untagOpt = includeUntagged
    ? '<option value="__untagged__">Untagged (no season)</option>'
    : '';
  return `<select id="${id}">${allOpt}${untagOpt}${opts
    .map(s => `<option>${s}</option>`)
    .join('')}</select>`;
}

// ── helpers ────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function ts() {
  const d = new Date();
  return (
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }) +
    ' ' +
    d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'})
  );
}
function badge(status) {
  const c = STATUS_COLORS[status] || {bg: '#F1EFE8', color: '#5F5E5A'};
  return `<span class="badge" style="background:${c.bg};color:${c.color};">${status}</span>`;
}
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── auth + password gate ───────────────────────────────
const SESSION_KEY = 'planting_authed';

async function init() {
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    await signInAnonymously(auth);
    showApp();
    loadSeasonLabel();
    startListen();
    return;
  }
  showLock();
}

function showLock() {
  document.getElementById('lock-screen').style.display = 'flex';
  document.getElementById('app-wrap').style.display = 'none';
  setTimeout(() => document.getElementById('lock-input').focus(), 50);
}

function showApp() {
  document.getElementById('lock-screen').style.display = 'none';
  document.getElementById('app-wrap').style.display = 'block';
}

async function submitPassword() {
  const entered = document.getElementById('lock-input').value.trim();
  if (!entered) return;
  const errEl = document.getElementById('lock-error');
  const btn = document.getElementById('lock-btn');
  errEl.textContent = '';
  btn.textContent = 'Checking…';
  btn.disabled = true;
  try {
    await signInAnonymously(auth);
    const snap = await getDoc(doc(db, ACCESS_DOC));
    if (!snap.exists()) {
      errEl.textContent = '⚠ Access config not found — see setup guide.';
      btn.textContent = 'Enter';
      btn.disabled = false;
      return;
    }
    const correct = snap.data().password;
    if (entered === correct) {
      sessionStorage.setItem(SESSION_KEY, '1');
      showApp();
      loadSeasonLabel();
      startListen();
    } else {
      errEl.textContent = 'Incorrect password.';
      document.getElementById('lock-input').value = '';
      document.getElementById('lock-input').focus();
      btn.textContent = 'Enter';
      btn.disabled = false;
    }
  } catch (e) {
    errEl.textContent = '⚠ Connection error — check Firebase config.';
    console.error(e);
    btn.textContent = 'Enter';
    btn.disabled = false;
  }
}

// ── firebase ───────────────────────────────────────────
function startListen() {
  showStatus('Connecting…');
  onSnapshot(
    collection(db, COL),
    snap => {
      records = snap.docs.map(d => ({id: d.id, ...d.data()}));
      hideStatus();
      renderCountBar();
      renderCards();
      if (document.getElementById('history').classList.contains('active'))
        renderHistory();
    },
    err => {
      showStatus('⚠ Connection error — check your Firebase config.');
      console.error(err);
    }
  );
}

async function saveToFirebase(record) {
  const {id, ...data} = record;
  await setDoc(doc(db, COL, id), data);
}

async function deleteFromFirebase(id) {
  await deleteDoc(doc(db, COL, id));
}

// ── status banner ──────────────────────────────────────
function showStatus(msg) {
  document.getElementById('status-bar').textContent = msg;
  document.getElementById('status-bar').style.display = 'block';
}
function hideStatus() {
  document.getElementById('status-bar').style.display = 'none';
}

// ── tabs ───────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document
    .querySelectorAll('.section')
    .forEach(s => s.classList.remove('active'));
  document.getElementById(tab).classList.add('active');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'history') renderHistory();
}
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── sort ───────────────────────────────────────────────
function setSort(mode) {
  sortMode = mode;
  document
    .querySelectorAll('.sort-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
  renderCards();
}
document
  .querySelectorAll('.sort-btn')
  .forEach(b => b.addEventListener('click', () => setSort(b.dataset.sort)));

function sortRecords(arr) {
  if (sortMode === 'status') {
    return arr.sort((a, b) => {
      if (a.followup !== b.followup) return a.followup ? -1 : 1;
      const ai = STATUS_ORDER.indexOf(a.status || ''),
        bi = STATUS_ORDER.indexOf(b.status || '');
      if (ai !== bi) return ai - bi;
      return (a.street || '').localeCompare(b.street || '');
    });
  } else if (sortMode === 'date') {
    return arr.sort((a, b) => {
      if (a.followup !== b.followup) return a.followup ? -1 : 1;
      return (b.updated || '').localeCompare(a.updated || '');
    });
  } else {
    return arr.sort((a, b) => {
      if (a.followup !== b.followup) return a.followup ? -1 : 1;
      return (
        (a.street || '').localeCompare(b.street || '') ||
        (parseInt(a.housenum) || 0) - (parseInt(b.housenum) || 0)
      );
    });
  }
}

// ── add/edit modal ─────────────────────────────────────
function openAdd() {
  editingId = null;
  document.getElementById('modal-title').textContent = 'Add address';
  [
    'housenum',
    'street',
    'owner',
    'email',
    'phone',
    'note',
    'tree1',
    'tree2',
  ].forEach(f => (document.getElementById('f-' + f).value = ''));
  document.getElementById('f-source').value = '';
  document.getElementById('f-status').value = '';
  document.getElementById('f-season').value = '';
  document.getElementById('f-followup').checked = false;
  document.getElementById('modal').classList.add('open');
  document.getElementById('f-housenum').focus();
}

function openEdit(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  editingId = id;
  document.getElementById('modal-title').textContent =
    'Edit — ' + r.housenum + ' ' + r.street;
  document.getElementById('f-housenum').value = r.housenum || '';
  document.getElementById('f-street').value = r.street || '';
  document.getElementById('f-owner').value = r.owner || '';
  document.getElementById('f-source').value = r.source || '';
  document.getElementById('f-email').value = r.email || '';
  document.getElementById('f-phone').value = r.phone || '';
  document.getElementById('f-status').value = r.status || '';
  document.getElementById('f-tree1').value = r.tree1 || '';
  document.getElementById('f-tree2').value = r.tree2 || '';
  document.getElementById('f-season').value = r.season || '';
  document.getElementById('f-followup').checked = !!r.followup;
  document.getElementById('f-note').value = '';
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

async function saveRecord() {
  const housenum = document.getElementById('f-housenum').value.trim();
  const street = document.getElementById('f-street').value.trim();
  if (!housenum || !street) {
    alert('House number and street are required.');
    return;
  }
  const note = document.getElementById('f-note').value.trim();
  const status = document.getElementById('f-status').value;
  const followup = document.getElementById('f-followup').checked;
  const season = document.getElementById('f-season').value;
  let record;
  if (editingId) {
    record = {...records.find(x => x.id === editingId)};
    const prevStatus = record.status,
      prevFollowup = record.followup;
    Object.assign(record, {
      housenum,
      street,
      owner: document.getElementById('f-owner').value.trim(),
      source: document.getElementById('f-source').value,
      email: document.getElementById('f-email').value.trim(),
      phone: document.getElementById('f-phone').value.trim(),
      status,
      followup,
      tree1: document.getElementById('f-tree1').value.trim(),
      tree2: document.getElementById('f-tree2').value.trim(),
      season,
      updated: ts(),
    });
    const logParts = [];
    if (status && status !== prevStatus) logParts.push('Status → ' + status);
    if (followup !== prevFollowup)
      logParts.push(followup ? 'Flagged for follow-up' : 'Follow-up cleared');
    if (note) logParts.push(note);
    if (logParts.length)
      record.log = [
        ...(record.log || []),
        {date: ts(), text: logParts.join(' · ')},
      ];
  } else {
    let initNote = 'Record created';
    if (status) initNote += '. Status: ' + status;
    if (followup) initNote += '. Flagged for follow-up';
    if (note) initNote += ' — ' + note;
    record = {
      id: uid(),
      housenum,
      street,
      owner: document.getElementById('f-owner').value.trim(),
      source: document.getElementById('f-source').value,
      email: document.getElementById('f-email').value.trim(),
      phone: document.getElementById('f-phone').value.trim(),
      status,
      tree1: document.getElementById('f-tree1').value.trim(),
      tree2: document.getElementById('f-tree2').value.trim(),
      season,
      followup,
      created: ts(),
      updated: ts(),
      log: [{date: ts(), text: initNote + '.'}],
    };
  }
  closeModal();
  await saveToFirebase(record);
}

async function deleteRecord(id) {
  if (!confirm('Delete this record? This cannot be undone.')) return;
  await deleteFromFirebase(id);
}

// ── note modal ─────────────────────────────────────────
function openNoteModal(id) {
  noteTargetId = id;
  const r = records.find(x => x.id === id);
  document.getElementById('note-addr-label').textContent =
    r.housenum + ' ' + r.street + (r.owner ? ' · ' + r.owner : '');
  document.getElementById('note-text').value = '';
  document.getElementById('note-status').value = '';
  document.getElementById('note-followup').checked = !!r.followup;
  document.getElementById('note-followup-label').textContent = r.followup
    ? 'Follow-up flagged (uncheck to clear)'
    : 'Flag for follow-up';
  document.getElementById('note-modal').classList.add('open');
  document.getElementById('note-text').focus();
}

function closeNoteModal() {
  document.getElementById('note-modal').classList.remove('open');
  noteTargetId = null;
}

async function saveNote() {
  if (!noteTargetId) return;
  const r = {...records.find(x => x.id === noteTargetId)};
  const note = document.getElementById('note-text').value.trim();
  const newStatus = document.getElementById('note-status').value;
  const newFollowup = document.getElementById('note-followup').checked;
  if (!note && !newStatus && newFollowup === r.followup) {
    alert('Add a note, status update, or flag change.');
    return;
  }
  const logParts = [];
  if (newStatus && newStatus !== r.status) {
    r.status = newStatus;
    logParts.push('Status → ' + newStatus);
  }
  if (newFollowup !== r.followup) {
    r.followup = newFollowup;
    logParts.push(newFollowup ? 'Flagged for follow-up' : 'Follow-up cleared');
  }
  if (note) logParts.push(note);
  r.log = [...(r.log || []), {date: ts(), text: logParts.join(' · ')}];
  r.updated = ts();
  closeNoteModal();
  await saveToFirebase(r);
}

// ── bulk edit ──────────────────────────────────────────
function openBulkModal() {
  document.getElementById('bulk-from').value = '';
  document.getElementById('bulk-to').value = '';
  document.getElementById('bulk-note').value = '';
  document.getElementById('bulk-preview').innerHTML = '';
  document.getElementById('bulk-modal').classList.add('open');
}
function closeBulkModal() {
  document.getElementById('bulk-modal').classList.remove('open');
}

function previewBulk() {
  const from = document.getElementById('bulk-from').value;
  if (!from) {
    document.getElementById('bulk-preview').innerHTML =
      '<span style="color:var(--text-muted);font-size:12px;">Select a "from" status first.</span>';
    return;
  }
  const matches = records.filter(r => r.status === from);
  document.getElementById('bulk-preview').innerHTML = matches.length
    ? `<span style="font-size:12px;color:var(--text-muted);">Will update <strong>${
        matches.length
      }</strong> record${matches.length === 1 ? '' : 's'}: ${matches
        .map(r => r.housenum + ' ' + r.street)
        .join(', ')}</span>`
    : `<span style="font-size:12px;color:var(--text-muted);">No records with that status.</span>`;
}

async function runBulkUpdate() {
  const from = document.getElementById('bulk-from').value;
  const to = document.getElementById('bulk-to').value;
  const note = document.getElementById('bulk-note').value.trim();
  if (!from || !to) {
    alert('Select both a "from" and "to" status.');
    return;
  }
  if (from === to) {
    alert('"From" and "to" status are the same.');
    return;
  }
  const matches = records.filter(r => r.status === from);
  if (!matches.length) {
    alert('No records with that status.');
    return;
  }
  if (
    !confirm(
      `Update ${matches.length} record${
        matches.length === 1 ? '' : 's'
      } from "${from}" to "${to}"?`
    )
  )
    return;
  closeBulkModal();
  showStatus(`Updating ${matches.length} records…`);
  const logText = `Bulk update: ${from} → ${to}` + (note ? ' — ' + note : '');
  for (const r of matches) {
    const updated = {
      ...r,
      status: to,
      updated: ts(),
      log: [...(r.log || []), {date: ts(), text: logText}],
    };
    await saveToFirebase(updated);
  }
  hideStatus();
}

// ── note history modal ─────────────────────────────────
function openHistoryModal(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;
  document.getElementById('hist-modal-title').textContent =
    r.housenum + ' ' + r.street + (r.owner ? ' · ' + r.owner : '');
  const logs = (r.log || []).slice().reverse();
  document.getElementById('hist-modal-body').innerHTML = logs.length
    ? logs
        .map(
          l =>
            `<div class="log-row"><span class="muted" style="font-size:12px;">${esc(
              l.date
            )}</span><br>${esc(l.text)}</div>`
        )
        .join('')
    : '<p class="muted" style="font-size:12px;">No log entries.</p>';
  document.getElementById('hist-modal').classList.add('open');
}
function closeHistoryModal() {
  document.getElementById('hist-modal').classList.remove('open');
}

// ── render ─────────────────────────────────────────────
function renderCountBar() {
  const counts = {},
    flagCount = records.filter(r => r.followup).length;
  records.forEach(r => {
    counts[r.status || 'Unknown'] = (counts[r.status || 'Unknown'] || 0) + 1;
  });
  const order = [
    'Ready to plant',
    'Tree selected',
    'Confirmed request',
    'Interested – contacted',
    'Awaiting response',
    'Letter returned',
    'Letter sent',
    'Planted',
    'Not interested',
    'No response',
    'Hold',
    'Cannot plant',
    'Complete',
  ];
  const completeCount = counts['Complete'] || 0;
  let html = `<div class="count-pill">Total <strong>${records.length}</strong></div>`;
  if (flagCount)
    html += `<div class="count-pill flag-pill"><strong>${flagCount}</strong> follow-up</div>`;
  order.forEach(s => {
    if (counts[s])
      html += `<div class="count-pill">${badge(s)} <strong>${
        counts[s]
      }</strong></div>`;
  });
  document.getElementById('count-bar').innerHTML = html;
  const lbl = document.getElementById('show-complete-label');
  if (lbl) lbl.textContent = `Show complete (${completeCount})`;
}

function renderCards() {
  const q = document.getElementById('search').value.toLowerCase();
  const fs = document.getElementById('filter-status').value;
  const fsrc = document.getElementById('filter-source').value;
  const fflag = document.getElementById('filter-flag').value;
  const fseason = document.getElementById('filter-season').value;
  let filtered = records.filter(r => {
    if (!showComplete && r.status === COMPLETE_STATUS) return false;
    const hay = [
      r.housenum,
      r.street,
      r.owner,
      r.email,
      r.phone,
      r.tree1,
      r.tree2,
      ...(r.log || []).map(l => l.text),
    ]
      .join(' ')
      .toLowerCase();
    const seasonOk =
      !fseason ||
      (fseason === '__untagged__' ? !r.season : r.season === fseason);
    return (
      (!q || hay.includes(q)) &&
      (!fs || r.status === fs) &&
      (!fsrc || r.source === fsrc) &&
      (!fflag || r.followup) &&
      seasonOk
    );
  });
  sortRecords(filtered);
  const el = document.getElementById('cards');
  if (!filtered.length) {
    el.innerHTML = '<p class="empty">No records match your filters.</p>';
    return;
  }
  el.innerHTML = filtered
    .map(r => {
      const trees = [r.tree1, r.tree2].filter(Boolean).join(', ') || '—';
      const logs = r.log || [];
      const lastLog = logs.length ? logs[logs.length - 1] : null;
      const hasMore = logs.length > 1;
      return `<div class="card${r.followup ? ' flagged' : ''}${
        r.status === COMPLETE_STATUS ? ' complete-card' : ''
      }">
      <div class="card-header">
        <div>
          <div class="card-addr">${esc(r.housenum)} ${esc(r.street)}${
            r.followup ? ' <span class="flag-badge">! follow-up</span>' : ''
          }</div>
          <div class="card-meta">${esc(
            r.owner || 'No owner name'
          )} &middot; via ${esc(r.source || 'unknown')}${
            r.season ? ' &middot; ' + esc(r.season) : ''
          } &middot; updated ${esc(r.updated || r.created)}</div>
        </div>
        <div class="card-actions">
          <button class="btn small" onclick="openNoteModal('${
            r.id
          }')">+ Note</button>
          <button class="btn small" onclick="openEdit('${r.id}')">Edit</button>
          <button class="btn small danger" onclick="deleteRecord('${
            r.id
          }')">Delete</button>
        </div>
      </div>
      <div class="card-body">
        <div><div class="field-label">Status</div><div>${
          r.status ? badge(r.status) : '—'
        }</div></div>
        <div><div class="field-label">Trees requested</div><div class="field-val">${esc(
          trees
        )}</div></div>
        <div><div class="field-label">Email</div><div class="field-sm">${esc(
          r.email || '—'
        )}</div></div>
        <div><div class="field-label">Phone</div><div class="field-sm">${esc(
          r.phone || '—'
        )}</div></div>
        ${
          lastLog
            ? `<div class="full-col">
          <div class="field-label" style="display:flex;align-items:center;gap:6px;">
            Last note
            ${
              hasMore
                ? `<button class="notes-expand-btn" onclick="openHistoryModal('${
                    r.id
                  }')">+ ${logs.length - 1} more</button>`
                : ''
            }
          </div>
          <div class="field-sm muted">${esc(lastLog.date)} — ${esc(
            lastLog.text
          )}</div>
        </div>`
            : ''
        }
      </div>
    </div>`;
    })
    .join('');
}

function renderHistory() {
  const q = document.getElementById('hist-search').value.toLowerCase();
  let sorted = [...records];
  sortRecords(sorted);
  const filtered = sorted.filter(r => {
    const hay = [
      r.housenum,
      r.street,
      r.owner,
      ...(r.log || []).map(l => l.text),
    ]
      .join(' ')
      .toLowerCase();
    return !q || hay.includes(q);
  });
  const el = document.getElementById('hist-list');
  if (!filtered.length) {
    el.innerHTML = '<p class="empty">No records found.</p>';
    return;
  }
  el.innerHTML = filtered
    .map(r => {
      const logs = (r.log || []).slice().reverse();
      return `<div class="card${r.followup ? ' flagged' : ''}">
      <div class="card-addr">${esc(r.housenum)} ${esc(
        r.street
      )} <span class="muted">${r.owner ? '· ' + esc(r.owner) : ''}</span>${
        r.followup ? ' <span class="flag-badge">! follow-up</span>' : ''
      }</div>
      <div style="margin-top:8px;">
        ${
          logs.length
            ? logs
                .map(
                  l =>
                    `<div class="log-row"><span class="muted">${esc(
                      l.date
                    )}</span> — ${esc(l.text)}</div>`
                )
                .join('')
            : '<div class="muted" style="font-size:12px;">No log entries yet.</div>'
        }
      </div>
    </div>`;
    })
    .join('');
}

// ── export ─────────────────────────────────────────────
function openExportModal() {
  const container = document.getElementById('export-season-wrap');
  container.innerHTML = seasonSelectHTML('export-season', true, true);
  const seasons = [
    ...new Set(records.map(r => r.season).filter(Boolean)),
  ].sort();
  if (seasons.length === 1)
    document.getElementById('export-season').value = seasons[0];
  document.getElementById('export-modal').classList.add('open');
}
function closeExportModal() {
  document.getElementById('export-modal').classList.remove('open');
}

function doExport() {
  const season = document.getElementById('export-season').value;
  const sorted = [...records];
  sortRecords(sorted);
  const rows = sorted
    .filter(r => {
      if (EXPORT_EXCLUDE.has(r.status) || r.status === COMPLETE_STATUS)
        return false;
      if (!season) return true;
      if (season === '__untagged__') return !r.season;
      return r.season === season;
    })
    .map(r => ({
      'House #': r.housenum,
      Street: r.street,
      Owner: r.owner,
      Email: r.email,
      Phone: r.phone,
      Status: r.status,
      'Tree 1': r.tree1,
      'Tree 2': r.tree2,
      'Follow-up needed': r.followup ? 'YES' : '',
      Notes: r.log && r.log.length ? r.log[r.log.length - 1].text : '',
    }));
  if (!rows.length) {
    alert('No exportable records for that selection.');
    return;
  }
  const label = season === '__untagged__' ? 'untagged' : season || 'all';
  const sheetName = label.replace(/\s+/g, '_').slice(0, 31);
  const filename =
    'planting_' + label.replace(/\s+/g, '_').toLowerCase() + '.xlsx';
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [8, 18, 20, 26, 14, 22, 22, 22, 14, 40].map(w => ({wch: w}));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
  closeExportModal();
}

// ── season label (subtitle) ────────────────────────────
async function loadSeasonLabel() {
  try {
    const snap = await getDoc(doc(db, 'config', 'settings'));
    if (snap.exists() && snap.data().seasonLabel) {
      document.getElementById('season-label').textContent =
        snap.data().seasonLabel;
    }
  } catch (e) {
    /* non-critical */
  }
}

function startEditSeason() {
  const lbl = document.getElementById('season-label');
  const inp = document.getElementById('season-input');
  inp.value = lbl.textContent;
  lbl.style.display = 'none';
  inp.style.display = 'inline-block';
  inp.focus();
  inp.select();
}

function cancelEditSeason() {
  document.getElementById('season-label').style.display = '';
  document.getElementById('season-input').style.display = 'none';
}

async function saveSeason() {
  const inp = document.getElementById('season-input');
  const val = inp.value.trim() || 'East Aurora';
  document.getElementById('season-label').textContent = val;
  cancelEditSeason();
  try {
    await setDoc(
      doc(db, 'config', 'settings'),
      {seasonLabel: val},
      {merge: true}
    );
  } catch (e) {
    /* non-critical */
  }
}

// ── populate season selects ────────────────────────────
function populateSeasonSelects() {
  const opts = seasonOptions();
  const optHTML = opts.map(s => `<option>${s}</option>`).join('');
  document.getElementById(
    'filter-season'
  ).innerHTML = `<option value="">All seasons</option><option value="__untagged__">Untagged</option>${optHTML}`;
  document.getElementById(
    'f-season'
  ).innerHTML = `<option value="">— not set —</option>${optHTML}`;
}

// ── wire up events ─────────────────────────────────────
document.getElementById('lock-btn').addEventListener('click', submitPassword);
document.getElementById('lock-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitPassword();
});

document.getElementById('btn-add').addEventListener('click', openAdd);
document
  .getElementById('btn-export')
  .addEventListener('click', openExportModal);
document.getElementById('btn-save').addEventListener('click', saveRecord);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-save-note').addEventListener('click', saveNote);
document
  .getElementById('btn-cancel-note')
  .addEventListener('click', closeNoteModal);
document.getElementById('btn-bulk').addEventListener('click', openBulkModal);
document
  .getElementById('btn-cancel-bulk')
  .addEventListener('click', closeBulkModal);
document
  .getElementById('btn-run-bulk')
  .addEventListener('click', runBulkUpdate);
document
  .getElementById('btn-close-hist-modal')
  .addEventListener('click', closeHistoryModal);

document.getElementById('btn-reset-filters').addEventListener('click', () => {
  document.getElementById('search').value = '';
  document.getElementById('filter-status').value = '';
  document.getElementById('filter-source').value = '';
  document.getElementById('filter-flag').value = '';
  document.getElementById('filter-season').value = '';
  renderCards();
});

document.getElementById('search').addEventListener('input', renderCards);
document
  .getElementById('filter-status')
  .addEventListener('change', renderCards);
document
  .getElementById('filter-source')
  .addEventListener('change', renderCards);
document.getElementById('filter-flag').addEventListener('change', renderCards);
document
  .getElementById('filter-season')
  .addEventListener('change', renderCards);
document.getElementById('hist-search').addEventListener('input', renderHistory);
document.getElementById('bulk-from').addEventListener('change', previewBulk);

document.getElementById('show-complete').addEventListener('change', e => {
  showComplete = e.target.checked;
  renderCards();
});

document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});
document.getElementById('note-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('note-modal')) closeNoteModal();
});
document.getElementById('export-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('export-modal')) closeExportModal();
});
document.getElementById('bulk-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('bulk-modal')) closeBulkModal();
});
document.getElementById('hist-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('hist-modal')) closeHistoryModal();
});

// ── expose to inline onclick handlers in HTML ──────────
window.openEdit = openEdit;
window.openNoteModal = openNoteModal;
window.deleteRecord = deleteRecord;
window.openHistoryModal = openHistoryModal;
window.closeExportModal = closeExportModal;
window.doExport = doExport;
window.startEditSeason = startEditSeason;
window.saveSeason = saveSeason;
window.cancelEditSeason = cancelEditSeason;

// ── go ─────────────────────────────────────────────────
populateSeasonSelects();
init();
