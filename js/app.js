/* ==========================================================================
   app.js — Pegamento de la interfaz: dashboard, modales, paneles y atajos
   ========================================================================== */
(function () {
  'use strict';
  const RBX = window.RBX, E = RBX.Editor, V = RBX.Viewer, DB = RBX.Storage;

  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  const nextFrame = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };

  let screen = 'dashboard';
  let currentId = null;
  let viewerReady = false;
  let newType = 'shirt';

  const ICON_EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M17.9 17.9A10.1 10.1 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 5.1-5.9"/><path d="M9.9 4.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2"/><path d="M1 1l22 22"/></svg>';

  const HINTS = {
    brush: 'Pincel · clic y arrastra para pintar · [ ] cambian el tamaño',
    eraser: 'Borrador · borra píxeles de la capa activa',
    fill: 'Relleno · rellena la zona contigua del color pulsado (ajusta la tolerancia)',
    picker: 'Cuentagotas · toma un color del lienzo',
    magic: 'Quitar fondo · pulsa el color de fondo de la capa activa para hacerlo transparente',
    move: 'Mover · arrastra la imagen · esquinas escalan (Shift = estirar libre) · círculo superior rota (Shift = 15°)',
    hand: 'Mano · arrastra para desplazar la vista · rueda del ratón = zoom'
  };

  /* ------------------------------------------------------------- utilidades */
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 4200 : 2800);
  }

  /** Diálogo de confirmación. Devuelve 'ok' | 'alt' | 'cancel'. */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      const m = $('#modal-confirm'), ok = $('#confirm-ok'), alt = $('#confirm-alt'), cancel = $('#confirm-cancel');
      $('#confirm-title').textContent = opts.title;
      $('#confirm-text').textContent = opts.text;
      ok.textContent = opts.ok || 'Aceptar';
      ok.classList.toggle('danger', !!opts.danger);
      alt.hidden = !opts.alt; alt.textContent = opts.alt || '';
      m.hidden = false;
      function done(v) { m.hidden = true; ok.onclick = alt.onclick = cancel.onclick = null; resolve(v); }
      ok.onclick = function () { done('ok'); };
      alt.onclick = function () { done('alt'); };
      cancel.onclick = function () { done('cancel'); };
      m._cancel = function () { done('cancel'); };
      ok.focus();
    });
  }

  function showScreen(name) {
    screen = name;
    document.body.dataset.screen = name;
    $('#screen-dashboard').hidden = name !== 'dashboard';
    $('#screen-editor').hidden = name !== 'editor';
    E.setActive(name === 'editor');
    if (V.isReady()) V.setActive(name === 'editor');
  }

  /* -------------------------------------------------------------- dashboard */
  async function renderDashboard() {
    let items = [];
    try { items = await DB.list(); } catch (e) { toast('No se pudieron leer los proyectos', 'error'); }
    const grid = $('#project-grid');
    grid.innerHTML = '';
    $('#empty-state').hidden = items.length > 0;
    $('#project-count').textContent = items.length ? items.length + (items.length === 1 ? ' proyecto' : ' proyectos') : '';
    items.forEach(function (p) {
      const card = document.createElement('div');
      card.className = 'card'; card.dataset.id = p.id;
      const date = new Date(p.updated).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
      card.innerHTML =
        '<img class="thumb" alt="" src="' + (p.thumb || '') + '">' +
        '<div class="meta"><div class="name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
        '<div class="sub"><span class="tag">' + esc((RBX.GARMENTS[p.type] || {}).label || p.type) + '</span><span>' + esc(date) + '</span></div></div>' +
        '<div class="actions"><button class="btn sm" data-act="open">Abrir</button>' +
        '<button class="btn sm ghost danger" data-act="delete">Eliminar</button></div>';
      grid.appendChild(card);
    });
  }

  $('#project-grid').addEventListener('click', async function (e) {
    const card = e.target.closest('.card'); if (!card) return;
    const id = card.dataset.id, act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'delete') {
      e.stopPropagation();
      const name = card.querySelector('.name').textContent;
      const r = await confirmDialog({ title: 'Eliminar proyecto', text: '¿Eliminar "' + name + '"? Esta acción no se puede deshacer.', ok: 'Eliminar', danger: true });
      if (r === 'ok') { await DB.remove(id); toast('Proyecto eliminado'); renderDashboard(); }
      return;
    }
    openProject(id);
  });

  /* ---------------------------------------------------------- nuevo proyecto */
  function openNewModal() {
    selectType('shirt');
    $('#modal-new').hidden = false;
    const inp = $('#new-name'); inp.focus(); inp.select();
  }
  function selectType(t) {
    const prevDefault = (RBX.GARMENTS[newType] || {}).defaultName;
    newType = t;
    $$('.type-card').forEach(function (c) { c.classList.toggle('selected', c.dataset.type === t); });
    const inp = $('#new-name');
    if (!inp.value.trim() || inp.value === prevDefault || inp.value === RBX.GARMENTS.shirt.defaultName || inp.value === RBX.GARMENTS.pants.defaultName) {
      inp.value = RBX.GARMENTS[t].defaultName;
    }
  }
  $$('.type-card').forEach(function (c) { c.addEventListener('click', function () { selectType(c.dataset.type); }); });
  $('#btn-new-project').addEventListener('click', openNewModal);
  $('#btn-cancel-new').addEventListener('click', function () { $('#modal-new').hidden = true; });
  $('#btn-create').addEventListener('click', function () {
    const name = $('#new-name').value.trim() || RBX.GARMENTS[newType].defaultName;
    $('#modal-new').hidden = true;
    createProject(newType, name);
  });
  $('#new-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btn-create').click(); });

  /* ------------------------------------------------------------------ editor */
  async function enterEditor(type) {
    showScreen('editor');
    await nextFrame();
    if (!viewerReady) viewerReady = V.init($('#viewer'), E.getTextureCanvas());
    V.setGarment(type);
    E.setActive(true);
    E.resizeView(); E.fitView();
    V.resize(); V.setActive(true);
    syncAll();
  }
  async function createProject(type, name) {
    currentId = null;
    await E.newProject(type, name);
    $('#project-name').value = name;
    await enterEditor(type);
  }
  async function openProject(id) {
    let rec = null;
    try { rec = await DB.get(id); } catch (e) { /* ignorar */ }
    if (!rec) { toast('No se pudo abrir el proyecto', 'error'); return; }
    try { await E.load(rec); } catch (e) { toast('El proyecto está dañado: ' + e.message, 'error'); return; }
    currentId = id;
    $('#project-name').value = E.getInfo().name;
    await enterEditor(rec.data.type);
  }

  async function saveProject() {
    if (screen !== 'editor') return false;
    const info = E.getInfo();
    if (!currentId) currentId = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = { id: currentId, name: info.name || 'Sin título', type: info.type, thumb: E.getThumbnail(), updated: Date.now() };
    try {
      await DB.save(meta, E.serialize());
      E.markSaved(); toast('Proyecto guardado');
      return true;
    } catch (err) {
      toast('No se pudo guardar: ' + err.message, 'error');
      return false;
    }
  }

  async function goHome() {
    if (screen !== 'editor') return;
    if (E.isModified()) {
      const r = await confirmDialog({ title: 'Cambios sin guardar', text: 'Tienes cambios sin guardar en este proyecto.', ok: 'Guardar y salir', alt: 'Salir sin guardar' });
      if (r === 'cancel') return;
      if (r === 'ok' && !(await saveProject())) return;
    }
    showScreen('dashboard');
    renderDashboard();
  }

  $('#btn-home').addEventListener('click', goHome);
  $('#brand').addEventListener('click', goHome);
  $('#btn-save').addEventListener('click', saveProject);
  $('#btn-export').addEventListener('click', function () {
    const info = E.getInfo();
    const safe = (info.name || 'roblox').replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim().replace(/\s+/g, '-') || 'roblox';
    E.exportPNG(safe + '-' + info.type);
  });
  $('#btn-undo').addEventListener('click', function () { E.undo(); });
  $('#btn-redo').addEventListener('click', function () { E.redo(); });
  $('#project-name').addEventListener('input', function (e) { E.setName(e.target.value); });

  /* ------------------------------------------------------- herramientas / opciones */
  $$('.tool[data-tool]').forEach(function (b) { b.addEventListener('click', function () { E.setTool(b.dataset.tool); }); });

  const RECENT_KEY = 'rbx-recent-colors';
  const DEFAULT_SWATCHES = ['#ffffff', '#000000', '#8d96a8', '#e5484d', '#f5a524', '#f5d90a', '#30a46c', '#0091ff', '#8e4ec6'];
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { recent = []; }
  function renderSwatches() {
    const box = $('#opt-swatches'); box.innerHTML = '';
    recent.concat(DEFAULT_SWATCHES).filter(function (c, i, a) { return a.indexOf(c) === i; }).slice(0, 16).forEach(function (c) {
      const b = document.createElement('button');
      b.className = 'swatch'; b.style.background = c; b.title = c; b.dataset.color = c;
      box.appendChild(b);
    });
  }
  function pushRecent(c) {
    c = c.toLowerCase();
    recent = [c].concat(recent.filter(function (x) { return x !== c; })).slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (e) { /* ignorar */ }
  }
  $('#opt-swatches').addEventListener('click', function (e) {
    const b = e.target.closest('.swatch'); if (!b) return;
    E.setBrush({ color: b.dataset.color }); $('#opt-color').value = b.dataset.color;
  });
  $('#opt-color').addEventListener('input', function (e) { E.setBrush({ color: e.target.value }); });
  $('#opt-color').addEventListener('change', function (e) { pushRecent(e.target.value); renderSwatches(); });

  function bindRange(id, outId, apply) {
    $(id).addEventListener('input', function (e) { $(outId).textContent = e.target.value; apply(+e.target.value); });
  }
  bindRange('#opt-size', '#opt-size-val', function (v) { E.setBrush({ size: v }); });
  bindRange('#opt-opacity', '#opt-opacity-val', function (v) { E.setBrush({ opacity: v }); });
  bindRange('#opt-tol', '#opt-tol-val', function (v) { E.setOptions({ tol: v }); });
  $('#opt-shape').addEventListener('change', function (e) { E.setBrush({ shape: e.target.value }); });
  $('#opt-contig').addEventListener('change', function (e) { E.setOptions({ contiguous: e.target.checked }); });
  $('#opt-all').addEventListener('change', function (e) { E.setOptions({ allLayers: e.target.checked }); });
  $('#opt-zone').addEventListener('change', function (e) { E.setOptions({ zoneLimit: e.target.checked }); });

  function syncOptions() {
    const tool = E.getTool(), b = E.getBrush(), o = E.getOptions();
    $$('#optionsbar [data-tools]').forEach(function (el) { el.hidden = el.dataset.tools.split(' ').indexOf(tool) < 0; });
    $('#opt-color').value = b.color;
    $('#opt-size').value = b.size; $('#opt-size-val').textContent = b.size;
    $('#opt-opacity').value = b.opacity; $('#opt-opacity-val').textContent = b.opacity;
    $('#opt-shape').value = b.shape;
    $('#opt-tol').value = o.tol; $('#opt-tol-val').textContent = o.tol;
    $('#opt-contig').checked = o.contiguous; $('#opt-all').checked = o.allLayers; $('#opt-zone').checked = o.zoneLimit;
    $('#opt-note').textContent = 'Capa de imagen: arrastra para mover · en capas raster desplaza todos los píxeles';
  }

  /* -------------------------------------------------------------- imágenes */
  $('#btn-add-image').addEventListener('click', function () { $('#file-image').click(); });
  $('#file-image').addEventListener('change', async function (e) {
    const files = Array.prototype.slice.call(e.target.files);
    for (let i = 0; i < files.length; i++) await E.addImageFile(files[i]);
    e.target.value = '';
  });
  const stage = $('#stage');
  ['dragenter', 'dragover'].forEach(function (ev) {
    stage.addEventListener(ev, function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { e.preventDefault(); $('#drop-hint').hidden = false; }
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) { stage.addEventListener(ev, function () { $('#drop-hint').hidden = true; }); });
  stage.addEventListener('drop', async function (e) {
    e.preventDefault();
    const files = Array.prototype.slice.call(e.dataTransfer.files);
    for (let i = 0; i < files.length; i++) await E.addImageFile(files[i]);
  });
  window.addEventListener('paste', function (e) {
    if (screen !== 'editor' || !e.clipboardData) return;
    const items = Array.prototype.slice.call(e.clipboardData.items || []);
    const it = items.filter(function (x) { return x.kind === 'file' && /^image\//.test(x.type); })[0];
    if (it) { e.preventDefault(); E.addImageFile(it.getAsFile()); }
  });

  /* ---------------------------------------------------------------- zoom */
  $('#z-in').addEventListener('click', function () { E.zoomBy(1.25); });
  $('#z-out').addEventListener('click', function () { E.zoomBy(0.8); });
  $('#z-fit').addEventListener('click', function () { E.fitView(); });
  $('#z-100').addEventListener('click', function () { E.zoomTo100(); });

  /* ---------------------------------------------------------------- capas */
  function renderLayers() {
    const list = $('#layer-list'), layers = E.getLayers(), activeId = E.getActiveId();
    list.innerHTML = '';
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const li = document.createElement('li');
      li.className = 'layer' + (l.id === activeId ? ' active' : '') + (l.visible ? '' : ' hidden-layer');
      li.dataset.id = l.id; li.draggable = true;
      li.innerHTML =
        '<button class="icon-btn" data-act="vis" title="Mostrar / ocultar">' + (l.visible ? ICON_EYE : ICON_EYE_OFF) + '</button>' +
        '<canvas class="thumb" width="40" height="38"></canvas>' +
        '<span class="lname" title="Doble clic para renombrar">' + esc(l.name) + '</span>' +
        '<span class="lkind">' + (l.kind === 'image' ? 'IMG' : 'RAS') + '</span>';
      list.appendChild(li);
      E.drawLayerThumb(l.id, li.querySelector('canvas'));
    }
    renderProps();
  }

  const layerList = $('#layer-list');
  layerList.addEventListener('click', function (e) {
    const li = e.target.closest('.layer'); if (!li) return;
    const id = +li.dataset.id;
    if (e.target.closest('[data-act="vis"]')) {
      const l = E.getLayers().filter(function (x) { return x.id === id; })[0];
      E.setLayerVisible(id, !l.visible);
    } else E.setActiveLayer(id);
  });
  layerList.addEventListener('dblclick', function (e) {
    const name = e.target.closest('.lname'); if (!name) return;
    const li = name.closest('.layer'), id = +li.dataset.id;
    const inp = document.createElement('input');
    inp.className = 'lname-input'; inp.value = name.textContent; inp.maxLength = 40;
    name.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    function commit(save) { if (done) return; done = true; if (save) E.renameLayer(id, inp.value); renderLayers(); }
    inp.addEventListener('blur', function () { commit(true); });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') commit(true);
      if (ev.key === 'Escape') commit(false);
      ev.stopPropagation();
    });
  });
  let dragLayerId = null;
  layerList.addEventListener('dragstart', function (e) {
    const li = e.target.closest('.layer'); if (!li) return;
    dragLayerId = +li.dataset.id; e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragLayerId)); } catch (_) { /* ignorar */ }
  });
  layerList.addEventListener('dragover', function (e) {
    const li = e.target.closest('.layer'); if (!li || dragLayerId === null) return;
    e.preventDefault(); $$('.layer.drag-over', layerList).forEach(function (x) { x.classList.remove('drag-over'); }); li.classList.add('drag-over');
  });
  layerList.addEventListener('dragleave', function (e) { const li = e.target.closest('.layer'); if (li) li.classList.remove('drag-over'); });
  layerList.addEventListener('drop', function (e) {
    const li = e.target.closest('.layer'); if (!li || dragLayerId === null) return;
    e.preventDefault(); E.moveLayerTo(dragLayerId, +li.dataset.id); dragLayerId = null;
  });
  layerList.addEventListener('dragend', function () { dragLayerId = null; $$('.layer.drag-over', layerList).forEach(function (x) { x.classList.remove('drag-over'); }); });

  $('#ly-add').addEventListener('click', function () { E.addLayer(); });
  $('#ly-dup').addEventListener('click', function () { E.duplicateLayer(); });
  $('#ly-up').addEventListener('click', function () { E.moveLayer(undefined, 1); });
  $('#ly-down').addEventListener('click', function () { E.moveLayer(undefined, -1); });
  $('#ly-merge').addEventListener('click', function () { E.mergeDown(); });
  $('#ly-del').addEventListener('click', function () { E.deleteLayer(); });

  function renderProps() {
    const box = $('#layer-props');
    const l = E.getLayers().filter(function (x) { return x.id === E.getActiveId(); })[0];
    if (!l) { box.innerHTML = ''; return; }
    let html =
      '<div class="prop-row"><label>Opacidad</label><input type="range" id="lp-opacity" min="0" max="100" value="' + Math.round(l.opacity * 100) + '"><output id="lp-opacity-val" style="min-width:34px;text-align:right;color:var(--text)">' + Math.round(l.opacity * 100) + '%</output></div>' +
      '<div class="prop-grid">' +
      '<button class="btn sm" id="lp-fh">Voltear horizontal</button>' +
      '<button class="btn sm" id="lp-fv">Voltear vertical</button>' +
      '<button class="btn sm" id="lp-bg" title="Usa el color de las esquinas y la tolerancia de la barra de opciones">Quitar fondo (auto)</button>';
    if (l.kind === 'image') html += '<button class="btn sm" id="lp-ras">Rasterizar capa</button>';
    html += '</div>';
    if (l.kind === 'image') {
      html += '<div class="prop-row"><label>Estirar a zona</label><select id="lp-zone">' +
        E.getZones().map(function (z) { return '<option value="' + z.key + '">' + esc(z.label) + '</option>'; }).join('') +
        '</select><button class="btn sm" id="lp-fit">Ajustar</button></div>' +
        '<p class="hint">Con la herramienta Mover (V): arrastra para mover, esquinas para escalar (Shift = estirar libre) y el círculo superior para rotar.</p>';
    } else {
      html += '<p class="hint">Capa raster. Las imágenes importadas aparecen como capas de imagen transformables.</p>';
    }
    box.innerHTML = html;

    const op = $('#lp-opacity');
    op.addEventListener('pointerdown', function () { E.checkpoint(); });
    op.addEventListener('input', function () { $('#lp-opacity-val').textContent = op.value + '%'; E.setLayerOpacity(l.id, op.value / 100); });
    op.addEventListener('change', function () { renderLayers(); });
    $('#lp-fh').addEventListener('click', function () { E.flipLayer(l.id, 'h'); });
    $('#lp-fv').addEventListener('click', function () { E.flipLayer(l.id, 'v'); });
    $('#lp-bg').addEventListener('click', function () { E.autoRemoveBg(l.id); toast('Fondo eliminado · ajusta la tolerancia si quedó algo (Ctrl+Z para deshacer)'); });
    if (l.kind === 'image') {
      $('#lp-ras').addEventListener('click', function () { E.rasterizeLayer(l.id); });
      $('#lp-fit').addEventListener('click', function () { E.fitLayerToZone(l.id, $('#lp-zone').value); });
    }
  }

  /* ------------------------------------------------------------ plantilla */
  $('#tpl-load').addEventListener('click', function () { $('#file-template').click(); });
  $('#file-template').addEventListener('change', async function (e) {
    if (e.target.files[0]) await E.setTemplateFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#tpl-default').addEventListener('click', function () { E.useDefaultTemplate(); });
  $('#tpl-clear').addEventListener('click', function () { E.clearTemplate(); });
  $('#tpl-opacity').addEventListener('input', function (e) { $('#tpl-opacity-val').textContent = e.target.value; E.setTemplateOpacity(e.target.value / 100); });
  $('#tpl-zones').addEventListener('change', function (e) { E.setShowZones(e.target.checked); });
  function syncTemplate() {
    const t = E.getTemplateInfo();
    $('#tpl-opacity').value = Math.round(t.opacity * 100); $('#tpl-opacity-val').textContent = Math.round(t.opacity * 100);
    $('#tpl-zones').checked = t.showZones;
    $('#tpl-name').textContent = t.source === 'custom' ? 'Personalizada' + (t.name ? ': ' + t.name : '')
      : t.source === 'none' ? 'Sin plantilla'
      : (t.procedural ? 'Guía integrada (puedes poner tu PNG en assets/templates/)' : 'Predeterminada (assets/templates/)');
  }

  /* ------------------------------------------------------------- visor 3D */
  $('#v-front').addEventListener('click', function () { V.setView('front'); });
  $('#v-back').addEventListener('click', function () { V.setView('back'); });
  $('#v-side').addEventListener('click', function () { V.setView('side'); });
  $('#v-reset').addEventListener('click', function () { V.setView('reset'); });
  $('#v-auto').addEventListener('change', function (e) { V.setAutoRotate(e.target.checked); });
  $('#v-comp').addEventListener('change', function (e) { V.setComplement(e.target.checked); });
  $('#v-skin').addEventListener('input', function (e) { V.setSkin(e.target.value); });

  /* --------------------------------------------------------- hooks del editor */
  function syncHistory() { $('#btn-undo').disabled = !E.canUndo(); $('#btn-redo').disabled = !E.canRedo(); }
  function syncAll() { syncOptions(); syncTemplate(); renderLayers(); syncHistory(); setToolUI(E.getTool()); $('#modified-dot').hidden = !E.isModified(); }
  function setToolUI(t) {
    $$('.tool[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
    $('#st-hint').textContent = HINTS[t] || '';
    syncOptions();
  }

  E.init($('#view'), {
    onToast: toast,
    onTexture: function () { V.refresh(); },
    onLayers: function () { renderLayers(); },
    onHistory: syncHistory,
    onModified: function () { $('#modified-dot').hidden = !E.isModified(); },
    onTool: setToolUI,
    onTemplate: syncTemplate,
    onPaint: function (c) { pushRecent(c); },
    onColorPicked: function (hex) { $('#opt-color').value = hex; pushRecent(hex); renderSwatches(); toast('Color ' + hex); },
    onView: function (z) { $('#st-zoom').textContent = Math.round(z * 100) + '%'; },
    onCursor: function (x, y) { $('#st-pos').textContent = x === null ? '—' : x + ', ' + y + ' px'; }
  });
  renderSwatches();

  /* ---------------------------------------------------------------- atajos */
  window.addEventListener('keydown', function (e) {
    const modals = $$('.modal').filter(function (m) { return !m.hidden; });
    if (e.key === 'Escape' && modals.length) {
      const m = modals[modals.length - 1];
      if (m._cancel) m._cancel(); else m.hidden = true;
      return;
    }
    if (modals.length || screen !== 'editor') return;
    const t = e.target;
    const typing = t && ((t.tagName === 'INPUT' && !/^(checkbox|range|color|button)$/.test(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); saveProject(); return; }
    if (typing) return;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? E.redo() : E.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); E.redo(); return; }
    if (mod) return;
    const map = { b: 'brush', e: 'eraser', g: 'fill', i: 'picker', m: 'magic', v: 'move', h: 'hand' };
    if (map[k]) { E.setTool(map[k]); return; }
    if (k === '[' || k === ']') {
      const b = E.getBrush(), step = b.size < 10 ? 1 : (b.size < 40 ? 4 : 10);
      const size = Math.max(1, Math.min(120, b.size + (k === ']' ? step : -step)));
      E.setBrush({ size: size }); syncOptions();
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (screen === 'editor' && E.isModified()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------------------------------------------ inicio */
  showScreen('dashboard');
  renderDashboard();
})();
