import { useRef, useState, useEffect, useCallback, type ChangeEvent } from "react";
import { processFrame, DEFAULT_CHARSET, type AsciiOptions, type AsciiFrame } from "./lib/ascii";
import {
  encodeFramesToBinary,
  decodeBinaryFrames,
  gzipCompress,
  gzipDecompress,
  encodeFramesToText,
  decodeTextFrames,
} from "./lib/binary";

const PRESETS = {
  "Classic": { charset: " .:-=+*#%@", color: false, edges: false, dither: false, invert: false },
  "Dense":   { charset: " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@", color: false, edges: false, dither: false, invert: false },
  "Blocks":  { charset: " ░▒▓█", color: true, edges: false, dither: false, invert: false },
  "Edges":   { charset: " .:-=+*#%@", color: false, edges: true, dither: false, invert: false },
  "Dither":  { charset: " .:-=+*#%@", color: false, edges: false, dither: true, invert: false },
  "Color":   { charset: " .:-=+*#%@", color: true, edges: false, dither: false, invert: false },
  "Dots":    { charset: " ·•●", color: true, edges: false, dither: true, invert: false },
} as const;

const FONT_SIZES = [8, 10, 12, 14, 16];

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const fpsCounterRef = useRef<{ times: number[]; last: number }>({ times: [], last: 0 });

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fontSize, setFontSize] = useState(10);
  const [recording, setRecording] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [playback, setPlayback] = useState<{
    frames: number[][][];
    charset: string;
    asciiW: number;
    asciiH: number;
  } | null>(null);
  const recordedFramesRef = useRef<AsciiFrame[]>([]);
  const recordDimsRef = useRef<{ w: number; h: number; charset: string } | null>(null);
  const playbackRafRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [opts, setOpts] = useState<AsciiOptions>({
    asciiW: 120,
    asciiH: 50,
    brightness: 0,
    contrast: 100,
    invert: false,
    color: false,
    edges: false,
    dither: false,
    charset: DEFAULT_CHARSET,
  });

  const updateOpt = <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) =>
    setOpts(o => ({ ...o, [key]: val }));

  const applyPreset = (name: keyof typeof PRESETS) => {
    const p = PRESETS[name];
    setOpts(o => ({ ...o, ...p }));
  };

  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const pre = preRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    const frame = processFrame(video, offscreenRef.current, opts);
    if (frame) {
      pre.innerHTML = frameToHtml(frame, opts.color);
      if (recording) {
        recordedFramesRef.current.push(frame);
        recordDimsRef.current = { w: opts.asciiW, h: opts.asciiH, charset: opts.charset || DEFAULT_CHARSET };
        setRecordedCount(recordedFramesRef.current.length);
      }
    }

    const now = performance.now();
    const fc = fpsCounterRef.current;
    fc.times.push(now);
    if (fc.times.length > 30) fc.times.shift();
    if (fc.times.length > 1) {
      const elapsed = fc.times[fc.times.length - 1] - fc.times[0];
      setFps(Math.round(((fc.times.length - 1) / elapsed) * 1000));
    }

    rafRef.current = requestAnimationFrame(renderFrame);
  }, [opts, recording]);

  useEffect(() => {
    if (running && !playback) {
      rafRef.current = requestAnimationFrame(renderFrame);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, renderFrame, playback]);

  // Playback loop for imported ASCII video
  useEffect(() => {
    if (!playback) return;
    const pre = preRef.current;
    if (!pre) return;

    const { frames, charset, asciiW, asciiH } = playback;
    let i = 0;

    const drawFrame = () => {
      const grid = frames[i];
      const lines: string[] = [];
      for (let y = 0; y < asciiH; y++) {
        let line = "";
        for (let x = 0; x < asciiW; x++) {
          const ch = charset[grid[y][x]] ?? " ";
          line += ch === " " ? "\u00a0" : ch;
        }
        lines.push(line);
      }
      pre.textContent = lines.join("\n");
      i = (i + 1) % frames.length;
    };

    drawFrame();
    const interval = setInterval(drawFrame, 1000 / 15);
    return () => clearInterval(interval);
  }, [playback]);

  const startCamera = async () => {
    setError(null);
    setPlayback(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Camera access denied");
    }
  };

  const stopCamera = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (preRef.current) preRef.current.innerHTML = "";
    setRunning(false);
    setFps(0);
    setRecording(false);
    fpsCounterRef.current = { times: [], last: 0 };
  };

  const copyAscii = () => {
    if (!preRef.current) return;
    navigator.clipboard.writeText(preRef.current.innerText);
  };

  const downloadAscii = () => {
    if (!preRef.current) return;
    const blob = new Blob([preRef.current.innerText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ascii-art.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleRecording = () => {
    if (!recording) {
      recordedFramesRef.current = [];
      setRecordedCount(0);
    }
    setRecording(r => !r);
  };

  const triggerDownload = (data: Blob, filename: string) => {
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportVideoText = () => {
    const dims = recordDimsRef.current;
    const frames = recordedFramesRef.current;
    if (!dims || frames.length === 0) return;
    const text = encodeFramesToText(frames, dims.charset, dims.w, dims.h);
    triggerDownload(new Blob([text], { type: "text/plain" }), "ascii-video.txt");
  };

  const exportVideoBinary = async () => {
    const dims = recordDimsRef.current;
    const frames = recordedFramesRef.current;
    if (!dims || frames.length === 0) return;
    const raw = encodeFramesToBinary(frames, dims.charset, dims.w, dims.h);
    const compressed = await gzipCompress(raw);
    triggerDownload(new Blob([compressed as BlobPart], { type: "application/octet-stream" }), "ascii-video.bin.gz");
  };

  const importVideoBinary = async (file: File) => {
    setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const raw = await gzipDecompress(buf);
      const decoded = decodeBinaryFrames(raw);
      stopCamera();
      setPlayback({
        frames: decoded.frames,
        charset: decoded.charset,
        asciiW: decoded.asciiW,
        asciiH: decoded.asciiH,
      });
      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load binary file");
    }
  };

  const importVideoText = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const decoded = decodeTextFrames(text);
      const charIdx = (ch: string) => {
        const idx = decoded.charset.indexOf(ch);
        return idx >= 0 ? idx : 0;
      };
      const frames = decoded.frames.map(grid =>
        grid.map(row => Array.from(row.padEnd(decoded.asciiW, decoded.charset[0] ?? " ")).map(charIdx))
      );
      stopCamera();
      setPlayback({
        frames,
        charset: decoded.charset,
        asciiW: decoded.asciiW,
        asciiH: decoded.asciiH,
      });
      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load text file");
    }
  };

  const handleFileImport = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.name.endsWith(".gz") || file.name.endsWith(".bin")) {
      importVideoBinary(file);
    } else {
      importVideoText(file);
    }
    e.target.value = "";
  };

  const stopPlayback = () => {
    setPlayback(null);
    setRunning(false);
    if (preRef.current) preRef.current.innerHTML = "";
  };

  return (
    <div className="app-root">
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      {/* Top bar */}
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">▓ AsciiCam</span>
          {running && !playback && <span className="fps-badge">{fps} fps</span>}
          {playback && <span className="fps-badge">▶ playback</span>}
          {recording && <span className="error-badge">● rec {recordedCount}</span>}
          {error && <span className="error-badge">⚠ {error}</span>}
        </div>
        <div className="topbar-right">
          {running && !playback && (
            <>
              <button className="btn btn-ghost" onClick={copyAscii} title="Copy to clipboard">⎘ Copy</button>
              <button className="btn btn-ghost" onClick={downloadAscii} title="Download .txt">↓ Save</button>
              <button
                className={`btn ${recording ? "btn-danger" : "btn-ghost"}`}
                onClick={toggleRecording}
                title="Record frames for export"
              >
                {recording ? "■ Stop Rec" : "● Record"}
              </button>
              <button className="btn btn-ghost" onClick={exportVideoText} title="Export recorded frames as .txt" disabled={recordedCount === 0}>
                ↓ TXT
              </button>
              <button className="btn btn-ghost" onClick={exportVideoBinary} title="Export recorded frames as compressed binary" disabled={recordedCount === 0}>
                ↓ BIN
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()} title="Import .txt or .bin.gz ASCII video">
            ↑ Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.bin,.gz"
            style={{ display: "none" }}
            onChange={handleFileImport}
          />
          {playback ? (
            <button className="btn btn-danger" onClick={stopPlayback}>■ Stop Playback</button>
          ) : (
            <button
              className={`btn ${running ? "btn-danger" : "btn-primary"}`}
              onClick={running ? stopCamera : startCamera}
            >
              {running ? "■ Stop" : "▶ Start Camera"}
            </button>
          )}
          <button className="btn btn-ghost panel-toggle" onClick={() => setPanelOpen(o => !o)}>
            {panelOpen ? "◀ Controls" : "▶ Controls"}
          </button>
        </div>
      </header>

      <div className="main-layout">
        {/* ASCII output */}
        <div className="ascii-area">
          {!running && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={startCamera}>
                ▶ Start Camera
              </button>
              <p className="splash-hint">Live video → ASCII art in your browser</p>
            </div>
          )}
          <pre
            ref={preRef}
            className="ascii-output"
            style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }}
          />
        </div>

        {/* Controls panel */}
        {panelOpen && (
          <aside className="controls-panel">
            <div className="panel-section">
              <label className="section-label">Presets</label>
              <div className="preset-grid">
                {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map(name => (
                  <button key={name} className="btn btn-preset" onClick={() => applyPreset(name)}>
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <div className="panel-section">
              <label className="section-label">Display</label>
              <div className="control-row">
                <span>Font size</span>
                <div className="btn-group">
                  {FONT_SIZES.map(s => (
                    <button
                      key={s}
                      className={`btn btn-sm ${fontSize === s ? "btn-active" : "btn-ghost"}`}
                      onClick={() => setFontSize(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="panel-section">
              <label className="section-label">Output Size</label>
              <SliderRow label="Columns" value={opts.asciiW} min={20} max={200} step={1}
                onChange={v => updateOpt("asciiW", v)} />
              <SliderRow label="Rows" value={opts.asciiH} min={10} max={80} step={1}
                onChange={v => updateOpt("asciiH", v)} />
            </div>

            <div className="panel-section">
              <label className="section-label">Image</label>
              <SliderRow label="Brightness" value={opts.brightness} min={-128} max={128} step={1}
                onChange={v => updateOpt("brightness", v)} showSign />
              <SliderRow label="Contrast" value={opts.contrast} min={10} max={300} step={5}
                onChange={v => updateOpt("contrast", v)} unit="%" />
            </div>

            <div className="panel-section">
              <label className="section-label">Mode</label>
              <div className="toggle-grid">
                <ToggleRow label="Color" value={opts.color} onChange={v => updateOpt("color", v)} />
                <ToggleRow label="Edges" value={opts.edges} onChange={v => updateOpt("edges", v)} />
                <ToggleRow label="Dither" value={opts.dither} onChange={v => updateOpt("dither", v)} />
                <ToggleRow label="Invert" value={opts.invert} onChange={v => updateOpt("invert", v)} />
              </div>
            </div>

            <div className="panel-section">
              <label className="section-label">Character Set</label>
              <input
                className="charset-input"
                value={opts.charset}
                onChange={e => updateOpt("charset", e.target.value || DEFAULT_CHARSET)}
                spellCheck={false}
              />
              <div className="charset-presets">
                {[
                  ["Default", " .:-=+*#%@"],
                  ["Dense", " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@"],
                  ["Blocks", " ░▒▓█"],
                  ["Binary", " 01"],
                  ["Dots", " ·•●"],
                  ["Lines", " -=≡"],
                ].map(([name, set]) => (
                  <button key={name} className="btn btn-xs btn-ghost"
                    onClick={() => updateOpt("charset", set as string)}>
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <div className="panel-section">
              <label className="section-label">Reset</label>
              <button className="btn btn-ghost btn-full" onClick={() => setOpts({
                asciiW: 120, asciiH: 50, brightness: 0, contrast: 100,
                invert: false, color: false, edges: false, dither: false,
                charset: DEFAULT_CHARSET,
              })}>
                ↺ Reset all
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function SliderRow({
  label, value, min, max, step, onChange, unit = "", showSign = false,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; unit?: string; showSign?: boolean;
}) {
  const display = showSign && value > 0 ? `+${value}${unit}` : `${value}${unit}`;
  return (
    <div className="slider-row">
      <div className="slider-header">
        <span>{label}</span>
        <span className="slider-value">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="slider"
      />
    </div>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle-btn ${value ? "toggle-on" : ""}`} onClick={() => onChange(!value)}>
      <span className="toggle-indicator">{value ? "●" : "○"}</span>
      {label}
    </button>
  );
}

function frameToHtml(frame: AsciiFrame, color: boolean): string {
  if (!color) {
    return frame.map(row => row.map(c => c.char === " " ? "\u00a0" : c.char).join("")).join("\n");
  }
  const lines: string[] = [];
  for (const row of frame) {
    let line = "";
    for (const cell of row) {
      if (cell.char === " ") {
        line += "\u00a0";
      } else {
        line += `<span style="color:rgb(${cell.r},${cell.g},${cell.b})">${cell.char}</span>`;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

