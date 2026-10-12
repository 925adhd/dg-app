// Camera barcode scanner for product codes (UPC-A, UPC-E, EAN-13, EAN-8).
// Uses the browser's own BarcodeDetector where it has one (Chrome on
// Android) and the bundled ZXing library everywhere else (Safari on iPhone),
// loaded only the first time the scanner opens. The camera picture never
// leaves the phone.
//
//   window.openScanner({
//     title: 'Scan items',
//     hint: 'Keep scanning to add more.',
//     onCode: async (code) => ({ text: 'Added Tide', tone: 'met', close: false }),
//     top: element,    // optional, shown above the camera (e.g. a mode switch)
//     panel: element,  // optional, shown under the camera (e.g. a list of scans)
//   });
//
// `code` is digits only, with UPC-E and zero-led EAN-13 turned into the
// 12-digit UPC-A, so the same product always gets the same code.
(() => {
  'use strict';

  const FORMATS = ['upc_a', 'upc_e', 'ean_13', 'ean_8'];
  // After a scan, wait before taking another so one swipe isn't added twice.
  const SAME_CODE_PAUSE = 2500;
  const NEXT_CODE_PAUSE = 900;
  const SCAN_EVERY = 150;

  let dialog = null;
  let video, guide, statusEl, titleEl, hintEl, manualInput;
  let stream = null;
  let timer = null;
  let session = 0;
  let options = null;
  let busy = false;
  let last = { code: '', at: 0 };
  let detector = null;
  let zxReader = null;
  let canvas = null;

  // ---------- Codes ----------
  const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

  // GTIN check digit: weights 3,1,3,1… from the right, excluding the check digit.
  function validCheckDigit(code) {
    if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
    let sum = 0;
    for (let i = code.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(code[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
  }

  function upcEtoA(e) {
    const d = e.slice(1, 7);
    const last = d[5];
    let body;
    if ('012'.includes(last)) body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
    else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
    else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
    else body = d.slice(0, 5) + '0000' + last;
    return e[0] + body + e[7];
  }

  function normalize(raw, format) {
    let code = digitsOnly(raw);
    if (format === 'upc_e' && code.length === 8) code = upcEtoA(code);
    if (code.length === 13 && code[0] === '0') code = code.slice(1);
    return validCheckDigit(code) ? code : '';
  }

  // ---------- Decoders ----------
  async function setUpDecoder() {
    if (detector || zxReader) return;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter((f) => supported.includes(f));
        if (formats.length) { detector = new window.BarcodeDetector({ formats }); return; }
      } catch (e) { /* fall through to ZXing */ }
    }
    if (!window.ZXing) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/zxing.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('The barcode reader didn’t load — check your connection and try again.'));
        document.head.appendChild(s);
      });
    }
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxReader = new Z.MultiFormatReader();
    zxReader.setHints(hints);
    canvas = document.createElement('canvas');
  }

  async function detectOnce() {
    if (!video.videoWidth) return null;
    if (detector) {
      const found = await detector.detect(video);
      return found.length ? { raw: found[0].rawValue, format: found[0].format } : null;
    }
    // ZXing reads a still: copy the middle band of the frame, where the
    // on-screen guide is, scaled down so each try stays quick.
    const Z = window.ZXing;
    const vw = video.videoWidth, vh = video.videoHeight;
    const sx = vw * 0.05, sw = vw * 0.9, sy = vh * 0.2, sh = vh * 0.6;
    const scale = Math.min(1, 960 / sw);
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    try {
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      const result = zxReader.decodeWithState(bitmap);
      return { raw: result.getText(), format: String(Z.BarcodeFormat[result.getBarcodeFormat()]).toLowerCase() };
    } catch (e) {
      return null; // nothing readable in this frame
    } finally {
      zxReader.reset();
    }
  }

  // ---------- Dialog ----------
  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'scan-dialog';
    dialog.setAttribute('aria-labelledby', 'scan-title');
    dialog.innerHTML = `
      <div class="scan-body">
        <div class="scan-head">
          <h2 class="scan-title" id="scan-title"></h2>
          <button type="button" class="scan-close" aria-label="Close scanner">&times;</button>
        </div>
        <div class="scan-top"></div>
        <div class="scan-view">
          <video playsinline muted autoplay></video>
          <div class="scan-guide" aria-hidden="true"></div>
        </div>
        <p class="scan-hint"></p>
        <p class="threshold-status scan-status" aria-live="polite" hidden></p>
        <div class="scan-panel"></div>
        <div class="scan-manual">
          <input type="text" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="Or type the barcode number" aria-label="Barcode number">
          <button type="button" class="scan-manual-add">Add</button>
        </div>
      </div>
    `;
    video = dialog.querySelector('video');
    guide = dialog.querySelector('.scan-guide');
    statusEl = dialog.querySelector('.scan-status');
    titleEl = dialog.querySelector('.scan-title');
    hintEl = dialog.querySelector('.scan-hint');
    manualInput = dialog.querySelector('.scan-manual input');
    dialog.querySelector('.scan-close').addEventListener('click', () => dialog.close());
    // Tapping the dimmed area outside the scanner closes it.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', stop);
    const addManual = () => {
      const raw = digitsOnly(manualInput.value);
      const code = normalize(raw, raw.length === 8 && raw[0] === '0' ? 'upc_e' : '') || (raw.length >= 6 ? raw : '');
      if (!code) { setStatus('Type the numbers under the barcode.', 'unmet'); return; }
      manualInput.value = '';
      handle(code, true);
    };
    dialog.querySelector('.scan-manual-add').addEventListener('click', addManual);
    manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } });
    document.body.appendChild(dialog);
  }

  function setStatus(text, tone = '') {
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
    statusEl.className = `threshold-status scan-status ${tone}`;
  }

  async function handle(code, typed = false) {
    const now = Date.now();
    if (!typed && (busy || (code === last.code ? now - last.at < SAME_CODE_PAUSE : now - last.at < NEXT_CODE_PAUSE))) return;
    busy = true;
    last = { code, at: now };
    guide.classList.add('hit');
    if (navigator.vibrate) navigator.vibrate(60);
    setStatus(`Got ${code}…`);
    const mine = session;
    let result;
    try { result = await options.onCode(code); } catch (e) { result = { text: 'Something went wrong — try that one again.', tone: 'unmet' }; }
    if (mine !== session) return;
    busy = false;
    last.at = Date.now();
    guide.classList.remove('hit');
    if (result && result.text) setStatus(result.text, result.tone || '');
    if (result && result.close) dialog.close();
  }

  async function loop(mine) {
    if (mine !== session) return;
    if (!busy) {
      try {
        const hit = await detectOnce();
        const code = hit && normalize(hit.raw, hit.format);
        if (code && mine === session) handle(code);
      } catch (e) { /* skip this frame */ }
    }
    if (mine === session) timer = setTimeout(() => loop(mine), SCAN_EVERY);
  }

  function stop() {
    session += 1;
    clearTimeout(timer);
    busy = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    if (options && options.onClose) options.onClose();
    options = null;
  }

  function cameraError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera access is off for this site. Allow the camera in your browser’s settings, or type the barcode number below.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. You can type the barcode number below.';
    if (name === 'NotReadableError') return 'The camera is busy in another app. Close it and try again, or type the number below.';
    return (err && err.message) || 'The camera couldn’t start. You can type the barcode number below.';
  }

  // Lets the caller relabel the open scanner (e.g. when switching modes).
  window.setScannerText = (title, hint) => {
    if (!dialog) return;
    titleEl.textContent = title;
    hintEl.textContent = hint;
  };

  window.openScanner = async (opts) => {
    if (!dialog) build();
    if (dialog.open) dialog.close();
    options = opts;
    const mine = ++session;
    last = { code: '', at: 0 };
    titleEl.textContent = opts.title || 'Scan a barcode';
    hintEl.textContent = opts.hint || 'Line the barcode up inside the box.';
    hintEl.hidden = false;
    setStatus('');
    dialog.querySelector('.scan-top').replaceChildren(...(opts.top ? [opts.top] : []));
    dialog.querySelector('.scan-panel').replaceChildren(...(opts.panel ? [opts.panel] : []));
    manualInput.value = '';
    dialog.showModal();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('This browser can’t use the camera here. You can type the barcode number below.', 'unmet');
      return;
    }
    setStatus('Starting the camera…');
    try {
      const [camera] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        }),
        setUpDecoder(),
      ]);
      if (mine !== session) { camera.getTracks().forEach((t) => t.stop()); return; }
      stream = camera;
      const [track] = stream.getVideoTracks();
      // Keep refocusing as the phone moves between items, where supported.
      if (track && track.applyConstraints) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus('');
      loop(mine);
    } catch (err) {
      if (mine === session) setStatus(cameraError(err), 'unmet');
    }
  };
})();
