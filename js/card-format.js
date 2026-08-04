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
 *   以前はデータグリッドが「正方形」で、A4(2480x3508px)の上半分強しか
 *   使っていなかった。本バージョンでは四隅ファインダの内側いっぱい
 *   (ページ全高からフッタ分だけを除いた領域)をデータ領域として使う。
 *   グリッド矩形 GRID_W x GRID_H は全モード共通の「1つの長方形」で固定し、
 *   各モードはその同じ長方形を cols x rows に細分するだけ。
 *   これによりファインダ位置も全モード共通のまま、容量を大幅に拡張できる。
 *
 * ● 密度モード (5種) ------------------------------------------------
 *   "1kb":  96 x 143 セル ->  1704 byte/枚 (グロス)
 *   "2kb": 112 x 167 セル ->  2324 byte/枚 (グロス)
 *   "3kb": 130 x 194 セル ->  3136 byte/枚 (グロス)
 *   "4kb": 149 x 222 セル ->  4116 byte/枚 (グロス)
 *   "5kb": 170 x 254 セル ->  5376 byte/枚 (グロス) ← ページ全面を極限まで活用
 *
 *   グリッドはほぼ正方形セル(アスペクト比 ≈ 1.00)。300dpi でのセル物理サイズは
 *     1kb: 約 19.4px ≈ 1.64mm    4kb: 約 12.5px ≈ 1.06mm
 *     2kb: 約 16.6px ≈ 1.41mm    5kb: 約 10.9px ≈ 0.93mm
 *     3kb: 約 14.3px ≈ 1.21mm
 *
 * ● 誤り訂正 (ECC) — 段階選択 --------------------------------------
 *   高密度化(特に 5kb の 0.93mm セル)で読み違えが起きても復元できるよう、
 *   リードソロモン符号(js/reed-solomon.js)を被せる。クリエイターが
 *   汚れ耐性と正味容量のトレードオフを 4 段階で選べる:
 *     ecc=0 "none": パリティ 0%     (訂正なし・最大容量)
 *     ecc=1 "low" : パリティ 約10%  (グロスの ~5% のセル誤りを訂正)
 *     ecc=2 "med" : パリティ 約20%  (~10% のセル誤りを訂正・推奨)
 *     ecc=3 "high": パリティ 約30%  (~15% のセル誤りを訂正・最も頑健)
 *
 *   グロス容量(グリッドが物理的に持つバイト数)を最大 255byte の RS ブロックに
 *   分割し、各ブロックに nsym バイトのパリティを付ける。デコード時は各ブロックで
 *   最大 t=nsym/2 バイトの誤りを訂正する。これにより「誤り訂正に容量の一部を
 *   委ねる」ことで、セルを縮めても実用的に復元できる。
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
  const FOOTER = 110; // px 下端の人間可読テキスト用に確保する余白

  // 先頭のヘッダ行数。保護済みヘッダ(HEADER_LEN byte)が収まる最小行数を各モードで確保する。
  // (1kb は cols=96 なので 1 行=96bit=12byte では 18byte を収めきれない → 2 行にする)

  // ---- 全モード共通のデータグリッド矩形(px) ------------------
  // 四隅ファインダの内側いっぱいを使う「1つの長方形」。cols/rows のみ
  // モードで切り替え、この矩形自体は固定する(=ファインダ位置も固定)。
  // 以前は正方形グリッドで A4 の上半分強しか使っていなかったが、
  // ここでページ全高(下端フッタ分だけ除く)を使うことで容量を大幅拡張する。
  const GRID_X = QUIET + FINDER + GAP; // 310
  const GRID_Y = QUIET + FINDER + GAP; // 310 (上端)
  const GRID_W = PAGE_W - 2 * GRID_X;  // 1860
  const GRID_H = PAGE_H - GRID_Y - GRID_X - FOOTER; // 2778 (ページ全高活用)

  // ---- ヘッダ仕様 ----------------------------------------------
  // 論理ヘッダ = 12 byte:
  //   [0..1]  MAGIC  = 0x4E 0x43 ("NC" = Naidesu Card)
  //   [2]     verModeEcc: 下位3bit=version, 次3bit=modeId(0..4), 上位2bit=eccLevel(0..3)
  //   [3]     pageIndex (0-based)
  //   [4]     totalPages
  //   [5..6]  payloadLenThisPage (big-endian, このページの有効(正味)バイト数)
  //   [7..10] totalFileLen (big-endian 32bit, ファイル全体のバイト数)
  //   [11]    checksum = XOR of bytes[0..10]
  //
  // ヘッダは印刷/スキャン損傷に弱い(1行しかない)ため、論理12byte を
  // 専用 RS(nsym=HEADER_NSYM) で保護し、[12byte data | HEADER_NSYM parity] を
  // ヘッダ行に格納する。復号時は RS で誤り訂正してから解釈する。
  const MAGIC0 = 0x4e;
  const MAGIC1 = 0x43;
  const VERSION = 3; // 3: modeId(5種)+eccLevel を埋め込み。旧(1,2)は後方互換読取。
  const HEADER_DATA_LEN = 12;      // 論理ヘッダのバイト数
  const HEADER_NSYM = 6;           // ヘッダ保護 RS のパリティ(最大3byte誤り訂正)
  const HEADER_LEN = HEADER_DATA_LEN + HEADER_NSYM; // 18 = ヘッダ行に載る総バイト数

  // モードID (verModeEcc の bit3..5 に格納)
  const MODE_ID = { '1kb': 0, '2kb': 1, '3kb': 2, '4kb': 3, '5kb': 4 };
  const ID_MODE = { 0: '1kb', 1: '2kb', 2: '3kb', 3: '4kb', 4: '5kb' };

  // ---- ECC (誤り訂正) レベル -----------------------------------
  // 各ブロック(最大 BLOCK_N byte)に対するパリティ割合。nsym は偶数へ丸める。
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
  // 全モードは共通の GRID_X/Y/W/H 長方形を cols x rows に細分するだけ。
  // cols/rows は 1860:2778 ≈ 2:3 に近い比で選ぶため、セルはほぼ正方形。
  function makeProfile(mode, cols, rows) {
    // 保護済みヘッダ(HEADER_LEN byte = HEADER_LEN*8 bit)が収まる最小行数
    const headerRows = Math.max(1, Math.ceil((HEADER_LEN * 8) / cols));
    const HEADER_BITS = headerRows * cols;
    const DATA_BITS = (rows - headerRows) * cols;
    const PAYLOAD_BYTES = Math.floor(DATA_BITS / 8);

    const CELL_W = GRID_W / cols;
    const CELL_H = GRID_H / rows;

    return {
      mode,
      modeId: MODE_ID[mode],
      COLS: cols,
      ROWS: rows,
      HEADER_ROWS: headerRows,
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

  // 共通長方形(1860 x 2778)を細分する cols x rows。payload はページ全高を活用。
  // PAYLOAD_BYTES は「グロス容量」(グリッドが物理的に持てるバイト数)。
  // ECC を使う場合の正味容量は netPayload(mode, eccLevel) で求める。
  //   1kb:  96x143 -> 1704B (cell ≈ 1.64mm)
  //   2kb: 112x167 -> 2324B (cell ≈ 1.41mm)
  //   3kb: 130x194 -> 3136B (cell ≈ 1.21mm)
  //   4kb: 149x222 -> 4116B (cell ≈ 1.06mm)
  //   5kb: 170x254 -> 5376B (cell ≈ 0.93mm)  ← ページ全面を極限活用・5KB超/枚
  const PROFILES = {
    '1kb': makeProfile('1kb', 96, 143),
    '2kb': makeProfile('2kb', 112, 167),
    '3kb': makeProfile('3kb', 130, 194),
    '4kb': makeProfile('4kb', 149, 222),
    '5kb': makeProfile('5kb', 170, 254),
  };
  const MODES = Object.keys(PROFILES);

  function getProfile(mode) {
    return PROFILES[mode] || PROFILES['1kb'];
  }

  // ---- RS ブロック割り (グロス G byte を RS ブロックへ分割) --------
  // 返り値: [{dataLen, nsym}] のブロック配列。合計符号語長 = G。
  //   ecc=0: [{dataLen:G, nsym:0}]
  //   ecc>0: 先頭から満杯ブロック(N=255, nsym固定) を並べ、末尾に端数ブロック。
  //          端数ブロックは (残り符号語長) を dataLen+nsym に割る。
  function blockPlan(grossBytes, eccLevel) {
    const nsym = eccNsym(eccLevel);
    if (nsym === 0) return [{ dataLen: grossBytes, nsym: 0 }];
    const plan = [];
    let remaining = grossBytes;
    while (remaining > 0) {
      if (remaining >= BLOCK_N) {
        plan.push({ dataLen: BLOCK_N - nsym, nsym });
        remaining -= BLOCK_N;
      } else {
        // 端数: 符号語長 remaining。data がゼロ以下なら ECC に載せられないので
        // その端数はデータに使えない(捨てる)。
        const dLen = remaining - nsym;
        if (dLen > 0) plan.push({ dataLen: dLen, nsym });
        remaining = 0;
      }
    }
    return plan;
  }

  // グロス容量とECCレベルから「正味(データ)容量」を求める。
  function netPayload(mode, eccLevel) {
    const G = getProfile(mode).PAYLOAD_BYTES;
    return blockPlan(G, eccLevel).reduce((s, b) => s + b.dataLen, 0);
  }

  // ---- ファインダ中心座標 (全モード共通・幾何はグリッド矩形依存) --
  // グリッド矩形はモードに依らず同一(GRID_X/Y/W/H は全モード同値)なので、
  // ファインダ位置も共通。TL, TR, BR, BL の順 (時計回り)。
  function finderCenters() {
    // GRID_X/Y/W/H は全モード共通のトップレベル定数。
    const half = FINDER / 2;
    const tl = { x: GRID_X - GAP - half, y: GRID_Y - GAP - half };
    const tr = { x: GRID_X + GRID_W + GAP + half, y: GRID_Y - GAP - half };
    const br = { x: GRID_X + GRID_W + GAP + half, y: GRID_Y + GRID_H + GAP + half };
    const bl = { x: GRID_X - GAP - half, y: GRID_Y + GRID_H + GAP + half };
    return { tl, tr, br, bl };
  }

  // 論理ヘッダ(12byte)を組み立てる。verModeEcc に version/modeId/eccLevel を詰める。
  function buildHeaderLogical(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode, eccLevel) {
    const h = new Uint8Array(HEADER_DATA_LEN);
    const modeId = MODE_ID[mode] != null ? MODE_ID[mode] : 0;
    const ecc = eccLevel != null ? (eccLevel & 0x03) : 0;
    h[0] = MAGIC0;
    h[1] = MAGIC1;
    // 下位3bit=version, 次3bit=modeId(0..4), 上位2bit=eccLevel(0..3)
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
  // 論理12byte を RS(nsym=HEADER_NSYM) で符号化。RS 不在時は 0 パディングで後方互換。
  function buildHeader(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode, eccLevel) {
    const logical = buildHeaderLogical(pageIndex, totalPages, payloadLenThisPage, totalFileLen, mode, eccLevel);
    if (RS && HEADER_NSYM > 0) {
      return RS.encode(logical, HEADER_NSYM); // [12 data | 6 parity] = 18byte
    }
    const out = new Uint8Array(HEADER_LEN);
    out.set(logical, 0);
    return out;
  }

  // 論理ヘッダ(12byte)を解釈する。
  function interpretLogical(h, checksumOk) {
    const verByte = h[2];
    // version は下位3bit。旧 version(1,2) は下位4bit解釈 & 別レイアウトなので後方互換。
    let version = verByte & 0x07;
    let modeId, ecc;
    if (version >= 3) {
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

  // ヘッダ行から読んだ bytes(HEADER_LEN もしくは旧12byte)を解釈する。
  // まず RS でヘッダを誤り訂正してから、MAGIC/checksum を確認する。
  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_DATA_LEN) return null;

    // 1) RS 保護ヘッダ(>=18byte)として復元を試みる
    if (RS && bytes.length >= HEADER_LEN) {
      const cw = bytes.subarray(0, HEADER_LEN);
      const r = RS.decode(cw, HEADER_NSYM);
      const h = r.data; // 12byte
      if (h[0] === MAGIC0 && h[1] === MAGIC1) {
        let x = 0;
        for (let i = 0; i < 11; i++) x ^= h[i];
        const ok = r.ok && x === h[11];
        if (ok) return interpretLogical(h, true);
        // RS 復元は失敗だが MAGIC は見えている → checksum で最終判定
        return interpretLogical(h, x === h[11]);
      }
    }

    // 2) 後方互換: RS なし/旧12byteヘッダとして素の先頭12byteを解釈
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= bytes[i];
    const ok = x === bytes[11];
    return interpretLogical(bytes, ok);
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

  // ---- 正味データ(dataBytes) を RS 符号化してグロス領域(grossBytes)に詰める ----
  // 返り値: グロス長 grossBytes の Uint8Array (末尾ゼロ埋め)。
  // ecc=0 の場合はそのままコピー。
  function encodePayload(dataBytes, grossBytes, eccLevel) {
    const out = new Uint8Array(grossBytes);
    const nsym = eccNsym(eccLevel);
    if (nsym === 0 || !RS) {
      out.set(dataBytes.subarray(0, Math.min(dataBytes.length, grossBytes)), 0);
      return out;
    }
    const plan = blockPlan(grossBytes, eccLevel);
    let dOff = 0, cOff = 0;
    for (const b of plan) {
      const data = new Uint8Array(b.dataLen); // 0埋め
      const take = Math.min(b.dataLen, dataBytes.length - dOff);
      if (take > 0) data.set(dataBytes.subarray(dOff, dOff + take), 0);
      dOff += b.dataLen;
      const cw = RS.encode(data, b.nsym); // 長さ dataLen+nsym
      out.set(cw, cOff);
      cOff += cw.length;
    }
    return out;
  }

  // ---- グロス領域(grossBytes) を RS デコードして正味データ(netLen)を取り出す ----
  // 返り値: { data: Uint8Array(netLen), ok: bool, corrected: number }
  //   ok=false は「どこかのブロックで訂正能力を超えた」= このページは要再スキャン。
  function decodePayload(grossData, eccLevel, netLen) {
    const nsym = eccNsym(eccLevel);
    if (nsym === 0 || !RS) {
      return { data: grossData.slice(0, netLen), ok: true, corrected: 0 };
    }
    const plan = blockPlan(grossData.length, eccLevel);
    const data = new Uint8Array(plan.reduce((s, b) => s + b.dataLen, 0));
    let cOff = 0, dOff = 0, allOk = true, corrected = 0;
    for (const b of plan) {
      const cwLen = b.dataLen + b.nsym;
      const cw = grossData.subarray(cOff, cOff + cwLen);
      cOff += cwLen;
      const r = RS.decode(cw, b.nsym);
      if (!r.ok) allOk = false;
      corrected += r.corrected;
      data.set(r.data, dOff);
      dOff += b.dataLen;
    }
    return { data: data.slice(0, netLen), ok: allOk, corrected };
  }

  // ファイル全体を複数ページ分の {header, payload} に分割
  //   mode:     '1kb'..'5kb'（省略時は '1kb'）
  //   eccLevel: 0..3（省略時は 0=なし）
  // payload はグロス長(prof.PAYLOAD_BYTES)。ecc>0 なら RS 符号化済みのバイト列。
  function splitFile(fileBytes, mode, eccLevel) {
    const prof = getProfile(mode);
    const ecc = eccLevel != null ? (eccLevel & 0x03) : 0;
    const net = netPayload(mode, ecc); // 1ページに載る正味データ量
    const total = fileBytes.length;
    const totalPages = Math.max(1, Math.ceil(total / net));
    const pages = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * net;
      const end = Math.min(start + net, total);
      const chunk = fileBytes.slice(start, end);
      const payload = encodePayload(chunk, prof.PAYLOAD_BYTES, ecc); // グロス長
      const header = buildHeader(p, totalPages, chunk.length, total, prof.mode, ecc);
      pages.push({ header, payload, payloadLen: chunk.length, mode: prof.mode, eccLevel: ecc });
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
