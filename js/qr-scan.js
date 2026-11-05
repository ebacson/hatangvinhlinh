/** Quét QR / Code 128 bằng camera (BarcodeDetector, fallback jsQR cho QR). */

const BARCODE_FORMATS = ['qr_code', 'code_128', 'code_39', 'data_matrix'];
/** Hai lần đọc giống nhau, cách nhau một nhịp, mới nhận — tránh khung mờ ra sai. */
const CONFIRM_HITS = 2;
const SCAN_GAP_MS = 140;

let active = null;

function ensureOverlay() {
  let el = document.getElementById('qr-scan-overlay');
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
      <div class="qr-scan-video-wrap">
        <video playsinline muted autoplay></video>
        <div class="qr-scan-frame" aria-hidden="true"></div>
      </div>
      <p class="qr-scan-hint muted tiny" data-qr-hint>Đưa sát mã vạch hoặc QR nhỏ, giữ ngang trong khung</p>
      <p class="qr-scan-status muted tiny" data-qr-status hidden></p>
    </div>`;
  document.body.appendChild(el);
  return el;
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

async function openCamera() {
  const attempts = [
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    },
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    },
  ];
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getVideoTracks()[0];
      try {
        const caps = track?.getCapabilities?.() || {};
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch {
        /* máy không cho chỉnh nét — vẫn quét */
      }
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
 * inset CSS: 18% dọc, 14% ngang. loosen nới vùng để mã nhỏ không phải nằm đúng tâm.
 */
function viewfinderSourceRect(video, loosen = 0) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const rect = video.getBoundingClientRect();
  if (!vw || !vh || !rect.width || !rect.height) return null;
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const offsetX = (rect.width - vw * scale) / 2;
  const offsetY = (rect.height - vh * scale) / 2;
  const insetX = Math.max(0.04, 0.14 - loosen);
  const insetY = Math.max(0.05, 0.18 - loosen);
  const frameLeft = rect.left + rect.width * insetX;
  const frameTop = rect.top + rect.height * insetY;
  const frameW = rect.width * (1 - insetX * 2);
  const frameH = rect.height * (1 - insetY * 2);
  const sx = Math.max(0, Math.floor((frameLeft - rect.left - offsetX) / scale));
  const sy = Math.max(0, Math.floor((frameTop - rect.top - offsetY) / scale));
  const sw = Math.min(vw - sx, Math.ceil(frameW / scale));
  const sh = Math.min(vh - sy, Math.ceil(frameH / scale));
  if (sw < 48 || sh < 48) return null;
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
function pickScanValue(codes, video) {
  const list = (codes || []).filter((c) => String(c?.rawValue || '').trim());
  if (!list.length) return '';
  const crop = viewfinderSourceRect(video);
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
  const { overlay, stream, raf, video } = active;
  if (raf) cancelAnimationFrame(raf);
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
  if (hint) hint.textContent = 'Đưa sát mã vạch hoặc QR nhỏ, giữ ngang trong khung';
  setStatus(status, 'Đang mở camera…');

  return new Promise(async (resolve) => {
    let settled = false;
    let stream = null;
    let raf = 0;
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
      if (streak >= CONFIRM_HITS) finish(value);
    };

    active = {
      overlay,
      stream: null,
      video,
      raf: 0,
      settle: finish,
    };

    if (closeBtn) closeBtn.onclick = () => finish(null);
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(null);
    };

    const rawValues = (codes) =>
      (codes || []).map((c) => String(c?.rawValue || '').trim()).filter(Boolean);

    /** Phóng vùng giữa khung để vạch mỏng / QR nhỏ đủ điểm ảnh. */
    const drawZoomedViewfinder = () => {
      const crop = viewfinderSourceRect(video, 0.08);
      if (!crop) return false;
      const scale = Math.min(3, 1600 / crop.sw);
      canvas.width = Math.max(1, Math.round(crop.sw * scale));
      canvas.height = Math.max(1, Math.round(crop.sh * scale));
      ctx.imageSmoothingEnabled = false;
      ctx.filter = 'contrast(1.35)';
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
      return true;
    };

    const scanOnce = async () => {
      if (video.readyState < 2 || !video.videoWidth) return '';
      const values = [];
      if (detector) {
        try {
          values.push(pickScanValue(await detector.detect(video), video));
        } catch {
          /* thử ảnh phóng to */
        }
        if (drawZoomedViewfinder()) {
          try {
            values.push(...rawValues(await detector.detect(canvas)));
          } catch {
            /* canvas không đọc được trên một số máy */
          }
        }
      }
      if (!jsQR) jsQR = await jsQRReady;
      if (jsQR && drawZoomedViewfinder()) {
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
