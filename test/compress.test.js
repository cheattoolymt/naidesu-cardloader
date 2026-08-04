/*
 * compress.test.js
 * ------------------------------------------------------------------
 * 圧縮コンテナ(js/compress.js)の往復一致と、圧縮を挟んだカード全往復
 *   original -> NaidesuCompress.compress -> splitFile -> 理論座標で描画/復元
 *            -> 結合 -> NaidesuCompress.autoDecompress -> original
 * が byte-exact に戻ることを検証する。
 *
 * 「破損厳禁」の要件を機械的に担保するのが目的:
 *   - 全方式で round-trip 一致
 *   - ランダムバイナリ等の非圧縮データは STORE にフォールバックし、
 *     ヘッダ(8B)以外の増加や破損がない
 *   - 圧縮ON/OFF どちらでも、カード全往復で完全一致
 *
 * Node の CompressionStream(v18+) と pako(vendor) を使う。Canvas 不要の
 * 自前ラスタライザ + 理論座標サンプリングで幾何要因を排除して検証する。
 */
'use strict';

global.window = global;
require('../js/reed-solomon.js');
require('../js/card-format.js');
const CF = global.CardFormat;
const CZ = require('../js/compress.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const enc = new TextEncoder();

// ---- 簡易グレースケールラスタライザ(理論座標) --------------------
function renderPageGray(page) {
  const prof = CF.getProfile(page.mode);
  const W = CF.PAGE_W, H = CF.PAGE_H;
  const g = new Uint8Array(W * H).fill(255);
  const fillRect = (x0, y0, w, h, val) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++)
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++)
        if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = val;
  };
  const f = CF.finderCenters(); const half = CF.FINDER / 2;
  [f.tl, f.tr, f.br, f.bl].forEach((c, i) => {
    fillRect(c.x - half, c.y - half, half * 2, half * 2, 0);
    if (i === 0) { const q = half * 0.55; fillRect(c.x - q, c.y - q, q * 2, q * 2, 255);
                   const q2 = half * 0.22; fillRect(c.x - q2, c.y - q2, q2 * 2, q2 * 2, 0); }
  });
  const bits = CF.bytesToBitGrid(page.header, page.payload, prof);
  for (let r = 0; r < prof.ROWS; r++) for (let c = 0; c < prof.COLS; c++) {
    if (bits[r * prof.COLS + c]) {
      const x = prof.GRID_X + c * prof.CELL_W;
      const y = prof.GRID_Y + r * prof.CELL_H;
      fillRect(x + 0.5, y + 0.5, prof.CELL_W - 1, prof.CELL_H - 1, 0);
    }
  }
  return { g, W, H };
}
function decodeGray(img, prof) {
  const { g, W } = img;
  const bits = new Uint8Array(prof.COLS * prof.ROWS);
  for (let r = 0; r < prof.ROWS; r++) for (let c = 0; c < prof.COLS; c++) {
    const x = Math.round(prof.GRID_X + (c + 0.5) * prof.CELL_W);
    const y = Math.round(prof.GRID_Y + (r + 0.5) * prof.CELL_H);
    bits[r * prof.COLS + c] = g[y * W + x] < 128 ? 1 : 0;
  }
  const { header, payload } = CF.bitGridToBytes(bits, prof);
  const meta = CF.parseHeader(header);
  return { meta, payload };
}

// カードに載せるバイト列(=splitFile への入力)を、各ページ描画→復元→結合で戻す
function cardRoundtrip(cardBytes, mode, ecc) {
  const pages = CF.splitFile(cardBytes, mode, ecc);
  const total = pages[0] ? CF.parseHeader(pages[0].header).totalFileLen : 0;
  const out = new Uint8Array(total);
  let off = 0;
  for (const page of pages) {
    const img = renderPageGray(page);
    const prof = CF.getProfile(page.mode);
    const { meta, payload } = decodeGray(img, prof);
    if (!meta || !meta.checksumOk) return null;
    const dec = CF.decodePayload(payload, meta.eccLevel, meta.payloadLen);
    if (!dec.ok) return null;
    out.set(dec.data.subarray(0, meta.payloadLen), off);
    off += meta.payloadLen;
  }
  return out;
}

// ---- テストデータ -------------------------------------------------
function randomBytes(n, seed) {
  // 決定的擬似乱数(再現性のため)
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = s & 0xff; }
  return out;
}

const cases = [
  { name: '空データ', bytes: new Uint8Array(0) },
  { name: '1バイト', bytes: enc.encode('a') },
  { name: '短い日本語', bytes: enc.encode('これはテストです。ありがとうございます。よろしくお願いいたします。') },
  { name: '中日本語', bytes: enc.encode('本日はお忙しい中お集まりいただきありがとうございます。それでは会議を始めます。'.repeat(3)) },
  { name: '長い日本語', bytes: enc.encode('吾輩は猫である。名前はまだ無い。どこで生れたか頓と見当がつかぬ。'.repeat(30)) },
  { name: 'JSON', bytes: enc.encode(JSON.stringify({ name: 'test', id: 42, items: [1, 2, 3], data: { a: true, b: false, c: null } })) },
  { name: 'HTML', bytes: enc.encode('<!DOCTYPE html><html><head><meta charset="utf-8"><title>テスト</title></head><body><p>これはテストページです。</p></body></html>') },
  { name: '英語長文', bytes: enc.encode('The quick brown fox jumps over the lazy dog. '.repeat(20)) },
  { name: 'ランダムバイナリ2KB', bytes: randomBytes(2000, 12345) },
  { name: 'ゼロ埋め4KB', bytes: new Uint8Array(4096) },
  { name: 'PNGっぽい先頭バイト', bytes: (() => { const b = randomBytes(500, 7); b[0]=0x89;b[1]=0x50;b[2]=0x4e;b[3]=0x47; return b; })() },
];

(async () => {
  console.log('=== compress.js 環境 ===');
  console.log('hasCompressionStream:', CZ.hasCompressionStream, '/ hasDictDeflate:', CZ.hasDictDeflate);
  ok(CZ.hasDictDeflate, 'pako(辞書deflate)が利用可能であること');

  console.log('\n=== 1) 圧縮コンテナ単体の往復 ===');
  for (const t of cases) {
    const r = await CZ.compress(t.bytes);
    const back = await CZ.autoDecompress(r.container);
    const eq = bytesEqual(back.data, t.bytes);
    ok(eq, `[${t.name}] compress→autoDecompress が完全一致`);
    // コンテナは元データ+ヘッダを超えない（STORE 保証）
    ok(r.compLen <= t.bytes.length + CZ.HEADER_LEN,
       `[${t.name}] 圧縮後がヘッダ込みで元サイズを超えない (comp=${r.compLen} orig=${t.bytes.length})`);
    console.log(`  ${t.name}: ${t.bytes.length}B → ${r.compLen}B  [${r.methodName}]`);
  }

  console.log('\n=== 2) 非コンテナ(生データ)は素通し ===');
  {
    const raw = enc.encode('plain data without container');
    const back = await CZ.autoDecompress(raw);
    ok(!back.wasCompressed && bytesEqual(back.data, raw), '生データを autoDecompress しても不変');
  }

  console.log('\n=== 3) 圧縮ON でのカード全往復 (compress→カード→復元→展開) ===');
  const MODES = ['1kb', '5kb', '8kb']; // 代表(最小/中/最高密度)
  const ECCS = [0, 2, 3];
  for (const t of cases) {
    const comp = await CZ.compress(t.bytes);
    for (const mode of MODES) {
      for (const ecc of ECCS) {
        const carded = cardRoundtrip(comp.container, mode, ecc);
        if (carded == null) { ok(false, `[${t.name}/${mode}/ecc${ecc}] カード往復でヘッダ/ECC失敗`); continue; }
        const restored = await CZ.autoDecompress(carded);
        ok(bytesEqual(restored.data, t.bytes),
           `[${t.name}/${mode}/ecc${ecc}] 圧縮ON カード全往復が byte-exact`);
      }
    }
  }

  console.log('\n=== 4) 圧縮OFF でのカード全往復 (生データを直接カード化) ===');
  for (const t of cases) {
    // 空はカード化しても0バイト。splitFile は最低1ページ作る。
    for (const mode of ['1kb']) {
      for (const ecc of [0, 2]) {
        const carded = cardRoundtrip(t.bytes, mode, ecc);
        if (carded == null) { ok(false, `[${t.name}/${mode}/ecc${ecc}] OFF カード往復失敗`); continue; }
        ok(bytesEqual(carded, t.bytes),
           `[${t.name}/${mode}/ecc${ecc}] 圧縮OFF カード往復が byte-exact`);
      }
    }
  }

  console.log(`\n=== 結果: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  console.log('compress.test.js: ALL PASS ✅');
})();
