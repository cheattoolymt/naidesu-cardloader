/*
 * jpeg-e2e.node.js
 * ------------------------------------------------------------------
 * 実 Canvas(node-canvas) でカードをフルサイズ描画 → 実 JPEG 圧縮(品質0.9)を
 * 経由 → decoder.html と同じ自動検出経路(otsu + 連結成分 + finderToGrid +
 * セルサンプリング + 両/全モード試し読み)で復元し、byte-exact を検証する。
 *
 * ブラウザの browser-e2e.html を Node 上で再現したもので、
 * 特に 3KB モード(1セル 0.98mm)が JPEG 圧縮を経ても 300dpi 相当で
 * 安定して読めることを確認するのが目的。
 *
 * 依存: npm i canvas （テスト専用・本体アプリはブラウザ Canvas を使用）
 */
'use strict';
global.window = global;
require('../js/card-format.js');
const CF = global.CardFormat;
const { createCanvas, loadImage } = require('canvas');

// ---- creator.html と同じフルサイズ描画 ----
function drawPageCanvas(page) {
  const prof = CF.getProfile(page.mode);
  const cv = createCanvas(CF.PAGE_W, CF.PAGE_H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const f = CF.finderCenters();
  const half = CF.FINDER / 2;
  const drawFinder = (center, special) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(center.x - half, center.y - half, half * 2, half * 2);
    if (special) {
      const q = half * 0.55;
      ctx.fillStyle = '#fff';
      ctx.fillRect(center.x - q, center.y - q, q * 2, q * 2);
      const q2 = half * 0.22;
      ctx.fillStyle = '#000';
      ctx.fillRect(center.x - q2, center.y - q2, q2 * 2, q2 * 2);
    }
  };
  drawFinder(f.tl, true);
  drawFinder(f.tr, false);
  drawFinder(f.br, false);
  drawFinder(f.bl, false);
  const bits = CF.bytesToBitGrid(page.header, page.payload, prof);
  ctx.fillStyle = '#000';
  for (let r = 0; r < prof.ROWS; r++)
    for (let c = 0; c < prof.COLS; c++)
      if (bits[r * prof.COLS + c])
        ctx.fillRect(prof.GRID_X + c * prof.CELL_W + 0.5, prof.GRID_Y + r * prof.CELL_H + 0.5, prof.CELL_W - 1, prof.CELL_H - 1);
  return cv;
}

// ---- decoder.html から移植した自動検出/サンプリング ----
function findFinders(bin, w, h) {
  const labels = new Int32Array(w * h); let next = 1; const comps = []; const stack = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x; if (bin[idx] !== 1 || labels[idx]) continue;
    const id = next++; let n = 0, sx = 0, sy = 0, minx = x, miny = y, maxx = x, maxy = y; stack.length = 0; stack.push(idx); labels[idx] = id;
    while (stack.length) { const p = stack.pop(); const px = p % w, py = (p / w) | 0; n++; sx += px; sy += py;
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0 && bin[p - 1] === 1 && !labels[p - 1]) { labels[p - 1] = id; stack.push(p - 1); }
      if (px < w - 1 && bin[p + 1] === 1 && !labels[p + 1]) { labels[p + 1] = id; stack.push(p + 1); }
      if (py > 0 && bin[p - w] === 1 && !labels[p - w]) { labels[p - w] = id; stack.push(p - w); }
      if (py < h - 1 && bin[p + w] === 1 && !labels[p + w]) { labels[p + w] = id; stack.push(p + w); } }
    comps.push({ n, cx: sx / n, cy: sy / n, minx, miny, maxx, maxy });
  }
  if (comps.length < 4) return null;
  const area = w * h; const cand = comps.filter(c => { const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1, ar = bw / bh, fill = c.n / (bw * bh);
    return c.n > area * 0.0006 && c.n < area * 0.05 && ar > 0.5 && ar < 2.0 && fill > 0.45; });
  const pool = cand.length >= 4 ? cand : comps;
  const refs = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]; const chosen = []; const used = new Set();
  for (const cr of refs) { let best = null, bd = Infinity, bi = -1; pool.forEach((c, i) => { if (used.has(i)) return;
    const d = (c.cx - cr.x) ** 2 + (c.cy - cr.y) ** 2; if (d < bd) { bd = d; best = c; bi = i; } }); if (!best) return null; used.add(bi); chosen.push({ x: best.cx, y: best.cy }); }
  return chosen;
}
function finderToGrid(fc) {
  const p = CF.getProfile('1kb');
  const offX = CF.GAP + CF.FINDER / 2, offY = CF.GAP + CF.FINDER / 2;
  const fW = ((fc[1].x - fc[0].x) + (fc[2].x - fc[3].x)) / 2;
  const fH = ((fc[3].y - fc[0].y) + (fc[2].y - fc[1].y)) / 2;
  const rx = fW / (p.GRID_W + 2 * offX), ry = fH / (p.GRID_H + 2 * offY);
  const dx = offX * rx, dy = offY * ry;
  return [{ x: fc[0].x + dx, y: fc[0].y + dy }, { x: fc[1].x - dx, y: fc[1].y + dy },
          { x: fc[2].x - dx, y: fc[2].y - dy }, { x: fc[3].x + dx, y: fc[3].y - dy }];
}
const lerp = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
function autoDetect(img) {
  const { data, width: w, height: h } = img;
  const scale = Math.max(1, Math.round(Math.max(w, h) / 800));
  const sw = Math.floor(w / scale), sh = Math.floor(h / scale); const gray = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const px = (y * scale * w + x * scale) * 4;
    gray[y * sw + x] = data[px] * 0.299 + data[px + 1] * 0.587 + data[px + 2] * 0.114; }
  const thr = CF.otsuThreshold(gray); const bin = new Uint8Array(sw * sh); for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= thr ? 1 : 0;
  const found = findFinders(bin, sw, sh); if (!found) return null;
  return finderToGrid(found.map(p => ({ x: p.x * scale, y: p.y * scale })));
}
function sampleGrid(img, corners, prof) {
  const { data, width: w, height: h } = img; const bits = new Uint8Array(prof.COLS * prof.ROWS);
  for (let r = 0; r < prof.ROWS; r++) for (let c = 0; c < prof.COLS; c++) {
    const T = lerp(corners[0], corners[1], (c + 0.5) / prof.COLS), B = lerp(corners[3], corners[2], (c + 0.5) / prof.COLS);
    const pt = lerp(T, B, (r + 0.5) / prof.ROWS); let acc = 0, cnt = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const xx = Math.round(pt.x + ox), yy = Math.round(pt.y + oy);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const p = (yy * w + xx) * 4;
      acc += data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114; cnt++; }
    bits[r * prof.COLS + c] = (cnt ? acc / cnt : 255) < 128 ? 1 : 0;
  }
  return bits;
}
function decodeAnyMode(img, corners) {
  let last = null;
  for (const mode of CF.MODES) {
    const prof = CF.getProfile(mode);
    const bits = sampleGrid(img, corners, prof);
    const { header, payload } = CF.bitGridToBytes(bits, prof);
    const meta = CF.parseHeader(header);
    if (!meta) continue;
    last = { meta, payload: null };
    if (!meta.checksumOk) continue;
    if (meta.mode === mode) return { meta, payload };
  }
  return last || { meta: null, payload: null };
}

function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }

async function pageToImageData(cv, viaJpeg) {
  if (!viaJpeg) {
    return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  }
  // 実 JPEG エンコード(品質0.9) → デコードして RGBA を取り出す
  const buf = cv.toBuffer('image/jpeg', { quality: 0.9 });
  const im = await loadImage(buf);
  const cv2 = createCanvas(im.width, im.height);
  const ctx2 = cv2.getContext('2d');
  ctx2.drawImage(im, 0, 0);
  return ctx2.getImageData(0, 0, cv2.width, cv2.height);
}

async function runCase(name, bytes, mode, viaJpeg) {
  console.log(`\n=== [${mode}] ${name} (${bytes.length}B, jpeg=${!!viaJpeg}) ===`);
  const pages = CF.splitFile(bytes, mode);
  const restored = new Uint8Array(bytes.length); let off = 0, ok = true;
  for (const page of pages) {
    let cv = drawPageCanvas(page);
    let img = await pageToImageData(cv, viaJpeg);
    cv = null; // フルサイズ Canvas を早めに解放(メモリ節約)
    const corners = autoDetect(img);
    if (!corners) { ok = false; console.error('autoDetect null'); break; }
    const { meta, payload } = decodeAnyMode(img, corners);
    img = null;
    if (!meta || !meta.checksumOk || !payload) { ok = false; console.error('decode failed', meta); break; }
    if (meta.mode !== mode) { ok = false; console.error('mode mismatch', meta.mode, '!=', mode); break; }
    restored.set(payload.subarray(0, meta.payloadLen), off); off += meta.payloadLen;
    if (global.gc) global.gc();
  }
  assert(ok, `[${mode}] ${name}: autodetect+mode-detect+decode ok`);
  assert(off === bytes.length, `[${mode}] ${name}: length ${off}==${bytes.length}`);
  let eq = ok && off === bytes.length; for (let i = 0; i < bytes.length && eq; i++) if (bytes[i] !== restored[i]) eq = false;
  assert(eq, `[${mode}] ${name}: byte-exact via REAL-JPEG(0.9) + AUTO-DETECT`);
}

const crypto = require('crypto');
const rand = (n) => new Uint8Array(crypto.randomBytes(n));

(async () => {
  // 全モードを実 JPEG(0.9) 経由で検証。特に 3KB の高密度セル(0.98mm)が
  // JPEG 圧縮を経ても 300dpi 相当で安定して読めることを重点確認する。
  //
  // ※ セルサイズの読み取り安定性は「1ページ内の話」なので、ここでは
  //   1ページで完結するケースのみを実 JPEG で検証する。複数ページ分割
  //   (4KB→3kb で 2 枚 など)の結合ロジックは roundtrip / autodetect
  //   テストで byte-exact を確認済み。
  //   (フルサイズ Canvas を複数枚 JPEG デコードするとメモリを大量消費
  //    するため、E2E は 1 ページ描画に限定している。)
  await runCase('1KB-random', rand(1024), '1kb', true);
  await runCase('2KB-random', rand(2048), '2kb', true);
  await runCase('3KB-text', new TextEncoder().encode('naidesu 3KB mode E2E ✓ 日本語 0123456789'), '3kb', true);
  await runCase('3KB-random', rand(3072), '3kb', true); // 3KB(3072B) をぴったり
  await runCase('3KB-cap', rand(CF.getProfile('3kb').PAYLOAD_BYTES), '3kb', true); // 1ページ上限(全セル最密)

  if (process.exitCode) console.log('\n*** SOME JPEG-E2E TESTS FAILED ***');
  else console.log('\nALL JPEG-E2E TESTS PASSED (1-page real-JPEG cases)');
})();
