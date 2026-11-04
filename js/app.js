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
} from './config.js?v=107';
import {
  stationForecast,
  forecastFuelPercentDuringActiveAlert,
  formatMinutes,
  formatDuration,
  formatMillis,
  formatPercent,
} from './forecast.js?v=107';
import {
  extractMayNoRuns,
  computeStats,
  formatPeriodLabel,
  fuelTypeLabel,
  formatLiters,
} from './stats.js?v=107';
import { downloadExcelWorkbook, safeFilePart } from './exportExcel.js?v=107';
import {
  equipmentTypes,
  equipmentTypeById,
  normalizeEquipment,
  buildEquipmentFieldsHtml,
  readEquipmentFormValues,
  equipmentPayload,
  equipmentUnitLabel,
  equipmentUnitOptionLabel,
  equipmentTypeMeta,
  equipmentFilledFields,
  mapStationMayNoToMayPhatDien,
  mergeEquipmentDeviceFillEmpty,
  countEquipmentDataFields,
  sharedFieldsFromDevice,
  buildEquipmentKindRecord,
  equipmentKindKey,
  equipmentKindLabel,
  applyBinhAcquyInferredFields,
  applyPostefAcquyYearFromSerial,
  isUniqueEquipmentField,
} from './equipment.js?v=107';
import { openQrScanner, closeQrScanner, isQrScannerOpen } from './qr-scan.js?v=107';


const app = initializeApp(firebaseConfig);

/** Draft thiết bị đang sửa trong sheet. */
let equipmentDraft = null;
/** Bỏ qua sự kiện change khi đổ lại #eq-kind-from bằng code. */
let eqKindSelectSilent = false;
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
  equipmentByCsht: {},
  /** RTDB equipmentKinds/{typeId}/{kindKey} — loại TB toàn hệ thống (hãng+model). */
  equipmentKinds: {},
  user: null,
  /** false đến khi Firebase báo auth state lần đầu */
  authReady: false,
  /** 'login' | 'register' */
  authMode: 'login',
  displayName: '',
  tab: 'stations',
  stations: [],
  query: '',
  equipmentQuery: '',
  /** 'all' | 'nearest' */
  equipmentGeoFilter: 'all',
  /** Vị trí GPS hiện tại: { lat, lng, accuracy, at } | null */
  geo: null,
  geoLocating: false,
  /** Map maCsht → true khi đang xem chi tiết */
  equipmentExpanded: {},
  /** CSHT đang mở sheet thiết bị */
  selectedCsht: null,
  alertTab: 0,
  selectedKey: null,
  /** null | 'edit' | 'lock' | 'station' | 'history' */
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

/** Admin/root: sửa thông tin trạm hoặc xóa trạm. */
function canManageStations() {
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
      maCsht: profile.maCsht || null,
      maKhoaTram: profile.maKhoaTram || null,
      tenCsht: profile.tenCsht || null,
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
    equipment: {},
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
      const csht = (s.profile.maCsht || '').toLowerCase();
      const khoa = (s.profile.maKhoaTram || '').toLowerCase();
      return code.includes(q) || name.includes(q) || csht.includes(q) || khoa.includes(q);
    });
  }
  return [...list].sort((a, b) => {
    const pa = stationForecast(a) ?? Infinity;
    const pb = stationForecast(b) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return (a.profile.maTram || a.stationKey).localeCompare(b.profile.maTram || b.stationKey, 'vi');
  });
}

function normalizeAlertSource(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'fms_crawl' || s === 'fms' || s === 'service') return 'fms';
  if (s === 'sms') return 'sms';
  // Android cũ không ghi lastSource → coi như SMS
  return 'sms';
}

function alertSourceBadge(source) {
  if (source === 'fms') {
    return '<span class="badge badge-source badge-source-fms" title="Đẩy từ FMS service">FMS</span>';
  }
  return '<span class="badge badge-source badge-source-sms" title="Đẩy từ SMS Ghunter">SMS</span>';
}

function activeAlerts(deviceTypes) {
  const types = Array.isArray(deviceTypes) ? deviceTypes : [deviceTypes];
  const rows = [];
  for (const s of state.stations) {
    for (const deviceType of types) {
      const key = sanitizeKey(deviceType);
      const status = s.deviceStatus[key] || s.deviceStatus[deviceType];
      if (!status || status.lastAlertType !== 'SC') continue;
      const scAt = toNum(status.scAtMillis);
      const updatedAt = toNum(status.updatedAt) || 0;
      const source = normalizeAlertSource(status.lastSource);
      rows.push({
        stationKey: s.stationKey,
        maTram: s.profile.maTram || s.stationKey,
        tenTram: s.profile.tenTram || '',
        alertAt: scAt || updatedAt,
        scEventTime: status.scEventTime || null,
        alarmCause: status.alarmCause || null,
        alarmDetail: status.alarmDetail || null,
        profile: s.profile,
        stats: s.stats,
        clearedBy: status.clearedBy || null,
        deviceType,
        source,
      });
    }
  }
  return rows.sort((a, b) => a.maTram.localeCompare(b.maTram, 'vi'));
}

function deviceTypeShortLabel(deviceType) {
  const t = String(deviceType || '').toUpperCase();
  if (t === 'CELL_OOS') return 'CELL';
  if (t === 'SITE_OOS') return 'SITE';
  return '';
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
  if (state.tab === 'equipment') renderEquipmentList();
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

/** Ngưỡng coi như đang ở đúng CSHT (mét) — hỗ trợ cập nhật thiết bị đúng trạm. */
const GEO_NEAR_M = 150;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function siteLatLng(rowOrSite) {
  if (!rowOrSite) return null;
  const lat = toNum(rowOrSite.lat);
  const lng = toNum(rowOrSite.long);
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function formatDistanceMeters(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Google Maps chỉ đường tới lat/long (điểm xuất phát = vị trí hiện tại trên app Maps). */
function googleMapsDirectionsUrl(lat, lng) {
  const dest = `${Number(lat)},${Number(lng)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
}

function openSiteDirections(rowOrSite) {
  const c = siteLatLng(rowOrSite);
  if (!c) {
    toast('Trạm chưa có tọa độ LAT/LONG');
    return;
  }
  const url = googleMapsDirectionsUrl(c.lat, c.lng);
  window.open(url, '_blank', 'noopener,noreferrer');
}

function siteDistanceMeters(rowOrSite) {
  const geo = state.geo;
  if (!geo || geo.lat == null || geo.lng == null) return null;
  const c = siteLatLng(rowOrSite);
  if (!c) return null;
  return haversineMeters(geo.lat, geo.lng, c.lat, c.lng);
}

function isEquipmentNearestFilter() {
  return state.equipmentGeoFilter === 'nearest' && !!state.geo;
}

/** Gần nhất: chỉ giữ 1 CSHT gần GPS nhất (có tọa độ). */
function applyEquipmentNearestFilter(list) {
  if (!isEquipmentNearestFilter()) return list;
  let best = null;
  let bestDist = Infinity;
  for (const row of list) {
    const d = siteDistanceMeters(row);
    if (d == null) continue;
    if (d < bestDist) {
      bestDist = d;
      best = row;
    }
  }
  return best ? [best] : [];
}

function syncEquipmentGeoFilterControl() {
  const sel = $('#equipment-geo-filter');
  if (!sel) return;
  sel.disabled = !!state.geoLocating;
  if (sel.value !== state.equipmentGeoFilter) sel.value = state.equipmentGeoFilter;
}

function requestEquipmentGeoForNearest() {
  if (!navigator.geolocation) {
    toast('Thiết bị không hỗ trợ GPS');
    state.equipmentGeoFilter = 'all';
    syncEquipmentGeoFilterControl();
    renderEquipmentList();
    return;
  }
  if (state.geoLocating) return;
  state.geoLocating = true;
  syncEquipmentGeoFilterControl();
  renderEquipmentList();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.geoLocating = false;
      state.geo = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: Date.now(),
      };
      state.equipmentGeoFilter = 'nearest';
      syncEquipmentGeoFilterControl();
      renderEquipmentList();
      toast('Đã lấy vị trí — danh sách theo khoảng cách gần nhất');
    },
    (err) => {
      state.geoLocating = false;
      state.equipmentGeoFilter = 'all';
      syncEquipmentGeoFilterControl();
      renderEquipmentList();
      const code = err && err.code;
      const msg =
        code === 1
          ? 'Chưa cấp quyền vị trí — hãy cho phép trong trình duyệt/OS'
          : code === 2
            ? 'Không xác định được vị trí'
            : code === 3
              ? 'Hết thời gian lấy GPS'
              : 'Không lấy được GPS';
      toast(msg);
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
  );
}

function onEquipmentGeoFilterChange(value) {
  const next = value === 'nearest' ? 'nearest' : 'all';
  if (next === 'all') {
    state.equipmentGeoFilter = 'all';
    state.geoLocating = false;
    syncEquipmentGeoFilterControl();
    renderEquipmentList();
    return;
  }
  // Gần nhất: lấy GPS (làm mới mỗi lần chọn) rồi sắp xếp.
  state.equipmentGeoFilter = 'nearest';
  requestEquipmentGeoForNearest();
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
      const maCsht = (s.profile.maCsht || '').trim();
      const maKhoa = (s.profile.maKhoaTram || '').trim();
      const generator = (s.profile.generatorName || '').trim();
      const addr = s.profile.diaChi || 'Chưa có địa chỉ';
      const predicted = stationForecast(s);
      const fuelClass = fuelLevelClass(predicted);
      const fuelLabel = predicted == null ? '--' : formatPercent(predicted);
      const since = formatMinutes(s.stats.runMinutesSinceRefuel);
      // Gần nhất / Tổng: chỉ từ KP MAY_NO (cùng nguồn với Chi tiết lịch sử).
      // Không dùng stats.lastRunMinutes — backend có thể lẫn KP nguồn điện (POWER_AC).
      const mayNoRuns = [...(s.runs || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
      const lastRun = mayNoRuns[0] || null;
      const totalFromRuns = mayNoRuns.reduce((sum, r) => sum + (Number(r.minutes) || 0), 0);
      const total =
        mayNoRuns.length > 0
          ? formatMinutes(totalFromRuns)
          : formatMinutes(s.stats.totalRunMinutes);
      const last = lastRun
        ? `${formatMinutes(lastRun.minutes)}${lastRun.at ? ` · ${formatMillis(lastRun.at)}` : ''}`
        : '--';
      const genLabel = generator || 'chưa đặt tên';
      const active = s.mayNoLastAlertType === 'SC';
      const historyBtn = canManageRunHistory()
        ? `<button type="button" class="btn station-action-btn" data-action="history" data-key="${escapeAttr(
            s.stationKey
          )}">Chi tiết</button>`
        : '';
      const adminBtns = canManageStations()
        ? `<button type="button" class="btn-outline station-action-btn" data-action="station" data-key="${escapeAttr(
            s.stationKey
          )}">Sửa trạm</button>
           <button type="button" class="btn-text danger station-action-btn" data-action="delete" data-key="${escapeAttr(
             s.stationKey
           )}">Xóa</button>`
        : '';
      const footerBtns = [historyBtn, adminBtns].filter(Boolean).join('');
      return `<article class="station-card ${fuelClass}${active ? ' is-sc' : ''}" data-key="${escapeAttr(
        s.stationKey
      )}" style="--i:${index}">
        <div class="station-accent" aria-hidden="true"></div>
        <header class="station-top">
          <div class="station-id">
            <span class="station-code">${escapeHtml(code)}</span>
            ${active ? '<span class="badge badge-sc">SC</span>' : ''}
          </div>
          <div class="station-fuel ${fuelClass}" title="Dự báo nhiên liệu">
            <span class="fuel-label">NL</span>
            <span class="fuel-value">${escapeHtml(fuelLabel)}</span>
          </div>
        </header>
        <p class="station-name">${escapeHtml(name)}</p>
        <p class="station-addr">${escapeHtml(addr)}</p>

        <div class="station-kv">
          <div class="station-kv-row">
            <span class="station-kv-l">CSHT</span>
            <strong class="station-kv-v">${escapeHtml(maCsht || '—')}</strong>
          </div>
          <div class="station-kv-row station-kv-action">
            <div class="station-kv-text">
              <span class="station-kv-l">Mã khóa</span>
              <strong class="station-kv-v">${escapeHtml(maKhoa || '—')}</strong>
            </div>
            <button type="button" class="btn-outline station-action-btn" data-action="lock" data-key="${escapeAttr(
              s.stationKey
            )}">Cập nhật MK</button>
          </div>
          <div class="station-kv-row station-kv-action">
            <div class="station-kv-text">
              <span class="station-kv-l">Máy</span>
              <strong class="station-kv-v">${escapeHtml(genLabel)}</strong>
            </div>
            <button type="button" class="btn-outline station-action-btn" data-action="edit" data-key="${escapeAttr(
              s.stationKey
            )}">Cập nhật MN</button>
          </div>
        </div>

        <div class="station-metrics">
          <div class="station-metric">
            <span class="station-metric-l">Đã chạy</span>
            <strong>${escapeHtml(since)}</strong>
          </div>
          <div class="station-metric">
            <span class="station-metric-l">Tổng</span>
            <strong>${escapeHtml(total)}</strong>
          </div>
          <div class="station-metric station-metric-wide">
            <span class="station-metric-l">Gần nhất</span>
            <strong>${escapeHtml(last)}</strong>
          </div>
        </div>
        ${
          footerBtns
            ? `<div class="station-footer">${footerBtns}</div>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderAlerts() {
  if (state.alertTab >= ALERT_TABS.length) state.alertTab = 0;
  const tabs = $('#alert-tabs');
  tabs.innerHTML = ALERT_TABS.map(
    (t, i) =>
      `<button type="button" class="chip ${i === state.alertTab ? 'active' : ''}" data-alert-tab="${i}">${escapeHtml(
        t.title
      )}</button>`
  ).join('');

  const cfg = ALERT_TABS[state.alertTab];
  const types = cfg.deviceTypes || [cfg.id];
  const alerts = activeAlerts(types);
  const multiType = types.length > 1;
  const root = $('#alerts-list');
  const empty = $('#alerts-empty');
  if (!alerts.length) {
    root.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'Không có cảnh báo đang active.';
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
      const typeLabel = multiType ? deviceTypeShortLabel(a.deviceType) : '';
      const typeBadge = typeLabel
        ? `<span class="badge badge-device">${escapeHtml(typeLabel)}</span>`
        : '';
      const sourceBadge = alertSourceBadge(a.source);
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
      const hasDetail =
        !!(a.alarmCause && String(a.alarmCause).trim()) ||
        !!(a.alarmDetail && String(a.alarmDetail).trim());
      const detailBtn = hasDetail
        ? `<button type="button" class="btn-text" data-alarm-detail="${escapeAttr(
            JSON.stringify({
              cause: a.alarmCause || '',
              detail: a.alarmDetail || '',
              title: `${a.maTram} · ${a.tenTram}`,
              source: a.source === 'fms' ? 'FMS' : 'SMS',
            })
          )}">Chi tiết</button>`
        : '';
      const dismissBtn = canDismissAlerts()
        ? `<button type="button" class="btn-text danger" data-dismiss="${escapeAttr(
            a.stationKey
          )}" data-device="${escapeAttr(a.deviceType)}">Xóa</button>`
        : '';
      const actions =
        detailBtn || dismissBtn
          ? `<div class="row-actions">${detailBtn}${dismissBtn}</div>`
          : '';
      return `<article class="card alert-card ${warn ? 'is-warn' : ''} source-${a.source}">
        <div class="card-title-row">
          <h3>${escapeHtml(a.maTram)} · ${escapeHtml(a.tenTram)}</h3>
          ${sourceBadge}
          ${typeBadge}
          ${warnBtn}
        </div>
        <p class="muted ${warn ? 'danger' : ''}">Lúc: ${escapeHtml(when)} · ${escapeHtml(ago)}</p>
        ${fuelLine}
        ${actions}
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
    el.innerHTML = `<p class="muted run-history-empty">Chưa có lần chạy hoàn tất (KP máy nổ).</p>`;
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
  if ((mode === 'station' || mode === 'delete') && !canManageStations()) {
    toast('Chỉ admin hoặc root được sửa/xóa trạm');
    return;
  }
  if (mode === 'delete') {
    deleteStation(stationKey);
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
  const lockPanel = $('#detail-lock-panel');
  const equipmentPanel = $('#detail-equipment-panel');
  const stationPanel = $('#detail-station-panel');
  const historyPanel = $('#detail-history-panel');
  const isEquipment = state.sheetMode === 'equipment';
  if ((!state.selectedKey && !isEquipment) || !state.sheetMode) {
    sheet.hidden = true;
    backdrop.hidden = true;
    stopRunHistoryListener();
    return;
  }
  if (isEquipment) {
    const csht = (state.selectedCsht || '').trim();
    if (!csht) {
      state.sheetMode = null;
      sheet.hidden = true;
      backdrop.hidden = true;
      return;
    }
    sheet.hidden = false;
    backdrop.hidden = false;
    editPanel.hidden = true;
    if (lockPanel) lockPanel.hidden = true;
    if (equipmentPanel) equipmentPanel.hidden = false;
    if (stationPanel) stationPanel.hidden = true;
    historyPanel.hidden = true;
    ensureEquipmentDraft(csht, sheet);
    const isAdd = equipmentDraft?.mode === 'add';
    sheet.setAttribute('aria-label', isAdd ? 'Thêm thiết bị' : 'Sửa thiết bị');
    const badge = $('#detail-mode-badge');
    if (badge) {
      badge.textContent = isAdd ? 'Thêm TB' : 'Sửa TB';
      badge.classList.toggle('is-history', false);
      badge.classList.toggle('is-lock', false);
      badge.classList.toggle('is-equipment', true);
      badge.classList.toggle('is-station', false);
    }
    const site = state.equipmentByCsht[csht] || { maCsht: csht };
    $('#detail-title').textContent = formatMaTram(site.maTram) || csht;
    const unit =
      equipmentDraft && equipmentTypeById(equipmentDraft.typeId)
        ? equipmentUnitOptionLabel(equipmentDraft.typeId, equipmentDraft.index)
        : '';
    const showGeo = isEquipmentNearestFilter();
    const distM = showGeo ? siteDistanceMeters(site) : null;
    const distPart =
      distM != null
        ? `${formatDistanceMeters(distM)}${distM <= GEO_NEAR_M ? ' · gần vị trí' : ' · lệch vị trí'}`
        : showGeo
          ? 'Chưa có tọa độ'
          : '';
    $('#detail-subtitle').textContent =
      [isAdd ? 'Thêm thiết bị' : 'Sửa thiết bị', unit, site.tenTram, csht, distPart]
        .filter(Boolean)
        .join(' · ') || '—';
    const saveBtn = $('#detail-save-equipment');
    if (saveBtn) saveBtn.textContent = isAdd ? 'Lưu thiết bị mới' : 'Lưu thay đổi';
    renderEquipmentEditor(csht, true);
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
  const isLock = state.sheetMode === 'lock';
  const isStation = state.sheetMode === 'station';
  const isHistory = state.sheetMode === 'history';
  sheet.hidden = false;
  backdrop.hidden = false;
  editPanel.hidden = !isEdit;
  if (lockPanel) lockPanel.hidden = !isLock;
  if (equipmentPanel) equipmentPanel.hidden = true;
  if (stationPanel) stationPanel.hidden = !isStation;
  historyPanel.hidden = !isHistory;
  sheet.setAttribute(
    'aria-label',
    isEdit
      ? 'Cập nhật MN'
      : isLock
        ? 'Cập nhật mã khóa'
        : isStation
          ? 'Sửa thông tin trạm'
          : 'Chi tiết trạm'
  );
  const badge = $('#detail-mode-badge');
  if (badge) {
    badge.textContent = isEdit
      ? 'Cập nhật MN'
      : isLock
        ? 'Mã khóa'
        : isStation
          ? 'Sửa trạm'
          : 'Chi tiết';
    badge.classList.toggle('is-history', isHistory);
    badge.classList.toggle('is-lock', isLock);
    badge.classList.toggle('is-equipment', false);
    badge.classList.toggle('is-station', isStation);
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

  if (isLock) {
    if (!sheet.dataset.bound || sheet.dataset.key !== s.stationKey || sheet.dataset.mode !== 'lock') {
      const lockInput = $('#f-lock-code');
      if (lockInput) lockInput.value = s.profile.maKhoaTram || '';
      sheet.dataset.initialLock = String(s.profile.maKhoaTram || '');
      sheet.dataset.key = s.stationKey;
      sheet.dataset.mode = 'lock';
      sheet.dataset.bound = '1';
    }
    const cshtEl = $('#detail-lock-csht');
    if (cshtEl) cshtEl.textContent = s.profile.maCsht || '—';
  }

  if (isStation) {
    if (!sheet.dataset.bound || sheet.dataset.key !== s.stationKey || sheet.dataset.mode !== 'station') {
      const keyEl = $('#f-station-key');
      if (keyEl) keyEl.textContent = s.stationKey;
      $('#f-ma-tram').value = s.profile.maTram || s.stationKey;
      $('#f-ten-tram').value = s.profile.tenTram || '';
      $('#f-dia-chi').value = s.profile.diaChi || '';
      $('#f-ma-csht').value = s.profile.maCsht || '';
      $('#f-ma-khoa').value = s.profile.maKhoaTram || '';
      $('#f-ten-csht').value = s.profile.tenCsht || '';
      $('#f-station-generator').value = s.profile.generatorName || '';
      sheet.dataset.key = s.stationKey;
      sheet.dataset.mode = 'station';
      sheet.dataset.bound = '1';
    }
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
      alarmCause: null,
      alarmDetail: null,
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

async function saveStationInfo() {
  if (!canManageStations()) {
    toast('Chỉ admin hoặc root được sửa trạm');
    return;
  }
  const key = state.selectedKey;
  if (!key || !state.user) return;
  const who = currentUserLabel();
  const updates = {
    maTram: ($('#f-ma-tram')?.value || '').trim() || key,
    tenTram: ($('#f-ten-tram')?.value || '').trim() || null,
    diaChi: ($('#f-dia-chi')?.value || '').trim() || null,
    maCsht: ($('#f-ma-csht')?.value || '').trim() || null,
    maKhoaTram: ($('#f-ma-khoa')?.value || '').trim() || null,
    tenCsht: ($('#f-ten-csht')?.value || '').trim() || null,
    generatorName: ($('#f-station-generator')?.value || '').trim() || null,
    updatedAt: serverTimestamp(),
    lastEditedBy: who,
    lastEditedByUid: state.user.uid,
    lastEditedAt: serverTimestamp(),
  };
  try {
    await update(ref(db, `stations/${key}/profile`), updates);
    const csht = String(updates.maCsht || '').trim();
    if (csht && updates.generatorName) {
      const station = state.stations.find((s) => s.stationKey === key);
      syncMayNoProfileToEquipment(
        csht,
        { ...(station?.profile || {}), ...updates },
        'station-mayno'
      ).catch(() => {});
    }
    const sheet = $('#detail-sheet');
    if (sheet) sheet.dataset.bound = '';
    toast('Đã lưu thông tin trạm');
    state.selectedKey = null;
    state.sheetMode = null;
    render();
  } catch (e) {
    toast('Lưu thất bại: ' + (e.message || e));
  }
}

async function deleteStation(stationKey) {
  if (!canManageStations()) {
    toast('Chỉ admin hoặc root được xóa trạm');
    return;
  }
  const key = stationKey || state.selectedKey;
  if (!key) return;
  const s = state.stations.find((x) => x.stationKey === key);
  const label = s?.profile?.maTram || key;
  if (
    !confirm(
      `Xóa trạm ${label}?\n\nSẽ xóa toàn bộ profile, cảnh báo, thống kê và lịch sử chạy máy.\nThao tác không hoàn tác được.`
    )
  ) {
    return;
  }
  if (!confirm(`Xác nhận lần nữa: xóa hẳn ${label}?`)) return;
  try {
    await remove(ref(db, `stations/${key}`));
    if (state.selectedKey === key) {
      state.selectedKey = null;
      state.sheetMode = null;
      stopRunHistoryListener();
    }
    toast('Đã xóa trạm');
    render();
  } catch (e) {
    toast('Xóa thất bại: ' + (e.message || e));
  }
}

async function saveLockCode() {
  const key = state.selectedKey;
  if (!key || !state.user) return;
  const sheet = $('#detail-sheet');
  const lockInput = $('#f-lock-code');
  const next = (lockInput?.value || '').trim();
  const prev = sheet?.dataset.initialLock || '';
  if (next === prev) {
    toast('Không có thay đổi');
    return;
  }
  const who = currentUserLabel();
  try {
    await update(ref(db, `stations/${key}/profile`), {
      maKhoaTram: next || null,
      updatedAt: serverTimestamp(),
      lastEditedBy: who,
      lastEditedByUid: state.user.uid,
      lastEditedAt: serverTimestamp(),
    });
    if (sheet) sheet.dataset.bound = '';
    toast('Đã lưu mã khóa');
    state.selectedKey = null;
    state.sheetMode = null;
    render();
  } catch (e) {
    toast('Lưu thất bại: ' + (e.message || e));
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
    const station = state.stations.find((s) => s.stationKey === key);
    const csht = String(
      updates.maCsht || station?.profile?.maCsht || ''
    ).trim();
    if (csht) {
      const mergedProfile = { ...(station?.profile || {}), ...updates };
      syncMayNoProfileToEquipment(csht, mergedProfile, 'station-mayno').catch(() => {});
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




function stripStationTechPrefix(name) {
  return String(name || '')
    .trim()
    .replace(/^(4G|3G|5G|UL)[-_]+/i, '');
}

function formatMaTram(name) {
  return stripStationTechPrefix(name) || String(name || '').trim();
}

function equipmentSiteByCsht(csht) {
  const key = String(csht || '').trim();
  if (!key) return null;
  return state.equipmentByCsht[key] || null;
}

/** Meta CSHT khi update nhánh thiết bị — chỉ ghi field đang có giá trị (tránh xóa tenTram/maTram bằng null). */
function equipmentSiteMetaPatch(csht, site, who) {
  const key = String(csht || '').trim();
  const s = site && typeof site === 'object' ? site : {};
  const patch = {
    maCsht: key,
    lastEditedBy: who,
    lastEditedByUid: state.user.uid,
    lastEditedAt: serverTimestamp(),
  };
  if (s.maTram != null && String(s.maTram).trim() !== '') patch.maTram = s.maTram;
  if (Array.isArray(s.maTrams) && s.maTrams.length) patch.maTrams = s.maTrams;
  if (s.tenTram != null && String(s.tenTram).trim() !== '') patch.tenTram = s.tenTram;
  if (s.lat != null && Number.isFinite(Number(s.lat))) patch.lat = Number(s.lat);
  if (s.long != null && Number.isFinite(Number(s.long))) patch.long = Number(s.long);
  return patch;
}

function equipmentDevicesByCsht(csht) {
  return normalizeEquipment(equipmentSiteByCsht(csht));
}

/** Profile Máy nổ tốt nhất theo mã CSHT (nhiều field nhất). */
function bestStationProfileForCsht(csht) {
  const key = String(csht || '').trim();
  if (!key) return null;
  let best = null;
  let bestScore = -1;
  for (const s of state.stations || []) {
    if (String(s.profile?.maCsht || '').trim() !== key) continue;
    const mapped = mapStationMayNoToMayPhatDien(s.profile);
    const score = countEquipmentDataFields(mapped);
    if (score > bestScore) {
      bestScore = score;
      best = s.profile;
    }
  }
  return bestScore > 0 ? best : null;
}

function applyMayNoMapToMayPhatList(list, profile) {
  const mapped = mapStationMayNoToMayPhatDien(profile);
  if (!countEquipmentDataFields(mapped)) return { list, changed: false };
  const next = Array.isArray(list) ? list.map((d) => ({ ...d })) : [];
  if (!next.length) next.push({});
  const { device, changed } = mergeEquipmentDeviceFillEmpty(next[0], mapped);
  if (!changed) return { list: next, changed: false };
  next[0] = device;
  return { list: next, changed: true };
}

/** Ghi máy phát điện từ profile Máy nổ — chỉ điền ô trống trên MPD #1, không đụng loại TB khác. */
async function syncMayNoProfileToEquipment(csht, profile, source = 'station-mayno') {
  const key = String(csht || '').trim();
  const mapped = mapStationMayNoToMayPhatDien(profile);
  if (!key || !countEquipmentDataFields(mapped) || !state.user) return false;
  const current0 = (equipmentDevicesByCsht(key).may_phat_dien || [])[0] || {};
  const { changed } = mergeEquipmentDeviceFillEmpty(current0, mapped);
  if (!changed) return false;

  const who = currentUserLabel();
  const nowMs = Date.now();
  // Multi-path update: chỉ các field trống của may_phat_dien/devices/0 (+ meta MPD).
  const updates = {
    maCsht: key,
    lastEditedBy: who,
    lastEditedByUid: state.user.uid,
    lastEditedAt: serverTimestamp(),
    'may_phat_dien/lastEditedBy': who,
    'may_phat_dien/lastEditedByUid': state.user.uid,
    'may_phat_dien/lastEditedAt': serverTimestamp(),
    'may_phat_dien/source': source,
  };
  let wrote = 0;
  for (const [k, v] of Object.entries(mapped)) {
    if (v == null || String(v).trim() === '') continue;
    if (current0[k] != null && String(current0[k]).trim() !== '') continue;
    updates[`may_phat_dien/devices/0/${k}`] = String(v).trim();
    wrote += 1;
  }
  if (!wrote) return false;
  updates['may_phat_dien/devices/0/lastEditedBy'] = who;
  updates['may_phat_dien/devices/0/lastEditedAt'] = nowMs;
  await update(ref(db, `equipment/${key}`), updates);
  return true;
}

async function syncAllMayNoStationsToEquipment() {
  if (!state.user || !isRootUser()) return { updated: 0 };
  const byCsht = new Map();
  for (const s of state.stations || []) {
    const csht = String(s.profile?.maCsht || '').trim();
    if (!csht) continue;
    const mapped = mapStationMayNoToMayPhatDien(s.profile);
    const score = countEquipmentDataFields(mapped);
    if (!score) continue;
    const prev = byCsht.get(csht);
    if (!prev || score > prev.score) byCsht.set(csht, { profile: s.profile, score });
  }
  let updated = 0;
  for (const [csht, { profile }] of byCsht) {
    try {
      if (await syncMayNoProfileToEquipment(csht, profile, 'station-mayno')) updated += 1;
    } catch {
      /* continue */
    }
  }
  return { updated, total: byCsht.size };
}

function equipmentDeviceCountParts(site) {
  const norm = normalizeEquipment(site);
  const parts = [];
  for (const t of equipmentTypes()) {
    const n = (norm[t.id] || []).length;
    if (n) parts.push(`${t.title}: ${n}`);
  }
  return parts;
}

function equipmentDeviceCountLabel(site) {
  const parts = equipmentDeviceCountParts(site);
  return parts.length ? parts.join(' · ') : 'Chưa có chủng loại/Thiết bị';
}

function equipmentDeviceCountHtml(site) {
  const parts = equipmentDeviceCountParts(site);
  if (!parts.length) return `<span class="eq-type-empty">Chưa có chủng loại/Thiết bị</span>`;
  return `<ul class="eq-type-lines">${parts
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join('')}</ul>`;
}

function equipmentSiteEditorLine(site) {
  if (!site) return null;
  let who = site.lastEditedBy || null;
  let when = site.lastEditedAt || null;
  if (!who) {
    for (const t of equipmentTypes()) {
      const meta = equipmentTypeMeta(site, t.id);
      if (meta.lastEditedBy) {
        who = meta.lastEditedBy;
        when = meta.lastEditedAt;
        break;
      }
    }
  }
  if (!who && !when) return null;
  const whenText = when ? formatMillis(typeof when === 'number' ? when : Number(when)) : '—';
  return `Cập nhật bởi ${who || '—'} · ${whenText}`;
}

function renderEquipmentInventoryHtml(site, maCsht) {
  const norm = normalizeEquipment(site);
  const blocks = [];
  for (const t of equipmentTypes()) {
    const devices = norm[t.id] || [];
    if (!devices.length) continue;
    const meta = equipmentTypeMeta(site, t.id);
    const metaLine =
      meta.lastEditedBy || meta.lastEditedAt
        ? `<span class="eq-type-meta">${escapeHtml(
            [meta.lastEditedBy ? meta.lastEditedBy : null, meta.lastEditedAt ? formatMillis(Number(meta.lastEditedAt)) : null]
              .filter(Boolean)
              .join(' · ')
          )}</span>`
        : '';
    const rows = devices
      .map((d, i) => {
        const filled = equipmentFilledFields(t, d, 10);
        const fields =
          filled.length
            ? `<dl class="eq-device-fields">${filled
                .map(
                  (f) =>
                    `<div><dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(f.value)}</dd></div>`
                )
                .join('')}</dl>`
            : `<p class="muted tiny">Chưa có thông số chi tiết</p>`;
        const who = d.lastEditedBy
          ? `<p class="muted tiny">Người cập nhật: ${escapeHtml(String(d.lastEditedBy))}</p>`
          : '';
        return `<div class="eq-device-row">
          <div class="eq-device-title">${escapeHtml(equipmentUnitOptionLabel(t.id, i))}</div>
          ${fields}
          ${who}
          <div class="eq-device-actions">
            <button type="button" class="btn-outline" data-action="eq-edit" data-csht="${escapeAttr(
              maCsht
            )}" data-type="${escapeAttr(t.id)}" data-index="${i}">Sửa</button>
            <button type="button" class="btn-text danger" data-action="eq-delete" data-csht="${escapeAttr(
              maCsht
            )}" data-type="${escapeAttr(t.id)}" data-index="${i}">Xóa</button>
          </div>
        </div>`;
      })
      .join('');
    blocks.push(`<div class="eq-type-block">
      <div class="eq-type-head">
        <span class="eq-type-title">${escapeHtml(t.title)} (${devices.length})</span>
        ${metaLine}
      </div>
      ${rows}
    </div>`);
  }
  if (!blocks.length) {
    return `<p class="muted tiny">Chưa có chủng loại/Thiết bị</p>`;
  }
  return `<div class="eq-inventory">${blocks.join('')}</div>`;
}

function filteredEquipmentSites() {
  const q = state.equipmentQuery.trim().toLowerCase();
  const rows = Object.entries(state.equipmentByCsht || {}).map(([maCsht, site]) => {
    const maTrams = Array.isArray(site?.maTrams)
      ? [...new Set(site.maTrams.filter(Boolean).map((x) => formatMaTram(x)).filter(Boolean))]
      : site?.maTram
        ? [formatMaTram(site.maTram)].filter(Boolean)
        : [];
    return {
      maCsht,
      maTram: formatMaTram((site && site.maTram) || maTrams[0] || ''),
      maTrams,
      tenTram: (site && site.tenTram) || '',
      lat: site?.lat ?? null,
      long: site?.long ?? null,
      site: site || {},
    };
  });
  rows.sort((a, b) =>
    (a.maTram || a.maCsht).localeCompare(b.maTram || b.maCsht, 'vi')
  );
  const matched = !q
    ? rows
    : rows.filter((r) => {
        const hay = `${r.maCsht} ${r.maTram} ${r.maTrams.join(' ')} ${r.tenTram}`.toLowerCase();
        return hay.includes(q);
      });
  return applyEquipmentNearestFilter(matched);
}

function exportEquipmentExcel() {
  const list = filteredEquipmentSites();
  if (!list.length) {
    toast('Không có CSHT nào để xuất');
    return;
  }
  const sheets = [];

  // Sheet danh sách CSHT (giống mục lục)
  sheets.push({
    name: 'Danh sách CSHT',
    rows: [
      ['STT', 'Mã CSHT', 'Mã trạm', 'Các mã trạm', 'Tên trạm', 'LAT', 'LONG'],
      ...list.map((r, i) => [
        i + 1,
        r.maCsht,
        r.maTram || '',
        (r.maTrams || []).join(', '),
        r.tenTram || '',
        r.lat,
        r.long,
      ]),
    ],
  });

  // Mỗi loại thiết bị = 1 sheet (định dạng gần ex.xlsx: header + dòng thiết bị)
  for (const typeDef of equipmentTypes()) {
    const headers = [
      'STT',
      'Mã CSHT(*)',
      'Mã trạm',
      'Tên trạm',
      'LAT',
      'LONG',
      ...typeDef.fields.map((f) => f.label),
    ];
    const dataRows = [];
    let stt = 0;
    for (const r of list) {
      const devices = equipmentDevicesByCsht(r.maCsht)[typeDef.id] || [];
      if (!devices.length) continue;
      for (const d of devices) {
        stt += 1;
        dataRows.push([
          stt,
          r.maCsht,
          r.maTram || '',
          r.tenTram || '',
          r.lat,
          r.long,
          ...typeDef.fields.map((f) => (d[f.key] != null && d[f.key] !== '' ? d[f.key] : '')),
        ]);
      }
    }
    sheets.push({ name: typeDef.title, rows: [headers, ...dataRows] });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  downloadExcelWorkbook(sheets, `bao-cao-thiet-bi-${stamp}`);
  toast(`Đã xuất ${list.length} CSHT · ${sheets.length} sheet`);
}

function renderEquipmentList() {
  const root = $('#equipment-list');
  const empty = $('#equipment-empty');
  const summary = $('#equipment-summary');
  if (!root || !empty) return;
  const syncBtn = $('#equipment-sync-mayno');
  if (syncBtn) syncBtn.hidden = !isRootUser();
  syncEquipmentGeoFilterControl();
  const list = filteredEquipmentSites();
  if (summary) {
    summary.hidden = false;
    if (state.geoLocating && state.equipmentGeoFilter === 'nearest') {
      summary.textContent = 'Đang lấy GPS…';
    } else {
      summary.textContent = `${list.length} CSHT`;
    }
  }
  if (!list.length) {
    root.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = state.equipmentQuery.trim()
      ? `<p class="empty-title">Không tìm thấy CSHT</p><p class="empty-desc">Thử mã hoặc tên khác.</p>`
      : state.equipmentGeoFilter === 'nearest'
        ? `<p class="empty-title">Không có CSHT gần bạn</p><p class="empty-desc">Cần tọa độ LAT/LONG trên CSHT, hoặc chọn Tất cả.</p>`
        : `<p class="empty-title">Chưa có dữ liệu thiết bị</p>`;
    return;
  }
  empty.hidden = true;
  root.innerHTML = list
    .map((r, index) => {
      const geo =
        r.lat != null && r.long != null
          ? `${escapeHtml(String(r.lat))}, ${escapeHtml(String(r.long))}`
          : '—';
      const showGeo = isEquipmentNearestFilter();
      const distM = showGeo ? siteDistanceMeters(r) : null;
      const distNear = distM != null && distM <= GEO_NEAR_M;
      const distHtml = !showGeo
        ? ''
        : distM != null
          ? `<p class="station-dist${distNear ? ' is-near' : ''}">${
              distNear ? 'Gần vị trí · ' : 'Lệch vị trí · '
            }${escapeHtml(formatDistanceMeters(distM))}</p>`
          : `<p class="station-dist is-missing">Chưa có tọa độ — kiểm tra trước khi cập nhật</p>`;
      const typeParts = equipmentDeviceCountParts(r.site);
      const editor = equipmentSiteEditorLine(r.site);
      const maExtra =
        r.maTrams.length > 1
          ? ` · +${r.maTrams.length - 1} mã`
          : '';
      const hasDetail = typeParts.length > 0;
      const expanded = !!(state.equipmentExpanded && state.equipmentExpanded[r.maCsht]);
      const inventory = hasDetail ? renderEquipmentInventoryHtml(r.site, r.maCsht) : '';
      const detailBtn = hasDetail
        ? `<button type="button" class="btn-outline station-action-btn" data-action="eq-toggle" data-csht="${escapeAttr(
            r.maCsht
          )}">${expanded ? 'Thu gọn' : 'Chi tiết'}</button>`
        : '';
      const hasCoords = siteLatLng(r) != null;
      const dirBtn = hasCoords
        ? `<button type="button" class="btn-outline station-action-btn eq-directions-btn" data-action="eq-directions" data-csht="${escapeAttr(
            r.maCsht
          )}">Chỉ đường</button>`
        : `<button type="button" class="btn-outline station-action-btn eq-directions-btn" disabled title="Chưa có tọa độ">Chỉ đường</button>`;
      return `<article class="station-card${expanded ? ' is-eq-expanded' : ''}${
        distNear ? ' is-geo-near' : ''
      }" data-csht="${escapeAttr(r.maCsht)}" style="--i:${index}">
        <div class="station-accent" aria-hidden="true"></div>
        <header class="station-top">
          <div class="station-id">
            <span class="station-code">${escapeHtml(r.maTram || r.maCsht)}</span>
          </div>
          ${dirBtn}
        </header>
        <p class="station-name">${escapeHtml(r.tenTram || 'Chưa có tên')}</p>
        <p class="station-addr">${escapeHtml(r.maCsht)}${escapeHtml(maExtra)} · LAT/LONG: ${geo}</p>
        ${distHtml}
        <div class="station-kv">
          <div class="station-kv-row station-kv-action eq-kv-stack">
            <div class="station-kv-text eq-kv-types">
              <span class="station-kv-l">Thiết bị</span>
              <div class="station-kv-v eq-type-wrap">${equipmentDeviceCountHtml(r.site)}</div>
            </div>
            <div class="eq-card-actions">
              <button type="button" class="btn-outline station-action-btn" data-action="equipment" data-csht="${escapeAttr(
                r.maCsht
              )}">Thêm</button>
              ${detailBtn}
            </div>
          </div>
        </div>
        ${
          hasDetail
            ? `<div class="eq-detail-panel" ${expanded ? '' : 'hidden'}>
          ${inventory}
          ${editor ? `<p class="eq-card-footer">${escapeHtml(editor)}</p>` : ''}
        </div>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function openEquipmentSheet(maCsht, typeId = null, index = 0, opts = {}) {
  const csht = String(maCsht || '').trim();
  if (!csht) {
    toast('Thiếu mã CSHT');
    return;
  }
  state.selectedCsht = csht;
  state.selectedKey = null;
  state.sheetMode = 'equipment';
  state.equipmentFocus = {
    typeId: typeId || null,
    index: Number.isFinite(Number(index)) ? Number(index) : 0,
    addNew: !!opts.addNew,
  };
  const sheet = $('#detail-sheet');
  if (sheet) {
    sheet.dataset.bound = '';
    sheet.dataset.mode = 'equipment';
  }
  stopRunHistoryListener();
  render();
  ensureEquipmentKindsLoaded().then(() => {
    if (state.sheetMode === 'equipment' && equipmentDraft) {
      fillKindSelect(equipmentDraft.typeId, $('#eq-kind-from')?.value || '');
    }
  });
}

function ensureEquipmentDraft(csht, sheet) {
  const key = String(csht || '').trim();
  const focus = state.equipmentFocus || {};
  const wantsRetarget =
    !!equipmentDraft &&
    equipmentDraft.maCsht === key &&
    sheet.dataset.bound === '1' &&
    sheet.dataset.key === key &&
    sheet.dataset.mode === 'equipment' &&
    (focus.typeId || focus.addNew);
  const needsInit =
    !equipmentDraft ||
    equipmentDraft.maCsht !== key ||
    !sheet.dataset.bound ||
    sheet.dataset.key !== key ||
    sheet.dataset.mode !== 'equipment' ||
    wantsRetarget;
  if (!needsInit) return;
  const byType = {};
  const existingMap = equipmentDevicesByCsht(key);
  for (const t of equipmentTypes()) {
    const existing = existingMap[t.id] || [];
    byType[t.id] = existing.map((d) => ({ ...d }));
  }
  const mayNoProfile = bestStationProfileForCsht(key);
  if (mayNoProfile) {
    const applied = applyMayNoMapToMayPhatList(byType.may_phat_dien || [], mayNoProfile);
    byType.may_phat_dien = applied.list;
  }
  const prefer =
    (focus.typeId && equipmentTypeById(focus.typeId) ? focus.typeId : null) ||
    equipmentTypes().find((t) => (byType[t.id] || []).length)?.id ||
    equipmentTypes()[0]?.id ||
    'may_phat_dien';
  let idx = Number(focus.index);
  if (!Number.isFinite(idx) || idx < 0) idx = 0;
  let preferList = byType[prefer] || [];
  const mode = focus.addNew ? 'add' : 'edit';
  if (focus.addNew) {
    const last = preferList[preferList.length - 1];
    if (preferList.length && last && !countEquipmentDataFields(last)) {
      idx = preferList.length - 1;
    } else {
      preferList = [...preferList, {}];
      byType[prefer] = preferList;
      idx = preferList.length - 1;
    }
  } else {
    if (!preferList.length) {
      preferList = [{}];
      byType[prefer] = preferList;
      idx = 0;
    } else if (idx >= preferList.length) {
      idx = preferList.length - 1;
    }
  }
  equipmentDraft = {
    maCsht: key,
    typeId: prefer,
    index: idx,
    byType,
    mode,
    dirty: false,
  };
  state.equipmentFocus = null;
  sheet.dataset.key = key;
  sheet.dataset.mode = 'equipment';
  sheet.dataset.bound = '1';
  const fields = $('#eq-fields');
  if (fields) fields.dataset.stamp = '';
  const kindSel = $('#eq-kind-from');
  if (kindSel) kindSel.value = '';
}

function captureEquipmentFormIntoDraft() {
  if (!equipmentDraft) return;
  const typeDef = equipmentTypeById(equipmentDraft.typeId);
  if (!typeDef) return;
  const root = $('#eq-fields');
  if (!root) return;
  // Tránh ghi đè nhầm khi DOM form chưa khớp thiết bị đang chọn (sau Thêm / đổi #).
  const expected = `${equipmentDraft.maCsht}|${equipmentDraft.typeId}|${equipmentDraft.index}`;
  if (root.dataset.stamp && root.dataset.stamp !== expected) return;
  let vals = readEquipmentFormValues(typeDef, root);
  if (equipmentDraft.typeId === 'binh_acquy') {
    vals = applyBinhAcquyInferredFields(vals);
  }
  const list = equipmentDraft.byType[equipmentDraft.typeId] || [];
  while (list.length <= equipmentDraft.index) list.push({});
  // Không thay bản nháp đã có bằng object rỗng (mất thiết bị cũ).
  if (!countEquipmentDataFields(vals) && countEquipmentDataFields(list[equipmentDraft.index])) {
    return;
  }
  list[equipmentDraft.index] = vals;
  equipmentDraft.byType[equipmentDraft.typeId] = list;
}

function renderEquipmentEditor(csht, forceFields = false) {
  if (!equipmentDraft) return;
  const key = String(csht || equipmentDraft.maCsht || '').trim();
  const typeSel = $('#eq-type');
  const idxSel = $('#eq-device-index');
  const hint = $('#eq-csht-hint');
  const site = equipmentSiteByCsht(key) || {};
  if (hint) {
    const geo =
      site.lat != null && site.long != null ? ` · LAT ${site.lat}, LONG ${site.long}` : '';
    const ten = site.tenTram ? ` · ${site.tenTram}` : '';
    const ma = site.maTram ? ` · ${formatMaTram(site.maTram)}` : '';
    const showGeo = isEquipmentNearestFilter();
    const distM = showGeo ? siteDistanceMeters(site) : null;
    const dist =
      distM != null
        ? ` · ${formatDistanceMeters(distM)}${distM <= GEO_NEAR_M ? ' (gần vị trí)' : ' (lệch vị trí — kiểm tra lại CSHT)'}`
        : showGeo
          ? ' · Chưa có tọa độ'
          : '';
    hint.textContent = `CSHT: ${key}${ma}${ten}${geo}${dist}. Chỉ cập nhật chủng loại và thông số kỹ thuật.`;
  }
  const metaEl = $('#eq-editor-meta');
  if (metaEl) {
    const meta = equipmentTypeMeta(site, equipmentDraft.typeId);
    if (meta.lastEditedBy || meta.lastEditedAt) {
      metaEl.hidden = false;
      const when = meta.lastEditedAt ? formatMillis(Number(meta.lastEditedAt)) : '—';
      metaEl.textContent = `Cập nhật bởi ${meta.lastEditedBy || '—'} · ${when}`;
    } else {
      metaEl.hidden = true;
      metaEl.textContent = '';
    }
  }
  if (typeSel && typeSel.dataset.filled !== '1') {
    typeSel.innerHTML = equipmentTypes()
      .map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`)
      .join('');
    typeSel.dataset.filled = '1';
  }
  if (typeSel) typeSel.value = equipmentDraft.typeId;
  const list = equipmentDraft.byType[equipmentDraft.typeId] || [];
  if (!list.length) {
    list.push({});
    equipmentDraft.byType[equipmentDraft.typeId] = list;
  }
  if (equipmentDraft.index >= list.length) equipmentDraft.index = 0;
  const unit = equipmentUnitLabel(equipmentDraft.typeId);
  const idxLabel = $('#eq-device-index-label');
  if (idxLabel) idxLabel.textContent = `${unit} #`;
  const addBtn = $('#eq-add-device');
  if (addBtn) addBtn.textContent = `+ Thêm ${unit}`;
  if (idxSel) {
    idxSel.innerHTML = list
      .map((_, i) => `<option value="${i}">${escapeHtml(equipmentUnitOptionLabel(equipmentDraft.typeId, i))}</option>`)
      .join('');
    idxSel.value = String(equipmentDraft.index);
  }
  const typeDef = equipmentTypeById(equipmentDraft.typeId);
  const fields = $('#eq-fields');
  const stamp = `${equipmentDraft.maCsht}|${equipmentDraft.typeId}|${equipmentDraft.index}`;
  if (fields && typeDef && (forceFields || fields.dataset.stamp !== stamp)) {
    fields.innerHTML = buildEquipmentFieldsHtml(typeDef, list[equipmentDraft.index] || {});
    fields.dataset.stamp = stamp;
  }
  // Đổ list mẫu theo đúng thiết bị đang mở (không giữ value loại TB trước đó).
  fillKindSelect(equipmentDraft.typeId, '');
}

function onEquipmentTypeChange() {
  captureEquipmentFormIntoDraft();
  if (!equipmentDraft) return;
  equipmentDraft.typeId = $('#eq-type')?.value || equipmentDraft.typeId;
  equipmentDraft.index = 0;
  renderEquipmentEditor(equipmentDraft.maCsht, true);
}

function onEquipmentIndexChange() {
  captureEquipmentFormIntoDraft();
  if (!equipmentDraft) return;
  equipmentDraft.index = Number($('#eq-device-index')?.value || 0) || 0;
  renderEquipmentEditor(equipmentDraft.maCsht, true);
}

function kindsForType(typeId) {
  const fromRtdb = state.equipmentKinds?.[typeId];
  const map = {};
  if (fromRtdb && typeof fromRtdb === 'object') {
    for (const [k, rec] of Object.entries(fromRtdb)) {
      if (rec && typeof rec === 'object') map[k] = { ...rec, kindKey: k };
    }
  }
  // Bổ sung nhẹ từ draft / CSHT đang mở — không quét cả hệ thống (treo UI).
  const localDevices = [];
  if (equipmentDraft?.byType?.[typeId]) {
    localDevices.push(...equipmentDraft.byType[typeId]);
  }
  const csht = equipmentDraft?.maCsht;
  if (csht && state.equipmentByCsht?.[csht]) {
    localDevices.push(...(normalizeEquipment(state.equipmentByCsht[csht])[typeId] || []));
  }
  for (const d of localDevices) {
    const built = buildEquipmentKindRecord(typeId, d, null);
    if (!built) continue;
    if (!map[built.kindKey]) map[built.kindKey] = { ...built.record, kindKey: built.kindKey };
  }
  return Object.values(map).sort((a, b) =>
    String(equipmentKindLabel(typeId, a) || a.label || '').localeCompare(
      String(equipmentKindLabel(typeId, b) || b.label || ''),
      'vi'
    )
  );
}

let equipmentKindsLoadPromise = null;
function ensureEquipmentKindsLoaded() {
  if (state.equipmentKinds && Object.keys(state.equipmentKinds).length) {
    return Promise.resolve(state.equipmentKinds);
  }
  if (equipmentKindsLoadPromise) return equipmentKindsLoadPromise;
  equipmentKindsLoadPromise = get(ref(db, 'equipmentKinds'))
    .then((snap) => {
      const val = snap.val() || {};
      state.equipmentKinds = val;
      return val;
    })
    .catch(() => state.equipmentKinds || {})
    .finally(() => {
      equipmentKindsLoadPromise = null;
    });
  return equipmentKindsLoadPromise;
}

function fillKindSelect(typeId, preferredKey = '') {
  const sel = $('#eq-kind-from');
  if (!sel) return;
  const kinds = kindsForType(typeId);
  let want = preferredKey || '';
  if (equipmentDraft) {
    const cur = (equipmentDraft.byType?.[typeId] || [])[equipmentDraft.index];
    const match = cur ? equipmentKindKey(typeId, cur) : null;
    if (match && kinds.some((k) => k.kindKey === match)) {
      // Ưu tiên khớp thiết bị đang sửa; chỉ giữ preferred khi trùng.
      if (!want || want === match) want = match;
    } else if (want && !kinds.some((k) => k.kindKey === want)) {
      want = '';
    }
  }
  eqKindSelectSilent = true;
  try {
    sel.innerHTML =
      `<option value="">Loại khác</option>` +
      kinds
        .map((k) => {
          const text = equipmentKindLabel(typeId, k) || k.label || k.kindKey;
          return `<option value="${escapeAttr(k.kindKey)}">${escapeHtml(text)}</option>`;
        })
        .join('');
    sel.value = want && [...sel.options].some((o) => o.value === want) ? want : '';
    sel.disabled = false;
    const kindLab = sel.parentElement?.querySelector('label[for="eq-kind-from"]');
    if (kindLab) {
      kindLab.textContent =
        typeId === 'may_phat_dien' || typeId === 'dieu_hoa'
          ? 'Theo loại có sẵn (tên · model · công suất)'
          : 'Theo loại có sẵn (hãng · model)';
    }
    const hint = sel.parentElement?.querySelector('.muted.tiny');
    if (hint) {
      const editing = equipmentDraft?.mode === 'edit';
      hint.textContent = kinds.length
        ? editing
          ? `${kinds.length} loại có sẵn · chọn mẫu sẽ ghi đè thông số cố định (serial/IP giữ nguyên).`
          : `${kinds.length} loại có sẵn · chọn để điền thông số cố định. Serial / IP / thẻ tài sản… nhập mới.`
        : 'Chưa có mẫu cho loại này — nhập tay, lần lưu sau sẽ thêm vào danh mục.';
    }
  } finally {
    eqKindSelectSilent = false;
  }
}

function applyKindTemplateToCurrentDevice(kindKey) {
  if (!equipmentDraft) return;
  const typeId = equipmentDraft.typeId;
  const typeDef = equipmentTypeById(typeId);
  if (!typeDef) return;
  const list = equipmentDraft.byType[typeId] || [];
  const idx = equipmentDraft.index;
  while (list.length <= idx) list.push({});
  const current = { ...(list[idx] || {}) };

  // Loại khác: xóa hết field để nhập tay từ đầu (sau khi xem mẫu không khớp).
  if (!kindKey) {
    const blank = {};
    list[idx] = blank;
    equipmentDraft.byType[typeId] = list;
    equipmentDraft.mode = equipmentDraft.mode || 'add';
    const fields = $('#eq-fields');
    if (fields) fields.dataset.stamp = '';
    renderEquipmentEditor(equipmentDraft.maCsht, true);
    fillKindSelect(typeId, '');
    toast('Đã chọn Loại khác — form trống, nhập thông số mới');
    return;
  }

  const kinds = kindsForType(typeId);
  const kind = kinds.find((k) => k.kindKey === kindKey);
  if (!kind) {
    toast('Không tìm thấy loại thiết bị');
    return;
  }
  const shared = sharedFieldsFromDevice(typeDef, kind);
  let next = { ...current };
  for (const f of typeDef.fields) {
    if (isUniqueEquipmentField(f.key)) continue;
    if (shared[f.key] != null) next[f.key] = shared[f.key];
  }
  if (typeId === 'binh_acquy') next = applyBinhAcquyInferredFields(next);
  list[idx] = next;
  equipmentDraft.byType[typeId] = list;
  renderEquipmentEditor(equipmentDraft.maCsht, true);
  fillKindSelect(typeId, kindKey);
  toast(`Đã áp dụng loại: ${equipmentKindLabel(typeId, kind) || kind.label || kindKey}`);
}

function addEquipmentDevice() {
  captureEquipmentFormIntoDraft();
  if (!equipmentDraft) return;
  const typeId = equipmentDraft.typeId;
  const list = [...(equipmentDraft.byType[typeId] || [])];
  list.push({});
  equipmentDraft.byType[typeId] = list;
  equipmentDraft.index = list.length - 1;
  equipmentDraft.mode = 'add';
  // Đánh dấu form DOM lệch index để capture không ghi đè nhầm trước khi render.
  const fields = $('#eq-fields');
  if (fields) fields.dataset.stamp = '';
  const saveBtn = $('#detail-save-equipment');
  if (saveBtn) saveBtn.textContent = 'Lưu thiết bị mới';
  const badge = $('#detail-mode-badge');
  if (badge) badge.textContent = 'Thêm TB';
  renderEquipmentEditor(equipmentDraft.maCsht, true);
  fillKindSelect(typeId, '');
}

async function upsertEquipmentKindsFromDevices(typeId, devices, who) {
  if (!typeId || !Array.isArray(devices) || !devices.length) return;
  const updates = {};
  for (const d of devices) {
    const built = buildEquipmentKindRecord(typeId, d, who);
    if (!built) continue;
    updates[`${typeId}/${built.kindKey}`] = built.record;
  }
  if (!Object.keys(updates).length) return;
  await update(ref(db, 'equipmentKinds'), updates);
}

function deleteEquipmentDeviceFromDraft() {
  captureEquipmentFormIntoDraft();
  if (!equipmentDraft) return;
  const list = equipmentDraft.byType[equipmentDraft.typeId] || [];
  if (!list.length) {
    toast('Không có thiết bị để xóa');
    return;
  }
  const unit = equipmentUnitOptionLabel(equipmentDraft.typeId, equipmentDraft.index);
  if (!confirm(`Xóa ${unit}?`)) return;
  list.splice(equipmentDraft.index, 1);
  equipmentDraft.byType[equipmentDraft.typeId] = list;
  if (!list.length) list.push({});
  equipmentDraft.index = Math.min(equipmentDraft.index, list.length - 1);
  equipmentDraft.dirty = true;
  renderEquipmentEditor(equipmentDraft.maCsht, true);
  toast('Đã xóa khỏi bản nháp — nhớ Lưu thiết bị');
}

async function deleteEquipmentDeviceDirect(maCsht, typeId, index) {
  const csht = String(maCsht || '').trim();
  const typeDef = equipmentTypeById(typeId);
  if (!csht || !typeDef) return;
  const site = equipmentSiteByCsht(csht) || {};
  const devices = [...(equipmentDevicesByCsht(csht)[typeId] || [])];
  if (index < 0 || index >= devices.length) {
    toast('Không tìm thấy thiết bị');
    return;
  }
  const unit = equipmentUnitOptionLabel(typeId, index);
  if (!confirm(`Xóa ${unit} khỏi ${csht}?`)) return;
  devices.splice(index, 1);
  const who = currentUserLabel();
  const cleanDevices = devices
    .map((d) => {
      const clean = {};
      for (const f of typeDef.fields) {
        if (d[f.key] != null && String(d[f.key]).trim() !== '') clean[f.key] = String(d[f.key]).trim();
      }
      if (d.lastEditedBy) clean.lastEditedBy = d.lastEditedBy;
      if (d.lastEditedAt) clean.lastEditedAt = d.lastEditedAt;
      return clean;
    })
    .filter((d) => Object.keys(d).some((k) => !k.startsWith('lastEdited')));
  const payload = equipmentPayload(cleanDevices, who, state.user.uid, 'manual');
  try {
    await update(ref(db, `equipment/${csht}`), {
      ...equipmentSiteMetaPatch(csht, site, who),
      [typeId]: {
        devices: payload.devices,
        lastEditedBy: who,
        lastEditedByUid: state.user.uid,
        lastEditedAt: serverTimestamp(),
        source: 'manual',
      },
    });
    toast(`Đã xóa ${unit}`);
    render();
  } catch (e) {
    toast('Xóa thất bại: ' + (e.message || e));
  }
}

async function saveEquipment() {
  if (!state.user || !equipmentDraft) return;
  captureEquipmentFormIntoDraft();
  const typeId = equipmentDraft.typeId;
  const typeDef = equipmentTypeById(typeId);
  if (!typeDef) {
    toast('Loại thiết bị không hợp lệ');
    return;
  }
  const who = currentUserLabel();
  const nowMs = Date.now();
  const devices = (equipmentDraft.byType[typeId] || [])
    .map((raw) => {
      const d = typeId === 'binh_acquy' ? applyBinhAcquyInferredFields(raw) : raw;
      const clean = {};
      for (const f of typeDef.fields) {
        if (d[f.key] != null && String(d[f.key]).trim() !== '') clean[f.key] = String(d[f.key]).trim();
      }
      if (!Object.keys(clean).length) return null;
      clean.lastEditedBy = who;
      clean.lastEditedAt = nowMs;
      return clean;
    })
    .filter(Boolean);
  const csht = (equipmentDraft.maCsht || '').trim();
  if (!csht) {
    toast('Thiếu mã CSHT — không lưu được thiết bị');
    return;
  }
  // Lưu form trống sẽ làm Firebase bỏ `devices: {}` → mất MPD trên list.
  if (!devices.length) {
    const existingN = (equipmentDevicesByCsht(csht)[typeId] || []).length;
    if (existingN) {
      if (
        !confirm(
          `Đang lưu ${typeDef.title} trống — sẽ xóa ${existingN} thiết bị đã có trên CSHT này. Tiếp tục?`
        )
      ) {
        return;
      }
    }
  }
  const payload = equipmentPayload(devices, who, state.user.uid, 'manual');
  try {
    const site = equipmentSiteByCsht(csht) || {};
    await update(ref(db, `equipment/${csht}`), {
      ...equipmentSiteMetaPatch(csht, site, who),
      [typeId]: {
        devices: Object.keys(payload.devices).length ? payload.devices : null,
        lastEditedBy: who,
        lastEditedByUid: state.user.uid,
        lastEditedAt: serverTimestamp(),
        source: payload.source,
      },
    });
    // Cập nhật danh mục loại TB toàn hệ thống (hãng+model → thông số cố định)
    upsertEquipmentKindsFromDevices(typeId, devices, who).catch(() => {});
    const mode = equipmentDraft.mode;
    const sheet = $('#detail-sheet');
    if (sheet) sheet.dataset.bound = '';
    equipmentDraft = null;
    toast(
      devices.length
        ? mode === 'edit'
          ? `Đã cập nhật ${typeDef.title}`
          : `Đã lưu ${devices.length} ${typeDef.title}`
        : `Đã xóa dữ liệu ${typeDef.title}`
    );
    state.selectedCsht = null;
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
  $('#equipment-search')?.addEventListener('input', (e) => {
    state.equipmentQuery = e.target.value;
    renderEquipmentList();
  });
  $('#equipment-geo-filter')?.addEventListener('change', (e) => {
    onEquipmentGeoFilterChange(e.target.value || 'all');
  });
  $('#equipment-export-excel')?.addEventListener('click', () => {
    exportEquipmentExcel();
  });
  $('#equipment-sync-mayno')?.addEventListener('click', async () => {
    if (!isRootUser()) {
      toast('Chỉ root được đồng bộ');
      return;
    }
    const btn = $('#equipment-sync-mayno');
    if (btn) btn.disabled = true;
    try {
      toast('Đang đồng bộ Máy nổ → Máy phát điện…');
      const { updated, total } = await syncAllMayNoStationsToEquipment();
      toast(`Đã đồng bộ ${updated}/${total || 0} CSHT từ Máy nổ`);
      renderEquipmentList();
    } catch (e) {
      toast('Đồng bộ thất bại: ' + (e.message || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $('#equipment-list')?.addEventListener('click', (e) => {
    const dirBtn = e.target.closest('[data-action="eq-directions"][data-csht]');
    if (dirBtn) {
      e.preventDefault();
      e.stopPropagation();
      const site = state.equipmentByCsht?.[dirBtn.dataset.csht];
      openSiteDirections(site || { lat: null, long: null });
      return;
    }
    const toggleBtn = e.target.closest('[data-action="eq-toggle"][data-csht]');
    if (toggleBtn) {
      e.preventDefault();
      const csht = toggleBtn.dataset.csht;
      if (!state.equipmentExpanded) state.equipmentExpanded = {};
      state.equipmentExpanded[csht] = !state.equipmentExpanded[csht];
      renderEquipmentList();
      return;
    }
    const editBtn = e.target.closest('[data-action="eq-edit"][data-csht]');
    if (editBtn) {
      e.preventDefault();
      openEquipmentSheet(editBtn.dataset.csht, editBtn.dataset.type, editBtn.dataset.index);
      return;
    }
    const delBtn = e.target.closest('[data-action="eq-delete"][data-csht]');
    if (delBtn) {
      e.preventDefault();
      deleteEquipmentDeviceDirect(delBtn.dataset.csht, delBtn.dataset.type, Number(delBtn.dataset.index));
      return;
    }
    const btn = e.target.closest('[data-action="equipment"][data-csht]');
    if (!btn) return;
    e.preventDefault();
    openEquipmentSheet(btn.dataset.csht, null, 0, { addNew: true });
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
    else if (action === 'lock') openStationSheet(key, 'lock');
    else if (action === 'station') openStationSheet(key, 'station');
    else if (action === 'delete') openStationSheet(key, 'delete');
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
    const detailBtn = e.target.closest('[data-alarm-detail]');
    if (detailBtn) {
      const info = JSON.parse(detailBtn.dataset.alarmDetail);
      const cause = (info.cause && String(info.cause).trim()) || '—';
      const detail = (info.detail && String(info.detail).trim()) || '—';
      const src = info.source ? `\nNguồn: ${info.source}` : '';
      alert(`${info.title || 'Chi tiết cảnh báo'}${src}\n\nNguyên nhân: ${cause}\n\nChi tiết: ${detail}`);
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
  $('#detail-save-lock')?.addEventListener('click', saveLockCode);
  $('#detail-save-station')?.addEventListener('click', saveStationInfo);
  $('#detail-save-equipment')?.addEventListener('click', saveEquipment);
  $('#eq-type')?.addEventListener('change', onEquipmentTypeChange);
  $('#eq-device-index')?.addEventListener('change', onEquipmentIndexChange);
  $('#eq-kind-from')?.addEventListener('change', (e) => {
    if (eqKindSelectSilent) return;
    captureEquipmentFormIntoDraft();
    applyKindTemplateToCurrentDevice(e.target.value || '');
  });
  $('#eq-add-device')?.addEventListener('click', addEquipmentDevice);
  $('#eq-delete-device')?.addEventListener('click', deleteEquipmentDeviceFromDraft);
  $('#eq-fields')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-eq-qr]');
    if (!btn) return;
    const key = btn.getAttribute('data-eq-qr');
    if (!key) return;
    const input = $(`#eq-f-${CSS.escape(key)}`) || $(`[data-eq-key="${CSS.escape(key)}"]`);
    if (!input) return;
    btn.disabled = true;
    try {
      const raw = await openQrScanner();
      if (raw) {
        input.value = raw;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        toast('Đã quét serial từ mã');
        input.focus();
      }
    } finally {
      btn.disabled = false;
    }
  });
  $('#eq-fields')?.addEventListener('input', (e) => {
    if (!equipmentDraft || equipmentDraft.typeId !== 'binh_acquy') return;
    const key = e.target?.getAttribute?.('data-eq-key');
    if (!key || !['serial', 'hang_san_xuat', 'model'].includes(key)) return;
    const typeDef = equipmentTypeById('binh_acquy');
    const root = $('#eq-fields');
    if (!typeDef || !root) return;
    let vals = applyBinhAcquyInferredFields(readEquipmentFormValues(typeDef, root));
    // Năm SX chỉ suy ra khi vừa quét/nhập serial (không theo hãng/model).
    const touchYear = key === 'serial';
    if (touchYear) vals = applyPostefAcquyYearFromSerial(vals);
    const keysToWrite = touchYear
      ? ['cong_nghe_accu', 'dien_ap_binh', 'dung_luong_binh', 'hang_san_xuat', 'model', 'nam_san_xuat']
      : ['cong_nghe_accu', 'dien_ap_binh', 'dung_luong_binh', 'hang_san_xuat', 'model'];
    for (const f of typeDef.fields) {
      if (!keysToWrite.includes(f.key)) continue;
      const el = root.querySelector(`[data-eq-key="${CSS.escape(f.key)}"]`);
      if (!el || vals[f.key] == null) continue;
      if (el.value !== String(vals[f.key])) el.value = String(vals[f.key]);
    }
  });
  $('#detail-delete-station')?.addEventListener('click', () => {
    deleteStation(state.selectedKey);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isQrScannerOpen()) {
      closeQrScanner();
      return;
    }
    closeDetail();
  });
}

function closeDetail() {
  closeQrScanner();
  state.selectedKey = null;
  state.selectedCsht = null;
  state.sheetMode = null;
  state.equipmentFocus = null;
  equipmentDraft = null;
  const sheet = $('#detail-sheet');
  if (sheet) {
    sheet.dataset.bound = '';
    sheet.dataset.key = '';
    sheet.dataset.mode = '';
  }
  const fields = $('#eq-fields');
  if (fields) {
    fields.innerHTML = '';
    fields.dataset.stamp = '';
  }
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
  onValue(ref(db, 'equipment'), (snap) => {
    if (!state.user) return;
    state.equipmentByCsht = snap.val() || {};
    render();
  });
  onValue(
    ref(db, 'equipmentKinds'),
    (snap) => {
      if (!state.user) return;
      state.equipmentKinds = snap.val() || {};
      if (state.sheetMode === 'equipment' && equipmentDraft) {
        fillKindSelect(equipmentDraft.typeId, $('#eq-kind-from')?.value || '');
      }
    },
    () => {
      /* permission / network — vẫn dùng fallback local khi mở sheet */
    }
  );
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
