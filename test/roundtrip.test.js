/*
 * roundtrip.test.js
 * card-format.js を Node で読み込み、
 *   file -> pages -> ピクセルバッファ描画(ファインダ含む) -> デコード
 * の往復でバイナリが完全一致するか検証する。
 * ブラウザの Canvas を使わず、自前の簡易ラスタライザで検証する。
 *
 * 1KB(96x143) / 2KB(112x167) / 3KB(130x194) / 4KB(149x222) 各モードを検証する。
 * グリッドはページ全高を使う共通長方形の細分。
 */
'use strict';

// card-format.js を読み込む（window/globalThis に CardFormat を生やす）
global.window = global;
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

function assert(cond, msg){ if(!cond){ console.error('FAIL:', msg); process.exitCode=1; } else console.log('ok:', msg); }

// ---- テスト実行 ----
function runTest(name, bytes, mode){
  const prof = CF.getProfile(mode);
  console.log(`\n=== [${mode}] ${name} (${bytes.length} bytes) ===`);
  const pages = CF.splitFile(bytes, mode);
  const restored = new Uint8Array(bytes.length);
  let off = 0, allHeaderOk = true;
  for (const page of pages){
    const img = renderPageGray(page);
    const { meta, payload } = decodeGray(img, prof);
    if (!meta || !meta.checksumOk){ allHeaderOk = false; console.error('header decode failed', meta); break; }
    if (meta.mode !== mode){ allHeaderOk = false; console.error('mode mismatch', meta.mode, '!=', mode); break; }
    restored.set(payload.subarray(0, meta.payloadLen), off);
    off += meta.payloadLen;
  }
  assert(allHeaderOk, `[${mode}] ${name}: all headers decoded & checksum ok & mode ok`);
  assert(off === bytes.length, `[${mode}] ${name}: total length ${off} === ${bytes.length}`);
  let equal = allHeaderOk && off===bytes.length;
  for (let i=0;i<bytes.length && equal;i++) if (bytes[i]!==restored[i]) equal=false;
  assert(equal, `[${mode}] ${name}: byte-exact roundtrip`);
}

// 各モードの「公称容量」(KB単位) — このバイト数が1枚に収まることを確認する。
const NOMINAL = { '1kb': 1024, '2kb': 2048, '3kb': 3072, '4kb': 4096 };

for (const mode of CF.MODES) {
  const prof = CF.getProfile(mode);
  const nominal = NOMINAL[mode];
  // 1) 小さいテキスト
  runTest('small-text', new TextEncoder().encode('Hello, naidesu-cardloader! (何もかも)ないです'), mode);
  // 2) 公称容量ぎりぎり(1バイト手前)が1枚に収まる
  runTest(`${nominal - 1}B`, crypto.getRandomValues(new Uint8Array(nominal - 1)), mode);
  // 2b) 公称容量ちょうど(nKB)が1枚に収まることの確認
  runTest(`exact-${nominal}`, crypto.getRandomValues(new Uint8Array(nominal)), mode);
  // 3) 1ページ上限ちょうど
  runTest('exact-1page', crypto.getRandomValues(new Uint8Array(prof.PAYLOAD_BYTES)), mode);
  // 4) 複数ページ (2ページ+α)
  runTest('multi-pages', crypto.getRandomValues(new Uint8Array(prof.PAYLOAD_BYTES*2 + 500)), mode);
  // 5) 空に近い
  runTest('tiny-1byte', new Uint8Array([0xA5]), mode);
}

// 公称容量が実ペイロードに収まる(=各KBが必ず1枚)ことを明示的に検証
for (const mode of CF.MODES) {
  const prof = CF.getProfile(mode);
  assert(prof.PAYLOAD_BYTES >= NOMINAL[mode],
    `[${mode}] payload ${prof.PAYLOAD_BYTES}B >= nominal ${NOMINAL[mode]}B (1枚に収まる)`);
}

console.log('\nGeometry:');
console.log('  PAGE', CF.PAGE_W, 'x', CF.PAGE_H, '@300dpi');
for (const mode of CF.MODES) {
  const p = CF.getProfile(mode);
  console.log(`  [${mode}] GRID ${p.COLS}x${p.ROWS}  cell ${p.CELL_W.toFixed(2)}x${p.CELL_H.toFixed(2)}px  ` +
    `= ${(p.CELL_W/CF.DPI*25.4).toFixed(3)}mm  payload/page = ${p.PAYLOAD_BYTES}B`);
}

if (process.exitCode) console.log('\n*** SOME TESTS FAILED ***');
else console.log('\nALL TESTS PASSED');
