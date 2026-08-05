/*
 * autodetect.test.js
 * デコーダの自動検出ロジック(otsu + 連結成分 + finderToGrid + 射影変換 +
 * 適応サンプリング + 全モード試し読み)を Node上で検証する。
 * v6 からは decoder.html と共有する js/decode-core.js / js/geometry.js を
 * 直接使い、実コードパスをそのままテストする。
 *
 * 全モード × 誤り訂正(ECC) レベルに加え、
 *   - スキャン解像度違い(1.3x)・平行移動(余白)
 *   - 汚れ(セル反転)・バーストエラー(帯状の連続反転)
 *   - スマホ斜め撮影(射影変形=台形歪み)
 * を検証する。
 */
'use strict';
global.window = global;
require('../js/reed-solomon.js');
require('../js/card-format.js');
require('../js/geometry.js');
require('../js/decode-core.js');
const CF = global.CardFormat;
const DC = global.NaidesuDecodeCore;
const GEO = global.NaidesuGeometry;

// ---- ページを RGBA バッファに描画 ----
// opt.warp を与えると射影変形(4隅を任意にずらす=斜め撮影の模擬)を適用する。
function renderPageRGBA(page, opt = {}) {
  const prof = CF.getProfile(page.mode);
  const scale = opt.scale || 1;
  const ox = opt.ox || 0, oy = opt.oy || 0;
  const baseW = Math.round(CF.PAGE_W * scale), baseH = Math.round(CF.PAGE_H * scale);

  // まず理想ページをグレースケールで描く
  const g0 = new Uint8Array(baseW * baseH).fill(255);
  const fillRect0 = (x0, y0, w, h, val) => {
    const X0 = Math.round(x0 * scale), Y0 = Math.round(y0 * scale);
    const X1 = Math.round((x0 + w) * scale), Y1 = Math.round((y0 + h) * scale);
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++)
      if (x >= 0 && y >= 0 && x < baseW && y < baseH) g0[y * baseW + x] = val;
  };
  const f = CF.finderCenters(); const half = CF.FINDER / 2;
  [f.tl, f.tr, f.br, f.bl].forEach((c, i) => {
    fillRect0(c.x - half, c.y - half, half * 2, half * 2, 0);
    if (i === 0) { const q = half * 0.55; fillRect0(c.x - q, c.y - q, q * 2, q * 2, 255);
                   const q2 = half * 0.22; fillRect0(c.x - q2, c.y - q2, q2 * 2, q2 * 2, 0); }
  });
  const bits = CF.bytesToBitGrid(page.header, page.payload, prof);
  if (opt.flips) { const ds = CF.HEADER_LEN * 8; for (let i = 0; i < opt.flips; i++) { const idx = ds + ((i * 4099 + 37) % (bits.length - ds)); bits[idx] ^= 1; } }
  // バーストエラー: 連続する burst 個のセルを反転(帯状の折れ・かすれ模擬)
  if (opt.burst) { const ds = CF.HEADER_LEN * 8; const start = ds + 500; for (let i = 0; i < opt.burst; i++) { if (start + i < bits.length) bits[start + i] ^= 1; } }
  for (let r = 0; r < prof.ROWS; r++) for (let c = 0; c < prof.COLS; c++) {
    if (bits[r * prof.COLS + c]) fillRect0(prof.GRID_X + c * prof.CELL_W + 0.5, prof.GRID_Y + r * prof.CELL_H + 0.5, prof.CELL_W - 1, prof.CELL_H - 1, 0);
  }

  // warp なし: 平行移動だけして返す
  if (!opt.warp) {
    const W = baseW + ox * 2, H = baseH + oy * 2;
    const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255;
    for (let y = 0; y < baseH; y++) for (let x = 0; x < baseW; x++) {
      const v = g0[y * baseW + x];
      const p = ((y + oy) * W + (x + ox)) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255;
    }
    return { data: rgba, width: W, height: H };
  }

  // warp あり: 出力キャンバスへ、出力画素ごとに「逆射影」で入力画素をサンプリング。
  // dst 四隅(出力上の紙の四隅)を warp 量で内側/外側にずらして台形歪みを作る。
  const margin = opt.warpMargin || 120;
  const W = baseW + margin * 2, H = baseH + margin * 2;
  // 元ページ矩形の四隅(スケール済み) TL,TR,BR,BL
  const s = (v) => v * scale;
  const srcQuad = [ {x:0,y:0}, {x:baseW,y:0}, {x:baseW,y:baseH}, {x:0,y:baseH} ];
  // 出力上の四隅(台形)。warp=[dTLx,dTLy,dTRx,...] 相対量(px)。
  const wv = opt.warp;
  const dstQuad = [
    { x: margin + wv[0], y: margin + wv[1] },
    { x: margin + baseW + wv[2], y: margin + wv[3] },
    { x: margin + baseW + wv[4], y: margin + baseH + wv[5] },
    { x: margin + wv[6], y: margin + baseH + wv[7] },
  ];
  // dst 四隅 → 単位正方形 → src 矩形 の合成で逆写像。
  // ここでは「単位正方形 → dstQuad」の H_dst と「単位正方形 → srcQuad」の H_src を作り、
  // 出力(x,y) を H_dst で逆に解いて (u,v) を得るのは非線形なので、素直に
  // 「(u,v) を細かく走査して出力へ順方向スプラット」する(テスト用途で十分)。
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255;
  const Hdst = GEO.computeHomography(dstQuad);
  const N = Math.max(baseW, baseH) * 2; // 走査密度(十分に細かく)
  for (let iy = 0; iy <= N; iy++) {
    for (let ix = 0; ix <= N; ix++) {
      const u = ix / N, v = iy / N;
      const sx = Math.round(u * (baseW - 1)), sy = Math.round(v * (baseH - 1));
      const val = g0[sy * baseW + sx];
      const d = GEO.applyHomography(Hdst, u, v);
      const dx = Math.round(d.x), dy = Math.round(d.y);
      if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
      const p = (dy * W + dx) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = val; rgba[p + 3] = 255;
    }
  }
  return { data: rgba, width: W, height: H };
}

function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }

function run(name, bytes, mode, ecc, opt) {
  ecc = ecc || 0; opt = opt || {};
  const pages = CF.splitFile(bytes, mode, ecc);
  const restored = new Uint8Array(bytes.length); let off = 0, ok = true, corr = 0;
  for (const page of pages) {
    const img = renderPageRGBA(page, opt);
    const corners = DC.detectCorners(img, {});
    if (!corners) { ok = false; console.error('detectCorners returned null'); break; }
    const { meta, dec } = DC.decodeAnyMode(img, corners, {});
    if (!meta || !meta.checksumOk || !dec || !dec.ok) { ok = false; console.error('decode failed', meta && meta.mode, dec && dec.ok); break; }
    if (meta.mode !== mode) { ok = false; console.error('mode mismatch', meta.mode, '!=', mode); break; }
    if (meta.eccLevel !== ecc) { ok = false; console.error('ecc mismatch', meta.eccLevel, '!=', ecc); break; }
    corr += dec.corrected;
    restored.set(dec.data.subarray(0, meta.payloadLen), off); off += meta.payloadLen;
  }
  assert(ok, `[${mode} ecc=${ecc}] ${name}: autodetect+mode/ecc-detect+RS-decode ok`);
  assert(off === bytes.length, `[${mode} ecc=${ecc}] ${name}: length ${off}==${bytes.length}`);
  let eq = ok && off === bytes.length; for (let i = 0; i < bytes.length && eq; i++) if (bytes[i] !== restored[i]) eq = false;
  assert(eq, `[${mode} ecc=${ecc}] ${name}: corrected=${corr} byte-exact via AUTO-DETECT`);
}

for (const mode of CF.MODES) {
  for (const ecc of [0, 1, 2, 3]) {
    run('auto-small', new TextEncoder().encode('naidesu auto-detect test 1234567890'), mode, ecc);
    run('auto-cap', crypto.getRandomValues(new Uint8Array(CF.netPayload(mode, ecc))), mode, ecc);
    run('auto-multi', crypto.getRandomValues(new Uint8Array(CF.netPayload(mode, ecc) * 2 + 200)), mode, ecc);
    run('auto-scaled', crypto.getRandomValues(new Uint8Array(700)), mode, ecc, { scale: 1.3 });
    run('auto-offset', crypto.getRandomValues(new Uint8Array(600)), mode, ecc, { ox: 80, oy: 120 });
  }
  // 汚れ耐性: ECC>0 なら自動検出経路でも反転セルを訂正して復元できる
  for (const ecc of [1, 2, 3]) {
    run('auto-dirty', crypto.getRandomValues(new Uint8Array(500)), mode, ecc, { flips: ecc * 20 });
  }
  // バーストエラー耐性(インターリーブの効果): 連続反転をインターリーブが分散して訂正。
  for (const ecc of [2, 3]) {
    run('auto-burst', crypto.getRandomValues(new Uint8Array(600)), mode, ecc, { burst: ecc * 30 });
  }
}

// ---- 斜め撮影(射影変形)テスト: 台形に歪めても射影変換で復元できる ----
// 低〜中密度モードで、そこそこの傾き(数%)を掛ける。ECC は中(推奨)。
for (const mode of ['1kb', '2kb', '3kb', '4kb']) {
  // 四隅を非対称にずらして台形(遠近)を作る。単位: px(元ページ基準)。
  const warp = [40, 20, -30, 60, -50, -20, 20, -40];
  run('auto-skew', crypto.getRandomValues(new Uint8Array(CF.netPayload(mode, 2))), mode, 2, { warp, warpMargin: 140 });
}

if (process.exitCode) console.log('\n*** SOME TESTS FAILED ***'); else console.log('\nALL AUTO-DETECT TESTS PASSED');
