/*
 * naidesu-cardloader — decode-core.js
 * ------------------------------------------------------------------
 * 読み取りの中核ロジック(DOM 非依存)。decoder.html と Node テストが
 * 同じコードを共有するため、ここに集約する(decoder.html の肥大化対策)。
 *
 * 入力は常に「RGBA 相当のピクセルアクセサ」+ 幅/高さで受け取り、
 * Canvas/ImageData への依存を排除する。呼び出し側(ブラウザ)は
 *   getImageData().data (Uint8ClampedArray) と width/height を渡すだけ。
 *
 * 提供する処理:
 *   detectCorners(img, opt)  … 四隅ファインダ自動検出 → データグリッド四隅
 *   sampleGrid(img, corners, prof, opt) … 射影変換 + 適応窓でセルを 0/1 に
 *   decodeAnyMode(img, corners, opt)   … 全モード試し読み → モード/ECC 確定
 * ================================================================== */

(function (global) {
  'use strict';

  const CF = global.CardFormat;
  const GEO = global.NaidesuGeometry;

  // ---- 画像アクセサ: {data, width, height} からグレースケール値を取得 ----
  function grayAt(img, x, y) {
    const { data, width } = img;
    const p = (y * width + x) * 4;
    return data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  // ---- 連結成分ラベリングで四隅ファインダを検出 ----
  function findFinders(bin, w, h) {
    const labels = new Int32Array(w * h);
    let next = 1;
    const comps = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (bin[idx] !== 1 || labels[idx] !== 0) continue;
        const id = next++;
        let n = 0, sx = 0, sy = 0, minx = x, miny = y, maxx = x, maxy = y;
        stack.length = 0; stack.push(idx); labels[idx] = id;
        while (stack.length) {
          const p = stack.pop();
          const px = p % w, py = (p / w) | 0;
          n++; sx += px; sy += py;
          if (px < minx) minx = px; if (px > maxx) maxx = px;
          if (py < miny) miny = py; if (py > maxy) maxy = py;
          if (px > 0 && bin[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = id; stack.push(p - 1); }
          if (px < w - 1 && bin[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = id; stack.push(p + 1); }
          if (py > 0 && bin[p - w] === 1 && labels[p - w] === 0) { labels[p - w] = id; stack.push(p - w); }
          if (py < h - 1 && bin[p + w] === 1 && labels[p + w] === 0) { labels[p + w] = id; stack.push(p + w); }
        }
        comps.push({ n, cx: sx / n, cy: sy / n, minx, miny, maxx, maxy });
      }
    }
    if (comps.length < 4) return null;

    const area = w * h;
    const cand = comps.filter(c => {
      const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
      const ar = bw / bh;
      const fill = c.n / (bw * bh);
      return c.n > area * 0.0004 && c.n < area * 0.06 && ar > 0.5 && ar < 2.0 && fill > 0.45;
    });
    const pool = cand.length >= 4 ? cand : comps;

    const cornersRef = [ { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h } ];
    const chosen = [];
    const used = new Set();
    for (const cr of cornersRef) {
      let best = null, bestD = Infinity, bestI = -1;
      pool.forEach((c, i) => {
        if (used.has(i)) return;
        const d = (c.cx - cr.x) ** 2 + (c.cy - cr.y) ** 2;
        if (d < bestD) { bestD = d; best = c; bestI = i; }
      });
      if (!best) return null;
      used.add(bestI);
      chosen.push({ x: best.cx, y: best.cy });
    }
    return chosen; // TL,TR,BR,BL のファインダ中心
  }

  // ファインダ中心 → データグリッド四隅(斜めでも動くよう各辺個別に補正)
  function finderToGrid(fc) {
    const offX = CF.GAP + CF.FINDER / 2;
    const offY = CF.GAP + CF.FINDER / 2;
    // 各辺のファインダ間ベクトルからグリッド角へ内側方向に補正。
    // 上辺(TL→TR)・右辺(TR→BR)・下辺(BL→BR)・左辺(TL→BL)を使う。
    const lerpVec = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const spanX = ((fc[1].x - fc[0].x) + (fc[2].x - fc[3].x)) / 2;
    const spanY = ((fc[3].y - fc[0].y) + (fc[2].y - fc[1].y)) / 2;
    const gridSpanFinderX = CF.GRID_W + 2 * offX;
    const gridSpanFinderY = CF.GRID_H + 2 * offY;
    const rx = spanX / gridSpanFinderX;
    const ry = spanY / gridSpanFinderY;
    const dx = offX * rx, dy = offY * ry;
    // 斜め対応: 各角ごとに、その角に接続する 2 辺の方向で内側へ寄せる
    return [
      { x: fc[0].x + dx, y: fc[0].y + dy }, // TL
      { x: fc[1].x - dx, y: fc[1].y + dy }, // TR
      { x: fc[2].x - dx, y: fc[2].y - dy }, // BR
      { x: fc[3].x + dx, y: fc[3].y - dy }, // BL
    ];
  }

  // 自動検出: img={data,width,height} からグリッド四隅を返す(検出不可なら null)。
  // opt.invert=true で白黒反転。
  function detectCorners(img, opt) {
    opt = opt || {};
    const w = img.width, h = img.height;
    const invert = !!opt.invert;
    const scale = Math.max(1, Math.round(Math.max(w, h) / 1400));
    const sw = Math.floor(w / scale), sh = Math.floor(h / scale);
    const gray = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let g = grayAt(img, x * scale, y * scale);
        if (invert) g = 255 - g;
        gray[y * sw + x] = g;
      }
    }
    const thr = CF.otsuThreshold(gray);
    const bin = new Uint8Array(sw * sh);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= thr ? 1 : 0;
    const found = findFinders(bin, sw, sh);
    if (!found) return null;
    const corners = found.map(p => ({ x: p.x * scale, y: p.y * scale }));
    return finderToGrid(corners);
  }

  // セルサンプリング: 射影変換(斜め補正) + 適応窓平均で 0/1 グリッドを得る。
  // opt.rowLimit を与えると先頭 rowLimit 行だけをサンプリングする(ヘッダ試し読み用の高速パス)。
  function sampleGrid(img, corners, prof, opt) {
    opt = opt || {};
    const invert = !!opt.invert;
    const w = img.width, h = img.height;
    const rowsToScan = opt.rowLimit != null ? Math.min(opt.rowLimit, prof.ROWS) : prof.ROWS;
    const bits = new Uint8Array(prof.COLS * prof.ROWS);
    const mapper = GEO.makeCellMapper(corners, prof.COLS, prof.ROWS);
    const span = mapper.cellSpanPx();
    const rad = GEO.samplingRadius(span);
    for (let r = 0; r < rowsToScan; r++) {
      for (let c = 0; c < prof.COLS; c++) {
        const pt = mapper.map(c, r);
        let acc = 0, cnt = 0;
        for (let oy = -rad; oy <= rad; oy++) {
          for (let ox = -rad; ox <= rad; ox++) {
            const xx = Math.round(pt.x + ox), yy = Math.round(pt.y + oy);
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            let g = grayAt(img, xx, yy);
            if (invert) g = 255 - g;
            acc += g; cnt++;
          }
        }
        const avg = cnt ? acc / cnt : 255;
        bits[r * prof.COLS + c] = avg < 128 ? 1 : 0;
      }
    }
    return bits;
  }

  // 全モードで試し読み → MAGIC+checksum+modeID一致を採用 → 本文 RS デコード。
  //
  // 高速化(v7): ヘッダは各モードのグリッド先頭 HEADER_ROWS 行にしか無いため、
  // まず「ヘッダ行だけ」を各モードでサンプリングして自己整合モードを絞り込み、
  // 確定したモードでのみ全面サンプリング+本文 RS デコードを行う。
  // これにより全モードを毎回フル解像度でサンプリングする無駄を排除する
  // (モード数が 10 に増えても検出コストがほぼ一定に保たれる)。
  function decodeAnyMode(img, corners, opt) {
    opt = opt || {};
    let lastMeta = null;
    let matched = null;
    for (const mode of CF.MODES) {
      const prof = CF.getProfile(mode);
      // ヘッダ行だけを試し読み(安全のため +1 行の余裕を持たせる)
      const headBits = sampleGrid(img, corners, prof, Object.assign({}, opt, { rowLimit: prof.HEADER_ROWS + 1 }));
      const { header } = CF.bitGridToBytes(headBits, prof);
      const meta = CF.parseHeader(header);
      if (!meta) continue;
      lastMeta = meta;
      if (!meta.checksumOk) continue;
      if (meta.mode === mode) { matched = { mode, prof, meta }; break; }
    }
    if (!matched) return { meta: lastMeta, payload: null, prof: null, dec: null };
    // 確定モードで全面サンプリング → 本文 RS デコード
    const { prof, meta } = matched;
    const bits = sampleGrid(img, corners, prof, opt);
    const { header, payload } = CF.bitGridToBytes(bits, prof);
    const fullMeta = CF.parseHeader(header) || meta;
    const dec = CF.decodePayload(payload, fullMeta.eccLevel, fullMeta.payloadLen);
    return { meta: fullMeta, payload, prof, dec };
  }

  global.NaidesuDecodeCore = {
    grayAt,
    findFinders,
    finderToGrid,
    detectCorners,
    sampleGrid,
    decodeAnyMode,
  };
})(typeof window !== 'undefined' ? window : globalThis);
