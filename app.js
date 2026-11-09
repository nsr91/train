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
function thumb(id) { const i = exInfo(id); return i.images && i.images[0] ? `style="background-image:url('${esc(i.images[i.images.length > 1 ? 1 : 0])}')"` : ''; }
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
  ${allWeekDone ? `<div class="card"><h3>Week ${w} complete</h3><p class="muted small" style="margin:4px 0 10px">${w < PLAN.weeks ? 'Nice work. Move on when you are ready.' : 'Block finished — export to Excel and plan the next one.'}</p>${w < PLAN.weeks ? `<button class="btn" data-act="week" data-dir="1">Start week ${w + 1}</button>` : ''}</div>` : ''}
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
  <a class="btn" href="#/w/${w}/${sel}">${s && s.finished ? 'View / edit workout' : (s && Object.keys(s.sets).length ? 'Continue workout' : 'Start workout')}</a>`;
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
      <span class="prev">${prev ? `${fmt(prev.kg)}×${fmt(prev.reps)}` : '—'}</span>
      <input inputmode="decimal" enterkeyhint="next" aria-label="Set ${k + 1} kg" data-f="kg" value="${esc(vKg)}" placeholder="${esc(phKg)}">
      <input inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" aria-label="Set ${k + 1} ${isSec ? 'seconds' : 'reps'}" data-f="reps" value="${esc(vR)}" placeholder="${esc(phR)}">
      <button class="ok" data-act="set" aria-label="Complete set ${k + 1}">✓</button>
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
      <div class="sethdr"><span style="text-align:center">Set</span><span style="text-align:center">Last</span><span style="text-align:center">kg</span><span style="text-align:center">${isSec ? 'Sec' : 'Reps'}</span><span></span></div>
      ${rows}
      <button class="addset" data-act="addset" data-ex="${ex.id}">+ Add set</button>
    </div>
    ${ln ? `<div class="lastnote"><span class="muted">Last note (W${ln.w} D${ln.d}):</span> ${esc(ln.text)}</div>` : ''}
    <textarea class="note-in" data-note="${ex.id}" rows="2" placeholder="Notes — seat setting, how it felt…" aria-label="Notes for ${esc(ex.name)}">${esc(myNote)}</textarea>
  </section>`;
}
const restSecs = id => (EX[id] && EX[id].rest) || S.settings.restDefault;
function restLabel(id) { const r = restSecs(id); return r >= 60 ? `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}` : `${r}s`; }

function viewProgress(params) {
  setTab('progress');
  const exs = allExercises().filter(e => sessionsOrdered().some(x => doneSets(x.s.sets[e.id]).length));
  const id = params.get('ex') || (exs[0] && exs[0].id);
  const weeklyVol = Array.from({ length: PLAN.weeks }, (_, i) => {
    let v = 0; PLAN.days.forEach(d => { const s = session(i + 1, d.id); if (s) Object.values(s.sets).forEach(a => doneSets(a).forEach(x => v += (+x.kg || 0) * (+x.reps || 0))); });
    return v;
  });
  const sessions = sessionsOrdered().filter(x => x.s.finished).length;
  let body = '';
  if (id) {
    const ex = allExercises().find(e => e.id === id);
    const pts = []; // per session best
    sessionsOrdered().forEach(x => { const ds = doneSets(x.s.sets[id]); if (!ds.length) return;
      const best = ds.reduce((a, b) => e1rm(b.kg, b.reps) > e1rm(a.kg, a.reps) ? b : a);
      pts.push({ label: `W${x.w}D${x.d}`, kg: Math.max(...ds.map(s => +((ex && ex.unit === 'sec') ? s.reps : s.kg) || 0)), e: e1rm(best.kg, best.reps), best, vol: ds.reduce((t, s) => t + (+s.kg || 0) * (+s.reps || 0), 0) }); });
    const bestAll = pts.reduce((a, b) => (b.e > (a ? a.e : -1) ? b : a), null);
    body = `
    <select data-act="pickex" aria-label="Exercise">${exs.map(e => `<option value="${e.id}" ${e.id === id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
    <div class="stats">
      <div class="stat"><div class="v">${bestAll ? `${fmt(bestAll.best.kg)}×${fmt(bestAll.best.reps)}` : '—'}</div><div class="l">Best set</div></div>
      <div class="stat"><div class="v">${bestAll && bestAll.e ? Math.round(bestAll.e) : '—'}</div><div class="l">Est. 1RM kg</div></div>
      <div class="stat"><div class="v">${pts.length}</div><div class="l">Sessions</div></div>
    </div>
    <div class="card"><div class="small muted">${ex && ex.unit === 'sec' ? 'Longest hold per session (sec)' : 'Top weight per session (kg)'}</div>${lineChart(pts.map(p => p.label), pts.map(p => p.kg), pts.map(p => p.e))}
    <div class="tiny muted"><span style="color:var(--acc)">●</span> top kg &nbsp; <span style="color:var(--muted)">●</span> est. 1RM</div></div>`;
  } else body = `<div class="card muted">Log your first workout to see charts here.</div>`;
  const prs = allExercises().map(e => { let best = null; sessionsOrdered().forEach(x => doneSets(x.s.sets[e.id]).forEach(s => { if (!best || e1rm(s.kg, s.reps) > e1rm(best.kg, best.reps)) best = s; })); return { e, best }; }).filter(x => x.best && +x.best.kg > 0);
  return `<h1>Progress</h1>
  <div class="stats"><div class="stat"><div class="v">${sessions}</div><div class="l">Workouts</div></div>
  <div class="stat"><div class="v">${S.week}/${PLAN.weeks}</div><div class="l">Week</div></div>
  <div class="stat"><div class="v">${Math.round(weeklyVol[S.week - 1] / 1000 * 10) / 10}t</div><div class="l">Volume this wk</div></div></div>
  ${body}
  <div class="card"><div class="small muted">Weekly volume (kg × reps)</div>${barChart(weeklyVol.map((_, i) => 'W' + (i + 1)), weeklyVol)}</div>
  <h2>Personal records</h2>
  <div class="card" style="padding:4px 14px"><table class="pr">${prs.map(x => `<tr><td><a href="#/progress?ex=${x.e.id}">${esc(x.e.name)}</a></td><td>${fmt(x.best.kg)} kg × ${fmt(x.best.reps)}</td></tr>`).join('') || '<tr><td class="muted">None yet</td><td></td></tr>'}</table></div>`;
}

function lineChart(labels, a, b) {
  if (!a.length) return '<p class="muted small" style="padding:20px 0">No data yet</p>';
  const W = 320, H = 150, P = { l: 30, r: 8, t: 10, b: 22 };
  const all = [...a, ...b].filter(v => v > 0); const max = Math.max(...all, 1), min = Math.min(...all, max) * 0.9;
  const x = i => P.l + (labels.length === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (labels.length - 1));
  const y = v => P.t + (H - P.t - P.b) * (1 - (v - min) / ((max - min) || 1));
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ticks = [min, (min + max) / 2, max];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#2e3136"/><text x="2" y="${y(t) + 4}">${Math.round(t)}</text>`).join('')}
    <path d="${path(b)}" fill="none" stroke="#9a9ea5" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${path(a)}" fill="none" stroke="#c6f432" stroke-width="2.5"/>
    ${a.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="#c6f432"/>`).join('')}
    ${labels.map((l, i) => (labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${l}</text>` : '').join('')}
  </svg>`;
}
function barChart(labels, vals) {
  const W = 320, H = 120, P = { l: 6, r: 6, t: 14, b: 20 }, max = Math.max(...vals, 1);
  const bw = (W - P.l - P.r) / vals.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly volume">
    ${vals.map((v, i) => { const h = (H - P.t - P.b) * v / max; const X = P.l + i * bw + 4; return `<rect x="${X}" y="${H - P.b - h}" width="${bw - 8}" height="${Math.max(h, v ? 2 : 0)}" rx="3" fill="${i === S.week - 1 ? '#c6f432' : '#3a3e44'}"/>${v ? `<text x="${X + (bw - 8) / 2}" y="${H - P.b - h - 3}" text-anchor="middle">${Math.round(v / 100) / 10}t</text>` : ''}<text x="${X + (bw - 8) / 2}" y="${H - 5}" text-anchor="middle">${labels[i]}</text>`; }).join('')}
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
  </div>
  <h2>Your data</h2>
  <div class="card">
    <p class="small muted" style="margin-bottom:12px">Everything is stored only on this phone (${Math.round(bytes / 1024)} KB). Back up now and then — deleting the app or clearing Safari data erases it.</p>
    <button class="btn" data-act="excel">Export to Excel</button>
    <button class="btn sec" data-act="backup">Back up (file)</button>
    <label class="btn sec" style="margin-top:10px">Restore from backup<input type="file" accept="application/json,.json" data-act="restore" hidden></label>
  </div>
  <div class="card"><button class="btn danger" data-act="reset">Erase all data</button></div>
  <p class="tiny muted" style="text-align:center;margin-top:16px">Train · ${esc(PLAN.athlete)} · ${esc(PLAN.block)} · v${APP_VERSION}</p>`;
}
const APP_VERSION = '1.1.0';

/* ---------- exercise info sheet ---------- */
function openInfo(id) {
  const i = exInfo(id); const note = PLAN.coachNotes[id];
  const sh = $('#sheet');
  const pics = (i.images || []).length ? `<div class="pics"><img src="${esc(i.images[0])}" alt="${esc(i.name)} start position">${i.images[1] ? `<img class="b" src="${esc(i.images[1])}" alt="${esc(i.name)} end position">` : ''}</div>
    <div class="tiny muted">${i.imageIsApprox ? 'Similar movement shown — your machine may differ. ' : ''}Images: free-exercise-db (public domain)</div>` : '';
  const list = (t, a) => a && a.length ? `<h3 style="margin-top:16px">${t}</h3><ul class="clean small">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  sh.innerHTML = `<div class="panel"><div class="grab"></div>
    <div class="row between"><h2 style="margin:0">${esc(i.name)}</h2><button data-act="close" aria-label="Close" style="font-size:22px;padding:4px 8px">✕</button></div>
    ${pics}
    <div class="chips">${(i.muscles || []).map(m => `<span class="chip">${esc(m)}</span>`).join('')}${i.equipment ? `<span class="chip">${esc(i.equipment)}</span>` : ''}${i.tempo ? `<span class="chip">Tempo ${esc(i.tempo)}</span>` : ''}${i.rest ? `<span class="chip">Rest ${restLabel(id)}</span>` : ''}</div>
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
  const el = $('#timer'); el.classList.remove('hidden');
  if (left <= 0) {
    if (!beeped) { beeped = true; beep(); }
    el.classList.add('over'); $('#tval').textContent = `Go · +${Math.floor(-left / 60)}:${String(-left % 60).padStart(2, '0')}`;
    if (left < -90) stopTimer();
  } else { el.classList.remove('over'); $('#tval').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; }
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
function summarize(sets) {
  const ds = doneSets(sets); if (!ds.length) return '';
  const same = ds.every(s => s.kg === ds[0].kg && s.reps === ds[0].reps);
  return same ? `${ds.length} x ${fmt(ds[0].reps)} x ${fmt(ds[0].kg)}` : ds.map(s => `${fmt(s.kg)}x${fmt(s.reps)}`).join(', ');
}
function exportExcel() {
  if (!window.XLSX) return toast('Excel library still loading — try again');
  const rows = [[null, null, PLAN.athlete.toUpperCase()], []];
  PLAN.days.forEach(d => {
    rows.push([null, `DAY ${d.id}`, d.focus.toUpperCase(), null, null, ...Array.from({ length: PLAN.weeks }, (_, i) => `Week ${i + 1}`)]);
    rows.push([null, null, 'Movement', 'Sets', 'Reps', ...Array(PLAN.weeks).fill('sets x reps x load')]);
    d.exercises.forEach(e => rows.push([null, null, e.name, e.sets, e.reps, ...Array.from({ length: PLAN.weeks }, (_, i) => { const s = session(i + 1, d.id); return s ? summarize(s.sets[e.id]) || null : null; })]));
    rows.push([]);
  });
  const log = [['Date', 'Week', 'Day', 'Focus', 'Exercise', 'Set', 'kg', 'Reps / sec', 'Est. 1RM']];
  sessionsOrdered().forEach(x => { const day = dayById(x.d); if (!day) return; day.exercises.forEach(e => doneSets(x.s.sets[e.id]).forEach((s, i) => log.push([x.s.date ? new Date(x.s.date).toLocaleDateString('en-GB') : (x.s.imported ? 'from sheet' : ''), x.w, x.d, day.focus, e.name, i + 1, +s.kg || 0, +s.reps, e.unit === 'sec' ? null : Math.round(e1rm(s.kg, s.reps) * 10) / 10]))); });
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(rows); ws1['!cols'] = [{ wch: 3 }, { wch: 7 }, { wch: 40 }, { wch: 6 }, { wch: 9 }, ...Array(PLAN.weeks).fill({ wch: 18 })];
  const ws2 = XLSX.utils.aoa_to_sheet(log); ws2['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 5 }, { wch: 7 }, { wch: 40 }, { wch: 5 }, { wch: 7 }, { wch: 10 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, ws1, PLAN.block.slice(0, 31)); XLSX.utils.book_append_sheet(wb, ws2, 'Set log');
  const notes = [['Date', 'Week', 'Day', 'Exercise', 'Note']];
  sessionsOrdered().forEach(x => { const day = dayById(x.d); if (!day || !x.s.notes) return; Object.entries(x.s.notes).forEach(([id, t]) => { if (!t || !t.trim()) return; const e = day.exercises.find(q => q.id === id); notes.push([x.s.date ? new Date(x.s.date).toLocaleDateString('en-GB') : '', x.w, x.d, id === '_workout' ? 'Workout' : (e ? e.name : id), t.trim()]); }); });
  const ws3 = XLSX.utils.aoa_to_sheet(notes); ws3['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 5 }, { wch: 36 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Notes');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  deliverFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${PLAN.athlete}_${PLAN.block.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
function backup() { deliverFile(new Blob([JSON.stringify({ app: 'train', ...S }, null, 1)], { type: 'application/json' }), `train-backup-${new Date().toISOString().slice(0, 10)}.json`); }
function restore(file) {
  const r = new FileReader();
  r.onload = () => { try { const d = JSON.parse(r.result); if (!d.log || typeof d.log !== 'object') throw 0; if (!confirm('Replace all data on this phone with this backup?')) return; delete d.app; S = d; S.settings = Object.assign({ sound: true, restDefault: 120 }, S.settings || {}); S.week = Math.min(PLAN.weeks, Math.max(1, +S.week || 1)); save(); toast('Backup restored'); route(); } catch (e) { toast('That file is not a Train backup'); } };
  r.readAsText(file);
}

/* ---------- router & events ---------- */
function route() {
  const h = location.hash || '#/';
  const [path, q] = h.slice(1).split('?'); const params = new URLSearchParams(q || '');
  let html; let m;
  if ((m = path.match(/^\/w\/(\d+)\/(\d+)/))) html = viewWorkout(m[1], m[2]);
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
  else if (a === 'set') toggleSet(t.closest('.set'));
  else if (a === 'addset') { const m = location.hash.match(/#\/w\/(\d+)\/(\d+)/); const s = session(+m[1], +m[2], true); (s.sets[t.dataset.ex] = s.sets[t.dataset.ex] || []); const ex = PLAN.days.flatMap(d => d.exercises).find(x => x.id === t.dataset.ex); while (s.sets[t.dataset.ex].length < ex.sets) s.sets[t.dataset.ex].push({ kg: '', reps: '', done: false }); s.sets[t.dataset.ex].push({ kg: '', reps: '', done: false }); save(); const y = window.scrollY; route(); window.scrollTo(0, y); }
  else if (a === 'finish') { const s = session(+t.dataset.w, +t.dataset.d, true); const any = Object.values(s.sets).some(x => doneSets(x).length); if (!any && !confirm('No sets ticked. Mark this workout as done anyway?')) return; s.finished = true; s.date = s.date || new Date().toISOString(); save(); stopTimer(); toast('Workout saved'); location.hash = '#/'; }
  else if (a === 'week') { const nw = Math.min(PLAN.weeks, Math.max(1, S.week + +t.dataset.dir)); if (nw !== S.week) { S.week = nw; save(); } location.hash = '#/'; route(); }
  else if (a === 't-minus') nudgeTimer(-15);
  else if (a === 't-plus') nudgeTimer(15);
  else if (a === 't-skip') stopTimer();
  else if (a === 'excel') exportExcel();
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
  else if (a === 'restore' && e.target.files[0]) restore(e.target.files[0]);
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
  load(); route();
  if (localStorage.getItem(TIMER_KEY)) { tInt = setInterval(tick, 250); tick(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
}
boot();
