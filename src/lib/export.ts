import type { AsciiFrame } from "./ascii";

export function frameToText(frame: AsciiFrame): string {
  return frame.map(row => row.map(c => c.char).join("")).join("\n");
}

export function framesToText(frames: AsciiFrame[]): string {
  return frames.map((f, i) => (i > 0 ? "\n---\n" : "") + frameToText(f)).join("");
}

const EXPORT_SCALE = 3; // 3× for crisp high-res PNG/JPG
const CHAR_ASPECT = 0.575; // charWidth / fontSize ratio for JetBrains Mono

export function frameToCanvas(
  frame: AsciiFrame,
  fontSize: number,
  fg: string,
  bg: string,
  color: boolean
): HTMLCanvasElement {
  const cols = frame[0]?.length ?? 80;
  const rows = frame.length;
  const s = EXPORT_SCALE;
  const cw = fontSize * CHAR_ASPECT * s;
  const ch = fontSize * 1.15 * s;
  const canvas = document.createElement("canvas");
  canvas.width  = Math.ceil(cols * cw);
  canvas.height = Math.ceil(rows * ch);
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize * s}px "JetBrains Mono", "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.textRendering = "geometricPrecision" as any;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
      const cell = frame[y][x];
      if (cell.char === " ") continue;
      ctx.fillStyle = color && (cell.r || cell.g || cell.b)
        ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
      ctx.fillText(cell.char, x * cw, y * ch);
    }
  }
  return canvas;
}

export function exportPng(
  frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean
): Promise<Blob> {
  const canvas = frameToCanvas(frame, fontSize, fg, bg, color);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG failed")), "image/png")
  );
}

export function exportJpeg(
  frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean
): Promise<Blob> {
  const canvas = frameToCanvas(frame, fontSize, fg, bg, color);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("JPEG failed")), "image/jpeg", 0.97)
  );
}

/** SVG — lossless vector with color, text selectable */
export function exportSvg(
  frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean
): Blob {
  const cols = frame[0]?.length ?? 80;
  const rows = frame.length;
  const cw = fontSize * CHAR_ASPECT;
  const ch = fontSize * 1.15;
  const W = cols * cw;
  const H = rows * ch;
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(1)}" height="${H.toFixed(1)}" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}">`,
    `<rect width="100%" height="100%" fill="${escXml(bg)}"/>`,
    `<g font-family="&quot;JetBrains Mono&quot;,&quot;Courier New&quot;,monospace" font-size="${fontSize}" xml:space="preserve">`,
  ];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
      const cell = frame[y][x];
      if (cell.char === " ") continue;
      const cx = (x * cw).toFixed(2);
      const cy = ((y + 0.82) * ch).toFixed(2);
      const fill = color && (cell.r || cell.g || cell.b)
        ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
      lines.push(
        `<text x="${cx}" y="${cy}" fill="${escXml(fill)}">${escXml(cell.char)}</text>`
      );
    }
  }
  lines.push("</g></svg>");
  return new Blob([lines.join("")], { type: "image/svg+xml" });
}

/** HTML — self-contained file with coloured <pre> */
export function exportHtml(
  frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean
): Blob {
  const rows = frame.map(row =>
    row.map(cell => {
      if (cell.char === " ") return "\u00a0"; // &nbsp; to preserve spaces
      const fill = color && (cell.r || cell.g || cell.b)
        ? `rgb(${cell.r},${cell.g},${cell.b})` : "";
      const ch = escHtml(cell.char);
      return fill ? `<span style="color:${fill}">${ch}</span>` : ch;
    }).join("")
  ).join("\n");
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
body{margin:0;background:${bg}}
pre{font-family:"JetBrains Mono","Courier New",monospace;font-size:${fontSize}px;line-height:1.15;color:${fg};padding:8px;white-space:pre}
</style></head><body><pre>${rows}</pre></body></html>`;
  return new Blob([html], { type: "text/html" });
}

function escXml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function escHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

export async function exportGif(
  frames: AsciiFrame[], fontSize: number, fg: string, bg: string, color: boolean, fps: number
): Promise<Blob> {
  const cols = frames[0]?.[0]?.length ?? 80;
  const rows = frames[0]?.length ?? 40;
  const s = 2; // 2× for GIF (balance size vs quality)
  const cw = Math.ceil(fontSize * CHAR_ASPECT * s);
  const ch = Math.ceil(fontSize * 1.15 * s);
  const W = cols * cw;
  const H = rows * ch;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize * s}px "JetBrains Mono", "Courier New", monospace`;
  ctx.textBaseline = "top";

  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const gif = GIFEncoder();
  const delay = Math.round(1000 / Math.max(1, fps));

  for (const frame of frames) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < frame.length; y++) {
      for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
        const cell = frame[y][x];
        if (cell.char === " ") continue;
        ctx.fillStyle = color && (cell.r || cell.g || cell.b)
          ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
        ctx.fillText(cell.char, x * cw, y * ch);
      }
    }
    const imgData = ctx.getImageData(0, 0, W, H);
    const palette = quantize(imgData.data, 256);
    const index = applyPalette(imgData.data, palette);
    gif.writeFrame(index, W, H, { palette, delay });
  }
  gif.finish();
  return new Blob([gif.bytesView()], { type: "image/gif" });
}

export async function exportMp4(
  frames: AsciiFrame[], fontSize: number, fg: string, bg: string, color: boolean, fps: number
): Promise<Blob> {
  const cols = frames[0]?.[0]?.length ?? 80;
  const rows = frames[0]?.length ?? 40;
  const s = 2;
  const cw = Math.ceil(fontSize * CHAR_ASPECT * s);
  const ch = Math.ceil(fontSize * 1.15 * s);
  const rawW = cols * cw; const rawH = rows * ch;
  const W = rawW % 2 === 0 ? rawW : rawW + 1;
  const H = rawH % 2 === 0 ? rawH : rawH + 1;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize * s}px "JetBrains Mono", "Courier New", monospace`;
  ctx.textBaseline = "top";

  const drawFrame = (frame: AsciiFrame) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < frame.length; y++) {
      for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
        const cell = frame[y][x];
        if (cell.char === " ") continue;
        ctx.fillStyle = color && (cell.r || cell.g || cell.b)
          ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
        ctx.fillText(cell.char, x * cw, y * ch);
      }
    }
  };

  if (typeof VideoEncoder !== "undefined") {
    const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: console.error,
    });
    encoder.configure({ codec: "avc1.42001f", width: W, height: H, bitrate: 4_000_000, framerate: fps });
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
    let i = 0;
    const tick = () => {
      if (i >= frames.length) { recorder.stop(); return; }
      drawFrame(frames[i++]);
      setTimeout(tick, 1000 / Math.max(1, fps));
    };
    tick();
  });
}
