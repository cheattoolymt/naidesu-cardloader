/*
 * naidesu-cardloader — card-format.js
 * ------------------------------------------------------------------
 * バイナリ <-> 印刷用「パンチカード」画像 の共通フォーマット定義。
 * エンコーダ(creator.html)とデコーダ(decoder.html)の両方から
 * 読み込まれ、両者が必ず同じ幾何形状・ヘッダ仕様を使うようにする。
 *
 * すべて A4 / 300dpi 前提。1bit = 1セル。
 * ================================================================== */

(function (global) {
  'use strict';

  // ---- 物理サイズ (A4 @ 300dpi) --------------------------------
  // A4 = 210mm x 297mm = 8.2677in x 11.6929in
  const DPI = 300;
  const PAGE_W = Math.round(8.2677 * DPI); // 2480 px
  const PAGE_H = Math.round(11.6929 * DPI); // 3508 px

  // ---- データグリッド ------------------------------------------
  // 96 x 96 セル。各セル = 1bit。
  //   1行目(96bit = 12byte) をヘッダに使用。
  //   残り 95 x 96 = 9120bit = 1140byte をペイロードに使用。
  //   -> 1ページで 1KB(1024byte) を余裕をもって格納できる。
  const COLS = 96;
  const ROWS = 96;

  const HEADER_ROWS = 1; // 先頭1行はヘッダ
  const HEADER_BITS = HEADER_ROWS * COLS; // 96 bit = 12 byte
  const DATA_BITS = (ROWS - HEADER_ROWS) * COLS; // 9120 bit
  const PAYLOAD_BYTES = Math.floor(DATA_BITS / 8); // 1140 byte / page

  // ---- レイアウト(px) ------------------------------------------
  // ページ余白と、四隅ファインダの外側にデータグリッドを置く。
  //   QUIET   : ページ端からの余白
  //   FINDER  : 四隅の位置合わせ用マーカー(正方形)のサイズ
  //   GAP     : ファインダとデータグリッドの隙間
  const QUIET = 150; // px
  const FINDER = 120; // px 正方形マーカー
  const GAP = 40; // px

  // グリッド外枠 (ファインダ中心を結ぶ矩形の内側)
  // ファインダはグリッド矩形の四隅の "外側" に配置する。
  // COLS==ROWS なので、セルを正方形にするため GRID を正方形にし、
  // ページ上方寄せ(フッタ文字用に下側へ余白)にする。
  const GRID_X = QUIET + FINDER + GAP;
  const GRID_W = PAGE_W - 2 * GRID_X;
  const GRID_H = GRID_W * (ROWS / COLS); // 正方形セル
  const GRID_Y = QUIET + FINDER + GAP;   // 上方寄せ

  const CELL_W = GRID_W / COLS;
  const CELL_H = GRID_H / ROWS;

  // ファインダマーカー中心座標 (グリッド四隅の外側)
  // TL, TR, BR, BL の順 (時計回り)
  function finderCenters() {
    const half = FINDER / 2;
    const tl = { x: GRID_X - GAP - half, y: GRID_Y - GAP - half };
    const tr = { x: GRID_X + GRID_W + GAP + half, y: GRID_Y - GAP - half };
    const br = { x: GRID_X + GRID_W + GAP + half, y: GRID_Y + GRID_H + GAP + half };
    const bl = { x: GRID_X - GAP - half, y: GRID_Y + GRID_H + GAP + half };
    return { tl, tr, br, bl };
  }

  // ---- ヘッダ仕様 ----------------------------------------------
  // 12 byte:
  //   [0..1]  MAGIC  = 0x4E 0x43 ("NC" = Naidesu Card)
  //   [2]     VERSION = 1
  //   [3]     pageIndex (0-based)
  //   [4]     totalPages
  //   [5..6]  payloadLenThisPage (big-endian, このページの有効バイト数)
  //   [7..10] totalFileLen (big-endian 32bit, ファイル全体のバイト数)
  //   [11]    checksum = XOR of bytes[0..10]
  const MAGIC0 = 0x4e;
  const MAGIC1 = 0x43;
  const VERSION = 1;
  const HEADER_LEN = 12;

  function buildHeader(pageIndex, totalPages, payloadLenThisPage, totalFileLen) {
    const h = new Uint8Array(HEADER_LEN);
    h[0] = MAGIC0;
    h[1] = MAGIC1;
    h[2] = VERSION;
    h[3] = pageIndex & 0xff;
    h[4] = totalPages & 0xff;
    h[5] = (payloadLenThisPage >> 8) & 0xff;
    h[6] = payloadLenThisPage & 0xff;
    h[7] = (totalFileLen >>> 24) & 0xff;
    h[8] = (totalFileLen >>> 16) & 0xff;
    h[9] = (totalFileLen >>> 8) & 0xff;
    h[10] = totalFileLen & 0xff;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= h[i];
    h[11] = x;
    return h;
  }

  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_LEN) return null;
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= bytes[i];
    const ok = x === bytes[11];
    return {
      version: bytes[2],
      pageIndex: bytes[3],
      totalPages: bytes[4],
      payloadLen: (bytes[5] << 8) | bytes[6],
      totalFileLen:
        (bytes[7] * 0x1000000) + (bytes[8] << 16) + (bytes[9] << 8) + bytes[10],
      checksumOk: ok,
    };
  }

  // ---- bit <-> byte ヘルパ -------------------------------------
  // グリッドは行優先(row-major)、MSB first でビットを並べる。
  // 返す配列: 長さ COLS*ROWS の 0/1 配列。
  function bytesToBitGrid(headerBytes, payloadBytes) {
    const bits = new Uint8Array(COLS * ROWS);
    // header -> 先頭 HEADER_BITS
    writeBytesToBits(bits, 0, headerBytes, HEADER_BITS);
    // payload -> 残り
    writeBytesToBits(bits, HEADER_BITS, payloadBytes, DATA_BITS);
    return bits;
  }

  function writeBytesToBits(bits, bitOffset, bytes, maxBits) {
    let bi = bitOffset;
    const limit = bitOffset + maxBits;
    for (let i = 0; i < bytes.length && bi < limit; i++) {
      const b = bytes[i];
      for (let k = 7; k >= 0 && bi < limit; k--) {
        bits[bi++] = (b >> k) & 1;
      }
    }
  }

  // 0/1 grid (長さ COLS*ROWS) -> {header: Uint8Array(12), payload: Uint8Array}
  function bitGridToBytes(bits) {
    const header = bitsToBytes(bits, 0, HEADER_BITS);
    const payload = bitsToBytes(bits, HEADER_BITS, DATA_BITS);
    return { header, payload };
  }

  function bitsToBytes(bits, bitOffset, numBits) {
    const numBytes = Math.floor(numBits / 8);
    const out = new Uint8Array(numBytes);
    let bi = bitOffset;
    for (let i = 0; i < numBytes; i++) {
      let b = 0;
      for (let k = 0; k < 8; k++) {
        b = (b << 1) | (bits[bi++] & 1);
      }
      out[i] = b;
    }
    return out;
  }

  // ---- 二値化しきい値 (大津法 + 縮退対策) --------------------
  // gray: Uint8Array。返り値 thr で「gray[i] <= thr なら黒(1)」と判定する。
  // 2値だけの綺麗なスキャンでも、写真のような連続階調でも安定するように、
  // 大津法で求めた値が端(0付近/255付近)に張り付いた場合はフォールバックする。
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
    const total = gray.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, thr = 127;
    let mBstar = 0, mFstar = 255;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; thr = t; mBstar = mB; mFstar = mF; }
    }
    // 大津の thr は「クラス境界(背景=前景の分かれ目)」。
    // 黒(前景)と白(背景)の平均の中点を採用するとロバスト。
    let mid = Math.round((mBstar + mFstar) / 2);
    if (!isFinite(mid)) mid = 128;
    // それでも端に寄ったら安全な中央値へ
    if (mid < 5) mid = 128;
    if (mid > 250) mid = 128;
    return mid;
  }

  // ファイル全体を複数ページ分の {header, payload} に分割
  function splitFile(fileBytes) {
    const total = fileBytes.length;
    const totalPages = Math.max(1, Math.ceil(total / PAYLOAD_BYTES));
    const pages = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * PAYLOAD_BYTES;
      const end = Math.min(start + PAYLOAD_BYTES, total);
      const chunk = fileBytes.slice(start, end);
      const payload = new Uint8Array(PAYLOAD_BYTES); // 0埋め
      payload.set(chunk, 0);
      const header = buildHeader(p, totalPages, chunk.length, total);
      pages.push({ header, payload, payloadLen: chunk.length });
    }
    return pages;
  }

  global.CardFormat = {
    DPI,
    PAGE_W,
    PAGE_H,
    COLS,
    ROWS,
    HEADER_ROWS,
    HEADER_BITS,
    DATA_BITS,
    PAYLOAD_BYTES,
    HEADER_LEN,
    QUIET,
    FINDER,
    GAP,
    GRID_X,
    GRID_Y,
    GRID_W,
    GRID_H,
    CELL_W,
    CELL_H,
    finderCenters,
    otsuThreshold,
    buildHeader,
    parseHeader,
    bytesToBitGrid,
    bitGridToBytes,
    splitFile,
  };
})(typeof window !== 'undefined' ? window : globalThis);
