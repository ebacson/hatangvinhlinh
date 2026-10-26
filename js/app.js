import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
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
} from './config.js?v=32';
import {
  stationForecast,
  forecastFuelPercentDuringActiveAlert,
  formatMinutes,
  formatDuration,
  formatMillis,
  formatPercent,
} from './forecast.js?v=32';
import {
  extractMayNoRuns,
  computeStats,
  formatPeriodLabel,
  fuelTypeLabel,
  formatLiters,
} from './stats.js?v=32';
import { downloadExcelWorkbook, safeFilePart } from './exportExcel.js?v=32';

const app = initializeApp(firebaseConfig);
// Persist session (IndexedDB → localStorage) so PWA/standalone không mất đăng nhập mỗi lần mở.
let auth;
try {
  auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
} catch (_) {
  auth = getAuth(app);
}
const db = getDatabase(app);
const stationsRef = ref(db, 'stations');

const state = {
  user: null,
  /** false đến khi Firebase báo auth state lần đầu */
  authReady: false,
  /** 'login' | 'register' */
  authMode: 'login',
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
  /** Map uid → { email, blockedAt, blockedBy } */
  blocked: {},
  /** Map emailKey → { email, blockedAt, blockedBy } */
  pendingBlocked: {},
  rolesBound: false,
  /** true sau snapshot roles đầu tiên (để biết blocked trước khi hiện app) */
  rolesReady: false,
  /** Map uid → { email, displayName, ... } */
  directoryUsers: {},
  usersBound: false,
};

let unsubRoles = null;
let unsubUsers = null;

let unsubRunHistory = null;
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

/** Root hoặc admin: xóa cảnh báo, xem thống kê, xóa/sửa lịch sử chạy. */
function isPrivilegedUser() {
  if (!state.user) return false;
  if (isRootUser()) return true;
  return !!state.admins[state.user.uid];
}

function canDismissAlerts() {
  return isPrivilegedUser();
}

function canViewStats() {
  return isPrivilegedUser();
}

function canManageRunHistory() {
  return isPrivilegedUser();
}

function canManageUserBlocks() {
  return isPrivilegedUser();
}

function isBlockedUser(user = state.user) {
  if (!user) return false;
  if (isRootUser(user)) return false;
  if (state.blocked[user.uid]) return true;
  const key = emailKey(user.email);
  return !!(key && state.pendingBlocked[key]);
}

/** Admin/root được chặn user thường; root được chặn cả admin. Không chặn root / chính mình. */
function canBlockTarget(uid, email) {
  if (!canManageUserBlocks()) return false;
  const em = normalizeEmail(email);
  if (!em) return false;
  if (em === normalizeEmail(ROOT_EMAIL)) return false;
  if (uid && uid === state.user?.uid) return false;
  if (em === normalizeEmail(state.user?.email)) return false;
  if (!isRootUser() && uid && state.admins[uid]) return false;
  return true;
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

function showBoot(show) {
  const boot = $('#boot-screen');
  if (boot) boot.hidden = !show;
}

function showBlocked(show) {
  const el = $('#blocked-screen');
  if (el) el.hidden = !show;
  document.body.classList.toggle('is-blocked', show);
}

function showAuth(show) {
  showBoot(false);
  showBlocked(false);
  $('#auth-screen').hidden = !show;
  $('#app-shell').hidden = show;
  document.body.classList.toggle('is-auth', show);
}

function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const isReg = state.authMode === 'register';
  $$('.auth-tab').forEach((tab) => {
    const on = tab.dataset.authMode === state.authMode;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const heading = $('#auth-heading');
  const sub = $('#auth-subheading');
  if (heading) heading.textContent = isReg ? 'Tạo tài khoản' : 'Chào mừng trở lại';
  if (sub) {
    sub.textContent = isReg
      ? 'Đăng ký để theo dõi trạm và cảnh báo'
      : 'Đăng nhập để tiếp tục quản lý trạm';
  }
  const nameField = $('#auth-name-field');
  const confirmField = $('#auth-confirm-field');
  if (nameField) nameField.hidden = !isReg;
  if (confirmField) confirmField.hidden = !isReg;
  const confirmInput = $('#auth-password-confirm');
  if (confirmInput) confirmInput.required = isReg;
  const pw = $('#auth-password');
  if (pw) pw.autocomplete = isReg ? 'new-password' : 'current-password';
  const label = $('.auth-submit-label');
  if (label) label.textContent = isReg ? 'Đăng ký' : 'Đăng nhập';
  showAuthError('');
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
    case 'auth/email-already-in-use':
      return 'Email này đã được đăng ký. Hãy đăng nhập.';
    case 'auth/weak-password':
      return 'Mật khẩu cần ít nhất 6 ký tự.';
    case 'auth/too-many-requests':
      return 'Thử quá nhiều lần. Vui lòng đợi rồi thử lại.';
    case 'auth/network-request-failed':
      return 'Lỗi mạng. Kiểm tra kết nối.';
    case 'auth/operation-not-allowed':
      return 'Chưa bật đăng nhập Email/Password trên Firebase Console.';
    case 'auth/user-disabled':
      return 'Tài khoản đã bị vô hiệu hóa.';
    default:
      return state.authMode === 'register'
        ? 'Không thể đăng ký. Thử lại.'
        : 'Không thể đăng nhập. Thử lại.';
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const isReg = state.authMode === 'register';
  showAuthError('');
  if (isReg) {
    const confirm = $('#auth-password-confirm')?.value || '';
    if (password !== confirm) {
      showAuthError('Mật khẩu nhập lại không khớp.');
      return;
    }
  }
  setAuthLoading(true);
  try {
    if (isReg) {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const name = ($('#auth-display-name')?.value || '').trim();
      if (name) {
        try {
          await updateProfile(cred.user, { displayName: name });
          state.displayName = name;
        } catch (_) {
          /* ignore */
        }
      }
      toast('Đăng ký thành công');
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      toast('Đã đăng nhập');
    }
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
  state.directoryUsers = {};
  stopUsersListener();
  toast('Đã đăng xuất');
}

/* ---------- Render ---------- */

function render() {
  // Chưa biết session — không đẩy sang login (tránh mất trạng thái mỗi lần mở app).
  if (!state.authReady) {
    showBoot(true);
    showBlocked(false);
    $('#auth-screen').hidden = true;
    $('#app-shell').hidden = true;
    document.body.classList.remove('is-auth');
    return;
  }
  if (!state.user) {
    showAuth(true);
    return;
  }
  // Đợi roles (blocked/admins) trước khi mở shell — tránh flash dữ liệu với user bị chặn.
  if (!state.rolesReady) {
    showBoot(true);
    showBlocked(false);
    $('#auth-screen').hidden = true;
    $('#app-shell').hidden = true;
    document.body.classList.remove('is-auth');
    return;
  }
  if (isBlockedUser()) {
    showBoot(false);
    showBlocked(true);
    $('#auth-screen').hidden = true;
    $('#app-shell').hidden = true;
    document.body.classList.remove('is-auth');
    state.selectedKey = null;
    state.sheetMode = null;
    stopRunHistoryListener();
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
  if (state.tab === 'stats' && !canViewStats()) {
    state.tab = 'stations';
  }
  if (
    state.sheetMode === 'history' &&
    state.selectedKey &&
    !canManageRunHistory()
  ) {
    state.selectedKey = null;
    state.sheetMode = null;
    stopRunHistoryListener();
  }

  $$('.nav-btn').forEach((btn) => {
    const tab = btn.dataset.tab;
    if (tab === 'stats') {
      btn.hidden = !canViewStats();
    }
    btn.classList.toggle('active', tab === state.tab);
  });
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== state.tab;
  });

  if (state.tab === 'stations') renderStations();
  if (state.tab === 'alerts') renderAlerts();
  if (state.tab === 'stats' && canViewStats()) renderStats();
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

function buildStatsData() {
  const stations = generatorStations().map((s) => ({
    ...s,
    _forecastPercent: stationForecast(s),
  }));
  const preview = computeStats(stations, {
    periodType: state.statsPeriodType,
    periodKey: state.statsPeriodKey,
    stationKey: '',
  });
  syncStatsFiltersUi(preview.periodOptions);
  return computeStats(stations, {
    periodType: state.statsPeriodType,
    periodKey: state.statsPeriodType === 'all' ? '' : state.statsPeriodKey,
    stationKey: state.statsStationKey,
  });
}

function statsPeriodText(data) {
  return state.statsPeriodType === 'all'
    ? 'Tất cả thời gian'
    : formatPeriodLabel(data.periodKey, data.periodType);
}

function exportStatsExcel() {
  if (!canViewStats()) {
    toast('Chỉ admin hoặc root được xuất thống kê');
    return;
  }
  const data = buildStatsData();
  const periodText = statsPeriodText(data);
  const stationLabel = state.statsStationKey
    ? (() => {
        const s = state.stations.find((x) => x.stationKey === state.statsStationKey);
        return s?.profile?.maTram || state.statsStationKey;
      })()
    : 'Tat-ca-tram';

  const summaryRows = [
    ['Thống kê máy nổ'],
    ['Kỳ', periodText],
    ['Trạm', state.statsStationKey ? stationLabel : 'Tất cả trạm'],
    ['Xuất lúc', new Date().toLocaleString('vi-VN')],
    [],
    ['Chỉ số', 'Giá trị'],
    ['Thời gian chạy (phút)', data.totalMinutes],
    ['Thời gian chạy', formatMinutes(data.totalMinutes)],
    ['Số lần chạy', data.runCount],
    ['Số trạm trong phạm vi', data.stationCount],
    ['NL tiêu thụ ước tính (L)', data.totalFuelUsed != null ? Number(data.totalFuelUsed.toFixed(2)) : ''],
  ];

  const byStationRows = [
    ['Mã trạm', 'Tên trạm', 'Máy', 'Loại NL', 'Số lần', 'Phút chạy', 'Thời gian', 'NL dùng (L)'],
    ...data.byStation.map((r) => [
      r.maTram,
      r.tenTram || '',
      r.generatorName || '',
      fuelTypeLabel(r.fuelType),
      r.runs,
      r.minutes,
      formatMinutes(r.minutes),
      r.fuelKnown ? Number(r.fuelUsed.toFixed(2)) : '',
    ]),
  ];

  const fuelRows = [
    ['Loại nhiên liệu', 'Số trạm', 'Tiêu thụ kỳ (L)', 'Còn lại hiện tại (L)'],
    ...[
      ['gasoline', 'Xăng'],
      ['diesel', 'Dầu'],
      ['unknown', 'Chưa chọn loại'],
    ].map(([key, label]) => {
      const b = data.fuelByType[key];
      return [
        label,
        b.stations,
        b.consumedKnown ? Number(b.consumedL.toFixed(2)) : '',
        b.remainingKnown ? Number(b.remainingL.toFixed(2)) : '',
      ];
    }),
  ];

  const historyRows = [
    [
      'Mã trạm',
      'Tên trạm',
      'Máy',
      'Loại NL',
      'Bắt đầu',
      'Kết thúc',
      'Phút chạy',
      'Thời gian',
      'NL ước tính (L)',
    ],
    ...(data.runs || []).map((r) => {
      let fuel = '';
      if (r.fuelRate != null && r.fuelRate >= 0) {
        fuel = Number(((Math.max(0, r.minutes || 0) / 60) * r.fuelRate).toFixed(2));
      }
      return [
        r.maTram,
        r.tenTram || '',
        r.generatorName || '',
        fuelTypeLabel(r.fuelType),
        r.start,
        r.end,
        r.minutes,
        formatMinutes(r.minutes),
        fuel,
      ];
    }),
  ];

  const fileBase = [
    'thong-ke-may-no',
    safeFilePart(periodText),
    safeFilePart(stationLabel),
  ]
    .filter(Boolean)
    .join('_');

  downloadExcelWorkbook(
    [
      { name: 'Tom tat', rows: summaryRows },
      { name: 'Theo tram', rows: byStationRows },
      { name: 'Nhien lieu', rows: fuelRows },
      { name: 'Lich su chay', rows: historyRows },
    ],
    fileBase
  );
  toast('Đã tải file Excel');
}

function renderStats() {
  const root = $('#stats-root');
  if (!root) return;
  const exportBtn = $('#stats-export-excel');
  if (!canViewStats()) {
    root.innerHTML = `<p class="muted stats-empty">Chỉ admin hoặc root được xem thống kê.</p>`;
    if (exportBtn) exportBtn.hidden = true;
    return;
  }
  if (exportBtn) exportBtn.hidden = false;

  const data = buildStatsData();

  const periodText = statsPeriodText(data);

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
              )}">Cập nhật</button>
              ${
                canManageRunHistory()
                  ? `<button type="button" class="btn station-action-btn" data-action="history" data-key="${escapeAttr(
                      s.stationKey
                    )}">Chi tiết</button>`
                  : ''
              }
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

  if (avatarEl) {
    const initial = (name || email || '?').trim().charAt(0).toUpperCase() || '?';
    avatarEl.textContent = initial;
    avatarEl.classList.toggle('is-root', role === 'root');
    avatarEl.classList.toggle('is-admin', role === 'admin');
  }

  renderAdminRoles();
  renderUserModeration();
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

function findUidByEmail(email) {
  const want = normalizeEmail(email);
  for (const [uid, u] of Object.entries(state.directoryUsers)) {
    if (normalizeEmail(u?.email) === want) return uid;
  }
  return null;
}

function renderUserModeration() {
  const box = $('#user-moderation');
  const list = $('#user-mod-list');
  if (!box || !list) return;
  const show = canManageUserBlocks();
  box.hidden = !show;
  if (!show) return;

  if (canManageUserBlocks()) bindUsersListener();

  const rows = [];
  const seen = new Set();

  for (const [uid, info] of Object.entries(state.blocked)) {
    const email = info.email || uid;
    seen.add(normalizeEmail(email));
    rows.push({
      uid,
      email,
      name: state.directoryUsers[uid]?.displayName || '',
      status: 'blocked',
      meta: info.blockedBy ? `chặn bởi ${info.blockedBy}` : 'đã chặn',
      canAct: canBlockTarget(uid, email),
    });
  }
  for (const [key, info] of Object.entries(state.pendingBlocked)) {
    const email = info.email || key;
    const em = normalizeEmail(email);
    if (seen.has(em)) continue;
    seen.add(em);
    rows.push({
      uid: '',
      email,
      emailKey: key,
      name: '',
      status: 'pending-block',
      meta: 'chờ đăng nhập · đã đánh dấu chặn',
      canAct: canBlockTarget('', email),
    });
  }
  for (const [uid, u] of Object.entries(state.directoryUsers)) {
    const email = u?.email || '';
    const em = normalizeEmail(email);
    if (!em || seen.has(em)) continue;
    if (em === normalizeEmail(ROOT_EMAIL)) continue;
    seen.add(em);
    const isAdmin = !!state.admins[uid];
    rows.push({
      uid,
      email,
      name: u.displayName || '',
      status: isAdmin ? 'admin' : 'user',
      meta: isAdmin ? 'admin' : 'user',
      canAct: canBlockTarget(uid, email),
    });
  }

  rows.sort((a, b) => {
    const rank = { blocked: 0, 'pending-block': 1, user: 2, admin: 3 };
    const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (d !== 0) return d;
    return a.email.localeCompare(b.email, 'vi');
  });

  if (!rows.length) {
    list.innerHTML = `<p class="muted tiny">Chưa có user nào trong danh bạ. User sẽ xuất hiện sau khi đăng ký/đăng nhập.</p>`;
    return;
  }

  list.innerHTML = rows
    .map((r) => {
      const blocked = r.status === 'blocked' || r.status === 'pending-block';
      const statusLabel =
        r.status === 'blocked'
          ? 'Đã chặn'
          : r.status === 'pending-block'
            ? 'Chờ chặn'
            : r.status === 'admin'
              ? 'Admin'
              : 'User';
      let action = '';
      if (r.canAct) {
        if (blocked) {
          action = `<button type="button" class="btn-text" data-unblock-user="${escapeAttr(
            r.uid || r.emailKey || ''
          )}" data-unblock-kind="${escapeAttr(r.uid ? 'active' : 'pending')}">Bỏ chặn</button>`;
        } else {
          action = `<button type="button" class="btn-text danger" data-block-user="${escapeAttr(
            r.uid
          )}" data-block-email="${escapeAttr(r.email)}">Chặn</button>`;
        }
      }
      return `<div class="admin-row">
        <div>
          <strong>${escapeHtml(r.email)}</strong>
          <div class="muted tiny">${escapeHtml(
            [r.name, statusLabel, r.meta].filter(Boolean).join(' · ')
          )}</div>
        </div>
        ${action}
      </div>`;
    })
    .join('');
}

function buildRunHistory(eventsMap, station) {
  const rows = extractMayNoRuns(eventsMap).map((r) => ({
    id: r.id,
    active: false,
    start: r.start,
    end: r.end,
    minutes: r.minutes,
    sortAt: r.at || r.receivedAt || 0,
    receivedAt: r.receivedAt || 0,
    label: 'Đã chạy',
  }));

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
      receivedAt: station.mayNoScAtMillis,
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
  const canManage = canManageRunHistory();
  el.innerHTML = state.runHistory
    .map((r) => {
      const dur =
        r.minutes == null ? '--' : r.active ? `~${formatMinutes(r.minutes)}` : formatMinutes(r.minutes);
      const range = `${escapeHtml(r.start)} → ${escapeHtml(r.end)}`;
      const actions =
        canManage && !r.active
          ? `<div class="run-row-actions">
              <button type="button" class="btn-text run-edit-btn" data-edit-run="${escapeAttr(
                r.id
              )}" data-minutes="${escapeAttr(String(r.minutes ?? ''))}">Sửa</button>
              <button type="button" class="btn-text danger run-del-btn" data-del-run="${escapeAttr(
                r.id
              )}">Xóa</button>
            </div>`
          : '';
      return `<article class="run-row ${r.active ? 'is-active' : ''}">
        <div class="run-row-top">
          <div class="run-row-range">${range}</div>
          <div class="run-row-dur">${escapeHtml(dur)}</div>
        </div>
        <div class="run-row-meta">${escapeHtml(r.label)}</div>
        ${actions}
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
  if (mode === 'history' && !canManageRunHistory()) {
    toast('Chỉ admin hoặc root được xem/sửa lịch sử chạy máy');
    return;
  }
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

async function deleteRunHistoryEvent(eventId) {
  if (!canManageRunHistory() || !state.selectedKey || !eventId || eventId === 'active-sc') {
    toast('Không thể xóa mục này');
    return;
  }
  if (!confirm('Xóa lần chạy này khỏi lịch sử?\nKhông tự chỉnh lại tổng giờ chạy đã cộng.')) return;
  try {
    await remove(ref(db, `stations/${state.selectedKey}/events/${eventId}`));
    toast('Đã xóa lịch sử chạy');
  } catch (e) {
    toast('Xóa thất bại: ' + (e.message || e));
  }
}

async function editRunHistoryEvent(eventId, currentMinutes) {
  if (!canManageRunHistory() || !state.selectedKey || !eventId || eventId === 'active-sc') {
    toast('Không thể sửa mục này');
    return;
  }
  const raw = prompt('Thời gian chạy (phút):', String(currentMinutes ?? ''));
  if (raw == null) return;
  const minutes = Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(minutes) || minutes < 0) {
    toast('Số phút không hợp lệ');
    return;
  }
  const rounded = Math.round(minutes);
  try {
    await update(ref(db, `stations/${state.selectedKey}/events/${eventId}`), {
      durationMinutesEffective: rounded,
      durationMinutesFromRange: rounded,
      durationToken: `${rounded}p`,
      editedAt: serverTimestamp(),
      editedBy: currentUserLabel(),
      editedByUid: state.user.uid,
    });
    toast('Đã cập nhật thời gian chạy');
  } catch (e) {
    toast('Sửa thất bại: ' + (e.message || e));
  }
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
    toast('Chỉ admin hoặc root được xóa cảnh báo');
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
  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode));
  });
  $('#logout-btn').addEventListener('click', handleLogout);
  $('#blocked-logout')?.addEventListener('click', handleLogout);

  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'stats' && !canViewStats()) {
        toast('Chỉ admin hoặc root được xem thống kê');
        return;
      }
      state.tab = tab;
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
  $('#stats-export-excel')?.addEventListener('click', () => {
    exportStatsExcel();
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

  $('#detail-run-history')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-run]');
    if (del) {
      deleteRunHistoryEvent(del.dataset.delRun);
      return;
    }
    const edit = e.target.closest('[data-edit-run]');
    if (edit) {
      editRunHistoryEvent(edit.dataset.editRun, edit.dataset.minutes);
    }
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
  $('#block-user-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    blockUserByEmail($('#block-user-email')?.value || '');
  });
  $('#user-mod-list')?.addEventListener('click', (e) => {
    const blockBtn = e.target.closest('[data-block-user]');
    if (blockBtn) {
      blockUserByEmail(blockBtn.dataset.blockEmail || '', blockBtn.dataset.blockUser || '');
      return;
    }
    const unblockBtn = e.target.closest('[data-unblock-user]');
    if (unblockBtn) {
      unblockUser(unblockBtn.dataset.unblockKind, unblockBtn.dataset.unblockUser);
    }
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

  const key = emailKey(email);
  // Promote pending admin → active by uid
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

  // Promote pending block → active by uid
  try {
    const pendingBlock = await get(ref(db, `roles/pendingBlocked/${key}`));
    if (pendingBlock.exists()) {
      const pending = pendingBlock.val() || {};
      await set(ref(db, `roles/blocked/${user.uid}`), {
        email,
        blockedAt: pending.blockedAt || serverTimestamp(),
        blockedBy: pending.blockedBy || 'admin',
        blockedByUid: pending.blockedByUid || null,
        activatedAt: serverTimestamp(),
      });
      await remove(ref(db, `roles/pendingBlocked/${key}`));
    }
  } catch (_) {
    /* ignore */
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
    state.blocked = val.blocked || {};
    state.pendingBlocked = val.pendingBlocked || {};
    state.rolesReady = true;
    if (canManageUserBlocks()) bindUsersListener();
    render();
  });
}

function stopRolesListener() {
  if (unsubRoles) {
    unsubRoles();
    unsubRoles = null;
  }
  state.rolesBound = false;
  state.rolesReady = false;
  state.admins = {};
  state.pendingAdmins = {};
  state.blocked = {};
  state.pendingBlocked = {};
}

function bindUsersListener() {
  if (state.usersBound || !canManageUserBlocks()) return;
  state.usersBound = true;
  unsubUsers = onValue(ref(db, 'users'), (snap) => {
    state.directoryUsers = snap.val() || {};
    if (state.tab === 'settings') renderUserModeration();
  });
}

function stopUsersListener() {
  if (unsubUsers) {
    unsubUsers();
    unsubUsers = null;
  }
  state.usersBound = false;
  state.directoryUsers = {};
}

async function blockUserByEmail(emailRaw, uidHint = '') {
  if (!canManageUserBlocks()) {
    toast('Chỉ admin hoặc root được chặn user');
    return;
  }
  const email = normalizeEmail(emailRaw);
  if (!email || !email.includes('@')) {
    toast('Email không hợp lệ');
    return;
  }
  let uid = uidHint || findUidByEmail(email);
  if (!canBlockTarget(uid || '', email)) {
    toast('Không thể chặn tài khoản này');
    return;
  }
  if (!confirm(`Chặn tài khoản ${email}? Họ sẽ không xem được dữ liệu.`)) return;
  const who = currentUserLabel();
  const key = emailKey(email);
  try {
    if (uid) {
      await set(ref(db, `roles/blocked/${uid}`), {
        email,
        blockedAt: serverTimestamp(),
        blockedBy: who,
        blockedByUid: state.user.uid,
      });
      await remove(ref(db, `roles/pendingBlocked/${key}`));
    } else {
      await set(ref(db, `roles/pendingBlocked/${key}`), {
        email,
        blockedAt: serverTimestamp(),
        blockedBy: who,
        blockedByUid: state.user.uid,
      });
    }
    toast(`Đã chặn: ${email}`);
    const input = $('#block-user-email');
    if (input) input.value = '';
  } catch (e) {
    toast('Chặn thất bại: ' + (e.message || e));
  }
}

async function unblockUser(kind, key) {
  if (!canManageUserBlocks()) {
    toast('Chỉ admin hoặc root được bỏ chặn');
    return;
  }
  if (!key) return;
  if (!confirm('Bỏ chặn tài khoản này?')) return;
  try {
    if (kind === 'pending') {
      await remove(ref(db, `roles/pendingBlocked/${key}`));
    } else {
      await remove(ref(db, `roles/blocked/${key}`));
    }
    toast('Đã bỏ chặn');
  } catch (e) {
    toast('Bỏ chặn thất bại: ' + (e.message || e));
  }
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
    state.authReady = true;
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
      // Không chặn UI nếu ghi profile/roles chậm hoặc lỗi mạng.
      upsertCurrentUserProfile(user).catch(() => {});
      bindRolesListener();
      bindStationsListener();
    } else {
      state.displayName = '';
      state.selectedKey = null;
      state.sheetMode = null;
      stopRunHistoryListener();
      stopRolesListener();
      stopUsersListener();
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
