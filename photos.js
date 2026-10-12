// Item photos: shrinking a picture from the camera or photo library, and
// keeping photos on this device in IndexedDB, which has far more room than
// localStorage. The Bought tab syncs them to the Google Sheet separately.
//
//   const dataUrl = await window.photoStore.shrink(file);
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

  // Scales a photo down to at most 640px on its longest side as a JPEG,
  // lowering the quality until it's small enough to sync quickly.
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
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    // JPEG has no transparency; fill white so see-through PNGs don't go black.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = 0.72;
    let out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > MAX_CHARS && quality > 0.3) {
      quality -= 0.12;
      out = canvas.toDataURL('image/jpeg', quality);
    }
    if (!PHOTO_RE.test(out) || out.length > MAX_CHARS * 2) throw new Error('Couldn’t shrink that photo.');
    return out;
  }

  window.photoStore = { get, put, remove, ids, shrink, PHOTO_RE };
})();
