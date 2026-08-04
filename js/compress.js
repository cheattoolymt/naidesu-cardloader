/*
 * naidesu-cardloader — compress.js
 * ------------------------------------------------------------------
 * 「限界まで圧縮」して紙1枚あたりに詰め込めるデータ量を増やすための
 * 圧縮コンテナ。creator でチェックを入れるだけで有効化し、decoder は
 * 結合後のバイト列を見て「圧縮されているか / どの方式か」を自動判別し、
 * 自動で展開する。
 *
 * ● 破損厳禁 --------------------------------------------------------
 *   バイナリの完全一致は絶対条件。そこで
 *     1) 複数方式で圧縮 → 最小の符号語を選ぶ
 *     2) 圧縮しても元データより小さくならなければ「無圧縮(STORE)」にする
 *     3) 展開後に「元の長さ」と一致するか自己検証（不一致なら例外）
 *   という三重の安全策を取る。全方式は round-trip 可逆なもののみ採用。
 *
 * ● 方式 -----------------------------------------------------------
 *   0 STORE          : 無圧縮（そのまま）。圧縮で増える場合のフォールバック。
 *   1 DEFLATE_RAW    : deflate-raw（zlibヘッダ/checksum なし＝最小オーバヘッド）
 *                      ≒ gzip/deflate 相当の 40〜50% 削減、ヘッダ分だけさらに得。
 *   2 GZIP           : gzip（deflate_raw が使えない/劣る環境の保険）
 *   3 BROTLI         : brotli（対応環境のみ。deflate より強い ≈50% 削減）
 *   4 DEFLATE_JADICT : deflate-raw + 日本語プリセット辞書（zlib/pako の
 *                      「preset dictionary」機能。辞書は符号語に含めず、両側が
 *                      同じ辞書を共有して LZ77 の初期ウィンドウに載せる真の
 *                      辞書圧縮。短い日本語テキストで最大 60%超、長文でも
 *                      +10〜15% の上乗せを狙う）。
 *
 * ● コンテナ形式（先頭 6byte のヘッダ + 本体） --------------------
 *   [0..2] MAGIC = 'N','Z','1'   (0x4E 0x5A 0x31 = "NaidesuZip v1")
 *   [3]    method (0..4)
 *   [4..7] origLen (big-endian 32bit, 展開後の元バイト数)  ← [4..7] の 4byte
 *   [8..]  本体（method に応じた符号語 / STORE ならそのまま）
 *   ※ 実バイト位置: MAGIC(3) + method(1) + origLen(4) = 8byte ヘッダ。
 *
 *   decoder は先頭 3byte が MAGIC なら「圧縮コンテナ」とみなし展開、
 *   そうでなければ「旧来の無圧縮データ」として素通しする（後方互換）。
 *
 * ● 環境 -----------------------------------------------------------
 *   ブラウザ: CompressionStream / DecompressionStream（Baseline 2023-05〜）
 *            を deflate-raw/gzip/brotli に使用。辞書 deflate だけは辞書 API が
 *            無いため pako(js/vendor/pako.min.js)を使う。
 *   Node:    node:zlib / pako（テスト用）。
 * ================================================================== */

(function (global) {
  'use strict';

  const MAGIC0 = 0x4e; // 'N'
  const MAGIC1 = 0x5a; // 'Z'
  const MAGIC2 = 0x31; // '1'
  const HEADER_LEN = 8;

  const METHOD = {
    STORE: 0,
    DEFLATE_RAW: 1,
    GZIP: 2,
    BROTLI: 3,
    DEFLATE_JADICT: 4,
  };
  const METHOD_NAME = {
    0: 'STORE(無圧縮)',
    1: 'deflate-raw',
    2: 'gzip',
    3: 'brotli',
    4: 'deflate+日本語辞書',
  };

  // ---- 環境判定 --------------------------------------------------
  const hasCompressionStream =
    typeof global.CompressionStream !== 'undefined' &&
    typeof global.DecompressionStream !== 'undefined';

  let zlib = null;
  if (typeof require !== 'undefined') {
    try { zlib = require('zlib'); } catch (e) { /* browser */ }
  }

  // pako（辞書 deflate 用）。ブラウザは <script> で window.pako を先に読み込む。
  let pako = global.pako || null;
  if (!pako && typeof require !== 'undefined') {
    try { pako = require('./vendor/pako.min.js'); } catch (e) { /* optional */ }
  }
  const hasDictDeflate = !!pako;

  // ---- 日本語プリセット辞書 --------------------------------------
  // deflate の「preset dictionary」機能を使う。辞書は符号語に一切含めず、
  // 圧縮側・展開側の両方が同じ辞書を共有して LZ77 の初期ウィンドウに載せる。
  // これにより本文中の頻出日本語トークンが「辞書内への後方参照」として
  // 短く符号化される（＝真の辞書圧縮。prefix priming と違い辞書分の
  // オーバヘッドが無い）。
  //
  // 内容: ひらがな/カタカナ/よくある助詞・語尾・記号・HTML/JSON 断片など、
  // 日本語テキストで高頻度に出るバイト列を並べたもの。deflate は辞書の
  // 「末尾」を最も近い距離で参照できるので、高頻度語を後半に置く。
  const JA_DICT_TEXT = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>',
    '{"":"","id":,"name":"","type":"","value":,"data":[],"items":[{}],"true":true,"false":false,"null":null}',
    'ぁぃぅぇぉっゃゅょがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ',
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンー・、。',
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
    'これはですますでしたしていますございますについてということそしてしかしまたためからまでよりへとがのにをはもや',
    'する事もの時人年月日今何私達彼女使用場合以上以下および又は当社弊社お客様ありがとうございますよろしくお願いいたします',
    'です。ます。ました。ください。について、ということ。しかし、そして、',
  ].join('\n');

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf-8'));
  }
  const JA_DICT = utf8Encode(JA_DICT_TEXT);

  // ---- 低レベル: 生の deflate-raw / gzip / brotli (方式非依存) ----
  async function rawCompress(bytes, fmt) {
    // fmt: 'deflate-raw' | 'gzip' | 'brotli'
    if (hasCompressionStream) {
      let cs;
      try { cs = new global.CompressionStream(fmt); }
      catch (e) { return null; } // 未対応フォーマット(brotli等)
      const stream = new global.Blob([bytes]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (zlib) {
      return await new Promise((resolve, reject) => {
        const cb = (e, r) => (e ? reject(e) : resolve(new Uint8Array(r)));
        const inp = Buffer.from(bytes);
        if (fmt === 'deflate-raw') zlib.deflateRaw(inp, { level: 9 }, cb);
        else if (fmt === 'gzip') zlib.gzip(inp, { level: 9 }, cb);
        else if (fmt === 'brotli') zlib.brotliCompress(inp, cb);
        else reject(new Error('unknown fmt ' + fmt));
      });
    }
    return null;
  }

  async function rawDecompress(bytes, fmt) {
    if (hasCompressionStream) {
      let ds;
      try { ds = new global.DecompressionStream(fmt); }
      catch (e) { throw new Error('DecompressionStream 未対応: ' + fmt); }
      const stream = new global.Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (zlib) {
      return await new Promise((resolve, reject) => {
        const cb = (e, r) => (e ? reject(e) : resolve(new Uint8Array(r)));
        const inp = Buffer.from(bytes);
        if (fmt === 'deflate-raw') zlib.inflateRaw(inp, cb);
        else if (fmt === 'gzip') zlib.gunzip(inp, cb);
        else if (fmt === 'brotli') zlib.brotliDecompress(inp, cb);
        else reject(new Error('unknown fmt ' + fmt));
      });
    }
    throw new Error('展開環境なし');
  }

  // ---- 日本語辞書 deflate（真の preset dictionary） --------------
  // pako の deflateRaw/inflateRaw に dictionary オプションを渡す。辞書は
  // 符号語に含まれず、両側で共有する（この JS 内に固定で持つ）。
  function jadictCompress(bytes) {
    if (!pako) return null;
    try {
      return pako.deflateRaw(bytes, { level: 9, dictionary: JA_DICT });
    } catch (e) { return null; }
  }
  function jadictDecompress(body, origLen) {
    if (!pako) throw new Error('pako 未読み込み: 辞書展開不可');
    const out = pako.inflateRaw(body, { dictionary: JA_DICT });
    return out.subarray(0, origLen).slice();
  }

  // ---- ユーティリティ --------------------------------------------
  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  function makeContainer(method, origLen, body) {
    const out = new Uint8Array(HEADER_LEN + body.length);
    out[0] = MAGIC0; out[1] = MAGIC1; out[2] = MAGIC2;
    out[3] = method & 0xff;
    out[4] = (origLen >>> 24) & 0xff;
    out[5] = (origLen >>> 16) & 0xff;
    out[6] = (origLen >>> 8) & 0xff;
    out[7] = origLen & 0xff;
    out.set(body, HEADER_LEN);
    return out;
  }
  function isContainer(bytes) {
    return bytes && bytes.length >= HEADER_LEN &&
      bytes[0] === MAGIC0 && bytes[1] === MAGIC1 && bytes[2] === MAGIC2;
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---- 公開: 圧縮 ------------------------------------------------
  // fileBytes(Uint8Array) を「限界まで」圧縮したコンテナ(Uint8Array)を返す。
  // 全方式を試し、最小＆可逆(自己検証OK)のものを採用。増える場合は STORE。
  // 返り値: { container, method, methodName, origLen, compLen, ratio, tried }
  async function compress(fileBytes) {
    const origLen = fileBytes.length;
    const tried = []; // {method, len, ok}

    // 候補 [method, bodyPromise]
    const candidates = [];
    candidates.push([METHOD.DEFLATE_RAW, rawCompress(fileBytes, 'deflate-raw')]);
    candidates.push([METHOD.GZIP, rawCompress(fileBytes, 'gzip')]);
    candidates.push([METHOD.BROTLI, rawCompress(fileBytes, 'brotli')]);
    candidates.push([METHOD.DEFLATE_JADICT, Promise.resolve(jadictCompress(fileBytes))]);

    let best = { method: METHOD.STORE, body: fileBytes };
    let bestLen = fileBytes.length; // STORE の本体長（＝origLen）

    for (const [method, p] of candidates) {
      let body = null;
      try { body = await p; } catch (e) { body = null; }
      if (!body) { tried.push({ method, methodName: METHOD_NAME[method], len: null, ok: false }); continue; }
      tried.push({ method, methodName: METHOD_NAME[method], len: body.length, ok: true });
      if (body.length < bestLen) { best = { method, body }; bestLen = body.length; }
    }

    // 自己検証: 選ばれた方式で展開して完全一致するか確認（破損厳禁）。
    // 一致しなければ STORE にフォールバック。
    if (best.method !== METHOD.STORE) {
      let roundtripOk = false;
      try {
        const check = await decompressBody(best.method, best.body, origLen);
        roundtripOk = bytesEqual(check, fileBytes);
      } catch (e) { roundtripOk = false; }
      if (!roundtripOk) { best = { method: METHOD.STORE, body: fileBytes }; bestLen = fileBytes.length; }
    }

    const container = makeContainer(best.method, origLen, best.body);
    // コンテナ全体が元データ+ヘッダより大きいなら STORE を確定（既に上で吸収済みだが念のため）
    return {
      container,
      method: best.method,
      methodName: METHOD_NAME[best.method],
      origLen,
      compLen: container.length,
      ratio: origLen > 0 ? container.length / origLen : 1,
      tried,
    };
  }

  // 本体(body)を方式に応じて展開して元データを返す（内部用）
  async function decompressBody(method, body, origLen) {
    switch (method) {
      case METHOD.STORE:        return body.slice(0, origLen);
      case METHOD.DEFLATE_RAW:  return (await rawDecompress(body, 'deflate-raw')).slice(0, origLen);
      case METHOD.GZIP:         return (await rawDecompress(body, 'gzip')).slice(0, origLen);
      case METHOD.BROTLI:       return (await rawDecompress(body, 'brotli')).slice(0, origLen);
      case METHOD.DEFLATE_JADICT: return jadictDecompress(body, origLen);
      default: throw new Error('未知の圧縮方式: ' + method);
    }
  }

  // ---- 公開: 自動展開 --------------------------------------------
  // decoder が結合したバイト列。コンテナなら展開、そうでなければ素通し。
  // 返り値: { data, wasCompressed, method, methodName }
  async function autoDecompress(bytes) {
    if (!isContainer(bytes)) {
      return { data: bytes, wasCompressed: false, method: null, methodName: null };
    }
    const method = bytes[3];
    const origLen = (bytes[4] * 0x1000000) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
    const body = bytes.subarray(HEADER_LEN);
    const data = await decompressBody(method, body, origLen);
    if (data.length !== origLen) {
      throw new Error(`展開後の長さが不一致 (期待 ${origLen} / 実際 ${data.length})`);
    }
    return { data, wasCompressed: method !== METHOD.STORE, method, methodName: METHOD_NAME[method] };
  }

  global.NaidesuCompress = {
    METHOD,
    METHOD_NAME,
    HEADER_LEN,
    hasCompressionStream,
    hasDictDeflate,
    isContainer,
    compress,
    autoDecompress,
    // テスト補助
    _rawCompress: rawCompress,
    _rawDecompress: rawDecompress,
    _JA_DICT_LEN: JA_DICT.length,
  };

  // Node(テスト用): require で受け取れるように module.exports も設定
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.NaidesuCompress;
  }
})(typeof window !== 'undefined' ? window : globalThis);
