'use strict';
/* Train — private offline workout log. All data lives in this browser's localStorage. */
const KEY = 'train.v1';
const TIMER_KEY = 'train.timer';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => String(v ?? '').trim().replace(/[\u0660-\u0669\u06F0-\u06F9]/g, c => (c.charCodeAt(0) & 15) % 10).replace(/[,\u066B\u060C]/g, '.');
const fmt = n => (n == null || n === '' || isNaN(n)) ? '' : (Math.round(n * 100) / 100).toString();

let PLAN = null, EX = {}, S = null;

/* ---------- storage ---------- */
function load() {
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) { S = null; }
  if (!S || !S.log) {
    S = { v: 1, week: 1, log: {}, settings: { sound: true, restDefault: 120 }, created: new Date().toISOString() };
    importSheetHistory();
    // Week 1 came from the spreadsheet, so start on week 1 to finish its remaining days.
    save();
  }
  S.settings = Object.assign({ sound: true, restDefault: 120 }, S.settings || {});
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save — storage full or blocked'); }
}
function importSheetHistory() {
  PLAN.days.forEach(day => day.exercises.forEach(ex => {
    Object.entries(ex.history || {}).forEach(([w, h]) => {
      const k = `${w}-${day.id}`;
      const s = S.log[k] || (S.log[k] = { date: null, finished: true, imported: true, sets: {} });
      s.sets[ex.id] = Array.from({ length: h.sets }, () => ({ kg: h.load, reps: h.reps, done: true }));
    });
  }));
}

/* ---------- plan helpers ---------- */
const nDays = () => PLAN.days.length;
const dayById = id => PLAN.days.find(d => d.id === +id);
const sessKey = (w, d) => `${w}-${d}`;
const sessIdx = (w, d) => (w - 1) * nDays() + (d - 1);
function session(w, d, create) {
  const k = sessKey(w, d);
  if (!S.log[k] && create) S.log[k] = { date: null, finished: false, sets: {} };
  return S.log[k];
}
const doneSets = arr => (arr || []).filter(s => s.done && s.reps !== '' && s.reps != null);
function allExercises() {
  const m = new Map();
  PLAN.days.forEach(d => d.exercises.forEach(e => { if (!m.has(e.id)) m.set(e.id, e); }));
  return [...m.values()];
}
function exInfo(id) { return EX[id] || { name: (allExercises().find(e => e.id === id) || {}).name || id, images: [], cues: [], setup: [], mistakes: [], muscles: [] }; }
function sessionsOrdered() {
  return Object.entries(S.log).map(([k, v]) => { const [w, d] = k.split('-').map(Number); return { w, d, idx: sessIdx(w, d), s: v }; })
    .sort((a, b) => a.idx - b.idx);
}
/** Most recent performance of an exercise strictly before session index. */
function lastPerf(exId, beforeIdx) {
  const list = sessionsOrdered().filter(x => x.idx < beforeIdx).reverse();
  for (const x of list) { const ds = doneSets(x.s.sets[exId]); if (ds.length) return { w: x.w, d: x.d, sets: ds }; }
  return null;
}
/** Same day last week if logged, otherwise the most recent session with this exercise. */
function lastWeekPerf(exId, w, d) {
  if (w > 1) { const s = session(w - 1, d); const ds = s && doneSets(s.sets[exId]); if (ds && ds.length) return { w: w - 1, d, sets: ds }; }
  return lastPerf(exId, sessIdx(w, d));
}
function lastNote(exId, beforeIdx) {
  const list = sessionsOrdered().filter(x => x.idx < beforeIdx).reverse();
  for (const x of list) { const n = x.s.notes && x.s.notes[exId]; if (n && n.trim()) return { w: x.w, d: x.d, text: n }; }
  return null;
}
/** Weight logged per side (each dumbbell / each arm) vs total. Defaults set by Nasser (Nov 2026). */
const PER_SIDE_DEFAULT = ['cable-cross-y-raise-lying-or-standing', 'incline-plate-loaded-press', 'flat-plate-loaded-press', 'reverse-pec-deck', 'chest-supported-row-lat-bias', 'machine-row-for-rear-delts', 'calf-raise', 'seated-row-upper-back-bias', 'rear-delt-cable-fly-bilateral', 'bicep-curl-machine'];
function perSide(id) { const m = (S && S.settings && S.settings.perSide) || {}; return id in m ? !!m[id] : PER_SIDE_DEFAULT.includes(id); }
function setPerSide(id, v) { S.settings.perSide = S.settings.perSide || {}; S.settings.perSide[id] = !!v; save(); }
/** Volume counts both sides when weight is logged per side. */
function setVol(id, q) { return (+q.kg || 0) * (+q.reps || 0) * (perSide(id) ? 2 : 1); }
const sideTag = id => perSide(id) ? '/side' : '';
const e1rm = (kg, reps) => (+kg > 0 && +reps > 0) ? +kg * (1 + Math.min(+reps, 15) / 30) : 0;

/** Progression suggestion: double progression on the sheet's rep ranges. Advisory only. */
function suggest(ex, perf) {
  if (!perf) return null;
  const sets = perf.sets, top = Math.max(...sets.map(s => +s.kg || 0));
  const reps = sets.map(s => +s.reps || 0);
  if (ex.repMin == null) return null;
  const unit = ex.unit === 'sec' ? 's' : '';
  if (sets.length >= ex.sets && reps.every(r => r >= ex.repMax)) {
    if (ex.unit === 'sec') return { type: 'up', text: `Hit ${ex.repMax}${unit} on every set — make it harder`, kg: top };
    if (top <= 0) return { type: 'up', text: `Top of range on every set — slow the tempo or add load`, kg: 0 };
    const inc = top < 10 ? 1 : 2.5;
    return { type: 'up', text: `Top of range on every set → try ${fmt(top + inc)} kg`, kg: top + inc };
  }
  if (reps.some(r => r < ex.repMin)) return { type: 'hold', text: `Below ${ex.repMin}${unit} last time — ${ex.unit === 'sec' || top <= 0 ? 'keep it the same' : `stay at ${fmt(top)} kg`}`, kg: top };
  return { type: 'reps', text: `Same weight, beat last time's reps`, kg: top };
}
function currentDay(w) {
  for (const d of PLAN.days) { const s = session(w, d.id); if (!s || !s.finished) return d.id; }
  return null;
}

/* ---------- UI utilities ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2200); }
/* ---------- your own machine photos (IndexedDB, stays on this phone) ---------- */
let PHOTOS = {};
const MAX_PHOTOS = 4;
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('train-photos', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function loadPhotos() { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction('photos'), st = tx.objectStore('photos'), out = {}; const c = st.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else { PHOTOS = out; res(); } }; c.onerror = () => res(); }); } catch (e) { PHOTOS = {}; } }
async function savePhotos(id) { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('photos', 'readwrite'); const st = tx.objectStore('photos'); if (PHOTOS[id] && PHOTOS[id].length) st.put(PHOTOS[id], id); else st.delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function resizeImage(file, max = 1000) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}
async function addPhotos(id, files) {
  const list = PHOTOS[id] ? PHOTOS[id].slice() : [];
  for (const f of files) { if (list.length >= MAX_PHOTOS) { toast(`Up to ${MAX_PHOTOS} photos per exercise`); break; } try { list.push(await resizeImage(f)); } catch (e) { toast('Could not read that photo'); } }
  PHOTOS[id] = list;
  try { await savePhotos(id); toast('Photo saved'); } catch (e) { toast('Could not save photo — storage full?'); }
  openInfo(id); if (!/^#\/w\//.test(location.hash)) { const y = window.scrollY; route(); window.scrollTo(0, y); } else refreshThumbs(id);
}
function refreshThumbs(id) { document.querySelectorAll(`[data-id="${id}"] .thumb, #ex-${id} .thumb`).forEach(el => el.setAttribute('style', (thumb(id).match(/style="(.*)"/) || [, ''])[1].replace(/&#39;/g, "'"))); }
function thumb(id) { if (PHOTOS[id] && PHOTOS[id].length) return `style="background-image:url('${PHOTOS[id][0]}')"`; const i = exInfo(id); return i.images && i.images[0] ? `style="background-image:url('${esc(i.images[i.images.length > 1 ? 1 : 0])}')"` : ''; }
function perfStr(sets) { return sets.map(s => `${fmt(s.kg)}×${fmt(s.reps)}`).join(', '); }
function setTab(name) { document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === name)); }

/* ---------- views ---------- */
function viewHome(params) {
  setTab('home');
  const w = S.week;
  const cur = currentDay(w);
  const sel = +(params.get('d') || cur || 1);
  const day = dayById(sel);
  const s = session(w, sel);
  const finishedCount = PLAN.days.filter(d => (session(w, d.id) || {}).finished).length;
  const idx = sessIdx(w, sel);
  const allWeekDone = cur == null;
  return `
  <div class="weeknav">
    <button data-act="week" data-dir="-1" aria-label="Previous week">‹</button>
    <div class="grow"><div class="eyebrow">${esc(PLAN.block)} block</div><div style="font-weight:700;font-size:17px">Week ${w} of ${PLAN.weeks}</div></div>
    <button data-act="week" data-dir="1" aria-label="Next week">›</button>
  </div>
  <div class="bar"><i style="width:${(finishedCount / nDays()) * 100}%"></i></div>
  <div class="tiny muted" style="margin:6px 0 12px">${finishedCount} of ${nDays()} sessions done this week</div>
  ${allWeekDone ? `<div class="card"><h3>Week ${w} complete</h3><p class="muted small" style="margin:4px 0 10px">${w < PLAN.weeks ? 'Nice work. Move on when you are ready.' : 'Block finished — export to Excel and plan the next one.'}</p><a class="btn sec" href="#/ws/${w}" style="margin-bottom:10px">Week ${w} summary</a>${w < PLAN.weeks ? `<button class="btn" data-act="week" data-dir="1">Start week ${w + 1}</button>` : ''}</div>` : ''}
  <div class="pills" role="tablist">
    ${PLAN.days.map(d => { const ss = session(w, d.id); return `<a class="pill ${d.id === sel ? 'on' : ''} ${ss && ss.finished ? 'done' : ''}" href="#/?d=${d.id}">D${d.id} · ${esc(d.focus)}</a>`; }).join('')}
  </div>
  <h1 style="margin-top:14px">${esc(day.name)} · ${esc(day.focus)}</h1>
  ${s && s.finished ? `<p class="small muted" style="margin-top:-6px">Done${s.date ? ' · ' + new Date(s.date).toLocaleDateString() : ' (from your sheet)'}</p>` : ''}
  <div class="card" style="padding:4px 14px">
    ${day.exercises.map(ex => {
      const lp = lastWeekPerf(ex.id, w, sel); const sg = suggest(ex, lp);
      const mine = doneSets(s && s.sets[ex.id]);
      const ok = mine.length >= ex.sets;
      return `<div class="exrow" data-act="info" data-id="${ex.id}">
        <div class="thumb" ${thumb(ex.id)}></div>
        <div class="grow"><div style="font-weight:600">${esc(ex.name)}</div>
          <div class="small muted">${ex.sets} × ${esc(ex.reps)}${lp ? ` · last ${esc(perfStr(lp.sets.slice(0, 1)))}` : ''}</div>
          ${sg && !ok ? `<span class="badge b-${sg.type}" style="margin-top:4px">${sg.type === 'up' ? '↑ ' : ''}${esc(sg.type === 'up' ? (sg.kg ? fmt(sg.kg) + ' kg' : 'Harder') : sg.type === 'hold' ? 'Hold' : 'Beat reps')}</span>` : ''}
        </div>
        <div class="chk ${ok ? 'on' : ''}">${ok ? '✓' : mine.length || ''}</div>
      </div>`; }).join('')}
  </div>
  <details class="card"><summary style="font-weight:600">Warm-up first</summary>
    <ul class="clean small">${PLAN.warmup.map(x => { const id = 'warmup-' + x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return `<li><a data-act="info" data-id="${id}" style="text-decoration:underline">${esc(x)}</a></li>`; }).join('')}</ul>
  </details>
  ${s && s.finished ? `<a class="btn" href="#/s/${w}/${sel}">Workout summary</a>` : ''}
  <a class="btn${s && s.finished ? ' sec' : ''}" href="#/w/${w}/${sel}" ${s && s.finished ? 'style="margin-top:10px"' : ''}>${s && s.finished ? 'View / edit workout' : (s && Object.keys(s.sets).length ? 'Continue workout' : 'Start workout')}</a>`;
}

/* ---------- one-screen workout summary (made to be screenshotted) ---------- */
function viewSummary(w, d) {
  setTab('home');
  const day = dayById(d), s = session(w, d);
  if (!day || !s) return viewHome(new URLSearchParams());
  const idx = sessIdx(w, d);
  const start = s.date ? new Date(s.date) : null, end = s.end ? new Date(s.end) : null;
  const mins = start && end ? Math.round((end - start) / 6e4) : null;
  let setsDone = 0, setsPlan = 0, vol = 0, prs = 0;
  const rows = day.exercises.map(ex => {
    const ds = doneSets(s.sets[ex.id]); setsPlan += ex.sets; setsDone += ds.length;
    ds.forEach(x => vol += setVol(ex.id, x));
    const short = ex.name.replace(/\s*\(.*?\)/g, '');
    if (!ds.length) return `<tr class="skip"><td>${esc(short)}</td><td colspan="3" class="muted">Skipped</td></tr>`;
    const lp = lastWeekPerf(ex.id, w, d);
    const byReps = ex.unit === 'sec' || ds.every(q => !(+q.kg > 0));
    const score = a => byReps ? Math.max(...a.map(q => +q.reps || 0)) : Math.max(...a.map(q => e1rm(q.kg, q.reps)));
    const best = Math.max(0, ...exposures(ex).filter(x => sessIdx(x.w, x.d) < idx).map(x => x.score));
    const now = score(ds); const isPR = best > 0 && now > best + 1e-9; if (isPR) prs++;
    let cmp = '<span class="muted">first</span>';
    if (lp) {
      const lTop = Math.max(...lp.sets.map(q => +q.kg || 0)), nTop = Math.max(...ds.map(q => +q.kg || 0));
      const lReps = lp.sets.reduce((a, q) => a + (+q.reps || 0), 0), nReps = ds.reduce((a, q) => a + (+q.reps || 0), 0);
      const dKg = nTop - lTop, dR = nReps - lReps, unit = ex.unit === 'sec' ? 's' : ' reps';
      cmp = !byReps && Math.abs(dKg) > 0.01 ? `<span class="${dKg > 0 ? 'up' : 'down'}">${dKg > 0 ? '▲ +' : '▼ '}${fmt(dKg)} kg</span>`
        : dR ? `<span class="${dR > 0 ? 'up' : 'down'}">${dR > 0 ? '▲ +' : '▼ '}${dR}${unit === ' reps' && Math.abs(dR) === 1 ? ' rep' : unit}</span>` : '<span class="muted">= same</span>';
    }
    const sets = ds.map(q => byReps && !(+q.kg > 0) ? `${fmt(q.reps)}${ex.unit === 'sec' ? 's' : ''}` : `${fmt(q.kg)}×${fmt(q.reps)}`).join('  ') + (perSide(ex.id) && !byReps ? ' <span class="side">/side</span>' : '');
    const rir = rirOf(s, ex.id);
    return `<tr><td>${esc(short)}${isPR ? ' <span class="prb">PR</span>' : ''}${s.notes && s.notes[ex.id] ? `<div class="sn">${esc(s.notes[ex.id])}</div>` : ''}</td><td class="sets">${sets}</td><td class="c">${rir == null ? '–' : rir}</td><td class="r">${cmp}</td></tr>`;
  }).join('');
  const bw = (S.body || []).find(b => start && b.d === new Date(start.getTime() - start.getTimezoneOffset() * 6e4).toISOString().slice(0, 10));
  const dateStr = start ? start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'From your sheet';
  return `<div class="sum" id="summary">
    <div class="sumhead">
      <div><div class="eyebrow">${esc(PLAN.athlete)} · Week ${w} of ${PLAN.weeks}</div><div class="sumtitle">${esc(day.name)} · ${esc(day.focus)}</div><div class="small muted">${dateStr}${start && end ? ` · ${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</div></div>
      <div class="sumlogo" aria-hidden="true">◉</div>
    </div>
    <div class="sumstats">
      <div><b>${setsDone}<small>/${setsPlan}</small></b><span>Sets</span></div>
      <div><b>${vol >= 1000 ? (Math.round(vol / 100) / 10) + 't' : Math.round(vol) + 'kg'}</b><span>Volume</span></div>
      <div><b>${mins != null && mins >= 0 && mins < 300 ? mins + "'" : '–'}</b><span>Minutes</span></div>
      <div><b>${prs}</b><span>PRs</span></div>
      ${bw ? `<div><b>${fmt(bw.kg)}</b><span>Body kg</span></div>` : ''}
    </div>
    <table class="sumtable"><thead><tr><th>Exercise</th><th>Sets (kg×reps)</th><th class="c">RIR</th><th class="r">vs last</th></tr></thead><tbody>${rows}</tbody></table>
    ${s.notes && s.notes._workout ? `<div class="sumnote"><b>Notes:</b> ${esc(s.notes._workout)}</div>` : ''}
    <div class="sumfoot">RIR = reps left on last set · vs last = change since last time</div>
  </div>
  <div class="sumactions">
    <p class="small muted" style="text-align:center;margin:10px 0">Take a screenshot (side + volume up) to send to your adviser.</p>
    <a class="btn" href="#/">Done</a>
    ${PLAN.days.every(x => (session(w, x.id) || {}).finished) ? `<a class="btn sec" href="#/ws/${w}" style="margin-top:10px">Week ${w} summary</a>` : ''}
    <a class="btn sec" href="#/w/${w}/${d}" style="margin-top:10px">Edit workout</a>
  </div>`;
}

/* ---------- one-screen weekly summary ---------- */
function weekScoreBest(ex, w) {
  const xs = exposures(ex).filter(x => x.w === w); return xs.length ? { score: Math.max(...xs.map(x => x.score)), byReps: xs[0].byReps } : null;
}
const half = v => (Math.round(v * 2) / 2) % 1 ? `${Math.floor(v)}½` : String(Math.round(v));
function viewWeekSummary(w) {
  setTab('progress');
  w = Math.min(PLAN.weeks, Math.max(1, w));
  let setsDone = 0, setsPlan = 0, vol = 0, prevVol = 0, prs = 0, mins = 0, minsN = 0;
  const dates = [];
  const dayRows = PLAN.days.map(d => {
    const s = session(w, d.id); let sd = 0, sp = 0, v = 0, pr = 0;
    d.exercises.forEach(ex => {
      sp += ex.sets; const ds = s ? doneSets(s.sets[ex.id]) : []; sd += ds.length; ds.forEach(q => v += setVol(ex.id, q));
      if (ds.length) { const idx = sessIdx(w, d.id); const before = exposures(ex).filter(x => sessIdx(x.w, x.d) < idx); const me = exposures(ex).find(x => x.w === w && x.d === d.id);
        if (me && before.length && me.score > Math.max(...before.map(x => x.score)) + 1e-9) pr++; }
    });
    const ps = session(w - 1, d.id); if (ps) d.exercises.forEach(ex => doneSets(ps.sets[ex.id]).forEach(q => prevVol += setVol(ex.id, q)));
    setsDone += sd; setsPlan += sp; vol += v; prs += pr;
    const st = s && s.date ? new Date(s.date) : null, en = s && s.end ? new Date(s.end) : null; if (st) dates.push(st);
    const m = st && en ? Math.round((en - st) / 6e4) : null; if (m != null && m > 0 && m < 300) { mins += m; minsN++; }
    const done = s && s.finished;
    return `<tr class="${done ? '' : 'skip'}"><td><b>D${d.id}</b> ${esc(d.focus)}</td><td>${st ? st.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) : (done ? 'sheet' : '–')}</td><td class="c">${sd}/${sp}</td><td class="c">${v ? (Math.round(v / 100) / 10) + 't' : '–'}</td><td class="c">${m != null && m > 0 && m < 300 ? m + "'" : '–'}</td><td class="r">${done ? (pr ? `<span class="prb">${pr} PR</span>` : '✓') : '<span class="muted">not done</span>'}</td></tr>`;
  }).join('');
  const done = PLAN.days.filter(d => (session(w, d.id) || {}).finished).length;
  // reps left
  const rirs = []; PLAN.days.forEach(d => { const s = session(w, d.id); if (s) d.exercises.forEach(ex => { if (doneSets(s.sets[ex.id]).length) { const r = rirOf(s, ex.id); if (r != null) rirs.push(r); } }); });
  const rirAvg = rirs.length ? (rirs.reduce((a, b) => a + b, 0) / rirs.length).toFixed(1) : '–';
  // body weight: average over the 7 days from the week's first workout, vs the 7 days before
  let bw = null;
  if (dates.length && (S.body || []).length) {
    const t0 = Math.min(...dates.map(x => x.getTime())), day = 864e5;
    const inRange = (a, b) => S.body.filter(x => { const t = new Date(x.d + 'T12:00').getTime(); return t >= a && t < b; }).map(x => x.kg);
    const cur = inRange(t0 - day / 2, t0 + 7 * day), prev = inRange(t0 - 7 * day, t0 - day / 2);
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    if (cur.length) bw = { avg: avg(cur), diff: prev.length ? avg(cur) - avg(prev) : null };
  }
  // exercise changes vs last week (best of the week)
  const changes = allExercises().map(ex => { const a = weekScoreBest(ex, w), b = weekScoreBest(ex, w - 1); if (!a || !b || !b.score || a.byReps !== b.byReps) return null; return { ex, pct: (a.score / b.score - 1) * 100 }; }).filter(Boolean).sort((a, b) => b.pct - a.pct);
  const ups = changes.filter(c => c.pct > 0.5).slice(0, 4), downs = changes.filter(c => c.pct < -0.5).sort((a, b) => a.pct - b.pct).slice(0, 3);
  const flat = changes.filter(c => Math.abs(c.pct) <= 0.5).length;
  const short = n => n.replace(/\s*\(.*?\)/g, '');
  // muscles
  const act = weekMuscleSets(w, false), pl = weekMuscleSets(w, true);
  const mus = MUSCLES.filter(m => pl[m].sets > 0).map(m => { const a = act[m].sets; const ab = { 'Front delts': 'Front dl.', 'Side delts': 'Side dl.', 'Rear delts': 'Rear dl.', 'Upper back': 'U.back', 'Hamstrings': 'Hams' }; return `<div class="wm"><span title="${m}"><span class="lg">${m}</span><span class="sm">${ab[m] || m}</span></span><b class="${a === 0 ? '' : a < 10 ? 'lo' : a <= 20 ? 'ok' : 'hi'}">${half(a)}</b><i>/${half(pl[m].sets)}</i></div>`; }).join('');
  const range = dates.length ? (() => { const a = new Date(Math.min(...dates)), b = new Date(Math.max(...dates)); const f = x => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); return f(a) === f(b) ? f(a) : `${f(a)} – ${f(b)}`; })() : '';
  const volChg = prevVol ? Math.round((vol / prevVol - 1) * 100) : null;
  return `<div class="sum" id="summary">
    <div class="sumhead">
      <div><div class="eyebrow">${esc(PLAN.athlete)} · ${esc(PLAN.block)} block</div><div class="sumtitle">Week ${w} of ${PLAN.weeks} summary</div><div class="small muted">${range}</div></div>
      <div class="sumlogo" aria-hidden="true">◉</div>
    </div>
    <div class="sumstats">
      <div><b>${done}<small>/${nDays()}</small></b><span>Workouts</span></div>
      <div><b>${setsDone}<small>/${setsPlan}</small></b><span>Sets</span></div>
      <div><b>${Math.round(vol / 100) / 10}t</b><span>${volChg == null ? 'Volume' : `Vol <span class="${volChg >= 0 ? 'up' : 'down'}">${volChg >= 0 ? '+' : ''}${volChg}%</span>`}</span></div>
      <div><b>${prs}</b><span>PRs</span></div>
      <div><b>${rirAvg}</b><span>Avg RIR</span></div>
    </div>
    <table class="sumtable wk"><thead><tr><th>Day</th><th>Date</th><th class="c">Sets</th><th class="c">Vol</th><th class="c">Min</th><th class="r"></th></tr></thead><tbody>${dayRows}</tbody></table>
    <div class="wgrid">
      <div><div class="wh">Stronger vs last week</div>${ups.length ? ups.map(c => `<div class="wl"><span>${esc(short(c.ex.name))}</span><b class="up">+${Math.round(c.pct)}%</b></div>`).join('') : `<div class="wl muted">${w === 1 ? 'First week — baseline' : 'No gains logged'}</div>`}</div>
      <div><div class="wh">Down</div>${downs.length ? downs.map(c => `<div class="wl"><span>${esc(short(c.ex.name))}</span><b class="down">${Math.round(c.pct)}%</b></div>`).join('') : '<div class="wl muted">None</div>'}${flat ? `<div class="wl muted">${flat} unchanged</div>` : ''}</div>
    </div>
    <div class="wh" style="margin-top:8px">Sets per muscle (done/plan)</div><div class="wms">${mus}</div>
    ${bw ? `<div class="sumnote"><b>Body weight:</b> ${fmt(Math.round(bw.avg * 10) / 10)} kg avg${bw.diff != null ? ` · <span class="${bw.diff >= 0 ? 'up' : 'down'}">${bw.diff >= 0 ? '+' : ''}${fmt(Math.round(bw.diff * 100) / 100)} kg</span> vs week before` : ''}${minsN ? ` · ${Math.round(mins / minsN)}' avg session` : ''}</div>` : (minsN ? `<div class="sumnote">${Math.round(mins / minsN)}' average session</div>` : '')}
    <div class="sumfoot">Changes use estimated 1RM (or reps for bodyweight) · RIR = reps left on last set</div>
  </div>
  <div class="sumactions">
    <div class="weeknav" style="margin-top:12px"><a class="navbtn" href="#/ws/${Math.max(1, w - 1)}" aria-label="Previous week">‹</a><div class="grow small muted" style="text-align:center">Screenshot to share with your adviser</div><a class="navbtn" href="#/ws/${Math.min(PLAN.weeks, w + 1)}" aria-label="Next week">›</a></div>
    <a class="btn" href="#/progress?w=${w}">Done</a>
  </div>`;
}

function viewWorkout(w, d) {
  setTab('home');
  w = +w; d = +d;
  const day = dayById(d); if (!day) return viewHome(new URLSearchParams());
  const s = session(w, d, true);
  const idx = sessIdx(w, d);
  return `
  <div class="row between"><a href="#/?d=${d}" class="muted back">‹ Back</a><span class="eyebrow">Week ${w}</span></div>
  <h1 style="margin-top:8px">${esc(day.name)} · ${esc(day.focus)}</h1>
  ${day.exercises.map((ex, i) => exCard(ex, s, idx, w, d, i)).join('')}
  <div class="ex"><h3>Workout notes</h3><textarea class="note-in" data-note="_workout" rows="3" placeholder="Energy, sleep, gym busy, anything to remember…" aria-label="Workout notes">${esc((s.notes && s.notes._workout) || '')}</textarea></div>
  <button class="btn" data-act="finish" data-w="${w}" data-d="${d}" style="margin-top:18px">${s.finished ? 'Save changes' : 'Finish workout'}</button>`;
}

function exCard(ex, s, idx, w, d, i) {
  const lp = lastWeekPerf(ex.id, w, d);
  const ln = lastNote(ex.id, idx);
  const myNote = (s.notes && s.notes[ex.id]) || '';
  const sg = suggest(ex, lp);
  const mine = s.sets[ex.id] || [];
  const n = Math.max(ex.sets, mine.length);
  const isSec = ex.unit === 'sec';
  const complete = doneSets(mine).length >= ex.sets;
  const note = PLAN.coachNotes[ex.id];
  let rows = '';
  for (let k = 0; k < n; k++) {
    const cur = mine[k] || {};
    const prev = lp && (lp.sets[k] || lp.sets[lp.sets.length - 1]);
    // Default = last week's numbers, filled in; the user overwrites when needed.
    const has = v => v !== undefined && v !== null && v !== '';
    const vKg = has(cur.kg) ? fmt(cur.kg) : prev ? fmt(prev.kg) : '';
    const vR = has(cur.reps) ? fmt(cur.reps) : prev ? fmt(prev.reps) : '';
    const phKg = '';
    const phR = String(ex.repMax ?? '');
    rows += `<div class="set ${cur.done ? 'done' : ''}" data-ex="${ex.id}" data-k="${k}">
      <span class="n">${k + 1}</span>
      <div class="step"><button class="sb" data-act="step" data-f="kg" data-d="-1" aria-label="Less weight">−</button><input inputmode="decimal" enterkeyhint="next" aria-label="Set ${k + 1} kg" data-f="kg" value="${esc(vKg)}" placeholder="${esc(phKg)}"><button class="sb" data-act="step" data-f="kg" data-d="1" aria-label="More weight">+</button></div>
      <div class="step"><button class="sb" data-act="step" data-f="reps" data-d="-1" aria-label="Fewer ${isSec ? 'seconds' : 'reps'}">−</button><input inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" aria-label="Set ${k + 1} ${isSec ? 'seconds' : 'reps'}" data-f="reps" value="${esc(vR)}" placeholder="${esc(phR)}"><button class="sb" data-act="step" data-f="reps" data-d="1" aria-label="More ${isSec ? 'seconds' : 'reps'}">+</button></div>
      <button class="ok" data-act="set" aria-label="Complete set ${k + 1}">✓</button>
      ${prev ? `<span class="prevcap">Last: ${fmt(prev.kg)} kg${perSide(ex.id) ? '/side' : ''} × ${fmt(prev.reps)}${isSec ? ' s' : ''}</span>` : ''}
    </div>`;
  }
  return `<section class="ex ${complete ? 'complete' : ''}" id="ex-${ex.id}">
    <div class="exhead" data-act="info" data-id="${ex.id}">
      <div class="thumb" ${thumb(ex.id)}></div>
      <div class="grow"><h3>${i + 1}. ${esc(ex.name)}</h3><div class="small muted">${ex.sets} sets × ${esc(ex.reps)} · rest ${restLabel(ex.id)}</div></div>
      <span class="muted" aria-label="How to">ⓘ</span>
    </div>
    ${sg ? `<div style="margin-top:8px"><span class="badge b-${sg.type}">${esc(sg.text)}</span></div>` : ''}
    ${note ? `<div class="tiny muted" style="margin-top:6px">Coach note available — tap ⓘ</div>` : ''}
    <div class="sets">
      <div class="sethdr"><span style="text-align:center">Set</span><button class="kgmode" data-act="side" data-ex="${ex.id}" aria-label="Switch between total weight and weight per side">${perSide(ex.id) ? 'kg per side' : 'kg total'} ⇄</button><span style="text-align:center">${isSec ? 'Sec' : 'Reps'}</span><span></span></div>
      ${rows}
      <button class="addset" data-act="addset" data-ex="${ex.id}">+ Add set</button>
    </div>
    <div class="rir" data-ex="${ex.id}"><span class="tiny muted">Reps left on last set</span><div class="rirchips">${[0, 1, 2].map(v => `<button data-act="rir" data-v="${v}" class="${rirOf(s, ex.id) === v ? 'on' : ''}" aria-label="${v} reps left">${v}</button>`).join('')}</div></div>
    ${ln ? `<div class="lastnote"><span class="muted">Last note (W${ln.w} D${ln.d}):</span> ${esc(ln.text)}</div>` : ''}
    <textarea class="note-in" data-note="${ex.id}" rows="2" placeholder="Notes — seat setting, how it felt…" aria-label="Notes for ${esc(ex.name)}">${esc(myNote)}</textarea>
  </section>`;
}
const restSecs = id => (EX[id] && EX[id].rest) || S.settings.restDefault;
function restLabel(id) { const r = restSecs(id); return r >= 60 ? `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}` : `${r}s`; }

/* ---------- science-based progress analytics ---------- */
const MUSCLES = ['Chest', 'Front delts', 'Side delts', 'Rear delts', 'Triceps', 'Lats', 'Upper back', 'Biceps', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Abs'];
const findEx = id => PLAN.days.flatMap(d => d.exercises).find(e => e.id === id);
const muscleWork = id => (PLAN.muscleMap || {})[id] || { p: [], s: [] };
/** Fractional set counting (Pelland et al.): direct sets = 1, indirect sets = 0.5. */
function weekMuscleSets(w, planned) {
  const out = {}; MUSCLES.forEach(m => out[m] = { sets: 0, days: 0, maxSession: 0 });
  PLAN.days.forEach(d => {
    const s = session(w, d.id); const per = {}, direct = {};
    d.exercises.forEach(ex => {
      const n = planned ? ex.sets : (s ? doneSets(s.sets[ex.id]).length : 0); if (!n) return;
      const mw = muscleWork(ex.id);
      mw.p.forEach(m => { per[m] = (per[m] || 0) + n; direct[m] = 1; });
      mw.s.forEach(m => { per[m] = (per[m] || 0) + n * 0.5; });
    });
    Object.entries(per).forEach(([m, v]) => { if (!out[m]) return; out[m].sets += v; if (direct[m]) out[m].days++; out[m].maxSession = Math.max(out[m].maxSession, v); });
  });
  return out;
}
/** Reps left on the last set: defaults to 0 unless changed (not assumed for sessions imported from the sheet). */
function rirOf(s, exId) { if (!s) return null; const v = s.rir ? s.rir[exId] : undefined; if (v !== undefined && v !== null) return Math.min(2, +v); return s.imported ? null : 0; }
function exposures(ex) {
  const xs = sessionsOrdered().map(x => { const ds = doneSets(x.s.sets[ex.id]); return ds.length ? { w: x.w, d: x.d, ds, rir: x.s.rir ? x.s.rir[ex.id] : undefined } : null; }).filter(Boolean);
  // One measure per exercise: estimated 1RM only if every session had load; otherwise best reps/seconds.
  const byReps = ex.unit === 'sec' || xs.some(x => x.ds.every(q => !(+q.kg > 0)));
  xs.forEach(x => { x.byReps = byReps; x.score = byReps ? Math.max(...x.ds.map(q => +q.reps || 0)) : Math.max(...x.ds.map(q => e1rm(q.kg, q.reps))); });
  return xs;
}
function exStatus(ex) {
  const xs = exposures(ex); if (!xs.length) return null;
  const first = xs[0].score, last = xs[xs.length - 1].score;
  const change = first > 0 ? (last / first - 1) * 100 : 0;
  let st;
  if (xs.length < 2) st = { k: 'new', t: 'Baseline' };
  else {
    const prevBest = Math.max(...xs.slice(0, -1).map(x => x.score));
    if (xs.length >= 4 && Math.max(...xs.slice(-3).map(x => x.score)) <= Math.max(...xs.slice(0, -3).map(x => x.score)) + 1e-9) st = { k: 'stall', t: 'Stalled' };
    else if (last > prevBest + 1e-9) st = { k: 'pr', t: 'New best' };
    else st = { k: 'ok', t: 'Holding' };
    const sg = suggest(ex, { sets: xs[xs.length - 1].ds });
    if (sg && sg.type === 'up' && st.k !== 'stall') st = { k: 'up', t: 'Add load' };
  }
  return { xs, change, st, last, byReps: xs[xs.length - 1].byReps };
}
function bodyRate() {
  const b = (S.body || []).slice().sort((a, c) => a.d < c.d ? -1 : 1); if (b.length < 2) return null;
  const t = new Date(b[b.length - 1].d).getTime(), day = 864e5;
  const avg = arr => arr.reduce((x, y) => x + y.kg, 0) / arr.length;
  const recent = b.filter(x => t - new Date(x.d).getTime() < 7 * day), prior = b.filter(x => { const a = t - new Date(x.d).getTime(); return a >= 7 * day && a < 14 * day; });
  if (!prior.length) { const f = b[0], days = (t - new Date(f.d).getTime()) / day; if (days < 6) return null; const kgw = (b[b.length - 1].kg - f.kg) / days * 7; return { kgw, pct: kgw / f.kg * 100 }; }
  const kgw = avg(recent) - avg(prior); return { kgw, pct: kgw / avg(prior) * 100 };
}

function viewProgress(params) {
  setTab('progress');
  const W = Math.min(PLAN.weeks, Math.max(1, +(params.get('w') || S.week)));
  const exs = allExercises().filter(e => sessionsOrdered().some(x => doneSets(x.s.sets[e.id]).length));
  const id = params.get('ex') || (exs[0] && exs[0].id);
  const q = (o) => { const u = new URLSearchParams({ w: W, ...(id ? { ex: id } : {}), ...o }); return '#/progress?' + u.toString(); };
  const weeklyVol = Array.from({ length: PLAN.weeks }, (_, i) => {
    let v = 0; PLAN.days.forEach(d => { const s = session(i + 1, d.id); if (s) Object.entries(s.sets).forEach(([id, a]) => doneSets(a).forEach(x => v += setVol(id, x))); });
    return v;
  });
  const doneW = PLAN.days.filter(d => (session(W, d.id) || {}).finished).length;
  const actual = weekMuscleSets(W, false), plan = weekMuscleSets(W, true);
  const hardSets = PLAN.days.reduce((t, d) => { const s = session(W, d.id); return t + (s ? Object.values(s.sets).reduce((a, x) => a + doneSets(x).length, 0) : 0); }, 0);
  const plannedSets = PLAN.days.reduce((t, d) => t + d.exercises.reduce((a, e) => a + e.sets, 0), 0);

  // Muscle volume rows
  const scale = 24;
  const mrows = MUSCLES.filter(m => plan[m].sets > 0).map(m => {
    const a = actual[m].sets, pl = plan[m].sets;
    const zone = a === 0 ? '' : a < 10 ? 'lo' : a <= 20 ? 'ok' : 'hi';
    return `<div class="mrow">
      <span class="mname">${m}</span>
      <div class="mbar" title="${fmt(a)} of ${fmt(pl)} planned"><i class="plan" style="width:${Math.min(100, pl / scale * 100)}%"></i><i class="done ${zone}" style="width:${Math.min(100, a / scale * 100)}%"></i><b style="left:${10 / scale * 100}%"></b><b style="left:${20 / scale * 100}%"></b></div>
      <span class="mval">${fmt(a)}<span class="muted">/${fmt(pl)}</span></span>
      <span class="mfreq ${plan[m].days >= 2 || !plan[m].days ? '' : 'one'}">${plan[m].days ? plan[m].days + '×' : '—'}</span>
    </div>`;
  }).join('');
  const overSession = MUSCLES.filter(m => actual[m].maxSession > 11);

  // Progression status
  const stats = allExercises().map(e => ({ e, r: exStatus(e) })).filter(x => x.r);
  const order = { stall: 0, up: 1, pr: 2, ok: 3, new: 4 };
  stats.sort((a, b) => order[a.r.st.k] - order[b.r.st.k]);
  const counts = stats.reduce((c, x) => (c[x.r.st.k] = (c[x.r.st.k] || 0) + 1, c), {});
  const statusRow = x => `<a class="srow" href="${q({ ex: x.e.id })}">
      <span class="grow"><span style="font-weight:600">${esc(x.e.name)}</span><span class="tiny muted" style="display:block">${x.r.xs.length} session${x.r.xs.length > 1 ? 's' : ''} · ${x.r.byReps ? 'best ' + fmt(x.r.last) + (x.e.unit === 'sec' ? ' s' : ' reps') : 'e1RM ' + Math.round(x.r.last) + ' kg'}</span></span>
      ${x.r.xs.length > 1 ? `<span class="chg ${x.r.change > 0.5 ? 'pos' : x.r.change < -0.5 ? 'neg' : ''}">${x.r.change > 0 ? '+' : ''}${Math.round(x.r.change)}%</span>` : ''}
      <span class="st st-${x.r.st.k}">${x.r.st.t}</span></a>`;
  const statusRows = stats.slice(0, 6).map(statusRow).join('') + (stats.length > 6 ? `<details class="more"><summary>Show all ${stats.length} exercises</summary>${stats.slice(6).map(statusRow).join('')}</details>` : '');

  // Effort (RIR)
  const rirVals = []; PLAN.days.forEach(d => { const s = session(W, d.id); if (!s) return; d.exercises.forEach(e => { if (!doneSets(s.sets[e.id]).length) return; const v = rirOf(s, e.id); if (v != null) rirVals.push(v); }); });
  const rirAvg = rirVals.length ? rirVals.reduce((a, b) => a + b, 0) / rirVals.length : 0;
  const rirHist = [0, 1, 2].map(v => rirVals.filter(x => x === v).length);

  // Exercise detail
  let detail = '';
  if (id) {
    const ex = findEx(id); const r = ex && exStatus(ex);
    const pts = r ? r.xs.map(x => {
      const best = x.ds.reduce((a, b) => e1rm(b.kg, b.reps) > e1rm(a.kg, a.reps) ? b : a);
      return { label: `W${x.w}D${x.d}`, kg: Math.max(...x.ds.map(s => +((ex.unit === 'sec') ? s.reps : s.kg) || 0)), e: e1rm(best.kg, best.reps), best, inRange: ex.repMin == null || x.ds.every(s => +s.reps >= ex.repMin && +s.reps <= ex.repMax) };
    }) : [];
    const bestAll = pts.reduce((a, b) => (b.e > (a ? a.e : -1) ? b : a), null);
    const inRangePct = pts.length ? Math.round(pts.filter(p => p.inRange).length / pts.length * 100) : 0;
    detail = `
    <select data-act="pickex" aria-label="Exercise">${exs.map(e => `<option value="${e.id}" ${e.id === id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
    <div class="stats">
      <div class="stat"><div class="v">${bestAll ? `${fmt(bestAll.best.kg)}×${fmt(bestAll.best.reps)}` : '—'}</div><div class="l">Best set</div></div>
      <div class="stat"><div class="v">${bestAll && bestAll.e ? Math.round(bestAll.e) : '—'}</div><div class="l">Est. 1RM kg</div></div>
      <div class="stat"><div class="v">${r && r.xs.length > 1 ? (r.change > 0 ? '+' : '') + Math.round(r.change) + '%' : '—'}</div><div class="l">Since start</div></div>
    </div>
    <div class="card"><div class="small muted">${ex && ex.unit === 'sec' ? 'Longest hold per session (sec)' : 'Top weight per session (kg)'}</div>${lineChart(pts.map(p => p.label), pts.map(p => p.kg), pts.map(p => p.e))}
    <div class="tiny muted"><span style="color:var(--acc)">●</span> top kg &nbsp; <span style="color:var(--muted)">●</span> est. 1RM${ex && ex.repMin != null ? ` &nbsp;·&nbsp; ${inRangePct}% of sessions inside ${esc(ex.reps)}` : ''}</div></div>`;
  }

  // Body weight
  const body = (S.body || []).slice().sort((a, c) => a.d < c.d ? -1 : 1);
  const br = bodyRate();
  const lastB = body[body.length - 1];
  const bodyPts = body.slice(-30);

  const prs = allExercises().map(e => { let best = null; sessionsOrdered().forEach(x => doneSets(x.s.sets[e.id]).forEach(s => { if (!best || e1rm(s.kg, s.reps) > e1rm(best.kg, best.reps)) best = s; })); return { e, best }; }).filter(x => x.best && +x.best.kg > 0);

  return `<h1>Progress</h1>
  <div class="weeknav">
    <a class="navbtn" href="${q({ w: Math.max(1, W - 1) })}" aria-label="Previous week">‹</a>
    <div class="grow" style="text-align:center;font-weight:700">Week ${W} of ${PLAN.weeks}${W === S.week ? ' <span class="tiny muted">· current</span>' : ''}</div>
    <a class="navbtn" href="${q({ w: Math.min(PLAN.weeks, W + 1) })}" aria-label="Next week">›</a>
  </div>
  <a class="btn sec" href="#/ws/${W}" style="margin-bottom:10px">Week ${W} summary for your adviser</a>
  <div class="stats">
    <div class="stat"><div class="v">${doneW}/${nDays()}</div><div class="l">Workouts</div></div>
    <div class="stat"><div class="v">${hardSets}<span class="muted" style="font-size:13px">/${plannedSets}</span></div><div class="l">Working sets</div></div>
    <div class="stat"><div class="v">${Math.round(weeklyVol[W - 1] / 100) / 10}t</div><div class="l">Volume load</div></div>
  </div>

  <h2>Weekly sets per muscle</h2>
  <div class="card">
    <div class="tiny muted" style="margin-bottom:8px">Fractional count: direct sets = 1, helper sets = 0.5 (e.g. presses add ½ set to triceps). Grey = your coach's plan; colour = done. Lines at 10 and 20 sets. <b>2×</b> = days per week trained directly.</div>
    ${mrows}
    <div class="legend tiny"><span><i class="lo"></i>under 10</span><span><i class="ok"></i>10–20</span><span><i class="hi"></i>over 20</span></div>
    ${overSession.length ? `<div class="note" style="margin-top:10px">Over ~11 sets for ${overSession.join(', ')} in a single session — research suggests little extra benefit past that in one workout.</div>` : ''}
  </div>

  <h2>Progression check</h2>
  <div class="chips" style="margin-top:-2px">${counts.pr ? `<span class="st st-pr">${counts.pr} new best</span>` : ''}${counts.up ? `<span class="st st-up">${counts.up} add load</span>` : ''}${counts.stall ? `<span class="st st-stall">${counts.stall} stalled</span>` : ''}${counts.ok ? `<span class="st st-ok">${counts.ok} holding</span>` : ''}</div>
  <div class="card" style="padding:2px 14px">${statusRows || '<p class="muted small" style="padding:12px 0">Log a few sessions to see trends.</p>'}</div>
  <div class="tiny muted" style="margin:-4px 2px 0">Strength trend uses estimated 1RM (Epley). "Stalled" = no new best in the last 3 sessions of that exercise.</div>

  <h2>Exercise detail</h2>
  ${detail || '<div class="card muted">Log your first workout to see charts here.</div>'}

  <h2>Effort</h2>
  <div class="card">
    ${rirVals.length ? `<div class="row between"><div><div style="font-size:22px;font-weight:700">${(Math.round(rirAvg * 10) / 10).toFixed(1)}</div><div class="small muted">average reps left on last set (week ${W})</div></div>
    <div class="rirhist">${rirHist.map((n, i) => `<div><span style="color:var(--text);font-weight:600">${n}</span><i style="height:${Math.max(3, n / Math.max(...rirHist, 1) * 40)}px" class="in"></i><span>${i}</span></div>`).join('')}</div></div>`
      : `<p class="small muted">Log a workout to see this. “Reps left on last set” is 0 unless you tap 1 or 2.</p>`}
    <div class="tiny muted" style="margin-top:8px">0, 1 and 2 are all close enough to failure for muscle growth. Stopping 1–2 reps short is usually about as effective as going to failure.</div>
  </div>

  <h2>Body weight</h2>
  <div class="card">
    <div class="row" style="gap:8px"><input class="field" style="flex:1" inputmode="decimal" id="bwin" placeholder="${lastB ? fmt(lastB.kg) : 'kg'}" aria-label="Body weight kg"><button class="btn" style="width:auto;padding:12px 18px" data-act="bwlog">Log</button></div>
    ${body.length ? `<div class="stats" style="margin-top:10px"><div class="stat"><div class="v">${fmt(lastB.kg)}</div><div class="l">Latest kg</div></div>
      <div class="stat"><div class="v">${br ? (br.pct > 0 ? '+' : '') + (Math.round(br.pct * 100) / 100) + '%' : '—'}</div><div class="l">Per week</div></div>
      <div class="stat"><div class="v">${br ? (br.kgw > 0 ? '+' : '') + (Math.round(br.kgw * 100) / 100) : '—'}</div><div class="l">kg / week</div></div></div>
      ${bodyPts.length > 1 ? lineChart(bodyPts.map(b => b.d.slice(5)), bodyPts.map(b => b.kg), rolling(bodyPts.map(b => b.kg), 7), true) : ''}
      <div class="tiny muted">Weigh in the morning, 3+ times a week; watch the 7-day average (dashed), not single days.${body.length ? ` <a data-act="bwundo" style="text-decoration:underline">Remove last entry</a>` : ''}</div>` : ''}
    <div class="tiny muted" style="margin-top:6px">For a lean muscle gain, studies suggest about +0.25–0.5% of body weight per week (slower for experienced lifters).</div>
  </div>

  <h2>Weekly volume</h2>
  <div class="card"><div class="small muted">kg × reps, all exercises</div>${barChart(weeklyVol.map((_, i) => 'W' + (i + 1)), weeklyVol, W)}</div>

  <details class="card"><summary style="font-weight:600">Personal records (${prs.length})</summary>
  <table class="pr" style="margin-top:6px">${prs.map(x => `<tr><td><a href="${q({ ex: x.e.id })}">${esc(x.e.name)}</a></td><td>${fmt(x.best.kg)} kg × ${fmt(x.best.reps)}</td></tr>`).join('') || '<tr><td class="muted">None yet</td><td></td></tr>'}</table></details>

  <details class="card"><summary style="font-weight:600">The science behind these numbers</summary>
    <ul class="clean small">
      <li><b>Volume:</b> more weekly sets per muscle → more growth, with diminishing returns. Counting helper sets as ½ predicted results best. <a href="https://doi.org/10.1007/s40279-025-02344-w">Pelland et al., Sports Med 2025</a>; <a href="https://doi.org/10.1080/02640414.2016.1210197">Schoenfeld et al., J Sports Sci 2017</a></li>
      <li><b>Per session:</b> benefits flatten around ~11 fractional sets per muscle in one workout. <a href="https://sportrxiv.org/index.php/server/preprint/view/537">Remmert et al., 2025 preprint</a></li>
      <li><b>Frequency:</b> with equal weekly sets, how many days you split them over matters little for size. <a href="https://pubmed.ncbi.nlm.nih.gov/30558493/">Schoenfeld et al., 2019</a></li>
      <li><b>Effort:</b> growth improves as sets end closer to failure, while strength gains are similar across a wide range. Going all the way to failure isn't clearly better than stopping just short. <a href="https://doi.org/10.1007/s40279-024-02069-2">Robinson et al., Sports Med 2024</a>; <a href="https://doi.org/10.1007/s40279-022-01784-y">Refalo et al., Sports Med 2023</a></li>
      <li><b>Body weight:</b> ~0.25–0.5%/week for lean gains. <a href="https://doi.org/10.3390/sports7070154">Iraki et al., Sports 2019</a></li>
    </ul>
    <p class="tiny muted" style="margin-top:6px">These are population averages, not rules. Your coach's plan comes first.</p>
  </details>`;
}
function rolling(arr, n) { return arr.map((_, i) => { const a = arr.slice(Math.max(0, i - n + 1), i + 1); return a.reduce((x, y) => x + y, 0) / a.length; }); }

function lineChart(labels, a, b, tight) {
  if (!a.length) return '<p class="muted small" style="padding:20px 0">No data yet</p>';
  const W = 320, H = 150, P = { l: 30, r: 8, t: 10, b: 22 };
  const all = [...a, ...b].filter(v => v > 0); let max = Math.max(...all, 1), min = Math.min(...all, max) * 0.9;
  if (tight) { const lo = Math.min(...all), hi = Math.max(...all), pad = Math.max(0.5, (hi - lo) * 0.25); min = lo - pad; max = hi + pad; }
  const x = i => P.l + (labels.length === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (labels.length - 1));
  const y = v => P.t + (H - P.t - P.b) * (1 - (v - min) / ((max - min) || 1));
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ticks = [min, (min + max) / 2, max];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#2e3136"/><text x="2" y="${y(t) + 4}">${(max - min) < 6 ? t.toFixed(1) : Math.round(t)}</text>`).join('')}
    <path d="${path(b)}" fill="none" stroke="#9a9ea5" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${path(a)}" fill="none" stroke="#c6f432" stroke-width="2.5"/>
    ${a.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="#c6f432"/>`).join('')}
    ${labels.map((l, i) => (labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${l}</text>` : '').join('')}
  </svg>`;
}
function barChart(labels, vals, hl) {
  if (hl == null) hl = S.week;
  const W = 320, H = 120, P = { l: 6, r: 6, t: 14, b: 20 }, max = Math.max(...vals, 1);
  const bw = (W - P.l - P.r) / vals.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly volume">
    ${vals.map((v, i) => { const h = (H - P.t - P.b) * v / max; const X = P.l + i * bw + 4; return `<rect x="${X}" y="${H - P.b - h}" width="${bw - 8}" height="${Math.max(h, v ? 2 : 0)}" rx="3" fill="${i === hl - 1 ? '#c6f432' : '#3a3e44'}"/>${v ? `<text x="${X + (bw - 8) / 2}" y="${H - P.b - h - 3}" text-anchor="middle">${Math.round(v / 100) / 10}t</text>` : ''}<text x="${X + (bw - 8) / 2}" y="${H - 5}" text-anchor="middle">${labels[i]}</text>`; }).join('')}
  </svg>`;
}

function viewLibrary() {
  setTab('library');
  const groups = {};
  PLAN.days.forEach(d => d.exercises.forEach(e => { (groups[d.focus] = groups[d.focus] || new Map()).set(e.id, e); }));
  return `<h1>Exercises</h1>${Object.entries(groups).map(([g, m]) => `<h2>${esc(g)}</h2><div class="card" style="padding:4px 14px">${[...m.values()].map(e => { const i = exInfo(e.id); return `<div class="exrow" data-act="info" data-id="${e.id}"><div class="thumb" ${thumb(e.id)}></div><div class="grow"><div style="font-weight:600">${esc(e.name)}</div><div class="small muted">${esc((i.muscles || []).join(', '))}</div></div><span class="muted">›</span></div>`; }).join('')}</div>`).join('')}
  <h2>Warm-up</h2><div class="card" style="padding:4px 14px">${PLAN.warmup.map(x => { const id = 'warmup-' + x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return `<div class="exrow" data-act="info" data-id="${id}"><div class="thumb" ${thumb(id)}></div><div class="grow" style="font-weight:600">${esc(x)}</div><span class="muted">›</span></div>`; }).join('')}</div>`;
}

function viewSettings() {
  setTab('settings');
  const bytes = (localStorage.getItem(KEY) || '').length;
  return `<h1>Settings</h1>
  <div class="card">
    <div class="row between"><div><div style="font-weight:600">Rest timer sound</div><div class="small muted">Beeps when rest ends (app must be open)</div></div>
    <input type="checkbox" data-act="sound" ${S.settings.sound ? 'checked' : ''} style="width:24px;height:24px;accent-color:#c6f432"></div>
    <div style="margin-top:14px;font-weight:600">Default rest</div>
    <select data-act="restdef" style="margin-top:6px">${[60, 90, 120, 150, 180].map(v => `<option value="${v}" ${v === S.settings.restDefault ? 'selected' : ''}>${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}</option>`).join('')}</select>
    <div class="tiny muted" style="margin-top:6px">Used when an exercise has no suggested rest.</div>
    <div style="margin-top:14px;font-weight:600">Weight step for + / −</div>
    <select data-act="kgstep" style="margin-top:6px">${[1, 1.25, 2.5, 5].map(v => `<option value="${v}" ${v === (S.settings.kgStep || 2.5) ? 'selected' : ''}>${v} kg</option>`).join('')}</select>
  </div>
  <h2>Your data</h2>
  <div class="card">
    <p class="small muted" style="margin-bottom:12px">Everything is stored only on this phone (${Math.round(bytes / 1024)} KB). Back up now and then — deleting the app or clearing Safari data erases it.</p>
    <button class="btn" data-act="excelsheet">Export to Excel (your sheet)</button>
    <button class="btn sec" data-act="excel">Export detailed log + notes</button>
    <button class="btn sec" data-act="backup">Back up (file)</button>
    <label class="btn sec" style="margin-top:10px">Restore from backup<input type="file" accept="application/json,.json" data-act="restore" hidden></label>
  </div>
  <div class="card"><button class="btn danger" data-act="reset">Erase all data</button></div>
  <p class="tiny muted" style="text-align:center;margin-top:16px">Train · ${esc(PLAN.athlete)} · ${esc(PLAN.block)} · v${APP_VERSION}</p>`;
}
const APP_VERSION = '1.9.1';

/* ---------- exercise info sheet ---------- */
function openInfo(id) {
  const i = exInfo(id); const note = PLAN.coachNotes[id];
  const sh = $('#sheet');
  const pics = (i.images || []).length ? `<div class="pics"><img src="${esc(i.images[0])}" alt="${esc(i.name)} start position">${i.images[1] ? `<img class="b" src="${esc(i.images[1])}" alt="${esc(i.name)} end position">` : ''}</div>
    <div class="tiny muted">${i.imageIsApprox ? 'Similar movement shown — your machine may differ. ' : ''}Images: free-exercise-db (public domain)</div>` : '';
  const list = (t, a) => a && a.length ? `<h3 style="margin-top:16px">${t}</h3><ul class="clean small">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  sh.innerHTML = `<div class="panel"><div class="grab"></div>
    <div class="row between"><h2 style="margin:0">${esc(i.name)}</h2><button data-act="close" aria-label="Close" style="font-size:22px;padding:4px 8px">✕</button></div>
    <div class="myphotos">
      ${(PHOTOS[id] || []).map((src, k) => `<div class="ph"><img src="${src}" alt="Your photo ${k + 1}" data-act="bigphoto"><button data-act="delphoto" data-id="${id}" data-i="${k}" aria-label="Delete photo">✕</button></div>`).join('')}
      ${(PHOTOS[id] || []).length < MAX_PHOTOS ? `<label class="ph add"><span>＋</span><span class="tiny">${(PHOTOS[id] || []).length ? 'Add photo' : 'Add your machine photo'}</span><input type="file" accept="image/*" data-act="addphoto" data-id="${id}" hidden></label>` : ''}
    </div>
    ${pics}
    <div class="chips">${(i.muscles || []).map(m => `<span class="chip">${esc(m)}</span>`).join('')}${i.equipment ? `<span class="chip">${esc(i.equipment)}</span>` : ''}${i.tempo ? `<span class="chip">Tempo ${esc(i.tempo)}</span>` : ''}${i.rest ? `<span class="chip">Rest ${restLabel(id)}</span>` : ''}</div>
    ${findEx(id) && findEx(id).unit !== 'sec' ? `<div class="sidetoggle"><span class="small">Weight I log is</span><div class="seg"><button data-act="side" data-ex="${id}" data-v="0" class="${perSide(id) ? '' : 'on'}">Total</button><button data-act="side" data-ex="${id}" data-v="1" class="${perSide(id) ? 'on' : ''}">Per side</button></div></div>
    <div class="tiny muted" style="margin:-4px 0 8px">Per side = one dumbbell or one arm. Volume then counts both sides.</div>` : ''}
    ${i.summary ? `<p class="small">${esc(i.summary)}</p>` : ''}
    ${note ? `<div class="note"><b>Your coach:</b> ${esc(note)}</div>` : ''}
    ${list('Setup', i.setup)}${list('Cues', i.cues)}${list('Common mistakes', i.mistakes)}
    ${!EX[id] ? '<p class="small muted" style="margin-top:12px">No guide for this exercise yet.</p>' : ''}
  </div>`;
  sh.classList.remove('hidden');
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheet').innerHTML = ''; }

/* ---------- rest timer + sound ---------- */
let actx = null, tInt = null, beeped = false;
function unlockAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext; actx = new AC();
    const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource(); src.buffer = b; src.connect(actx.destination); src.start(0);
  } catch (e) { actx = null; }
}
function beep() {
  if (!S.settings.sound || !actx) return;
  try { if (navigator.audioSession) navigator.audioSession.type = 'transient'; } catch (e) { }
  const t0 = actx.currentTime;
  [0, 0.28, 0.56].forEach((dt, i) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = i === 2 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
    o.connect(g).connect(actx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.25);
  });
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function startTimer(sec) {
  localStorage.setItem(TIMER_KEY, String(Date.now() + sec * 1000)); beeped = false; tick();
  clearInterval(tInt); tInt = setInterval(tick, 250);
}
function stopTimer() { localStorage.removeItem(TIMER_KEY); clearInterval(tInt); tInt = null; $('#timer').classList.add('hidden'); }
function tick() {
  const end = +localStorage.getItem(TIMER_KEY); if (!end) return stopTimer();
  const left = Math.round((end - Date.now()) / 1000);
  const el = $('#timer');
  if (left <= 0) {
    if (!beeped && left > -5) { beeped = true; beep(); toast('Rest done — next set'); }
    stopTimer(); return;
  } else { el.classList.remove('hidden', 'over'); $('#tval').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; }
}
function nudgeTimer(d) { const end = +localStorage.getItem(TIMER_KEY); if (!end) return; localStorage.setItem(TIMER_KEY, String(Math.max(Date.now() + 1000, end + d * 1000))); beeped = false; tick(); }

/* ---------- workout interactions ---------- */
function rowState(row) {
  const ex = row.dataset.ex, k = +row.dataset.k;
  const m = location.hash.match(/#\/w\/(\d+)\/(\d+)/); if (!m) return null;
  const s = session(+m[1], +m[2], true);
  const arr = s.sets[ex] || (s.sets[ex] = []);
  while (arr.length <= k) arr.push({ kg: '', reps: '', done: false });
  return { s, arr, set: arr[k], ex, k };
}
function onSetInput(inp) {
  const row = inp.closest('.set'); const st = rowState(row); if (!st) return;
  const v = num(inp.value);
  st.set[inp.dataset.f] = v === '' ? '' : (isNaN(+v) ? '' : +v);
  save();
}
function toggleSet(row) {
  const st = rowState(row); if (!st) return;
  const kgI = $('input[data-f=kg]', row), rI = $('input[data-f=reps]', row);
  if (!st.set.done) {
    if (kgI.value === '' && kgI.placeholder !== '') kgI.value = kgI.placeholder;
    if (rI.value === '' && rI.placeholder !== '') rI.value = rI.placeholder;
    const kg = +num(kgI.value), reps = +num(rI.value);
    if (num(rI.value) === '' || isNaN(reps) || reps <= 0) { rI.focus(); toast('Enter reps first'); return; }
    st.set.kg = isNaN(kg) ? 0 : kg; st.set.reps = reps; st.set.done = true;
    if (!st.s.date) st.s.date = new Date().toISOString();
    row.classList.add('done');
    startTimer(restSecs(st.ex));
  } else { st.set.done = false; row.classList.remove('done'); }
  save();
  const card = row.closest('.ex'); const ex = PLAN.days.flatMap(d => d.exercises).find(e => e.id === st.ex);
  const complete = doneSets(st.arr).length >= ex.sets;
  card.classList.toggle('complete', complete);
  if (st.set.done && complete) { const next = card.nextElementSibling; if (next && next.classList.contains('ex')) setTimeout(() => next.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350); }
}

/* ---------- export / backup ---------- */
async function deliverFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function summarize(sets, id) {
  const tag = id && perSide(id) ? '/side' : '';
  const ds = doneSets(sets); if (!ds.length) return '';
  const same = ds.every(s => s.kg === ds[0].kg && s.reps === ds[0].reps);
  if (same) return `${ds.length} x ${fmt(ds[0].reps)} x ${fmt(ds[0].kg)}${+ds[0].kg > 0 ? tag : ''}`;
  // Same "sets x reps x load" style as the coach's sheet, grouping consecutive identical sets.
  // e.g. "2 x 12/10 x 100" (same load) or "2 x 12/10 x 100/105" (load changed)
  const reps = ds.map(x => fmt(x.reps)), kgs = ds.map(x => fmt(x.kg));
  const one = a => a.every(v => v === a[0]) ? a[0] : a.join('/');
  return `${ds.length} x ${one(reps)} x ${one(kgs)}${tag}`;
}
/** Fill the coach's original workbook (kept as a template) so the export looks exactly like it. */
async function exportSheetFormat() {
  if (!window.JSZip) return toast('Still loading — try again');
  const X = PLAN.excel; if (!X) return exportExcel();
  toast('Preparing Excel…');
  try {
    const buf = await fetch(X.template).then(r => { if (!r.ok) throw new Error('template'); return r.arrayBuffer(); });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file(X.sheet).async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const NS = doc.documentElement.namespaceURI;
    const sheetData = doc.getElementsByTagNameNS(NS, 'sheetData')[0];
    const rowsByN = {}; for (const r of sheetData.getElementsByTagNameNS(NS, 'row')) rowsByN[r.getAttribute('r')] = r;
    const colNum = ref => ref.replace(/\d+/g, '').split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
    function cell(ref) {
      const rn = ref.replace(/[A-Z]+/g, '');
      let row = rowsByN[rn];
      if (!row) {
        row = doc.createElementNS(NS, 'row'); row.setAttribute('r', rn); rowsByN[rn] = row;
        const after = [...sheetData.getElementsByTagNameNS(NS, 'row')].find(r => +r.getAttribute('r') > +rn);
        sheetData.insertBefore(row, after || null);
      }
      let c = [...row.getElementsByTagNameNS(NS, 'c')].find(x => x.getAttribute('r') === ref);
      if (!c) {
        c = doc.createElementNS(NS, 'c'); c.setAttribute('r', ref);
        const after = [...row.getElementsByTagNameNS(NS, 'c')].find(x => colNum(x.getAttribute('r')) > colNum(ref));
        row.insertBefore(c, after || null);
      }
      return c;
    }
    function put(ref, text) {
      const c = cell(ref);
      while (c.firstChild) c.removeChild(c.firstChild);
      c.removeAttribute('t');
      if (text) { c.setAttribute('t', 'inlineStr'); const is = doc.createElementNS(NS, 'is'), t = doc.createElementNS(NS, 't'); t.textContent = text; is.appendChild(t); c.appendChild(is); }
    }
    PLAN.days.forEach(d => d.exercises.forEach(e => {
      const row = X.rows[d.id] && X.rows[d.id][e.id]; if (!row) return;
      X.weekCols.forEach((col, i) => { const s = session(i + 1, d.id); put(col + row, s ? summarize(s.sets[e.id], e.id) : ''); });
    }));
    zip.file(X.sheet, new XMLSerializer().serializeToString(doc));
    zip.remove('xl/calcChain.xml');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    deliverFile(blob, `${PLAN.athlete}_${PLAN.block.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (err) { toast('Could not build the Excel file'); }
}
function exportExcel() {
  if (!window.XLSX) return toast('Excel library still loading — try again');
  const rows = [[null, null, PLAN.athlete.toUpperCase()], []];
  PLAN.days.forEach(d => {
    rows.push([null, `DAY ${d.id}`, d.focus.toUpperCase(), null, null, ...Array.from({ length: PLAN.weeks }, (_, i) => `Week ${i + 1}`)]);
    rows.push([null, null, 'Movement', 'Sets', 'Reps', ...Array(PLAN.weeks).fill('sets x reps x load')]);
    d.exercises.forEach(e => rows.push([null, null, e.name, e.sets, e.reps, ...Array.from({ length: PLAN.weeks }, (_, i) => { const s = session(i + 1, d.id); return s ? summarize(s.sets[e.id], e.id) || null : null; })]));
    rows.push([]);
  });
  const log = [['Date', 'Week', 'Day', 'Focus', 'Exercise', 'Set', 'kg', 'kg is', 'Reps / sec', 'Est. 1RM', 'Reps left (last set)']];
  sessionsOrdered().forEach(x => { const day = dayById(x.d); if (!day) return; day.exercises.forEach(e => doneSets(x.s.sets[e.id]).forEach((s, i) => log.push([x.s.date ? new Date(x.s.date).toLocaleDateString('en-GB') : (x.s.imported ? 'from sheet' : ''), x.w, x.d, day.focus, e.name, i + 1, +s.kg || 0, perSide(e.id) ? 'per side' : 'total', +s.reps, e.unit === 'sec' ? null : Math.round(e1rm(s.kg, s.reps) * 10) / 10, rirOf(x.s, e.id)]))); });
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(rows); ws1['!cols'] = [{ wch: 3 }, { wch: 7 }, { wch: 40 }, { wch: 6 }, { wch: 9 }, ...Array(PLAN.weeks).fill({ wch: 18 })];
  const ws2 = XLSX.utils.aoa_to_sheet(log); ws2['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 5 }, { wch: 7 }, { wch: 40 }, { wch: 5 }, { wch: 7 }, { wch: 10 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, ws1, PLAN.block.slice(0, 31)); XLSX.utils.book_append_sheet(wb, ws2, 'Set log');
  const notes = [['Date', 'Week', 'Day', 'Exercise', 'Note']];
  sessionsOrdered().forEach(x => { const day = dayById(x.d); if (!day || !x.s.notes) return; Object.entries(x.s.notes).forEach(([id, t]) => { if (!t || !t.trim()) return; const e = day.exercises.find(q => q.id === id); notes.push([x.s.date ? new Date(x.s.date).toLocaleDateString('en-GB') : '', x.w, x.d, id === '_workout' ? 'Workout' : (e ? e.name : id), t.trim()]); }); });
  const ws3 = XLSX.utils.aoa_to_sheet(notes); ws3['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 5 }, { wch: 36 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Notes');
  const bw = [['Date', 'Body weight (kg)'], ...(S.body || []).slice().sort((a, b) => a.d < b.d ? -1 : 1).map(b => [b.d, b.kg])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bw), 'Body weight');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  deliverFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${PLAN.athlete}_${PLAN.block.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
function backup() { deliverFile(new Blob([JSON.stringify({ app: 'train', ...S, photos: PHOTOS })], { type: 'application/json' }), `train-backup-${new Date().toISOString().slice(0, 10)}.json`); }
function restore(file) {
  const r = new FileReader();
  r.onload = () => { try { const d = JSON.parse(r.result); if (!d.log || typeof d.log !== 'object') throw 0; if (!confirm('Replace all data on this phone with this backup?')) return; delete d.app; const ph = d.photos; delete d.photos; S = d; if (ph && typeof ph === 'object') { PHOTOS = ph; Object.keys(ph).forEach(k => savePhotos(k).catch(() => { })); } S.settings = Object.assign({ sound: true, restDefault: 120 }, S.settings || {}); S.week = Math.min(PLAN.weeks, Math.max(1, +S.week || 1)); save(); toast('Backup restored'); route(); } catch (e) { toast('That file is not a Train backup'); } };
  r.readAsText(file);
}

/* ---------- router & events ---------- */
function route() {
  const h = location.hash || '#/';
  const [path, q] = h.slice(1).split('?'); const params = new URLSearchParams(q || '');
  let html; let m;
  document.body.classList.toggle('summary-mode', /^\/(s|ws)\//.test(path));
  if ((m = path.match(/^\/w\/(\d+)\/(\d+)/))) html = viewWorkout(m[1], m[2]);
  else if ((m = path.match(/^\/ws\/(\d+)/))) html = viewWeekSummary(+m[1]);
  else if ((m = path.match(/^\/s\/(\d+)\/(\d+)/))) html = viewSummary(+m[1], +m[2]);
  else if (path.startsWith('/progress')) html = viewProgress(params);
  else if (path.startsWith('/library')) html = viewLibrary();
  else if (path.startsWith('/settings')) html = viewSettings();
  else html = viewHome(params);
  $('#view').innerHTML = html;
  const pill = $('.pill.on'); if (pill) pill.parentElement.scrollLeft = pill.offsetLeft - 16;
  if (!/^\/w\//.test(path) || route.last !== path) window.scrollTo(0, 0);
  route.last = path;
}
document.addEventListener('click', e => {
  unlockAudio();
  const t = e.target.closest('[data-act]'); if (!t) { if (e.target.id === 'sheet') closeSheet(); return; }
  const a = t.dataset.act;
  if (a === 'info') { e.preventDefault(); openInfo(t.dataset.id); }
  else if (a === 'close') closeSheet();
  else if (a === 'side') {
    const id = t.dataset.ex; setPerSide(id, t.dataset.v != null ? t.dataset.v === '1' : !perSide(id));
    toast(perSide(id) ? 'Weight is per side — volume counts both sides' : 'Weight is total');
    const inSheet = !!t.closest('.sheet'); const y = window.scrollY; route(); window.scrollTo(0, y); if (inSheet) openInfo(id);
  }
  else if (a === 'bigphoto') { const ph = t.closest('.ph'); const on = !ph.classList.contains('big'); document.querySelectorAll('.myphotos .ph.big').forEach(x => x.classList.remove('big')); ph.classList.toggle('big', on); }
  else if (a === 'delphoto') { const id = t.dataset.id; if (!confirm('Delete this photo?')) return; PHOTOS[id].splice(+t.dataset.i, 1); savePhotos(id).then(() => { openInfo(id); refreshThumbs(id); if (!/^#\/w\//.test(location.hash)) { const y = window.scrollY; route(); window.scrollTo(0, y); } }); }
  else if (a === 'set') toggleSet(t.closest('.set'));
  else if (a === 'rir') {
    const m = location.hash.match(/#\/w\/(\d+)\/(\d+)/); if (!m) return; const s = session(+m[1], +m[2], true); s.rir = s.rir || {};
    const exId = t.closest('.rir').dataset.ex, v = +t.dataset.v;
    s.rir[exId] = v; save();
    t.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', v === +b.dataset.v));
  }
  else if (a === 'bwlog') {
    const v = +num($('#bwin').value); if (!(v > 20 && v < 400)) { toast('Enter your weight in kg'); return; }
    const d = new Date(); const key = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    S.body = (S.body || []).filter(x => x.d !== key); S.body.push({ d: key, kg: v }); save(); toast('Body weight saved'); const y = window.scrollY; route(); window.scrollTo(0, y);
  }
  else if (a === 'bwundo') { if (!S.body || !S.body.length) return; S.body.sort((x, y) => x.d < y.d ? -1 : 1).pop(); save(); const y = window.scrollY; route(); window.scrollTo(0, y); }
  else if (a === 'step') {
    const inp = t.parentElement.querySelector('input'); const isKg = t.dataset.f === 'kg';
    const exId = t.closest('.set').dataset.ex; const ex = PLAN.days.flatMap(q => q.exercises).find(q => q.id === exId);
    const step = isKg ? (S.settings.kgStep || 2.5) : (ex && ex.unit === 'sec' ? 5 : 1);
    let v = num(inp.value); v = (v === '' || isNaN(+v)) ? (num(inp.placeholder) || 0) : +v;
    v = Math.max(0, Math.round((v + step * +t.dataset.d) * 100) / 100);
    inp.value = fmt(v); onSetInput(inp);
  }
  else if (a === 'addset') { const m = location.hash.match(/#\/w\/(\d+)\/(\d+)/); const s = session(+m[1], +m[2], true); (s.sets[t.dataset.ex] = s.sets[t.dataset.ex] || []); const ex = PLAN.days.flatMap(d => d.exercises).find(x => x.id === t.dataset.ex); while (s.sets[t.dataset.ex].length < ex.sets) s.sets[t.dataset.ex].push({ kg: '', reps: '', done: false }); s.sets[t.dataset.ex].push({ kg: '', reps: '', done: false }); save(); const y = window.scrollY; route(); window.scrollTo(0, y); }
  else if (a === 'finish') { const s = session(+t.dataset.w, +t.dataset.d, true); const any = Object.values(s.sets).some(x => doneSets(x).length); if (!any && !confirm('No sets ticked. Mark this workout as done anyway?')) return; const first = !s.finished; s.finished = true; s.date = s.date || new Date().toISOString(); if (first || !s.end) s.end = new Date().toISOString(); save(); stopTimer(); location.hash = `#/s/${t.dataset.w}/${t.dataset.d}`; }
  else if (a === 'week') { const nw = Math.min(PLAN.weeks, Math.max(1, S.week + +t.dataset.dir)); if (nw !== S.week) { S.week = nw; save(); } location.hash = '#/'; route(); }
  else if (a === 't-minus') nudgeTimer(-15);
  else if (a === 't-plus') nudgeTimer(15);
  else if (a === 't-skip') stopTimer();
  else if (a === 'excel') exportExcel();
  else if (a === 'excelsheet') exportSheetFormat();
  else if (a === 'backup') backup();
  else if (a === 'reset') { if (confirm('Erase every logged workout on this phone? This cannot be undone.') && confirm('Really erase? Consider a backup first.')) { localStorage.removeItem(KEY); stopTimer(); load(); toast('Data erased'); route(); } }
});
document.addEventListener('input', e => {
  if (e.target.matches('textarea.note-in')) { const m = location.hash.match(/#\/w\/(\d+)\/(\d+)/); if (!m) return; const s = session(+m[1], +m[2], true); (s.notes = s.notes || {})[e.target.dataset.note] = e.target.value; save(); return; } if (e.target.matches('.set input')) onSetInput(e.target); });
document.addEventListener('change', e => {
  const a = e.target.dataset.act;
  if (a === 'pickex') location.hash = '#/progress?ex=' + e.target.value;
  else if (a === 'sound') { S.settings.sound = e.target.checked; save(); if (e.target.checked) { unlockAudio(); beep(); } }
  else if (a === 'restdef') { S.settings.restDefault = +e.target.value; save(); }
  else if (a === 'kgstep') { S.settings.kgStep = +e.target.value; save(); }
  else if (a === 'restore' && e.target.files[0]) restore(e.target.files[0]);
  else if (a === 'addphoto' && e.target.files.length) addPhotos(e.target.dataset.id, [...e.target.files]);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target.matches('.set input')) { e.preventDefault(); const row = e.target.closest('.set'); if (e.target.dataset.f === 'kg') $('input[data-f=reps]', row).focus(); else { e.target.blur(); if (!row.classList.contains('done')) toggleSet(row); } }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && localStorage.getItem(TIMER_KEY)) { clearInterval(tInt); tInt = setInterval(tick, 250); tick(); } });
window.addEventListener('hashchange', () => { closeSheet(); route(); });

async function boot() {
  try {
    const [p, x] = await Promise.all([fetch('data/plan.json').then(r => r.json()), fetch('data/exercises.json').then(r => r.ok ? r.json() : {}).catch(() => ({}))]);
    PLAN = p; EX = x || {};
  } catch (e) { $('#view').innerHTML = '<div class="card">Could not load the program. Open once with internet to install.</div>'; return; }
  load(); await loadPhotos(); route();
  if (localStorage.getItem(TIMER_KEY)) { tInt = setInterval(tick, 250); tick(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
}
boot();
