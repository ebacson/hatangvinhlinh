/** Quét mã QR bằng camera (BarcodeDetector hoặc jsQR). */

let active = null;

function ensureOverlay() {
  let el = document.getElementById('qr-scan-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'qr-scan-overlay';
  el.className = 'qr-scan-overlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="qr-scan-panel" role="dialog" aria-modal="true" aria-label="Quét mã QR">
      <div class="qr-scan-head">
        <strong>Quét mã QR</strong>
        <button type="button" class="btn-text" data-qr-close>Đóng</button>
      </div>
      <div class="qr-scan-video-wrap">
        <video playsinline muted autoplay></video>
        <div class="qr-scan-frame" aria-hidden="true"></div>
      </div>
      <p class="qr-scan-hint muted tiny">Đưa mã QR vào khung hình</p>
      <p class="qr-scan-status muted tiny" data-qr-status></p>
    </div>`;
  document.body.appendChild(el);
  return el;
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
    s.onerror = () => reject(new Error('Không tải được thư viện quét QR'));
    document.head.appendChild(s);
  });
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
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
 * Mở camera và quét QR. Trả về chuỗi khi đọc được, hoặc null nếu đóng.
 * @returns {Promise<string|null>}
 */
export function openQrScanner() {
  closeQrScanner();
  const overlay = ensureOverlay();
  const video = overlay.querySelector('video');
  const status = overlay.querySelector('[data-qr-status]');
  const closeBtn = overlay.querySelector('[data-qr-close]');
  overlay.hidden = false;
  if (status) status.textContent = 'Đang mở camera…';

  return new Promise(async (resolve) => {
    let settled = false;
    let stream = null;
    let raf = 0;
    let detector = null;
    let jsQR = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanupActive();
      resolve(value);
    };

    active = {
      overlay,
      stream: null,
      video,
      raf: 0,
      settle: finish,
    };

    closeBtn?.onclick = () => finish(null);
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(null);
    };

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Trình duyệt không hỗ trợ camera');
      }

      if ('BarcodeDetector' in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }
      if (!detector) jsQR = await loadJsQR();

      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (settled) {
        stopStream(stream);
        return;
      }
      if (active) active.stream = stream;
      video.srcObject = stream;
      await video.play();
      if (status) status.textContent = 'Đưa mã QR vào khung hình';

      const tick = async () => {
        if (settled) return;
        try {
          if (detector && video.readyState >= 2) {
            const codes = await detector.detect(video);
            if (codes?.length) {
              const raw = String(codes[0].rawValue || '').trim();
              if (raw) {
                finish(raw);
                return;
              }
            }
          } else if (jsQR && video.readyState >= 2 && video.videoWidth) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            const code = jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' });
            if (code?.data) {
              const raw = String(code.data).trim();
              if (raw) {
                finish(raw);
                return;
              }
            }
          }
        } catch {
          /* continue scanning */
        }
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
      if (status) status.textContent = msg;
      setTimeout(() => finish(null), 1600);
    }
  });
}
