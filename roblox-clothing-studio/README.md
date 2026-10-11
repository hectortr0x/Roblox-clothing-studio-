# Roblox Clothing Studio

Editor web de camisas y pantalones de Roblox (plantilla 585×559) con vista 3D en tiempo real.

## Ejecutar
Abre `index.html` en el navegador (Chrome, Edge o Firefox). No necesita servidor.
Three.js y OrbitControls se cargan desde un CDN, así que hace falta internet la primera vez.
Para uso sin conexión, descarga `three.min.js` y `OrbitControls.js` (r128) a una carpeta `libs/` y cambia las dos etiquetas `<script>` de `index.html`.

## Estructura
- `index.html` / `style.css` — interfaz y tema oscuro
- `js/config.js` — constantes y regiones de la plantilla de Roblox
- `js/storage.js` — proyectos en IndexedDB (con respaldo en localStorage)
- `js/editor.js` — lienzo 2D: capas, pincel, borrador, relleno, imágenes, quitar fondo, historial
- `js/viewer3d.js` — avatar R6 en Three.js con textura dinámica
- `js/app.js` — dashboard, modales, paneles y atajos
- `assets/templates/shirt.png`, `pants.png` — plantillas guía (reemplázalas por las tuyas si quieres)

## Atajos
B pincel · E borrador · G relleno · I cuentagotas · M quitar fondo · V mover · H mano · [ ] tamaño ·
Espacio+arrastrar = desplazar · rueda = zoom · Ctrl+Z / Ctrl+Y · Ctrl+S guardar · Ctrl+V pega una imagen
