import { useCallback, useEffect, useRef, useState } from "react";
import { renderToHtml, snapshotFromBuffers, processFrame, resetTemporalSmoothing, type AsciiOptions, type AsciiFrame } from "../lib/ascii";
import { saveLibraryItem, makeThumbnail, genId } from "../lib/library";
import { exportGif, exportMp4, exportPng, exportJpeg, exportSvg, exportHtml, framesToText } from "../lib/export";
import { makeFilename, triggerDownload, getExportBg } from "../types";
import ControlsPanel from "./ControlsPanel";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
  onLibraryUpdated: () => void;
  exportFg: string;
  onExportFgChange: (v: string) => void;
}

type Stage = "idle" | "live" | "recording" | "choosing" | "exporting";

export default function CameraTab({ opts, updateOpt, fontSize, setFontSize, onReset, onLibraryUpdated, exportFg, onExportFgChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const offscreen = useRef(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const optsRef = useRef(opts);
  const recordedRef = useRef<AsciiFrame[]>([]);
  const liveFpsRef = useRef(15);
  const fpsTimesRef = useRef<number[]>([]);
  const lastRenderRef = useRef<{ drawW: number; drawH: number; chars: string } | null>(null);
  const stageRef = useRef<Stage>("idle");
  const fitRef = useRef({ cols: 80, rows: 40 });
  const fontSizeRef = useRef(fontSize);
  const displayFsRef = useRef(fontSize);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const lastFrameTime = useRef(0);

  const [stage, setStageState] = useState<Stage>("idle");
  const [capturedCount, setCapturedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [recCount, setRecCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 720);
  const [exportStatus, setExportStatus] = useState("");
  const [isMobile] = useState(() => window.innerWidth <= 720);

  const setStage = (s: Stage) => { stageRef.current = s; setStageState(s); };

  useEffect(() => { optsRef.current = opts; }, [opts]);

  // Auto-size the ASCII grid to fill the ascii-area exactly.
  // fitRef tracks cols/rows for processFrame; displayFsRef tracks the font size
  // that makes that grid fill the container (decoupled from the user "detail" slider).
  const CHAR_W_RATIO = 0.575;
  const CHAR_H_RATIO = 1.15;

  const recompute = () => {
    const area = areaRef.current;
    if (!area) return;
    const W = area.clientWidth;
    const H = area.clientHeight;
    if (!W || !H) return;
    const fs = fontSizeRef.current;
    const cols = Math.max(10, Math.floor(W / (fs * CHAR_W_RATIO)));
    const rows = Math.max(5,  Math.floor(H / (fs * CHAR_H_RATIO)));
    fitRef.current = { cols, rows };
    // font size that makes the grid fill the container
    const dfx = W / (cols * CHAR_W_RATIO);
    const dfy = H / (rows * CHAR_H_RATIO);
    displayFsRef.current = Math.min(dfx, dfy);
  };

  useEffect(() => {
    fontSizeRef.current = fontSize;
    recompute();
  }, [fontSize]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const obs = new ResizeObserver(() => recompute());
    obs.observe(area);
    recompute();
    return () => obs.disconnect();
  }, []);

  const renderLoop = useCallback((timestamp: number) => {
    const video = videoRef.current;
    const pre = preRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    // Cap at 30fps to balance quality vs CPU (video call feel without burning battery)
    const elapsed = timestamp - lastFrameTime.current;
    if (elapsed < 33) { rafRef.current = requestAnimationFrame(renderLoop); return; }
    lastFrameTime.current = timestamp - (elapsed % 33);

    const result = renderToHtml(video, offscreen.current, {
      ...optsRef.current,
      asciiW: fitRef.current.cols,
      asciiH: fitRef.current.rows,
    }, true);

    if (result) {
      pre.innerHTML = result.html;
      pre.style.fontSize = `${displayFsRef.current.toFixed(2)}px`;
      pre.style.lineHeight = "1.15";
      lastRenderRef.current = { drawW: result.drawW, drawH: result.drawH, chars: result.chars };

      if (stageRef.current === "recording") {
        // Snapshot shared buffers immediately — they're valid until next renderToHtml call
        const frame = snapshotFromBuffers(result.drawW, result.drawH, result.chars, optsRef.current);
        recordedRef.current.push(frame);
        setRecCount(c => c + 1);
      }

      const now = performance.now();
      fpsTimesRef.current.push(now);
      if (fpsTimesRef.current.length > 20) fpsTimesRef.current.shift();
      if (fpsTimesRef.current.length > 1) {
        const f = Math.round((fpsTimesRef.current.length - 1) / (now - fpsTimesRef.current[0]) * 1000);
        setFps(f); liveFpsRef.current = f || 15;
      }
    }
    rafRef.current = requestAnimationFrame(renderLoop);
  }, []);

  useEffect(() => {
    if (stage === "live" || stage === "recording") {
      rafRef.current = requestAnimationFrame(renderLoop);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [stage, renderLoop]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const s = stageRef.current;
      if (e.code === "Space") { e.preventDefault(); if (s === "idle") startCamera(); else if (s === "live" || s === "recording") stopAndChoose(); }
      if (e.code === "KeyR" && s === "live") startRecording();
      if (e.code === "KeyR" && s === "recording") stopAndChoose();
      if (e.code === "KeyC" && (s === "live" || s === "recording")) captureFrame();
      if (e.code === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const stopStream = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const startCamera = async () => {
    setError(null);
    resetTemporalSmoothing();
    if (window.innerWidth > 720) setPanelOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setStage("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Camera access denied");
    }
  };

  const stopCamera = () => {
    stopStream();
    if (preRef.current) preRef.current.innerHTML = "";
    recordedRef.current = [];
    setStage("idle"); setFps(0); setRecCount(0); setCapturedCount(0);
    fpsTimesRef.current = [];
    resetTemporalSmoothing();
  };

  const startRecording = () => {
    recordedRef.current = [];
    setRecCount(0);
    setStage("recording");
  };

  const captureFrame = () => {
    stopStream();
    const last = lastRenderRef.current;
    if (last) {
      const frame = snapshotFromBuffers(last.drawW, last.drawH, last.chars, optsRef.current);
      recordedRef.current = [frame];
    } else {
      recordedRef.current = [];
    }
    setCapturedCount(recordedRef.current.length);
    setStage("choosing");
  };

  const stopAndChoose = () => {
    stopStream();
    setCapturedCount(recordedRef.current.length);
    setStage("choosing");
  };

  const discard = () => {
    recordedRef.current = [];
    setRecCount(0); setCapturedCount(0);
    if (preRef.current) preRef.current.innerHTML = "";
    setStage("idle");
  };

  const doExport = async (format: "txt" | "png" | "jpeg" | "svg" | "html" | "gif" | "mp4") => {
    const frames = recordedRef.current;
    const isMulti = frames.length > 1;
    const o = optsRef.current;
    const bg = getExportBg(exportFg);
    const exportFontSize = Math.max(12, fontSize); // min 12px for quality exports
    setStage("exporting");
    setExportStatus(`Generating ${format.toUpperCase()}…`);
    try {
      if (format === "txt") {
        const text = frames.length ? framesToText(frames) : (preRef.current?.innerText ?? "");
        triggerDownload(new Blob([text], { type: "text/plain" }), makeFilename("ascii", "txt"));
      } else if (format === "png") {
        const f = frames[0]; if (!f) throw new Error("No frame");
        triggerDownload(await exportPng(f, exportFontSize, exportFg, bg, o.color), makeFilename("ascii", "png"));
      } else if (format === "jpeg") {
        const f = frames[0]; if (!f) throw new Error("No frame");
        triggerDownload(await exportJpeg(f, exportFontSize, exportFg, bg, o.color), makeFilename("ascii", "jpg"));
      } else if (format === "svg") {
        const f = frames[0]; if (!f) throw new Error("No frame");
        triggerDownload(exportSvg(f, exportFontSize, exportFg, bg, o.color), makeFilename("ascii", "svg"));
      } else if (format === "html") {
        const f = frames[0]; if (!f) throw new Error("No frame");
        triggerDownload(exportHtml(f, exportFontSize, exportFg, bg, o.color), makeFilename("ascii", "html"));
      } else if (format === "gif") {
        if (!isMulti) throw new Error("No frames for GIF");
        triggerDownload(await exportGif(frames, exportFontSize, exportFg, bg, o.color, liveFpsRef.current), makeFilename("ascii", "gif"));
      } else if (format === "mp4") {
        if (!isMulti) throw new Error("No frames for MP4");
        const blob = await exportMp4(frames, exportFontSize, exportFg, bg, o.color, liveFpsRef.current);
        triggerDownload(blob, makeFilename("ascii", blob.type.includes("webm") ? "webm" : "mp4"));
      }
      await saveToLibrary(frames, o);
      onLibraryUpdated();
      setStage("idle");
      recordedRef.current = [];
      setRecCount(0); setCapturedCount(0);
      if (preRef.current) preRef.current.innerHTML = "";
    } catch (err) {
      console.error(err);
      setExportStatus("Export failed — " + (err instanceof Error ? err.message : "unknown"));
      setTimeout(() => setStage("choosing"), 2000);
    }
  };

  const saveToLibrary = async (frames: AsciiFrame[], o: AsciiOptions) => {
    if (!frames.length) return;
    const charset = o.charset || " .:-=+*#%@";
    const frameH = frames[0].length;
    const frameW = frames[0][0]?.length ?? 0;
    const idxFrames = frames.map(f => f.map(row => row.map(c => c.charIdx)));
    const colorFrames = o.color ? frames.map(f => f.map(row => row.map(c => [c.r, c.g, c.b]))) : undefined;
    await saveLibraryItem({
      id: genId(),
      name: makeFilename(frames.length > 1 ? "rec" : "capture", "txt"),
      createdAt: Date.now(), source: "recording",
      kind: frames.length > 1 ? "video" : "image",
      charset, asciiW: frameW, asciiH: frameH,
      frameCount: idxFrames.length, frames: idxFrames, colorFrames,
      thumbnail: makeThumbnail(idxFrames, charset, frameW, frameH),
      fps: liveFpsRef.current,
    });
  };

  const isMulti = capturedCount > 1;

  return (
    <div className="tab-content">
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      <div className="toolbar">
        <div className="toolbar-left">
          {(stage === "live" || stage === "recording") && (
            <span className={`badge${fps < 8 ? " badge-warn" : ""}`}>{fps} fps</span>
          )}
          {stage === "recording" && <span className="badge badge-rec">● REC {recCount}f</span>}
          {error && <span className="badge badge-err">⚠ {error}</span>}
        </div>
        <div className="toolbar-right">
          {stage === "idle" && (
            <button className="btn btn-primary" onClick={startCamera}>Start Camera</button>
          )}
          {stage === "live" && (
            <>
              <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")}>Copy</button>
              <button className="btn btn-ghost" onClick={captureFrame}>Capture</button>
              <button className="btn btn-primary" onClick={startRecording}>● Record</button>
              <button className="btn btn-ghost" onClick={stopCamera}>Stop</button>
            </>
          )}
          {stage === "recording" && (
            <>
              <button className="btn btn-danger" onClick={stopAndChoose}>■ Stop</button>
              <button className="btn btn-ghost" onClick={discard}>Discard</button>
            </>
          )}
          {(stage === "live" || stage === "recording") && (
            <button className="btn btn-ghost" onClick={() => setPanelOpen(o => !o)}>
              Controls {panelOpen ? "▲" : "▼"}
            </button>
          )}
          <input ref={colorInputRef} type="color" value={exportFg} onChange={e => onExportFgChange(e.target.value)}
            style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }} tabIndex={-1} />
          <button className="btn btn-ghost color-pick-btn" onClick={() => colorInputRef.current?.click()} title="Export font color">
            <span className="color-swatch" style={{ background: exportFg }} />
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div ref={areaRef} className="ascii-area">
          {stage === "idle" && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={startCamera}>Start Camera</button>
              <p className="splash-hint">Live video → ASCII art · runs in your browser</p>
              <p className="splash-hint">Works offline after first load</p>
              {error && <p className="badge badge-err" style={{ marginTop: 8 }}>⚠ {error}</p>}
              <p className="splash-hint" style={{ marginTop: 8, fontSize: 10 }}>
                Space · start/stop &nbsp; R · record &nbsp; C · capture &nbsp; Esc · close panel
              </p>
            </div>
          )}
          <pre ref={preRef} className="ascii-output" />
        </div>
        {panelOpen && (stage === "live" || stage === "recording") && (
          <div className="controls-panel-wrap">
            <ControlsPanel opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={onReset} />
          </div>
        )}
      </div>

      {isMobile && (stage === "live" || stage === "recording") && (
        <div className="cam-controls-mobile">
          <button className="cam-side-btn" onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")} title="Copy">⎘</button>
          {stage === "live" ? (
            <>
              <button className="cam-capture-btn" onClick={captureFrame} title="Capture" />
              <button className="cam-record-btn" onClick={startRecording} title="Record">●</button>
            </>
          ) : (
            <>
              <button className="cam-side-btn" onClick={discard} title="Discard">✕</button>
              <button className="cam-record-btn recording" onClick={stopAndChoose} title="Stop">■</button>
            </>
          )}
          <button className="cam-side-btn" onClick={() => setPanelOpen(o => !o)} title="Controls">⚙</button>
        </div>
      )}

      {stage === "choosing" && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">Choose Output</div>
            <div className="modal-message">
              {isMulti ? `${capturedCount} frames recorded.` : "Single frame captured."} Select format:
            </div>
            <div className="export-grid">
              <button className="export-opt" onClick={() => doExport("txt")}>
                <span className="export-opt-icon">TXT</span>
                <span className="export-opt-label">Plain text</span>
              </button>
              <button className="export-opt" onClick={() => doExport("png")}>
                <span className="export-opt-icon">PNG</span>
                <span className="export-opt-label">Hi-res image</span>
              </button>
              <button className="export-opt" onClick={() => doExport("jpeg")}>
                <span className="export-opt-icon">JPG</span>
                <span className="export-opt-label">Hi-res image</span>
              </button>
              <button className="export-opt" onClick={() => doExport("svg")}>
                <span className="export-opt-icon">SVG</span>
                <span className="export-opt-label">Vector + color</span>
              </button>
              <button className="export-opt" onClick={() => doExport("html")}>
                <span className="export-opt-icon">HTML</span>
                <span className="export-opt-label">Color text</span>
              </button>
              {isMulti && (
                <>
                  <button className="export-opt" onClick={() => doExport("gif")}>
                    <span className="export-opt-icon">GIF</span>
                    <span className="export-opt-label">Animated</span>
                  </button>
                  <button className="export-opt" onClick={() => doExport("mp4")}>
                    <span className="export-opt-icon">MP4</span>
                    <span className="export-opt-label">Video</span>
                  </button>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={discard}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {stage === "exporting" && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">Exporting</div>
            <div className="modal-message">{exportStatus}</div>
          </div>
        </div>
      )}
    </div>
  );
}
