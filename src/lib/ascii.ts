export const DEFAULT_CHARSET = " .:-=+*#%@";

export const GRADIENT_CHARS = { h: "-", v: "|", d1: "/", d2: "\\" };

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
  charDensitySort: boolean;
  brailleMode: boolean;
  blockMode: boolean;
  temporalSmoothing: boolean;
}

export const DEFAULT_OPTIONS: AsciiOptions = {
  asciiW: 120,
  asciiH: 50,
  brightness: 0,
  contrast: 100,
  threshold: 0,
  gamma: 1.0,
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
  charDensitySort: true,
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
  const k = [1/16, 2/16, 1/16, 2/16, 4/16, 2/16, 1/16, 2/16, 1/16];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const nx = clamp(x + kx, 0, w - 1);
          const ny = clamp(y + ky, 0, h - 1);
          s += gray[ny * w + nx] * k[(ky + 1) * 3 + (kx + 1)];
        }
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

function sobelGradient(gray: Float32Array, w: number, h: number): { mag: Float32Array; dir: Float32Array } {
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  const Gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const Gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y + ky) * w + (x + kx)];
          const ki = (ky + 1) * 3 + (kx + 1);
          gx += Gx[ki] * p;
          gy += Gy[ki] * p;
        }
      }
      mag[y * w + x] = clamp(Math.abs(gx) + Math.abs(gy));
      dir[y * w + x] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

function bayerDither(gray: Float32Array, w: number, h: number, nchars: number): Float32Array {
  const M4 = [0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = (M4[(y % 4) * 4 + (x % 4)] / 16) * 255;
      out[i] = clamp(gray[i] + (t - 128) * (1 / nchars) * 2);
    }
  }
  return out;
}

function floydSteinberg(gray: Float32Array, w: number, h: number, nchars: number): Float32Array {
  const buf = new Float32Array(gray);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const old = buf[y * w + x];
      const qi = clamp(Math.round((old / 255) * (nchars - 1)), 0, nchars - 1);
      const newVal = (qi / (nchars - 1)) * 255;
      const err = old - newVal;
      buf[y * w + x] = newVal;
      const spread: [number, number, number][] = [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
      for (const [dx, dy, f] of spread) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += err * f;
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
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
  const cdfMin = cdf.find(v => v > 0) ?? 0;
  const total = gray.length;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round(clamp(gray[i]));
    out[i] = Math.round(((cdf[v] - cdfMin) / (total - cdfMin)) * 255);
  }
  return out;
}

function localContrastEnhancement(gray: Float32Array, w: number, h: number): Float32Array {
  const blurred = gaussianBlur3(gray, w, h);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = clamp(gray[i] + (gray[i] - blurred[i]) * 1.5);
  }
  return out;
}

const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80];

function buildBrailleFrame(
  gray: Float32Array, rArr: Uint8Array, gArr: Uint8Array, bArr: Uint8Array,
  w: number, h: number, threshold: number, invert: boolean, color: boolean
): AsciiFrame {
  const frame: AsciiFrame = [];
  const th = threshold > 0 ? threshold : 128;
  for (let cy = 0; cy < h; cy++) {
    const row: AsciiCell[] = [];
    for (let cx = 0; cx < w; cx++) {
      let bits = 0;
      let tr = 0, tg = 0, tb = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = clamp(cx * 2 + dx, 0, w * 2 - 1);
          const py = clamp(cy * 4 + dy, 0, h * 4 - 1);
          const i = py * w * 2 + px;
          const lum = gray[i < gray.length ? i : gray.length - 1];
          if (invert ? lum < th : lum >= th) bits |= BRAILLE_DOTS[dy * 2 + dx];
          tr += rArr[i < rArr.length ? i : rArr.length - 1];
          tg += gArr[i < gArr.length ? i : gArr.length - 1];
          tb += bArr[i < bArr.length ? i : bArr.length - 1];
        }
      }
      const ch = String.fromCodePoint(BRAILLE_BASE | bits);
      row.push({ char: ch, charIdx: bits, r: color ? Math.round(tr / 8) : 0, g: color ? Math.round(tg / 8) : 0, b: color ? Math.round(tb / 8) : 0 });
    }
    frame.push(row);
  }
  return frame;
}

const densityCache = new Map<string, string>();

export function getSortedCharset(charset: string, enabled: boolean): string {
  if (!enabled) return charset;
  const key = charset;
  if (!densityCache.has(key)) {
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
      densityCache.set(key, measured.map(m => m.ch).join(""));
    } catch {
      densityCache.set(key, charset);
    }
  }
  return densityCache.get(key)!;
}

let smoothed: Float32Array | null = null;

export function resetTemporalSmoothing(): void {
  smoothed = null;
}

function applyTemporalSmooth(gray: Float32Array, alpha = 0.4): Float32Array {
  if (!smoothed || smoothed.length !== gray.length) {
    smoothed = new Float32Array(gray);
    return smoothed;
  }
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = smoothed[i] * (1 - alpha) + gray[i] * alpha;
  }
  smoothed = out;
  return out;
}

export function processFrame(
  source: AsciiSource,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions,
  mirror = true
): AsciiFrame | null {
  const { w: sw, h: sh } = getSourceDimensions(source);
  if (!sw || !sh) return null;

  const {
    asciiW, asciiH, brightness, contrast, threshold, gamma,
    invert, color, edges, gradientDirs, dither, ditherMode,
    noiseReduction, localContrast, histEq, charset,
    charDensitySort, brailleMode, blockMode, temporalSmoothing
  } = opts;

  offscreen.width = asciiW;
  offscreen.height = asciiH;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true })!;

  ctx.save();
  if (mirror) { ctx.scale(-1, 1); ctx.drawImage(source, -asciiW, 0, asciiW, asciiH); }
  else ctx.drawImage(source, 0, 0, asciiW, asciiH);
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, asciiW, asciiH);
  const px = imgData.data;
  const N = asciiW * asciiH;

  const gray = new Float32Array(N);
  const rArr = new Uint8Array(N);
  const gArr = new Uint8Array(N);
  const bArr = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (gamma !== 1.0) lum = Math.pow(lum / 255, 1 / gamma) * 255;
    if (contrast !== 100) lum = 128 + (lum - 128) * contrast / 100;
    lum += brightness;
    gray[i] = clamp(lum);
    rArr[i] = r; gArr[i] = g; bArr[i] = b;
  }

  if (brailleMode) {
    return buildBrailleFrame(gray, rArr, gArr, bArr, asciiW, asciiH, threshold, invert, color);
  }

  let processed: Float32Array<ArrayBuffer> = gray;
  if (noiseReduction) processed = gaussianBlur3(processed, asciiW, asciiH) as Float32Array<ArrayBuffer>;
  if (histEq) processed = histogramEqualize(processed) as Float32Array<ArrayBuffer>;
  if (localContrast) processed = localContrastEnhancement(processed, asciiW, asciiH) as Float32Array<ArrayBuffer>;
  if (temporalSmoothing) processed = applyTemporalSmooth(processed) as Float32Array<ArrayBuffer>;

  const chars = getSortedCharset(charset || DEFAULT_CHARSET, charDensitySort);
  const nchars = chars.length;

  if (blockMode) {
    const blocks = " \u2591\u2592\u2593\u2588";
    const nb = blocks.length;
    const frame: AsciiFrame = [];
    for (let y = 0; y < asciiH; y++) {
      const row: AsciiCell[] = [];
      for (let x = 0; x < asciiW; x++) {
        const i = y * asciiW + x;
        const idx = Math.min(Math.floor((clamp(processed[i]) / 256) * nb), nb - 1);
        row.push({ char: blocks[idx], charIdx: idx, r: color ? rArr[i] : 0, g: color ? gArr[i] : 0, b: color ? bArr[i] : 0 });
      }
      frame.push(row);
    }
    return frame;
  }

  const needGradient = edges || gradientDirs;
  const { mag, dir } = needGradient ? sobelGradient(processed, asciiW, asciiH) : { mag: processed, dir: new Float32Array(N) };
  let finalGray = edges ? mag : processed;

  if (dither) {
    finalGray = ditherMode === "bayer"
      ? bayerDither(finalGray, asciiW, asciiH, nchars)
      : floydSteinberg(finalGray, asciiW, asciiH, nchars);
  }

  const frame: AsciiFrame = [];
  for (let y = 0; y < asciiH; y++) {
    const row: AsciiCell[] = [];
    for (let x = 0; x < asciiW; x++) {
      const i = y * asciiW + x;
      const lum = clamp(finalGray[i]);
      let charIdx: number;
      let charOut: string;

      if (gradientDirs && mag[i] > 40) {
        const deg = ((dir[i] * 180 / Math.PI) + 180) % 180;
        if (deg < 22.5 || deg >= 157.5) charOut = "-";
        else if (deg < 67.5) charOut = "/";
        else if (deg < 112.5) charOut = "|";
        else charOut = "\\";
        charIdx = Math.floor(lum / 255 * (nchars - 1));
      } else if (threshold > 0) {
        const isLight = lum >= threshold;
        charIdx = invert ? (isLight ? 0 : nchars - 1) : (isLight ? nchars - 1 : 0);
        charOut = chars[charIdx];
      } else {
        const idx = invert
          ? Math.floor((1 - lum / 255) * (nchars - 1))
          : Math.floor((lum / 255) * (nchars - 1));
        charIdx = clamp(idx, 0, nchars - 1);
        charOut = chars[charIdx];
      }

      row.push({
        char: charOut!,
        charIdx,
        r: color ? rArr[i] : 0,
        g: color ? gArr[i] : 0,
        b: color ? bArr[i] : 0,
      });
    }
    frame.push(row);
  }
  return frame;
}

export function frameToHtml(frame: AsciiFrame, color: boolean): string {
  if (!color) {
    return frame.map(row =>
      row.map(c => c.char === " " ? "\u00a0" : escHtml(c.char)).join("")
    ).join("\n");
  }
  const lines: string[] = [];
  for (const row of frame) {
    let line = "";
    for (const cell of row) {
      if (cell.char === " ") line += "\u00a0";
      else line += `<span style="color:rgb(${cell.r},${cell.g},${cell.b})">${escHtml(cell.char)}</span>`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function escHtml(s: string): string {
  if (s === "&") return "&amp;";
  if (s === "<") return "&lt;";
  if (s === ">") return "&gt;";
  return s;
}

export function frameToText(frame: AsciiFrame): string {
  return frame.map(row => row.map(c => c.char).join("")).join("\n");
}

export function computeDelta(prev: AsciiFrame, curr: AsciiFrame): number {
  let changed = 0;
  for (let y = 0; y < curr.length; y++)
    for (let x = 0; x < (curr[y]?.length ?? 0); x++)
      if (prev[y]?.[x]?.charIdx !== curr[y][x]?.charIdx) changed++;
  return changed;
}
