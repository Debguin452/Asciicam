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
  charDensitySort: boolean;
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
  charDensitySort: false,
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

// ── Scratch-buffer pool ──────────────────────────────────────────
// Reused across frames to avoid per-frame allocation/GC churn, which
// is the single biggest cost at 30-45fps target rates. Buffers are
// keyed by pixel count and only reallocated when the grid size changes
// (e.g. on resize or fit recalculation), not on every frame.
class ScratchPool {
  n = 0;
  gray = new Float32Array(0);
  grayB = new Float32Array(0);
  grayC = new Float32Array(0);
  mag = new Float32Array(0);
  dir = new Float32Array(0);
  r = new Uint8Array(0);
  g = new Uint8Array(0);
  b = new Uint8Array(0);
  charIdx = new Uint16Array(0);
  hist = new Uint32Array(256);
  cdf = new Float32Array(256);
  smoothed: Float32Array | null = null;

  ensure(n: number) {
    if (this.n === n) return;
    this.n = n;
    this.gray = new Float32Array(n);
    this.grayB = new Float32Array(n);
    this.grayC = new Float32Array(n);
    this.mag = new Float32Array(n);
    this.dir = new Float32Array(n);
    this.r = new Uint8Array(n);
    this.g = new Uint8Array(n);
    this.b = new Uint8Array(n);
    this.charIdx = new Uint16Array(n);
    this.smoothed = null;
  }
}

const pool = new ScratchPool();

export function resetTemporalSmoothing(): void {
  pool.smoothed = null;
}

// ── Per-pixel filters, all operating in place on pool buffers ──────

function gaussianBlur3(src: Float32Array, dst: Float32Array, w: number, h: number) {
  // Separable-ish 3x3 box-weighted blur, unrolled, no allocation.
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y, y2 = y < h - 1 ? y + 1 : h - 1;
    const r0 = y0 * w, r1 = y1 * w, r2 = y2 * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x, x2 = x < w - 1 ? x + 1 : w - 1;
      const s =
        src[r0+x0]*1 + src[r0+x1]*2 + src[r0+x2]*1 +
        src[r1+x0]*2 + src[r1+x1]*4 + src[r1+x2]*2 +
        src[r2+x0]*1 + src[r2+x1]*2 + src[r2+x2]*1;
      dst[y*w+x] = s / 16;
    }
  }
}

function sobelGradient(src: Float32Array, mag: Float32Array, dir: Float32Array, w: number, h: number) {
  mag.fill(0);
  dir.fill(0);
  for (let y = 1; y < h - 1; y++) {
    const rm1 = (y - 1) * w, r0 = y * w, rp1 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const tl = src[rm1+x-1], tm = src[rm1+x], tr = src[rm1+x+1];
      const ml = src[r0+x-1],                  mr = src[r0+x+1];
      const bl = src[rp1+x-1], bm = src[rp1+x], br = src[rp1+x+1];
      const gx = (tr + 2*mr + br) - (tl + 2*ml + bl);
      const gy = (bl + 2*bm + br) - (tl + 2*tm + tr);
      mag[r0+x] = clamp(Math.abs(gx) + Math.abs(gy));
      dir[r0+x] = Math.atan2(gy, gx);
    }
  }
}

function bayerDitherInPlace(buf: Float32Array, w: number, h: number, n: number) {
  const M = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  const scale = (1 / n) * 2;
  for (let y = 0; y < h; y++) {
    const rowM = (y & 3) * 4;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      buf[i] = clamp(buf[i] + (M[rowM + (x & 3)] / 16 * 255 - 128) * scale);
    }
  }
}

function floydSteinbergInPlace(buf: Float32Array, w: number, h: number, n: number) {
  const denom = n - 1 || 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const hasNext = y < h - 1;
    const nrow = row + w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const old = buf[i];
      const qi = clamp(Math.round((old / 255) * denom), 0, denom);
      const nv = (qi / denom) * 255;
      const err = old - nv;
      buf[i] = nv;
      if (x + 1 < w) buf[i + 1] += err * 0.4375; // 7/16
      if (hasNext) {
        if (x > 0) buf[nrow + x - 1] += err * 0.1875; // 3/16
        buf[nrow + x] += err * 0.3125; // 5/16
        if (x + 1 < w) buf[nrow + x + 1] += err * 0.0625; // 1/16
      }
    }
  }
}

function histogramEqualizeInPlace(buf: Float32Array) {
  const hist = pool.hist, cdf = pool.cdf;
  hist.fill(0);
  for (let i = 0; i < buf.length; i++) hist[Math.round(clamp(buf[i]))]++;
  cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
  let cdfMin = 0;
  for (let i = 0; i < 256; i++) { if (cdf[i] > 0) { cdfMin = cdf[i]; break; } }
  const total = buf.length;
  const denom = total - cdfMin || 1;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.round(((cdf[Math.round(clamp(buf[i]))] - cdfMin) / denom) * 255);
  }
}

function localContrastInPlace(src: Float32Array, blurred: Float32Array, w: number, h: number) {
  gaussianBlur3(src, blurred, w, h);
  for (let i = 0; i < src.length; i++) src[i] = clamp(src[i] + (src[i] - blurred[i]) * 1.5);
}

function applyTemporalSmoothInPlace(buf: Float32Array, alpha = 0.4) {
  if (!pool.smoothed || pool.smoothed.length !== buf.length) {
    pool.smoothed = new Float32Array(buf);
    buf.set(pool.smoothed);
    return;
  }
  const sm = pool.smoothed;
  for (let i = 0; i < buf.length; i++) {
    const v = sm[i] * (1 - alpha) + buf[i] * alpha;
    sm[i] = v;
    buf[i] = v;
  }
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80];

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

interface CoreResult {
  w: number;
  h: number;
  chars: string;
  nchars: number;
  brailleMode: boolean;
  blockMode: boolean;
  gradientDirs: boolean;
  color: boolean;
  threshold: number;
  invert: boolean;
}

/**
 * Shared pixel pipeline: draws the source into the offscreen canvas,
 * computes luminance + all enabled filters, and leaves the final
 * per-pixel char-index / color data in the shared pool buffers.
 * Both the allocating (AsciiFrame) and streaming (string) output
 * paths read from the same pool afterward, so the expensive per-pixel
 * math only ever runs once per frame regardless of output format.
 */
function runCore(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror: boolean,
  crop?: { x: number; y: number; w: number; h: number }
): CoreResult | null {
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
  drawW = Math.max(1, drawW);
  drawH = Math.max(1, drawH);

  if (offscreen.width !== drawW) offscreen.width = drawW;
  if (offscreen.height !== drawH) offscreen.height = drawH;
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
  pool.ensure(N);
  const { gray, r: rArr, g: gArr, b: bArr } = pool;

  const applyGamma = gamma !== 1.0;
  const applyContrast = contrast !== 100;
  const invGamma = 1 / gamma;

  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const r = px[o], g = px[o+1], b = px[o+2];
    let lum = 0.299*r + 0.587*g + 0.114*b;
    if (applyGamma) lum = Math.pow(lum/255, invGamma)*255;
    if (applyContrast) lum = 128 + (lum-128)*contrast/100;
    lum += brightness;
    gray[i] = clamp(lum);
    rArr[i] = r; gArr[i] = g; bArr[i] = b;
  }

  if (brailleMode) {
    return { w: drawW, h: drawH, chars: "", nchars: 0, brailleMode: true, blockMode: false, gradientDirs: false, color, threshold, invert };
  }

  let proc = gray;
  if (noiseReduction) { gaussianBlur3(proc, pool.grayB, drawW, drawH); proc = pool.grayB; }
  if (histEq) histogramEqualizeInPlace(proc);
  if (localContrast) localContrastInPlace(proc, pool.grayC, drawW, drawH);
  if (temporalSmoothing) applyTemporalSmoothInPlace(proc);

  const chars = sortCharsetByDensity(charset || DEFAULT_CHARSET);
  const nchars = chars.length;

  if (blockMode) {
    const blocks = " \u2591\u2592\u2593\u2588";
    const nb = blocks.length;
    const charIdx = pool.charIdx;
    for (let i = 0; i < N; i++) {
      charIdx[i] = Math.min(Math.floor(clamp(proc[i]) / 256 * nb), nb - 1);
    }
    return { w: drawW, h: drawH, chars: blocks, nchars: nb, brailleMode: false, blockMode: true, gradientDirs: false, color, threshold, invert };
  }

  const needGrad = edges || gradientDirs;
  let mag = proc, dir = pool.dir;
  if (needGrad) {
    sobelGradient(proc, pool.mag, pool.dir, drawW, drawH);
    mag = pool.mag; dir = pool.dir;
  }
  let final = edges ? mag : proc;
  if (dither) {
    if (final !== pool.grayB && final !== pool.grayC) {
      // copy to a scratch buffer before mutating in place, so we don't
      // corrupt `proc`/`gray` for any subsequent reads this frame
      pool.grayB.set(final);
      final = pool.grayB;
    }
    if (ditherMode === "bayer") bayerDitherInPlace(final, drawW, drawH, nchars);
    else floydSteinbergInPlace(final, drawW, drawH, nchars);
  }

  const charIdx = pool.charIdx;
  const denom = nchars - 1 || 1;
  for (let i = 0; i < N; i++) {
    const lum = clamp(final[i]);
    let idx: number;
    if (gradientDirs && mag[i] > 40) {
      idx = Math.floor(lum / 255 * denom);
    } else if (threshold > 0) {
      const isLight = lum >= threshold;
      idx = invert ? (isLight ? 0 : denom) : (isLight ? denom : 0);
    } else {
      idx = invert ? Math.floor((1 - lum/255) * denom) : Math.floor(lum/255 * denom);
      if (idx < 0) idx = 0; else if (idx > denom) idx = denom;
    }
    charIdx[i] = idx;
  }
  if (gradientDirs) {
    // store direction-derived line glyphs by encoding a sentinel range
    // above nchars; resolved when building output (see buildOutput)
    for (let i = 0; i < N; i++) {
      if (mag[i] > 40) {
        const deg = ((dir[i]*180/Math.PI)+180) % 180;
        const lineIdx = deg < 22.5 || deg >= 157.5 ? 0 : deg < 67.5 ? 1 : deg < 112.5 ? 2 : 3;
        charIdx[i] = 0x4000 | lineIdx; // tag high bit range, unpacked below
      }
    }
  }

  return { w: drawW, h: drawH, chars, nchars, brailleMode: false, blockMode: false, gradientDirs, color, threshold, invert };
}

const LINE_CHARS = ["-", "/", "|", "\\"];

/**
 * Fast streaming path for live preview: goes straight from pixels to
 * an output string with zero per-cell object allocation. Used by the
 * Camera and Call tabs' render loops, which need to sustain 30-45fps.
 */
export function renderToString(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror: boolean,
  mode: "html" | "text",
  crop?: { x: number; y: number; w: number; h: number }
): string | null {
  const core = runCore(source, offscreen, opts, mirror, crop);
  if (!core) return null;

  if (core.brailleMode) return buildBrailleString(core, mode);

  const { w, h, chars, color } = core;
  const charIdx = pool.charIdx;
  const rArr = pool.r, gArr = pool.g, bArr = pool.b;

  const lines: string[] = new Array(h);

  if (mode === "text") {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let line = "";
      for (let x = 0; x < w; x++) {
        const idx = charIdx[row + x];
        line += (idx & 0x4000) ? LINE_CHARS[idx & 3] : chars[idx];
      }
      lines[y] = line;
    }
    return lines.join("\n");
  }

  // html mode
  if (!color) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let line = "";
      for (let x = 0; x < w; x++) {
        const idx = charIdx[row + x];
        const ch = (idx & 0x4000) ? LINE_CHARS[idx & 3] : chars[idx];
        line += ch === " " ? "\u00a0" : escChar(ch);
      }
      lines[y] = line;
    }
    return lines.join("\n");
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let line = "";
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const idx = charIdx[i];
      const ch = (idx & 0x4000) ? LINE_CHARS[idx & 3] : chars[idx];
      if (ch === " ") { line += "\u00a0"; continue; }
      line += `<span style="color:rgb(${rArr[i]},${gArr[i]},${bArr[i]})">${escChar(ch)}</span>`;
    }
    lines[y] = line;
  }
  return lines.join("\n");
}

function buildBrailleString(core: CoreResult, mode: "html" | "text"): string {
  const { w: srcW, h: srcH, threshold, invert, color } = core;
  const gray = pool.gray, rArr = pool.r, gArr = pool.g, bArr = pool.b;
  const th = threshold > 0 ? threshold : 128;
  const bW = Math.floor(srcW / 2);
  const bH = Math.floor(srcH / 4);
  const lines: string[] = new Array(bH);

  for (let cy = 0; cy < bH; cy++) {
    let line = "";
    for (let cx = 0; cx < bW; cx++) {
      let bits = 0, tr = 0, tg = 0, tb = 0;
      for (let dy = 0; dy < 4; dy++) {
        const py = clamp(cy*4+dy, 0, srcH-1);
        for (let dx = 0; dx < 2; dx++) {
          const px = clamp(cx*2+dx, 0, srcW-1);
          const i = py * srcW + px;
          const lum = gray[i] ?? 0;
          if (invert ? lum < th : lum >= th) bits |= BRAILLE_DOTS[dy*2+dx];
          tr += rArr[i] ?? 0; tg += gArr[i] ?? 0; tb += bArr[i] ?? 0;
        }
      }
      const ch = String.fromCodePoint(BRAILLE_BASE | bits);
      if (mode === "text" || !color) {
        line += ch;
      } else {
        line += `<span style="color:rgb(${Math.round(tr/8)},${Math.round(tg/8)},${Math.round(tb/8)})">${ch}</span>`;
      }
    }
    lines[cy] = line;
  }
  return lines.join("\n");
}

function escChar(s: string): string {
  return s === "&" ? "&amp;" : s === "<" ? "&lt;" : s === ">" ? "&gt;" : s;
}

/**
 * Allocating path: returns a full AsciiCell[][] grid. Used for capture,
 * recording, and the Image tab — call sites that need a persisted,
 * serializable frame rather than just on-screen text. Reuses the same
 * core pixel pipeline as the streaming path.
 */
export function processFrame(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror = true,
  crop?: { x: number; y: number; w: number; h: number }
): AsciiFrame | null {
  const core = runCore(source, offscreen, opts, mirror, crop);
  if (!core) return null;

  if (core.brailleMode) return brailleCore(core);

  const { w, h, chars, color } = core;
  const charIdx = pool.charIdx, rArr = pool.r, gArr = pool.g, bArr = pool.b;

  const frame: AsciiFrame = new Array(h);
  for (let y = 0; y < h; y++) {
    const row: AsciiCell[] = new Array(w);
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x;
      const idxRaw = charIdx[i];
      const idx = idxRaw & 0x4000 ? Math.floor(clamp(pool.gray[i]) / 255 * (chars.length - 1 || 1)) : idxRaw;
      const ch = idxRaw & 0x4000 ? LINE_CHARS[idxRaw & 3] : chars[idx];
      row[x] = { char: ch, charIdx: idx, r: color ? rArr[i] : 0, g: color ? gArr[i] : 0, b: color ? bArr[i] : 0 };
    }
    frame[y] = row;
  }
  return frame;
}

function brailleCore(core: CoreResult): AsciiFrame {
  const { w: srcW, h: srcH, threshold, invert, color } = core;
  const gray = pool.gray, rArr = pool.r, gArr = pool.g, bArr = pool.b;
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

export function frameToHtml(frame: AsciiFrame, color: boolean): string {
  if (!color) return frame.map(row => row.map(c => c.char===" " ? "\u00a0" : escChar(c.char)).join("")).join("\n");
  return frame.map(row => {
    let line = "";
    for (const c of row) {
      if (c.char===" ") line += "\u00a0";
      else line += `<span style="color:rgb(${c.r},${c.g},${c.b})">${escChar(c.char)}</span>`;
    }
    return line;
  }).join("\n");
}

export function frameToText(frame: AsciiFrame): string {
  return frame.map(row => row.map(c => c.char).join("")).join("\n");
}
