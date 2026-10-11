/* ==========================================================================
   config.js — Constantes globales y definición de regiones de la plantilla
   Plantilla oficial de Roblox: 585 x 559 px (camisas y pantalones).
   ========================================================================== */
(function (global) {
  'use strict';
  const RBX = global.RBX = global.RBX || {};

  /** Resolución exacta que exige Roblox. */
  RBX.TEMPLATE_W = 585;
  RBX.TEMPLATE_H = 559;

  /**
   * Rutas locales predeterminadas de las plantillas guía.
   * Coloca tus PNG en estas rutas (relativas a index.html) y se cargarán solos.
   * Si el archivo no existe, la app dibuja una guía procedimental equivalente.
   */
  RBX.DEFAULT_TEMPLATE_PATHS = {
    shirt: 'assets/templates/shirt.png',
    pants: 'assets/templates/pants.png'
  };

  /** Tipos de prenda. */
  RBX.GARMENTS = {
    shirt: { label: 'Camisa / Shirt', defaultName: 'Mi camisa',   limbName: 'Brazo'  },
    pants: { label: 'Pantalón / Pants', defaultName: 'Mi pantalón', limbName: 'Pierna' }
  };

  /**
   * Regiones [x, y, ancho, alto] de la plantilla de Roblox.
   * Camisa y pantalón comparten el mismo diseño de plantilla:
   *   - torso: torso / cintura
   *   - limbR: brazo derecho (camisa) o pierna derecha (pantalón)
   *   - limbL: brazo izquierdo (camisa) o pierna izquierda (pantalón)
   * Caras: top, bottom, right, front, left, back.
   */
  RBX.REGIONS = {
    torso: {
      top:    [231,   8, 128,  64],
      bottom: [231, 204, 128,  64],
      right:  [165,  74,  64, 128],
      front:  [231,  74, 128, 128],
      left:   [361,  74,  64, 128],
      back:   [427,  74, 128, 128]
    },
    limbR: {
      top:    [217, 289,  64,  64],
      bottom: [217, 485,  64,  64],
      right:  [ 19, 355,  64, 128],
      front:  [ 85, 355,  64, 128],
      left:   [151, 355,  64, 128],
      back:   [217, 355,  64, 128]
    },
    limbL: {
      top:    [308, 289,  64,  64],
      bottom: [308, 485,  64,  64],
      right:  [308, 355,  64, 128],
      front:  [374, 355,  64, 128],
      left:   [440, 355,  64, 128],
      back:   [506, 355,  64, 128]
    }
  };

  const FACE_ES = { top: 'Arriba', bottom: 'Abajo', right: 'Derecha', front: 'Frente', left: 'Izquierda', back: 'Espalda' };

  /** Lista plana de zonas (para guías y para "ajustar imagen a zona"). */
  RBX.getZones = function (type) {
    const g = RBX.GARMENTS[type] || RBX.GARMENTS.shirt;
    const names = { torso: 'Torso', limbR: g.limbName + ' der.', limbL: g.limbName + ' izq.' };
    const out = [];
    ['torso', 'limbR', 'limbL'].forEach(function (part) {
      ['front', 'back', 'right', 'left', 'top', 'bottom'].forEach(function (face) {
        out.push({
          key: part + '.' + face,
          label: names[part] + ' · ' + FACE_ES[face],
          short: FACE_ES[face],
          part: part,
          face: face,
          rect: RBX.REGIONS[part][face]
        });
      });
    });
    return out;
  };

  /** Rótulos de grupo que se dibujan sobre la plantilla (x, y en px de plantilla). */
  RBX.getGroupCaptions = function (type) {
    const g = RBX.GARMENTS[type] || RBX.GARMENTS.shirt;
    return [
      { text: 'TORSO',                    x: 167, y: 24 },
      { text: g.limbName.toUpperCase() + ' DER.', x: 21,  y: 312 },
      { text: g.limbName.toUpperCase() + ' IZQ.', x: 376, y: 312 }
    ];
  };
})(window);
