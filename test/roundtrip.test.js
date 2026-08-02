/*
 * roundtrip.test.js
 * card-format.js を Node で読み込み、
 *   file -> pages -> ピクセルバッファ描画(ファインダ含む) -> デコード
 * の往復でバイナリが完全一致するか検証する。
 * ブラウザの Canvas を使わず、自前の簡易ラスタライザで検証する。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// card-format.js を読み込む（window/globalThis に CardFormat を生やす）
global.window = global;
require('../js/card-format.js');
const CF = global.CardFormat;

// ---- 簡易グレースケールラスタライザ ----
function renderPageGray(page) {
  const W = CF.PAGE_W, H = CF.PAGE_H;
  const g = new Uint8Array(W * H).fill(255); // 白
  const set = (x, y) => { if (x>=0&&y>=0&&x<W&&y<H) g[y*W+x] = 0; };
  const fillRect = (x0,y0,w,h,val) => {
    for (let y=Math.round(y0); y<Math.round(y0+h); y++)
      for (let x=Math.round(x0); x<Math.round(x0+w); x++)
        if (x>=0&&y>=0&&x<W&&y<H) g[y*W+x]=val;
  };
  // ファインダ
  const f = CF.finderCenters(); const half = CF.FINDER/2;
  [f.tl,f.tr,f.br,f.bl].forEach((c,i)=>{
    fillRect(c.x-half,c.y-half,half*2,half*2,0);
    if (i===0){ const q=half*0.55; fillRect(c.x-q,c.y-q,q*2,q*2,255);
                const q2=half*0.22; fillRect(c.x-q2,c.y-q2,q2*2,q2*2,0); }
  });
  // データ
  const bits = CF.bytesToBitGrid(page.header, page.payload);
  for (let r=0;r<CF.ROWS;r++) for(let c=0;c<CF.COLS;c++){
    if (bits[r*CF.COLS+c]){
      const x = CF.GRID_X + c*CF.CELL_W;
      const y = CF.GRID_Y + r*CF.CELL_H;
      fillRect(x+0.5,y+0.5,CF.CELL_W-1,CF.CELL_H-1,0);
    }
  }
  return { g, W, H };
}

// ---- デコード: 既知の理論座標でサンプリング（幾何一致の検証） ----
function decodeGray(img) {
  const { g, W } = img;
  const bits = new Uint8Array(CF.COLS*CF.ROWS);
  for (let r=0;r<CF.ROWS;r++) for(let c=0;c<CF.COLS;c++){
    const x = Math.round(CF.GRID_X + (c+0.5)*CF.CELL_W);
    const y = Math.round(CF.GRID_Y + (r+0.5)*CF.CELL_H);
    bits[r*CF.COLS+c] = g[y*W+x] < 128 ? 1 : 0;
  }
  const { header, payload } = CF.bitGridToBytes(bits);
  const meta = CF.parseHeader(header);
  return { meta, payload };
}

function assert(cond, msg){ if(!cond){ console.error('FAIL:', msg); process.exitCode=1; } else console.log('ok:', msg); }

// ---- テスト実行 ----
function runTest(name, bytes){
  console.log(`\n=== ${name} (${bytes.length} bytes) ===`);
  const pages = CF.splitFile(bytes);
  const restored = new Uint8Array(bytes.length);
  let off = 0, allHeaderOk = true;
  for (const page of pages){
    const img = renderPageGray(page);
    const { meta, payload } = decodeGray(img);
    if (!meta || !meta.checksumOk){ allHeaderOk = false; console.error('header decode failed', meta); break; }
    restored.set(payload.subarray(0, meta.payloadLen), off);
    off += meta.payloadLen;
  }
  assert(allHeaderOk, `${name}: all headers decoded & checksum ok`);
  assert(off === bytes.length, `${name}: total length ${off} === ${bytes.length}`);
  let equal = allHeaderOk && off===bytes.length;
  for (let i=0;i<bytes.length && equal;i++) if (bytes[i]!==restored[i]) equal=false;
  assert(equal, `${name}: byte-exact roundtrip`);
}

// 1) 小さいテキスト
runTest('small-text', new TextEncoder().encode('Hello, naidesu-cardloader! (何もかも)ないです'));
// 2) 1KB ぴったり近辺
runTest('1023B', crypto.getRandomValues(new Uint8Array(1023)));
// 3) 1ページ上限ちょうど
runTest('exact-1page', crypto.getRandomValues(new Uint8Array(CF.PAYLOAD_BYTES)));
// 4) 複数ページ (3ページ分)
runTest('multi-3pages', crypto.getRandomValues(new Uint8Array(CF.PAYLOAD_BYTES*2 + 500)));
// 5) 空に近い
runTest('tiny-1byte', new Uint8Array([0xA5]));

console.log('\nGeometry:');
console.log('  PAGE', CF.PAGE_W, 'x', CF.PAGE_H, '@300dpi');
console.log('  GRID', CF.COLS,'x',CF.ROWS, 'cell', CF.CELL_W.toFixed(2),'x',CF.CELL_H.toFixed(2),'px');
console.log('  cell size mm =', (CF.CELL_W/CF.DPI*25.4).toFixed(2), 'mm');
console.log('  payload/page =', CF.PAYLOAD_BYTES, 'bytes');

if (process.exitCode) console.log('\n*** SOME TESTS FAILED ***');
else console.log('\nALL TESTS PASSED');
