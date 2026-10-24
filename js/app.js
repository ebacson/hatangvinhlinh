import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
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
  tick: Date.now(),
  authMode: 'login',
  stationsBound: false,
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

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  $$('.auth-tab').forEach((t) => {
    const on = t.dataset.authMode === mode;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#field-name').hidden = !isRegister;
  $('#field-password2').hidden = !isRegister;
  $('#auth-name').required = isRegister;
  $('#auth-password2').required = isRegister;
  $('#auth-heading').textContent = isRegister ? 'Tạo tài khoản' : 'Chào mừng trở lại';
  $('#auth-subheading').textContent = isRegister
    ? 'Đăng ký để theo dõi và cập nhật dữ liệu trạm'
    : 'Đăng nhập để tiếp tục quản lý trạm';
  $('.auth-submit-label').textContent = isRegister ? 'Tạo tài khoản' : 'Đăng nhập';
  $('#auth-password').autocomplete = isRegister ? 'new-password' : 'current-password';
  const switchEl = $('#auth-switch');
  if (isRegister) {
    switchEl.innerHTML =
      'Đã có tài khoản? <button type="button" class="auth-switch-btn" data-auth-mode="login">Đăng nhập</button>';
  } else {
    switchEl.innerHTML =
      'Chưa có tài khoản? <button type="button" class="auth-switch-btn" data-auth-mode="register">Đăng ký ngay</button>';
  }
  $('#auth-error').hidden = true;
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
    case 'auth/email-already-in-use':
      return 'Email đã được đăng ký.';
    case 'auth/invalid-email':
      return 'Email không hợp lệ.';
    case 'auth/weak-password':
      return 'Mật khẩu cần ít nhất 6 ký tự.';
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
    default:
      return 'Không thể xác thực. Thử lại.';
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const password2 = $('#auth-password2').value;
  const name = $('#auth-name').value.trim();
  showAuthError('');
  if (state.authMode === 'register') {
    if (!name) {
      showAuthError('Vui lòng nhập họ và tên.');
      return;
    }
    if (password !== password2) {
      showAuthError('Mật khẩu xác nhận không khớp.');
      return;
    }
  }
  setAuthLoading(true);
  try {
    if (state.authMode === 'register') {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await set(ref(db, `users/${cred.user.uid}`), {
        displayName: name,
        email,
        createdAt: serverTimestamp(),
      });
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

  $$('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });
  $$('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== state.tab;
  });

  if (state.tab === 'stations') renderStations();
  if (state.tab === 'alerts') renderAlerts();
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
      const edited = editorLine(s.profile);
      const active = s.mayNoLastAlertType === 'SC' ? '<span class="badge badge-warn">Đang SC</span>' : '';
      return `<article class="card station-card" data-key="${escapeAttr(s.stationKey)}" role="button" tabindex="0">
        <div class="card-title-row"><h3>${title}</h3>${active}</div>
        <p class="muted">${escapeHtml(s.profile.diaChi || '')}</p>
        <p class="forecast">${escapeHtml(forecast)}</p>
        <p class="muted small">${escapeHtml(runLine)}</p>
        <p class="muted small">${escapeHtml(last)}</p>
        ${edited ? `<p class="muted small editor-line">${escapeHtml(edited)}</p>` : ''}
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
  $('#detail-editor').textContent = s.profile.lastEditedBy || '--';
  $('#detail-edited-at').textContent = s.profile.lastEditedAt
    ? formatMillis(s.profile.lastEditedAt)
    : '--';
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
  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode));
  });
  $('#auth-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-auth-mode]');
    if (btn) setAuthMode(btn.dataset.authMode);
  });
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });
}

function closeDetail() {
  state.selectedKey = null;
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
      bindStationsListener();
    } else {
      state.displayName = '';
      state.selectedKey = null;
    }
    render();
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch(() => {});
}

bindEvents();
setAuthMode('login');
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
