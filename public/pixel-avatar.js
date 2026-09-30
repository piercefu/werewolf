// Pixel-art avatar generator — purely cosmetic.
//
// Turns a short seed string (stored per player on the server) into a little
// 8-bit critter as an inline SVG string. Everything is drawn from code, so
// there are no image files and nothing to download. Same seed -> same
// critter, on every phone.
//
// Deliberately never produces anything that could be read as game
// information: no wolves / pointy ears, no crowns (Werewolf King), no badges
// or stars (Sheriff), no ghosts, skulls or halos (dead), no fangs.
(function (root) {
  'use strict';

  const G = 12; // grid is G x G, left half mirrored onto the right

  function hash(s) {
    let h = 2166136261;
    for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = hash(seed);
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // [background, body, body-shade, accent]
  const PALETTES = [
    ['#ffe5b4', '#ff8c42', '#c4561b', '#ffd23f'],
    ['#d0f4de', '#2ec4b6', '#127c73', '#ffbf69'],
    ['#e4c1f9', '#7b2cbf', '#4a1880', '#ff9ecd'],
    ['#fcf6bd', '#90be6d', '#4f772d', '#f94144'],
    ['#a9def9', '#3a86ff', '#1d4ea8', '#ffbe0b'],
    ['#ffc6ff', '#ff5d8f', '#b2204f', '#ffe066'],
    ['#caffbf', '#43aa8b', '#1f6f58', '#f9844a'],
    ['#fde4cf', '#e76f51', '#9d3a22', '#2a9d8f'],
    ['#bde0fe', '#ffafcc', '#c26b8e', '#6a4c93'],
    ['#fff1e6', '#8d99ae', '#4a5568', '#ef233c'],
    ['#e9edc9', '#d4a373', '#8a5a2b', '#588157'],
    ['#cddafd', '#6c63ff', '#3b33b5', '#00f5d4'],
    ['#ffd6a5', '#9b5de5', '#5f2a9e', '#00bbf9'],
    ['#b9fbc0', '#f15bb5', '#9c1f6e', '#fee440'],
    ['#fbe7c6', '#06d6a0', '#03845f', '#ef476f'],
    ['#dee2ff', '#ffb703', '#b07a00', '#219ebc'],
    ['#ffe0e9', '#8ac926', '#4d7a0c', '#6a4c93'],
    ['#e0fbfc', '#ee6c4d', '#a33a20', '#3d5a80'],
    ['#f1e4ff', '#00a6fb', '#0063a3', '#ff6d00'],
    ['#fff8e1', '#5e548e', '#352e5c', '#f7b267'],
  ];

  // Body shapes, each a predicate on (dx, y) where dx is the distance from
  // the vertical center line (0.5, 1.5, ... 5.5) and y is the row (0..11).
  const SHAPES = {
    blob(r) { const rx = 3.6 + r() * 1.8, ry = 3.4 + r() * 1.4, cy = 6.4 + r() * 0.8; return (dx, y) => (dx / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1; },
    tall(r) { const w = 2.6 + r() * 1.2; return (dx, y) => y >= 2 && y <= 10 && dx <= w + (y > 6 ? 0.8 : 0) && !(y === 2 && dx > w - 1); },
    robot(r) { const w = 3 + Math.floor(r() * 2) + 0.5, top = 3 + Math.floor(r() * 2); return (dx, y) => y >= top && y <= 10 && dx <= w; },
    invader(r) {
      const rows = [];
      for (let y = 0; y < G; y++) { rows[y] = []; for (let i = 0; i < 6; i++) rows[y][i] = r() < (y < 3 ? 0.08 : y > 9 ? 0.25 : 0.6); }
      return (dx, y) => { const i = 5 - Math.floor(dx); if (y < 1 || y > 10 || dx > 5) return false; if (dx < 3 && y >= 4 && y <= 7) return true; return rows[y][i]; };
    },
    squid(r) { const rx = 3.8 + r() * 1.2; return (dx, y) => (y <= 6 ? (dx / rx) ** 2 + ((y - 6) / 4) ** 2 <= 1 : y <= 9 && dx <= rx - 0.5 && (y < 8 || Math.floor(dx) % 2 === 0)); },
    bug(r) { const rx = 3 + r() * 1; return (dx, y) => ((dx / rx) ** 2 + ((y - 6.5) / 3.5) ** 2 <= 1) || ((y === 5 || y === 7 || y === 9) && dx > rx - 0.5 && dx <= rx + 1.5); },
    bear(r) { const rx = 4 + r() * 0.8; return (dx, y) => ((dx / rx) ** 2 + ((y - 6.8) / 3.8) ** 2 <= 1) || ((dx - (rx - 0.8)) ** 2 + (y - 2.8) ** 2 <= 1.6); },
    pear(r) { return (dx, y) => y >= 2 && y <= 10 && dx <= (y < 5 ? 2 + (y - 2) * 0.4 : 4.6 - Math.max(0, y - 8) * 0.8); },
  };
  const SHAPE_NAMES = Object.keys(SHAPES);

  function build(seed) {
    const r = rng(seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const [bg, body, shade, accent] = pick(PALETTES);
    const shapeName = pick(SHAPE_NAMES);
    const inShape = SHAPES[shapeName](r);

    // body mask (mirrored)
    const cell = [];
    for (let y = 0; y < G; y++) {
      cell[y] = [];
      for (let x = 0; x < G / 2; x++) {
        const dx = G / 2 - x - 0.5;
        cell[y][x] = inShape(dx, y);
      }
    }
    // a little roughness on the edges of organic shapes
    if (shapeName === 'blob' || shapeName === 'bug') {
      for (let y = 1; y < G - 1; y++) for (let x = 0; x < G / 2; x++) {
        if (cell[y][x] && (!cell[y - 1][x] || !cell[y + 1][x] || (x > 0 && !cell[y][x - 1])) && r() < 0.12) cell[y][x] = false;
      }
    }
    const on = (x, y) => y >= 0 && y < G && x >= 0 && x < G && cell[y][x < G / 2 ? x : G - 1 - x];

    // rows spanned by the body, used to place the face and hats
    let top = G, bottom = -1;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (on(x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    const faceY = Math.max(top + 1, Math.min(bottom - 3, Math.round(top + (bottom - top) * (0.35 + r() * 0.15))));

    const px = []; // [x, y, w, h, color]
    const put = (x, y, c, w = 1, h = 1) => px.push([x, y, w, h, c]);
    const mirror = (x, y, c, w = 1, h = 1) => { put(x, y, c, w, h); put(G - x - w, y, c, w, h); };

    // outline + body (+ shade on the lower rows for depth)
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      if (on(x, y)) {
        put(x, y, y >= bottom - 1 && r() < 0.7 ? shade : body);
      } else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) {
        put(x, y, 'OUT');
      }
    }

    // pattern
    const pattern = pick(['none', 'none', 'spots', 'stripes', 'belly']);
    if (pattern === 'spots') {
      for (let y = faceY + 3; y <= bottom; y++) for (let x = 0; x < G / 2; x++) if (on(x, y) && r() < 0.18) mirror(x, y, accent);
    } else if (pattern === 'stripes') {
      for (let y = faceY + 3; y <= bottom; y += 2) for (let x = 0; x < G; x++) if (on(x, y)) put(x, y, shade);
    } else if (pattern === 'belly') {
      for (let y = faceY + 3; y <= bottom - 1; y++) for (let x = 4; x < 8; x++) if (on(x, y) && on(x - 1, y) && on(x + 1, y)) put(x, y, 'BELLY');
    }

    // eyes
    const eyeStyle = pick(['dot', 'big', 'big', 'sleepy', 'visor', 'cyclops', 'three', 'shine']);
    const ex = pick([1.5, 2.5, 2.5]); // distance from center
    const lx = G / 2 - ex - 0.5, rx = G / 2 + ex - 0.5;
    const eyes = [];
    if (eyeStyle === 'dot') { eyes.push(['rect', lx + 0.2, faceY + 0.2, 0.6, 0.6, '#16131f'], ['rect', rx + 0.2, faceY + 0.2, 0.6, 0.6, '#16131f']); }
    else if (eyeStyle === 'big' || eyeStyle === 'shine') {
      for (const x of [lx, rx]) {
        eyes.push(['rect', x - 0.1, faceY - 0.1, 1.2, 1.2, '#ffffff'], ['rect', x + 0.3, faceY + 0.25, 0.6, 0.7, '#16131f']);
        if (eyeStyle === 'shine') eyes.push(['rect', x + 0.35, faceY + 0.3, 0.25, 0.25, '#ffffff']);
      }
    } else if (eyeStyle === 'sleepy') { eyes.push(['rect', lx - 0.1, faceY + 0.45, 1.2, 0.3, '#16131f'], ['rect', rx - 0.1, faceY + 0.45, 1.2, 0.3, '#16131f']); }
    else if (eyeStyle === 'visor') { eyes.push(['rect', lx - 0.3, faceY, rx - lx + 1.6, 1, '#16131f'], ['rect', lx + 0.1, faceY + 0.2, 0.9, 0.35, accent], ['rect', rx - 0.1, faceY + 0.2, 0.9, 0.35, accent]); }
    else if (eyeStyle === 'cyclops') { eyes.push(['rect', 4.9, faceY - 0.4, 2.2, 1.8, '#ffffff'], ['rect', 5.55, faceY + 0.05, 0.9, 1, '#16131f']); }
    else if (eyeStyle === 'three') { for (const x of [lx, 5.5, rx]) eyes.push(['rect', x - 0.05 + (x === 5.5 ? -0.5 : 0), faceY + (x === 5.5 ? -0.7 : 0), 1.1, 1.1, '#ffffff'], ['rect', x + 0.3 + (x === 5.5 ? -0.5 : 0), faceY + 0.25 + (x === 5.5 ? -0.7 : 0), 0.5, 0.6, '#16131f']); }

    // mouth
    const mouthStyle = pick(['smile', 'smile', 'open', 'flat', 'o', 'tongue', 'none']);
    const my = faceY + 2;
    const mouth = [];
    if (mouthStyle === 'smile') { mouth.push(['rect', 5, my + 0.3, 2, 0.4, '#16131f'], ['rect', 4.6, my - 0.1, 0.5, 0.5, '#16131f'], ['rect', 6.9, my - 0.1, 0.5, 0.5, '#16131f']); }
    else if (mouthStyle === 'open') { mouth.push(['rect', 4.8, my, 2.4, 1, '#16131f'], ['rect', 5.2, my + 0.55, 1.6, 0.45, '#ff5d73']); }
    else if (mouthStyle === 'flat') { mouth.push(['rect', 5, my + 0.3, 2, 0.35, '#16131f']); }
    else if (mouthStyle === 'o') { mouth.push(['rect', 5.55, my, 0.9, 0.9, '#16131f']); }
    else if (mouthStyle === 'tongue') { mouth.push(['rect', 5, my + 0.2, 2, 0.35, '#16131f'], ['rect', 5.9, my + 0.5, 0.7, 0.7, '#ff5d73']); }

    // cheeks
    const cheeks = r() < 0.45 && eyeStyle !== 'visor' ? [['rect', lx - 0.6, faceY + 1.3, 0.8, 0.5, '#ff7aa2'], ['rect', rx + 0.8, faceY + 1.3, 0.8, 0.5, '#ff7aa2']] : [];

    // accessories on top (never crowns, stars or halos)
    const acc = [];
    const hat = pick(['none', 'none', 'none', 'antenna', 'antennae', 'party', 'beanie', 'bow', 'sprout', 'tophat']);
    const ty = Math.max(top, 2);
    if (hat === 'antenna') { acc.push(['rect', 5.75, ty - 2, 0.5, 2, shade], ['rect', 5.4, ty - 2.8, 1.2, 1.2, accent]); }
    else if (hat === 'antennae') { acc.push(['rect', 4, ty - 2, 0.45, 2, shade], ['rect', 7.55, ty - 2, 0.45, 2, shade], ['rect', 3.6, ty - 2.8, 1.1, 1.1, accent], ['rect', 7.3, ty - 2.8, 1.1, 1.1, accent]); }
    else if (hat === 'party') { acc.push(['poly', `4.4,${ty} 7.6,${ty} 6,${ty - 3.4}`, accent], ['rect', 5.6, ty - 3.9, 0.8, 0.8, '#ffffff'], ['rect', 4.9, ty - 1, 0.6, 0.6, '#ffffff'], ['rect', 6.3, ty - 2.1, 0.5, 0.5, '#ffffff']); }
    else if (hat === 'beanie') { acc.push(['rect', 3.5, ty - 1.4, 5, 1.6, accent], ['rect', 3.3, ty - 0.2, 5.4, 0.6, shade], ['rect', 5.4, ty - 2.3, 1.2, 1, '#ffffff']); }
    else if (hat === 'bow') { acc.push(['poly', `6,${ty - 0.2} 4.3,${ty - 1.3} 4.3,${ty + 0.9}`, accent], ['poly', `6,${ty - 0.2} 7.7,${ty - 1.3} 7.7,${ty + 0.9}`, accent], ['rect', 5.6, ty - 0.6, 0.8, 0.8, shade]); }
    else if (hat === 'sprout') { acc.push(['rect', 5.8, ty - 1.8, 0.4, 1.8, '#3a7d2c'], ['poly', `6,${ty - 1.6} 4.4,${ty - 2.6} 5,${ty - 1.2}`, '#6fcf4a'], ['poly', `6,${ty - 1.8} 7.6,${ty - 2.9} 7,${ty - 1.4}`, '#6fcf4a']); }
    else if (hat === 'tophat') { acc.push(['rect', 3.6, ty - 0.5, 4.8, 0.7, '#1f1b2e'], ['rect', 4.4, ty - 3, 3.2, 2.6, '#1f1b2e'], ['rect', 4.4, ty - 1.3, 3.2, 0.5, accent]); }

    return { bg, body, shade, accent, px, eyes, mouth, cheeks, acc };
  }

  const cache = new Map();
  function pixelAvatarSVG(seed) {
    const key = String(seed || '');
    if (cache.has(key)) return cache.get(key);
    const a = build(key || 'x');
    const out = '#1f1b2e';
    const belly = mixWhite(a.body);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.2 -2.2 14.4 14.4" shape-rendering="crispEdges" aria-hidden="true"><rect x="-1.2" y="-2.2" width="14.4" height="14.4" fill="${a.bg}"/>`;
    for (const [x, y, w, h, c] of a.px) s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c === 'OUT' ? out : c === 'BELLY' ? belly : c}"/>`;
    for (const item of [...a.cheeks, ...a.eyes, ...a.mouth, ...a.acc]) {
      if (item[0] === 'rect') s += `<rect x="${item[1]}" y="${item[2]}" width="${item[3]}" height="${item[4]}" fill="${item[5]}"/>`;
      else s += `<polygon points="${item[1]}" fill="${item[2]}"/>`;
    }
    s += '</svg>';
    cache.set(key, s);
    return s;
  }
  function mixWhite(hex) {
    const n = parseInt(hex.slice(1), 16);
    const m = (c) => Math.round(c + (255 - c) * 0.55);
    return '#' + [m(n >> 16), m((n >> 8) & 255), m(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  root.pixelAvatarSVG = pixelAvatarSVG;
  if (typeof module !== 'undefined') module.exports = { pixelAvatarSVG };
})(typeof window !== 'undefined' ? window : globalThis);
