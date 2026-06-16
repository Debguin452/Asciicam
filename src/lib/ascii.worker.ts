import { DEFAULT_CHARSET, getSortedCharset, type AsciiOptions } from "./ascii";

let prevSmoothed: Float32Array | null = null;

function clamp(v: number, lo = 0, hi = 255) { return v < lo ? lo : v > hi ? hi : v; }

function sobelGradient(g: Float32Array, w: number, h: number) {
  const mag = new Float32Array(w * h), dir = new Float32Array(w * h);
  const Gx = [-1,0,1,-2,0,2,-1,0,1], Gy = [-1,-2,-1,0,0,0,1,2,1];
  for (let y = 1; y < h-1; y++) for (let x = 1; x < w-1; x++) {
    let gx = 0, gy = 0;
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
      const p = g[(y+ky)*w+(x+kx)], ki = (ky+1)*3+(kx+1);
      gx += Gx[ki]*p; gy += Gy[ki]*p;
    }
    mag[y*w+x] = clamp(Math.abs(gx)+Math.abs(gy));
    dir[y*w+x] = Math.atan2(gy, gx);
  }
  return { mag, dir };
}

function gaussBlur(g: Float32Array, w: number, h: number) {
  const k = [1/16,2/16,1/16,2/16,4/16,2/16,1/16,2/16,1/16];
  const out = new Float32Array(w*h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
      s += g[clamp(y+ky,0,h-1)*w+clamp(x+kx,0,w-1)] * k[(ky+1)*3+(kx+1)];
    }
    out[y*w+x] = s;
  }
  return out;
}

function histEq(g: Float32Array) {
  const hist = new Uint32Array(256);
  for (const v of g) hist[Math.round(clamp(v))]++;
  const cdf = new Float32Array(256); cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i-1] + hist[i];
  const cmin = cdf.find(v => v > 0) ?? 0, total = g.length;
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.round(((cdf[Math.round(clamp(g[i]))]-cmin)/(total-cmin))*255);
  return out;
}

function floyd(g: Float32Array, w: number, h: number, n: number) {
  const buf = new Float32Array(g);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const old = buf[y*w+x], qi = clamp(Math.round((old/255)*(n-1)),0,n-1);
    const nv = (qi/(n-1))*255, err = old-nv; buf[y*w+x] = nv;
    const s: [number,number,number][] = [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
    for (const [dx,dy,f] of s) { const nx=x+dx,ny=y+dy; if (nx>=0&&nx<w&&ny<h) buf[ny*w+nx]+=err*f; }
  }
  return buf;
}

function bayer(g: Float32Array, w: number, h: number, n: number) {
  const M = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  const out = new Float32Array(w*h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y*w+x, t = (M[(y%4)*4+(x%4)]/16)*255;
    out[i] = clamp(g[i]+(t-128)*(1/n)*2);
  }
  return out;
}

function localContrast(g: Float32Array, w: number, h: number) {
  const b = gaussBlur(g, w, h), out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = clamp(g[i]+(g[i]-b[i])*1.5);
  return out;
}

function temporalSmooth(g: Float32Array, alpha = 0.4) {
  if (!prevSmoothed || prevSmoothed.length !== g.length) { prevSmoothed = new Float32Array(g); return prevSmoothed; }
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = prevSmoothed[i]*(1-alpha)+g[i]*alpha;
  prevSmoothed = out; return out;
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x01,0x02,0x04,0x40,0x08,0x10,0x20,0x80];

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data as { type: string; data: { pixels: Uint8ClampedArray; opts: AsciiOptions } };

  if (type === "reset") { prevSmoothed = null; return; }
  if (type !== "frame") return;

  const { pixels: px, opts } = data;
  const {
    asciiW: w, asciiH: h, brightness, contrast, threshold,
    gamma, invert, color, edges, gradientDirs, dither, ditherMode,
    noiseReduction, localContrast: lc, histEq: he,
    charset, charDensitySort, brailleMode, blockMode, temporalSmoothing,
  } = opts;

  const N = w * h;
  const gray = new Float32Array(N);
  const rArr = new Uint8Array(N), gArr = new Uint8Array(N), bArr = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const r = px[i*4], g = px[i*4+1], b = px[i*4+2];
    let lum = 0.299*r + 0.587*g + 0.114*b;
    if (gamma !== 1.0) lum = Math.pow(lum/255, 1/gamma)*255;
    if (contrast !== 100) lum = 128+(lum-128)*contrast/100;
    lum += brightness;
    gray[i] = clamp(lum);
    rArr[i] = r; gArr[i] = g; bArr[i] = b;
  }

  const chars = getSortedCharset(charset || DEFAULT_CHARSET, charDensitySort);
  const nchars = chars.length;

  if (brailleMode) {
    const th = threshold > 0 ? threshold : 128;
    const rows: string[][] = [];
    const htmlLines: string[] = [];
    for (let cy = 0; cy < h; cy++) {
      const row: string[] = [];
      let line = "";
      for (let cx = 0; cx < w; cx++) {
        let bits = 0, tr=0,tg=0,tb=0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
          const px2 = clamp(cx*2+dx,0,w*2-1), py2 = clamp(cy*4+dy,0,h*4-1);
          const ii = Math.min(py2*w*2+px2, gray.length-1);
          if (invert ? gray[ii]<th : gray[ii]>=th) bits |= BRAILLE_DOTS[dy*2+dx];
          tr+=rArr[Math.min(ii,rArr.length-1)]; tg+=gArr[Math.min(ii,gArr.length-1)]; tb+=bArr[Math.min(ii,bArr.length-1)];
        }
        const ch = String.fromCodePoint(BRAILLE_BASE|bits);
        row.push(ch);
        if (color) line += `<span style="color:rgb(${Math.round(tr/8)},${Math.round(tg/8)},${Math.round(tb/8)})">${ch}</span>`;
        else line += ch;
      }
      rows.push(row); htmlLines.push(line);
    }
    self.postMessage({ type: "result", html: htmlLines.join("\n"), indices: rows.map(r=>r.map(()=>0)) });
    return;
  }

  let proc: Float32Array = gray;
  if (noiseReduction) proc = gaussBlur(proc, w, h);
  if (he) proc = histEq(proc);
  if (lc) proc = localContrast(proc, w, h);
  if (temporalSmoothing) proc = temporalSmooth(proc);

  if (blockMode) {
    const blocks = " \u2591\u2592\u2593\u2588", nb = blocks.length;
    const lines: string[] = [];
    const indices: number[][] = [];
    for (let y = 0; y < h; y++) {
      let line = ""; const row: number[] = [];
      for (let x = 0; x < w; x++) {
        const i = y*w+x, idx = Math.min(Math.floor((clamp(proc[i])/256)*nb), nb-1);
        const ch = blocks[idx];
        row.push(idx);
        if (color) line += `<span style="color:rgb(${rArr[i]},${gArr[i]},${bArr[i]})">${ch}</span>`;
        else line += ch === " " ? "\u00a0" : ch;
      }
      lines.push(line); indices.push(row);
    }
    self.postMessage({ type: "result", html: lines.join("\n"), indices });
    return;
  }

  const needGrad = edges || gradientDirs;
  const { mag, dir } = needGrad ? sobelGradient(proc, w, h) : { mag: proc, dir: new Float32Array(N) };
  let final: Float32Array = edges ? mag : proc;
  if (dither) final = ditherMode === "bayer" ? bayer(final,w,h,nchars) : floyd(final,w,h,nchars);

  const htmlLines: string[] = [];
  const indices: number[][] = [];

  for (let y = 0; y < h; y++) {
    let line = ""; const row: number[] = [];
    for (let x = 0; x < w; x++) {
      const i = y*w+x;
      const lum = clamp(final[i]);
      let charIdx: number, charOut: string;

      if (gradientDirs && mag[i] > 40) {
        const deg = ((dir[i]*180/Math.PI)+180)%180;
        if (deg < 22.5 || deg >= 157.5) charOut = "-";
        else if (deg < 67.5) charOut = "/";
        else if (deg < 112.5) charOut = "|";
        else charOut = "\\";
        charIdx = Math.floor(lum/255*(nchars-1));
      } else if (threshold > 0) {
        const isLight = lum >= threshold;
        charIdx = invert ? (isLight?0:nchars-1) : (isLight?nchars-1:0);
        charOut = chars[charIdx];
      } else {
        charIdx = clamp(invert ? Math.floor((1-lum/255)*(nchars-1)) : Math.floor((lum/255)*(nchars-1)), 0, nchars-1);
        charOut = chars[charIdx];
      }

      row.push(charIdx);
      const out = charOut === " " ? "\u00a0" : charOut;
      if (color) line += `<span style="color:rgb(${rArr[i]},${gArr[i]},${bArr[i]})">${out}</span>`;
      else line += out;
    }
    htmlLines.push(line); indices.push(row);
  }

  self.postMessage({ type: "result", html: htmlLines.join("\n"), indices });
};
