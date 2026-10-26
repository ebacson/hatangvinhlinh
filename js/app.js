import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getDatabase,
  ref,
  onValue,
  update,
  set,
  remove,
  get,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import {
  BASE,
  APP_VERSION,
  ROOT_EMAIL,
  firebaseConfig,
  ALERT_TABS,
  LONG_RUN_MS,
  LOW_FUEL_PERCENT,
} from './config.js?v=24';
import {
  stationForecast,
  forecastFuelPercentDuringActiveAlert,
  formatMinutes,
  formatDuration,
  formatMillis,
  formatPercent,
} from './forecast.js?v=24';
import {
  extractMayNoRuns,
  computeStats,
  formatPeriodLabel,
  fuelTypeLabel,
  formatLiters,
} from './stats.js?v=24';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const stationsRef = ref(db, 'stations');

const state = {
  user: null,
  displayName: '',
  tab: 'stations',
  stations: [],
  query: '',
  alertTab: 0,
  selectedKey: null,
  /** null | 'edit' | 'history' */
  sheetMode: null,
  tick: Date.now(),
  stationsBound: false,
  runHistory: [],
  runHistoryLoading: false,
  runHistoryKey: null,
  statsPeriodType: 'month',
  statsPeriodKey: '',
  statsStationKey: '',
  /** Map uid → { email, grantedAt, grantedBy } */
  admins: {},
  /** Map emailKey → { email, grantedAt, grantedBy } */
  pendingAdmins: {},
  rolesBound: false,
};

let unsubRunHistory = null;
let unsubRoles = null;
let cachedRunEvents = {};
const RUN_HISTORY_LIMIT = 40;

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function emailKey(email) {
  return normalizeEmail(email).replace(/[.#$[\]/]/g, '_');
}

function isRootUser(user = state.user) {
  return normalizeEmail(user?.email) === normalizeEmail(ROOT_EMAIL);
}

function canDismissAlerts() {
  if (!state.user) return false;
  if (isRootUser()) return true;
  return !!state.admins[state.user.uid];
}

function roleLabel() {
  if (isRootUser()) return 'root';
  if (state.admins[state.user?.uid]) return 'admin';
  return '';
}

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

function currentUserLabel() {
  return (
    state.displayName ||
    state.user?.displayName ||
    state.user?.email ||
    'Người dùng'
  );
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
      lastEditedBy: profile.lastEditedBy || null,
      lastEditedByUid: profile.lastEditedByUid || null,
      lastEditedAt: toNum(profile.lastEditedAt),
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
    runs: extractMayNoRuns(raw.events || {}),
  };
}

function generatorStations() {
  return state.stations.filter((s) => !!(s.deviceStatus && s.deviceStatus.MAY_NO_EAS));
}

function filteredStations() {
  const q = state.query.trim().toLowerCase();
  let list = generatorStations();
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
        alertAt: scAt || updatedAt,
        scEventTime: status.scEventTime || null,
        profile: s.profile,
        stats: s.stats,
        clearedBy: status.clearedBy || null,
        deviceType,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.maTram.localeCompare(b.maTram, 'vi'));
}

function editorLine(profile) {
  if (!profile.lastEditedBy && !profile.lastEditedAt) return null;
  const who = profile.lastEditedBy || '—';
  const when = profile.lastEditedAt ? formatMillis(profile.lastEditedAt) : '—';
  return `Cập nhật: ${who} · ${when}`;
}

/* ---------- Auth UI ---------- */

function showAuth(show) {
  $('#auth-screen').hidden = !show;
  $('#app-shell').hidden = show;
  document.body.classList.toggle('is-auth', show);
}

function setAuthLoading(loading) {
  const btn = $('#auth-submit');
  btn.disabled = loading;
  $('.auth-submit-spinner').hidden = !loading;
  $('.auth-submit-label').style.opacity = loading ? '0.85' : '1';
}

function showAuthError(msg) {
  const el = $('#auth-error');
  el.textContent = msg;
  el.hidden = !msg;
}

function authErrorMessage(code) {
  switch (code) {
    case 'auth/invalid-email':
      return 'Email không hợp lệ.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Email hoặc mật khẩu không đúng.';
    case 'auth/too-many-requests':
      return 'Thử quá nhiều lần. Vui lòng đợi rồi thử lại.';
    case 'auth/network-request-failed':
      return 'Lỗi mạng. Kiểm tra kết nối.';
    case 'auth/operation-not-allowed':
      return 'Chưa bật đăng nhập Email/Password trên Firebase Console.';
    case 'auth/user-disabled':
      return 'Tài khoản đã bị vô hiệu hóa.';
    default:
      return 'Không thể đăng nhập. Thử lại.';
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  showAuthError('');
  setAuthLoading(true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast('Đã đăng nhập');
  } catch (err) {
    showAuthError(authErrorMessage(err.code) || err.message || 'Không thể xác thực.');
  } finally {
    setAuthLoading(false);
  }
}

async function handleLogout() {
  await signOut(auth);
  state.stations = [];
  state.selectedKey = null;
  toast('Đã đăng xuất');
}

/* ---------- Render ---------- */

function render() {
  if (!state.user) {
    showAuth(true);
    return;
  }
  showAuth(false);
  $('#user-label').textContent = currentUserLabel();
  const roleEl = $('#user-role');
  if (roleEl) {
    const role = roleLabel();
    roleEl.hidden = !role;
    roleEl.textContent = role;
    roleEl.classList.toggle('is-root', role === 'root');
    roleEl.classList.toggle('is-admin', role === 'admin');
  }
  const ver = $('#app-version');
  if (ver) {
    ver.hidden = false;
    ver.textContent = `bản ${APP_VERSION}`;
  }
  $$('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== state.tab;
  });

  if (state.tab === 'stations') renderStations();
  if (state.tab === 'alerts') renderAlerts();
  if (state.tab === 'stats') renderStats();
  if (state.tab === 'settings') renderSettings();
  renderDetail();
}

function syncStatsFiltersUi(periodOptions) {
  const typeSel = $('#stats-period-type');
  const keySel = $('#stats-period-key');
  const keyWrap = $('#stats-period-wrap');
  const stSel = $('#stats-station');
  if (!typeSel || !keySel || !stSel) return;

  typeSel.value = state.statsPeriodType;
  const showKey = state.statsPeriodType !== 'all';
  keyWrap.hidden = !showKey;

  if (showKey) {
    const opts = periodOptions.length ? periodOptions : [];
    if (!state.statsPeriodKey || !opts.includes(state.statsPeriodKey)) {
      state.statsPeriodKey = opts[0] || '';
    }
    keySel.innerHTML = opts.length
      ? opts
          .map(
            (k) =>
              `<option value="${escapeAttr(k)}">${escapeHtml(
                formatPeriodLabel(k, state.statsPeriodType)
              )}</option>`
          )
          .join('')
      : `<option value="">—</option>`;
    keySel.value = state.statsPeriodKey;
  }

  const stations = generatorStations().sort((a, b) =>
    (a.profile.maTram || a.stationKey).localeCompare(b.profile.maTram || b.stationKey, 'vi')
  );
  const prev = state.statsStationKey;
  stSel.innerHTML =
    `<option value="">Tất cả trạm</option>` +
    stations
      .map((s) => {
        const label = s.profile.maTram || s.stationKey;
        const gen = (s.profile.generatorName || '').trim();
        const text = gen ? `${label} · ${gen}` : label;
        return `<option value="${escapeAttr(s.stationKey)}">${escapeHtml(text)}</option>`;
      })
      .join('');
  stSel.value = stations.some((s) => s.stationKey === prev) ? prev : '';
  if (stSel.value !== prev) state.statsStationKey = stSel.value;
}

function renderStats() {
  const root = $('#stats-root');
  if (!root) return;

  const stations = generatorStations().map((s) => ({
    ...s,
    _forecastPercent: stationForecast(s),
  }));

  // Prefill period options before compute (need all runs)
  const preview = computeStats(stations, {
    periodType: state.statsPeriodType,
    periodKey: state.statsPeriodKey,
    stationKey: '',
  });
  syncStatsFiltersUi(preview.periodOptions);

  const data = computeStats(stations, {
    periodType: state.statsPeriodType,
    periodKey: state.statsPeriodType === 'all' ? '' : state.statsPeriodKey,
    stationKey: state.statsStationKey,
  });

  const periodText =
    state.statsPeriodType === 'all'
      ? 'Tất cả thời gian'
      : formatPeriodLabel(data.periodKey, data.periodType);

  const fuelTypes = [
    ['gasoline', 'Xăng'],
    ['diesel', 'Dầu'],
    ['unknown', 'Chưa chọn loại'],
  ];

  root.innerHTML = `
    <div class="stats-summary">
      <article class="stats-kpi">
        <span class="stats-kpi-l">Thời gian chạy</span>
        <strong class="stats-kpi-v">${escapeHtml(formatMinutes(data.totalMinutes))}</strong>
        <span class="stats-kpi-h">${escapeHtml(periodText)}</span>
      </article>
      <article class="stats-kpi">
        <span class="stats-kpi-l">Số lần chạy</span>
        <strong class="stats-kpi-v">${data.runCount}</strong>
        <span class="stats-kpi-h">${data.stationCount} trạm</span>
      </article>
      <article class="stats-kpi">
        <span class="stats-kpi-l">NL tiêu thụ (ước tính)</span>
        <strong class="stats-kpi-v">${escapeHtml(formatLiters(data.totalFuelUsed))}</strong>
        <span class="stats-kpi-h">theo định mức trạm</span>
      </article>
    </div>

    <section class="stats-card">
      <h3 class="stats-card-title">Thời gian chạy theo trạm</h3>
      ${
        data.byStation.length
          ? `<div class="stats-table-wrap"><table class="stats-table">
        <thead><tr><th>Trạm</th><th>Máy</th><th>Lần</th><th>Thời gian</th><th>NL dùng</th></tr></thead>
        <tbody>
          ${data.byStation
            .map(
              (r) => `<tr>
              <td><strong>${escapeHtml(r.maTram)}</strong><div class="muted tiny">${escapeHtml(
                r.tenTram || ''
              )}</div></td>
              <td>${escapeHtml(r.generatorName || '—')}</td>
              <td>${r.runs}</td>
              <td>${escapeHtml(formatMinutes(r.minutes))}</td>
              <td>${escapeHtml(r.fuelKnown ? formatLiters(r.fuelUsed) : '--')}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table></div>`
          : `<p class="muted stats-empty">Không có lần chạy trong kỳ này.</p>`
      }
    </section>

    <section class="stats-card">
      <h3 class="stats-card-title">Nhiên liệu theo loại</h3>
      <div class="stats-fuel-grid">
        ${fuelTypes
          .map(([key, label]) => {
            const b = data.fuelByType[key];
            if (!b.stations && key === 'unknown') return '';
            return `<article class="stats-fuel-tile">
              <h4>${escapeHtml(label)}</h4>
              <p><span>Tiêu thụ kỳ</span><strong>${escapeHtml(
                b.consumedKnown ? formatLiters(b.consumedL) : '--'
              )}</strong></p>
              <p><span>Còn lại (hiện tại)</span><strong>${escapeHtml(
                b.remainingKnown ? formatLiters(b.remainingL) : '--'
              )}</strong></p>
              <p class="muted tiny">${b.stations} trạm</p>
            </article>`;
          })
          .join('')}
      </div>
      <p class="muted tiny stats-note">Còn lại = dự báo % × dung tích bình. Tiêu thụ = giờ chạy KP × định mức lít/giờ.</p>
    </section>

    <section class="stats-card">
      <h3 class="stats-card-title">Lịch sử chạy máy</h3>
      ${
        data.history.length
          ? `<div class="stats-history">
          ${data.history
            .map(
              (r) => `<article class="stats-hist-row">
              <div class="stats-hist-top">
                <strong>${escapeHtml(r.maTram)}</strong>
                <span>${escapeHtml(formatMinutes(r.minutes))}</span>
              </div>
              <div class="muted tiny">${escapeHtml(r.start)} → ${escapeHtml(r.end)}</div>
              <div class="muted tiny">${escapeHtml(r.generatorName || 'Máy chưa đặt tên')} · ${escapeHtml(
                fuelTypeLabel(r.fuelType)
              )}</div>
            </article>`
            )
            .join('')}
        </div>`
          : `<p class="muted stats-empty">Chưa có lịch sử KP máy nổ trong kỳ.</p>`
      }
    </section>
  `;
}

function fuelLevelClass(predicted) {
  if (predicted == null) return 'fuel-unknown';
  if (predicted < 10) return 'fuel-critical';
  if (predicted < 30) return 'fuel-low';
  if (predicted < 60) return 'fuel-mid';
  return 'fuel-ok';
}

function renderStationsSummary(list) {
  const el = $('#stations-summary');
  if (!el) return;
  if (!list.length && !state.query.trim()) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const sc = list.filter((s) => s.mayNoLastAlertType === 'SC').length;
  const low = list.filter((s) => {
    const p = stationForecast(s);
    return p != null && p < 30;
  }).length;
  el.hidden = false;
  el.innerHTML = `
    <div class="stat-pill"><span class="stat-n">${list.length}</span><span class="stat-l">trạm</span></div>
    <div class="stat-pill ${sc ? 'is-warn' : ''}"><span class="stat-n">${sc}</span><span class="stat-l">đang SC</span></div>
    <div class="stat-pill ${low ? 'is-fuel' : ''}"><span class="stat-n">${low}</span><span class="stat-l">NL thấp</span></div>
  `;
}

function renderStations() {
  const list = filteredStations();
  const root = $('#stations-list');
  const empty = $('#stations-empty');
  renderStationsSummary(list);

  if (!list.length) {
    root.innerHTML = '';
    empty.hidden = false;
    if (state.query.trim()) {
      empty.innerHTML = `
        <p class="empty-title">Không tìm thấy trạm</p>
        <p class="empty-desc">Thử mã hoặc tên khác.</p>`;
    } else {
      empty.innerHTML = `<p class="empty-title">Đang tải...</p>`;
    }
    return;
  }
  empty.hidden = true;
  root.innerHTML = list
    .map((s, index) => {
      const code = s.profile.maTram || s.stationKey;
      const name = s.profile.tenTram || 'Chưa có tên site';
      const generator = (s.profile.generatorName || '').trim();
      const addr = s.profile.diaChi || 'Chưa có địa chỉ';
      const predicted = stationForecast(s);
      const fuelClass = fuelLevelClass(predicted);
      const fuelLabel = predicted == null ? '--' : formatPercent(predicted);
      const since = formatMinutes(s.stats.runMinutesSinceRefuel);
      const total = formatMinutes(s.stats.totalRunMinutes);
      const lastMin = s.stats.lastRunMinutes;
      const last =
        lastMin == null
          ? '--'
          : `${formatMinutes(lastMin)}${s.stats.lastKpAt ? ` · ${formatMillis(s.stats.lastKpAt)}` : ''}`;
      const genLabel = generator || 'chưa đặt tên';
      const active = s.mayNoLastAlertType === 'SC';
      return `<article class="station-card ${fuelClass}${active ? ' is-sc' : ''}" data-key="${escapeAttr(
        s.stationKey
      )}" style="--i:${index}">
        <div class="station-accent" aria-hidden="true"></div>
        <div class="station-row-main">
          <div class="station-main">
            <div class="station-id">
              <span class="station-code">${escapeHtml(code)}</span>
              ${active ? '<span class="badge badge-sc">SC</span>' : ''}
            </div>
            <p class="station-name">${escapeHtml(name)}</p>
            <p class="station-meta-line">
              <span class="station-generator">Máy: <strong>${escapeHtml(genLabel)}</strong></span>
              <span class="dot-sep" aria-hidden="true">·</span>
              <span class="station-addr">${escapeHtml(addr)}</span>
            </p>
            <p class="station-stats-line">
              Đã chạy ${escapeHtml(since)}
              <span class="dot-sep" aria-hidden="true">·</span>
              Tổng ${escapeHtml(total)}
              <span class="dot-sep" aria-hidden="true">·</span>
              Gần nhất ${escapeHtml(last)}
            </p>
          </div>
          <div class="station-side">
            <div class="station-fuel ${fuelClass}" title="Dự báo nhiên liệu">
              <span class="fuel-value">${escapeHtml(fuelLabel)}</span>
            </div>
            <div class="station-actions">
              <button type="button" class="btn-outline station-action-btn" data-action="edit" data-key="${escapeAttr(
                s.stationKey
              )}">Sửa</button>
              <button type="button" class="btn station-action-btn" data-action="history" data-key="${escapeAttr(
                s.stationKey
              )}">Chi tiết</button>
            </div>
          </div>
        </div>
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
        ${
          canDismissAlerts()
            ? `<div class="row-actions">
          <button type="button" class="btn-text danger" data-dismiss="${escapeAttr(a.stationKey)}" data-device="${escapeAttr(
                cfg.id
              )}">Xóa</button>
        </div>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderSettings() {
  const emailEl = $('#settings-email');
  const nameEl = $('#settings-name');
  const roleEl = $('#settings-role');
  const noteEl = $('#settings-dismiss-note');
  const avatarEl = $('#settings-avatar');
  if (!emailEl) return;

  const name = currentUserLabel();
  const email = state.user?.email || '—';
  emailEl.textContent = email;
  nameEl.textContent = name;

  const role = roleLabel();
  const roleText = role === 'root' ? 'Root' : role === 'admin' ? 'Admin' : 'User';
  roleEl.textContent = roleText;
  roleEl.classList.toggle('is-root', role === 'root');
  roleEl.classList.toggle('is-admin', role === 'admin');
  roleEl.classList.toggle('is-user', !role);

  const canDismiss = canDismissAlerts();
  noteEl.textContent = canDismiss ? 'Được xóa cảnh báo' : 'Không được xóa cảnh báo';
  noteEl.classList.toggle('is-ok', canDismiss);
  noteEl.classList.toggle('is-no', !canDismiss);

  if (avatarEl) {
    const initial = (name || email || '?').trim().charAt(0).toUpperCase() || '?';
    avatarEl.textContent = initial;
    avatarEl.classList.toggle('is-root', role === 'root');
    avatarEl.classList.toggle('is-admin', role === 'admin');
  }

  renderAdminRoles();
}

function renderAdminRoles() {
  const box = $('#admin-roles');
  const list = $('#admin-list');
  if (!box || !list) return;
  const show = isRootUser();
  box.hidden = !show;
  if (!show) return;

  const adminRows = Object.entries(state.admins).map(([uid, info]) => ({
    kind: 'active',
    key: uid,
    email: info.email || uid,
    meta: info.grantedBy ? `bởi ${info.grantedBy}` : 'admin',
  }));
  const pendingRows = Object.entries(state.pendingAdmins).map(([key, info]) => ({
    kind: 'pending',
    key,
    email: info.email || key,
    meta: 'chờ đăng nhập lần đầu',
  }));
  const rows = [...adminRows, ...pendingRows].sort((a, b) =>
    a.email.localeCompare(b.email, 'vi')
  );

  if (!rows.length) {
    list.innerHTML = `<p class="muted tiny">Chưa cấp admin nào.</p>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (r) => `<div class="admin-row">
        <div>
          <strong>${escapeHtml(r.email)}</strong>
          <div class="muted tiny">${escapeHtml(r.meta)}</div>
        </div>
        <button type="button" class="btn-text danger" data-revoke-admin="${escapeAttr(r.key)}" data-revoke-kind="${escapeAttr(
          r.kind
        )}">Thu hồi</button>
      </div>`
    )
    .join('');
}

function parseDurationToken(token) {
  if (!token || typeof token !== 'string') return null;
  const m = token.trim().match(/^(\d+)\s*p$/i);
  return m ? Number(m[1]) : null;
}

function runDurationMinutes(ev) {
  const effective = toNum(ev.durationMinutesEffective);
  if (effective != null && effective >= 0) return effective;
  const fromRange = toNum(ev.durationMinutesFromRange);
  if (fromRange != null && fromRange >= 0) return fromRange;
  return parseDurationToken(ev.durationToken);
}

function buildRunHistory(eventsMap, station) {
  const rows = [];
  const events = Object.entries(eventsMap || {}).map(([id, ev]) => ({ id, ...(ev || {}) }));

  for (const ev of events) {
    const device = String(ev.deviceType || '');
    if (!device.toUpperCase().includes('MAY_NO')) continue;
    if (String(ev.type || '').toUpperCase() !== 'KP') continue;
    const minutes = runDurationMinutes(ev);
    const start = ev.kpStartTime || '--';
    const end = ev.kpEndTime || '--';
    const sortAt = toNum(ev.receivedAt) || 0;
    rows.push({
      id: ev.id,
      active: false,
      start,
      end,
      minutes,
      sortAt,
      label: 'Đã chạy',
    });
  }

  if (station?.mayNoLastAlertType === 'SC' && station.mayNoScAtMillis > 0) {
    const status = station.deviceStatus?.MAY_NO_EAS || {};
    const start = status.scEventTime || formatMillis(station.mayNoScAtMillis);
    const activeMin = Math.max(0, Math.floor((Date.now() - station.mayNoScAtMillis) / 60_000));
    rows.push({
      id: 'active-sc',
      active: true,
      start,
      end: 'đang chạy',
      minutes: activeMin,
      sortAt: station.mayNoScAtMillis,
      label: 'Đang chạy',
    });
  }

  rows.sort((a, b) => b.sortAt - a.sortAt);
  return rows.slice(0, RUN_HISTORY_LIMIT);
}

function renderRunHistory() {
  const el = $('#detail-run-history');
  if (!el) return;
  if (state.runHistoryLoading && state.runHistory.length === 0) {
    el.innerHTML = `<p class="muted run-history-empty">Đang tải...</p>`;
    return;
  }
  if (!state.runHistory.length) {
    el.innerHTML = `<p class="muted run-history-empty">Chưa có lần chạy nào được ghi.</p>`;
    return;
  }
  el.innerHTML = state.runHistory
    .map((r) => {
      const dur =
        r.minutes == null ? '--' : r.active ? `~${formatMinutes(r.minutes)}` : formatMinutes(r.minutes);
      const range = `${escapeHtml(r.start)} → ${escapeHtml(r.end)}`;
      return `<article class="run-row ${r.active ? 'is-active' : ''}">
        <div class="run-row-top">
          <div class="run-row-range">${range}</div>
          <div class="run-row-dur">${escapeHtml(dur)}</div>
        </div>
        <div class="run-row-meta">${escapeHtml(r.label)}</div>
      </article>`;
    })
    .join('');
}

function stopRunHistoryListener() {
  if (unsubRunHistory) {
    unsubRunHistory();
    unsubRunHistory = null;
  }
  cachedRunEvents = {};
  state.runHistory = [];
  state.runHistoryKey = null;
  state.runHistoryLoading = false;
}

function refreshRunHistoryFromCache(station) {
  if (!station || state.runHistoryKey !== station.stationKey) return;
  state.runHistory = buildRunHistory(cachedRunEvents, station);
  renderRunHistory();
}

function bindRunHistory(stationKey) {
  if (!stationKey) {
    stopRunHistoryListener();
    renderRunHistory();
    return;
  }
  if (state.runHistoryKey === stationKey && unsubRunHistory) {
    refreshRunHistoryFromCache(state.stations.find((x) => x.stationKey === stationKey));
    return;
  }
  stopRunHistoryListener();
  state.runHistoryKey = stationKey;
  state.runHistoryLoading = true;
  renderRunHistory();

  unsubRunHistory = onValue(ref(db, `stations/${stationKey}/events`), (snap) => {
    cachedRunEvents = snap.val() || {};
    state.runHistoryLoading = false;
    refreshRunHistoryFromCache(state.stations.find((x) => x.stationKey === stationKey));
  });
}

function openStationSheet(stationKey, mode) {
  state.selectedKey = stationKey;
  state.sheetMode = mode;
  const sheet = $('#detail-sheet');
  if (sheet) {
    sheet.dataset.bound = '';
    sheet.dataset.mode = mode;
  }
  if (mode !== 'history') stopRunHistoryListener();
  render();
}

function renderDetail() {
  const sheet = $('#detail-sheet');
  const backdrop = $('#sheet-backdrop');
  const editPanel = $('#detail-edit-panel');
  const historyPanel = $('#detail-history-panel');
  if (!state.selectedKey || !state.sheetMode) {
    sheet.hidden = true;
    backdrop.hidden = true;
    stopRunHistoryListener();
    return;
  }
  const s = state.stations.find((x) => x.stationKey === state.selectedKey);
  if (!s) {
    state.selectedKey = null;
    state.sheetMode = null;
    sheet.hidden = true;
    backdrop.hidden = true;
    stopRunHistoryListener();
    return;
  }
  const isEdit = state.sheetMode === 'edit';
  const isHistory = state.sheetMode === 'history';
  sheet.hidden = false;
  backdrop.hidden = false;
  editPanel.hidden = !isEdit;
  historyPanel.hidden = !isHistory;
  sheet.setAttribute('aria-label', isEdit ? 'Cập nhật trạm' : 'Chi tiết trạm');
  const badge = $('#detail-mode-badge');
  if (badge) {
    badge.textContent = isEdit ? 'Cập nhật' : 'Chi tiết';
    badge.classList.toggle('is-history', isHistory);
  }
  $('#detail-title').textContent = s.profile.maTram || s.stationKey;
  $('#detail-subtitle').textContent = s.profile.tenTram || '—';

  if (isEdit) {
    if (!sheet.dataset.bound || sheet.dataset.key !== s.stationKey || sheet.dataset.mode !== 'edit') {
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
      sheet.dataset.mode = 'edit';
      sheet.dataset.bound = '1';
    }
    const predicted = stationForecast(s);
    $('#detail-forecast').textContent =
      predicted == null ? 'Chưa đủ dữ liệu để dự báo' : formatPercent(predicted);
    $('#detail-since').textContent = formatMinutes(s.stats.runMinutesSinceRefuel);
    $('#detail-total').textContent = formatMinutes(s.stats.totalRunMinutes);
    $('#detail-editor').textContent = s.profile.lastEditedBy || '--';
    $('#detail-edited-at').textContent = s.profile.lastEditedAt
      ? formatMillis(s.profile.lastEditedAt)
      : '--';
  }

  if (isHistory) {
    $('#history-since').textContent = formatMinutes(s.stats.runMinutesSinceRefuel);
    $('#history-total').textContent = formatMinutes(s.stats.totalRunMinutes);
    if (state.runHistoryKey !== s.stationKey || !unsubRunHistory) {
      bindRunHistory(s.stationKey);
    } else {
      refreshRunHistoryFromCache(s);
    }
    sheet.dataset.key = s.stationKey;
    sheet.dataset.mode = 'history';
    sheet.dataset.bound = '1';
  }
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
  if (!state.user) return;
  if (!canDismissAlerts()) {
    toast('Chỉ root hoặc admin được xóa cảnh báo');
    return;
  }
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
  const who = currentUserLabel();
  const statusPath = `stations/${stationKey}/deviceStatus/${sanitizeKey(deviceType)}`;
  try {
    await update(ref(db, statusPath), {
      lastAlertType: 'CLEARED',
      lastEventAtMillis: now,
      clearedAt: serverTimestamp(),
      clearedManually: true,
      clearedBy: who,
      clearedByUid: state.user.uid,
      scAtMillis: null,
      scEventTime: null,
      updatedAt: serverTimestamp(),
    });
    await update(ref(db, `stations/${stationKey}/profile`), {
      lastAlertType: 'CLEARED',
      lastEditedBy: who,
      lastEditedByUid: state.user.uid,
      lastEditedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    toast('Đã xóa cảnh báo');
  } catch (e) {
    toast('Xóa thất bại: ' + (e.message || e));
  }
}

async function saveStation() {
  const key = state.selectedKey;
  if (!key || !state.user) return;
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
  const genChanged = genName !== sheet.dataset.initialGenerator;

  if (!rateChanged && !capChanged && !levelChanged && !fuelTypeChanged && !genChanged) {
    toast('Không có thay đổi');
    return;
  }

  const who = currentUserLabel();
  const updates = {
    generatorName: genName,
    updatedAt: serverTimestamp(),
    lastEditedBy: who,
    lastEditedByUid: state.user.uid,
    lastEditedAt: serverTimestamp(),
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
    state.sheetMode = null;
    render();
  } catch (e) {
    toast('Lưu thất bại: ' + (e.message || e));
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
  $('#toggle-password').addEventListener('click', () => {
    const input = $('#auth-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggle-password').textContent = show ? 'Ẩn' : 'Hiện';
    $('#toggle-password').setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  });
  $('#auth-form').addEventListener('submit', handleAuthSubmit);
  $('#logout-btn').addEventListener('click', handleLogout);

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

  $('#stats-period-type')?.addEventListener('change', (e) => {
    state.statsPeriodType = e.target.value;
    state.statsPeriodKey = '';
    renderStats();
  });
  $('#stats-period-key')?.addEventListener('change', (e) => {
    state.statsPeriodKey = e.target.value;
    renderStats();
  });
  $('#stats-station')?.addEventListener('change', (e) => {
    state.statsStationKey = e.target.value;
    renderStats();
  });

  $('#stations-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action][data-key]');
    if (!btn) return;
    e.preventDefault();
    const key = btn.dataset.key;
    const action = btn.dataset.action;
    if (action === 'edit') openStationSheet(key, 'edit');
    else if (action === 'history') openStationSheet(key, 'history');
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

  $('#admin-grant-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    grantAdmin($('#admin-email')?.value || '');
  });
  $('#admin-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-revoke-admin]');
    if (!btn) return;
    revokeAdmin(btn.dataset.revokeKind, btn.dataset.revokeAdmin);
  });

  $('#sheet-backdrop').addEventListener('click', closeDetail);
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-save').addEventListener('click', saveStation);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });
}

function closeDetail() {
  state.selectedKey = null;
  state.sheetMode = null;
  stopRunHistoryListener();
  render();
}

function bindStationsListener() {
  if (state.stationsBound) return;
  state.stationsBound = true;
  onValue(stationsRef, (snap) => {
    if (!state.user) return;
    const val = snap.val() || {};
    state.stations = Object.keys(val)
      .map((k) => parseStation(k, val[k] || {}))
      .sort((a, b) =>
        (a.profile.maTram || a.stationKey).localeCompare(b.profile.maTram || b.stationKey, 'vi')
      );
    render();
  });
}

async function upsertCurrentUserProfile(user) {
  const email = normalizeEmail(user.email);
  if (!email) return;
  try {
    await update(ref(db, `users/${user.uid}`), {
      email,
      displayName: user.displayName || state.displayName || '',
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (_) {
    /* ignore profile write failures */
  }

  // Promote pending admin → active by uid
  const key = emailKey(email);
  try {
    const pendingSnap = await get(ref(db, `roles/pendingAdmins/${key}`));
    if (pendingSnap.exists()) {
      const pending = pendingSnap.val() || {};
      await set(ref(db, `roles/admins/${user.uid}`), {
        email,
        grantedAt: pending.grantedAt || serverTimestamp(),
        grantedBy: pending.grantedBy || 'root',
        grantedByUid: pending.grantedByUid || null,
        activatedAt: serverTimestamp(),
      });
      await remove(ref(db, `roles/pendingAdmins/${key}`));
    }
  } catch (_) {
    /* ignore role promote failures */
  }
}

function bindRolesListener() {
  if (state.rolesBound) return;
  state.rolesBound = true;
  const rolesRef = ref(db, 'roles');
  unsubRoles = onValue(rolesRef, (snap) => {
    const val = snap.val() || {};
    state.admins = val.admins || {};
    state.pendingAdmins = val.pendingAdmins || {};
    render();
  });
}

function stopRolesListener() {
  if (unsubRoles) {
    unsubRoles();
    unsubRoles = null;
  }
  state.rolesBound = false;
  state.admins = {};
  state.pendingAdmins = {};
}

async function grantAdmin(emailRaw) {
  if (!isRootUser()) {
    toast('Chỉ root được cấp quyền admin');
    return;
  }
  const email = normalizeEmail(emailRaw);
  if (!email || !email.includes('@')) {
    toast('Email không hợp lệ');
    return;
  }
  if (email === normalizeEmail(ROOT_EMAIL)) {
    toast('Root đã có đủ quyền');
    return;
  }
  const who = currentUserLabel();
  const key = emailKey(email);

  // Prefer uid if user already logged in once
  let existingUid = null;
  try {
    const usersSnap = await get(ref(db, 'users'));
    const users = usersSnap.val() || {};
    for (const [uid, u] of Object.entries(users)) {
      if (normalizeEmail(u?.email) === email) {
        existingUid = uid;
        break;
      }
    }
  } catch (_) {
    /* continue with pending */
  }

  try {
    if (existingUid) {
      await set(ref(db, `roles/admins/${existingUid}`), {
        email,
        grantedAt: serverTimestamp(),
        grantedBy: who,
        grantedByUid: state.user.uid,
      });
      await remove(ref(db, `roles/pendingAdmins/${key}`));
      toast(`Đã cấp admin: ${email}`);
    } else {
      await set(ref(db, `roles/pendingAdmins/${key}`), {
        email,
        grantedAt: serverTimestamp(),
        grantedBy: who,
        grantedByUid: state.user.uid,
      });
      toast(`Đã cấp admin (chờ đăng nhập): ${email}`);
    }
    const input = $('#admin-email');
    if (input) input.value = '';
  } catch (e) {
    toast('Cấp quyền thất bại: ' + (e.message || e));
  }
}

async function revokeAdmin(kind, key) {
  if (!isRootUser()) {
    toast('Chỉ root được thu hồi admin');
    return;
  }
  if (!confirm('Thu hồi quyền admin của tài khoản này?')) return;
  try {
    if (kind === 'pending') {
      await remove(ref(db, `roles/pendingAdmins/${key}`));
    } else {
      await remove(ref(db, `roles/admins/${key}`));
    }
    toast('Đã thu hồi admin');
  } catch (e) {
    toast('Thu hồi thất bại: ' + (e.message || e));
  }
}

function startAuth() {
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    if (user) {
      state.displayName = user.displayName || '';
      if (!state.displayName) {
        onValue(
          ref(db, `users/${user.uid}/displayName`),
          (snap) => {
            if (snap.val()) state.displayName = snap.val();
            render();
          },
          { onlyOnce: true }
        );
      }
      await upsertCurrentUserProfile(user);
      bindRolesListener();
      bindStationsListener();
    } else {
      state.displayName = '';
      state.selectedKey = null;
      state.sheetMode = null;
      stopRunHistoryListener();
      stopRolesListener();
    }
    render();
  });
}

function showUpdateBanner(worker) {
  const banner = $('#update-banner');
  if (!banner) return;
  banner.hidden = false;
  const btn = $('#update-reload');
  btn.onclick = () => {
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(`${BASE}/sw.js`, { scope: `${BASE}/` })
    .then((reg) => {
      // Đã có bản waiting sẵn (mở lại app sau khi deploy)
      if (reg.waiting) showUpdateBanner(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(installing);
          }
        });
      });

      // Kiểm tra bản mới khi mở app / khi quay lại tab
      const check = () => reg.update().catch(() => {});
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, 5 * 60_000);
    })
    .catch(() => {});

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

bindEvents();
startAuth();
registerSW();
render();

setInterval(() => {
  state.tick = Date.now();
  if (!state.user) return;
  if (state.tab === 'alerts') renderAlerts();
  if (state.tab === 'stations' && state.stations.some((s) => s.mayNoLastAlertType === 'SC')) {
    renderStations();
  }
  if (state.selectedKey) renderDetail();
}, 60_000);
