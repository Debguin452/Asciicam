import { sortCharsetByDensity, DEFAULT_CHARSET, type AsciiOptions } from "./ascii";

let prevSmoothed: Float32Array | null = null;

// ── Inline clamp (no function call overhead in hot path) ─────────────────────
function clamp(v: number, lo = 0, hi = 255) { return v < lo ? lo : v > hi ? hi : v; }

// ── Precomputed 256-entry char lookup table ───────────────────────────────────
function buildCharTable(nchars: number, invert: boolean): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const idx = invert
      ? Math.floor((1 - i / 255) * (nchars - 1))
      : Math.floor((i / 255) * (nchars - 1));
    t[i] = idx < 0 ? 0 : idx >= nchars ? nchars - 1 : idx;
  }
  return t;
}

// ── RGB string cache (avoids repeated template literal allocation) ─────────────
const rgbCache = new Map<number, string>();
function rgbStr(r: number, g: number, b: number): string {
  const key = (r << 16) | (g << 8) | b;
  let s = rgbCache.get(key);
  if (!s) { s = `rgb(${r},${g},${b})`; if (rgbCache.size < 32768) rgbCache.set(key, s); }
  return s;
}

function gaussBlur(g: Float32Array, w: number, h: number): Float32Array {
  const k = [1/16,2/16,1/16,2/16,4/16,2/16,1/16,2/16,1/16];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++)
          s += g[clamp(y+ky,0,h-1)*w+clamp(x+kx,0,w-1)] * k[(ky+1)*3+(kx+1)];
      out[y*w+x] = s;
    }
  return out;
}

function sobelGradient(g: Float32Array, w: number, h: number) {
  const mag = new Float32Array(w*h), dir = new Float32Array(w*h);
  const Gx = [-1,0,1,-2,0,2,-1,0,1], Gy = [-1,-2,-1,0,0,0,1,2,1];
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const p = g[(y+ky)*w+(x+kx)], ki = (ky+1)*3+(kx+1);
          gx += Gx[ki]*p; gy += Gy[ki]*p;
        }
      mag[y*w+x] = clamp(Math.abs(gx)+Math.abs(gy));
      dir[y*w+x] = Math.atan2(gy, gx);
    }
  return { mag, dir };
}

function histEq(g: Float32Array): Float32Array {
  const hist = new Uint32Array(256);
  for (const v of g) hist[Math.round(clamp(v))]++;
  const cdf = new Float32Array(256); cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i-1] + hist[i];
  const cmin = cdf.find(v => v > 0) ?? 0, total = g.length;
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++)
    out[i] = Math.round(((cdf[Math.round(clamp(g[i]))] - cmin) / (total - cmin)) * 255);
  return out;
}

function floyd(g: Float32Array, w: number, h: number, n: number): Float32Array {
  const buf = new Float32Array(g);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const old = buf[y*w+x], qi = clamp(Math.round((old/255)*(n-1)), 0, n-1);
      const nv = (qi/(n-1))*255, err = old-nv; buf[y*w+x] = nv;
      for (const [dx,dy,f] of [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]] as [number,number,number][]) {
        const nx=x+dx, ny=y+dy;
        if (nx>=0 && nx<w && ny<h) buf[ny*w+nx] += err*f;
      }
    }
  return buf;
}

function bayer(g: Float32Array, w: number, h: number, n: number): Float32Array {
  const M = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  const out = new Float32Array(w*h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y*w+x, t = (M[(y%4)*4+(x%4)]/16)*255;
      out[i] = clamp(g[i]+(t-128)*(1/n)*2);
    }
  return out;
}

function localContrast(g: Float32Array, w: number, h: number): Float32Array {
  const bl = gaussBlur(g, w, h), out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = clamp(g[i]+(g[i]-bl[i])*1.5);
  return out;
}

function temporalSmooth(g: Float32Array, alpha = 0.4): Float32Array {
  if (!prevSmoothed || prevSmoothed.length !== g.length) { prevSmoothed = new Float32Array(g); return prevSmoothed; }
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = prevSmoothed[i]*(1-alpha)+g[i]*alpha;
  prevSmoothed = out; return out;
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x01,0x02,0x04,0x40,0x08,0x10,0x20,0x80];

// ── Color-run batching for HTML output ────────────────────────────────────────
function buildColorHtml(
  lines: string[], w: number, h: number,
  charOut: string[], rArr: Uint8Array, gArr: Uint8Array, bArr: Uint8Array
): void {
  for (let y = 0; y < h; y++) {
    const parts: string[] = [];
    let runR = -1, runG = -1, runB = -1, runText = "";

    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ch = charOut[i];
      const cr = rArr[i], cg = gArr[i], cb = bArr[i];
      if (cr === runR && cg === runG && cb === runB) {
        runText += ch;
      } else {
        if (runText) parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`);
        runR = cr; runG = cg; runB = cb;
        runText = ch;
      }
    }
    if (runText) parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`);
    lines.push(parts.join(""));
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data as {
    type: string;
    data: { pixels: Uint8ClampedArray; pixW: number; pixH: number; opts: AsciiOptions; fastMode?: boolean };
  };

  if (type === "reset") { prevSmoothed = null; return; }
  if (type !== "frame") return;

  const { pixels: px, pixW, pixH, opts, fastMode = false } = data;
  const { asciiW: rawW, asciiH: rawH, brightness, contrast, threshold, gamma,
    invert, color, edges, gradientDirs, dither, ditherMode,
    noiseReduction, localContrast: lc, histEq: he,
    charset, brailleMode, blockMode, temporalSmoothing } = opts;

  // Resolution cap
  const MAX_COLS = 160, MAX_ROWS = 90;
  const asciiW = rawW > MAX_COLS ? MAX_COLS : rawW;
  const asciiH = rawH > MAX_ROWS ? MAX_ROWS : rawH;

  const N = pixW * pixH;
  const gray = new Float32Array(N);
  const rArr = new Uint8Array(N), gArr = new Uint8Array(N), bArr = new Uint8Array(N);

  // Optimized pixel loop with branch hoisting
  if (gamma !== 1.0) {
    const invGamma = 1 / gamma;
    for (let i = 0, pi = 0; i < N; i++, pi += 4) {
      const r = px[pi], g = px[pi+1], b = px[pi+2];
      let lum = Math.pow((0.299*r + 0.587*g + 0.114*b) / 255, invGamma) * 255;
      if (contrast !== 100) lum = 128 + (lum - 128) * contrast / 100;
      lum += brightness;
      gray[i] = lum < 0 ? 0 : lum > 255 ? 255 : lum;
      rArr[i] = r; gArr[i] = g; bArr[i] = b;
    }
  } else if (contrast !== 100) {
    const cf = contrast / 100;
    for (let i = 0, pi = 0; i < N; i++, pi += 4) {
      const r = px[pi], g = px[pi+1], b = px[pi+2];
      let lum = 128 + (0.299*r + 0.587*g + 0.114*b - 128) * cf + brightness;
      gray[i] = lum < 0 ? 0 : lum > 255 ? 255 : lum;
      rArr[i] = r; gArr[i] = g; bArr[i] = b;
    }
  } else {
    const bf = brightness;
    for (let i = 0, pi = 0; i < N; i++, pi += 4) {
      const r = px[pi], g = px[pi+1], b = px[pi+2];
      let lum = 0.299*r + 0.587*g + 0.114*b + bf;
      gray[i] = lum < 0 ? 0 : lum > 255 ? 255 : lum;
      rArr[i] = r; gArr[i] = g; bArr[i] = b;
    }
  }

  const chars = sortCharsetByDensity(charset || DEFAULT_CHARSET);
  const nchars = chars.length;
  const charTable = buildCharTable(nchars, invert);

  // ── Braille mode ─────────────────────────────────────────────────────────
  if (brailleMode) {
    const bW = Math.floor(pixW/2), bH = Math.floor(pixH/4);
    const th = threshold > 0 ? threshold : 128;
    const htmlLines: string[] = [];
    const charOut: string[] = new Array(bW * bH);
    const outR = new Uint8Array(bW * bH), outG = new Uint8Array(bW * bH), outB = new Uint8Array(bW * bH);

    for (let cy = 0; cy < bH; cy++) {
      for (let cx = 0; cx < bW; cx++) {
        let bits = 0, tr = 0, tg = 0, tb = 0;
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const px2 = Math.min(cx*2+dx, pixW-1), py2 = Math.min(cy*4+dy, pixH-1);
            const ii = py2*pixW+px2;
            if (invert ? gray[ii] < th : gray[ii] >= th) bits |= BRAILLE_DOTS[dy*2+dx];
            tr += rArr[ii]; tg += gArr[ii]; tb += bArr[ii];
          }
        const oi = cy * bW + cx;
        charOut[oi] = String.fromCodePoint(BRAILLE_BASE | bits);
        if (color) { outR[oi] = Math.round(tr/8); outG[oi] = Math.round(tg/8); outB[oi] = Math.round(tb/8); }
      }
    }

    const indices: number[][] = [];
    if (color) {
      buildColorHtml(htmlLines, bW, bH, charOut, outR, outG, outB);
    } else {
      for (let y = 0; y < bH; y++) {
        let line = "";
        for (let x = 0; x < bW; x++) line += charOut[y * bW + x];
        htmlLines.push(line);
      }
    }
    for (let y = 0; y < bH; y++) {
      const row: number[] = [];
      for (let x = 0; x < bW; x++) row.push(y * bW + x);
      indices.push(row);
    }
    self.postMessage({ type: "result", html: htmlLines.join("\n"), indices, outW: bW, outH: bH });
    return;
  }

  // ── Standard / block mode ─────────────────────────────────────────────────
  let proc: Float32Array = gray;
  if (!fastMode) {
    if (noiseReduction) proc = gaussBlur(proc, pixW, pixH);
    if (he) proc = histEq(proc);
    if (lc) proc = localContrast(proc, pixW, pixH);
  }
  if (temporalSmoothing) proc = temporalSmooth(proc);

  if (blockMode) {
    const blocks = " \u2591\u2592\u2593\u2588", nb = blocks.length;
    const cellCount = asciiW * asciiH;
    const charOut: string[] = new Array(cellCount);
    const outR = new Uint8Array(cellCount), outG = new Uint8Array(cellCount), outB = new Uint8Array(cellCount);
    const indices: number[][] = [];

    for (let y = 0; y < asciiH; y++) {
      const row: number[] = [];
      for (let x = 0; x < asciiW; x++) {
        const i = y*pixW+x, oi = y*asciiW+x;
        const v = proc[i]; const idx = Math.min(Math.floor((v < 0 ? 0 : v > 255 ? 255 : v) / 256 * nb), nb - 1);
        charOut[oi] = blocks[idx] === " " ? "\u00a0" : blocks[idx];
        if (color) { outR[oi] = rArr[i]; outG[oi] = gArr[i]; outB[oi] = bArr[i]; }
        row.push(idx);
      }
      indices.push(row);
    }

    const htmlLines: string[] = [];
    if (color) {
      buildColorHtml(htmlLines, asciiW, asciiH, charOut, outR, outG, outB);
    } else {
      for (let y = 0; y < asciiH; y++) {
        let line = "";
        for (let x = 0; x < asciiW; x++) line += charOut[y * asciiW + x];
        htmlLines.push(line);
      }
    }
    self.postMessage({ type: "result", html: htmlLines.join("\n"), indices, outW: asciiW, outH: asciiH });
    return;
  }

  // ── Main ASCII path ───────────────────────────────────────────────────────
  const needGrad = edges || gradientDirs;
  const { mag, dir } = needGrad ? sobelGradient(proc, pixW, pixH) : { mag: proc, dir: null as unknown as Float32Array };
  let final: Float32Array = edges ? mag : proc;
  if (dither) final = ditherMode === "bayer" ? bayer(final, pixW, pixH, nchars) : floyd(final, pixW, pixH, nchars);

  const cellCount = asciiW * asciiH;
  const charOut: string[] = new Array(cellCount);
  const outR = new Uint8Array(cellCount), outG = new Uint8Array(cellCount), outB = new Uint8Array(cellCount);
  const indices: number[][] = [];

  for (let y = 0; y < asciiH; y++) {
    const row: number[] = [];
    for (let x = 0; x < asciiW; x++) {
      const i = y*pixW+x, oi = y*asciiW+x;
      const lum = final[i] < 0 ? 0 : final[i] > 255 ? 255 : final[i];
      let charIdx: number, out: string;

      if (gradientDirs && dir && mag[i] > 40) {
        const deg = ((dir[i]*180/Math.PI)+180)%180;
        out = deg<22.5||deg>=157.5 ? "-" : deg<67.5 ? "/" : deg<112.5 ? "|" : "\\";
        charIdx = charTable[lum < 0 ? 0 : lum > 255 ? 255 : lum];
      } else if (threshold > 0) {
        const isLight = lum >= threshold;
        charIdx = invert ? (isLight?0:nchars-1) : (isLight?nchars-1:0);
        out = chars[charIdx];
        if (out === " ") out = "\u00a0";
      } else {
        charIdx = charTable[lum < 0 ? 0 : lum > 255 ? 255 : lum];
        out = chars[charIdx];
        if (out === " ") out = "\u00a0";
        else if (out === "&") out = "&amp;";
        else if (out === "<") out = "&lt;";
        else if (out === ">") out = "&gt;";
      }
      charOut[oi] = out!;
      row.push(charIdx);
      if (color) { outR[oi] = rArr[i]; outG[oi] = gArr[i]; outB[oi] = bArr[i]; }
    }
    indices.push(row);
  }

  const htmlLines: string[] = [];
  if (color) {
    buildColorHtml(htmlLines, asciiW, asciiH, charOut, outR, outG, outB);
  } else {
    for (let y = 0; y < asciiH; y++) {
      const parts: string[] = [];
      for (let x = 0; x < asciiW; x++) parts.push(charOut[y * asciiW + x]);
      htmlLines.push(parts.join(""));
    }
  }

  self.postMessage({ type: "result", html: htmlLines.join("\n"), indices, outW: asciiW, outH: asciiH });
};
