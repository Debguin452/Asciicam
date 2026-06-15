export const DEFAULT_CHARSET = " .:-=+*#%@";

export interface AsciiOptions {
  asciiW: number;
  asciiH: number;
  brightness: number;
  contrast: number;
  invert: boolean;
  color: boolean;
  edges: boolean;
  dither: boolean;
  charset: string;
}

export interface AsciiCell {
  char: string;
  r: number;
  g: number;
  b: number;
}

export type AsciiFrame = AsciiCell[][];

function clamp(v: number, lo = 0, hi = 255): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function sobelEdges(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const Gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const Gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y + ky) * w + (x + kx)];
          const idx = (ky + 1) * 3 + (kx + 1);
          gx += Gx[idx] * p;
          gy += Gy[idx] * p;
        }
      }
      const mag = Math.abs(gx) + Math.abs(gy);
      out[y * w + x] = clamp(mag);
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
      const spread: [number, number, number][] = [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
      for (const [dx, dy, f] of spread) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += err * f;
      }
    }
  }
  return buf;
}

export function processFrame(
  video: HTMLVideoElement,
  offscreen: HTMLCanvasElement,
  opts: AsciiOptions
): AsciiFrame | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const { asciiW, asciiH, brightness, contrast, invert, color, edges, dither, charset } = opts;
  const chars = charset || DEFAULT_CHARSET;
  const nchars = chars.length;

  offscreen.width = asciiW;
  offscreen.height = asciiH;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true })!;

  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -asciiW, 0, asciiW, asciiH);
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, asciiW, asciiH);
  const px = imgData.data;

  const gray = new Float32Array(asciiW * asciiH);
  const rArr = new Uint8Array(asciiW * asciiH);
  const gArr = new Uint8Array(asciiW * asciiH);
  const bArr = new Uint8Array(asciiW * asciiH);

  for (let i = 0; i < asciiW * asciiH; i++) {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (contrast !== 100) lum = 128 + (lum - 128) * contrast / 100;
    lum += brightness;
    gray[i] = clamp(lum);
    rArr[i] = r;
    gArr[i] = g;
    bArr[i] = b;
  }

  let finalGray = edges ? sobelEdges(gray, asciiW, asciiH) : gray;
  if (dither) finalGray = floydSteinberg(finalGray, asciiW, asciiH, nchars);

  const frame: AsciiFrame = [];
  for (let y = 0; y < asciiH; y++) {
    const row: AsciiCell[] = [];
    for (let x = 0; x < asciiW; x++) {
      const i = y * asciiW + x;
      let lum = clamp(finalGray[i]);
      const idx = invert
        ? Math.floor((1 - lum / 255) * (nchars - 1))
        : Math.floor((lum / 255) * (nchars - 1));
      const charIdx = clamp(idx, 0, nchars - 1);
      row.push({
        char: chars[charIdx],
        r: color ? rArr[i] : 0,
        g: color ? gArr[i] : 0,
        b: color ? bArr[i] : 0,
      });
    }
    frame.push(row);
  }
  return frame;
}
