/*
 * autodetect.test.js
 * デコーダの自動検出ロジック(otsu + 連結成分 + finderToGrid + セルサンプリング +
 * 両モード試し読み)を Node上で再現し、レンダリング画像から角を自動検出→
 * モード自動判別→デコードして往復一致を検証する。
 * これは decoder.html の実経路(理想座標ではない)をテストする。
 *
 * 1KB / 2KB / 3KB / 4KB / 5KB 各モード × 誤り訂正(ECC) レベルを検証する。
 */
'use strict';
global.window = global;
require('../js/reed-solomon.js');
require('../js/card-format.js');
const CF = global.CardFormat;

// ---- ページを RGBA バッファに描画(ファインダ含む・任意の平行移動+スケール付与可) ----
function renderPageRGBA(page, opt = {}) {
  const prof = CF.getProfile(page.mode);
  const scale = opt.scale || 1;      // 拡大縮小(スキャナ解像度違いの模擬)
  const ox = opt.ox || 0, oy = opt.oy || 0; // 平行移動
  const W = Math.round(CF.PAGE_W * scale) + ox * 2;
  const H = Math.round(CF.PAGE_H * scale) + oy * 2;
  const g = new Uint8Array(W * H).fill(255);
  const fillRect = (x0,y0,w,h,val)=>{
    const X0=Math.round(x0*scale)+ox, Y0=Math.round(y0*scale)+oy;
    const X1=Math.round((x0+w)*scale)+ox, Y1=Math.round((y0+h)*scale)+oy;
    for(let y=Y0;y<Y1;y++)for(let x=X0;x<X1;x++) if(x>=0&&y>=0&&x<W&&y<H) g[y*W+x]=val;
  };
  const f = CF.finderCenters(); const half=CF.FINDER/2;
  [f.tl,f.tr,f.br,f.bl].forEach((c,i)=>{
    fillRect(c.x-half,c.y-half,half*2,half*2,0);
    if(i===0){const q=half*0.55;fillRect(c.x-q,c.y-q,q*2,q*2,255);
              const q2=half*0.22;fillRect(c.x-q2,c.y-q2,q2*2,q2*2,0);}
  });
  const bits=CF.bytesToBitGrid(page.header,page.payload,prof);
  // データセルを opt.flips 個だけ反転して「スキャン誤り」を模擬する
  if(opt.flips){ const ds=prof.HEADER_BITS; for(let i=0;i<opt.flips;i++){const idx=ds+((i*4099+37)%(bits.length-ds));bits[idx]^=1;} }
  for(let r=0;r<prof.ROWS;r++)for(let c=0;c<prof.COLS;c++){
    if(bits[r*prof.COLS+c]) fillRect(prof.GRID_X+c*prof.CELL_W+0.5, prof.GRID_Y+r*prof.CELL_H+0.5, prof.CELL_W-1, prof.CELL_H-1, 0);
  }
  // gray -> RGBA
  const rgba = new Uint8ClampedArray(W*H*4);
  for(let i=0;i<W*H;i++){ rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=g[i]; rgba[i*4+3]=255; }
  return { data: rgba, width: W, height: H };
}

// ---- decoder.html から移植: findFinders / finderToGrid / サンプリング ----
function findFinders(bin,w,h){
  const labels=new Int32Array(w*h);let next=1;const comps=[];const stack=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const idx=y*w+x;if(bin[idx]!==1||labels[idx])continue;
    const id=next++;let n=0,sx=0,sy=0,minx=x,miny=y,maxx=x,maxy=y;stack.length=0;stack.push(idx);labels[idx]=id;
    while(stack.length){const p=stack.pop();const px=p%w,py=(p/w)|0;n++;sx+=px;sy+=py;
      if(px<minx)minx=px;if(px>maxx)maxx=px;if(py<miny)miny=py;if(py>maxy)maxy=py;
      if(px>0&&bin[p-1]===1&&!labels[p-1]){labels[p-1]=id;stack.push(p-1);}
      if(px<w-1&&bin[p+1]===1&&!labels[p+1]){labels[p+1]=id;stack.push(p+1);}
      if(py>0&&bin[p-w]===1&&!labels[p-w]){labels[p-w]=id;stack.push(p-w);}
      if(py<h-1&&bin[p+w]===1&&!labels[p+w]){labels[p+w]=id;stack.push(p+w);}}
    comps.push({n,cx:sx/n,cy:sy/n,minx,miny,maxx,maxy});}
  if(comps.length<4)return null;
  const area=w*h;const cand=comps.filter(c=>{const bw=c.maxx-c.minx+1,bh=c.maxy-c.miny+1,ar=bw/bh,fill=c.n/(bw*bh);
    return c.n>area*0.0006&&c.n<area*0.05&&ar>0.5&&ar<2.0&&fill>0.45;});
  const pool=cand.length>=4?cand:comps;
  const refs=[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];const chosen=[];const used=new Set();
  for(const cr of refs){let best=null,bd=Infinity,bi=-1;pool.forEach((c,i)=>{if(used.has(i))return;
    const d=(c.cx-cr.x)**2+(c.cy-cr.y)**2;if(d<bd){bd=d;best=c;bi=i;}});if(!best)return null;used.add(bi);chosen.push({x:best.cx,y:best.cy});}
  return chosen;
}

function finderToGrid(fc){
  const p=CF.getProfile('1kb'); // GRID_* は全モード共通
  const offX=CF.GAP+CF.FINDER/2, offY=CF.GAP+CF.FINDER/2;
  const fW=((fc[1].x-fc[0].x)+(fc[2].x-fc[3].x))/2;
  const fH=((fc[3].y-fc[0].y)+(fc[2].y-fc[1].y))/2;
  const rx=fW/(p.GRID_W+2*offX), ry=fH/(p.GRID_H+2*offY);
  const dx=offX*rx, dy=offY*ry;
  return [{x:fc[0].x+dx,y:fc[0].y+dy},{x:fc[1].x-dx,y:fc[1].y+dy},
          {x:fc[2].x-dx,y:fc[2].y-dy},{x:fc[3].x+dx,y:fc[3].y-dy}];
}
const lerp=(a,b,f)=>({x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f});

function autoDetect(img){
  const {data,width:w,height:h}=img;
  const scale=Math.max(1,Math.round(Math.max(w,h)/800));
  const sw=Math.floor(w/scale),sh=Math.floor(h/scale);const gray=new Uint8Array(sw*sh);
  for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){const px=(y*scale*w+x*scale)*4;
    gray[y*sw+x]=data[px]*0.299+data[px+1]*0.587+data[px+2]*0.114;}
  const thr=CF.otsuThreshold(gray);const bin=new Uint8Array(sw*sh);for(let i=0;i<gray.length;i++)bin[i]=gray[i]<=thr?1:0;
  const found=findFinders(bin,sw,sh);if(!found)return null;
  let corners=found.map(p=>({x:p.x*scale,y:p.y*scale}));
  return finderToGrid(corners);
}

function sampleGrid(img,corners,prof){
  const {data,width:w,height:h}=img;const bits=new Uint8Array(prof.COLS*prof.ROWS);
  for(let r=0;r<prof.ROWS;r++)for(let c=0;c<prof.COLS;c++){
    const T=lerp(corners[0],corners[1],(c+0.5)/prof.COLS),B=lerp(corners[3],corners[2],(c+0.5)/prof.COLS);
    const pt=lerp(T,B,(r+0.5)/prof.ROWS);let acc=0,cnt=0;
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const xx=Math.round(pt.x+ox),yy=Math.round(pt.y+oy);
      if(xx<0||yy<0||xx>=w||yy>=h)continue;const p=(yy*w+xx)*4;
      acc+=data[p]*0.299+data[p+1]*0.587+data[p+2]*0.114;cnt++;}
    bits[r*prof.COLS+c]=(cnt?acc/cnt:255)<128?1:0;}
  return bits;
}

// 全モードで試し読みし、MAGIC+checksum+modeID一致の結果を採用(decoder.html の実経路)。
// ヘッダの eccLevel で本文を RS デコードして誤りを訂正する。
function decodeAnyMode(img,corners){
  let last=null;
  for(const mode of CF.MODES){
    const prof=CF.getProfile(mode);
    const bits=sampleGrid(img,corners,prof);
    const {header,payload}=CF.bitGridToBytes(bits,prof);
    const meta=CF.parseHeader(header);
    if(!meta)continue;
    last={meta,dec:null};
    if(!meta.checksumOk)continue;
    if(meta.mode===mode){
      const dec=CF.decodePayload(payload,meta.eccLevel,meta.payloadLen);
      return {meta,dec};
    }
  }
  return last||{meta:null,dec:null};
}

function assert(c,m){if(!c){console.error('FAIL:',m);process.exitCode=1;}else console.log('ok:',m);}

function run(name,bytes,mode,ecc,opt){
  ecc=ecc||0; opt=opt||{};
  const pages=CF.splitFile(bytes,mode,ecc);const restored=new Uint8Array(bytes.length);let off=0,ok=true,corr=0;
  for(const page of pages){
    const img=renderPageRGBA(page,opt);
    const corners=autoDetect(img);
    if(!corners){ok=false;console.error('autoDetect returned null');break;}
    const {meta,dec}=decodeAnyMode(img,corners);
    if(!meta||!meta.checksumOk||!dec||!dec.ok){ok=false;console.error('decode failed',meta&&meta.mode,dec&&dec.ok);break;}
    if(meta.mode!==mode){ok=false;console.error('mode mismatch',meta.mode,'!=',mode);break;}
    if(meta.eccLevel!==ecc){ok=false;console.error('ecc mismatch',meta.eccLevel,'!=',ecc);break;}
    corr+=dec.corrected;
    restored.set(dec.data.subarray(0,meta.payloadLen),off);off+=meta.payloadLen;
  }
  assert(ok,`[${mode} ecc=${ecc}] ${name}: autodetect+mode/ecc-detect+RS-decode ok`);
  assert(off===bytes.length,`[${mode} ecc=${ecc}] ${name}: length ${off}==${bytes.length}`);
  let eq=ok&&off===bytes.length;for(let i=0;i<bytes.length&&eq;i++)if(bytes[i]!==restored[i])eq=false;
  assert(eq,`[${mode} ecc=${ecc}] ${name}: corrected=${corr} byte-exact via AUTO-DETECT`);
}

for(const mode of CF.MODES){
  for(const ecc of [0,1,2,3]){
    run('auto-small', new TextEncoder().encode('naidesu auto-detect test 1234567890'), mode, ecc);
    // 正味容量ちょうどが1枚で自動検出・モード/ECC自動判別できるか
    run('auto-cap', crypto.getRandomValues(new Uint8Array(CF.netPayload(mode,ecc))), mode, ecc);
    run('auto-multi', crypto.getRandomValues(new Uint8Array(CF.netPayload(mode,ecc)*2+200)), mode, ecc);
    // スキャン解像度違い(1.3x)や余白付き(平行移動)でも動くか
    run('auto-scaled', crypto.getRandomValues(new Uint8Array(700)), mode, ecc, {scale:1.3});
    run('auto-offset', crypto.getRandomValues(new Uint8Array(600)), mode, ecc, {ox:80, oy:120});
  }
  // 汚れ耐性: ECC>0 なら自動検出経路でも反転セルを訂正して復元できる
  for(const ecc of [1,2,3]){
    run('auto-dirty', crypto.getRandomValues(new Uint8Array(500)), mode, ecc, {flips: ecc*20});
  }
}

if(process.exitCode)console.log('\n*** SOME TESTS FAILED ***');else console.log('\nALL AUTO-DETECT TESTS PASSED');
