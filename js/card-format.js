/*
 * naidesu-cardloader — card-format.js
 * ------------------------------------------------------------------
 * バイナリ <-> 印刷用「パンチカード」画像 の共通フォーマット定義。
 * エンコーダ(creator.html)とデコーダ(decoder.html)の両方から
 * 読み込まれ、両者が必ず同じ幾何形状・ヘッダ仕様を使うようにする。
 *
 * すべて A4 / 300dpi 前提。1bit = 1セル。
 *
 * ● ページ全面を使う設計 --------------------------------------------
 *   四隅ファインダの内側いっぱい(ページ全高からフッタ分だけを除いた領域)を
 *   データ領域として使う。グリッド矩形 GRID_W x GRID_H は全モード共通の
 *   「1つの長方形」で固定し、各モードはその同じ長方形を cols x rows に細分するだけ。
 *   これによりファインダ位置も全モード共通のまま、容量を大幅に拡張できる。
 *
 * ● 余白を削って“紙を使い切る”設計 (v6) ------------------------------
 *   v5 は端余白 QUIET=60px(5.08mm)・FINDER=100px でデータグリッドは A4 の 74.2% だった。
 *   家庭用プリンタの実際の印刷可能領域(概ね上下左右 5mm 前後)にはまだ余裕が
 *   あるので、端余白を QUIET=50px(4.23mm)・ファインダを FINDER=90px までさらに詰め、
 *   データグリッドを 2152 x 3096 px (= A4 の 76.6%) まで拡大した。
 *   **セルを縮めずに**、同じセル物理サイズでも容量だけを増やす無駄の除去である。
 *   さらに 1セル 0.75mm(0.7〜1mm の範囲内)の「10kb モード」を追加し、
 *   1 枚 10527 byte(≈10.3KB) を達成した(目標: 一マス 0.7〜1mm を外れず 10KB 以上)。
 *
 * ● モード名を実容量に合わせて是正 (v6) -----------------------------
 *   旧版は「7kb モードと言いつつ実際は 8082B(≈8KB)」「8kb と言いつつ 9209B(≈9KB)」と
 *   表示と実容量がズレていた。v6 ではモード名(=キー)を実グロス容量の KB に合わせ、
 *   1kb/2kb/3kb/4kb/5kb/7kb/8kb/10kb の 8モードとした(6kb/9kb は廃し、実容量に近い KB 名へ)。
 *
 * ● インターリーブ(バーストエラー耐性) -----------------------------
 *   スキャンの折れ・かすれ・帯状ノイズは「連続した領域のセル」をまとめて壊す
 *   (=バーストエラー)。RS は 1 ブロック内に誤りが集中すると訂正能力を超えるため、
 *   QR コードと同じく **複数 RS ブロックの符号語をバイト単位で交互配置(インターリーブ)** し、
 *   バースト誤りを複数ブロックへ分散させて各ブロックの誤り数を減らす。
 *
 * ● 密度モード ------------------------------------------------------
 *   セルは「300dpi でも余裕で読める」よう十分な大きさを確保する。5kb は
 *   1mm 以上を維持し、10kb でも 0.75mm(0.7〜1mm の下限側)に留める。
 *   "1kb" : 100 x 144 ->  1800 byte/枚 (cell ≈ 1.82mm)
 *   "2kb" : 118 x 170 ->  2507 byte/枚 (cell ≈ 1.54mm)
 *   "3kb" : 137 x 197 ->  3373 byte/枚 (cell ≈ 1.33mm)
 *   "4kb" : 157 x 226 ->  4435 byte/枚 (cell ≈ 1.16mm)
 *   "5kb" : 178 x 256 ->  5696 byte/枚 (cell ≈ 1.02mm) ← 1mm以上を維持
 *   "7kb" : 196 x 282 ->  6909 byte/枚 (cell ≈ 0.93mm)
 *   "8kb" : 212 x 305 ->  8082 byte/枚 (cell ≈ 0.86mm)
 *   "10kb": 242 x 348 -> 10527 byte/枚 (cell ≈ 0.75mm) ← 10KB超・0.7〜1mm の範囲内
 *
 * ● 誤り訂正 (ECC) — 段階選択 --------------------------------------
 *   リードソロモン符号(js/reed-solomon.js)を被せ、汚れ耐性と正味容量の
 *   トレードオフを 4 段階で選べる:
 *     ecc=0 "none": パリティ 0%     (訂正なし・最大容量)
 *     ecc=1 "low" : パリティ 約10%
 *     ecc=2 "med" : パリティ 約20% (推奨)
 *     ecc=3 "high": パリティ 約30%
 *
 *   グロス容量を最大 255byte の RS ブロックに分割し、各ブロックに nsym バイトの
 *   パリティを付ける。**端数ブロックの切り捨てを減らす**ため、ブロック数を先に決め、
 *   グロス容量をブロック間でできるだけ均等に割り振る(残余のバイトを捨てない)。
 *
 *   ヘッダにモードID+ECCレベルを格納し、ヘッダ自身も専用 RS(nsym=6)で保護する。
 *   デコーダはモード/ECC を事前に知らなくても、全モードのグリッドでヘッダ行を
 *   試し読みして復元・整合確認し、確定したモード/ECC で本文を RS デコードする。
 * ================================================================== */

(function (global) {
  'use strict';

  // ---- リードソロモン依存 (ブラウザ: window.ReedSolomon / Node: require) --
  let RS = global.ReedSolomon;
  if (!RS && typeof require !== 'undefined') {
    try { RS = require('./reed-solomon.js'); } catch (e) { /* optional */ }
    if (!RS) RS = global.ReedSolomon;
  }

  // ---- 物理サイズ (A4 @ 300dpi) --------------------------------
  const DPI = 300;
  const PAGE_W = Math.round(8.2677 * DPI); // 2480 px
  const PAGE_H = Math.round(11.6929 * DPI); // 3508 px

  // ---- レイアウト(px) ------------------------------------------
  // v6: 端余白/ファインダをさらに切り詰めて A4 を“もっと”使い切る。
  //   QUIET  50px = 4.23mm … 家庭用プリンタの印刷可能領域(概ね上下左右5mm前後)に収まる安全余白
  //   FINDER 90px = 7.6mm … 位置検出に必要な四隅マーカー(縮めても検出は安定)
  //   GAP    24px = 2.0mm … ファインダとデータグリッドの隙間
  //   FOOTER 84px = 7.1mm … 箱の直下に描く人間可読フッタ用
  // これでデータグリッドは 2112x3056(74.2%) → 2152x3096(76.6%) に拡大。
  const QUIET = 50; // px
  const FINDER = 90; // px 正方形マーカー
  const GAP = 24; // px
  const FOOTER = 84; // px 下端(=箱の直下)の人間可読テキスト用

  // ---- 全モード共通のデータグリッド矩形(px) ------------------
  const GRID_X = QUIET + FINDER + GAP; // 164
  const GRID_Y = QUIET + FINDER + GAP; // 164 (上端)
  const GRID_W = PAGE_W - 2 * GRID_X;  // 2152
  const GRID_H = PAGE_H - GRID_Y - GRID_X - FOOTER; // 3096

  // ---- ヘッダ仕様 ----------------------------------------------
  // 論理ヘッダ = 12 byte:
  //   [0..1]  MAGIC  = 0x4E 0x43 ("NC" = Naidesu Card)
  //   [2]     verModeEcc: 下位3bit=version, 次4bit=modeId(0..15), 上位?=... (下記参照)
  //   [3]     pageIndex (0-based)
  //   [4]     totalPages
  //   [5..6]  payloadLenThisPage (big-endian)
  //   [7..10] totalFileLen (big-endian 32bit)
  //   [11]    checksum = XOR of bytes[0..10]
  //
  // verModeEcc(=[2]) のビット割り当て(VERSION>=4):
  //   bit0..2 : version (=4)
  //   bit3..6 : modeId (0..15 の 16モードまで格納可)
  //   bit7    : eccLevel の下位1bit
  // eccLevel の上位1bit は [4](totalPages) ではなく、余りビットを使わず
  // 論理ヘッダを 12byte に保つため、[2] だけでは 2bit 分の ECC を格納しきれない。
  // → ECCレベルは 0..3 の 2bit 必要なので、bit7 と、pageIndex/totalPages を圧迫せずに
  //   もう1bit を確保するため VERSION>=4 では [2] の bit7 = ecc bit0、
  //   そして version 用 3bit のうち VERSION=4 は 0b100 なので bit2 が立つ。
  // ややこしさを避けるため、実装では次の単純な割当を採用する:
  //   [2] = (VERSION & 0x07) | ((modeId & 0x0F) << 3) | ((ecc & 0x01) << 7)
  //   [11] のチェックサム後の未使用は無いが、ecc の bit1 は「ヘッダ行の余りビット」で
  //   運ばず、pageIndex は 0..255 で 8bit フルに使うため、ecc bit1 は [2] に入れられない。
  // → シンプルに: ecc(2bit) は modeId を 4bit に拡張したうえで [2] の bit7 に ecc&1、
  //   ecc の bit1 は VERSION を 3bit のまま bit2 と衝突しないよう、[4] totalPages は
  //   1..255 しか使わないので最上位ビットに載せられるが可読性が下がる。
  // 実装は interpretLogical/buildHeaderLogical を正とする(下記参照)。
  const MAGIC0 = 0x4e;
  const MAGIC1 = 0x43;
  const VERSION = 4; // 4: modeId(16種)+ecc(2bit)。旧(1,2,3)は後方互換読取。
  const HEADER_DATA_LEN = 12;      // 論理ヘッダのバイト数
  const HEADER_NSYM = 6;           // ヘッダ保護 RS のパリティ(最大3byte誤り訂正)
  const HEADER_LEN = HEADER_DATA_LEN + HEADER_NSYM; // 18

  // モードID (0..7 の 3bit)。実グロス容量の KB に合わせた命名(v6で是正)。
  // 8モードに収め、modeId を 3bit で表現する(ヘッダ h[2] の bit3..5)。
  const MODE_ID = { '1kb': 0, '2kb': 1, '3kb': 2, '4kb': 3, '5kb': 4, '7kb': 5, '8kb': 6, '10kb': 7 };
  const ID_MODE = { 0: '1kb', 1: '2kb', 2: '3kb', 3: '4kb', 4: '5kb', 5: '7kb', 6: '8kb', 7: '10kb' };

  // ---- ECC (誤り訂正) レベル -----------------------------------
  const BLOCK_N = 255; // RS ブロック長(GF(256) 上限)
  const ECC_LEVELS = {
    0: { key: 'none', label: 'なし',   ratio: 0.00 },
    1: { key: 'low',  label: '低(約10%)', ratio: 0.10 },
    2: { key: 'med',  label: '中(約20%)', ratio: 0.20 },
    3: { key: 'high', label: '高(約30%)', ratio: 0.30 },
  };
  // 1ブロックあたりのパリティ数(偶数)。ecc=0 は 0。
  function eccNsym(eccLevel) {
    const lv = ECC_LEVELS[eccLevel] || ECC_LEVELS[0];
    if (lv.ratio <= 0) return 0;
    let n = Math.round(BLOCK_N * lv.ratio);
    if (n % 2) n++;
    return n;
  }

  // ---- プロファイル(密度モード)生成 ---------------------------
  function makeProfile(mode, cols, rows) {
    // 保護済みヘッダ(HEADER_LEN byte = HEADER_LEN*8 bit)が収まる最小行数
    const headerRows = Math.max(1, Math.ceil((HEADER_LEN * 8) / cols));
    const HEADER_BITS = headerRows * cols;
    const DATA_BITS = (rows - headerRows) * cols;
    // ヘッダ行の“余りビット”(HEADER_LEN*8 を超えるヘッダ領域のビット)は
    // これまで捨てていたが、v6 では payload に回してデータに使う。
    const HEADER_PAD_BITS = HEADER_BITS - (HEADER_LEN * 8);
    const PAYLOAD_BYTES = Math.floor((DATA_BITS + HEADER_PAD_BITS) / 8);

    const CELL_W = GRID_W / cols;
    const CELL_H = GRID_H / rows;

    return {
      mode,
      modeId: MODE_ID[mode],
      COLS: cols,
      ROWS: rows,
      HEADER_ROWS: headerRows,
      HEADER_BITS,
      HEADER_PAD_BITS,
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

  // 共通長方形(2152 x 3096)を細分する cols x rows。
  const PROFILES = {
    '1kb': makeProfile('1kb', 100, 144),
    '2kb': makeProfile('2kb', 118, 170),
    '3kb': makeProfile('3kb', 137, 197),
    '4kb': makeProfile('4kb', 157, 226),
    '5kb': makeProfile('5kb', 178, 256),
    '7kb': makeProfile('7kb', 196, 282),
    '8kb': makeProfile('8kb', 212, 305),
    '10kb': makeProfile('10kb', 242, 348),
  };
  const MODES = Object.keys(PROFILES);

  function getProfile(mode) {
    return PROFILES[mode] || PROFILES['1kb'];
  }

  // ---- RS ブロック割り (グロス G byte を RS ブロックへ分割) --------
  // v6: 端数ブロックの切り捨てを減らすため、まずブロック数 nblocks を決め、
  //     グロス容量を nblocks 個へできるだけ均等に割り振る(全バイトをデータ/パリティに使い、
  //     余りを捨てない)。QR コードのブロック分割と同じ考え方。
  //   ecc=0: [{dataLen:G, nsym:0}]
  //   ecc>0: 各ブロック符号語長は floor(G/nblocks) か +1。パリティは全ブロック共通 nsym。
  function blockPlan(grossBytes, eccLevel) {
    const nsym = eccNsym(eccLevel);
    if (nsym === 0) return [{ dataLen: grossBytes, nsym: 0 }];
    // 必要ブロック数: 各ブロックは最大 255byte。dataLen>0 を保つため、
    // 1 ブロックの符号語長は最低 nsym+1。
    const nblocks = Math.max(1, Math.ceil(grossBytes / BLOCK_N));
    const plan = [];
    const base = Math.floor(grossBytes / nblocks);
    let extra = grossBytes - base * nblocks; // 先頭 extra 個のブロックが +1 byte
    for (let i = 0; i < nblocks; i++) {
      const cwLen = base + (i < extra ? 1 : 0);
      const dLen = cwLen - nsym;
      // dLen<=0 になるほど細分されることは通常ないが、安全側にクランプ。
      plan.push({ dataLen: Math.max(0, dLen), nsym });
    }
    return plan;
  }

  // グロス容量とECCレベルから「正味(データ)容量」を求める。
  function netPayload(mode, eccLevel) {
    const G = getProfile(mode).PAYLOAD_BYTES;
    return blockPlan(G, eccLevel).reduce((s, b) => s + b.dataLen, 0);
  }

  // ---- ファインダ中心座標 (全モード共通) --
  function finderCenters() {
    const half = FINDER / 2;
    const tl = { x: GRID_X - GAP - half, y: GRID_Y - GAP - half };
    const tr = { x: GRID_X + GRID_W + GAP + half, y: GRID_Y - GAP - half };
    const br = { x: GRID_X + GRID_W + GAP + half, y: GRID_Y + GRID_H + GAP + half };
    const bl = { x: GRID_X - GAP - half, y: GRID_Y + GRID_H + GAP + half };
    return { tl, tr, br, bl };
  }

  // 論理ヘッダ(12byte)を組み立てる。
  // h[2](verModeEcc) の確定レイアウト(interpretLogical と厳密に一致):
  //   bit0..2 = version(=4)   bit3..5 = modeId(0..7)   bit6..7 = eccLevel(0..3)
  // modeId は 3bit(0..7)。将来 8モードを超える場合は VERSION を上げて再設計する。
  function buildHeaderLogical(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode, eccLevel) {
    const h = new Uint8Array(HEADER_DATA_LEN);
    const modeId = MODE_ID[mode] != null ? MODE_ID[mode] : 0;
    const ecc = eccLevel != null ? (eccLevel & 0x03) : 0;
    h[0] = MAGIC0;
    h[1] = MAGIC1;
    h[2] = (VERSION & 0x07) | ((modeId & 0x07) << 3) | ((ecc & 0x03) << 6);
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

  // ヘッダ行に載る「保護済みヘッダ」(HEADER_LEN byte)を返す。
  function buildHeader(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode, eccLevel) {
    const logical = buildHeaderLogical(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode, eccLevel);
    if (RS && HEADER_NSYM > 0) {
      return RS.encode(logical, HEADER_NSYM);
    }
    const out = new Uint8Array(HEADER_LEN);
    out.set(logical, 0);
    return out;
  }

  // 論理ヘッダ(12byte)を解釈する。
  function interpretLogical(h, checksumOk) {
    const verByte = h[2];
    let version = verByte & 0x07;
    let modeId, ecc;
    if (version >= 3) {
      // VERSION 3/4 共通: bit3..5=modeId(0..7), bit6..7=ecc(0..3)
      modeId = (verByte >> 3) & 0x07;
      ecc = (verByte >> 6) & 0x03;
    } else {
      // 旧ヘッダ後方互換: version は下位4bit、modeIdは上位4bit、ECCなし。
      version = verByte & 0x0f;
      modeId = version >= 2 ? (verByte >> 4) & 0x0f : 0;
      ecc = 0;
    }
    const mode = ID_MODE[modeId] != null ? ID_MODE[modeId] : '1kb';
    return {
      version,
      modeId,
      mode,
      eccLevel: ecc,
      pageIndex: h[3],
      totalPages: h[4],
      payloadLen: (h[5] << 8) | h[6],
      totalFileLen: (h[7] * 0x1000000) + (h[8] << 16) + (h[9] << 8) + h[10],
      checksumOk,
    };
  }

  // ヘッダ行から読んだ bytes を解釈する。
  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_DATA_LEN) return null;
    if (RS && bytes.length >= HEADER_LEN) {
      const cw = bytes.subarray(0, HEADER_LEN);
      const r = RS.decode(cw, HEADER_NSYM);
      const h = r.data;
      if (h[0] === MAGIC0 && h[1] === MAGIC1) {
        let x = 0;
        for (let i = 0; i < 11; i++) x ^= h[i];
        const ok = r.ok && x === h[11];
        if (ok) return interpretLogical(h, true);
        return interpretLogical(h, x === h[11]);
      }
    }
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= bytes[i];
    const ok = x === bytes[11];
    return interpretLogical(bytes, ok);
  }

  // ---- bit <-> byte ヘルパ -------------------------------------
  // グリッドは行優先(row-major)、MSB first でビットを並べる。
  // v6: ヘッダ行の余りビット(HEADER_PAD_BITS)も payload に使うため、
  //     payload の書き込みはヘッダ論理 18byte の直後(=HEADER_LEN*8 bit目)から始める。
  function bytesToBitGrid(headerBytes, payloadBytes, prof) {
    const p = prof || PROFILES['1kb'];
    const bits = new Uint8Array(p.COLS * p.ROWS);
    // header -> 先頭 HEADER_LEN*8 bit
    writeBytesToBits(bits, 0, headerBytes, HEADER_LEN * 8);
    // payload -> ヘッダ論理直後(余りビット)から、グリッド末尾まで
    const payloadBitStart = HEADER_LEN * 8;
    const payloadBits = p.COLS * p.ROWS - payloadBitStart;
    writeBytesToBits(bits, payloadBitStart, payloadBytes, payloadBits);
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

  // 0/1 grid -> {header: Uint8Array(18), payload: Uint8Array}
  function bitGridToBytes(bits, prof) {
    const p = prof || PROFILES['1kb'];
    const header = bitsToBytes(bits, 0, HEADER_LEN * 8);
    const payloadBitStart = HEADER_LEN * 8;
    const payloadBits = p.COLS * p.ROWS - payloadBitStart;
    const payload = bitsToBytes(bits, payloadBitStart, payloadBits);
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
    let mid = Math.round((mBstar + mFstar) / 2);
    if (!isFinite(mid)) mid = 128;
    if (mid < 5) mid = 128;
    if (mid > 250) mid = 128;
    return mid;
  }

  // ==================================================================
  //  インターリーブ (QR コード方式のバーストエラー分散)
  // ------------------------------------------------------------------
  //  複数の RS ブロック(符号語) cw[0..nblocks-1] を、バイト単位で「縦方向に
  //  取り出して交互配置」する。QR コードのデータ配置と同じ:
  //    出力 = cw[0][0], cw[1][0], ..., cw[k-1][0], cw[0][1], cw[1][1], ...
  //  ブロックごとに長さが違う場合(端数)は、その位置に存在するブロックだけ出す。
  //  こうすると、印刷物上で連続する領域(=バースト)の破損が、復元時には
  //  各ブロックへ「1〜数バイトずつ」分散され、ブロック単位の誤り数が減る。
  // ==================================================================
  function interleaveBlocks(codewords) {
    const maxLen = codewords.reduce((m, cw) => Math.max(m, cw.length), 0);
    const total = codewords.reduce((s, cw) => s + cw.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (let col = 0; col < maxLen; col++) {
      for (let b = 0; b < codewords.length; b++) {
        if (col < codewords[b].length) out[o++] = codewords[b][col];
      }
    }
    return out;
  }

  // インターリーブを解く。plan(各ブロックの符号語長 cwLen=dataLen+nsym)から
  // 元のブロック配列 cw[0..k-1] を復元する。
  function deinterleaveBlocks(inter, plan) {
    const lens = plan.map(b => b.dataLen + b.nsym);
    const maxLen = lens.reduce((m, l) => Math.max(m, l), 0);
    const cws = lens.map(l => new Uint8Array(l));
    let o = 0;
    for (let col = 0; col < maxLen; col++) {
      for (let b = 0; b < lens.length; b++) {
        if (col < lens[b]) cws[b][col] = inter[o++];
      }
    }
    return cws;
  }

  // ---- 正味データ(dataBytes) を RS 符号化 + インターリーブして
  //      グロス領域(grossBytes)に詰める ----
  function encodePayload(dataBytes, grossBytes, eccLevel) {
    const nsym = eccNsym(eccLevel);
    if (nsym === 0 || !RS) {
      const out = new Uint8Array(grossBytes);
      out.set(dataBytes.subarray(0, Math.min(dataBytes.length, grossBytes)), 0);
      return out;
    }
    const plan = blockPlan(grossBytes, eccLevel);
    // 各ブロックを RS 符号化 → codewords[]
    const codewords = [];
    let dOff = 0;
    for (const b of plan) {
      const data = new Uint8Array(b.dataLen);
      const take = Math.min(b.dataLen, dataBytes.length - dOff);
      if (take > 0) data.set(dataBytes.subarray(dOff, dOff + take), 0);
      dOff += b.dataLen;
      codewords.push(RS.encode(data, b.nsym));
    }
    // インターリーブして 1 本のバイト列に(バーストエラー分散)
    const inter = interleaveBlocks(codewords);
    const out = new Uint8Array(grossBytes);
    out.set(inter.subarray(0, Math.min(inter.length, grossBytes)), 0);
    return out;
  }

  // ---- グロス領域(grossBytes) をデインターリーブ + RS デコードして
  //      正味データ(netLen)を取り出す ----
  function decodePayload(grossData, eccLevel, netLen) {
    const nsym = eccNsym(eccLevel);
    if (nsym === 0 || !RS) {
      return { data: grossData.slice(0, netLen), ok: true, corrected: 0 };
    }
    const plan = blockPlan(grossData.length, eccLevel);
    // デインターリーブして各ブロック符号語へ戻す
    const cws = deinterleaveBlocks(grossData, plan);
    const data = new Uint8Array(plan.reduce((s, b) => s + b.dataLen, 0));
    let dOff = 0, allOk = true, corrected = 0;
    for (let i = 0; i < plan.length; i++) {
      const b = plan[i];
      const r = RS.decode(cws[i], b.nsym);
      if (!r.ok) allOk = false;
      corrected += r.corrected;
      data.set(r.data, dOff);
      dOff += b.dataLen;
    }
    return { data: data.slice(0, netLen), ok: allOk, corrected };
  }

  // ファイル全体を複数ページ分の {header, payload} に分割
  function splitFile(fileBytes, mode, eccLevel) {
    const prof = getProfile(mode);
    const ecc = eccLevel != null ? (eccLevel & 0x03) : 0;
    const net = netPayload(mode, ecc);
    const total = fileBytes.length;
    const totalPages = Math.max(1, Math.ceil(total / net));
    const pages = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * net;
      const end = Math.min(start + net, total);
      const chunk = fileBytes.slice(start, end);
      const payload = encodePayload(chunk, prof.PAYLOAD_BYTES, ecc);
      const header = buildHeader(p, totalPages, chunk.length, total, prof.mode, ecc);
      pages.push({ header, payload, payloadLen: chunk.length, mode: prof.mode, eccLevel: ecc });
    }
    return pages;
  }

  const DEFAULT = PROFILES['1kb'];

  global.CardFormat = {
    DPI,
    PAGE_W,
    PAGE_H,
    // --- 後方互換: 既定(1kb)のジオメトリ ---
    COLS: DEFAULT.COLS,
    ROWS: DEFAULT.ROWS,
    HEADER_ROWS: DEFAULT.HEADER_ROWS,
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
    HEADER_DATA_LEN,
    HEADER_NSYM,
    VERSION,
    QUIET,
    FINDER,
    GAP,
    FOOTER,
    // --- モード ---
    MODES,
    MODE_ID,
    ID_MODE,
    PROFILES,
    getProfile,
    // --- ECC ---
    ECC_LEVELS,
    BLOCK_N,
    eccNsym,
    blockPlan,
    netPayload,
    encodePayload,
    decodePayload,
    interleaveBlocks,
    deinterleaveBlocks,
    hasRS: !!RS,
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
