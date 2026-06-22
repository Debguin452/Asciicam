export const DEFAULT_CHARSET = " .:-=+*#%@";

export interface AsciiOptions {
  asciiW: number; asciiH: number;
  brightness: number; contrast: number; threshold: number; gamma: number;
  invert: boolean; color: boolean; edges: boolean; gradientDirs: boolean;
  dither: boolean; ditherMode: "floyd" | "bayer";
  noiseReduction: boolean; localContrast: boolean; histEq: boolean;
  charset: string; brailleMode: boolean; blockMode: boolean; temporalSmoothing: boolean;
}

export const DEFAULT_OPTIONS: AsciiOptions = {
  asciiW: 140, asciiH: 80, brightness: -30, contrast: 180, threshold: 0, gamma: 1.1,
  invert: false, color: false, edges: false, gradientDirs: false,
  dither: false, ditherMode: "floyd", noiseReduction: false, localContrast: false,
  histEq: false, charset: DEFAULT_CHARSET, brailleMode: false, blockMode: false, temporalSmoothing: false,
};

export interface AsciiCell { char: string; charIdx: number; r: number; g: number; b: number; }
export type AsciiFrame = AsciiCell[][];
export type AsciiSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

// ─── Shared scratch buffers ─────────────────────────────────────────────────────
// Allocated once per unique pixel count, reused every frame. Zero GC pressure at steady state.
let _N = 0;
let _gray      = new Float32Array(0);
let _r_buf     = new Uint8Array(0);
let _g_buf     = new Uint8Array(0);
let _b_buf     = new Uint8Array(0);
let _scratch_a = new Float32Array(0); // filter ping-buffer
let _scratch_b = new Float32Array(0); // filter pong-buffer
let _scratch_c = new Float32Array(0); // localContrast internal blur — never overlaps a/b
let _mag_buf   = new Float32Array(0); // sobel magnitude
let _dir_buf   = new Float32Array(0); // sobel direction (radians)
let _idx_buf   = new Uint16Array(0);  // char index per pixel
let _smoothed: Float32Array | null = null;
let _lastDrawW = 0, _lastDrawH = 0, _lastChars = "";

function ensureBuffers(n: number): void {
  if (n === _N) return;
  _N = n;
  _gray      = new Float32Array(n);
  _r_buf     = new Uint8Array(n);
  _g_buf     = new Uint8Array(n);
  _b_buf     = new Uint8Array(n);
  _scratch_a = new Float32Array(n);
  _scratch_b = new Float32Array(n);
  _scratch_c = new Float32Array(n);
  _mag_buf   = new Float32Array(n);
  _dir_buf   = new Float32Array(n);
  _idx_buf   = new Uint16Array(n);
  _smoothed  = null;
}

// next alternates between _scratch_a and _scratch_b, never returning the input buffer itself
function nextOf(cur: Float32Array): Float32Array {
  return cur === _scratch_a ? _scratch_b : _scratch_a;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function clamp(v: number, lo = 0, hi = 255): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function getSourceDimensions(s: AsciiSource): { w: number; h: number } {
  if (s instanceof HTMLVideoElement) return { w: s.videoWidth, h: s.videoHeight };
  if (s instanceof HTMLCanvasElement) return { w: s.width, h: s.height };
  return { w: s.naturalWidth, h: s.naturalHeight };
}

// ─── In-place filter implementations (no allocation) ──────────────────────────
function gaussianBlur3InPlace(src: Float32Array, dst: Float32Array, w: number, h: number): void {
  const k = [1/16,2/16,1/16,2/16,4/16,2/16,1/16,2/16,1/16];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++)
          s += src[clamp(y+ky,0,h-1)*w+clamp(x+kx,0,w-1)] * k[(ky+1)*3+(kx+1)];
      dst[y*w+x] = s;
    }
}

function sobelInPlace(src: Float32Array, mag: Float32Array, dir: Float32Array, w: number, h: number): void {
  const Gx = [-1,0,1,-2,0,2,-1,0,1], Gy = [-1,-2,-1,0,0,0,1,2,1];
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const p = src[(y+ky)*w+(x+kx)], ki = (ky+1)*3+(kx+1);
          gx += Gx[ki]*p; gy += Gy[ki]*p;
        }
      mag[y*w+x] = clamp(Math.abs(gx)+Math.abs(gy));
      dir[y*w+x] = Math.atan2(gy, gx);
    }
}

function bayerInPlace(src: Float32Array, dst: Float32Array, w: number, h: number, n: number): void {
  const M = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y*w+x;
      dst[i] = clamp(src[i] + (M[(y%4)*4+(x%4)]/16*255 - 128) * (2/n));
    }
}

const FS_KX = [1,-1,0,1], FS_KY = [0,1,1,1], FS_W = [7/16,3/16,5/16,1/16];
function floydInPlace(src: Float32Array, dst: Float32Array, w: number, h: number, n: number): void {
  dst.set(src);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const old = dst[y*w+x];
      const qi = clamp(Math.round((old/255)*(n-1)), 0, n-1);
      const nv = (qi/(n-1))*255;
      dst[y*w+x] = nv;
      const err = old - nv;
      for (let k = 0; k < 4; k++) {
        const nx = x+FS_KX[k], ny = y+FS_KY[k];
        if (nx>=0 && nx<w && ny<h) dst[ny*w+nx] += err*FS_W[k];
      }
    }
}

function histEqInPlace(src: Float32Array, dst: Float32Array, n: number): void {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.round(clamp(src[i]))]++;
  let cdfMin = 0, cdf = 0;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    cdf += hist[v];
    if (cdf > 0 && cdfMin === 0) cdfMin = cdf;
    lut[v] = ((cdf - cdfMin) / (n - cdfMin)) * 255;
  }
  for (let i = 0; i < n; i++) dst[i] = lut[Math.round(clamp(src[i]))];
}

function localContrastInPlace(src: Float32Array, dst: Float32Array, tmp: Float32Array, w: number, h: number): void {
  gaussianBlur3InPlace(src, tmp, w, h);
  for (let i = 0; i < src.length; i++) dst[i] = clamp(src[i] + (src[i] - tmp[i]) * 1.5);
}

function temporalSmoothInPlace(src: Float32Array, dst: Float32Array, n: number, alpha = 0.4): void {
  if (!_smoothed || _smoothed.length !== n) { _smoothed = new Float32Array(src); dst.set(src); return; }
  for (let i = 0; i < n; i++) { dst[i] = _smoothed[i]*(1-alpha) + src[i]*alpha; _smoothed[i] = dst[i]; }
}

// ─── Charset density ───────────────────────────────────────────────────────────
const densityCache = new Map<string, string>();
export function sortCharsetByDensity(charset: string): string {
  if (densityCache.has(charset)) return densityCache.get(charset)!;
  try {
    const cv = document.createElement("canvas"); cv.width=10; cv.height=14;
    const cx = cv.getContext("2d")!; cx.font="10px monospace"; cx.fillStyle="white";
    const measured = Array.from(new Set(charset)).map(ch => {
      cx.clearRect(0,0,10,14); cx.fillText(ch,0,11);
      const d=cx.getImageData(0,0,10,14).data; let s=0;
      for (let i=0;i<d.length;i+=4) s+=d[i];
      return {ch,density:s};
    });
    measured.sort((a,b)=>a.density-b.density);
    const sorted=measured.map(m=>m.ch).join("");
    densityCache.set(charset,sorted); return sorted;
  } catch { densityCache.set(charset,charset); return charset; }
}

export function resetTemporalSmoothing(): void { _smoothed = null; }

// ─── Core pipeline ─────────────────────────────────────────────────────────────
// Runs the full pixel→index mapping. Fills shared buffers.
// Returns { drawW, drawH, chars } or null if source has no dimensions.
interface PipelineResult { drawW: number; drawH: number; chars: string; }

function runPipeline(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror: boolean,
  crop?: { x:number; y:number; w:number; h:number }
): PipelineResult | null {
  const { w:sw, h:sh } = getSourceDimensions(source);
  if (!sw || !sh) return null;

  const { asciiW, asciiH, brightness, contrast, threshold, gamma, invert, color,
    edges, gradientDirs, dither, ditherMode, noiseReduction, localContrast, histEq,
    charset, brailleMode, blockMode, temporalSmoothing } = opts;

  const srcX=crop?.x??0, srcY=crop?.y??0, srcW=crop?.w??sw, srcH=crop?.h??sh;
  const aspect = srcW/srcH, charAspect = 0.5;
  let drawW = asciiW, drawH = Math.round(asciiW/aspect*charAspect);
  if (drawH > asciiH) { drawH=asciiH; drawW=Math.round(asciiH*aspect/charAspect); }

  offscreen.width=drawW; offscreen.height=drawH;
  const ctx = offscreen.getContext("2d",{willReadFrequently:true})!;
  ctx.save();
  if (mirror) { ctx.scale(-1,1); ctx.drawImage(source,srcX,srcY,srcW,srcH,-drawW,0,drawW,drawH); }
  else { ctx.drawImage(source,srcX,srcY,srcW,srcH,0,0,drawW,drawH); }
  ctx.restore();

  const px = ctx.getImageData(0,0,drawW,drawH).data;
  const N = drawW*drawH;
  ensureBuffers(N);

  // Step 1: Luminance + color extraction into shared buffers
  for (let i = 0; i < N; i++) {
    const r=px[i*4], g=px[i*4+1], b=px[i*4+2];
    let lum = 0.299*r + 0.587*g + 0.114*b;
    if (gamma!==1.0) lum = Math.pow(lum/255, 1/gamma)*255;
    if (contrast!==100) lum = 128+(lum-128)*contrast/100;
    lum += brightness;
    _gray[i]=clamp(lum); _r_buf[i]=r; _g_buf[i]=g; _b_buf[i]=b;
  }

  if (brailleMode) { _lastDrawW=drawW; _lastDrawH=drawH; _lastChars=charset; return {drawW,drawH,chars:charset}; }

  // Step 2: Filter pipeline — ping-pong between _scratch_a/_scratch_b, _scratch_c for blur scratch
  let cur: Float32Array = _gray;
  if (noiseReduction)   { gaussianBlur3InPlace(cur, nextOf(cur), drawW, drawH); cur=nextOf(cur); }
  if (histEq)           { histEqInPlace(cur, nextOf(cur), N); cur=nextOf(cur); }
  if (localContrast)    { localContrastInPlace(cur, nextOf(cur), _scratch_c, drawW, drawH); cur=nextOf(cur); }
  if (temporalSmoothing){ temporalSmoothInPlace(cur, nextOf(cur), N); cur=nextOf(cur); }

  const chars = sortCharsetByDensity(charset||DEFAULT_CHARSET);
  const nchars = chars.length;

  if (blockMode) {
    const blocks=" \u2591\u2592\u2593\u2588", nb=blocks.length;
    for (let i=0;i<N;i++) _idx_buf[i]=Math.min(Math.floor(clamp(cur[i])/256*nb),nb-1);
    _lastDrawW=drawW; _lastDrawH=drawH; _lastChars=blocks;
    return {drawW,drawH,chars:blocks};
  }

  // Step 3: Edge detection
  const needGrad = edges||gradientDirs;
  if (needGrad) sobelInPlace(cur, _mag_buf, _dir_buf, drawW, drawH);
  let final: Float32Array = (edges && needGrad) ? _mag_buf : cur;

  // Step 4: Dithering
  if (dither) {
    const dstBuf = (final===_scratch_a) ? _scratch_b : _scratch_a;
    if (ditherMode==="bayer") bayerInPlace(final, dstBuf, drawW, drawH, nchars);
    else floydInPlace(final, dstBuf, drawW, drawH, nchars);
    final = dstBuf;
  }

  // Step 5: Char index mapping into _idx_buf
  for (let i = 0; i < N; i++) {
    const lum = clamp(final[i]);
    if (threshold>0) {
      const isLight = lum>=threshold;
      _idx_buf[i] = invert ? (isLight?0:nchars-1) : (isLight?nchars-1:0);
    } else {
      _idx_buf[i] = clamp(invert ? Math.floor((1-lum/255)*(nchars-1)) : Math.floor((lum/255)*(nchars-1)), 0, nchars-1);
    }
  }

  _lastDrawW=drawW; _lastDrawH=drawH; _lastChars=chars;
  return {drawW,drawH,chars};
}

// ─── Braille (rare mode, keep object-based) ────────────────────────────────────
const BRAILLE_BASE=0x2800, BRAILLE_DOTS=[0x01,0x02,0x04,0x40,0x08,0x10,0x20,0x80];
function buildBrailleFrame(
  gray: Float32Array, rA: Uint8Array, gA: Uint8Array, bA: Uint8Array,
  srcW:number, srcH:number, threshold:number, invert:boolean, color:boolean
): AsciiFrame {
  const th=threshold>0?threshold:128, bW=Math.floor(srcW/2), bH=Math.floor(srcH/4);
  const frame: AsciiFrame=[];
  for (let cy=0;cy<bH;cy++) {
    const row:AsciiCell[]=[];
    for (let cx=0;cx<bW;cx++) {
      let bits=0,tr=0,tg=0,tb=0;
      for (let dy=0;dy<4;dy++) for (let dx=0;dx<2;dx++) {
        const i=clamp(cy*4+dy,0,srcH-1)*srcW+clamp(cx*2+dx,0,srcW-1);
        if (invert?gray[i]<th:gray[i]>=th) bits|=BRAILLE_DOTS[dy*2+dx];
        tr+=rA[i]; tg+=gA[i]; tb+=bA[i];
      }
      row.push({char:String.fromCodePoint(BRAILLE_BASE|bits),charIdx:bits,
        r:color?Math.round(tr/8):0,g:color?Math.round(tg/8):0,b:color?Math.round(tb/8):0});
    }
    frame.push(row);
  }
  return frame;
}

// ─── String renderers (read from shared buffers, no AsciiCell allocation) ──────
function escCh(c: string): string {
  return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c;
}

function buildHtmlFromBuffers(drawW: number, drawH: number, chars: string, opts: AsciiOptions): string {
  const { color, gradientDirs } = opts;
  const rows: string[] = new Array(drawH);

  for (let y=0; y<drawH; y++) {
    const base = y*drawW;
    let row="", spanR=-1, spanG=-1, spanB=-1, spanStr="";

    for (let x=0; x<drawW; x++) {
      const i=base+x;
      // Resolve character
      let ch: string;
      if (gradientDirs && _mag_buf[i]>40) {
        const deg=((_dir_buf[i]*180/Math.PI)+180)%180;
        ch = deg<22.5||deg>=157.5?"-":deg<67.5?"/":deg<112.5?"|":"\\";
      } else {
        ch = chars[_idx_buf[i]]??" ";
      }

      if (ch===" ") {
        // Space — flush accumulated span, emit &nbsp;
        if (spanStr) {
          row += color && spanR>=0
            ? `<span style="color:rgb(${spanR},${spanG},${spanB})">${spanStr}</span>`
            : spanStr;
          spanStr=""; spanR=-1;
        }
        row += "\u00a0";
        continue;
      }

      const out = escCh(ch);
      if (!color) {
        spanStr += out;
      } else {
        const r=_r_buf[i], g=_g_buf[i], b=_b_buf[i];
        if (r!==spanR || g!==spanG || b!==spanB) {
          // Color changed — flush previous span, open new
          if (spanStr) row += `<span style="color:rgb(${spanR},${spanG},${spanB})">${spanStr}</span>`;
          spanR=r; spanG=g; spanB=b; spanStr=out;
        } else {
          spanStr += out;
        }
      }
    }
    // Flush row's trailing span
    if (spanStr) {
      row += color && spanR>=0
        ? `<span style="color:rgb(${spanR},${spanG},${spanB})">${spanStr}</span>`
        : spanStr;
    }
    rows[y]=row;
  }
  return rows.join("\n");
}

function buildTextFromBuffers(drawW: number, drawH: number, chars: string, opts: AsciiOptions): string {
  const { gradientDirs } = opts;
  const rows: string[] = new Array(drawH);
  for (let y=0; y<drawH; y++) {
    let row="";
    for (let x=0; x<drawW; x++) {
      const i=y*drawW+x;
      if (gradientDirs && _mag_buf[i]>40) {
        const deg=((_dir_buf[i]*180/Math.PI)+180)%180;
        row += deg<22.5||deg>=157.5?"-":deg<67.5?"/":deg<112.5?"|":"\\";
      } else { row += chars[_idx_buf[i]]??" "; }
    }
    rows[y]=row;
  }
  return rows.join("\n");
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Fast zero-allocation live render path.
 *  Returns HTML (or text) string for use in pre.innerHTML, plus layout info for caller.
 *  Does NOT allocate AsciiCell objects — use processFrame/snapshotFromBuffers for that. */
export interface RenderResult { html: string; drawW: number; drawH: number; chars: string; }

export function renderToHtml(
  source: AsciiSource, offscreen: HTMLCanvasElement, opts: AsciiOptions,
  mirror=true, crop?: { x:number;y:number;w:number;h:number }
): RenderResult | null {
  if (opts.brailleMode) {
    const f=processFrame(source,offscreen,opts,mirror,crop);
    if (!f) return null;
    const html=frameToHtml(f,opts.color);
    return { html, drawW:_lastDrawW, drawH:_lastDrawH, chars:_lastChars };
  }
  const r=runPipeline(source,offscreen,opts,mirror,crop);
  if (!r) return null;
  return { html:buildHtmlFromBuffers(r.drawW,r.drawH,r.chars,opts), drawW:r.drawW, drawH:r.drawH, chars:r.chars };
}

/** Materialize an AsciiFrame from current shared buffers WITHOUT re-running the pipeline.
 *  Must be called immediately after renderToHtml (same frame). */
export function snapshotFromBuffers(drawW: number, drawH: number, chars: string, opts: AsciiOptions): AsciiFrame {
  const { color, gradientDirs } = opts;
  const frame: AsciiFrame=[];
  for (let y=0;y<drawH;y++) {
    const row:AsciiCell[]=[];
    for (let x=0;x<drawW;x++) {
      const i=y*drawW+x;
      let ch: string;
      if (gradientDirs && _mag_buf[i]>40) {
        const deg=((_dir_buf[i]*180/Math.PI)+180)%180;
        ch = deg<22.5||deg>=157.5?"-":deg<67.5?"/":deg<112.5?"|":"\\";
      } else { ch=chars[_idx_buf[i]]??" "; }
      row.push({char:ch, charIdx:_idx_buf[i], r:color?_r_buf[i]:0, g:color?_g_buf[i]:0, b:color?_b_buf[i]:0});
    }
    frame.push(row);
  }
  return frame;
}

/** Object-based frame (backward-compatible). Used by ImageTab, library, export. */
export function processFrame(
  source: AsciiSource, offscreen: HTMLCanvasElement, opts: AsciiOptions,
  mirror=true, crop?: { x:number;y:number;w:number;h:number }
): AsciiFrame | null {
  const { w:sw, h:sh } = getSourceDimensions(source);
  if (!sw||!sh) return null;

  if (opts.brailleMode) {
    // Braille path: run minimal pipeline then build braille frame
    const srcX=crop?.x??0, srcY=crop?.y??0, srcW=crop?.w??sw, srcH=crop?.h??sh;
    const aspect=srcW/srcH;
    let drawW=opts.asciiW, drawH=Math.round(opts.asciiW/aspect*0.5);
    if (drawH>opts.asciiH){drawH=opts.asciiH;drawW=Math.round(opts.asciiH*aspect/0.5);}
    offscreen.width=drawW; offscreen.height=drawH;
    const ctx=offscreen.getContext("2d",{willReadFrequently:true})!;
    ctx.save();
    if (mirror){ctx.scale(-1,1);ctx.drawImage(source,srcX,srcY,srcW,srcH,-drawW,0,drawW,drawH);}
    else{ctx.drawImage(source,srcX,srcY,srcW,srcH,0,0,drawW,drawH);}
    ctx.restore();
    const px=ctx.getImageData(0,0,drawW,drawH).data, N=drawW*drawH;
    ensureBuffers(N);
    const {brightness,contrast,gamma}=opts;
    for (let i=0;i<N;i++){
      const r=px[i*4],g=px[i*4+1],b=px[i*4+2];
      let lum=0.299*r+0.587*g+0.114*b;
      if (gamma!==1.0) lum=Math.pow(lum/255,1/gamma)*255;
      if (contrast!==100) lum=128+(lum-128)*contrast/100;
      _gray[i]=clamp(lum+brightness); _r_buf[i]=r; _g_buf[i]=g; _b_buf[i]=b;
    }
    return buildBrailleFrame(_gray,_r_buf,_g_buf,_b_buf,drawW,drawH,opts.threshold,opts.invert,opts.color);
  }

  const r=runPipeline(source,offscreen,opts,mirror,crop);
  if (!r) return null;
  return snapshotFromBuffers(r.drawW,r.drawH,r.chars,opts);
}

export function frameToHtml(frame: AsciiFrame, color: boolean): string {
  const esc=(s:string)=>s==="&"?"&amp;":s==="<"?"&lt;":s===">"?"&gt;":s;
  if (!color) return frame.map(row=>row.map(c=>c.char===" "?"\u00a0":esc(c.char)).join("")).join("\n");
  // Grouped color spans
  return frame.map(row=>{
    let line="", spanR=-1, spanG=-1, spanB=-1, spanStr="";
    for (const c of row) {
      if (c.char===" ") {
        if (spanStr) { line+=`<span style="color:rgb(${spanR},${spanG},${spanB})">${spanStr}</span>`; spanStr=""; spanR=-1; }
        line+="\u00a0"; continue;
      }
      const out=esc(c.char);
      if (c.r!==spanR||c.g!==spanG||c.b!==spanB) {
        if (spanStr) line+=`<span style="color:rgb(${spanR},${spanG},${spanB})">${spanStr}</span>`;
        spanR=c.r; spanG=c.g; spanB=c.b; spanStr=out;
      } else spanStr+=out;
    }
    if (spanStr) line+=`<span style="color:rgb(${spanR},${spanG},${spanB})">${spanStr}</span>`;
    return line;
  }).join("\n");
}

export function frameToText(frame: AsciiFrame): string {
  return frame.map(row=>row.map(c=>c.char).join("")).join("\n");
}
