/*
 * naidesu-cardloader — reed-solomon.js
 * ------------------------------------------------------------------
 * GF(256) 上のリードソロモン符号 (systematic RS)。
 * 汚れ・かすれ・にじみで読み違えたセルを「誤り訂正」で復元するために使う。
 *
 * ● 目的 ------------------------------------------------------------
 *   1bit=1セルの生データは、印刷・スキャンの過程で一部のセルが
 *   反転(黒⇄白)しうる。RS を被せておけば、ブロックあたり最大 t=floor(P/2)
 *   バイトまでの「誤り(位置不明)」を訂正できる (P=パリティバイト数)。
 *   これにより、セルを小さくして容量を増やしても復元性を保てる
 *   ＝「誤り訂正に委ねて」高密度化できる。
 *
 * ● 仕様 ------------------------------------------------------------
 *   - 原始多項式 0x11d (x^8+x^4+x^3+x^2+1)。QR コードと同一。
 *   - systematic: 符号語 = [データ | パリティ]。データはそのまま残る。
 *   - encode(data, nsym): data の後ろに nsym バイトのパリティを付けて返す。
 *   - decode(codeword, nsym): 誤りを訂正して {data, ok, corrected} を返す。
 *       ok=false は「訂正能力(t=nsym/2)を超えた」= 復元失敗。
 *
 *   ブロック長は最大 255 バイト (GF(256) の制約)。呼び出し側で
 *   データを 255-nsym バイトごとに区切ってブロック化する。
 * ================================================================== */

(function (global) {
  'use strict';

  // ---- GF(256) 対数/逆対数テーブル (原始元 alpha=2, 原始多項式 0x11d) ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    // 折り返し分(乗算で index が 255 を超えても参照できるように複製)
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function gfDiv(a, b) {
    if (b === 0) throw new Error('gfDiv by zero');
    if (a === 0) return 0;
    return EXP[(LOG[a] - LOG[b] + 255) % 255];
  }
  function gfPow(a, n) {
    // a^n
    if (a === 0) return n === 0 ? 1 : 0;
    return EXP[(LOG[a] * n) % 255];
  }
  function gfInv(a) {
    return EXP[(255 - LOG[a]) % 255];
  }

  // ---- 多項式演算 (係数は昇冪でなく降冪: poly[0] が最高次) ----
  function polyMul(p, q) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 0) continue;
      for (let j = 0; j < q.length; j++) {
        r[i + j] ^= gfMul(p[i], q[j]);
      }
    }
    return r;
  }

  function polyEval(p, x) {
    // Horner 法
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
    return y;
  }

  // 生成多項式 g(x) = Π_{i=0}^{nsym-1} (x - alpha^i)
  const GEN_CACHE = {};
  function generatorPoly(nsym) {
    if (GEN_CACHE[nsym]) return GEN_CACHE[nsym];
    let g = new Uint8Array([1]);
    for (let i = 0; i < nsym; i++) {
      g = polyMul(g, new Uint8Array([1, gfPow(2, i)]));
    }
    GEN_CACHE[nsym] = g;
    return g;
  }

  // ---- エンコード: data(Uint8Array) の後ろに nsym パリティを付与 ----
  function encode(data, nsym) {
    const gen = generatorPoly(nsym);
    // 剰余計算 (systematic): out = data<<nsym を gen で割った余り
    const out = new Uint8Array(data.length + nsym);
    out.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const coef = out[i];
      if (coef !== 0) {
        for (let j = 1; j < gen.length; j++) {
          out[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    // out の先頭 data.length はデータのまま、末尾 nsym が剰余(パリティ)になる
    out.set(data, 0);
    return out;
  }

  // ---- シンドローム多項式 (降冪, 先頭に 0 を1つ付ける慣習) ----
  function calcSyndPoly(msg, nsym) {
    const synd = new Array(nsym + 1).fill(0);
    for (let i = 0; i < nsym; i++) {
      synd[nsym - i] = polyEval(msg, gfPow(2, i));
    }
    // synd[0] は 0 のまま (慣習: 生成根の開始が alpha^0)
    return synd;
  }

  // 多項式加算 (GF(256) = XOR)。降冪, 長さを揃えて XOR。
  function polyAdd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  // 多項式スカラ倍
  function polyScale(p, x) {
    return p.map((c) => gfMul(c, x));
  }

  // ---- Berlekamp-Massey で誤り位置多項式 Λ(x) を求める (降冪) ----
  // 参考: Wikiversity "Reed–Solomon codes for coders" の標準実装。
  function findErrorLocator(syndPoly, nsym) {
    // 昇冪シンドローム s_0..s_{nsym-1}
    const synd = [];
    for (let i = 0; i < nsym; i++) synd.push(syndPoly[nsym - i]);

    let errLoc = [1]; // 降冪
    let oldLoc = [1];
    for (let i = 0; i < nsym; i++) {
      const delta = (function () {
        let d = synd[i];
        for (let j = 1; j < errLoc.length; j++) {
          d ^= gfMul(errLoc[errLoc.length - 1 - j], synd[i - j]);
        }
        return d;
      })();
      oldLoc = oldLoc.concat([0]); // oldLoc *= x
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, gfInv(delta));
          errLoc = newLoc;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    return errLoc; // 降冪 Λ(x)
  }

  // ---- Chien 探索で誤り位置(msg 配列インデックス)を求める ----
  function findErrors(errLoc, msgLen) {
    const errs = errLoc.length - 1;
    const positions = [];
    for (let i = 0; i < msgLen; i++) {
      // x = alpha^{-(msgLen-1-i)} が根かどうか (位置 i を試す)
      const xInv = gfPow(2, (255 - i) % 255);
      if (polyEvalDesc(errLoc, xInv) === 0) {
        positions.push(msgLen - 1 - i);
      }
    }
    if (positions.length !== errs) return null;
    return positions;
  }

  // 降冪多項式の評価 (errLoc[0] が最高次)
  function polyEvalDesc(poly, x) {
    let y = poly[0];
    for (let i = 1; i < poly.length; i++) y = gfMul(y, x) ^ poly[i];
    return y;
  }

  // ---- Forney で誤り値を求めて訂正 ----
  function correctErrata(msg, syndPoly, positions, nsym) {
    const msgLen = msg.length;
    // 誤り位置多項式 Λ(x) を位置から再構成 (降冪)
    let errLoc = [1];
    for (const pos of positions) {
      const coefExp = msgLen - 1 - pos; // その位置に対応する alpha の指数
      const term = [gfPow(2, coefExp), 1]; // (alpha^coefExp * x + 1) 相当を降冪で
      errLoc = Array.from(polyMul(new Uint8Array(errLoc), new Uint8Array(term)));
    }

    // シンドローム多項式 (降冪): syndPoly は [0, s_{n-1}, ..., s_0]
    // 昇冪反転して Ω 計算用に使う
    const syndRev = [];
    for (let i = 1; i <= nsym; i++) syndRev.push(syndPoly[i]); // s_{n-1}..s_0 の降冪
    // 誤り評価多項式 Ω(x) = (S(x) * Λ(x)) mod x^nsym
    let errEval = Array.from(polyMul(new Uint8Array(syndRev), new Uint8Array(errLoc)));
    errEval = errEval.slice(errEval.length - nsym); // 下位 nsym 項
    // 先頭の余分を落として次数を Λ に合わせる
    errEval = errEval.slice(errEval.length - errLoc.length + 1);

    // Λ'(x) 形式的微分 (GF(2) では偶数項が消える)
    // 降冪 errLoc を昇冪に直して奇数次だけ残す
    const asc = errLoc.slice().reverse(); // asc[k] = x^k の係数
    const deriv = []; // 降冪で返す
    for (let k = 1; k < asc.length; k++) {
      if (k % 2 === 1) deriv.push(asc[k]); // 奇数次 -> 微分後 偶数次に落ちる係数
      else deriv.push(0);
    }
    deriv.reverse(); // 降冪へ

    for (const pos of positions) {
      const coefExp = msgLen - 1 - pos;
      const Xi = gfPow(2, coefExp); // 誤り位置ロケータ X_i = alpha^coefExp
      const XiInv = gfInv(Xi);
      const omega = polyEvalDesc(errEval, XiInv);
      const lambdaPrime = polyEvalDesc(deriv, XiInv);
      if (lambdaPrime === 0) return false;
      // Forney: e = X_i * Ω(X_i^-1) / Λ'(X_i^-1)   (生成根が alpha^0 始まりの場合)
      const magnitude = gfMul(Xi, gfDiv(omega, lambdaPrime));
      msg[pos] ^= magnitude;
    }
    return true;
  }

  // ---- デコード (誤り訂正) ----
  // codeword: Uint8Array([data | parity]) (長さ = dataLen + nsym)
  // 返り値: { data: Uint8Array(dataLen), ok: bool, corrected: number }
  function decode(codeword, nsym) {
    const msg = Uint8Array.from(codeword);
    const dataLen = msg.length - nsym;
    const syndPoly = calcSyndPoly(msg, nsym);
    let hasError = false;
    for (let i = 1; i < syndPoly.length; i++) if (syndPoly[i] !== 0) { hasError = true; break; }
    if (!hasError) return { data: msg.slice(0, dataLen), ok: true, corrected: 0 };

    const errLoc = findErrorLocator(syndPoly, nsym);
    const errCount = errLoc.length - 1;
    if (errCount <= 0 || errCount > (nsym >> 1)) {
      return { data: msg.slice(0, dataLen), ok: false, corrected: 0 };
    }
    const positions = findErrors(errLoc, msg.length);
    if (!positions) return { data: msg.slice(0, dataLen), ok: false, corrected: 0 };

    const okCorr = correctErrata(msg, syndPoly, positions, nsym);
    if (!okCorr) return { data: msg.slice(0, dataLen), ok: false, corrected: 0 };

    // 訂正後に再検証
    const synd2 = calcSyndPoly(msg, nsym);
    for (let i = 1; i < synd2.length; i++) {
      if (synd2[i] !== 0) return { data: msg.slice(0, dataLen), ok: false, corrected: 0 };
    }
    return { data: msg.slice(0, dataLen), ok: true, corrected: positions.length };
  }

  global.ReedSolomon = {
    encode,
    decode,
    // 低レベル(テスト用)
    _gf: { gfMul, gfDiv, gfPow, gfInv, EXP, LOG },
    _generatorPoly: generatorPoly,
    _calcSyndPoly: calcSyndPoly,
  };
})(typeof window !== 'undefined' ? window : globalThis);
