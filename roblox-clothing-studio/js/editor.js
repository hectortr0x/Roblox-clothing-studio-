/* ==========================================================================
   editor.js — Motor del editor 2D (lienzo, capas, herramientas, historial)

   Diseño:
   - Cada capa tiene su propio <canvas> (raster) o un bitmap fuente + transformación (imagen).
   - Los canvases se tratan como "copy-on-write": antes de modificar píxeles se clona el
     canvas de la capa, de modo que los snapshots del historial pueden compartir
     referencias sin copiar memoria innecesariamente.
   - `texCanvas` (585x559, transparente) es la composición final de las capas. Es lo que
     se exporta y lo que se mapea como textura en el visor 3D.
   - La vista (zoom/pan, plantilla guía, zonas, manipuladores) se dibuja en espacio de pantalla.
   ========================================================================== */
(function (global) {
  'use strict';
  const RBX = global.RBX;
  const W = RBX.TEMPLATE_W, H = RBX.TEMPLATE_H;
  const MAX_UNDO = 60;

  /* ------------------------------------------------------------------ utils */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w || W; c.height = h || H;
    return c;
  }
  function cloneCanvas(src) {
    const c = makeCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }
  function hexToRgb(hex) {
    let h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    const n = parseInt(h, 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function loadImage(src) {
    return new Promise(function (res, rej) {
      const i = new Image();
      i.onload = function () { res(i); };
      i.onerror = function () { rej(new Error('No se pudo cargar la imagen')); };
      i.src = src;
    });
  }
  function readFileAsDataURL(file) {
    return new Promise(function (res, rej) {
      const r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('Error al leer el archivo')); };
      r.readAsDataURL(file);
    });
  }
  function imageToCanvas(img, maxSide) {
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }
  function isTyping(t) {
    return t && (t.tagName === 'INPUT' && !/^(checkbox|range|color|button)$/.test(t.type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  /* ------------------------------------------------------------- flood fill */
  /** Máscara (Uint8Array w*h) de píxeles contiguos al semilla cuyo color está dentro de la tolerancia. */
  function floodMask(data, w, h, sx, sy, tol, mask) {
    mask = mask || new Uint8Array(w * h);
    const i0 = (sy * w + sx) * 4;
    const r = data[i0], g = data[i0 + 1], b = data[i0 + 2], a = data[i0 + 3];
    function match(p) {
      const i = p * 4, aa = data[i + 3];
      if (a === 0 && aa === 0) return true;
      return Math.abs(data[i] - r) <= tol && Math.abs(data[i + 1] - g) <= tol &&
             Math.abs(data[i + 2] - b) <= tol && Math.abs(aa - a) <= tol;
    }
    if (mask[sy * w + sx]) return mask;
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(); let x = stack.pop();
      while (x >= 0 && !mask[y * w + x] && match(y * w + x)) x--;
      x++;
      let up = false, down = false;
      while (x < w && !mask[y * w + x] && match(y * w + x)) {
        mask[y * w + x] = 1;
        if (y > 0) {
          const m = !mask[(y - 1) * w + x] && match((y - 1) * w + x);
          if (!up && m) { stack.push(x, y - 1); up = true; } else if (up && !m) up = false;
        }
        if (y < h - 1) {
          const m2 = !mask[(y + 1) * w + x] && match((y + 1) * w + x);
          if (!down && m2) { stack.push(x, y + 1); down = true; } else if (down && !m2) down = false;
        }
        x++;
      }
    }
    return mask;
  }
  /** Máscara global: todos los píxeles parecidos al color del píxel semilla. */
  function globalMask(data, w, h, sx, sy, tol) {
    const mask = new Uint8Array(w * h);
    const i0 = (sy * w + sx) * 4;
    const r = data[i0], g = data[i0 + 1], b = data[i0 + 2], a = data[i0 + 3];
    for (let p = 0; p < w * h; p++) {
      const i = p * 4, aa = data[i + 3];
      if ((a === 0 && aa === 0) ||
          (Math.abs(data[i] - r) <= tol && Math.abs(data[i + 1] - g) <= tol &&
           Math.abs(data[i + 2] - b) <= tol && Math.abs(aa - a) <= tol)) mask[p] = 1;
    }
    return mask;
  }

  /* ------------------------------------------------------------------ state */
  const S = {
    type: 'shirt', name: '', layers: [], activeId: null, nextId: 1, modified: false,
    template: { source: 'default', canvas: null, dataURL: null, opacity: 0.7, procedural: true },
    showZones: true,
    tool: 'brush',
    brush: { size: 8, opacity: 100, color: '#ffffff', shape: 'round' },
    opt: { tol: 32, contiguous: true, allLayers: false, zoneLimit: true },
    view: { zoom: 1, px: 0, py: 0 },
    undo: [], redo: []
  };

  let cv = null, ctx = null, hooks = {};
  let dpr = 1, cssW = 0, cssH = 0, needFit = true;
  let texCanvas, texCtx, strokeCanvas, strokeCtx, liveTmp, liveTmpCtx, checker;
  let dirtyTex = true, raf = 0, active = false;
  let drag = null, live = null, edit = null, cursor = null, spaceDown = false;
  const procCache = {};

  function fire(name) {
    const fn = hooks[name];
    if (fn) fn.apply(null, Array.prototype.slice.call(arguments, 1));
  }
  function toast(msg, kind) { fire('onToast', msg, kind); }

  /* ----------------------------------------------------------- layer helpers */
  function activeLayer() {
    for (let i = 0; i < S.layers.length; i++) if (S.layers[i].id === S.activeId) return S.layers[i];
    return null;
  }
  function findLayer(id) {
    for (let i = 0; i < S.layers.length; i++) if (S.layers[i].id === id) return S.layers[i];
    return null;
  }
  function indexOfLayer(id) {
    for (let i = 0; i < S.layers.length; i++) if (S.layers[i].id === id) return i;
    return -1;
  }
  function newRasterLayer(name) {
    return { id: S.nextId++, name: name, visible: true, opacity: 1, kind: 'raster', canvas: makeCanvas() };
  }

  /** Dibuja el contenido de una capa en un contexto (en coordenadas de plantilla). */
  function drawLayer(c, l, alpha) {
    c.save();
    c.globalAlpha = alpha === undefined ? l.opacity : alpha;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    if (l.kind === 'raster') {
      let src = l.canvas;
      if (live && live.layer === l) src = livePreview(l);
      c.drawImage(src, 0, 0);
    } else {
      c.translate(l.cx, l.cy);
      c.rotate(l.rot);
      c.drawImage(l.canvas, -l.w / 2, -l.h / 2, l.w, l.h);
    }
    c.restore();
  }
  function livePreview(l) {
    liveTmpCtx.clearRect(0, 0, W, H);
    liveTmpCtx.drawImage(l.canvas, 0, 0);
    liveTmpCtx.save();
    liveTmpCtx.globalAlpha = live.alpha;
    liveTmpCtx.globalCompositeOperation = live.erase ? 'destination-out' : 'source-over';
    liveTmpCtx.drawImage(strokeCanvas, 0, 0);
    liveTmpCtx.restore();
    return liveTmp;
  }

  /** Compone todas las capas visibles en texCanvas. */
  function compose(force) {
    if (!force && !dirtyTex) return false;
    texCtx.clearRect(0, 0, W, H);
    for (let i = 0; i < S.layers.length; i++) {
      const l = S.layers[i];
      if (l.visible) drawLayer(texCtx, l);
    }
    dirtyTex = false;
    return true;
  }

  /* ---------------------------------------------------------------- history */
  function snap() {
    return { layers: S.layers.map(function (l) { return Object.assign({}, l); }), activeId: S.activeId };
  }
  function restore(s) {
    S.layers = s.layers.map(function (l) { return Object.assign({}, l); });
    S.activeId = s.activeId;
    if (!activeLayer() && S.layers.length) S.activeId = S.layers[S.layers.length - 1].id;
  }
  function trimUndo() { while (S.undo.length > MAX_UNDO) S.undo.shift(); }
  function pushUndo() {
    S.undo.push(snap()); trimUndo(); S.redo.length = 0; fire('onHistory');
  }
  function beginEdit(l, cloneIt) {
    edit = { pending: snap() };
    if (l && cloneIt) l.canvas = cloneCanvas(l.canvas);
  }
  function endEdit() {
    if (!edit) return;
    S.undo.push(edit.pending); trimUndo(); S.redo.length = 0; edit = null;
    markTex(); changed(); fire('onHistory');
  }
  function afterHistory() {
    markTex(); S.modified = true;
    fire('onLayers'); fire('onHistory'); fire('onModified');
  }
  function undo() {
    if (!S.undo.length || drag) return;
    S.redo.push(snap()); restore(S.undo.pop()); afterHistory();
  }
  function redo() {
    if (!S.redo.length || drag) return;
    S.undo.push(snap()); restore(S.redo.pop()); afterHistory();
  }
  function changed() { S.modified = true; fire('onLayers'); fire('onModified'); }

  /* --------------------------------------------------------------- rendering */
  function markTex() { dirtyTex = true; requestRender(); }
  function markView() { requestRender(); }
  function requestRender() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (!active) return;
    if (dirtyTex) { compose(); fire('onTexture', texCanvas); }
    renderView();
  }

  function buildProceduralTemplate(type) {
    if (procCache[type]) return procCache[type];
    const c = makeCanvas(), x = c.getContext('2d');
    RBX.getZones(type).forEach(function (z) {
      const r = z.rect;
      x.fillStyle = z.face === 'front' ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.075)';
      x.fillRect(r[0], r[1], r[2], r[3]);
      x.strokeStyle = 'rgba(255,255,255,0.22)';
      x.lineWidth = 1;
      x.strokeRect(r[0] + 0.5, r[1] + 0.5, r[2] - 1, r[3] - 1);
    });
    procCache[type] = c;
    return c;
  }

  function renderView() {
    if (!cv || !cssW) return;
    const V = S.view, z = V.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Fondo de transparencia (en espacio de pantalla)
    ctx.save();
    ctx.beginPath(); ctx.rect(V.px, V.py, W * z, H * z); ctx.clip();
    ctx.fillStyle = checker; ctx.fillRect(V.px, V.py, W * z, H * z);
    ctx.restore();

    // Plantilla guía + arte
    ctx.save();
    ctx.translate(V.px, V.py); ctx.scale(z, z);
    ctx.imageSmoothingEnabled = z < 2;
    if (S.template.canvas && S.template.opacity > 0) {
      ctx.globalAlpha = S.template.opacity;
      ctx.drawImage(S.template.canvas, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(texCanvas, 0, 0);
    ctx.restore();

    // Borde del documento
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.strokeRect(V.px - 0.5, V.py - 0.5, W * z + 1, H * z + 1);

    // Zonas y etiquetas
    if (S.showZones) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(190,200,220,0.45)';
      ctx.fillStyle = 'rgba(210,217,230,0.8)';
      ctx.font = '10px system-ui, sans-serif';
      RBX.getZones(S.type).forEach(function (zn) {
        const r = zn.rect, sx = V.px + r[0] * z, sy = V.py + r[1] * z;
        ctx.strokeRect(Math.round(sx) + 0.5, Math.round(sy) + 0.5, r[2] * z, r[3] * z);
        if (r[2] * z > 46) ctx.fillText(zn.short, sx + 4, sy + 12);
      });
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(235,238,245,0.9)';
      RBX.getGroupCaptions(S.type).forEach(function (c) { ctx.fillText(c.text, V.px + c.x * z, V.py + c.y * z); });
    }

    // Manipuladores de la capa-imagen
    if (S.tool === 'move') {
      const l = activeLayer();
      if (l && l.kind === 'image' && l.visible) drawHandles(l);
    }

    // Cursor del pincel
    if (cursor && (S.tool === 'brush' || S.tool === 'eraser') && !spaceDown && !(drag && drag.type === 'pan')) {
      const r = Math.max(S.brush.size * z / 2, 1);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      cursorShape(r); ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      cursorShape(r); ctx.stroke();
    }
  }
  function cursorShape(r) {
    ctx.beginPath();
    if (S.brush.shape === 'pixel') ctx.rect(cursor.x - r, cursor.y - r, r * 2, r * 2);
    else ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
  }

  function docToScreen(x, y) { return { x: S.view.px + x * S.view.zoom, y: S.view.py + y * S.view.zoom }; }

  function layerHandles(l) {
    const cos = Math.cos(l.rot), sin = Math.sin(l.rot);
    function pt(lx, ly) { return { x: l.cx + lx * cos - ly * sin, y: l.cy + lx * sin + ly * cos }; }
    const hw = l.w / 2, hh = l.h / 2, off = 30 / S.view.zoom, hs = [];
    for (let hy = -1; hy <= 1; hy++) {
      for (let hx = -1; hx <= 1; hx++) {
        if (hx === 0 && hy === 0) continue;
        const p = pt(hx * hw, hy * hh);
        hs.push({ mode: 'scale', hx: hx, hy: hy, x: p.x, y: p.y });
      }
    }
    const rp = pt(0, -hh - off);
    hs.push({ mode: 'rotate', hx: 0, hy: 0, x: rp.x, y: rp.y });
    return hs;
  }

  function drawHandles(l) {
    const hs = layerHandles(l);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (c) {
      const h = hs.filter(function (q) { return q.mode === 'scale' && q.hx === c[0] && q.hy === c[1]; })[0];
      return docToScreen(h.x, h.y);
    });
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    corners.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath(); ctx.stroke();
    const top = docToScreen((hs.filter(function (q) { return q.mode === 'scale' && q.hx === 0 && q.hy === -1; })[0]).x,
                            (hs.filter(function (q) { return q.mode === 'scale' && q.hx === 0 && q.hy === -1; })[0]).y);
    const rot = hs.filter(function (q) { return q.mode === 'rotate'; })[0];
    const rp = docToScreen(rot.x, rot.y);
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rp.x, rp.y); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111';
    hs.forEach(function (h) {
      const p = docToScreen(h.x, h.y);
      ctx.beginPath();
      if (h.mode === 'rotate') ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      else ctx.rect(p.x - 4.5, p.y - 4.5, 9, 9);
      ctx.fill(); ctx.stroke();
    });
  }

  function hitTest(l, dp) {
    const hs = layerHandles(l), z = S.view.zoom;
    for (let i = 0; i < hs.length; i++) {
      const d = Math.hypot(hs[i].x - dp.x, hs[i].y - dp.y) * z;
      if (d <= 10) return hs[i];
    }
    const dx = dp.x - l.cx, dy = dp.y - l.cy, cos = Math.cos(l.rot), sin = Math.sin(l.rot);
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    if (Math.abs(lx) <= l.w / 2 && Math.abs(ly) <= l.h / 2) return { mode: 'move', hx: 0, hy: 0 };
    return null;
  }
  function cursorFor(h) {
    if (!h) return 'default';
    if (h.mode === 'move') return 'move';
    if (h.mode === 'rotate') return 'grab';
    if (h.hx && h.hy) return h.hx === h.hy ? 'nwse-resize' : 'nesw-resize';
    return h.hx ? 'ew-resize' : 'ns-resize';
  }

  /* ------------------------------------------------------------------- view */
  function screenPt(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toDoc(p) { return { x: (p.x - S.view.px) / S.view.zoom, y: (p.y - S.view.py) / S.view.zoom }; }

  function resizeView() {
    if (!cv) return;
    const r = cv.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    const first = !cssW;
    cssW = Math.floor(r.width); cssH = Math.floor(r.height);
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    if (first || needFit) fitView();
    requestRender();
  }
  function fitView() {
    if (!cssW) { needFit = true; return; }
    needFit = false;
    const z = Math.max(0.1, Math.min((cssW - 40) / W, (cssH - 40) / H));
    S.view.zoom = z;
    S.view.px = (cssW - W * z) / 2;
    S.view.py = (cssH - H * z) / 2;
    fire('onView', z); requestRender();
  }
  function zoomAt(factor, sp) {
    const V = S.view, nz = Math.min(16, Math.max(0.15, V.zoom * factor));
    sp = sp || { x: cssW / 2, y: cssH / 2 };
    V.px = sp.x - (sp.x - V.px) * (nz / V.zoom);
    V.py = sp.y - (sp.y - V.py) * (nz / V.zoom);
    V.zoom = nz;
    fire('onView', nz); requestRender();
  }
  function zoomTo100() {
    const V = S.view, sp = { x: cssW / 2, y: cssH / 2 };
    zoomAt(1 / V.zoom, sp);
  }

  /* ------------------------------------------------------------------ tools */
  function setTool(t) {
    S.tool = t;
    if (cv) cv.style.cursor = t === 'hand' ? 'grab' : (t === 'move' ? 'default' : 'crosshair');
    fire('onTool', t); requestRender();
  }

  function drawDot(c, p) {
    const s = S.brush.size;
    c.fillStyle = S.tool === 'eraser' ? '#000' : S.brush.color;
    if (S.brush.shape === 'pixel') {
      const q = Math.max(1, Math.round(s));
      c.fillRect(Math.round(p.x - q / 2), Math.round(p.y - q / 2), q, q);
    } else {
      c.beginPath(); c.arc(p.x, p.y, s / 2, 0, Math.PI * 2); c.fill();
    }
  }
  function drawSegment(c, a, b) {
    const col = S.tool === 'eraser' ? '#000' : S.brush.color, s = S.brush.size;
    if (S.brush.shape === 'pixel') {
      const q = Math.max(1, Math.round(s));
      const dx = b.x - a.x, dy = b.y - a.y, n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
      c.fillStyle = col;
      for (let i = 0; i <= n; i++) {
        c.fillRect(Math.round(a.x + dx * i / n - q / 2), Math.round(a.y + dy * i / n - q / 2), q, q);
      }
    } else {
      c.strokeStyle = col; c.lineWidth = s; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
  }

  /** Convierte una capa-imagen en capa raster (aplana la transformación). */
  function rasterizeInPlace(l) {
    if (l.kind === 'raster') return;
    const c = makeCanvas();
    drawLayer(c.getContext('2d'), l, 1);
    l.canvas = c; l.kind = 'raster';
    delete l.cx; delete l.cy; delete l.w; delete l.h; delete l.rot;
  }

  function startStroke(dp) {
    const l = activeLayer();
    if (!l) return;
    if (!l.visible) { toast('La capa activa está oculta', 'error'); return; }
    beginEdit(l, l.kind === 'raster');
    if (l.kind === 'image') { rasterizeInPlace(l); toast('Capa de imagen rasterizada para poder pintar'); }
    const erase = S.tool === 'eraser';
    strokeCtx.clearRect(0, 0, W, H);
    drawDot(strokeCtx, dp);
    live = { layer: l, erase: erase, alpha: S.brush.opacity / 100 };
    drag = { type: 'stroke', last: dp };
    if (!erase) fire('onPaint', S.brush.color);
    markTex();
  }
  function endStroke() {
    if (!live) return;
    const l = live.layer, c = l.canvas.getContext('2d');
    c.save();
    c.globalAlpha = live.alpha;
    c.globalCompositeOperation = live.erase ? 'destination-out' : 'source-over';
    c.drawImage(strokeCanvas, 0, 0);
    c.restore();
    live = null;
    strokeCtx.clearRect(0, 0, W, H);
    endEdit();
  }

  function doFill(dp) {
    const l = activeLayer();
    if (!l) return;
    if (!l.visible) { toast('La capa activa está oculta', 'error'); return; }
    const x = Math.floor(dp.x), y = Math.floor(dp.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    // Limitar el relleno a la zona (cara) de la plantilla donde se hizo clic
    let rect = [0, 0, W, H];
    if (S.opt.zoneLimit) {
      const zone = RBX.getZones(S.type).filter(function (q) {
        return x >= q.rect[0] && x < q.rect[0] + q.rect[2] && y >= q.rect[1] && y < q.rect[1] + q.rect[3];
      })[0];
      if (!zone) { toast('Haz clic dentro de una zona de la plantilla (o desactiva "Limitar a zona")'); return; }
      rect = zone.rect;
    }
    beginEdit(l, l.kind === 'raster');
    if (l.kind === 'image') rasterizeInPlace(l);
    let data;
    if (S.opt.allLayers) { compose(true); data = texCtx.getImageData(0, 0, W, H).data; }
    else data = l.canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const mask = floodMask(data, W, H, x, y, S.opt.tol);
    const rgb = hexToRgb(S.brush.color);
    const id = new ImageData(W, H);
    for (let yy = rect[1]; yy < rect[1] + rect[3]; yy++) {
      for (let xx = rect[0]; xx < rect[0] + rect[2]; xx++) {
        const p = yy * W + xx;
        if (mask[p]) { const i = p * 4; id.data[i] = rgb.r; id.data[i + 1] = rgb.g; id.data[i + 2] = rgb.b; id.data[i + 3] = 255; }
      }
    }
    const tmp = makeCanvas(); tmp.getContext('2d').putImageData(id, 0, 0);
    const c = l.canvas.getContext('2d');
    c.save(); c.globalAlpha = S.brush.opacity / 100; c.drawImage(tmp, 0, 0); c.restore();
    fire('onPaint', S.brush.color);
    endEdit();
  }

  function pick(dp) {
    const x = Math.floor(dp.x), y = Math.floor(dp.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    compose(true);
    const d = texCtx.getImageData(x, y, 1, 1).data;
    if (d[3] === 0) { toast('Ese píxel es transparente'); return; }
    const hex = '#' + [d[0], d[1], d[2]].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
    S.brush.color = hex;
    fire('onColorPicked', hex);
  }

  function docToSource(l, dp) {
    const dx = dp.x - l.cx, dy = dp.y - l.cy, cos = Math.cos(l.rot), sin = Math.sin(l.rot);
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    if (Math.abs(lx) > l.w / 2 || Math.abs(ly) > l.h / 2) return null;
    const sx = Math.min(l.canvas.width - 1, Math.max(0, Math.floor((lx + l.w / 2) / l.w * l.canvas.width)));
    const sy = Math.min(l.canvas.height - 1, Math.max(0, Math.floor((ly + l.h / 2) / l.h * l.canvas.height)));
    return { x: sx, y: sy };
  }

  function applyMaskAlpha(l, mask) {
    const c = l.canvas, cx = c.getContext('2d');
    const id = cx.getImageData(0, 0, c.width, c.height);
    for (let p = 0; p < mask.length; p++) if (mask[p]) id.data[p * 4 + 3] = 0;
    cx.putImageData(id, 0, 0);
  }

  /** Varita de eliminación de fondo: quita el color pulsado de la capa activa. */
  function doMagic(dp) {
    const l = activeLayer();
    if (!l) return;
    if (!l.visible) { toast('La capa activa está oculta', 'error'); return; }
    let sx, sy;
    if (l.kind === 'raster') {
      sx = Math.floor(dp.x); sy = Math.floor(dp.y);
      if (sx < 0 || sy < 0 || sx >= l.canvas.width || sy >= l.canvas.height) return;
    } else {
      const p = docToSource(l, dp);
      if (!p) { toast('Haz clic dentro de la imagen'); return; }
      sx = p.x; sy = p.y;
    }
    beginEdit(l, true);
    const c = l.canvas, data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const mask = S.opt.contiguous ? floodMask(data, c.width, c.height, sx, sy, S.opt.tol)
                                  : globalMask(data, c.width, c.height, sx, sy, S.opt.tol);
    applyMaskAlpha(l, mask);
    endEdit();
  }

  /** Quita el fondo automáticamente tomando el color de las 4 esquinas. */
  function autoRemoveBg(id) {
    const l = findLayer(id === undefined ? S.activeId : id);
    if (!l) return;
    beginEdit(l, true);
    const c = l.canvas, w = c.width, h = c.height;
    const data = c.getContext('2d').getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].forEach(function (p) { floodMask(data, w, h, p[0], p[1], S.opt.tol, mask); });
    applyMaskAlpha(l, mask);
    endEdit();
  }

  /* ----------------------------------------------------------- move / xform */
  function startMove(dp) {
    const l = activeLayer();
    if (!l) return;
    if (!l.visible) { toast('La capa activa está oculta', 'error'); return; }
    if (l.kind === 'image') {
      const h = hitTest(l, dp);
      if (!h) return;
      drag = { type: 'xform', mode: h.mode, hx: h.hx, hy: h.hy, startDp: dp, moved: false, pending: snap(),
               start: { cx: l.cx, cy: l.cy, w: l.w, h: l.h, rot: l.rot } };
    } else {
      drag = { type: 'shift', base: l.canvas, startDp: dp, moved: false, pending: snap() };
    }
  }
  function dragMove(e, sp, dp) {
    const d = drag;
    if (d.type === 'pan') {
      S.view.px = d.px + (sp.x - d.sx); S.view.py = d.py + (sp.y - d.sy); requestRender(); return;
    }
    if (d.type === 'stroke') {
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
      for (let i = 0; i < evs.length; i++) {
        const p = toDoc(screenPt(evs[i]));
        drawSegment(strokeCtx, d.last, p); d.last = p;
      }
      markTex(); return;
    }
    const l = activeLayer();
    if (!l) return;
    if (!d.moved) {
      if (Math.hypot(dp.x - d.startDp.x, dp.y - d.startDp.y) * S.view.zoom < 2) return;
      d.moved = true; S.undo.push(d.pending); trimUndo(); S.redo.length = 0; fire('onHistory');
    }
    if (d.type === 'shift') {
      const nc = makeCanvas(d.base.width, d.base.height);
      nc.getContext('2d').drawImage(d.base, Math.round(dp.x - d.startDp.x), Math.round(dp.y - d.startDp.y));
      l.canvas = nc; markTex(); return;
    }
    const st = d.start;
    if (d.mode === 'move') {
      l.cx = st.cx + (dp.x - d.startDp.x); l.cy = st.cy + (dp.y - d.startDp.y);
    } else if (d.mode === 'rotate') {
      let a = Math.atan2(dp.y - st.cy, dp.x - st.cx) + Math.PI / 2;
      if (e.shiftKey) { const q = Math.PI / 12; a = Math.round(a / q) * q; }
      l.rot = a;
    } else {
      const cos = Math.cos(st.rot), sin = Math.sin(st.rot);
      const ox = st.cx + (-d.hx * st.w / 2) * cos - (-d.hy * st.h / 2) * sin;
      const oy = st.cy + (-d.hx * st.w / 2) * sin + (-d.hy * st.h / 2) * cos;
      const px = dp.x - ox, py = dp.y - oy;
      const lx = px * cos + py * sin, ly = -px * sin + py * cos;
      let nw = d.hx ? Math.max(4, d.hx * lx) : st.w;
      let nh = d.hy ? Math.max(4, d.hy * ly) : st.h;
      if (d.hx && d.hy && !e.shiftKey) {
        const k = Math.max(nw / st.w, nh / st.h); nw = st.w * k; nh = st.h * k;
      }
      const cxl = d.hx * nw / 2, cyl = d.hy * nh / 2;
      l.cx = ox + cxl * cos - cyl * sin; l.cy = oy + cxl * sin + cyl * cos;
      l.w = nw; l.h = nh;
    }
    markTex();
  }

  /* --------------------------------------------------------- pointer events */
  function onDown(e) {
    if (!active) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    const sp = screenPt(e), dp = toDoc(sp);
    drag = null;
    if (e.button === 1 || S.tool === 'hand' || spaceDown) {
      e.preventDefault();
      drag = { type: 'pan', sx: sp.x, sy: sp.y, px: S.view.px, py: S.view.py };
      cv.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0) return;
    switch (S.tool) {
      case 'brush': case 'eraser': startStroke(dp); break;
      case 'fill': doFill(dp); break;
      case 'picker': pick(dp); break;
      case 'magic': doMagic(dp); break;
      case 'move': startMove(dp); break;
    }
  }
  function onMove(e) {
    if (!active) return;
    const sp = screenPt(e), dp = toDoc(sp);
    cursor = sp;
    fire('onCursor', Math.floor(dp.x), Math.floor(dp.y));
    if (drag) { dragMove(e, sp, dp); return; }
    if (S.tool === 'move') {
      const l = activeLayer();
      cv.style.cursor = (l && l.kind === 'image' && l.visible) ? cursorFor(hitTest(l, dp)) : (l ? 'move' : 'default');
    } else if (spaceDown) cv.style.cursor = 'grab';
    requestRender();
  }
  function onUp(e) {
    if (!drag) return;
    const d = drag; drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.type === 'pan') { setTool(S.tool); if (spaceDown) cv.style.cursor = 'grab'; }
    else if (d.type === 'stroke') endStroke();
    else if ((d.type === 'xform' || d.type === 'shift') && d.moved) changed();
    requestRender();
  }
  function onLeave() { cursor = null; fire('onCursor', null, null); requestRender(); }
  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0016), screenPt(e));
  }
  function onKeyDown(e) {
    if (!active || isTyping(e.target)) return;
    if (e.code === 'Space') { spaceDown = true; if (cv && !drag) cv.style.cursor = 'grab'; e.preventDefault(); requestRender(); }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') { spaceDown = false; if (cv && !drag) setTool(S.tool); requestRender(); }
  }

  /* ------------------------------------------------------------ layer actions */
  function checkpoint() { pushUndo(); }

  function addLayer() {
    pushUndo();
    const l = newRasterLayer('Capa ' + S.nextId);
    S.layers.splice(indexOfLayer(S.activeId) + 1, 0, l);
    S.activeId = l.id; markTex(); changed();
  }
  function duplicateLayer(id) {
    const src = findLayer(id === undefined ? S.activeId : id);
    if (!src) return;
    pushUndo();
    const l = Object.assign({}, src, { id: S.nextId++, name: src.name + ' copia' }); // el canvas se comparte (copy-on-write)
    S.layers.splice(indexOfLayer(src.id) + 1, 0, l);
    S.activeId = l.id; markTex(); changed();
  }
  function deleteLayer(id) {
    id = id === undefined ? S.activeId : id;
    if (S.layers.length <= 1) { toast('Debe existir al menos una capa', 'error'); return; }
    const i = indexOfLayer(id);
    if (i < 0) return;
    pushUndo();
    S.layers.splice(i, 1);
    if (S.activeId === id) S.activeId = S.layers[Math.min(i, S.layers.length - 1)].id;
    markTex(); changed();
  }
  function moveLayer(id, dir) {
    id = id === undefined ? S.activeId : id;
    const i = indexOfLayer(id), j = i + dir;
    if (i < 0 || j < 0 || j >= S.layers.length) return;
    pushUndo();
    const t = S.layers[i]; S.layers[i] = S.layers[j]; S.layers[j] = t;
    markTex(); changed();
  }
  function moveLayerTo(id, targetId) {
    const from = indexOfLayer(id), to = indexOfLayer(targetId);
    if (from < 0 || to < 0 || from === to) return;
    pushUndo();
    const l = S.layers.splice(from, 1)[0];
    S.layers.splice(to, 0, l);
    markTex(); changed();
  }
  function mergeDown(id) {
    id = id === undefined ? S.activeId : id;
    const i = indexOfLayer(id);
    if (i <= 0) { toast('No hay una capa debajo para combinar', 'error'); return; }
    pushUndo();
    const up = S.layers[i], low = S.layers[i - 1];
    const c = makeCanvas(), x = c.getContext('2d');
    if (low.visible) drawLayer(x, low);
    if (up.visible) drawLayer(x, up);
    const merged = { id: S.nextId++, name: low.name, visible: true, opacity: 1, kind: 'raster', canvas: c };
    S.layers.splice(i - 1, 2, merged);
    S.activeId = merged.id; markTex(); changed();
  }
  function setActiveLayer(id) {
    if (!findLayer(id) || S.activeId === id) return;
    S.activeId = id; requestRender(); fire('onLayers');
  }
  function setLayerVisible(id, v) {
    const l = findLayer(id); if (!l) return;
    pushUndo(); l.visible = v; markTex(); changed();
  }
  function setLayerOpacity(id, v) {
    const l = findLayer(id); if (!l) return;
    l.opacity = Math.min(1, Math.max(0, v)); S.modified = true; markTex(); fire('onModified');
  }
  function renameLayer(id, name) {
    const l = findLayer(id); if (!l) return;
    name = String(name || '').trim().slice(0, 40) || l.name;
    if (name === l.name) return;
    pushUndo(); l.name = name; changed();
  }
  function rasterizeLayer(id) {
    const l = findLayer(id === undefined ? S.activeId : id);
    if (!l || l.kind === 'raster') return;
    pushUndo(); rasterizeInPlace(l); markTex(); changed();
  }
  function flipLayer(id, axis) {
    const l = findLayer(id === undefined ? S.activeId : id);
    if (!l) return;
    pushUndo();
    const c = makeCanvas(l.canvas.width, l.canvas.height), x = c.getContext('2d');
    if (axis === 'h') { x.translate(c.width, 0); x.scale(-1, 1); } else { x.translate(0, c.height); x.scale(1, -1); }
    x.drawImage(l.canvas, 0, 0);
    l.canvas = c; markTex(); changed();
  }
  function fitLayerToZone(id, key) {
    const l = findLayer(id === undefined ? S.activeId : id);
    if (!l || l.kind !== 'image') return;
    const z = RBX.getZones(S.type).filter(function (q) { return q.key === key; })[0];
    if (!z) return;
    pushUndo();
    l.cx = z.rect[0] + z.rect[2] / 2; l.cy = z.rect[1] + z.rect[3] / 2;
    l.w = z.rect[2]; l.h = z.rect[3]; l.rot = 0;
    markTex(); changed();
  }

  async function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('Ese archivo no es una imagen', 'error'); return; }
    try {
      const url = await readFileAsDataURL(file);
      const img = await loadImage(url);
      const src = imageToCanvas(img, 2048);
      pushUndo();
      const k = Math.min(1, (W * 0.5) / src.width, (H * 0.5) / src.height);
      const l = {
        id: S.nextId++, name: (file.name || 'Imagen').replace(/\.[^.]+$/, '').slice(0, 40) || 'Imagen',
        visible: true, opacity: 1, kind: 'image', canvas: src,
        cx: W / 2, cy: H / 2, w: src.width * k, h: src.height * k, rot: 0
      };
      S.layers.push(l); S.activeId = l.id;
      markTex(); changed(); setTool('move');
      toast('Imagen importada · usa los manipuladores para moverla, escalarla o rotarla');
    } catch (err) { toast(err.message, 'error'); }
  }

  /* --------------------------------------------------------------- template */
  function useDefaultTemplate() {
    const T = S.template;
    return loadImage(RBX.DEFAULT_TEMPLATE_PATHS[S.type]).then(function (img) {
      T.canvas = img; T.procedural = false;
    }).catch(function () {
      T.canvas = buildProceduralTemplate(S.type); T.procedural = true;
    }).then(function () {
      T.source = 'default'; T.dataURL = null; markView(); fire('onTemplate');
    });
  }
  async function setTemplateFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast('Ese archivo no es una imagen', 'error'); return; }
    try {
      const url = await readFileAsDataURL(file);
      const img = await loadImage(url);
      const T = S.template;
      T.canvas = img; T.source = 'custom'; T.dataURL = url; T.name = file.name; T.procedural = false;
      S.modified = true; markView(); fire('onTemplate'); fire('onModified');
    } catch (err) { toast(err.message, 'error'); }
  }
  function clearTemplate() {
    const T = S.template;
    T.canvas = null; T.source = 'none'; T.dataURL = null; S.modified = true;
    markView(); fire('onTemplate'); fire('onModified');
  }
  function setTemplateOpacity(v) { S.template.opacity = Math.min(1, Math.max(0, v)); markView(); }
  function setShowZones(v) { S.showZones = !!v; markView(); }

  /* ----------------------------------------------------------- project i/o */
  function resetCommon() {
    S.layers = []; S.undo = []; S.redo = []; S.nextId = 1; S.modified = false;
    drag = null; live = null; edit = null;
    S.template = { source: 'default', canvas: null, dataURL: null, opacity: 0.7, procedural: true };
    S.showZones = true;
  }

  async function newProject(type, name) {
    resetCommon();
    S.type = type; S.name = name;
    const l = newRasterLayer('Capa 1');
    S.layers.push(l); S.activeId = l.id;
    await useDefaultTemplate();
    needFit = true;
    markTex(); fire('onLayers'); fire('onHistory'); fire('onModified'); fire('onTemplate');
    if (cssW) fitView();
  }

  function serialize() {
    return {
      version: 1, type: S.type, name: S.name, nextId: S.nextId, activeId: S.activeId, showZones: S.showZones,
      template: { source: S.template.source, dataURL: S.template.source === 'custom' ? S.template.dataURL : null, opacity: S.template.opacity, name: S.template.name || '' },
      layers: S.layers.map(function (l) {
        return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, kind: l.kind,
                 cx: l.cx, cy: l.cy, w: l.w, h: l.h, rot: l.rot, png: l.canvas.toDataURL('image/png') };
      })
    };
  }

  async function load(rec) {
    const d = rec.data;
    resetCommon();
    S.type = d.type; S.name = d.name || rec.meta.name; S.nextId = d.nextId || 1;
    for (let i = 0; i < d.layers.length; i++) {
      const ld = d.layers[i], img = await loadImage(ld.png);
      const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      const l = { id: ld.id, name: ld.name, visible: ld.visible, opacity: ld.opacity, kind: ld.kind, canvas: c };
      if (ld.kind === 'image') { l.cx = ld.cx; l.cy = ld.cy; l.w = ld.w; l.h = ld.h; l.rot = ld.rot || 0; }
      S.layers.push(l);
    }
    if (!S.layers.length) S.layers.push(newRasterLayer('Capa 1'));
    S.activeId = findLayer(d.activeId) ? d.activeId : S.layers[S.layers.length - 1].id;
    S.showZones = d.showZones !== false;
    const t = d.template || {};
    S.template.opacity = typeof t.opacity === 'number' ? t.opacity : 0.7;
    if (t.source === 'custom' && t.dataURL) {
      try {
        S.template.canvas = await loadImage(t.dataURL);
        S.template.source = 'custom'; S.template.dataURL = t.dataURL; S.template.name = t.name || ''; S.template.procedural = false;
      } catch (_) { await useDefaultTemplate(); }
    } else if (t.source === 'none') {
      S.template.canvas = null; S.template.source = 'none';
    } else await useDefaultTemplate();
    needFit = true;
    markTex(); fire('onLayers'); fire('onHistory'); fire('onModified'); fire('onTemplate');
    if (cssW) fitView();
  }

  function getThumbnail() {
    compose(true);
    const tw = 240, th = Math.round(240 * H / W), c = makeCanvas(tw, th), x = c.getContext('2d');
    x.fillStyle = '#1b1e24'; x.fillRect(0, 0, tw, th);
    x.drawImage(buildProceduralTemplate(S.type), 0, 0, tw, th);
    x.drawImage(texCanvas, 0, 0, tw, th);
    return c.toDataURL('image/png');
  }

  function exportPNG(filename) {
    compose(true);
    texCanvas.toBlob(function (blob) {
      if (!blob) { toast('No se pudo generar el PNG', 'error'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (filename || 'roblox-clothing') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('PNG exportado · ' + W + '×' + H + ' px');
    }, 'image/png');
  }

  function drawLayerThumb(id, target) {
    const l = findLayer(id); if (!l || !target) return;
    const x = target.getContext('2d');
    x.clearRect(0, 0, target.width, target.height);
    x.save(); x.scale(target.width / W, target.height / H);
    // sin la vista previa del trazo en curso
    const prev = live; live = null;
    drawLayer(x, l, 1);
    live = prev;
    x.restore();
  }

  /* -------------------------------------------------------------------- init */
  function init(canvasEl, h) {
    cv = canvasEl; hooks = h || {};
    ctx = cv.getContext('2d');
    texCanvas = makeCanvas(); texCtx = texCanvas.getContext('2d');
    strokeCanvas = makeCanvas(); strokeCtx = strokeCanvas.getContext('2d');
    liveTmp = makeCanvas(); liveTmpCtx = liveTmp.getContext('2d');

    const p = makeCanvas(16, 16), px = p.getContext('2d');
    px.fillStyle = '#343944'; px.fillRect(0, 0, 16, 16);
    px.fillStyle = '#2b2f38'; px.fillRect(0, 0, 8, 8); px.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(p, 'repeat');

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', function () { if (!drag) onLeave(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resizeView);
    if (global.ResizeObserver) new ResizeObserver(resizeView).observe(cv.parentElement);
    setTool('brush');
  }

  /* --------------------------------------------------------------------- API */
  RBX.Editor = {
    init: init,
    setActive: function (v) { active = !!v; if (active) { resizeView(); markTex(); } },
    resizeView: resizeView, fitView: fitView,
    zoomBy: function (f) { zoomAt(f); }, zoomTo100: zoomTo100,
    newProject: newProject, load: load, serialize: serialize,
    getThumbnail: getThumbnail, exportPNG: exportPNG,
    getTextureCanvas: function () { return texCanvas; },

    setTool: setTool, getTool: function () { return S.tool; },
    setBrush: function (o) { Object.assign(S.brush, o); requestRender(); },
    getBrush: function () { return Object.assign({}, S.brush); },
    setOptions: function (o) { Object.assign(S.opt, o); },
    getOptions: function () { return Object.assign({}, S.opt); },

    getLayers: function () { return S.layers; },
    getActiveId: function () { return S.activeId; },
    getZones: function () { return RBX.getZones(S.type); },
    setActiveLayer: setActiveLayer, addLayer: addLayer, duplicateLayer: duplicateLayer,
    deleteLayer: deleteLayer, moveLayer: moveLayer, moveLayerTo: moveLayerTo, mergeDown: mergeDown,
    setLayerVisible: setLayerVisible, setLayerOpacity: setLayerOpacity, renameLayer: renameLayer,
    checkpoint: checkpoint, rasterizeLayer: rasterizeLayer, flipLayer: flipLayer,
    autoRemoveBg: autoRemoveBg, fitLayerToZone: fitLayerToZone, addImageFile: addImageFile,
    drawLayerThumb: drawLayerThumb,

    undo: undo, redo: redo,
    canUndo: function () { return S.undo.length > 0; },
    canRedo: function () { return S.redo.length > 0; },

    useDefaultTemplate: useDefaultTemplate, setTemplateFile: setTemplateFile, clearTemplate: clearTemplate,
    setTemplateOpacity: setTemplateOpacity, setShowZones: setShowZones,
    getTemplateInfo: function () {
      return { source: S.template.source, opacity: S.template.opacity, showZones: S.showZones,
               procedural: S.template.procedural, name: S.template.name || '' };
    },

    getInfo: function () { return { name: S.name, type: S.type, modified: S.modified }; },
    setName: function (n) { S.name = n; S.modified = true; fire('onModified'); },
    markSaved: function () { S.modified = false; fire('onModified'); },
    isModified: function () { return S.modified; }
  };
})(window);
