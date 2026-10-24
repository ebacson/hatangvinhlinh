import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getDatabase,
  ref,
  onValue,
  update,
  set,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import { BASE, firebaseConfig, ALERT_TABS, LONG_RUN_MS, LOW_FUEL_PERCENT } from './config.js';
import {
  stationForecast,
  forecastFuelPercentDuringActiveAlert,
  formatMinutes,
  formatDuration,
  formatMillis,
  formatPercent,
} from './forecast.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const stationsRef = ref(db, 'stations');

const state = {
  tab: 'stations',
  stations: [],
  query: '',
  alertTab: 0,
  selectedKey: null,
  connected: null,
  tick: Date.now(),
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function sanitizeKey(raw) {
  return String(raw).replace(/[.#$[\]/]/g, '_');
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseStation(key, raw) {
  const profile = raw.profile || {};
  const stats = raw.stats || {};
  const mayNo = (raw.deviceStatus && raw.deviceStatus.MAY_NO_EAS) || {};
  return {
    stationKey: key,
    profile: {
      tenTram: profile.tenTram || null,
      maTram: profile.maTram || null,
      diaChi: profile.diaChi || null,
      generatorName: profile.generatorName || null,
      fuelType: profile.fuelType || null,
      fuelRateLitersPerHour: toNum(profile.fuelRateLitersPerHour),
      tankCapacityLiters: toNum(profile.tankCapacityLiters),
      lastFuelPercent: toNum(profile.lastFuelPercent),
      lastFuelTotalRunMinutes: toNum(profile.lastFuelTotalRunMinutes),
    },
    stats: {
      totalRunMinutes: toNum(stats.totalRunMinutes),
      totalRunHours: toNum(stats.totalRunHours),
      runMinutesSinceRefuel: toNum(stats.runMinutesSinceRefuel),
      lastRunMinutes: toNum(stats.lastRunMinutes),
      lastKpAt: toNum(stats.lastKpAt),
    },
    mayNoLastAlertType: mayNo.lastAlertType || null,
    mayNoScAtMillis: toNum(mayNo.scAtMillis),
    deviceStatus: raw.deviceStatus || {},
  };
}

function filteredStations() {
  const q = state.query.trim().toLowerCase();
  let list = state.stations;
  if (q) {
    list = list.filter((s) => {
      const code = (s.profile.maTram || s.stationKey).toLowerCase();
      const name = (s.profile.tenTram || '').toLowerCase();
      return code.includes(q) || name.includes(q);
    });
  }
  return [...list].sort((a, b) => {
    const pa = stationForecast(a) ?? Infinity;
    const pb = stationForecast(b) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return (a.profile.maTram || a.stationKey).localeCompare(b.profile.maTram || b.stationKey, 'vi');
  });
}

function activeAlerts(deviceType) {
  const key = sanitizeKey(deviceType);
  return state.stations
    .map((s) => {
      const status = s.deviceStatus[key] || s.deviceStatus[deviceType];
      if (!status || status.lastAlertType !== 'SC') return null;
      const scAt = toNum(status.scAtMillis);
      const updatedAt = toNum(status.updatedAt) || 0;
      return {
        stationKey: s.stationKey,
        maTram: s.profile.maTram || s.stationKey,
        tenTram: s.profile.tenTram || '',
        diaChi: s.profile.diaChi || '',
        alertAt: scAt || updatedAt,
        scEventTime: status.scEventTime || null,
        profile: s.profile,
        stats: s.stats,
        deviceType,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.maTram.localeCompare(b.maTram, 'vi'));
}

/* ---------- Render ---------- */

function render() {
  $$('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== state.tab;
  });

  if (state.tab === 'stations') renderStations();
  if (state.tab === 'alerts') renderAlerts();
  if (state.tab === 'monitor') renderMonitor();
  renderDetail();
}

function renderStations() {
  const list = filteredStations();
  const root = $('#stations-list');
  const empty = $('#stations-empty');
  if (!list.length) {
    root.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  root.innerHTML = list
    .map((s) => {
      const code = s.profile.maTram || s.stationKey;
      const name = s.profile.tenTram || '';
      const title = name ? `${escapeHtml(code)} · ${escapeHtml(name)}` : escapeHtml(code);
      const predicted = stationForecast(s);
      const forecast =
        predicted == null
          ? 'Chưa đủ dữ liệu để dự báo'
          : `Dự báo nhiên liệu: ${formatPercent(predicted)}`;
      const since = s.stats.runMinutesSinceRefuel;
      const total = s.stats.totalRunMinutes;
      const runParts = [];
      if (since != null) runParts.push(`Đã chạy: ${formatMinutes(since)}`);
      if (total != null) runParts.push(`Tổng: ${formatMinutes(total)}`);
      const runLine = runParts.length ? runParts.join(' · ') : 'Tổng: --';
      const last =
        s.stats.lastRunMinutes == null
          ? 'Lần chạy gần nhất: --'
          : `Lần chạy gần nhất: ${formatMinutes(s.stats.lastRunMinutes)}${
              s.stats.lastKpAt ? ` · ${formatMillis(s.stats.lastKpAt)}` : ''
            }`;
      const active = s.mayNoLastAlertType === 'SC' ? '<span class="badge badge-warn">Đang SC</span>' : '';
      return `<article class="card station-card" data-key="${escapeAttr(s.stationKey)}" role="button" tabindex="0">
        <div class="card-title-row"><h3>${title}</h3>${active}</div>
        <p class="muted">${escapeHtml(s.profile.diaChi || '')}</p>
        <p class="forecast">${escapeHtml(forecast)}</p>
        <p class="muted small">${escapeHtml(runLine)}</p>
        <p class="muted small">${escapeHtml(last)}</p>
      </article>`;
    })
    .join('');
}

function renderAlerts() {
  const tabs = $('#alert-tabs');
  tabs.innerHTML = ALERT_TABS.map(
    (t, i) =>
      `<button type="button" class="chip ${i === state.alertTab ? 'active' : ''}" data-alert-tab="${i}">${escapeHtml(
        t.title
      )}</button>`
  ).join('');

  const cfg = ALERT_TABS[state.alertTab];
  const alerts = activeAlerts(cfg.id);
  const root = $('#alerts-list');
  const empty = $('#alerts-empty');
  if (!alerts.length) {
    root.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  root.innerHTML = alerts
    .map((a) => {
      const runningMs = a.alertAt > 0 ? state.tick - a.alertAt : 0;
      const overLong = cfg.showFuel && runningMs > LONG_RUN_MS;
      const predicted = cfg.showFuel
        ? forecastFuelPercentDuringActiveAlert(a.profile, a.stats, a.alertAt)
        : null;
      const lowFuel = cfg.showFuel && predicted != null && predicted < LOW_FUEL_PERCENT;
      const warn = overLong || lowFuel;
      const when = (a.scEventTime && a.scEventTime.trim()) || formatMillis(a.alertAt);
      const ago = a.alertAt > 0 ? formatDuration(runningMs) : '--';
      const fuelLine =
        !cfg.showFuel
          ? ''
          : predicted == null
            ? `<p class="forecast">Chưa đủ dữ liệu để dự báo</p>`
            : `<p class="forecast ${warn ? 'danger' : ''}">Dự báo nhiên liệu còn lại: ${formatPercent(predicted)}</p>`;
      const warnBtn = warn
        ? `<button type="button" class="warn-dot" title="Cảnh báo" data-warn="${escapeAttr(
            JSON.stringify({ overLong, lowFuel })
          )}">!</button>`
        : '';
      return `<article class="card alert-card ${warn ? 'is-warn' : ''}">
        <div class="card-title-row">
          <h3>${escapeHtml(a.maTram)} · ${escapeHtml(a.tenTram)}</h3>
          ${warnBtn}
        </div>
        <p class="muted ${warn ? 'danger' : ''}">Lúc: ${escapeHtml(when)} · ${escapeHtml(ago)}</p>
        ${fuelLine}
        <div class="row-actions">
          <button type="button" class="btn-text danger" data-dismiss="${escapeAttr(a.stationKey)}" data-device="${escapeAttr(
            cfg.id
          )}">Xóa</button>
        </div>
      </article>`;
    })
    .join('');
}

function renderMonitor() {
  const status = $('#connection-status');
  const dot = $('#connection-dot');
  if (state.connected == null) {
    status.textContent = 'Đang kiểm tra…';
    dot.className = 'dot';
  } else if (state.connected) {
    status.textContent = 'Đã kết nối cloud';
    dot.className = 'dot online';
  } else {
    status.textContent = 'Chưa kết nối / mất kết nối';
    dot.className = 'dot offline';
  }
  $('#firebase-summary').textContent = `Database: ${firebaseConfig.databaseURL}`;
}

function renderDetail() {
  const sheet = $('#detail-sheet');
  const backdrop = $('#sheet-backdrop');
  if (!state.selectedKey) {
    sheet.hidden = true;
    backdrop.hidden = true;
    return;
  }
  const s = state.stations.find((x) => x.stationKey === state.selectedKey);
  if (!s) {
    state.selectedKey = null;
    sheet.hidden = true;
    backdrop.hidden = true;
    return;
  }
  sheet.hidden = false;
  backdrop.hidden = false;
  $('#detail-title').textContent = s.profile.maTram || s.stationKey;
  $('#detail-subtitle').textContent = s.profile.tenTram || '';
  if (!sheet.dataset.bound || sheet.dataset.key !== s.stationKey) {
    $('#f-generator').value = s.profile.generatorName || '';
    $('#f-fuel-type').value = s.profile.fuelType || '';
    $('#f-rate').value = s.profile.fuelRateLitersPerHour ?? '';
    $('#f-capacity').value = s.profile.tankCapacityLiters ?? '';
    $('#f-level').value = s.profile.lastFuelPercent ?? '';
    sheet.dataset.initialGenerator = $('#f-generator').value;
    sheet.dataset.initialFuelType = $('#f-fuel-type').value;
    sheet.dataset.initialRate = String($('#f-rate').value);
    sheet.dataset.initialCapacity = String($('#f-capacity').value);
    sheet.dataset.initialLevel = String($('#f-level').value);
    sheet.dataset.key = s.stationKey;
    sheet.dataset.bound = '1';
  }
  const predicted = stationForecast(s);
  $('#detail-forecast').textContent =
    predicted == null ? 'Chưa đủ dữ liệu để dự báo' : formatPercent(predicted);
  $('#detail-since').textContent = formatMinutes(s.stats.runMinutesSinceRefuel);
  $('#detail-total').textContent = formatMinutes(s.stats.totalRunMinutes);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/* ---------- Actions ---------- */

async function dismissAlert(stationKey, deviceType) {
  const label =
    state.stations.find((s) => s.stationKey === stationKey)?.profile.maTram || stationKey;
  if (
    !confirm(
      `Xóa cảnh báo của ${label} nếu sai hoặc kéo dài bất thường?\nKhông ảnh hưởng tổng giờ chạy đã ghi.`
    )
  ) {
    return;
  }
  const now = Date.now();
  const statusPath = `stations/${stationKey}/deviceStatus/${sanitizeKey(deviceType)}`;
  try {
    await update(ref(db, statusPath), {
      lastAlertType: 'CLEARED',
      lastEventAtMillis: now,
      clearedAt: serverTimestamp(),
      clearedManually: true,
      scAtMillis: null,
      scEventTime: null,
      updatedAt: serverTimestamp(),
    });
    await set(ref(db, `stations/${stationKey}/profile/lastAlertType`), 'CLEARED');
    toast('Đã xóa cảnh báo');
  } catch (e) {
    toast('Xóa thất bại: ' + (e.message || e));
  }
}

async function saveStation() {
  const key = state.selectedKey;
  if (!key) return;
  const sheet = $('#detail-sheet');
  const genName = $('#f-generator').value.trim();
  const fuelType = $('#f-fuel-type').value || null;
  const rateText = $('#f-rate').value.trim();
  const capText = $('#f-capacity').value.trim();
  const levelText = $('#f-level').value.trim();

  const rateChanged = rateText !== sheet.dataset.initialRate;
  const capChanged = capText !== sheet.dataset.initialCapacity;
  const levelChanged = levelText !== sheet.dataset.initialLevel;
  const fuelTypeChanged = (fuelType || '') !== sheet.dataset.initialFuelType;

  const updates = {
    generatorName: genName,
    updatedAt: serverTimestamp(),
  };
  if (fuelTypeChanged) updates.fuelType = fuelType || null;
  if (rateChanged) updates.fuelRateLitersPerHour = rateText === '' ? null : Number(rateText);
  if (capChanged) updates.tankCapacityLiters = capText === '' ? null : Number(capText);

  try {
    const totalSnap = await new Promise((resolve, reject) => {
      onValue(
        ref(db, `stations/${key}/stats/totalRunMinutes`),
        (snap) => resolve(snap.val()),
        reject,
        { onlyOnce: true }
      );
    });
    const totalRunMinutes = toNum(totalSnap) || 0;

    if (levelChanged) {
      if (levelText === '') {
        updates.lastFuelPercent = null;
        updates.lastFuelTotalRunMinutes = null;
        updates.lastFuelUpdatedAt = null;
      } else {
        const level = Math.min(100, Math.max(0, Number(levelText)));
        updates.lastFuelPercent = level;
        updates.lastFuelTotalRunMinutes = totalRunMinutes;
        updates.lastFuelUpdatedAt = serverTimestamp();
      }
    }

    await update(ref(db, `stations/${key}/profile`), updates);
    if (levelChanged && levelText !== '') {
      await set(ref(db, `stations/${key}/stats/runMinutesSinceRefuel`), 0);
    }
    sheet.dataset.bound = '';
    toast('Đã lưu');
    state.selectedKey = null;
    render();
  } catch (e) {
    toast('Lưu thất bại: ' + (e.message || e));
  }
}

async function ping() {
  const btn = $('#ping-btn');
  btn.disabled = true;
  try {
    await set(ref(db, 'connectionTest/lastPing'), serverTimestamp());
    toast('Đã ghi connectionTest/lastPing');
  } catch (e) {
    toast('Ghi thất bại: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

/* ---------- Wire up ---------- */

function bindEvents() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      render();
    });
  });

  $('#station-search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderStations();
  });

  $('#stations-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-key]');
    if (!card) return;
    state.selectedKey = card.dataset.key;
    $('#detail-sheet').dataset.bound = '';
    render();
  });

  $('#alert-tabs').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-alert-tab]');
    if (!chip) return;
    state.alertTab = Number(chip.dataset.alertTab);
    renderAlerts();
  });

  $('#alerts-list').addEventListener('click', (e) => {
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) {
      dismissAlert(dismiss.dataset.dismiss, dismiss.dataset.device);
      return;
    }
    const warn = e.target.closest('[data-warn]');
    if (warn) {
      const info = JSON.parse(warn.dataset.warn);
      const msgs = [];
      if (info.overLong) msgs.push('Máy hoạt động quá lâu hoặc cảnh báo sai. Cần kiểm tra.');
      if (info.lowFuel) msgs.push('Cần bổ sung nhiên liệu.');
      alert(msgs.join('\n\n'));
    }
  });

  $('#sheet-backdrop').addEventListener('click', closeDetail);
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-save').addEventListener('click', saveStation);
  $('#ping-btn').addEventListener('click', ping);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });
}

function closeDetail() {
  state.selectedKey = null;
  render();
}

function startListeners() {
  onValue(ref(db, '.info/connected'), (snap) => {
    state.connected = snap.val() === true;
    if (state.tab === 'monitor') renderMonitor();
  });

  onValue(stationsRef, (snap) => {
    const val = snap.val() || {};
    state.stations = Object.keys(val)
      .map((k) => parseStation(k, val[k] || {}))
      .sort((a, b) =>
        (a.profile.maTram || a.stationKey).localeCompare(b.profile.maTram || b.stationKey, 'vi')
      );
    render();
  });

  setInterval(() => {
    state.tick = Date.now();
    if (state.tab === 'alerts') renderAlerts();
    if (state.tab === 'stations' && state.stations.some((s) => s.mayNoLastAlertType === 'SC')) {
      renderStations();
    }
    if (state.selectedKey) renderDetail();
  }, 60_000);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = `${BASE}/sw.js`;
  navigator.serviceWorker.register(swUrl, { scope: `${BASE}/` }).catch(() => {});
}

bindEvents();
startListeners();
registerSW();
render();
