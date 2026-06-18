export const DEFAULT_CHARSET = " .:-=+*#%@";

export interface AsciiOptions {
  asciiW: number;
  asciiH: number;
  brightness: number;
  contrast: number;
  threshold: number;
  gamma: number;
  invert: boolean;
  color: boolean;
  edges: boolean;
  gradientDirs: boolean;
  dither: boolean;
  ditherMode: "floyd" | "bayer";
  noiseReduction: boolean;
  localContrast: boolean;
  histEq: boolean;
  charset: string;
  brailleMode: boolean;
  blockMode: boolean;
  temporalSmoothing: boolean;
}

export const DEFAULT_OPTIONS: AsciiOptions = {
  asciiW: 140,
  asciiH: 80,
  brightness: -30,
  contrast: 180,
  threshold: 0,
  gamma: 1.1,
  invert: false,
  color: false,
  edges: false,
  gradientDirs: false,
  dither: false,
  ditherMode: "floyd",
  noiseReduction: false,
  localContrast: false,
  histEq: false,
  charset: DEFAULT_CHARSET,
  brailleMode: false,
  blockMode: false,
  temporalSmoothing: false,
};

export interface AsciiCell {
  char: string;
  charIdx: number;
  r: number;
  g: number;
  b: number;
}

export type AsciiFrame = AsciiCell[][];
export type AsciiSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

function clamp(v: number, lo = 0, hi = 255): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function getSourceDimensions(source: AsciiSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (source instanceof HTMLCanvasElement) return { w: source.width, h: source.height };
  return { w: source.naturalWidth, h: source.naturalHeight };
}

function gaussianBlur3(gray: Float32Array, w: number, h: number): Float32Array {
  const k = [1/16,2/16,1/16,2/16,4/16,2/16,1/16,2/16,1/16];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++)
          s += gray[clamp(y+ky,0,h-1)*w+clamp(x+kx,0,w-1)] * k[(ky+1)*3+(kx+1)];
      out[y*w+x] = s;
    }
  }
  return out;
}

function sobelGradient(gray: Float32Array, w: number, h: number): { mag: Float32Array; dir: Float32Array } {
  const mag = new Float32Array(w*h), dir = new Float32Array(w*h);
  const Gx = [-1,0,1,-2,0,2,-1,0,1], Gy = [-1,-2,-1,0,0,0,1,2,1];
  for (let y = 1; y < h-1; y++) {
    for (let x = 1; x < w-1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y+ky)*w+(x+kx)], ki = (ky+1)*3+(kx+1);
          gx += Gx[ki]*p; gy += Gy[ki]*p;
        }
      mag[y*w+x] = clamp(Math.abs(gx)+Math.abs(gy));
      dir[y*w+x] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

function bayerDither(gray: Float32Array, w: number, h: number, n: number): Float32Array {
  const M = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  const out = new Float32Array(w*h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y*w+x;
      out[i] = clamp(gray[i] + (M[(y%4)*4+(x%4)]/16*255 - 128) * (1/n) * 2);
    }
  return out;
}

function floydSteinberg(gray: Float32Array, w: number, h: number, n: number): Float32Array {
  const buf = new Float32Array(gray);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const old = buf[y*w+x];
      const qi = clamp(Math.round((old/255)*(n-1)), 0, n-1);
      const nv = (qi/(n-1))*255;
      const err = old - nv;
      buf[y*w+x] = nv;
      const s: [number,number,number][] = [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
      for (const [dx,dy,f] of s) {
        const nx=x+dx, ny=y+dy;
        if (nx>=0 && nx<w && ny<h) buf[ny*w+nx] += err*f;
      }
    }
  }
  return buf;
}

function histogramEqualize(gray: Float32Array): Float32Array {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[Math.round(clamp(v))]++;
  const cdf = new Float32Array(256);
  cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i-1] + hist[i];
  const cdfMin = cdf.find(v => v > 0) ?? 0;
  const total = gray.length;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++)
    out[i] = Math.round(((cdf[Math.round(clamp(gray[i]))] - cdfMin) / (total - cdfMin)) * 255);
  return out;
}

function localContrastEnhance(gray: Float32Array, w: number, h: number): Float32Array {
  const blurred = gaussianBlur3(gray, w, h);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = clamp(gray[i] + (gray[i] - blurred[i]) * 1.5);
  return out;
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x01,0x02,0x04,0x40,0x08,0x10,0x20,0x80];

function buildBrailleFrame(
  gray: Float32Array, rArr: Uint8Array, gArr: Uint8Array, bArr: Uint8Array,
  srcW: number, srcH: number, threshold: number, invert: boolean, color: boolean
): AsciiFrame {
  const th = threshold > 0 ? threshold : 128;
  const bW = Math.floor(srcW / 2);
  const bH = Math.floor(srcH / 4);
  const frame: AsciiFrame = [];
  for (let cy = 0; cy < bH; cy++) {
    const row: AsciiCell[] = [];
    for (let cx = 0; cx < bW; cx++) {
      let bits = 0, tr = 0, tg = 0, tb = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = cx*2+dx, py = cy*4+dy;
          const i = clamp(py,0,srcH-1)*srcW + clamp(px,0,srcW-1);
          const lum = gray[i] ?? 0;
          if (invert ? lum < th : lum >= th) bits |= BRAILLE_DOTS[dy*2+dx];
          tr += rArr[i] ?? 0; tg += gArr[i] ?? 0; tb += bArr[i] ?? 0;
        }
      }
      row.push({
        char: String.fromCodePoint(BRAILLE_BASE | bits),
        charIdx: bits,
        r: color ? Math.round(tr/8) : 0,
        g: color ? Math.round(tg/8) : 0,
        b: color ? Math.round(tb/8) : 0,
      });
    }
    frame.push(row);
  }
  return frame;
}

const densityCache = new Map<string, string>();

export function sortCharsetByDensity(charset: string): string {
  if (densityCache.has(charset)) return densityCache.get(charset)!;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 10; canvas.height = 14;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "10px monospace";
    ctx.fillStyle = "white";
    const measured = Array.from(new Set(charset)).map(ch => {
      ctx.clearRect(0, 0, 10, 14);
      ctx.fillText(ch, 0, 11);
      const data = ctx.getImageData(0, 0, 10, 14).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i];
      return { ch, density: sum };
    });
    measured.sort((a, b) => a.density - b.density);
    const sorted = measured.map(m => m.ch).join("");
    densityCache.set(charset, sorted);
    return sorted;
  } catch {
    densityCache.set(charset, charset);
    return charset;
  }
}

let smoothed: Float32Array | null = null;

export function resetTemporalSmoothing(): void { smoothed = null; }

function applyTemporalSmooth(gray: Float32Array, alpha = 0.4): Float32Array {
  if (!smoothed || smoothed.length !== gray.length) { smoothed = new Float32Array(gray); return smoothed; }
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = smoothed[i]*(1-alpha) + gray[i]*alpha;
  smoothed = out;
  return out;
}

export function processFrame(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror = true,
  crop?: { x: number; y: number; w: number; h: number }
): AsciiFrame | null {
  const { w: sw, h: sh } = getSourceDimensions(source);
  if (!sw || !sh) return null;

  const { asciiW, asciiH, brightness, contrast, threshold, gamma, invert, color,
    edges, gradientDirs, dither, ditherMode, noiseReduction, localContrast, histEq,
    charset, brailleMode, blockMode, temporalSmoothing } = opts;

  const srcX = crop ? crop.x : 0;
  const srcY = crop ? crop.y : 0;
  const srcW = crop ? crop.w : sw;
  const srcH = crop ? crop.h : sh;

  const aspect = srcW / srcH;
  const charAspect = 0.5;
  let drawW = asciiW;
  let drawH = Math.round(asciiW / aspect * charAspect);
  if (drawH > asciiH) { drawH = asciiH; drawW = Math.round(asciiH * aspect / charAspect); }

  offscreen.width = drawW;
  offscreen.height = drawH;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true })!;
  ctx.save();
  if (mirror) {
    ctx.scale(-1, 1);
    ctx.drawImage(source, srcX, srcY, srcW, srcH, -drawW, 0, drawW, drawH);
  } else {
    ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, drawW, drawH);
  }
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, drawW, drawH);
  const px = imgData.data;
  const N = drawW * drawH;
  const gray = new Float32Array(N);
  const rArr = new Uint8Array(N), gArr = new Uint8Array(N), bArr = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const r = px[i*4], g = px[i*4+1], b = px[i*4+2];
    let lum = 0.299*r + 0.587*g + 0.114*b;
    if (gamma !== 1.0) lum = Math.pow(lum/255, 1/gamma)*255;
    if (contrast !== 100) lum = 128 + (lum-128)*contrast/100;
    lum += brightness;
    gray[i] = clamp(lum);
    rArr[i] = r; gArr[i] = g; bArr[i] = b;
  }

  if (brailleMode) return buildBrailleFrame(gray, rArr, gArr, bArr, drawW, drawH, threshold, invert, color);

  let proc: Float32Array = gray;
  if (noiseReduction) proc = gaussianBlur3(proc, drawW, drawH);
  if (histEq) proc = histogramEqualize(proc);
  if (localContrast) proc = localContrastEnhance(proc, drawW, drawH);
  if (temporalSmoothing) proc = applyTemporalSmooth(proc);

  const chars = sortCharsetByDensity(charset || DEFAULT_CHARSET);
  const nchars = chars.length;

  if (blockMode) {
    const blocks = " \u2591\u2592\u2593\u2588";
    const nb = blocks.length;
    const frame: AsciiFrame = [];
    for (let y = 0; y < drawH; y++) {
      const row: AsciiCell[] = [];
      for (let x = 0; x < drawW; x++) {
        const i = y*drawW+x;
        const idx = Math.min(Math.floor(clamp(proc[i])/256*nb), nb-1);
        row.push({ char: blocks[idx], charIdx: idx, r: color?rArr[i]:0, g: color?gArr[i]:0, b: color?bArr[i]:0 });
      }
      frame.push(row);
    }
    return frame;
  }

  const needGrad = edges || gradientDirs;
  const { mag, dir } = needGrad ? sobelGradient(proc, drawW, drawH) : { mag: proc, dir: new Float32Array(N) };
  let final = edges ? mag : proc;
  if (dither) final = ditherMode === "bayer" ? bayerDither(final, drawW, drawH, nchars) : floydSteinberg(final, drawW, drawH, nchars);

  const frame: AsciiFrame = [];
  for (let y = 0; y < drawH; y++) {
    const row: AsciiCell[] = [];
    for (let x = 0; x < drawW; x++) {
      const i = y*drawW+x;
      const lum = clamp(final[i]);
      let charIdx: number, charOut: string;
      if (gradientDirs && mag[i] > 40) {
        const deg = ((dir[i]*180/Math.PI)+180)%180;
        charOut = deg<22.5||deg>=157.5 ? "-" : deg<67.5 ? "/" : deg<112.5 ? "|" : "\\";
        charIdx = Math.floor(lum/255*(nchars-1));
      } else if (threshold > 0) {
        const isLight = lum >= threshold;
        charIdx = invert ? (isLight?0:nchars-1) : (isLight?nchars-1:0);
        charOut = chars[charIdx];
      } else {
        charIdx = clamp(invert ? Math.floor((1-lum/255)*(nchars-1)) : Math.floor((lum/255)*(nchars-1)), 0, nchars-1);
        charOut = chars[charIdx];
      }
      row.push({ char: charOut!, charIdx, r: color?rArr[i]:0, g: color?gArr[i]:0, b: color?bArr[i]:0 });
    }
    frame.push(row);
  }
  return frame;
}

export function frameToHtml(frame: AsciiFrame, color: boolean): string {
  const esc = (s: string) => s==="&"?"&amp;":s==="<"?"&lt;":s===">"?"&gt;":s;
  if (!color) return frame.map(row => row.map(c => c.char===" " ? "\u00a0" : esc(c.char)).join("")).join("\n");
  return frame.map(row => {
    let line = "";
    for (const c of row) {
      if (c.char===" ") line += "\u00a0";
      else line += `<span style="color:rgb(${c.r},${c.g},${c.b})">${esc(c.char)}</span>`;
    }
    return line;
  }).join("\n");
}

export function frameToText(frame: AsciiFrame): string {
  return frame.map(row => row.map(c => c.char).join("")).join("\n");
}
