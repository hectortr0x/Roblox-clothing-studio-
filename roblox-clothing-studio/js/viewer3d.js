/* ==========================================================================
   viewer3d.js — Visor 3D (Three.js r128) con avatar Roblox R6 "blocky"

   - La textura es el <canvas> compuesto del editor (CanvasTexture), así que
     cualquier cambio 2D se refleja al instante llamando a `refresh()`.
   - Cada pieza del cuerpo es una caja con UV remapeados a las regiones
     de la plantilla de Roblox (ver RBX.REGIONS).
   - Sobre la piel se colocan "capas" de prenda ligeramente más grandes:
       camisa  → torso + brazos      pantalón → torso + piernas
     La prenda en edición usa la textura; la complementaria es un color plano.
   ========================================================================== */
(function (global) {
  'use strict';
  const RBX = global.RBX;
  const W = RBX.TEMPLATE_W, H = RBX.TEMPLATE_H;

  let container, renderer, scene, camera, controls, texture;
  let active = false, raf = 0, ready = false;
  let garment = 'shirt', skinColor = '#f5cd30', showComplement = true;
  let skinMat, headMats = [], faceCanvas, faceTex, texMat, flatShirt, flatPants;
  const parts = {};

  // Medidas en studs. Frente del avatar = +Z (cámara por defecto), derecha del personaje = -X.
  const BODY = {
    torso: { size: [2, 2, 1], pos: [0, 3, 0],    region: 'torso', shirt: true,  pants: true  },
    armR:  { size: [1, 2, 1], pos: [-1.5, 3, 0], region: 'limbR', shirt: true,  pants: false },
    armL:  { size: [1, 2, 1], pos: [1.5, 3, 0],  region: 'limbL', shirt: true,  pants: false },
    legR:  { size: [1, 2, 1], pos: [-0.5, 1, 0], region: 'limbR', shirt: false, pants: true  },
    legL:  { size: [1, 2, 1], pos: [0.5, 1, 0],  region: 'limbL', shirt: false, pants: true  }
  };
  // Orden de caras de BoxGeometry: +x, -x, +y, -y, +z, -z
  const FACE_ORDER = ['left', 'right', 'top', 'bottom', 'front', 'back'];

  /** Caja cuyos UV apuntan a las regiones [x,y,w,h] de la plantilla. */
  function regionBox(size, regions) {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const uv = g.attributes.uv;
    for (let f = 0; f < 6; f++) {
      const r = regions[FACE_ORDER[f]];
      for (let i = 0; i < 4; i++) {
        const idx = f * 4 + i, u0 = uv.getX(idx), v0 = uv.getY(idx);
        uv.setXY(idx, (r[0] + u0 * r[2]) / W, 1 - (r[1] + (1 - v0) * r[3]) / H);
      }
    }
    uv.needsUpdate = true;
    return g;
  }

  function drawFace() {
    const c = faceCanvas.getContext('2d');
    c.fillStyle = skinColor; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#1a1a1a';
    c.fillRect(16, 20, 8, 12); c.fillRect(40, 20, 8, 12);          // ojos
    c.lineWidth = 4; c.lineCap = 'round'; c.strokeStyle = '#1a1a1a';
    c.beginPath(); c.arc(32, 36, 14, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke(); // sonrisa
    if (faceTex) faceTex.needsUpdate = true;
  }

  function buildAvatar() {
    skinMat = new THREE.MeshLambertMaterial({ color: skinColor });
    flatShirt = new THREE.MeshLambertMaterial({ color: '#8d96a8' });
    flatPants = new THREE.MeshLambertMaterial({ color: '#2c3340' });
    texMat = new THREE.MeshLambertMaterial({ map: texture, transparent: true, depthWrite: false });

    // Cabeza con cara
    faceCanvas = document.createElement('canvas'); faceCanvas.width = faceCanvas.height = 64;
    faceTex = new THREE.CanvasTexture(faceCanvas);
    drawFace();
    headMats = [0, 1, 2, 3, 4, 5].map(function (i) {
      return i === 4 ? new THREE.MeshLambertMaterial({ map: faceTex }) : new THREE.MeshLambertMaterial({ color: skinColor });
    });
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.25, 1.25), headMats);
    head.position.set(0, 4.625, 0);
    scene.add(head);

    // Cuerpo
    Object.keys(BODY).forEach(function (name) {
      const def = BODY[name];
      const group = new THREE.Group();
      group.position.set(def.pos[0], def.pos[1], def.pos[2]);
      group.add(new THREE.Mesh(new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]), skinMat));
      const geo = regionBox(def.size, RBX.REGIONS[def.region]);
      const rec = {};
      if (def.pants) { rec.pants = new THREE.Mesh(geo, flatPants); rec.pants.scale.setScalar(1.025); group.add(rec.pants); }
      if (def.shirt) { rec.shirt = new THREE.Mesh(geo, flatShirt); rec.shirt.scale.setScalar(1.045); group.add(rec.shirt); }
      scene.add(group);
      parts[name] = rec;
    });

    // Suelo
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.MeshBasicMaterial({ color: 0x1a1d24 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.92, 4, 96), new THREE.MeshBasicMaterial({ color: 0x3a404d, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; scene.add(ring);
  }

  function applyGarment() {
    Object.keys(parts).forEach(function (n) {
      const p = parts[n];
      if (p.shirt) { p.shirt.material = garment === 'shirt' ? texMat : flatShirt; p.shirt.visible = garment === 'shirt' || showComplement; }
      if (p.pants) { p.pants.material = garment === 'pants' ? texMat : flatPants; p.pants.visible = garment === 'pants' || showComplement; }
    });
  }

  function resize() {
    if (!ready || !container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function loop() {
    if (!active) { raf = 0; return; }
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  }

  const V = {
    /** Devuelve false si no se pudo iniciar (sin Three.js o sin WebGL). */
    init: function (el, textureCanvas) {
      container = el;
      if (typeof THREE === 'undefined' || !THREE.OrbitControls) {
        el.innerHTML = '<div class="viewer-error">No se pudo cargar Three.js.<br>Revisa tu conexión a internet (se carga desde un CDN) y recarga la página.</div>';
        return false;
      }
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch (e) {
        el.innerHTML = '<div class="viewer-error">Tu navegador no soporta WebGL, necesario para el visor 3D.</div>';
        return false;
      }
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
      scene.add(new THREE.AmbientLight(0xffffff, 0.72));
      const key = new THREE.DirectionalLight(0xffffff, 0.45); key.position.set(3, 7, 8); scene.add(key);
      const back = new THREE.DirectionalLight(0xffffff, 0.28); back.position.set(-4, 4, -7); scene.add(back);

      texture = new THREE.CanvasTexture(textureCanvas);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;

      buildAvatar();
      applyGarment();

      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = 0.08;
      controls.minDistance = 4; controls.maxDistance = 26;
      controls.maxPolarAngle = Math.PI * 0.56;
      controls.autoRotateSpeed = 2.2;
      ready = true;
      V.setView('front');
      resize();
      if (global.ResizeObserver) new ResizeObserver(resize).observe(el);
      return true;
    },
    isReady: function () { return ready; },
    resize: resize,
    setActive: function (v) {
      active = !!v && ready;
      if (active && !raf) { resize(); loop(); }
    },
    /** Avisar que el canvas de textura cambió. */
    refresh: function () { if (texture) texture.needsUpdate = true; },
    setGarment: function (g) { garment = g; if (ready) applyGarment(); },
    setComplement: function (show) { showComplement = !!show; if (ready) applyGarment(); },
    setSkin: function (hex) {
      skinColor = hex; if (!ready) return;
      skinMat.color.set(hex);
      headMats.forEach(function (m, i) { if (i !== 4) m.color.set(hex); });
      drawFace();
    },
    setAutoRotate: function (v) { if (ready) controls.autoRotate = !!v; },
    setView: function (name) {
      if (!ready) return;
      const d = 12.5, y = 3.6;
      const pos = { front: [0, y, d], back: [0, y, -d], side: [d, y, 0], reset: [5.5, 5.5, 11] }[name] || [0, y, d];
      camera.position.set(pos[0], pos[1], pos[2]);
      controls.target.set(0, 2.7, 0);
      controls.update();
    }
  };

  RBX.Viewer = V;
})(window);
