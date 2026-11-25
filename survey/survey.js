import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
  updateDoc,
  deleteField,
  FieldPath,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {signInAnonymously} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {db, auth} from './firebase.js';
import {
  QUADRANTS,
  STATUSES,
  PRIORITIES,
  SIZES,
  OBSTRUCTIONS,
  addressKey,
  streetKey,
  summarize,
  exportRows,
  nearbyTrees,
  distanceFt,
  planHandoff,
  toTrackerRecord,
  trackerSeason,
} from './lib.js';

const SITES = 'survey_sites';
const YEARS = 'survey_years';
const TRACKER = 'planting2025';
const ACCESS_DOC = 'planting2025/config';
const SESSION_KEY = 'planting_authed'; // shared with the tracker
const SURVEYOR_KEY = 'survey_surveyor';
const YEAR_KEY = 'survey_year';

const QUAD_CENTERS = {
  NW: [42.7745, -78.629],
  NE: [42.776, -78.606],
  SE: [42.7615, -78.6055],
  SW: [42.761, -78.627],
};
const PRIORITY_COLORS = {High: '#c0392b', Medium: '#e0a100', Low: '#3a7bd5'};
const STATUS_COLORS = {
  Candidate: {bg: '#F1EFE8', color: '#5F5E5A'},
  Selected: {bg: '#C0DD97', color: '#3B6D11'},
  'Not suitable': {bg: '#F5E8E8', color: '#8C2B2B'},
  'Sent to tracker': {bg: '#E1F5EE', color: '#0F6E56'},
};

// ── state ──────────────────────────────────────────────
let years = {};
let year = '';
let sites = [];
let unsubSites = null;
let editingId = null;
let pin = null;
let sortMode = 'priority';
let inventory = [];
let quadDefaults = {};
const selected = new Set();
const maps = {};

// ── helpers ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ts = () => {
  const now = new Date();
  return (
    now.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }) +
    ' ' +
    now.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'})
  );
};
const today = () => {
  const now = new Date();
  const pad = num => String(num).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
const esc = str =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const badge = status => {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.Candidate;
  return `<span class="badge" style="background:${colors.bg};color:${colors.color};">${esc(status)}</span>`;
};
const priorityBadge = priority =>
  priority
    ? `<span class="badge priority-${priority}">${priority}</span>`
    : '<span class="badge">No priority</span>';
const addrLabel = site =>
  [site.housenum, site.street].filter(Boolean).join(' ') || '(no address)';
const plural = (num, word) => `${num} ${word}${num === 1 ? '' : 's'}`;
const store = {
  get: key => {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  },
  set: (key, val) => {
    try {
      localStorage.setItem(key, val);
    } catch {
      /* private mode */
    }
  },
};
const options = (list, first) =>
  (first ? `<option value="">${first}</option>` : '') +
  list.map(val => `<option>${esc(val)}</option>`).join('');

const showStatus = msg => {
  $('status-bar').textContent = msg;
  $('status-bar').style.display = 'block';
};
const hideStatus = () => ($('status-bar').style.display = 'none');
const reportError = (msg, err) => {
  console.error(err);
  const denied = err?.code === 'permission-denied';
  showStatus(
    denied
      ? `⚠ ${msg}: permission denied. Firestore rules may need to allow the "${SITES}" and "${YEARS}" collections.`
      : `⚠ ${msg}.`
  );
};

const yearDoc = () => years[year];
const yearStreets = () => yearDoc()?.streets || {};

// ── auth ───────────────────────────────────────────────
const startApp = () => {
  $('lock-screen').style.display = 'none';
  $('app-wrap').style.display = 'block';
  listenYears();
  loadStaticData();
};

const init = async () => {
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    await signInAnonymously(auth);
    startApp();
    return;
  }
  $('lock-screen').style.display = 'flex';
  setTimeout(() => $('lock-input').focus(), 50);
};

const submitPassword = async () => {
  const entered = $('lock-input').value.trim();
  if (!entered) return;
  const btn = $('lock-btn');
  $('lock-error').textContent = '';
  btn.textContent = 'Checking…';
  btn.disabled = true;
  try {
    await signInAnonymously(auth);
    const snap = await getDoc(doc(db, ACCESS_DOC));
    if (snap.exists() && entered === snap.data().password) {
      sessionStorage.setItem(SESSION_KEY, '1');
      startApp();
      return;
    }
    $('lock-error').textContent = snap.exists()
      ? 'Incorrect password.'
      : '⚠ Access config not found.';
    $('lock-input').value = '';
    $('lock-input').focus();
  } catch (err) {
    console.error(err);
    $('lock-error').textContent = '⚠ Connection error.';
  }
  btn.textContent = 'Enter';
  btn.disabled = false;
};

// ── data ───────────────────────────────────────────────
const loadStaticData = async () => {
  try {
    const [inv, quads] = await Promise.all([
      fetch('./data/inventory.json').then(res => res.json()),
      fetch('./data/quadrants.json').then(res => res.json()),
    ]);
    inventory = inv;
    quadDefaults = quads;
    drawInventory();
  } catch (err) {
    console.error('static data', err);
  }
};

const listenYears = () => {
  showStatus('Connecting…');
  onSnapshot(
    collection(db, YEARS),
    snap => {
      hideStatus();
      years = Object.fromEntries(
        snap.docs.map(snapDoc => [snapDoc.id, snapDoc.data()])
      );
      const ids = Object.keys(years).sort().reverse();
      if (!year) {
        const remembered = store.get(YEAR_KEY);
        selectYear(years[remembered] ? remembered : ids[0] || '');
      } else {
        renderAll();
      }
    },
    err => reportError('Could not load survey years', err)
  );
};

const selectYear = next => {
  year = next;
  if (year) store.set(YEAR_KEY, year);
  selected.clear();
  sites = [];
  if (unsubSites) unsubSites();
  unsubSites = null;
  if (year) {
    unsubSites = onSnapshot(
      query(collection(db, SITES), where('year', '==', Number(year))),
      snap => {
        sites = snap.docs.map(snapDoc => ({id: snapDoc.id, ...snapDoc.data()}));
        renderAll();
      },
      err => reportError('Could not load sites', err)
    );
  }
  renderAll();
};

const saveSite = async site => {
  const {id, ...data} = site;
  await setDoc(doc(db, SITES, id), data);
};

// ── year setup ─────────────────────────────────────────
const openYearModal = () => {
  const current = yearDoc();
  $('y-year').value = year || new Date().getFullYear();
  $('y-quadrant').innerHTML = Object.entries(QUADRANTS)
    .map(([key, name]) => `<option value="${key}">${name}</option>`)
    .join('');
  $('y-quadrant').value = current?.quadrant || 'SE';
  updateYearNote();
  $('year-modal').classList.add('open');
};

const updateYearNote = () => {
  const target = years[$('y-year').value];
  const quad = $('y-quadrant').value;
  const count = (quadDefaults[quad] || []).length;
  $('y-note').textContent = !target
    ? `Starts a new ${$('y-year').value} survey with ${count} ${QUADRANTS[quad]} streets on the checklist. You can add or remove streets afterward.`
    : target.quadrant === quad
      ? 'This year is already set up with this quadrant. Saving changes nothing.'
      : `This year is set up as ${QUADRANTS[target.quadrant]}. Switching replaces the street checklist (walked marks for streets in both lists are kept). Sites are not touched.`;
};

const saveYear = async () => {
  const id = String(parseInt($('y-year').value, 10) || '');
  const quad = $('y-quadrant').value;
  if (!id) return;
  const existing = years[id];
  $('year-modal').classList.remove('open');
  if (existing?.quadrant === quad) {
    selectYear(id);
    return;
  }
  const old = existing?.streets || {};
  const streets = Object.fromEntries(
    (quadDefaults[quad] || []).map(({name, partial}) => {
      const key = streetKey(name);
      return [key, {name, partial, walked: false, ...old[key]}];
    })
  );
  try {
    await setDoc(doc(db, YEARS, id), {quadrant: quad, streets});
    selectYear(id);
  } catch (err) {
    reportError('Could not save year', err);
  }
};

// ── streets ────────────────────────────────────────────
const streetPath = (key, field) => new FieldPath('streets', key, field);

const toggleStreet = async (key, walked) => {
  const surveyor = store.get(SURVEYOR_KEY);
  try {
    await updateDoc(
      doc(db, YEARS, year),
      streetPath(key, 'walked'),
      walked,
      streetPath(key, 'by'),
      walked ? surveyor : '',
      streetPath(key, 'on'),
      walked ? today() : ''
    );
  } catch (err) {
    reportError('Could not update street', err);
  }
};

const addStreet = async () => {
  const name = $('new-street').value.trim();
  if (!name || !year) return;
  const key = streetKey(name);
  if (yearStreets()[key]) {
    alert(`${name} is already on the list.`);
    return;
  }
  $('new-street').value = '';
  try {
    await updateDoc(doc(db, YEARS, year), new FieldPath('streets', key), {
      name,
      partial: false,
      walked: false,
    });
  } catch (err) {
    reportError('Could not add street', err);
  }
};

const removeStreet = async key => {
  const street = yearStreets()[key];
  if (!street || !confirm(`Remove ${street.name} from the checklist?`)) return;
  try {
    await updateDoc(
      doc(db, YEARS, year),
      new FieldPath('streets', key),
      deleteField()
    );
  } catch (err) {
    reportError('Could not remove street', err);
  }
};

// ── site modal ─────────────────────────────────────────
const setSeg = (id, value) =>
  $(id)
    .querySelectorAll('button')
    .forEach(btn => btn.classList.toggle('on', btn.dataset.val === value));
const getSeg = id => $(id).querySelector('button.on')?.dataset.val || '';

const buildForm = () => {
  $('f-priority').innerHTML = PRIORITIES.map(
    val => `<button type="button" data-val="${val}">${val}</button>`
  ).join('');
  $('f-size').innerHTML = SIZES.map(
    val => `<button type="button" data-val="${val}">${val}</button>`
  ).join('');
  $('f-status').innerHTML = options(STATUSES);
  $('bulk-status').innerHTML = options(
    STATUSES.filter(status => status !== 'Sent to tracker'),
    'Set status…'
  );
  $('f-obstructions').innerHTML = OBSTRUCTIONS.map(
    val =>
      `<label><input type="checkbox" value="${esc(val)}"> ${esc(val)}</label>`
  ).join('');
  ['f-priority', 'f-size'].forEach(id =>
    $(id).addEventListener('click', evt => {
      const btn = evt.target.closest('button');
      if (!btn) return;
      // tap again to clear
      setSeg(id, btn.classList.contains('on') ? '' : btn.dataset.val);
    })
  );
  $('f-obstructions').addEventListener('change', evt => {
    if (evt.target.value === 'Overhead wires' && evt.target.checked)
      setSeg('f-size', 'Small');
  });
};

const fillForm = site => {
  $('f-housenum').value = site.housenum || '';
  $('f-street').value = site.street || '';
  setSeg('f-priority', site.priority || '');
  setSeg('f-size', site.size || '');
  $('f-status').value = site.status || 'Candidate';
  // "Sent to tracker" is only set by the hand-off
  [...$('f-status').options].forEach(
    opt =>
      (opt.disabled =
        opt.value === 'Sent to tracker' && site.status !== 'Sent to tracker')
  );
  $('f-row').value = site.row || '';
  const obs = new Set(site.obstructions || []);
  $('f-obstructions')
    .querySelectorAll('input')
    .forEach(box => (box.checked = obs.has(box.value)));
  $('f-surveyor').value = site.surveyor || store.get(SURVEYOR_KEY);
  $('f-date').value = site.surveyedOn || today();
  $('f-note').value = '';
  $('f-log').innerHTML = (site.log || [])
    .slice()
    .reverse()
    .map(entry => `<div>${esc(entry.date)} — ${esc(entry.text)}</div>`)
    .join('');
  $('street-options').innerHTML = Object.values(yearStreets())
    .map(street => `<option>${esc(street.name)}</option>`)
    .join('');
  $('btn-delete-site').style.display = editingId ? '' : 'none';
};

const openSite = (site, at) => {
  if (!year) return;
  editingId = site?.id || null;
  $('site-modal-title').textContent = editingId
    ? 'Edit — ' + addrLabel(site)
    : 'Add site';
  fillForm(site || {});
  $('site-modal').classList.add('open');
  const start = at || (site?.lat ? {lat: site.lat, lng: site.lng} : null);
  setTimeout(() => {
    initSiteMap();
    setPin(start);
    maps.site.invalidateSize();
    if (start) maps.site.setView([start.lat, start.lng], 19);
    else
      maps.site.setView(
        QUAD_CENTERS[yearDoc()?.quadrant] || QUAD_CENTERS.SE,
        15
      );
  }, 50);
};

const closeSite = () => {
  $('site-modal').classList.remove('open');
  editingId = null;
};

const setPin = at => {
  pin = at ? {lat: +at.lat.toFixed(6), lng: +at.lng.toFixed(6)} : null;
  if (maps.sitePin) {
    maps.sitePin.remove();
    maps.sitePin = null;
  }
  if (pin) maps.sitePin = L.marker([pin.lat, pin.lng]).addTo(maps.site);
  $('pin-label').textContent = pin
    ? `— ${pin.lat}, ${pin.lng}`
    : '— tap the map or use GPS';
  renderNearby();
};

const renderNearby = () => {
  if (!pin) {
    $('nearby').innerHTML = '';
    return;
  }
  const trees = nearbyTrees(pin, inventory, 40);
  const lines = [];
  const removed = trees.find(tree => tree.status === 'R' && tree.feet <= 25);
  if (removed)
    lines.push(
      `<span class="warn">Removed tree ${Math.round(removed.feet)} ft away — old roots may be in the way.</span>`
    );
  const live = trees.find(tree => tree.status !== 'R');
  lines.push(
    live
      ? `Nearest existing tree: ${Math.round(live.feet)} ft${live.species ? ` (${esc(live.species)})` : ''}`
      : 'No inventoried trees within 40 ft.'
  );
  const neighbor = sites
    .filter(site => site.id !== editingId && site.lat)
    .map(site => ({site, feet: distanceFt(pin, site)}))
    .sort((a, b) => a.feet - b.feet)[0];
  if (neighbor && neighbor.feet < 40)
    lines.push(
      `<span class="warn">Another survey site ${Math.round(neighbor.feet)} ft away: ${esc(addrLabel(neighbor.site))}</span>`
    );
  $('nearby').innerHTML = lines.join('<br>');
};

const useGps = () => {
  if (!navigator.geolocation) {
    alert('Location is not available on this device.');
    return;
  }
  $('btn-gps').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      $('btn-gps').textContent = '📍 Use my location';
      const at = {lat: pos.coords.latitude, lng: pos.coords.longitude};
      setPin(at);
      maps.site.setView([at.lat, at.lng], 19);
    },
    err => {
      $('btn-gps').textContent = '📍 Use my location';
      alert('Could not get location: ' + err.message);
    },
    {enableHighAccuracy: true, timeout: 15000}
  );
};

const submitSite = async () => {
  const housenum = $('f-housenum').value.trim();
  const street = $('f-street').value.trim();
  if (!street) {
    alert('Street is required.');
    return;
  }
  if (housenum) {
    const key = addressKey(housenum, street);
    const dupe = sites.find(
      site =>
        site.id !== editingId && addressKey(site.housenum, site.street) === key
    );
    if (dupe) {
      if (
        confirm(
          `${addrLabel(dupe)} is already in this year's survey.\n\nOpen it instead? Unsaved changes here will be lost.`
        )
      )
        openSite(dupe);
      return;
    }
  }
  const surveyor = $('f-surveyor').value.trim();
  if (surveyor) store.set(SURVEYOR_KEY, surveyor);
  const prev = editingId ? sites.find(site => site.id === editingId) : null;
  const fields = {
    housenum,
    street,
    priority: getSeg('f-priority'),
    size: getSeg('f-size'),
    status: $('f-status').value || 'Candidate',
    row: $('f-row').value.trim(),
    obstructions: [
      ...$('f-obstructions').querySelectorAll('input:checked'),
    ].map(box => box.value),
    lat: pin?.lat ?? null,
    lng: pin?.lng ?? null,
    surveyor,
    surveyedOn: $('f-date').value,
  };
  const note = $('f-note').value.trim();
  const logParts = [];
  if (!prev) logParts.push('Site added');
  if (prev && fields.status !== prev.status)
    logParts.push('Status → ' + fields.status);
  if (prev && fields.priority !== prev.priority)
    logParts.push('Priority → ' + (fields.priority || 'none'));
  if (note) logParts.push(note);
  const stamp = ts();
  const site = {
    ...(prev || {
      id: uid(),
      year: Number(year),
      quadrant: yearDoc()?.quadrant || '',
      created: stamp,
    }),
    ...fields,
    updated: stamp,
    updatedAt: Date.now(),
  };
  if (logParts.length)
    site.log = [
      ...(prev?.log || []),
      {date: stamp, text: logParts.join(' · ')},
    ];
  closeSite();
  try {
    await saveSite(site);
  } catch (err) {
    reportError('Could not save site', err);
  }
};

const deleteSite = async () => {
  if (!editingId || !confirm('Delete this site? This cannot be undone.'))
    return;
  const id = editingId;
  closeSite();
  try {
    await deleteDoc(doc(db, SITES, id));
  } catch (err) {
    reportError('Could not delete site', err);
  }
};

// ── bulk status ────────────────────────────────────────
const runBulk = async () => {
  const status = $('bulk-status').value;
  if (!status || !selected.size) return;
  const picks = sites.filter(
    site => selected.has(site.id) && site.status !== status
  );
  if (!picks.length) return;
  if (!confirm(`Set ${plural(picks.length, 'site')} to "${status}"?`)) return;
  const stamp = ts();
  try {
    await commitInChunks(
      picks.map(site => batch => {
        const {id, ...data} = site;
        batch.set(doc(db, SITES, id), {
          ...data,
          status,
          updated: stamp,
          updatedAt: Date.now(),
          log: [
            ...(site.log || []),
            {date: stamp, text: 'Bulk update: Status → ' + status},
          ],
        });
      })
    );
    selected.clear();
    $('bulk-status').value = '';
    renderCards();
  } catch (err) {
    reportError('Bulk update failed', err);
  }
};

// Firestore batches cap at 500 writes
const commitInChunks = async ops => {
  for (let start = 0; start < ops.length; start += 400) {
    const batch = writeBatch(db);
    ops.slice(start, start + 400).forEach(op => op(batch));
    await batch.commit();
  }
};

// ── hand-off to the planting tracker ───────────────────
let pendingHandoff = null;

const openHandoff = async () => {
  $('handoff-body').textContent = 'Checking the planting tracker…';
  $('btn-run-handoff').disabled = true;
  $('handoff-modal').classList.add('open');
  try {
    const snap = await getDocs(collection(db, TRACKER));
    const records = snap.docs
      .filter(snapDoc => snapDoc.id !== 'config')
      .map(snapDoc => ({id: snapDoc.id, ...snapDoc.data()}));
    pendingHandoff = planHandoff(sites, records);
  } catch (err) {
    $('handoff-body').textContent = '⚠ Could not read the planting tracker.';
    console.error(err);
    return;
  }
  const {toSend, duplicates} = pendingHandoff;
  const unaddressed = toSend.filter(site => !site.housenum);
  const list = items =>
    `<ul class="muted">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
  $('handoff-body').innerHTML =
    !toSend.length && !duplicates.length
      ? 'No sites with status <strong>Selected</strong>. Mark the sites you have chosen as Selected first (bulk select works).'
      : `${
          toSend.length
            ? `<p><strong>${plural(toSend.length, 'site')}</strong> will be added to the planting tracker with season <strong>${trackerSeason(year)}</strong> and a blank status.</p>`
            : ''
        }${
          unaddressed.length
            ? `<p class="warn">⚠ ${plural(unaddressed.length, 'site')} with no house number will be sent with a blank house #.</p>`
            : ''
        }${
          duplicates.length
            ? `<p style="margin-top:8px;"><strong>${plural(duplicates.length, 'site')}</strong> already in the tracker — they won't be added again, just linked and marked as sent:</p>${list(
                duplicates.map(
                  ({site, record}) =>
                    `${addrLabel(site)} (tracker status: ${record.status || 'none'})`
                )
              )}`
            : ''
        }`;
  $('btn-run-handoff').disabled = !toSend.length && !duplicates.length;
};

const runHandoff = async () => {
  if (!pendingHandoff) return;
  const {toSend, duplicates} = pendingHandoff;
  $('handoff-modal').classList.remove('open');
  showStatus('Sending to tracker…');
  const stamp = ts();
  const markSent = (site, trackerId, text) => batch => {
    const {id, ...data} = site;
    batch.set(doc(db, SITES, id), {
      ...data,
      status: 'Sent to tracker',
      trackerId,
      updated: stamp,
      updatedAt: Date.now(),
      log: [...(site.log || []), {date: stamp, text}],
    });
  };
  const ops = [
    ...toSend.flatMap(site => {
      const trackerId = uid() + site.id.slice(-3);
      return [
        batch =>
          batch.set(doc(db, TRACKER, trackerId), toTrackerRecord(site, stamp)),
        markSent(site, trackerId, 'Sent to planting tracker'),
      ];
    }),
    ...duplicates.map(({site, record}) =>
      markSent(site, record.id, 'Already in planting tracker — linked')
    ),
  ];
  try {
    await commitInChunks(ops);
    hideStatus();
  } catch (err) {
    reportError('Hand-off failed', err);
  }
  pendingHandoff = null;
};

// ── export ─────────────────────────────────────────────
const doExport = () => {
  if (!sites.length) {
    alert('No sites to export yet.');
    return;
  }
  const quad = yearDoc()?.quadrant || '';
  const workbook = XLSX.utils.book_new();
  const siteSheet = XLSX.utils.json_to_sheet(exportRows(sortSites([...sites])));
  siteSheet['!cols'] = [8, 18, 14, 9, 10, 26, 30, 14, 11, 10, 10, 50].map(
    wch => ({wch})
  );
  XLSX.utils.book_append_sheet(workbook, siteSheet, 'Sites');
  const counts = summarize(sites).perStreet;
  const streetSheet = XLSX.utils.json_to_sheet(
    Object.entries(yearStreets())
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([key, street]) => ({
        Street: street.name,
        Partial: street.partial ? 'yes' : '',
        Walked: street.walked ? 'yes' : '',
        By: street.by || '',
        On: street.on || '',
        Sites: counts[key] || 0,
      }))
  );
  streetSheet['!cols'] = [22, 8, 8, 16, 11, 6].map(wch => ({wch}));
  XLSX.utils.book_append_sheet(workbook, streetSheet, 'Streets');
  XLSX.writeFile(workbook, `survey_${year}_${quad}.xlsx`);
};

// ── render ─────────────────────────────────────────────
const PRIORITY_RANK = {High: 0, Medium: 1, Low: 2};
const byAddress = (a, b) =>
  (a.street || '').localeCompare(b.street || '') ||
  (parseInt(a.housenum, 10) || 0) - (parseInt(b.housenum, 10) || 0);

const sortSites = list => {
  const unsuitableLast = (a, b) =>
    (a.status === 'Not suitable') - (b.status === 'Not suitable');
  if (sortMode === 'date')
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (sortMode === 'street') return list.sort(byAddress);
  return list.sort(
    (a, b) =>
      unsuitableLast(a, b) ||
      (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
      byAddress(a, b)
  );
};

const renderAll = () => {
  const ids = Object.keys(years).sort().reverse();
  const yearIds = year && !ids.includes(year) ? [year, ...ids] : ids;
  $('year-select').innerHTML = yearIds.length
    ? yearIds
        .map(
          id =>
            `<option value="${id}">${id}${years[id] ? ' · ' + QUADRANTS[years[id].quadrant] : ''}</option>`
        )
        .join('')
    : '<option value="">No years yet</option>';
  $('year-select').value = year;
  const ready = !!yearDoc();
  $('year-empty').style.display = ready ? 'none' : 'block';
  $('year-body').style.display = ready ? 'block' : 'none';
  if (!ready) return;
  $('year-banner').textContent =
    `${year} survey · ${QUADRANTS[yearDoc().quadrant]} quadrant`;
  renderSummary();
  renderFilters();
  renderCards();
  renderStreets();
  drawSites();
};

const renderSummary = () => {
  const sum = summarize(sites, yearStreets());
  const pill = (label, num) =>
    `<div class="count-pill">${label} <strong>${num}</strong></div>`;
  $('summary').innerHTML = [
    pill('Streets walked', `${sum.streetsWalked}/${sum.streetsTotal}`),
    pill('Sites', sum.total),
    ...PRIORITIES.map(pri => pill(priorityBadge(pri), sum.byPriority[pri])),
    ...STATUSES.filter(status => sum.byStatus[status]).map(status =>
      pill(badge(status), sum.byStatus[status])
    ),
  ].join('');
};

const renderFilters = () => {
  const keep = id => $(id).value;
  const fill = (id, list, first) => {
    const prev = keep(id);
    $(id).innerHTML = options(list, first);
    $(id).value = list.includes(prev) ? prev : '';
  };
  fill('filter-status', STATUSES, 'All statuses');
  fill('filter-priority', PRIORITIES, 'All priorities');
  const streetNames = [
    ...new Set(sites.map(site => site.street).filter(Boolean)),
  ].sort();
  fill('filter-street', streetNames, 'All streets');
};

const filteredSites = () => {
  const text = $('search').value.toLowerCase();
  const status = $('filter-status').value;
  const priority = $('filter-priority').value;
  const street = $('filter-street').value;
  return sortSites(
    sites.filter(site => {
      const hay = [
        site.housenum,
        site.street,
        site.row,
        site.surveyor,
        ...(site.obstructions || []),
        ...(site.log || []).map(entry => entry.text),
      ]
        .join(' ')
        .toLowerCase();
      return (
        (!text || hay.includes(text)) &&
        (!status || site.status === status) &&
        (!priority || site.priority === priority) &&
        (!street || site.street === street)
      );
    })
  );
};

const renderCards = () => {
  const list = filteredSites();
  const visible = list.map(site => site.id);
  for (const id of selected) if (!visible.includes(id)) selected.delete(id);
  $('bulk-bar').style.display = selected.size ? 'flex' : 'none';
  $('bulk-count').textContent = plural(selected.size, 'site') + ' selected';
  const picked = visible.filter(id => selected.has(id)).length;
  $('select-all').checked = visible.length > 0 && picked === visible.length;
  $('select-all').indeterminate = picked > 0 && picked < visible.length;
  if (!list.length) {
    $('cards').innerHTML = sites.length
      ? '<p class="empty">No sites match your filters.</p>'
      : '<p class="empty">No sites yet. Tap “+ Add site” while you walk, or tap the map.</p>';
    return;
  }
  $('cards').innerHTML = list
    .map(site => {
      const last = site.log?.at(-1);
      return `<div class="card${selected.has(site.id) ? ' selected' : ''}${site.status === 'Not suitable' ? ' complete-card' : ''}">
      <div class="card-header">
        <div class="card-head-left">
          <input type="checkbox" class="card-select" data-id="${site.id}"${selected.has(site.id) ? ' checked' : ''}>
          <div>
            <div class="card-addr">${esc(addrLabel(site))} ${priorityBadge(site.priority)}</div>
            <div class="card-meta">${esc(site.surveyor || 'unknown surveyor')}${site.surveyedOn ? ' &middot; ' + esc(site.surveyedOn) : ''}${site.lat ? ' &middot; 📍' : ''}</div>
          </div>
        </div>
        <div class="card-actions">
          ${site.lat ? `<button class="btn small" data-action="locate" data-id="${site.id}">Map</button>` : ''}
          <button class="btn small" data-action="edit" data-id="${site.id}">Edit</button>
        </div>
      </div>
      <div class="card-body">
        <div><div class="field-label">Status</div><div>${badge(site.status || 'Candidate')}</div></div>
        <div><div class="field-label">Size allowed</div><div class="field-val">${esc(site.size || '—')}</div></div>
        <div><div class="field-label">ROW</div><div class="field-sm">${esc(site.row || '—')}</div></div>
        <div><div class="field-label">Obstructions</div><div>${
          site.obstructions?.length
            ? site.obstructions
                .map(obs => `<span class="obs-tag">${esc(obs)}</span>`)
                .join('')
            : '<span class="field-sm">None noted</span>'
        }</div></div>
        ${last ? `<div class="full-col"><div class="field-label">Last note</div><div class="field-sm muted">${esc(last.date)} — ${esc(last.text)}</div></div>` : ''}
      </div>
    </div>`;
    })
    .join('');
};

const renderStreets = () => {
  const counts = summarize(sites).perStreet;
  const hideWalked = $('hide-walked').checked;
  const rows = Object.entries(yearStreets())
    .filter(([, street]) => !hideWalked || !street.walked)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  $('street-list').innerHTML = rows.length
    ? rows
        .map(
          ([
            key,
            street,
          ]) => `<div class="street-row${street.walked ? ' walked' : ''}">
      <input type="checkbox" data-street="${esc(key)}"${street.walked ? ' checked' : ''} aria-label="Walked">
      <div class="grow">
        <div class="street-name">${esc(street.name)} ${street.partial ? '<span class="partial-tag">partial</span>' : ''}</div>
        <div class="street-meta">${plural(counts[key] || 0, 'site')}${street.walked ? ` &middot; walked${street.by ? ' by ' + esc(street.by) : ''}${street.on ? ' ' + esc(street.on) : ''}` : ''}</div>
      </div>
      <button class="link-btn" data-remove-street="${esc(key)}" title="Remove from checklist">✕</button>
    </div>`
        )
        .join('')
    : '<p class="empty">No streets to show.</p>';
};

// ── maps ───────────────────────────────────────────────
const baseLayer = () =>
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: '© OpenStreetMap contributors',
  });

const inventoryLayer = () => {
  const renderer = L.canvas();
  return L.layerGroup(
    inventory.map(([lat, lng, status, species]) =>
      L.circleMarker([lat, lng], {
        renderer,
        radius: 3,
        weight: 0,
        fillOpacity: status === 'R' ? 0.9 : 0.6,
        fillColor: status === 'R' ? '#222' : '#8fbf6a',
        interactive: false,
      })
    )
  );
};

const drawInventory = () => {
  if (maps.main && !maps.mainInv) {
    maps.mainInv = inventoryLayer();
    if ($('show-inventory').checked) maps.mainInv.addTo(maps.main);
  }
  if (maps.site && !maps.siteInv)
    maps.siteInv = inventoryLayer().addTo(maps.site);
  if (maps.site) renderNearby();
};

const initMainMap = () => {
  if (maps.main) return;
  maps.main = L.map('main-map').setView(
    QUAD_CENTERS[yearDoc()?.quadrant] || QUAD_CENTERS.SE,
    15
  );
  baseLayer().addTo(maps.main);
  maps.mainSites = L.layerGroup().addTo(maps.main);
  maps.main.on('click', evt => openSite(null, evt.latlng));
  drawInventory();
  drawSites();
};

const initSiteMap = () => {
  if (maps.site) return;
  // keyboard off: focusing the map on tap scrolls the form and misplaces the pin
  maps.site = L.map('site-map', {keyboard: false});
  baseLayer().addTo(maps.site);
  maps.site.on('click', evt => setPin(evt.latlng));
  drawInventory();
};

const drawSites = () => {
  if (!maps.mainSites) return;
  maps.mainSites.clearLayers();
  for (const site of sites.filter(item => item.lat)) {
    const unsuitable = site.status === 'Not suitable';
    const color = PRIORITY_COLORS[site.priority] || '#888';
    L.circleMarker([site.lat, site.lng], {
      radius: 8,
      color: unsuitable ? '#888' : '#fff',
      weight: 2,
      fillColor: color,
      fillOpacity: unsuitable ? 0 : 0.9,
      bubblingMouseEvents: false,
    })
      .bindTooltip(`${esc(addrLabel(site))} · ${esc(site.status)}`)
      .on('click', () => openSite(site))
      .addTo(maps.mainSites);
  }
};

// ── tabs ───────────────────────────────────────────────
const switchTab = tab => {
  document
    .querySelectorAll('.tab')
    .forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document
    .querySelectorAll('.section')
    .forEach(sec => sec.classList.toggle('active', sec.id === tab));
  if (tab === 'map')
    setTimeout(() => {
      initMainMap();
      maps.main.invalidateSize();
    }, 0);
};

const locateSite = id => {
  const site = sites.find(item => item.id === id);
  if (!site?.lat) return;
  switchTab('map');
  setTimeout(() => maps.main.setView([site.lat, site.lng], 19), 50);
};

// ── wire up ────────────────────────────────────────────
const on = (id, evt, handler) => $(id).addEventListener(evt, handler);

on('lock-btn', 'click', submitPassword);
on('lock-input', 'keydown', evt => evt.key === 'Enter' && submitPassword());
on('year-select', 'change', evt => selectYear(evt.target.value));
on('btn-setup-year', 'click', openYearModal);
on('btn-setup-year-2', 'click', openYearModal);
on('y-year', 'input', updateYearNote);
on('y-quadrant', 'change', updateYearNote);
on('btn-save-year', 'click', saveYear);
on('btn-cancel-year', 'click', () => $('year-modal').classList.remove('open'));

on('btn-add', 'click', () => openSite(null));
on('btn-export', 'click', doExport);
on('btn-handoff', 'click', openHandoff);
on('btn-run-handoff', 'click', runHandoff);
on('btn-cancel-handoff', 'click', () =>
  $('handoff-modal').classList.remove('open')
);

on('btn-save-site', 'click', submitSite);
on('btn-cancel-site', 'click', closeSite);
on('btn-delete-site', 'click', deleteSite);
on('btn-gps', 'click', useGps);
on('btn-clear-pin', 'click', () => setPin(null));

document
  .querySelectorAll('[data-tab]')
  .forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
document.querySelectorAll('.sort-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    sortMode = btn.dataset.sort;
    document
      .querySelectorAll('.sort-btn')
      .forEach(other => other.classList.toggle('active', other === btn));
    renderCards();
  })
);
['search', 'filter-status', 'filter-priority', 'filter-street'].forEach(id =>
  on(id, id === 'search' ? 'input' : 'change', renderCards)
);

on('cards', 'click', evt => {
  const btn = evt.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'edit')
    openSite(sites.find(site => site.id === btn.dataset.id));
  if (btn.dataset.action === 'locate') locateSite(btn.dataset.id);
});
on('cards', 'change', evt => {
  if (!evt.target.classList.contains('card-select')) return;
  if (evt.target.checked) selected.add(evt.target.dataset.id);
  else selected.delete(evt.target.dataset.id);
  renderCards();
});
on('select-all', 'change', evt => {
  filteredSites().forEach(site =>
    evt.target.checked ? selected.add(site.id) : selected.delete(site.id)
  );
  renderCards();
});
on('btn-bulk', 'click', runBulk);
on('btn-clear-sel', 'click', () => {
  selected.clear();
  renderCards();
});

on('street-list', 'change', evt => {
  if (evt.target.dataset.street)
    toggleStreet(evt.target.dataset.street, evt.target.checked);
});
on('street-list', 'click', evt => {
  const btn = evt.target.closest('[data-remove-street]');
  if (btn) removeStreet(btn.dataset.removeStreet);
});
on('btn-add-street', 'click', addStreet);
on('new-street', 'keydown', evt => evt.key === 'Enter' && addStreet());
on('hide-walked', 'change', renderStreets);

on('show-inventory', 'change', evt => {
  if (!maps.mainInv) return;
  if (evt.target.checked) maps.mainInv.addTo(maps.main);
  else maps.mainInv.remove();
});

['year-modal', 'handoff-modal'].forEach(id =>
  on(id, 'click', evt => evt.target.id === id && $(id).classList.remove('open'))
);

buildForm();
init();
