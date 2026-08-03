/*
 * naidesu-cardloader — card-format.js
 * ------------------------------------------------------------------
 * バイナリ <-> 印刷用「パンチカード」画像 の共通フォーマット定義。
 * エンコーダ(creator.html)とデコーダ(decoder.html)の両方から
 * 読み込まれ、両者が必ず同じ幾何形状・ヘッダ仕様を使うようにする。
 *
 * すべて A4 / 300dpi 前提。1bit = 1セル。
 *
 * ● 密度モード (2種) ------------------------------------------------
 *   "1kb": 96 x 96 セル   -> 1140 byte/枚 (1KB を余裕で1枚)
 *   "2kb": 136 x 136 セル -> 2295 byte/枚 (2KB=2048B を余裕で1枚)
 *
 *   グリッドは常に正方形セル。300dpi でのセル物理サイズは
 *     1kb: 約 19.4px ≈ 1.64mm
 *     2kb: 約 13.7px ≈ 1.16mm
 *   いずれも 300dpi スキャンで安定して読めるサイズを維持している。
 *
 *   デコーダはモードを事前に知らなくても、両モードのグリッドで
 *   ヘッダを試し読みし、MAGIC + チェックサムが通った方を採用する
 *   (ヘッダにもモードIDを格納して整合を確認する)。
 * ================================================================== */

(function (global) {
  'use strict';

  // ---- 物理サイズ (A4 @ 300dpi) --------------------------------
  // A4 = 210mm x 297mm = 8.2677in x 11.6929in
  const DPI = 300;
  const PAGE_W = Math.round(8.2677 * DPI); // 2480 px
  const PAGE_H = Math.round(11.6929 * DPI); // 3508 px

  // ---- レイアウト(px) ------------------------------------------
  // ページ余白と、四隅ファインダの外側にデータグリッドを置く。
  //   QUIET   : ページ端からの余白
  //   FINDER  : 四隅の位置合わせ用マーカー(正方形)のサイズ
  //   GAP     : ファインダとデータグリッドの隙間
  // これらはモード非依存(全モード共通)。ファインダ幾何を共通にすることで
  // 自動検出ロジックをモードで分岐させずに済む。
  const QUIET = 150; // px
  const FINDER = 120; // px 正方形マーカー
  const GAP = 40; // px

  const HEADER_ROWS = 1; // 先頭1行はヘッダ

  // ---- ヘッダ仕様 ----------------------------------------------
  // 12 byte:
  //   [0..1]  MAGIC  = 0x4E 0x43 ("NC" = Naidesu Card)
  //   [2]     VERSION = 2  (下位4bit=version, 上位4bit=modeId)
  //   [3]     pageIndex (0-based)
  //   [4]     totalPages
  //   [5..6]  payloadLenThisPage (big-endian, このページの有効バイト数)
  //   [7..10] totalFileLen (big-endian 32bit, ファイル全体のバイト数)
  //   [11]    checksum = XOR of bytes[0..10]
  const MAGIC0 = 0x4e;
  const MAGIC1 = 0x43;
  const VERSION = 2; // 2 でモードID埋め込みに対応 (旧=1 は 1kb 固定として後方互換読取)
  const HEADER_LEN = 12;

  // モードID (VERSIONバイトの上位4bitに格納)
  const MODE_ID = { '1kb': 0, '2kb': 1 };
  const ID_MODE = { 0: '1kb', 1: '2kb' };

  // ---- プロファイル(密度モード)生成 ---------------------------
  function makeProfile(mode, cols, rows) {
    const HEADER_BITS = HEADER_ROWS * cols;
    const DATA_BITS = (rows - HEADER_ROWS) * cols;
    const PAYLOAD_BYTES = Math.floor(DATA_BITS / 8);

    // グリッド外枠 (ファインダ中心を結ぶ矩形の内側)
    // cols==rows なので、セルを正方形にするため GRID を正方形にし、
    // ページ上方寄せ(フッタ文字用に下側へ余白)にする。
    const GRID_X = QUIET + FINDER + GAP;
    const GRID_W = PAGE_W - 2 * GRID_X;
    const GRID_H = GRID_W * (rows / cols); // 正方形セル
    const GRID_Y = QUIET + FINDER + GAP; // 上方寄せ
    const CELL_W = GRID_W / cols;
    const CELL_H = GRID_H / rows;

    return {
      mode,
      modeId: MODE_ID[mode],
      COLS: cols,
      ROWS: rows,
      HEADER_ROWS,
      HEADER_BITS,
      DATA_BITS,
      PAYLOAD_BYTES,
      GRID_X,
      GRID_Y,
      GRID_W,
      GRID_H,
      CELL_W,
      CELL_H,
    };
  }

  // 1kb: 96x96 -> payload 1140B / 2kb: 136x136 -> payload 2295B
  const PROFILES = {
    '1kb': makeProfile('1kb', 96, 96),
    '2kb': makeProfile('2kb', 136, 136),
  };
  const MODES = Object.keys(PROFILES);

  function getProfile(mode) {
    return PROFILES[mode] || PROFILES['1kb'];
  }

  // ---- ファインダ中心座標 (全モード共通・幾何はグリッド矩形依存) --
  // グリッド矩形はモードに依らず同一(GRID_X/Y/W/H は全モード同値)なので、
  // ファインダ位置も共通。TL, TR, BR, BL の順 (時計回り)。
  function finderCenters() {
    const p = PROFILES['1kb']; // GRID_* は全モード共通値
    const half = FINDER / 2;
    const tl = { x: p.GRID_X - GAP - half, y: p.GRID_Y - GAP - half };
    const tr = { x: p.GRID_X + p.GRID_W + GAP + half, y: p.GRID_Y - GAP - half };
    const br = { x: p.GRID_X + p.GRID_W + GAP + half, y: p.GRID_Y + p.GRID_H + GAP + half };
    const bl = { x: p.GRID_X - GAP - half, y: p.GRID_Y + p.GRID_H + GAP + half };
    return { tl, tr, br, bl };
  }

  function buildHeader(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode) {
    const h = new Uint8Array(HEADER_LEN);
    const modeId = MODE_ID[mode] != null ? MODE_ID[mode] : 0;
    h[0] = MAGIC0;
    h[1] = MAGIC1;
    // version(下位4bit) + modeId(上位4bit)
    h[2] = ((modeId & 0x0f) << 4) | (VERSION & 0x0f);
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
    const verByte = bytes[2];
    const version = verByte & 0x0f;
    // version>=2 は上位4bitにモードIDを持つ。version==1(旧) は 1kb 固定。
    let modeId = version >= 2 ? (verByte >> 4) & 0x0f : 0;
    const mode = ID_MODE[modeId] != null ? ID_MODE[modeId] : '1kb';
    return {
      version,
      modeId,
      mode,
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
  function bytesToBitGrid(headerBytes, payloadBytes, prof) {
    const p = prof || PROFILES['1kb'];
    const bits = new Uint8Array(p.COLS * p.ROWS);
    // header -> 先頭 HEADER_BITS
    writeBytesToBits(bits, 0, headerBytes, p.HEADER_BITS);
    // payload -> 残り
    writeBytesToBits(bits, p.HEADER_BITS, payloadBytes, p.DATA_BITS);
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
  function bitGridToBytes(bits, prof) {
    const p = prof || PROFILES['1kb'];
    const header = bitsToBytes(bits, 0, p.HEADER_BITS);
    const payload = bitsToBytes(bits, p.HEADER_BITS, p.DATA_BITS);
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
  // mode: '1kb' | '2kb'（省略時は '1kb'）
  function splitFile(fileBytes, mode) {
    const prof = getProfile(mode);
    const total = fileBytes.length;
    const totalPages = Math.max(1, Math.ceil(total / prof.PAYLOAD_BYTES));
    const pages = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * prof.PAYLOAD_BYTES;
      const end = Math.min(start + prof.PAYLOAD_BYTES, total);
      const chunk = fileBytes.slice(start, end);
      const payload = new Uint8Array(prof.PAYLOAD_BYTES); // 0埋め
      payload.set(chunk, 0);
      const header = buildHeader(p, totalPages, chunk.length, total, prof.mode);
      pages.push({ header, payload, payloadLen: chunk.length, mode: prof.mode });
    }
    return pages;
  }

  // 既定プロファイル(=1kb)のジオメトリを従来通りトップレベルにも公開し、
  // 旧コードとの後方互換を保つ。
  const DEFAULT = PROFILES['1kb'];

  global.CardFormat = {
    DPI,
    PAGE_W,
    PAGE_H,
    // --- 後方互換: 既定(1kb)のジオメトリ ---
    COLS: DEFAULT.COLS,
    ROWS: DEFAULT.ROWS,
    HEADER_ROWS,
    HEADER_BITS: DEFAULT.HEADER_BITS,
    DATA_BITS: DEFAULT.DATA_BITS,
    PAYLOAD_BYTES: DEFAULT.PAYLOAD_BYTES,
    GRID_X: DEFAULT.GRID_X,
    GRID_Y: DEFAULT.GRID_Y,
    GRID_W: DEFAULT.GRID_W,
    GRID_H: DEFAULT.GRID_H,
    CELL_W: DEFAULT.CELL_W,
    CELL_H: DEFAULT.CELL_H,
    // --- 共通 ---
    HEADER_LEN,
    VERSION,
    QUIET,
    FINDER,
    GAP,
    // --- モード ---
    MODES,
    MODE_ID,
    ID_MODE,
    PROFILES,
    getProfile,
    // --- 関数 ---
    finderCenters,
    otsuThreshold,
    buildHeader,
    parseHeader,
    bytesToBitGrid,
    bitGridToBytes,
    splitFile,
  };
})(typeof window !== 'undefined' ? window : globalThis);
