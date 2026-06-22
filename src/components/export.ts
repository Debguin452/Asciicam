import { frameToCells, frameToText as asciiFrameToText, type AsciiFrame } from "./ascii";

// Legacy AsciiCell[][] format (used internally by export canvas drawing)
type LegacyFrame = { char: string; charIdx: number; r: number; g: number; b: number }[][];

function toLegacy(frame: AsciiFrame): LegacyFrame {
  return frameToCells(frame);
}

export function frameToText(frame: AsciiFrame): string {
  return asciiFrameToText(frame);
}

export function framesToText(frames: AsciiFrame[]): string {
  return frames.map((f, i) => (i > 0 ? "\n---\n" : "") + asciiFrameToText(f)).join("");
}

function frameToCanvas(frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean): HTMLCanvasElement {
  const { width, height, chars, r, g, b, charset, isBraille, braille } = frame;
  const cw = Math.ceil(fontSize * 0.6);
  const ch = Math.ceil(fontSize * 1.15);
  const canvas = document.createElement("canvas");
  canvas.width = width * cw;
  canvas.height = height * ch;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let ch2: string;
      if (isBraille && braille) {
        ch2 = String.fromCodePoint(0x2800 | braille[i]);
      } else {
        ch2 = charset[chars[i]] ?? " ";
      }
      if (ch2 === " ") continue;
      if (color && frame.isColor) {
        ctx.fillStyle = `rgb(${r[i]},${g[i]},${b[i]})`;
      } else {
        ctx.fillStyle = fg;
      }
      ctx.fillText(ch2, x * cw, (y + 1) * ch - Math.ceil(ch * 0.2));
    }
  }
  return canvas;
}

export function exportPng(frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean): Promise<Blob> {
  const canvas = frameToCanvas(frame, fontSize, fg, bg, color);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png");
  });
}

export function exportJpeg(frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean): Promise<Blob> {
  const canvas = frameToCanvas(frame, fontSize, fg, bg, color);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("JPEG export failed")), "image/jpeg", 0.92);
  });
}

export async function exportGif(frames: AsciiFrame[], fontSize: number, fg: string, bg: string, color: boolean, fps: number): Promise<Blob> {
  if (!frames.length) throw new Error("No frames");
  const { width, height } = frames[0];
  const cw = Math.ceil(fontSize * 0.6);
  const ch = Math.ceil(fontSize * 1.15);
  const W = width * cw;
  const H = height * ch;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const gif = GIFEncoder();
  const delay = Math.round(1000 / Math.max(1, fps));

  for (const frame of frames) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const i = y * frame.width + x;
        const ch2 = frame.charset[frame.chars[i]] ?? " ";
        if (ch2 === " ") continue;
        ctx.fillStyle = color && frame.isColor ? `rgb(${frame.r[i]},${frame.g[i]},${frame.b[i]})` : fg;
        ctx.fillText(ch2, x * cw, (y + 1) * ch - Math.ceil(ch * 0.2));
      }
    }
    const imgData = ctx.getImageData(0, 0, W, H);
    const palette = quantize(new Uint8Array(imgData.data.buffer), 256);
    const index = applyPalette(new Uint8Array(imgData.data.buffer), palette);
    gif.writeFrame(index, W, H, { palette, delay });
  }

  gif.finish();
  return new Blob([gif.bytes().buffer as ArrayBuffer], { type: "image/gif" });
}

export async function exportMp4(frames: AsciiFrame[], fontSize: number, fg: string, bg: string, color: boolean, fps: number): Promise<Blob> {
  if (!frames.length) throw new Error("No frames");
  const { width, height } = frames[0];
  const cw = Math.ceil(fontSize * 0.6);
  const ch = Math.ceil(fontSize * 1.15);
  const rawW = width * cw;
  const rawH = height * ch;
  const W = rawW % 2 === 0 ? rawW : rawW + 1;
  const H = rawH % 2 === 0 ? rawH : rawH + 1;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

  const drawFrame = (frame: AsciiFrame) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const i = y * frame.width + x;
        const ch2 = frame.charset[frame.chars[i]] ?? " ";
        if (ch2 === " ") continue;
        ctx.fillStyle = color && frame.isColor ? `rgb(${frame.r[i]},${frame.g[i]},${frame.b[i]})` : fg;
        ctx.fillText(ch2, x * cw, (y + 1) * ch - Math.ceil(ch * 0.2));
      }
    }
  };

  if (typeof VideoEncoder !== "undefined") {
    const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta!),
      error: console.error,
    });
    encoder.configure({ codec: "avc1.42001f", width: W, height: H, bitrate: 2_000_000, framerate: fps });
    const dur = Math.round(1_000_000 / fps);
    for (let i = 0; i < frames.length; i++) {
      drawFrame(frames[i]);
      const vf = new VideoFrame(canvas, { timestamp: i * dur, duration: dur });
      encoder.encode(vf, { keyFrame: i % 30 === 0 });
      vf.close();
    }
    await encoder.flush();
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  }

  return new Promise((resolve, reject) => {
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    recorder.onerror = reject;
    recorder.start();
    let fi = 0;
    const interval = 1000 / Math.max(1, fps);
    const tick = () => {
      if (fi >= frames.length) { recorder.stop(); return; }
      drawFrame(frames[fi++]);
      setTimeout(tick, interval);
    };
    tick();
  });
}
