// Item photos: shrinking a picture from the camera or photo library, and
// keeping photos on this device in IndexedDB, which has far more room than
// localStorage. The Bought tab syncs them to the Google Sheet separately.
//
//   const dataUrl = await window.photoStore.capture();  // camera or library; null if cancelled
//   await window.photoStore.put(id, dataUrl);
//   const back = await window.photoStore.get(id);
(() => {
  'use strict';

  const MAX_SIDE = 640;
  const MAX_CHARS = 150000;
  const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

  // Photos read this session, so re-renders don't hit IndexedDB again. Also
  // keeps photos working for the session if IndexedDB is unavailable.
  const cache = new Map();
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('therealtotal', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('photos');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function get(id) {
    if (cache.has(id)) return cache.get(id);
    try {
      const data = await run('readonly', (s) => s.get(id));
      if (typeof data === 'string' && PHOTO_RE.test(data)) { cache.set(id, data); return data; }
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  // Resolves false if the photo couldn't be saved on the device (e.g. storage
  // full); it's still usable until the page is closed.
  async function put(id, data) {
    if (!PHOTO_RE.test(data)) return false;
    cache.set(id, data);
    try { await run('readwrite', (s) => s.put(data, id)); return true; } catch (e) { return false; }
  }

  async function remove(id) {
    cache.delete(id);
    try { await run('readwrite', (s) => s.delete(id)); } catch (e) { /* storage unavailable */ }
  }

  async function ids() {
    try {
      const keys = await run('readonly', (s) => s.getAllKeys());
      return Array.from(new Set([...keys.map(String), ...cache.keys()]));
    } catch (e) {
      return Array.from(cache.keys());
    }
  }

  // Scales a picture (image, video frame or canvas) down to at most 640px on
  // its longest side as a JPEG, lowering the quality until it's small enough
  // to sync quickly.
  // `sx`/`sy` crop from that corner of the source.
  function toSmallJpeg(source, width, height, sx = 0, sy = 0) {
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    // JPEG has no transparency; fill white so see-through PNGs don't go black.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, sx, sy, width, height, 0, 0, canvas.width, canvas.height);
    let quality = 0.72;
    let out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > MAX_CHARS && quality > 0.3) {
      quality -= 0.12;
      out = canvas.toDataURL('image/jpeg', quality);
    }
    if (!PHOTO_RE.test(out) || out.length > MAX_CHARS * 2) throw new Error('Couldn’t shrink that photo.');
    return out;
  }

  async function shrink(file) {
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Couldn’t read that photo.'));
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file isn’t a photo this browser can open.'));
      el.src = source;
    });
    return toSmallJpeg(img, img.naturalWidth, img.naturalHeight);
  }

  // ---------- Camera ----------
  // Opens the camera inside the app with a shutter button, plus "Choose from
  // photos" for the library. Resolves to the finished photo, or null if closed.
  let dialog = null;
  let video, preview, statusEl, shootRow, reviewRow, fileInput;
  let stream = null;
  let shot = null;
  let finish = null;

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  function done(result) {
    const resolve = finish;
    finish = null;
    stopCamera();
    if (dialog.open) dialog.close();
    if (resolve) resolve(result);
  }

  function setStatus(text) {
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
  }

  function showReview(photo) {
    shot = photo;
    preview.src = photo;
    preview.hidden = false;
    video.hidden = true;
    shootRow.hidden = true;
    reviewRow.hidden = false;
  }

  async function startCamera() {
    shot = null;
    preview.hidden = true;
    preview.removeAttribute('src');
    video.hidden = false;
    shootRow.hidden = false;
    reviewRow.hidden = true;
    dialog.querySelector('.cam-shutter').disabled = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('This browser can’t open the camera here — use “Choose from photos”.');
      return;
    }
    setStatus('Starting the camera…');
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      if (!finish) { camera.getTracks().forEach((t) => t.stop()); return; }
      stream = camera;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus('');
      dialog.querySelector('.cam-shutter').disabled = false;
    } catch (err) {
      const name = err && err.name;
      setStatus(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Camera access is off for this site. Allow it in your browser’s settings, or use “Choose from photos”.'
        : 'The camera couldn’t start — use “Choose from photos”.');
    }
  }

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'scan-dialog cam-dialog';
    dialog.setAttribute('aria-labelledby', 'cam-title');
    dialog.innerHTML = `
      <div class="scan-body">
        <div class="scan-head">
          <h2 class="scan-title" id="cam-title">Take a photo</h2>
          <button type="button" class="scan-close" aria-label="Close">&times;</button>
        </div>
        <div class="cam-view">
          <video playsinline muted autoplay></video>
          <img class="cam-preview" alt="Photo you just took" hidden>
        </div>
        <p class="threshold-status unmet cam-status" aria-live="polite" hidden></p>
        <div class="cam-row cam-shoot">
          <button type="button" class="cam-shutter" aria-label="Take photo"></button>
        </div>
        <div class="product-actions cam-review" hidden>
          <button type="button" class="add-button cam-use">Use photo</button>
          <button type="button" class="ghost-button cam-retake">Retake</button>
        </div>
        <button type="button" class="ghost-button cam-library">Choose from photos</button>
      </div>
    `;
    video = dialog.querySelector('video');
    preview = dialog.querySelector('.cam-preview');
    statusEl = dialog.querySelector('.cam-status');
    shootRow = dialog.querySelector('.cam-shoot');
    reviewRow = dialog.querySelector('.cam-review');

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    dialog.appendChild(fileInput);

    dialog.querySelector('.scan-close').addEventListener('click', () => done(null));
    dialog.addEventListener('click', (e) => { if (e.target === dialog) done(null); });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dialog.querySelector('.cam-shutter').addEventListener('click', () => {
      if (!video.videoWidth) return;
      try {
        // Keep just what the viewfinder shows: the middle of the frame at its shape.
        const view = video.getBoundingClientRect();
        const want = view.width / view.height;
        const vw = video.videoWidth, vh = video.videoHeight;
        const w = vw / vh > want ? vh * want : vw;
        const h = vw / vh > want ? vh : vw / want;
        showReview(toSmallJpeg(video, w, h, (vw - w) / 2, (vh - h) / 2));
        stopCamera();
      } catch (err) {
        setStatus(err.message);
      }
    });
    dialog.querySelector('.cam-retake').addEventListener('click', startCamera);
    dialog.querySelector('.cam-use').addEventListener('click', () => done(shot));
    dialog.querySelector('.cam-library').addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        done(await shrink(file));
      } catch (err) {
        setStatus(err.message);
      }
    });
    document.body.appendChild(dialog);
  }

  function capture(title = 'Take a photo') {
    if (!dialog) build();
    if (finish) done(null);
    dialog.querySelector('.scan-title').textContent = title;
    setStatus('');
    dialog.showModal();
    const result = new Promise((resolve) => { finish = resolve; });
    startCamera();
    return result;
  }

  window.photoStore = { get, put, remove, ids, shrink, capture, PHOTO_RE };
})();
