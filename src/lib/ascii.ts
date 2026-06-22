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

// ── Flat typed-array frame (replaces AsciiCell[][] — zero object allocation) ──
export interface AsciiFrame {
  width: number;
  height: number;
  chars: Uint8Array;      // char indices into sorted charset
  r: Uint8Array;          // 0 when color=false
  g: Uint8Array;
  b: Uint8Array;
  gradDirs: Uint8Array | null; // direction chars as codepoints when gradientDirs=true
  braille: Uint16Array | null; // braille codepoint offsets
  charset: string;
  isBraille: boolean;
  isColor: boolean;
}

// Legacy cell type — kept for export pipeline compatibility
export interface AsciiCell {
  char: string;
  charIdx: number;
  r: number;
  g: number;
  b: number;
}

// Convert new flat frame to legacy format (used only by export functions)
export function frameToCells(frame: AsciiFrame): AsciiCell[][] {
  const { width, height, chars, r, g, b, charset, isBraille, braille } = frame;
  const rows: AsciiCell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: AsciiCell[] = [];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let char: string;
      if (isBraille && braille) {
        char = String.fromCodePoint(0x2800 | braille[i]);
      } else {
        char = charset[chars[i]] ?? " ";
      }
      row.push({ char, charIdx: chars[i], r: r[i], g: g[i], b: b[i] });
    }
    rows.push(row);
  }
  return rows;
}

export type AsciiSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

// ── Renderer abstraction (prepared for future CanvasRenderer) ──────────────
export interface Renderer {
  render(frame: AsciiFrame, target: HTMLPreElement): void;
}

export class DOMRenderer implements Renderer {
  render(frame: AsciiFrame, target: HTMLPreElement): void {
    if (frame.isColor) {
      target.innerHTML = frameToHtml(frame);
    } else {
      target.textContent = frameToText(frame);
    }
  }
}

// Singleton — reuse across renders
export const domRenderer = new DOMRenderer();

// ── Lookup table cache ──────────────────────────────────────────────────────
const charTableCache = new Map<string, Uint8Array>();

function getCharTable(charset: string, invert: boolean, nchars: number): Uint8Array {
  const key = charset + (invert ? "~" : "");
  let t = charTableCache.get(key);
  if (t) return t;
  t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const idx = invert
      ? Math.floor((1 - i / 255) * (nchars - 1))
      : Math.floor((i / 255) * (nchars - 1));
    t[i] = idx < 0 ? 0 : idx >= nchars ? nchars - 1 : idx;
  }
  charTableCache.set(key, t);
  return t;
}

// ── RGB-string palette cache ────────────────────────────────────────────────
const rgbStringCache = new Map<number, string>();

export function rgbStr(r: number, g: number, b: number): string {
  const key = (r << 16) | (g << 8) | b;
  let s = rgbStringCache.get(key);
  if (s) return s;
  s = `rgb(${r},${g},${b})`;
  if (rgbStringCache.size < 32768) rgbStringCache.set(key, s);
  return s;
}

// ── Resolution caps ─────────────────────────────────────────────────────────
const IS_MOBILE = typeof window !== "undefined" && window.innerWidth <= 720;
export const MAX_COLS = IS_MOBILE ? 120 : 160;
export const MAX_ROWS = IS_MOBILE ? 70 : 90;

export function clampDimensions(cols: number, rows: number): [number, number] {
  return [Math.min(cols, MAX_COLS), Math.min(rows, MAX_ROWS)];
}

// ── Utility ─────────────────────────────────────────────────────────────────
function clamp(v: number, lo = 0, hi = 255): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function getSourceDimensions(source: AsciiSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  if (source instanceof HTMLCanvasElement) return { w: source.width, h: source.height };
  return { w: source.naturalWidth, h: source.naturalHeight };
}

// ── Image processing helpers ─────────────────────────────────────────────────
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
  srcW: number, srcH: number, threshold: number, invert: boolean, color: boolean,
  charset: string
): AsciiFrame {
  const th = threshold > 0 ? threshold : 128;
  const bW = Math.floor(srcW / 2);
  const bH = Math.floor(srcH / 4);
  const N = bW * bH;
  const braille = new Uint16Array(N);
  const outR = new Uint8Array(N), outG = new Uint8Array(N), outB = new Uint8Array(N);

  for (let cy = 0; cy < bH; cy++) {
    for (let cx = 0; cx < bW; cx++) {
      let bits = 0, tr = 0, tg = 0, tb = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(cx*2+dx, srcW-1), py = Math.min(cy*4+dy, srcH-1);
          const ii = py*srcW+px;
          const lum = gray[ii] ?? 0;
          if (invert ? lum < th : lum >= th) bits |= BRAILLE_DOTS[dy*2+dx];
          tr += rArr[ii]; tg += gArr[ii]; tb += bArr[ii];
        }
      }
      const oi = cy*bW+cx;
      braille[oi] = bits;
      if (color) { outR[oi] = Math.round(tr/8); outG[oi] = Math.round(tg/8); outB[oi] = Math.round(tb/8); }
    }
  }
  return {
    width: bW, height: bH,
    chars: new Uint8Array(N), r: outR, g: outG, b: outB,
    gradDirs: null, braille, charset, isBraille: true, isColor: color,
  };
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

// ── Performance metrics (dev only) ──────────────────────────────────────────
declare global {
  interface Window {
    __asciiPerf?: { processMs: number; domMs: number; cells: number };
  }
}
const IS_DEV = import.meta.env?.DEV === true;

// ── Main entry point ─────────────────────────────────────────────────────────
export function processFrame(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror = true,
  crop?: { x: number; y: number; w: number; h: number },
  fastMode = false
): AsciiFrame | null {
  const t0 = IS_DEV ? performance.now() : 0;

  const { w: sw, h: sh } = getSourceDimensions(source);
  if (!sw || !sh) return null;

  const { asciiW: rawW, asciiH: rawH, brightness, contrast, threshold, gamma, invert, color,
    edges, gradientDirs, dither, ditherMode, noiseReduction, localContrast, histEq,
    charset, brailleMode, blockMode, temporalSmoothing } = opts;

  // Apply resolution cap
  const [asciiW, asciiH] = clampDimensions(rawW, rawH);

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

  // Optimized pixel loop — three branches to avoid per-pixel conditionals
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
    const bf = brightness;
    for (let i = 0, pi = 0; i < N; i++, pi += 4) {
      const r = px[pi], g = px[pi+1], b = px[pi+2];
      let lum = 128 + (0.299*r + 0.587*g + 0.114*b - 128) * cf + bf;
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

  if (brailleMode) {
    const frame = buildBrailleFrame(gray, rArr, gArr, bArr, drawW, drawH, threshold, invert, color, charset);
    if (IS_DEV && window.__asciiPerf) window.__asciiPerf.processMs = performance.now() - t0;
    return frame;
  }

  // Fast mode for live video: skip expensive processing passes
  let proc: Float32Array = gray;
  if (!fastMode) {
    if (noiseReduction) proc = gaussianBlur3(proc, drawW, drawH);
    if (histEq) proc = histogramEqualize(proc);
    if (localContrast) proc = localContrastEnhance(proc, drawW, drawH);
  }
  if (temporalSmoothing) proc = applyTemporalSmooth(proc);

  const chars = sortCharsetByDensity(charset || DEFAULT_CHARSET);
  const nchars = chars.length;

  const outChars = new Uint8Array(N);
  const outR = new Uint8Array(N), outG = new Uint8Array(N), outB = new Uint8Array(N);
  let outGradDirs: Uint8Array | null = null;

  if (blockMode) {
    const nb = 5; // " ░▒▓█"
    const blockChars = " \u2591\u2592\u2593\u2588";
    // build a temporary charset mapping for blocks
    const bTable = getCharTable(blockChars, false, nb);
    for (let i = 0; i < N; i++) {
      const idx = Math.min(Math.floor((proc[i] < 0 ? 0 : proc[i] > 255 ? 255 : proc[i]) / 256 * nb), nb - 1);
      outChars[i] = idx;
      if (color) { outR[i] = rArr[i]; outG[i] = gArr[i]; outB[i] = bArr[i]; }
    }
    if (IS_DEV) window.__asciiPerf = { processMs: performance.now() - t0, domMs: 0, cells: N };
    return { width: drawW, height: drawH, chars: outChars, r: outR, g: outG, b: outB,
      gradDirs: null, braille: null, charset: blockChars, isBraille: false, isColor: color };
  }

  const needGrad = edges || gradientDirs;
  const { mag, dir } = needGrad ? sobelGradient(proc, drawW, drawH) : { mag: proc, dir: null as unknown as Float32Array };
  let final = edges ? mag : proc;
  if (dither) final = ditherMode === "bayer" ? bayerDither(final, drawW, drawH, nchars) : floydSteinberg(final, drawW, drawH, nchars);

  // Precompute lookup table once per charset+invert config
  const charTable = getCharTable(chars, invert, nchars);

  if (gradientDirs) outGradDirs = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const lum = final[i] < 0 ? 0 : final[i] > 255 ? 255 : final[i];
    let charIdx: number;

    if (gradientDirs && dir && mag[i] > 40) {
      const deg = ((dir[i] * 180 / Math.PI) + 180) % 180;
      const dirChar = deg < 22.5 || deg >= 157.5 ? 45  // '-'
        : deg < 67.5 ? 47   // '/'
        : deg < 112.5 ? 124  // '|'
        : 92;                // '\'
      if (outGradDirs) outGradDirs[i] = dirChar;
      charIdx = charTable[lum];
    } else if (threshold > 0) {
      const isLight = lum >= threshold;
      charIdx = invert ? (isLight ? 0 : nchars - 1) : (isLight ? nchars - 1 : 0);
    } else {
      charIdx = charTable[lum];
    }
    outChars[i] = charIdx;
    if (color) { outR[i] = rArr[i]; outG[i] = gArr[i]; outB[i] = bArr[i]; }
  }

  if (IS_DEV) window.__asciiPerf = { processMs: performance.now() - t0, domMs: 0, cells: N };

  return {
    width: drawW, height: drawH,
    chars: outChars, r: outR, g: outG, b: outB,
    gradDirs: outGradDirs, braille: null,
    charset: chars, isBraille: false, isColor: color,
  };
}

// ── HTML renderer — color-run batching reduces DOM nodes 5–15× ──────────────
export function frameToHtml(frame: AsciiFrame): string {
  const { width, height, chars, r, g, b, gradDirs, braille, charset, isBraille } = frame;
  const lines: string[] = [];

  for (let y = 0; y < height; y++) {
    const parts: string[] = [];
    let runR = -1, runG = -1, runB = -1;
    let runText = "";

    const flushRun = () => {
      if (!runText) return;
      parts.push(`<span style="color:${rgbStr(runR, runG, runB)}">${runText}</span>`);
      runText = "";
    };

    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let ch: string;

      if (isBraille && braille) {
        ch = String.fromCodePoint(0x2800 | braille[i]);
      } else if (gradDirs && gradDirs[i]) {
        ch = String.fromCodePoint(gradDirs[i]);
      } else {
        const c = charset[chars[i]];
        ch = c === " " ? "\u00a0" : c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c ?? "\u00a0";
      }

      const cr = r[i], cg = g[i], cb = b[i];
      if (cr === runR && cg === runG && cb === runB) {
        runText += ch;
      } else {
        flushRun();
        runR = cr; runG = cg; runB = cb;
        runText = ch;
      }
    }
    flushRun();
    lines.push(parts.join(""));
  }
  return lines.join("\n");
}

// ── Plain text renderer — uses textContent, no HTML parsing overhead ─────────
export function frameToText(frame: AsciiFrame): string {
  const { width, height, chars, gradDirs, braille, charset, isBraille } = frame;
  const lines: string[] = [];

  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let ch: string;
      if (isBraille && braille) {
        ch = String.fromCodePoint(0x2800 | braille[i]);
      } else if (gradDirs && gradDirs[i]) {
        ch = String.fromCodePoint(gradDirs[i]);
      } else {
        const c = charset[chars[i]];
        ch = c === " " ? "\u00a0" : c ?? "\u00a0";
      }
      row.push(ch);
    }
    lines.push(row.join(""));
  }
  return lines.join("\n");
}

// ── Legacy compat: frameToHtml(frame, color) signature ──────────────────────
// Used by CameraTab/ImageTab which pass the color boolean separately
// The new frame already encodes isColor, so we just dispatch correctly
export function frameToHtmlLegacy(frame: AsciiFrame, color: boolean): string {
  if (!color) return frameToText(frame);
  return frameToHtml(frame);
}
