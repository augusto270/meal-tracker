(function () {
  'use strict';

  // =====================================================================
  // Constants
  // =====================================================================
  const STORE_KEY = 'mealtracker.v1';
  const KG_PER_LB = 0.45359237;
  const KCAL_PER_KG = 7700; // ~energy in 1 kg of body fat
  const MEALS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks']];
  const ACTIVITY = [
    [1.2, 'Sedentary — desk job, little exercise'],
    [1.375, 'Lightly active — exercise 1–3 days/week'],
    [1.55, 'Moderately active — exercise 3–5 days/week'],
    [1.725, 'Very active — hard exercise 6–7 days/week'],
    [1.9, 'Extremely active — physical job + training']
  ];
  const GOAL_RATES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5]; // kg per week
  const CATS = ['Protein', 'Dairy', 'Grains & Starches', 'Fruits', 'Vegetables', 'Beans & Nuts',
    'Fats & Sauces', 'Drinks', 'Meals & Fast Food', 'Snacks & Sweets'];
  const BASE_FOODS = (window.FOOD_DB || []).map(([n, cat, u, k, p, c, f]) => ({ n, cat, u, k, p, c, f }));

  // =====================================================================
  // State & persistence
  // =====================================================================
  function defaultState() {
    return { profile: null, weights: {}, days: {}, customFoods: [], recent: [] };
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s === 'object') return Object.assign(defaultState(), s);
    } catch (e) { /* ignore */ }
    return defaultState();
  }
  let state = load();
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save. Browser storage is blocked or full'); }
    scheduleBackup();
    requestPersist();
  }
  const hasData = () => !!state.profile || Object.keys(state.weights).length > 0 || Object.keys(state.days).length > 0;

  // =====================================================================
  // Helpers
  // =====================================================================
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtK = (n) => Math.round(n).toLocaleString();
  const fmtG = (n) => (Math.round(n * 10) / 10).toLocaleString();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

  function fmtQ(q) {
    const fr = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
    const w = Math.floor(q), rest = Math.round((q - w) * 100) / 100;
    if (fr[rest]) return (w || '') + fr[rest];
    return String(Math.round(q * 100) / 100);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  const fmtDate = (s, o) => parseYmd(s).toLocaleDateString(undefined, o || { weekday: 'short', month: 'short', day: 'numeric' });

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    const host = document.querySelector('dialog[open]') || document.body;
    if (t.parentElement !== host) host.appendChild(t);
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // Units (weights are always stored in kg)
  const isLb = () => state.profile && state.profile.units === 'lb';
  const wUnit = () => (isLb() ? 'lb' : 'kg');
  const toDisp = (kg) => (isLb() ? kg / KG_PER_LB : kg);
  const fromDisp = (v) => (isLb() ? v * KG_PER_LB : v);
  const fmtW = (kg) => toDisp(kg).toFixed(1);
  const rateLabel = (kgWk, lb = isLb()) => {
    if (kgWk === 0) return 'Maintain weight';
    const amt = Math.abs(kgWk);
    const shown = lb ? `${(amt / KG_PER_LB).toFixed(1)} lb` : `${amt} kg`;
    const extra = kgWk === -0.5 ? ' (recommended)' : kgWk === -1 ? ' (aggressive)' : kgWk === -0.25 ? ' (gentle)' : '';
    return `${kgWk < 0 ? 'Lose' : 'Gain'} ${shown} per week${extra}`;
  };

  // =====================================================================
  // Weight data
  // =====================================================================
  const sortedWeights = () => Object.entries(state.weights).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  function weightOn(date) {
    const all = sortedWeights();
    if (!all.length) return null;
    let w = all[0][1];
    for (const [d, v] of all) { if (d <= date) w = v; else break; }
    return w;
  }
  // 7-day trailing average for every logged day
  function movingAvg(all) {
    return all.map(([d], i) => {
      let sum = 0, n = 0;
      for (let j = i; j >= 0; j--) {
        if (daysBetween(all[j][0], d) > 6) break;
        sum += all[j][1]; n++;
      }
      return [d, sum / n];
    });
  }
  // Linear regression slope in kg/day over entries
  function slopePerDay(entries) {
    if (entries.length < 2) return null;
    const x0 = parseYmd(entries[0][0]);
    const xs = entries.map(([d]) => (parseYmd(d) - x0) / 86400000);
    if (xs[xs.length - 1] < 3) return null;
    const ys = entries.map(([, v]) => v);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let nume = 0, den = 0;
    xs.forEach((x, i) => { nume += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
    return den ? nume / den : null;
  }

  // =====================================================================
  // Calorie target (Mifflin-St Jeor)
  // =====================================================================
  function calcTargets(date) {
    const p = state.profile;
    if (!p) return null;
    const w = weightOn(date || today());
    if (!w) return null;
    const bmr = 10 * w + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
    const tdee = bmr * p.activity;
    const minK = p.sex === 'male' ? 1500 : 1200;
    let kcal = tdee + (p.goalRate * KCAL_PER_KG) / 7;
    let floored = false;
    if (p.goalRate < 0 && kcal < minK) { kcal = minK; floored = true; }
    const manual = !!p.manualTarget;
    if (manual) { kcal = p.manualTarget; floored = false; }
    kcal = Math.round(kcal / 10) * 10;
    const protein = Math.round(w * 1.6);
    const fat = Math.round((kcal * 0.27) / 9);
    const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
    return { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, protein, fat, carbs, floored, manual, weight: w };
  }

  // =====================================================================
  // Food log
  // =====================================================================
  const dayItems = (date) => state.days[date] || [];
  function totals(items) {
    return items.reduce((t, i) => {
      t.k += i.k * i.q; t.p += (i.p || 0) * i.q; t.c += (i.c || 0) * i.q; t.f += (i.f || 0) * i.q;
      return t;
    }, { k: 0, p: 0, c: 0, f: 0 });
  }
  const foodKey = (f) => `${f.n}|${f.u}`;
  const allFoods = () => BASE_FOODS.concat(state.customFoods.map((x) => Object.assign({}, x, { cat: 'My foods', custom: true })));

  function bumpRecent(food) {
    const key = foodKey(food);
    state.recent = [key].concat(state.recent.filter((k) => k !== key)).slice(0, 12);
  }

  // =====================================================================
  // Navigation
  // =====================================================================
  let curDate = today();
  let curTab = 'food';

  function showTab(tab) {
    curTab = tab;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
    renderTab();
    window.scrollTo({ top: 0 });
  }
  function renderTab() {
    if (curTab === 'food') renderFood();
    else if (curTab === 'weight') renderWeight();
    else if (curTab === 'history') renderHistory();
    else if (curTab === 'settings') renderSettings();
  }
  function setDate(d) {
    if (d > today()) { toast("Can't log future days"); return; }
    curDate = d;
    renderFood();
  }

  // =====================================================================
  // FOOD TAB
  // =====================================================================
  function renderFood() {
    $$('.unit-label').forEach((el) => (el.textContent = wUnit()));
    const isToday = curDate === today();
    const yest = addDays(today(), -1);
    const big = isToday ? 'Today' : curDate === yest ? 'Yesterday' : fmtDate(curDate, { weekday: 'long' });
    const sub = fmtDate(curDate, curDate.slice(0, 4) === today().slice(0, 4)
      ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    $('#dateLabel').innerHTML = `<b>${big}</b><small>${sub}</small>`;
    $('#datePick').value = curDate;
    $('#datePick').max = today();
    $('#nextDay').disabled = isToday;
    $('#todayBtn').classList.toggle('hidden', isToday);
    $('#setupBanner').classList.toggle('hidden', !!state.profile);
    renderBackupNudge();
    renderSummary();
    renderQuickWeight();
    renderMeals();
  }

  function renderSummary() {
    const T = calcTargets(curDate);
    const t = totals(dayItems(curDate));
    const target = T ? T.kcal : 0;
    const over = target && t.k > target;
    const C = 2 * Math.PI * 52;
    const pct = target ? Math.min(t.k / target, 1) : 0;
    const fg = $('#ringFg');
    fg.style.strokeDasharray = C;
    fg.style.strokeDashoffset = C * (1 - pct);
    fg.classList.toggle('over', !!over);
    const rn = $('#ringNum');
    rn.textContent = target ? fmtK(Math.abs(target - t.k)) : fmtK(t.k);
    rn.classList.toggle('over', !!over);
    $('#ringLabel').textContent = target ? (over ? 'kcal over' : 'kcal left') : 'kcal eaten';
    $('#sTarget').textContent = target ? fmtK(target) : '—';
    $('#sEaten').textContent = fmtK(t.k);
    $('#sRemLabel').textContent = over ? 'Over by' : 'Remaining';
    $('#sRem').textContent = target ? fmtK(Math.abs(target - t.k)) : '—';
    $('#sRem').classList.toggle('over', !!over);

    const rows = [['Protein', t.p, T && T.protein, 'var(--p)'], ['Carbs', t.c, T && T.carbs, 'var(--c)'], ['Fat', t.f, T && T.fat, 'var(--f)']];
    $('#macros').innerHTML = rows.map(([label, val, goal, color]) => {
      const w = goal ? Math.min(100, (val / goal) * 100) : 0;
      return `<div class="macro"><div class="name">${label}</div>
        <div class="val">${Math.round(val)}${goal ? ` <span>/ ${goal} g</span>` : ' g'}</div>
        <div class="bar"><div style="width:${w}%;background:${color}"></div></div></div>`;
    }).join('');
  }

  function renderQuickWeight() {
    const w = state.weights[curDate];
    const inp = $('#qwInput');
    inp.value = w != null ? fmtW(w) : '';
    const prev = sortedWeights().filter(([d]) => d < curDate).pop();
    inp.placeholder = prev ? fmtW(prev[1]) : '0.0';
    let info = '';
    if (w != null && prev) {
      const diff = toDisp(w - prev[1]);
      info = `${diff > 0 ? '+' : ''}${diff.toFixed(1)} ${wUnit()} vs ${fmtDate(prev[0], { month: 'short', day: 'numeric' })}`;
    } else if (w != null) info = 'Saved for this day';
    else if (prev) info = `Last: ${fmtW(prev[1])} ${wUnit()}, ${fmtDate(prev[0], { month: 'short', day: 'numeric' })}`;
    else info = 'Log it every morning';
    $('#qwInfo').textContent = info;
  }

  function renderMeals() {
    const items = dayItems(curDate);
    $('#meals').innerHTML = MEALS.map(([id, label]) => {
      const its = items.filter((i) => i.meal === id);
      const t = totals(its);
      const list = its.length
        ? '<ul class="entries">' + its.map((i) => `
          <li>
            <div class="e-main" data-edit="${i.id}" role="button" tabindex="0" title="Tap to change the amount">
              <div class="e-name">${esc(i.n)}</div>
              <div class="e-sub">${fmtQ(i.q)} × ${esc(i.u)}</div></div>
            <div class="e-k">${fmtK(i.k * i.q)}</div>
            <button class="e-btn del" data-del="${i.id}" aria-label="Remove ${esc(i.n)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </li>`).join('') + '</ul>'
        : '<div class="meal-empty">Nothing logged yet</div>';
      return `<div class="card meal"><div class="meal-head"><h3>${label}</h3>
        <span class="meal-k">${its.length ? `<b>${fmtK(t.k)}</b> kcal` : ''}</span>
        <button class="add-btn" data-add="${id}" aria-label="Add food to ${label}"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div>${list}</div>`;
    }).join('');
  }

  function saveWeight(date, dispVal) {
    const v = num(dispVal);
    const kg = v == null ? null : fromDisp(v);
    if (kg == null || kg < 20 || kg > 320) { toast('Enter a valid weight'); return false; }
    state.weights[date] = Math.round(kg * 100) / 100;
    save();
    return true;
  }

  // =====================================================================
  // ADD FOOD DIALOG
  // =====================================================================
  const dlg = $('#addDlg');
  let addMeal = 'breakfast';
  let curCat = 'All';
  let sel = null; // { food, editId }
  const isTouch = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  function defaultMealForNow() {
    const h = new Date().getHours();
    return h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snacks';
  }

  function openAdd(meal) {
    addMeal = meal || defaultMealForNow();
    $('#addMeal').value = addMeal;
    $('#addTitle').firstChild.textContent = 'Add to ';
    $('#addMeal').disabled = false;
    $('#addModes').classList.remove('hidden');
    setMode('search');
    $('#foodSearch').value = '';
    curCat = 'All';
    renderChips();
    closePortion();
    renderResults();
    dlg.showModal();
    if (!isTouch()) setTimeout(() => $('#foodSearch').focus(), 30);
  }

  function setMode(mode) {
    $$('#addModes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    ['search', 'quick', 'custom'].forEach((m) => $('#mode-' + m).classList.toggle('hidden', m !== mode));
    if (mode !== 'search') closePortion();
  }

  function renderChips() {
    const cats = ['All'].concat(state.customFoods.length ? ['My foods'] : [], CATS);
    $('#catChips').innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${c === curCat ? 'active' : ''}">${esc(c)}</button>`).join('');
  }

  function searchFoods(q) {
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = allFoods();
    if (curCat !== 'All') list = list.filter((f) => f.cat === curCat);
    if (toks.length) {
      list = list.filter((f) => { const h = (f.n + ' ' + f.cat).toLowerCase(); return toks.every((t) => h.includes(t)); });
      const score = (f) => { const n = f.n.toLowerCase(); return n.startsWith(toks[0]) ? 2 : new RegExp('\\b' + toks[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(n) ? 1 : 0; };
      list.sort((a, b) => score(b) - score(a));
    }
    return list;
  }

  function foodRow(f) {
    return `<button type="button" class="res" data-key="${esc(foodKey(f))}">
      <span class="res-name">${esc(f.n)}${f.custom ? ' <span class="tag">mine</span>' : ''}</span>
      <span class="res-unit">${esc(f.u)}</span>
      <span class="res-k">${fmtK(f.k)} <small>kcal</small></span></button>`;
  }

  function renderResults() {
    const q = $('#foodSearch').value.trim();
    const foods = allFoods();
    let html = '';
    if (!q && curCat === 'All') {
      const rec = state.recent.map((k) => foods.find((f) => foodKey(f) === k)).filter(Boolean);
      if (rec.length) html += '<div class="res-group">Recent</div>' + rec.map(foodRow).join('');
      html += '<div class="res-group">All foods</div>';
    }
    const list = searchFoods(q);
    html += list.length ? list.map(foodRow).join('')
      : `<div class="empty">No match for "${esc(q)}".<br>Try a simpler word, or use <b>Quick add</b> / <b>New food</b>.</div>`;
    $('#foodResults').innerHTML = html;
  }

  function openPortion(food, qty, editId) {
    sel = { food, editId: editId || null };
    $('#pName').textContent = food.n;
    $('#pUnit').textContent = `per ${food.u}: ${fmtK(food.k)} kcal`;
    $('#pQty').value = qty || 1;
    $('#pAdd').textContent = editId ? 'Update' : 'Add';
    $('#portion').classList.remove('hidden');
    updatePortion();
  }
  function closePortion() {
    sel = null;
    $('#portion').classList.add('hidden');
    $$('.res.sel').forEach((b) => b.classList.remove('sel'));
  }
  function getQty() {
    const q = num($('#pQty').value);
    return q && q > 0 ? Math.min(q, 50) : 0;
  }
  function updatePortion() {
    if (!sel) return;
    const q = getQty(), f = sel.food;
    $('#pTotals').innerHTML = `<b>${fmtK(f.k * q)} <small>kcal</small></b>P ${fmtG((f.p || 0) * q)} · C ${fmtG((f.c || 0) * q)} · F ${fmtG((f.f || 0) * q)} g`;
    $$('.qchips button').forEach((b) => b.classList.toggle('active', +b.dataset.set === q));
  }

  function addEntry(food, q, meal) {
    const items = state.days[curDate] || (state.days[curDate] = []);
    items.push({ id: uid(), meal, n: food.n, u: food.u, q, k: food.k, p: food.p || 0, c: food.c || 0, f: food.f || 0 });
    save();
    renderFood();
  }

  function commitPortion() {
    if (!sel) return;
    const q = getQty();
    if (!q) { toast('Enter an amount'); return; }
    if (sel.editId) {
      const it = dayItems(curDate).find((i) => i.id === sel.editId);
      if (it) { it.q = q; it.meal = $('#addMeal').value; save(); renderFood(); }
      dlg.close();
      toast('Updated');
      return;
    }
    addEntry(sel.food, q, $('#addMeal').value);
    bumpRecent(sel.food);
    save();
    toast(`Added ${fmtQ(q)} × ${sel.food.n}`);
    closePortion();
    $('#foodSearch').value = '';
    renderResults();
    if (!isTouch()) $('#foodSearch').focus();
  }

  function openEdit(id) {
    const it = dayItems(curDate).find((i) => i.id === id);
    if (!it) return;
    $('#addMeal').value = it.meal;
    $('#addTitle').firstChild.textContent = 'Edit in ';
    setMode('search');
    $('#addModes').classList.add('hidden');
    $('#foodSearch').value = it.n;
    curCat = 'All';
    renderChips();
    renderResults();
    openPortion(it, it.q, id);
    dlg.showModal();
  }

  // =====================================================================
  // WEIGHT TAB
  // =====================================================================
  let wRange = 90;
  let wChart = null, hChart = null;

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function stat(k, v, s, cls) {
    return `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  }

  function renderWeight() {
    $$('.unit-label').forEach((el) => (el.textContent = wUnit()));
    if (!$('#wDate').value) $('#wDate').value = today();
    $('#wDate').max = today();
    const all = sortedWeights();
    const u = wUnit();

    // ---- stats
    if (!all.length) {
      $('#wStats').innerHTML = '';
    } else {
      const [lastD, lastW] = all[all.length - 1];
      const [firstD, firstW] = all[0];
      const ma = movingAvg(all);
      const avg7 = ma[ma.length - 1][1];
      const change = lastW - firstW;
      const recent = all.filter(([d]) => daysBetween(d, lastD) <= 27);
      const slope = slopePerDay(recent);
      const wk = slope != null ? slope * 7 : null;
      const goal = state.profile && state.profile.goalWeightKg;
      const wantLose = goal && goal < firstW;
      let html = '';
      html += stat('Current', `${fmtW(lastW)} ${u}`, fmtDate(lastD, { month: 'short', day: 'numeric' }));
      html += stat('7-day average', `${fmtW(avg7)} ${u}`, 'your real trend');
      html += stat('Total change', `${change > 0 ? '+' : ''}${toDisp(change).toFixed(1)} ${u}`,
        `since ${fmtDate(firstD, { month: 'short', day: 'numeric', year: 'numeric' })}`,
        change === 0 ? '' : (goal ? ((change < 0) === wantLose ? 'good' : 'bad') : ''));
      html += stat('Weekly rate', wk != null ? `${wk > 0 ? '+' : ''}${toDisp(wk).toFixed(2)} ${u}` : '—',
        wk != null ? 'last 4 weeks' : 'need ~4+ days of data');
      if (goal) {
        const left = avg7 - goal;
        const reached = wantLose ? left <= 0 : left >= 0;
        let eta = '';
        if (!reached && wk && Math.sign(wk) === Math.sign(-left)) {
          const weeks = Math.abs(left / wk);
          if (weeks < 260) eta = 'ETA ' + parseYmd(addDays(today(), Math.round(weeks * 7))).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }
        html += stat('To goal', reached ? 'Reached!' : `${toDisp(Math.abs(left)).toFixed(1)} ${u}`, `goal ${fmtW(goal)} ${u}${eta ? ' · ' + eta : ''}`, reached ? 'good' : '');
      }
      if (state.profile && state.profile.heightCm) {
        const bmi = lastW / (state.profile.heightCm / 100) ** 2;
        const cat = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'healthy range' : bmi < 30 ? 'overweight' : 'obese range';
        html += stat('BMI', bmi.toFixed(1), cat);
      }
      $('#wStats').innerHTML = html;
    }

    // ---- list
    $('#wList').innerHTML = all.length ? all.slice().reverse().map(([d, v], i, arr) => {
      const prev = arr[i + 1];
      const diff = prev ? toDisp(v - prev[1]) : null;
      const dtxt = diff == null ? '' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
      return `<div class="wrow"><span>${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <strong>${fmtW(v)} ${u}</strong><span class="d muted">${dtxt}</span>
        <button class="e-btn del" data-wdel="${d}" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
    }).join('') : '<div class="muted small">Nothing yet.</div>';

    renderWeightChart(all);
  }

  function renderWeightChart(all) {
    if (wChart) { wChart.destroy(); wChart = null; }
    const empty = $('#wEmpty');
    const box = $('#wChart').parentElement;
    if (!window.Chart) { empty.textContent = 'Chart library could not load (needs an internet connection).'; empty.classList.remove('hidden'); box.classList.add('hidden'); return; }
    if (!all.length) { empty.classList.remove('hidden'); box.classList.add('hidden'); return; }
    empty.classList.add('hidden'); box.classList.remove('hidden');

    const start = wRange ? addDays(today(), -wRange) : all[0][0];
    const inRange = ([d]) => d >= start;
    const toPt = ([d, v]) => ({ x: parseYmd(d).getTime(), y: Math.round(toDisp(v) * 100) / 100 });
    const pts = all.filter(inRange).map(toPt);
    const ma = movingAvg(all).filter(inRange).map(toPt);
    const xMin = parseYmd(start < all[0][0] && !wRange ? all[0][0] : start).getTime();
    const xMax = parseYmd(today()).getTime();

    const datasets = [
      {
        label: 'Daily weigh-in', data: pts, borderColor: css('--muted'), backgroundColor: css('--muted'),
        borderWidth: 1, pointRadius: pts.length > 90 ? 1.5 : 3, pointHoverRadius: 5, showLine: pts.length > 1, tension: 0, order: 2
      },
      {
        label: '7-day average', data: ma, borderColor: css('--trend'), backgroundColor: css('--trend'),
        borderWidth: 3, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, order: 1
      }
    ];
    const goal = state.profile && state.profile.goalWeightKg;
    if (goal) {
      const gy = Math.round(toDisp(goal) * 10) / 10;
      datasets.push({
        label: 'Goal', data: [{ x: xMin, y: gy }, { x: xMax, y: gy }], borderColor: css('--accent'),
        borderDash: [6, 5], borderWidth: 2, pointRadius: 0, pointHoverRadius: 0, order: 3
      });
    }

    const grid = css('--grid'), muted = css('--muted');
    wChart = new Chart($('#wChart'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        scales: {
          x: {
            type: 'time', min: xMin, max: xMax,
            time: { tooltipFormat: 'EEE, MMM d, yyyy', displayFormats: { day: 'MMM d', week: 'MMM d', month: 'MMM yyyy' } },
            grid: { color: grid }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 }
          },
          y: {
            grace: '8%', grid: { color: grid },
            ticks: { color: muted, callback: (v) => `${(+v).toFixed(1)}` },
            title: { display: true, text: wUnit(), color: muted }
          }
        },
        plugins: {
          legend: { labels: { color: muted, usePointStyle: true, boxHeight: 6 } },
          tooltip: {
            filter: (item) => item.dataset.label !== 'Goal',
            callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(1)} ${wUnit()}` }
          }
        }
      }
    });
  }

  // =====================================================================
  // HISTORY TAB
  // =====================================================================
  let hRange = 30;
  function renderHistory() {
    const days = [];
    for (let i = hRange - 1; i >= 0; i--) days.push(addDays(today(), -i));
    const rows = days.map((d) => {
      const items = dayItems(d);
      const T = calcTargets(d);
      return { d, logged: items.length > 0, k: totals(items).k, target: T ? T.kcal : null, tdee: T ? T.tdee : null };
    });

    // stats
    const logged = rows.filter((r) => r.logged);
    let html = stat('Days logged', `${logged.length} / ${hRange}`, logged.length < hRange ? 'log every day for best accuracy' : 'perfect streak');
    if (logged.length) {
      const avg = logged.reduce((a, r) => a + r.k, 0) / logged.length;
      html += stat('Avg intake', `${fmtK(avg)} kcal`, 'on logged days');
      const withT = logged.filter((r) => r.target);
      if (withT.length) {
        const avgT = withT.reduce((a, r) => a + r.target, 0) / withT.length;
        const diff = withT.reduce((a, r) => a + (r.k - r.target), 0) / withT.length;
        const onTarget = withT.filter((r) => r.k <= r.target * 1.05).length;
        html += stat('Avg target', `${fmtK(avgT)} kcal`);
        html += stat('Vs target', `${diff > 0 ? '+' : ''}${fmtK(diff)} kcal/day`, diff > 0 ? 'over on average' : 'under on average', diff > 50 ? 'bad' : 'good');
        html += stat('Days on target', `${onTarget} / ${withT.length}`, 'within 5% of target');
        const def = withT.reduce((a, r) => a + (r.k - r.tdee), 0) / withT.length;
        const kgWk = (def * 7) / KCAL_PER_KG;
        html += stat('Expected change', `${kgWk > 0 ? '+' : ''}${toDisp(kgWk).toFixed(2)} ${wUnit()}/wk`,
          `${fmtK(Math.abs(def))} kcal/day ${def < 0 ? 'below' : 'above'} maintenance`);
      }
    }
    $('#hStats').innerHTML = html;

    if (hChart) { hChart.destroy(); hChart = null; }
    if (!window.Chart) return;
    const accent = css('--accent'), warn = css('--warn'), muted = css('--muted'), grid = css('--grid'), text = css('--text');
    hChart = new Chart($('#hChart'), {
      data: {
        labels: rows.map((r) => fmtDate(r.d, hRange <= 7 ? { weekday: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })),
        datasets: [
          {
            type: 'bar', label: 'Eaten', data: rows.map((r) => (r.logged ? Math.round(r.k) : null)),
            backgroundColor: rows.map((r) => (r.target && r.k > r.target * 1.05 ? warn : accent)),
            borderRadius: 4, maxBarThickness: 34, order: 2
          },
          {
            type: 'line', label: 'Target', data: rows.map((r) => r.target), borderColor: text, borderDash: [5, 4],
            borderWidth: 1.5, pointRadius: 0, stepped: 'middle', order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, grid: { color: grid }, ticks: { color: muted }, title: { display: true, text: 'kcal', color: muted } }
        },
        plugins: {
          legend: { labels: { color: muted, usePointStyle: true, boxHeight: 6 } },
          tooltip: { callbacks: { label: (c) => c.parsed.y == null ? ` ${c.dataset.label}: not logged` : ` ${c.dataset.label}: ${fmtK(c.parsed.y)} kcal` } }
        }
      }
    });
  }

  // =====================================================================
  // SETTINGS TAB
  // =====================================================================
  let formUnits = 'kg';

  function fillSelects() {
    $('#pActivity').innerHTML = ACTIVITY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('#addMeal').innerHTML = MEALS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  function fillGoalSelect(selected) {
    $('#pGoal').innerHTML = GOAL_RATES.map((r) => `<option value="${r}">${rateLabel(r, formUnits === 'lb')}</option>`).join('');
    $('#pGoal').value = String(selected);
  }

  function setFormUnits(u) {
    // convert values already typed in the form
    const wasLb = formUnits === 'lb';
    if (u === formUnits) { applyUnitVisibility(); return; }
    const conv = (id) => { const v = num($(id).value); if (v != null) $(id).value = (u === 'lb' ? v / KG_PER_LB : v * KG_PER_LB).toFixed(1); };
    conv('#pWeight'); conv('#pGoalWeight');
    if (wasLb) {
      const ft = num($('#pHeightFt').value) || 0, inch = num($('#pHeightIn').value) || 0;
      if (ft || inch) $('#pHeightCm').value = Math.round((ft * 12 + inch) * 2.54);
    } else {
      const cm = num($('#pHeightCm').value);
      if (cm) { const totalIn = cm / 2.54; $('#pHeightFt').value = Math.floor(totalIn / 12); $('#pHeightIn').value = Math.round((totalIn % 12) * 2) / 2; }
    }
    const goal = $('#pGoal').value;
    formUnits = u;
    fillGoalSelect(goal);
    applyUnitVisibility();
  }
  function applyUnitVisibility() {
    $$('#unitSeg button').forEach((b) => b.classList.toggle('active', b.dataset.u === formUnits));
    $('#heightCmWrap').classList.toggle('hidden', formUnits === 'lb');
    $('#heightFtWrap').classList.toggle('hidden', formUnits !== 'lb');
    $$('#profileForm .unit-label').forEach((el) => (el.textContent = formUnits));
  }

  function renderSettings() {
    const p = state.profile;
    $('#welcome').classList.toggle('hidden', !!p);
    formUnits = p ? p.units : 'kg';
    $('#pSex').value = p ? p.sex : 'male';
    $('#pAge').value = p ? p.age : '';
    const h = p ? p.heightCm : null;
    $('#pHeightCm').value = h ? Math.round(h * 2) / 2 : '';
    if (h) { const ti = h / 2.54; $('#pHeightFt').value = Math.floor(ti / 12); $('#pHeightIn').value = Math.round((ti % 12) * 2) / 2; }
    else { $('#pHeightFt').value = ''; $('#pHeightIn').value = ''; }
    const lastW = sortedWeights().pop();
    const toForm = (kg) => (formUnits === 'lb' ? kg / KG_PER_LB : kg).toFixed(1);
    $('#pWeight').value = lastW ? toForm(lastW[1]) : '';
    $('#pGoalWeight').value = p && p.goalWeightKg ? toForm(p.goalWeightKg) : '';
    $('#pActivity').value = String(p ? p.activity : 1.375);
    fillGoalSelect(p ? p.goalRate : -0.5);
    $('#pManual').value = p && p.manualTarget ? p.manualTarget : '';
    applyUnitVisibility();
    renderCalcBox();
    renderBackup();
    renderInstall();
  }

  function renderCalcBox() {
    const T = calcTargets(today());
    if (!T) { $('#calcBox').innerHTML = '<div class="muted small">Save your profile to see your numbers.</div>'; return; }
    let html = stat('BMR', `${fmtK(T.bmr)} kcal`, 'burned at complete rest');
    html += stat('Maintenance', `${fmtK(T.tdee)} kcal`, 'to keep your weight');
    html += stat('Daily target', `${fmtK(T.kcal)} kcal`,
      T.manual ? 'custom target' : T.floored ? 'raised to safe minimum' : rateLabel(state.profile.goalRate), 'good');
    html += stat('Protein goal', `${T.protein} g`, '1.6 g per kg body weight');
    html += stat('Carbs / Fat', `${T.carbs} / ${T.fat} g`, 'rest of calories');
    $('#calcBox').innerHTML = html;
  }

  function saveProfile(e) {
    e.preventDefault();
    const age = num($('#pAge').value);
    let heightCm;
    if (formUnits === 'lb') {
      const ft = num($('#pHeightFt').value) || 0, inch = num($('#pHeightIn').value) || 0;
      heightCm = (ft * 12 + inch) * 2.54;
    } else heightCm = num($('#pHeightCm').value);
    const toKg = (v) => (v == null ? null : formUnits === 'lb' ? v * KG_PER_LB : v);
    const wKg = toKg(num($('#pWeight').value));
    const goalKg = toKg(num($('#pGoalWeight').value));
    const manual = num($('#pManual').value);

    if (!age || age < 13 || age > 100) return toast('Enter an age between 13 and 100');
    if (!heightCm || heightCm < 100 || heightCm > 250) return toast('Enter a valid height');
    if (!sortedWeights().length && !wKg) return toast('Enter your current weight');
    if (wKg != null && (wKg < 20 || wKg > 320)) return toast('Enter a valid weight');
    if (manual != null && (manual < 800 || manual > 6000)) return toast('Custom target must be 800–6000 kcal');

    state.profile = {
      units: formUnits,
      sex: $('#pSex').value,
      age: Math.round(age),
      heightCm: Math.round(heightCm * 10) / 10,
      activity: parseFloat($('#pActivity').value),
      goalRate: parseFloat($('#pGoal').value),
      goalWeightKg: goalKg ? Math.round(goalKg * 100) / 100 : null,
      manualTarget: manual ? Math.round(manual) : null
    };
    // record weight for today if it changed from latest
    const last = sortedWeights().pop();
    if (wKg && (!last || Math.abs(last[1] - wKg) > 0.04)) state.weights[today()] = Math.round(wKg * 100) / 100;
    save();
    renderSettings();
    toast('Profile saved');
  }

  // =====================================================================
  // BACKUP: keep a copy of the data in a real file on the device,
  // so it survives deleting and reinstalling the app.
  // =====================================================================
  const META_KEY = 'mealtracker.meta';
  let meta = {};
  try { meta = JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { meta = {}; }
  const saveMeta = () => { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ } };

  // Automatic backup needs the File System Access API (Chrome / Edge, incl. recent Chrome on Android)
  const FS_OK = 'showSaveFilePicker' in window && 'indexedDB' in window;
  const FILE_TYPES = [{ description: 'Meal Tracker backup', accept: { 'application/json': ['.json'] } }];
  let backupHandle = null; // FileSystemFileHandle of the backup file
  let backupOk = false;    // do we currently have permission to write to it?
  let backupTimer = null;

  // tiny key-value store in IndexedDB (file handles can't go in localStorage)
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mealtracker', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function kvSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      if (v === undefined) tx.objectStore('kv').delete(k); else tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  let persistAsked = false;
  function requestPersist() {
    // ask the browser not to evict our storage when the device runs low on space
    if (persistAsked || !hasData() || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  async function initBackup() {
    if (FS_OK) {
      try {
        backupHandle = (await kvGet('backupHandle')) || null;
        if (backupHandle) backupOk = (await backupHandle.queryPermission({ mode: 'readwrite' })) === 'granted';
      } catch (e) { backupHandle = null; backupOk = false; }
    }
    renderBackup();
    renderBackupNudge();
    if (backupOk) scheduleBackup();
  }

  function scheduleBackup() {
    if (!backupHandle || !backupOk) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(writeBackup, 1200);
  }

  async function writeBackup() {
    clearTimeout(backupTimer);
    // never overwrite a backup file with an empty app
    if (!backupHandle || !backupOk || !hasData()) return false;
    try {
      const w = await backupHandle.createWritable();
      await w.write(JSON.stringify(state));
      await w.close();
      meta.lastBackup = Date.now();
      meta.fileName = backupHandle.name;
      saveMeta();
      renderBackup();
      return true;
    } catch (e) {
      backupOk = false;
      renderBackup();
      renderBackupNudge();
      return false;
    }
  }

  async function enableAutoBackup() {
    if (!hasData()) return toast('Nothing to back up yet. To bring old data back, use Restore');
    try {
      const h = await window.showSaveFilePicker({ suggestedName: 'mealtracker-backup.json', types: FILE_TYPES });
      backupHandle = h; backupOk = true;
      await kvSet('backupHandle', h);
      if (await writeBackup()) toast('Automatic backup is on');
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Could not create the backup file');
    }
    renderBackup(); renderBackupNudge();
  }

  async function reconnectBackup() {
    try {
      backupOk = (await backupHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
      if (backupOk && (await writeBackup())) toast('Backup file reconnected');
    } catch (e) { backupOk = false; }
    renderBackup(); renderBackupNudge();
  }

  function applyBackupText(text) {
    let s;
    try {
      s = JSON.parse(text);
      if (!s || typeof s !== 'object' || typeof s.weights !== 'object' || typeof s.days !== 'object') throw new Error('bad');
    } catch (e) { toast('That file is not a Meal Tracker backup'); return false; }
    if (hasData() && !confirm('Replace everything in the app with the data from this backup?')) return false;
    state = Object.assign(defaultState(), s);
    curDate = today();
    save();
    showTab(state.profile ? 'food' : 'settings');
    const days = Object.keys(state.days).length, ws = Object.keys(state.weights).length;
    toast(`Restored ${ws} weigh-ins and ${days} days of meals`);
    return true;
  }

  async function restoreFlow() {
    if (!('showOpenFilePicker' in window)) { $('#importFile').click(); return; }
    let h;
    try { [h] = await window.showOpenFilePicker({ types: FILE_TYPES }); }
    catch (e) { if (!e || e.name !== 'AbortError') $('#importFile').click(); return; }
    let ok = false;
    try { ok = applyBackupText(await (await h.getFile()).text()); }
    catch (e) { toast('Could not read that file'); }
    if (!ok || !FS_OK) return;
    // keep backing up into the same file from now on
    try {
      if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') {
        backupHandle = h; backupOk = true;
        await kvSet('backupHandle', h);
        meta.lastBackup = Date.now(); meta.fileName = h.name; saveMeta();
      }
    } catch (e) { /* user can turn it on in Settings */ }
    renderBackup(); renderBackupNudge();
  }

  // Manual backup: share sheet on phones (Save to Files / Drive), plain download elsewhere
  async function exportData() {
    if (!hasData()) return toast('Nothing to back up yet');
    const name = `mealtracker-backup-${today()}.json`;
    const json = JSON.stringify(state, null, 2);
    const done = () => { meta.lastBackup = Date.now(); saveMeta(); renderBackup(); renderBackupNudge(); };
    try {
      const file = new File([json], name, { type: 'application/json' });
      if (isTouch() && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Meal Tracker backup' });
        done();
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user closed the share sheet
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    done();
    toast('Backup file saved to your downloads');
  }

  function agoText(ts) {
    const d = Math.floor((Date.now() - ts) / 86400000);
    if (d <= 0) {
      const sameDay = ymd(new Date(ts)) === today();
      return sameDay ? 'today at ' + new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'yesterday';
    }
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }

  function renderBackup() {
    const st = $('#backupStatus'), btn = $('#autoBackupBtn');
    if (!st) return;
    const last = meta.lastBackup ? `Last backup ${agoText(meta.lastBackup)}` : 'No backup yet';
    btn.classList.toggle('hidden', !FS_OK || (backupHandle && backupOk));
    $('#exportBtn').textContent = backupHandle && backupOk ? 'Save an extra copy now' : 'Save a backup file now';
    if (backupHandle && backupOk) {
      st.className = 'backup-status ok';
      st.textContent = `Automatic backup is on (${backupHandle.name}). ${last}.`;
    } else if (backupHandle) {
      st.className = 'backup-status warn';
      st.textContent = `Backup file "${backupHandle.name}" needs permission again.`;
      btn.textContent = 'Reconnect backup file';
    } else {
      st.className = 'backup-status' + (hasData() ? ' warn' : '');
      st.textContent = last + (FS_OK ? '. Automatic backup is off.' : '.');
      btn.textContent = 'Turn on automatic backup';
    }
  }

  function renderBackupNudge() {
    const el = $('#backupNudge');
    if (!el) return;
    let text = '';
    const daysOfData = Object.keys(state.days).length + Object.keys(state.weights).length;
    if (backupHandle && !backupOk) text = 'Automatic backup is paused. Reconnect the backup file.';
    else if (!(backupHandle && backupOk) && daysOfData >= 3) {
      if (!meta.lastBackup) text = 'Your data is only inside this app. Save a backup file so you never lose it.';
      else if (Date.now() - meta.lastBackup > 7 * 86400000) text = `Last backup was ${agoText(meta.lastBackup)}. Save a fresh one.`;
    }
    $('#backupNudgeText').textContent = text;
    el.classList.toggle('hidden', !text || !state.profile);
  }

  // =====================================================================
  // INSTALL + PLATFORM
  // =====================================================================
  let installEvt = null;
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function renderInstall() {
    const card = $('#installCard');
    if (!card) return;
    const btn = $('#installBtn'), txt = $('#installText');
    if (isStandalone()) { card.classList.add('hidden'); return; }
    if (installEvt) {
      txt.textContent = 'Add Meal Tracker to your home screen. It opens full screen and works offline.';
      btn.classList.remove('hidden');
      card.classList.remove('hidden');
    } else if (isIos()) {
      txt.textContent = 'In Safari, tap the Share button, then "Add to Home Screen". The app then opens full screen and works offline.';
      btn.classList.add('hidden');
      card.classList.remove('hidden');
    } else if (isTouch()) {
      txt.textContent = 'Open your browser menu and choose "Add to Home screen" or "Install app".';
      btn.classList.add('hidden');
      card.classList.remove('hidden');
    } else card.classList.add('hidden');
  }

  function initPlatform() {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; renderInstall(); });
    window.addEventListener('appinstalled', () => { installEvt = null; renderInstall(); });

    // offline support (service workers need https or localhost)
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // keep full-screen sheets above the on-screen keyboard
    if (window.visualViewport) {
      const setVvh = () => document.documentElement.style.setProperty('--vvh', window.visualViewport.height + 'px');
      window.visualViewport.addEventListener('resize', setVvh);
      setVvh();
    }

    // write the backup right away when the app goes to the background
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && backupTimer) writeBackup();
      if (document.visibilityState === 'visible') renderBackupNudge();
    });
  }

  // =====================================================================
  // Events
  // =====================================================================
  function bind() {
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) showTab(g.dataset.goto);
      const c = e.target.closest('[data-close]');
      if (c) c.closest('dialog').close();
    });

    // date nav
    $('#prevDay').addEventListener('click', () => setDate(addDays(curDate, -1)));
    $('#nextDay').addEventListener('click', () => setDate(addDays(curDate, 1)));
    $('#todayBtn').addEventListener('click', () => setDate(today()));
    $('#datePick').addEventListener('change', (e) => e.target.value && setDate(e.target.value));

    // quick weight
    $('#qwForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (saveWeight(curDate, $('#qwInput').value)) { renderFood(); toast('Weight saved'); }
    });

    // meals
    $('#meals').addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) return openAdd(add.dataset.add);
      const del = e.target.closest('[data-del]');
      if (del) {
        state.days[curDate] = dayItems(curDate).filter((i) => i.id !== del.dataset.del);
        if (!state.days[curDate].length) delete state.days[curDate];
        save(); renderFood(); toast('Removed');
        return;
      }
      const ed = e.target.closest('[data-edit]');
      if (ed) openEdit(ed.dataset.edit);
    });

    $('#copyPrev').addEventListener('click', () => {
      // find the most recent earlier day with food (up to 14 days back)
      let src = null;
      for (let i = 1; i <= 14; i++) { const d = addDays(curDate, -i); if (dayItems(d).length) { src = d; break; } }
      if (!src) return toast('No meals found in the previous 2 weeks');
      const copies = dayItems(src).map((i) => Object.assign({}, i, { id: uid() }));
      state.days[curDate] = dayItems(curDate).concat(copies);
      save(); renderFood();
      toast(`Copied ${copies.length} item${copies.length > 1 ? 's' : ''} from ${fmtDate(src)}`);
    });

    $('#guideBtn').addEventListener('click', () => $('#guideDlg').showModal());

    // add dialog
    $$('#addModes button').forEach((b) => b.addEventListener('click', () => {
      setMode(b.dataset.mode);
      const first = $('#mode-' + b.dataset.mode + ' input');
      if (first && !isTouch()) first.focus();
    }));
    $('#foodSearch').addEventListener('input', () => { closePortion(); renderResults(); });
    $('#foodSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = $('#foodResults .res'); if (first) { e.preventDefault(); first.click(); } }
    });
    $('#catChips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      curCat = b.dataset.cat;
      renderChips(); closePortion(); renderResults();
    });
    $('#foodResults').addEventListener('click', (e) => {
      const b = e.target.closest('.res');
      if (!b) return;
      const food = allFoods().find((f) => foodKey(f) === b.dataset.key);
      if (!food) return;
      $$('.res.sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      openPortion(food, 1);
      if (isTouch()) $('#foodSearch').blur(); else setTimeout(() => { $('#pQty').select(); }, 0);
    });
    $('#pCancel').addEventListener('click', closePortion);
    $$('.stepper button').forEach((b) => b.addEventListener('click', () => {
      const q = Math.max(0.25, Math.round(((getQty() || 0) + parseFloat(b.dataset.step)) * 4) / 4);
      $('#pQty').value = q; updatePortion();
    }));
    $$('.qchips button').forEach((b) => b.addEventListener('click', () => { $('#pQty').value = b.dataset.set; updatePortion(); }));
    $('#pQty').addEventListener('input', updatePortion);
    $('#pQty').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitPortion(); } });
    $('#pAdd').addEventListener('click', commitPortion);

    $('#mode-quick').addEventListener('submit', (e) => {
      e.preventDefault();
      const food = { n: $('#qName').value.trim() || 'Quick add', u: 'serving', k: num($('#qKcal').value) || 0, p: num($('#qP').value) || 0, c: num($('#qC').value) || 0, f: num($('#qF').value) || 0 };
      addEntry(food, 1, $('#addMeal').value);
      toast(`Added ${food.n} (${fmtK(food.k)} kcal)`);
      e.target.reset();
      $('#qName').focus();
    });

    $('#mode-custom').addEventListener('submit', (e) => {
      e.preventDefault();
      const food = { n: $('#cName').value.trim(), u: $('#cUnit').value.trim(), k: num($('#cKcal').value) || 0, p: num($('#cP').value) || 0, c: num($('#cC').value) || 0, f: num($('#cF').value) || 0 };
      if (!food.n || !food.u) return;
      state.customFoods = state.customFoods.filter((x) => foodKey(x) !== foodKey(food)).concat([food]);
      bumpRecent(food);
      addEntry(food, 1, $('#addMeal').value);
      toast(`Saved "${food.n}" to My foods and added it`);
      e.target.reset();
      renderChips();
      setMode('search');
      renderResults();
    });

    // weight tab
    $('#wForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const d = $('#wDate').value;
      if (!d || d > today()) return toast('Pick a valid date');
      if (saveWeight(d, $('#wVal').value)) { $('#wVal').value = ''; renderWeight(); toast('Weight saved'); }
    });
    $('#wList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-wdel]');
      if (!b) return;
      if (!confirm(`Delete the weight for ${fmtDate(b.dataset.wdel)}?`)) return;
      delete state.weights[b.dataset.wdel];
      save(); renderWeight();
    });
    $('#wRange').addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      wRange = +b.dataset.r;
      $$('#wRange button').forEach((x) => x.classList.toggle('active', x === b));
      renderWeight();
    });

    // history
    $('#hRange').addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      hRange = +b.dataset.r;
      $$('#hRange button').forEach((x) => x.classList.toggle('active', x === b));
      renderHistory();
    });

    // settings
    $$('#unitSeg button').forEach((b) => b.addEventListener('click', () => setFormUnits(b.dataset.u)));
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#exportBtn').addEventListener('click', exportData);
    $('#autoBackupBtn').addEventListener('click', () => (backupHandle && !backupOk ? reconnectBackup() : enableAutoBackup()));
    $$('[data-restore]').forEach((b) => b.addEventListener('click', restoreFlow));
    $('#importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) applyBackupText(await file.text());
    });
    $('#installBtn').addEventListener('click', async () => {
      if (!installEvt) return;
      installEvt.prompt();
      await installEvt.userChoice;
      installEvt = null;
      renderInstall();
    });
    $('#resetBtn').addEventListener('click', () => {
      if (!confirm('Permanently delete ALL your meals, weights and settings? This cannot be undone.\n\nTip: export a backup first.')) return;
      // disconnect the backup file first so the wipe never overwrites it
      backupHandle = null; backupOk = false; kvSet('backupHandle', undefined).catch(() => {});
      meta = {}; saveMeta();
      state = defaultState(); save(); curDate = today(); showTab('settings'); toast('All data deleted');
    });

    // re-theme charts when OS light/dark changes
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderTab());
    }
    // roll over to the new day if the app is left open past midnight
    let lastToday = today();
    setInterval(() => {
      const t = today();
      if (t !== lastToday) { if (curDate === lastToday) curDate = t; lastToday = t; renderTab(); }
    }, 60000);
  }

  // =====================================================================
  // Init
  // =====================================================================
  fillSelects();
  bind();
  showTab(state.profile ? 'food' : 'settings');
  initBackup();
  initPlatform();
})();
