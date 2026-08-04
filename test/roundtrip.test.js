/*
 * roundtrip.test.js
 * card-format.js を Node で読み込み、
 *   file -> pages -> ピクセルバッファ描画(ファインダ含む) -> デコード
 * の往復でバイナリが完全一致するか検証する。
 * ブラウザの Canvas を使わず、自前の簡易ラスタライザで検証する。
 *
 * 1KB(96x143) / 2KB(112x167) / 3KB(130x194) / 4KB(149x222) / 5KB(170x254) 各モードを、
 * 誤り訂正(ECC) レベル 0..3 と組み合わせて検証する。
 * グリッドはページ全高を使う共通長方形の細分。
 */
'use strict';

// reed-solomon.js -> card-format.js の順に読み込む（window/globalThis に生やす）
global.window = global;
require('../js/reed-solomon.js');
require('../js/card-format.js');
const CF = global.CardFormat;

// ---- 簡易グレースケールラスタライザ ----
function renderPageGray(page) {
  const prof = CF.getProfile(page.mode);
  const W = CF.PAGE_W, H = CF.PAGE_H;
  const g = new Uint8Array(W * H).fill(255); // 白
  const fillRect = (x0,y0,w,h,val) => {
    for (let y=Math.round(y0); y<Math.round(y0+h); y++)
      for (let x=Math.round(x0); x<Math.round(x0+w); x++)
        if (x>=0&&y>=0&&x<W&&y<H) g[y*W+x]=val;
  };
  // ファインダ(全モード共通)
  const f = CF.finderCenters(); const half = CF.FINDER/2;
  [f.tl,f.tr,f.br,f.bl].forEach((c,i)=>{
    fillRect(c.x-half,c.y-half,half*2,half*2,0);
    if (i===0){ const q=half*0.55; fillRect(c.x-q,c.y-q,q*2,q*2,255);
                const q2=half*0.22; fillRect(c.x-q2,c.y-q2,q2*2,q2*2,0); }
  });
  // データ
  const bits = CF.bytesToBitGrid(page.header, page.payload, prof);
  for (let r=0;r<prof.ROWS;r++) for(let c=0;c<prof.COLS;c++){
    if (bits[r*prof.COLS+c]){
      const x = prof.GRID_X + c*prof.CELL_W;
      const y = prof.GRID_Y + r*prof.CELL_H;
      fillRect(x+0.5,y+0.5,prof.CELL_W-1,prof.CELL_H-1,0);
    }
  }
  return { g, W, H };
}

// ---- デコード: 既知の理論座標でサンプリング（幾何一致の検証） ----
function decodeGray(img, prof) {
  const { g, W } = img;
  const bits = new Uint8Array(prof.COLS*prof.ROWS);
  for (let r=0;r<prof.ROWS;r++) for(let c=0;c<prof.COLS;c++){
    const x = Math.round(prof.GRID_X + (c+0.5)*prof.CELL_W);
    const y = Math.round(prof.GRID_Y + (r+0.5)*prof.CELL_H);
    bits[r*prof.COLS+c] = g[y*W+x] < 128 ? 1 : 0;
  }
  const { header, payload } = CF.bitGridToBytes(bits, prof);
  const meta = CF.parseHeader(header);
  return { meta, payload };
}

// ---- ECC 込みのデコード: header 解釈 → payload(グロス) を RS 復号 → 正味データ ----
function decodeGrayFull(img, prof){
  const { meta, payload } = decodeGray(img, prof);
  if (!meta || !meta.checksumOk) return { meta, data: null };
  const dec = CF.decodePayload(payload, meta.eccLevel, meta.payloadLen);
  return { meta, data: dec.ok ? dec.data : null, corrected: dec.corrected };
}

// 描画時にデータセルを nFlips 個だけ反転させて「スキャン誤り」を模擬する
function renderPageGrayWithFlips(page, nFlips){
  const prof = CF.getProfile(page.mode);
  const W = CF.PAGE_W, H = CF.PAGE_H;
  const g = new Uint8Array(W * H).fill(255);
  const fillRect = (x0,y0,w,h,val) => {
    for (let y=Math.round(y0); y<Math.round(y0+h); y++)
      for (let x=Math.round(x0); x<Math.round(x0+w); x++)
        if (x>=0&&y>=0&&x<W&&y<H) g[y*W+x]=val;
  };
  const f = CF.finderCenters(); const half = CF.FINDER/2;
  [f.tl,f.tr,f.br,f.bl].forEach((c,i)=>{
    fillRect(c.x-half,c.y-half,half*2,half*2,0);
    if (i===0){ const q=half*0.55; fillRect(c.x-q,c.y-q,q*2,q*2,255);
                const q2=half*0.22; fillRect(c.x-q2,c.y-q2,q2*2,q2*2,0); }
  });
  const bits = CF.bytesToBitGrid(page.header, page.payload, prof);
  const ds = prof.HEADER_BITS;
  for (let i=0;i<nFlips;i++){ const idx = ds + ((i*4099+37) % (bits.length-ds)); bits[idx]^=1; }
  for (let r=0;r<prof.ROWS;r++) for(let c=0;c<prof.COLS;c++){
    if (bits[r*prof.COLS+c]){
      const x = prof.GRID_X + c*prof.CELL_W, y = prof.GRID_Y + r*prof.CELL_H;
      fillRect(x+0.5,y+0.5,prof.CELL_W-1,prof.CELL_H-1,0);
    }
  }
  return { g, W, H };
}

function assert(cond, msg){ if(!cond){ console.error('FAIL:', msg); process.exitCode=1; } else console.log('ok:', msg); }

// ---- テスト実行 (ECC レベル込み) ----
function runTest(name, bytes, mode, ecc){
  ecc = ecc || 0;
  const prof = CF.getProfile(mode);
  const pages = CF.splitFile(bytes, mode, ecc);
  const restored = new Uint8Array(bytes.length);
  let off = 0, allOk = true;
  for (const page of pages){
    const img = renderPageGray(page);
    const { meta, data } = decodeGrayFull(img, prof);
    if (!meta || !meta.checksumOk){ allOk = false; console.error('header decode failed', meta); break; }
    if (meta.mode !== mode){ allOk = false; console.error('mode mismatch', meta.mode, '!=', mode); break; }
    if (meta.eccLevel !== ecc){ allOk = false; console.error('ecc mismatch', meta.eccLevel, '!=', ecc); break; }
    if (!data){ allOk = false; console.error('payload RS decode failed'); break; }
    restored.set(data.subarray(0, meta.payloadLen), off);
    off += meta.payloadLen;
  }
  assert(allOk, `[${mode} ecc=${ecc}] ${name}: header+mode+ecc ok & payload decoded`);
  assert(off === bytes.length, `[${mode} ecc=${ecc}] ${name}: total length ${off} === ${bytes.length}`);
  let equal = allOk && off===bytes.length;
  for (let i=0;i<bytes.length && equal;i++) if (bytes[i]!==restored[i]) equal=false;
  assert(equal, `[${mode} ecc=${ecc}] ${name}: byte-exact roundtrip`);
}

// 汚れ耐性テスト: nFlips 個のデータセルを反転しても ECC で復元できることを検証。
function runFlipTest(name, bytes, mode, ecc, nFlips){
  const prof = CF.getProfile(mode);
  const pages = CF.splitFile(bytes, mode, ecc);
  const restored = new Uint8Array(bytes.length);
  let off = 0, allOk = true, corr = 0;
  for (const page of pages){
    const img = renderPageGrayWithFlips(page, nFlips);
    const { meta, data, corrected } = decodeGrayFull(img, prof);
    if (!meta || !meta.checksumOk || !data){ allOk = false; console.error('flip decode failed', meta); break; }
    corr += corrected || 0;
    restored.set(data.subarray(0, meta.payloadLen), off);
    off += meta.payloadLen;
  }
  let equal = allOk && off===bytes.length;
  for (let i=0;i<bytes.length && equal;i++) if (bytes[i]!==restored[i]) equal=false;
  assert(equal, `[${mode} ecc=${ecc}] ${name}: ${nFlips} flipped cells corrected (corrected=${corr}) byte-exact`);
}

for (const mode of CF.MODES) {
  const prof = CF.getProfile(mode);
  console.log(`\n=== mode ${mode} (gross ${prof.PAYLOAD_BYTES}B) ===`);
  for (const ecc of [0, 1, 2, 3]) {
    const net = CF.netPayload(mode, ecc);
    // 1) 小さいテキスト
    runTest('small-text', new TextEncoder().encode('Hello, naidesu-cardloader! (何もかも)ないです'), mode, ecc);
    // 2) 正味容量ちょうど(1枚に収まる最大)
    runTest(`exact-net-${net}`, crypto.getRandomValues(new Uint8Array(net)), mode, ecc);
    // 3) 複数ページ (2ページ+α)
    runTest('multi-pages', crypto.getRandomValues(new Uint8Array(net*2 + 300)), mode, ecc);
    // 4) 空に近い
    runTest('tiny-1byte', new Uint8Array([0xA5]), mode, ecc);
  }
  // 5) 汚れ耐性: ECC>0 なら反転セルを訂正できること (t=nsym/2 未満の範囲)
  for (const ecc of [1, 2, 3]) {
    const flips = ecc * 20; // レベルが高いほど多くの誤りを訂正できる
    runFlipTest('dirty-scan', crypto.getRandomValues(new Uint8Array(600)), mode, ecc, flips);
  }
}

// 5KB モードのグロス容量が 5120B(5KB) 以上あることを明示検証（要件: 5KB以上）
assert(CF.getProfile('5kb').PAYLOAD_BYTES >= 5120,
  `[5kb] gross ${CF.getProfile('5kb').PAYLOAD_BYTES}B >= 5120B (5KB以上)`);

console.log('\nGeometry:');
console.log('  PAGE', CF.PAGE_W, 'x', CF.PAGE_H, '@300dpi');
for (const mode of CF.MODES) {
  const p = CF.getProfile(mode);
  console.log(`  [${mode}] GRID ${p.COLS}x${p.ROWS}  cell ${p.CELL_W.toFixed(2)}x${p.CELL_H.toFixed(2)}px  ` +
    `= ${(p.CELL_W/CF.DPI*25.4).toFixed(3)}mm  gross/page = ${p.PAYLOAD_BYTES}B  ` +
    `net(L0..L3) = ${[0,1,2,3].map(e=>CF.netPayload(mode,e)).join('/')}`);
}

if (process.exitCode) console.log('\n*** SOME TESTS FAILED ***');
else console.log('\nALL TESTS PASSED');
