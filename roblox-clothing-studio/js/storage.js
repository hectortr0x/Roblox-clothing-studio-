/* ==========================================================================
   storage.js — Persistencia de proyectos
   - Usa IndexedDB (sin límite práctico de 5 MB) con dos almacenes:
       "meta": {id, name, type, thumb, updated}   → listado rápido del dashboard
       "data": {id, ...estado completo del proyecto}
   - Si IndexedDB no está disponible, cae a localStorage.
   ========================================================================== */
(function (global) {
  'use strict';
  const RBX = global.RBX = global.RBX || {};

  const DB_NAME = 'rbx-clothing-studio';
  const LS_KEY = 'rbx-clothing-studio:projects';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('Base de datos bloqueada')); };
    });
    return dbPromise;
  }

  /** Ejecuta una transacción; `work(tx)` puede devolver una IDBRequest cuyo resultado se resuelve al terminar. */
  function run(stores, mode, work) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(stores, mode);
        let out;
        tx.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transacción cancelada')); };
        out = work(tx);
      });
    });
  }

  /* ----------------------------------------------------- fallback localStorage */
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; }
  }
  function lsWrite(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }

  /** Intenta IndexedDB; si falla, usa el fallback. */
  function withFallback(primary, fallback) {
    return primary().catch(function (err) {
      console.warn('[storage] IndexedDB falló, usando localStorage:', err);
      return fallback();
    });
  }

  /* ------------------------------------------------------------------- API */
  RBX.Storage = {
    /** Lista de metadatos (más recientes primero). */
    list: function () {
      return withFallback(function () {
        return run(['meta'], 'readonly', function (tx) { return tx.objectStore('meta').getAll(); });
      }, function () {
        return Promise.resolve(lsRead().map(function (r) { return r.meta; }));
      }).then(function (items) {
        return (items || []).sort(function (a, b) { return b.updated - a.updated; });
      });
    },

    /** Devuelve {meta, data} o null. */
    get: function (id) {
      return withFallback(function () {
        return openDB().then(function (db) {
          return new Promise(function (resolve, reject) {
            const tx = db.transaction(['meta', 'data'], 'readonly');
            const rm = tx.objectStore('meta').get(id), rd = tx.objectStore('data').get(id);
            tx.oncomplete = function () { resolve(rm.result && rd.result ? { meta: rm.result, data: rd.result.data } : null); };
            tx.onerror = function () { reject(tx.error); };
          });
        });
      }, function () {
        const f = lsRead().filter(function (r) { return r.meta.id === id; })[0];
        return Promise.resolve(f || null);
      });
    },

    save: function (meta, data) {
      return withFallback(function () {
        return run(['meta', 'data'], 'readwrite', function (tx) {
          tx.objectStore('meta').put(meta);
          tx.objectStore('data').put({ id: meta.id, data: data });
        });
      }, function () {
        const list = lsRead().filter(function (r) { return r.meta.id !== meta.id; });
        list.push({ meta: meta, data: data });
        try { lsWrite(list); } catch (e) { return Promise.reject(new Error('Almacenamiento lleno')); }
        return Promise.resolve();
      });
    },

    remove: function (id) {
      return withFallback(function () {
        return run(['meta', 'data'], 'readwrite', function (tx) {
          tx.objectStore('meta').delete(id);
          tx.objectStore('data').delete(id);
        });
      }, function () {
        lsWrite(lsRead().filter(function (r) { return r.meta.id !== id; }));
        return Promise.resolve();
      });
    }
  };
})(window);
