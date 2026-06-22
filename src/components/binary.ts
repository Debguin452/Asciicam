import { type AsciiFrame } from "./ascii";

const MAGIC = "ACB1";
const MAGIC2 = "ACB2";

export function bitsNeeded(n: number): number {
  if (n <= 1) return 1;
  return Math.ceil(Math.log2(n));
}

export function encodeFramesToBinary(
  frames: AsciiFrame[],
  charset: string,
  asciiW: number,
  asciiH: number,
  includeColor = false
): Uint8Array {
  const charsetBytes = new TextEncoder().encode(charset);
  const bitsPerChar = bitsNeeded(charset.length);
  const bytesPerIndexFrame = Math.ceil((asciiW * asciiH * bitsPerChar) / 8);
  const bytesPerColorFrame = includeColor ? asciiW * asciiH * 3 : 0;
  const bytesPerFrame = bytesPerIndexFrame + bytesPerColorFrame;

  const headerLen = 4 + 1 + charsetBytes.length + 2 + 2 + 4 + 1 + 1;
  const total = headerLen + bytesPerFrame * frames.length;
  const out = new Uint8Array(total);
  let p = 0;

  const magic = includeColor ? MAGIC2 : MAGIC;
  for (let i = 0; i < 4; i++) out[p++] = magic.charCodeAt(i);
  out[p++] = charsetBytes.length;
  out.set(charsetBytes, p);
  p += charsetBytes.length;
  out[p++] = (asciiW >> 8) & 0xff;
  out[p++] = asciiW & 0xff;
  out[p++] = (asciiH >> 8) & 0xff;
  out[p++] = asciiH & 0xff;
  out[p++] = (frames.length >>> 24) & 0xff;
  out[p++] = (frames.length >>> 16) & 0xff;
  out[p++] = (frames.length >>> 8) & 0xff;
  out[p++] = frames.length & 0xff;
  out[p++] = bitsPerChar;
  out[p++] = includeColor ? 1 : 0;

  for (const frame of frames) {
    // New flat AsciiFrame — typed array access
    const { chars, r, g, b, width, height } = frame;
    const w = Math.min(asciiW, width);
    const h = Math.min(asciiH, height);

    let bitBuf = 0, bitCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = chars[y * width + x] ?? 0;
        bitBuf = (bitBuf << bitsPerChar) | idx;
        bitCount += bitsPerChar;
        while (bitCount >= 8) {
          bitCount -= 8;
          out[p++] = (bitBuf >> bitCount) & 0xff;
        }
      }
    }
    if (bitCount > 0) out[p++] = (bitBuf << (8 - bitCount)) & 0xff;

    if (includeColor) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * width + x;
          out[p++] = r[i] ?? 0;
          out[p++] = g[i] ?? 0;
          out[p++] = b[i] ?? 0;
        }
      }
    }
  }

  return out;
}

export interface DecodedBinary {
  charset: string;
  asciiW: number;
  asciiH: number;
  frameCount: number;
  bitsPerChar: number;
  hasColor: boolean;
  frames: number[][][];
  colorFrames?: Uint8Array[];
}

export function decodeFramesFromBinary(data: Uint8Array, hasColor = false): DecodedBinary {
  let p = 0;
  const magic = String.fromCharCode(data[p], data[p+1], data[p+2], data[p+3]); p += 4;
  if (magic !== MAGIC && magic !== MAGIC2) throw new Error("Invalid binary file: bad magic");

  const charsetLen = data[p++];
  const charset = new TextDecoder().decode(data.slice(p, p + charsetLen)); p += charsetLen;
  const asciiW = (data[p++] << 8) | data[p++];
  const asciiH = (data[p++] << 8) | data[p++];
  const frameCount = (data[p++] << 24) | (data[p++] << 16) | (data[p++] << 8) | data[p++];
  const bitsPerChar = data[p++];
  const colorFlag = data[p++];
  const fileHasColor = hasColor && colorFlag === 1;

  const bytesPerIndexFrame = Math.ceil((asciiW * asciiH * bitsPerChar) / 8);
  const bytesPerColorFrame = fileHasColor ? asciiW * asciiH * 3 : 0;
  const mask = (1 << bitsPerChar) - 1;

  const frames: number[][][] = [];
  const colorFrames: Uint8Array[] = [];

  for (let f = 0; f < frameCount; f++) {
    const frame: number[][] = [];
    let bitBuf = 0, bitCount = 0;
    let bytePos = p;
    for (let y = 0; y < asciiH; y++) {
      const row: number[] = [];
      for (let x = 0; x < asciiW; x++) {
        while (bitCount < bitsPerChar) {
          bitBuf = (bitBuf << 8) | data[bytePos++];
          bitCount += 8;
        }
        bitCount -= bitsPerChar;
        const idx = (bitBuf >> bitCount) & mask;
        row.push(idx);
      }
      frame.push(row);
    }
    frames.push(frame);
    p += bytesPerIndexFrame;

    if (fileHasColor) {
      colorFrames.push(data.slice(p, p + bytesPerColorFrame));
      p += bytesPerColorFrame;
    }
  }

  return {
    charset, asciiW, asciiH, frameCount, bitsPerChar,
    hasColor: fileHasColor,
    frames,
    colorFrames: fileHasColor ? colorFrames : undefined,
  };
}

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function encodeFramesToText(
  frames: AsciiFrame[],
  charset: string,
  asciiW: number,
  asciiH: number
): string {
  const lines: string[] = [`ACASCII1 ${asciiW} ${asciiH} ${charset}`];
  for (const frame of frames) {
    const { chars, width, height } = frame;
    for (let y = 0; y < height; y++) {
      let row = "";
      for (let x = 0; x < width; x++) {
        row += charset[chars[y * width + x]] ?? " ";
      }
      lines.push(row);
    }
    lines.push("---FRAME---");
  }
  return lines.join("\n");
}

export interface DecodedText {
  charset: string;
  asciiW: number;
  asciiH: number;
  frames: string[][];
}

export function decodeTextFrames(text: string): DecodedText {
  const lines = text.split("\n");
  const header = lines[0].split(" ");
  if (header[0] !== "ACASCII1") throw new Error("Invalid file: bad text header");
  const asciiW = parseInt(header[1], 10);
  const asciiH = parseInt(header[2], 10);
  const charset = header.slice(3).join(" ");

  const frames: string[][] = [];
  let current: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---FRAME---") {
      if (current.length > 0) frames.push(current);
      current = [];
    } else if (line.length > 0 || current.length < asciiH) {
      current.push(line);
    }
  }
  if (current.length > 0) frames.push(current);

  return { charset, asciiW, asciiH, frames };
}

export function textFramesToIndices(decoded: DecodedText): number[][][] {
  const charIdx = (ch: string) => {
    const idx = decoded.charset.indexOf(ch);
    return idx >= 0 ? idx : 0;
  };
  const pad = decoded.charset[0] ?? " ";
  return decoded.frames.map(grid =>
    grid.map(row => Array.from(row.padEnd(decoded.asciiW, pad)).map(charIdx))
  );
}
