/*
 * naidesu-cardloader — geometry.js
 * ------------------------------------------------------------------
 * 読み取り側の「幾何」ユーティリティ。decoder.html と Node テストの
 * 両方から使えるよう、DOM 非依存の純粋関数だけをまとめる。
 *
 *  ● 射影変換(ホモグラフィ) --------------------------------------
 *    スキャナは真上・等倍が前提だが、スマホ撮影では紙が台形に歪む
 *    (=遠近)。四隅ファインダから求めた 4 点対応で「単位正方形 → 画像上の
 *    四角形」への射影変換 H(3x3) を解き、グリッドの各セル中心 (u,v)∈[0,1]^2 を
 *    画像座標 (x,y) に写す。これにより斜め撮影でも正しいセルを拾える。
 *    双一次補間(bilinear, 台形近似)より精度が高い。
 *
 *  ● 適応サンプリング窓 ------------------------------------------
 *    セル中心まわりを従来は 3x3 固定でサンプリングしていたが、セルが
 *    大きい低密度モードでは窓が狭すぎてノイズに弱かった。セルの画像上の
 *    実効サイズ(px)に応じて窓半径を広げ、ノイズ耐性を上げる。
 * ================================================================== */

(function (global) {
  'use strict';

  // 3x3 線形方程式(8x8 まで)の Gauss-Jordan 消去。A x = b を解いて x を返す。
  function solveLinear(A, b) {
    const n = b.length;
    // 拡大係数行列
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      // ピボット選択(部分ピボッティング)
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null; // 特異
      const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      // 正規化
      const pv = M[col][col];
      for (let k = col; k <= n; k++) M[col][k] /= pv;
      // 消去
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
      }
    }
    return M.map(row => row[n]);
  }

  // 単位正方形 (0,0),(1,0),(1,1),(0,1) → 画像上の 4 点 dst[0..3] (TL,TR,BR,BL)
  // への射影変換 H を計算する。H は係数 [a,b,c,d,e,f,g,h] (i=1固定) で表し、
  //   x = (a*u + b*v + c) / (g*u + h*v + 1)
  //   y = (d*u + e*v + f) / (g*u + h*v + 1)
  // となる。4 点対応 → 8 元連立方程式。
  function computeHomography(dst) {
    // 単位正方形の対応点(u,v)
    const src = [ {u:0,v:0}, {u:1,v:0}, {u:1,v:1}, {u:0,v:1} ];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { u, v } = src[i];
      const { x, y } = dst[i];
      // x 方程式: a*u + b*v + c - g*u*x - h*v*x = x
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      // y 方程式: d*u + e*v + f - g*u*y - h*v*y = y
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    const h = solveLinear(A, b);
    if (!h) return null;
    return h; // [a,b,c,d,e,f,g,h]
  }

  // 射影変換 H で (u,v)∈[0,1]^2 → 画像座標 (x,y)
  function applyHomography(H, u, v) {
    const denom = H[6] * u + H[7] * v + 1;
    return {
      x: (H[0] * u + H[1] * v + H[2]) / denom,
      y: (H[3] * u + H[4] * v + H[5]) / denom,
    };
  }

  // フォールバック(平行四辺形近似): 4 隅の bilinear 補間で (u,v)→画像座標。
  // ホモグラフィが特異になったとき用。
  function bilinearMap(corners, u, v) {
    // corners: TL,TR,BR,BL
    const top = { x: corners[0].x + (corners[1].x - corners[0].x) * u,
                  y: corners[0].y + (corners[1].y - corners[0].y) * u };
    const bot = { x: corners[3].x + (corners[2].x - corners[3].x) * u,
                  y: corners[3].y + (corners[2].y - corners[3].y) * u };
    return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
  }

  // グリッドの (col,row) セル中心の画像座標を返すマッパを作る。
  //   corners: データグリッド四隅の画像座標 (TL,TR,BR,BL)
  //   useHomography=true なら射影変換、失敗/false なら bilinear。
  function makeCellMapper(corners, cols, rows) {
    const H = computeHomography(corners);
    const map = (c, r) => {
      const u = (c + 0.5) / cols;
      const v = (r + 0.5) / rows;
      return H ? applyHomography(H, u, v) : bilinearMap(corners, u, v);
    };
    // 隣接セル間の画像上の距離(=セルの実効 px サイズ)推定に使う関数も返す。
    const cellSpanPx = () => {
      // グリッド中央付近で 1 セル分の移動量を測る
      const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
      const p0 = map(cx, cy);
      const px = map(cx + 1, cy);
      const py = map(cx, cy + 1);
      const dx = Math.hypot(px.x - p0.x, px.y - p0.y);
      const dy = Math.hypot(py.x - p0.x, py.y - p0.y);
      return { w: dx, h: dy };
    };
    return { map, cellSpanPx, homography: H };
  }

  // セルの実効 px サイズから、サンプリング窓の半径(px)を決める。
  //   ・小さすぎる窓は量子化ノイズに弱く、大きすぎる窓は隣接セルを巻き込む。
  //   ・セル幅の約 30% を半径にする(=直径 60%)。最低 1、最大 6 にクランプ。
  function samplingRadius(cellSpanPx) {
    const minSpan = Math.min(cellSpanPx.w, cellSpanPx.h);
    let r = Math.round(minSpan * 0.30);
    if (r < 1) r = 1;
    if (r > 6) r = 6;
    return r;
  }

  global.NaidesuGeometry = {
    solveLinear,
    computeHomography,
    applyHomography,
    bilinearMap,
    makeCellMapper,
    samplingRadius,
  };
})(typeof window !== 'undefined' ? window : globalThis);
