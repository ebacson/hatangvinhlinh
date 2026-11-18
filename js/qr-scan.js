/** Quét QR / Code 128 bằng camera (BarcodeDetector, fallback jsQR cho QR). */

const BARCODE_FORMATS = [
  'qr_code',
  'code_128',
  'code_39',
  'code_93',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'itf',
  'codabar',
  'data_matrix',
  'pdf417',
  'aztec',
];
/** Một lần đọc ổn là nhận; mã rất ngắn (<6) vẫn cần 2 lần để giảm đọc nhầm. */
const CONFIRM_HITS = 1;
const CONFIRM_HITS_SHORT = 2;
const SHORT_CODE_LEN = 6;
/** Quét dày hơn — khoảng cách tối thiểu giữa hai vòng detect. */
const SCAN_GAP_MS = 55;

let active = null;

function ensureOverlay() {
  let el = document.getElementById('qr-scan-overlay');
  if (el && !el.querySelector('[data-scan-mode]')) {
    el.remove();
    el = null;
  }
  if (el) return el;
  el = document.createElement('div');
  el.id = 'qr-scan-overlay';
  el.className = 'qr-scan-overlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="qr-scan-panel" role="dialog" aria-modal="true" aria-label="Quét mã">
      <div class="qr-scan-head">
        <strong>Quét mã</strong>
        <button type="button" class="btn-text" data-qr-close>Đóng</button>
      </div>
      <div class="qr-scan-mode" role="tablist" aria-label="Loại mã">
        <button type="button" data-scan-mode="barcode" class="is-active" role="tab" aria-selected="true">Barcode</button>
        <button type="button" data-scan-mode="qr" role="tab" aria-selected="false">QR</button>
      </div>
      <div class="qr-scan-video-wrap">
        <video playsinline muted autoplay></video>
        <div class="qr-scan-frame is-barcode" aria-hidden="true"></div>
      </div>
      <p class="qr-scan-hint muted tiny" data-qr-hint>Đưa barcode ngang vào khung — chạm màn hình để lấy nét lại.</p>
      <p class="qr-scan-status muted tiny" data-qr-status hidden></p>
    </div>`;
  document.body.appendChild(el);
  return el;
}

/** inset % theo mode — khớp CSS .qr-scan-frame.is-barcode / .is-qr */
function viewfinderInsets(mode, loosen = 0) {
  if (mode === 'qr') {
    return {
      insetX: Math.max(0.04, 0.14 - loosen),
      insetY: Math.max(0.05, 0.18 - loosen),
    };
  }
  // Barcode: chữ nhật ngang
  return {
    insetX: Math.max(0.02, 0.05 - loosen * 0.5),
    insetY: Math.max(0.28, 0.36 - loosen),
  };
}

function applyScanFrameMode(overlay, mode) {
  const frame = overlay?.querySelector?.('.qr-scan-frame');
  const hint = overlay?.querySelector?.('[data-qr-hint]');
  const buttons = overlay?.querySelectorAll?.('[data-scan-mode]') || [];
  const next = mode === 'qr' ? 'qr' : 'barcode';
  if (frame) {
    frame.classList.toggle('is-qr', next === 'qr');
    frame.classList.toggle('is-barcode', next === 'barcode');
  }
  for (const btn of buttons) {
    const on = btn.getAttribute('data-scan-mode') === next;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (hint) {
    hint.textContent =
      next === 'qr'
        ? 'Đưa QR vào khung vuông — chạm màn hình để lấy nét lại.'
        : 'Đưa barcode ngang vào khung chữ nhật — chạm màn hình để lấy nét lại.';
  }
  return next;
}

function setStatus(el, text) {
  if (!el) return;
  const msg = String(text || '').trim();
  el.textContent = msg;
  el.hidden = !msg;
}

function loadJsQR() {
  if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./jsqr.min.js', import.meta.url).href;
    s.async = true;
    s.onload = () => {
      if (typeof window.jsQR === 'function') resolve(window.jsQR);
      else reject(new Error('jsQR không tải được'));
    };
    s.onerror = () => reject(new Error('Không tải được thư viện quét mã'));
    document.head.appendChild(s);
  });
}

async function createBarcodeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    let formats = BARCODE_FORMATS.slice();
    if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (Array.isArray(supported) && supported.length) {
        formats = BARCODE_FORMATS.filter((f) => supported.includes(f));
      }
    }
    if (formats.length) return new window.BarcodeDetector({ formats });
    return new window.BarcodeDetector();
  } catch {
    try {
      return new window.BarcodeDetector();
    } catch {
      return null;
    }
  }
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** Bật lấy nét liên tục + ưu tiên vùng giữa khung (tem/serial gần). */
async function enableContinuousAutofocus(track, point) {
  if (!track?.applyConstraints) return false;
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() || {} : {};
  const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
  const poi =
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? [{ x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) }]
      : [{ x: 0.5, y: 0.5 }];

  const advanced = {};
  if (modes.includes('continuous')) advanced.focusMode = 'continuous';
  else if (modes.includes('single-shot')) advanced.focusMode = 'single-shot';
  if (caps.pointsOfInterest) advanced.pointsOfInterest = poi;

  // Tem thiết bị thường cách ống kính ~10–25cm — ưu tiên nét gần nếu máy cho chỉnh.
  if (caps.focusDistance && typeof caps.focusDistance === 'object') {
    const min = Number(caps.focusDistance.min);
    const max = Number(caps.focusDistance.max);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      advanced.focusDistance = min + (max - min) * 0.18;
    }
  }

  const tries = [];
  if (Object.keys(advanced).length) {
    tries.push({ advanced: [advanced] });
    if (advanced.focusMode) tries.push({ focusMode: advanced.focusMode });
  } else {
    tries.push({ advanced: [{ focusMode: 'continuous' }] });
    tries.push({ focusMode: 'continuous' });
  }

  let ok = false;
  for (const c of tries) {
    try {
      await track.applyConstraints(c);
      ok = true;
      break;
    } catch {
      /* thử constraint khác */
    }
  }
  return ok;
}

async function openCamera() {
  const attempts = [
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        focusMode: { ideal: 'continuous' },
      },
    },
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        focusMode: { ideal: 'continuous' },
      },
    },
    {
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    },
  ];
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getVideoTracks()[0];
      await enableContinuousAutofocus(track);
      return stream;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Không mở được camera');
}

function preferSerial(values) {
  const uniq = [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
  if (!uniq.length) return '';
  const tagged = uniq.find((v) => /VF[LF]\d{6,}/i.test(v));
  if (tagged) {
    const m = tagged.match(/VF[LF]\d{6,}/i);
    return m ? m[0].toUpperCase() : tagged;
  }
  const plain = uniq.filter((v) => /^[A-Za-z0-9-]{8,}$/.test(v));
  if (plain.length) return plain.sort((a, b) => b.length - a.length)[0];
  return uniq.sort((a, b) => b.length - a.length)[0];
}

/**
 * Vùng khung hình (object-fit: cover) đổi sang pixel của video nguồn.
 * mode: 'barcode' | 'qr' — khớp khung CSS.
 */
function viewfinderSourceRect(video, loosen = 0, mode = 'barcode') {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const rect = video.getBoundingClientRect();
  if (!vw || !vh || !rect.width || !rect.height) return null;
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const offsetX = (rect.width - vw * scale) / 2;
  const offsetY = (rect.height - vh * scale) / 2;
  const { insetX, insetY } = viewfinderInsets(mode, loosen);
  const frameLeft = rect.left + rect.width * insetX;
  const frameTop = rect.top + rect.height * insetY;
  const frameW = rect.width * (1 - insetX * 2);
  const frameH = rect.height * (1 - insetY * 2);
  const sx = Math.max(0, Math.floor((frameLeft - rect.left - offsetX) / scale));
  const sy = Math.max(0, Math.floor((frameTop - rect.top - offsetY) / scale));
  const sw = Math.min(vw - sx, Math.ceil(frameW / scale));
  const sh = Math.min(vh - sy, Math.ceil(frameH / scale));
  const minH = mode === 'barcode' ? 24 : 48;
  if (sw < 48 || sh < minH) return null;
  return { sx, sy, sw, sh };
}

function codeCenter(code) {
  const box = code?.boundingBox;
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
  return {
    x: box.x + (Number(box.width) || 0) / 2,
    y: box.y + (Number(box.height) || 0) / 2,
  };
}

/** Ưu tiên mã trong khung; không có tọa độ hoặc lệch hệ tọa độ thì vẫn lấy mã gần tâm. */
function pickScanValue(codes, video, mode = 'barcode') {
  const list = (codes || []).filter((c) => String(c?.rawValue || '').trim());
  if (!list.length) return '';
  const crop = viewfinderSourceRect(video, 0, mode);
  const inside = crop
    ? list.filter((c) => {
        const p = codeCenter(c);
        if (!p) return true;
        return p.x >= crop.sx && p.x <= crop.sx + crop.sw && p.y >= crop.sy && p.y <= crop.sy + crop.sh;
      })
    : list;
  const pool = inside.length ? inside : list;
  const cx = crop ? crop.sx + crop.sw / 2 : (video.videoWidth || 0) / 2;
  const cy = crop ? crop.sy + crop.sh / 2 : (video.videoHeight || 0) / 2;
  let best = '';
  let bestD = Infinity;
  for (const code of pool) {
    const raw = String(code.rawValue || '').trim();
    const p = codeCenter(code);
    const d = p ? (p.x - cx) ** 2 + (p.y - cy) ** 2 : 0;
    if (d < bestD) {
      bestD = d;
      best = raw;
    }
  }
  return best;
}

export function isQrScannerOpen() {
  return Boolean(active);
}

/** Đóng overlay; nếu đang chờ kết quả thì trả về null. */
export function closeQrScanner() {
  if (!active) return;
  const settle = active.settle;
  cleanupActive();
  if (typeof settle === 'function') settle(null);
}

function cleanupActive() {
  if (!active) return;
  const { overlay, stream, raf, video, focusTimer, onTapFocus } = active;
  if (raf) cancelAnimationFrame(raf);
  if (focusTimer) clearInterval(focusTimer);
  const wrap = overlay?.querySelector?.('.qr-scan-video-wrap');
  if (wrap && onTapFocus) wrap.removeEventListener('click', onTapFocus);
  stopStream(stream);
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  if (overlay) overlay.hidden = true;
  active = null;
}

/**
 * Mở camera và quét QR/Code 128. Trả về chuỗi khi đọc ổn định, hoặc null nếu đóng.
 * @returns {Promise<string|null>}
 */
export function openQrScanner() {
  closeQrScanner();
  const overlay = ensureOverlay();
  const video = overlay.querySelector('video');
  const status = overlay.querySelector('[data-qr-status]');
  const hint = overlay.querySelector('[data-qr-hint]');
  const closeBtn = overlay.querySelector('[data-qr-close]');
  overlay.hidden = false;
  let scanMode = applyScanFrameMode(overlay, 'barcode');
  setStatus(status, 'Đang mở camera…');

  return new Promise(async (resolve) => {
    let settled = false;
    let stream = null;
    let raf = 0;
    let focusTimer = 0;
    let detector = null;
    let jsQR = null;
    const jsQRReady = loadJsQR()
      .then((fn) => {
        jsQR = fn;
        return fn;
      })
      .catch(() => null);
    let lastValue = '';
    let streak = 0;
    let busy = false;
    let lastDone = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanupActive();
      resolve(value);
    };

    const note = (raw) => {
      const value = String(raw || '').trim();
      if (!value) return;
      if (value === lastValue) streak += 1;
      else {
        lastValue = value;
        streak = 1;
      }
      const need = value.length < SHORT_CODE_LEN ? CONFIRM_HITS_SHORT : CONFIRM_HITS;
      if (streak >= need) finish(value);
    };

    const videoWrap = overlay.querySelector('.qr-scan-video-wrap');
    const onTapFocus = (e) => {
      e.stopPropagation();
      const track = stream?.getVideoTracks?.()[0];
      if (!track || !videoWrap) return;
      const rect = videoWrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      enableContinuousAutofocus(track, { x, y }).then((ok) => {
        if (!settled) setStatus(status, ok ? 'Đang lấy nét…' : '');
        if (ok) setTimeout(() => {
          if (!settled) setStatus(status, '');
        }, 700);
      });
    };

    active = {
      overlay,
      stream: null,
      video,
      raf: 0,
      focusTimer: 0,
      onTapFocus,
      settle: finish,
    };

    if (closeBtn) closeBtn.onclick = () => finish(null);
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(null);
    };
    overlay.querySelectorAll('[data-scan-mode]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        scanMode = applyScanFrameMode(overlay, btn.getAttribute('data-scan-mode'));
        lastValue = '';
        streak = 0;
      };
    });
    if (videoWrap) videoWrap.addEventListener('click', onTapFocus);

    const rawValues = (codes) =>
      (codes || []).map((c) => String(c?.rawValue || '').trim()).filter(Boolean);

    /** Phóng vùng khung theo mode — chỉ dùng khi detect video chưa ra kết quả. */
    const drawZoomedViewfinder = () => {
      const crop = viewfinderSourceRect(video, 0.08, scanMode);
      if (!crop) return false;
      const scale =
        scanMode === 'barcode'
          ? Math.min(2.6, 1600 / Math.max(crop.sw, 1))
          : Math.min(2.2, 1280 / Math.max(crop.sw, 1));
      canvas.width = Math.max(1, Math.round(crop.sw * scale));
      canvas.height = Math.max(1, Math.round(crop.sh * scale));
      ctx.imageSmoothingEnabled = false;
      ctx.filter = 'contrast(1.28)';
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
      return true;
    };

    const scanOnce = async () => {
      if (video.readyState < 2 || !video.videoWidth) return '';
      const values = [];
      // 1) Detect trực tiếp từ video — nhanh nhất.
      if (detector) {
        try {
          const hit = preferSerial([pickScanValue(await detector.detect(video), video, scanMode)]);
          if (hit) return hit;
        } catch {
          /* thử canvas */
        }
        // 2) Chỉ khi chưa có kết quả mới crop/phóng + detect lại.
        if (drawZoomedViewfinder()) {
          try {
            values.push(...rawValues(await detector.detect(canvas)));
            const hit = preferSerial(values);
            if (hit) return hit;
          } catch {
            /* canvas không đọc được trên một số máy */
          }
        }
      }
      // 3) jsQR fallback — hữu ích hơn ở mode QR.
      if (!jsQR) jsQR = await jsQRReady;
      if (jsQR && (scanMode === 'qr' || !detector) && drawZoomedViewfinder()) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (code?.data) values.push(String(code.data).trim());
      }
      return preferSerial(values);
    };

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Trình duyệt không hỗ trợ camera');
      }

      detector = await createBarcodeDetector();
      if (!detector) {
        jsQR = await loadJsQR();
        if (hint) hint.textContent = 'Đưa mã QR vào khung (barcode sọc cần Chrome hoặc Safari mới)';
      }

      stream = await openCamera();
      if (settled) {
        stopStream(stream);
        return;
      }
      if (active) active.stream = stream;
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      await enableContinuousAutofocus(track);
      // Nhắc AF thưa hơn — tránh giật nét làm chậm lúc đang đọc mã.
      focusTimer = window.setInterval(() => {
        if (settled) return;
        enableContinuousAutofocus(stream?.getVideoTracks?.()[0]);
      }, 3500);
      if (active) active.focusTimer = focusTimer;
      setStatus(status, '');

      const tick = async () => {
        if (settled) return;
        if (!busy && performance.now() - lastDone >= SCAN_GAP_MS) {
          busy = true;
          try {
            const raw = await scanOnce();
            if (!settled && raw) note(raw);
          } catch {
            /* tiếp tục quét */
          }
          busy = false;
          lastDone = performance.now();
        }
        if (settled) return;
        raf = requestAnimationFrame(tick);
        if (active) active.raf = raf;
      };
      raf = requestAnimationFrame(tick);
      if (active) active.raf = raf;
    } catch (err) {
      const msg =
        err?.name === 'NotAllowedError'
          ? 'Chưa được cấp quyền camera'
          : err?.message || 'Không mở được camera';
      setStatus(status, msg);
      setTimeout(() => finish(null), 1600);
    }
  });
}
