import { useCallback, useEffect, useRef, useState } from "react";
import { getSortedCharset, resetTemporalSmoothing, DEFAULT_CHARSET, type AsciiOptions, type AsciiFrame } from "../lib/ascii";
import { encodeAsv, encodeFramesToText } from "../lib/format";
import { saveLibraryItem, makeThumbnail, genId } from "../lib/library";
import { makeFilename } from "../types";
import ControlsPanel from "./ControlsPanel";
import Modal from "./Modal";
import AsciiWorker from "../lib/ascii.worker?worker";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
  onLibraryUpdated: () => void;
}

export default function CameraTab({ opts, updateOpt, fontSize, setFontSize, onReset, onLibraryUpdated }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const offscreen = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const fpsTimesRef = useRef<number[]>([]);
  const recordedRef = useRef<AsciiFrame[]>([]);
  const captureOptsRef = useRef<AsciiOptions>(opts);
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recCount, setRecCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"stop-save" | "discard" | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 720);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 720);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => { captureOptsRef.current = opts; }, [opts]);

  useEffect(() => {
    try {
      const w = new AsciiWorker();
      workerRef.current = w;
      return () => w.terminate();
    } catch { /* fallback to main thread */ }
  }, []);

  const renderFrameMain = useCallback(() => {
    const video = videoRef.current;
    const pre = preRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderFrameMain);
      return;
    }

    const { asciiW, asciiH, color } = captureOptsRef.current;
    offscreen.current.width = asciiW;
    offscreen.current.height = asciiH;
    const ctx = offscreen.current.getContext("2d", { willReadFrequently: true })!;
    ctx.save(); ctx.scale(-1, 1); ctx.drawImage(video, -asciiW, 0, asciiW, asciiH); ctx.restore();
    const imgData = ctx.getImageData(0, 0, asciiW, asciiH);

    const worker = workerRef.current;
    if (worker && !pendingRef.current) {
      pendingRef.current = true;
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type !== "result") return;
        if (preRef.current) preRef.current.innerHTML = e.data.html;
        if (recording) {
          const o = captureOptsRef.current;
          const charset = o.charset || DEFAULT_CHARSET;
          const sorted = getSortedCharset(charset, o.charDensitySort);
          const frame: AsciiFrame = (e.data.indices as number[][]).map(row =>
            row.map((ci) => ({ char: sorted[ci] ?? " ", charIdx: ci, r: 0, g: 0, b: 0 }))
          );
          recordedRef.current.push(frame);
          setRecCount(recordedRef.current.length);
        }
        pendingRef.current = false;
      };
      worker.postMessage({ type: "frame", data: { pixels: imgData.data, opts: captureOptsRef.current } });
    }

    const now = performance.now();
    fpsTimesRef.current.push(now);
    if (fpsTimesRef.current.length > 30) fpsTimesRef.current.shift();
    if (fpsTimesRef.current.length > 1) {
      const elapsed = fpsTimesRef.current.at(-1)! - fpsTimesRef.current[0];
      setFps(Math.round(((fpsTimesRef.current.length - 1) / elapsed) * 1000));
    }

    rafRef.current = requestAnimationFrame(renderFrameMain);
  }, [recording]);

  useEffect(() => {
    if (running) rafRef.current = requestAnimationFrame(renderFrameMain);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, renderFrameMain]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  const startCamera = async () => {
    setError(null);
    resetTemporalSmoothing();
    workerRef.current?.postMessage({ type: "reset" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setRunning(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Camera access denied"); }
  };

  const stopCamera = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (preRef.current) preRef.current.innerHTML = "";
    setRunning(false); setFps(0); setRecording(false);
    fpsTimesRef.current = [];
    resetTemporalSmoothing();
  };

  const captureFrame = () => {
    if (!preRef.current) return;
    const text = preRef.current.innerText;
    triggerDownload(new Blob([text], { type: "text/plain" }), makeFilename("asciiphoto", "txt"));
  };

  const startRecording = () => { recordedRef.current = []; setRecCount(0); setLastSaved(null); setRecording(true); };
  const stopRecordingAndSave = () => setConfirm("stop-save");
  const discardRecording = () => setConfirm("discard");

  const doSave = async (format: "asv" | "txt") => {
    const frames = recordedRef.current;
    if (!frames.length) return;
    setSaving(true);
    const o = captureOptsRef.current;
    const charset = o.charset || DEFAULT_CHARSET;
    try {
      if (format === "asv") {
        const { data } = await encodeAsv(frames, charset, o.asciiW, o.asciiH, o.color, fps || 15, o);
        triggerDownload(new Blob([data as BlobPart]), makeFilename("asciivideo", "asv"));
      } else {
        const text = encodeFramesToText(frames, charset, o.asciiW, o.asciiH);
        triggerDownload(new Blob([text], { type: "text/plain" }), makeFilename("asciivideo", "txt"));
      }
      await autoSaveToLibrary(frames, charset, o);
    } finally { setSaving(false); setRecording(false); setConfirm(null); }
  };

  const autoSaveToLibrary = async (frames: AsciiFrame[], charset: string, o: AsciiOptions) => {
    const idxFrames = frames.map(f => f.map(row => row.map(c => c.charIdx)));
    const colorFrames = o.color ? frames.map(f => f.map(row => row.map(c => [c.r, c.g, c.b]))) : undefined;
    const name = makeFilename("rec", "asv");
    await saveLibraryItem({
      id: genId(), name, createdAt: Date.now(), source: "recording", kind: "video",
      charset, asciiW: o.asciiW, asciiH: o.asciiH,
      frameCount: idxFrames.length, frames: idxFrames, colorFrames,
      thumbnail: makeThumbnail(idxFrames, charset, o.asciiW, o.asciiH),
    });
    onLibraryUpdated();
    setLastSaved(name);
  };

  return (
    <div className="tab-content">
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      {/* Desktop toolbar */}
      {!isMobile && (
        <div className="toolbar">
          <div className="toolbar-left">
            {running && <span className={`fps-badge${fps < 8 ? " fps-low" : ""}`}>{fps} fps</span>}
            {recording && <span className="rec-badge">● REC {recCount}</span>}
            {lastSaved && <span className="fps-badge">✓ saved</span>}
            {error && <span className="error-badge">⚠ {error}</span>}
          </div>
          <div className="toolbar-right">
            {running && !recording && (
              <>
                <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")}>Copy</button>
                <button className="btn btn-ghost" onClick={captureFrame} disabled={saving}>Save Frame</button>
                <button className="btn btn-primary" onClick={startRecording}>● Record</button>
              </>
            )}
            {running && recording && (
              <>
                <button className="btn btn-danger" onClick={stopRecordingAndSave} disabled={saving}>■ Stop & Save</button>
                <button className="btn btn-ghost" onClick={discardRecording}>Discard</button>
              </>
            )}
            <button className={`btn ${running ? "btn-danger" : "btn-primary"}`} onClick={running ? stopCamera : startCamera}>
              {running ? "Stop" : "Start Camera"}
            </button>
            <button className="btn btn-ghost" onClick={() => setPanelOpen(o => !o)}>
              {panelOpen ? "▼" : "▲"} Controls
            </button>
          </div>
        </div>
      )}

      {/* Mobile status bar */}
      {isMobile && running && (
        <div className="toolbar">
          <div className="toolbar-left">
            <span className={`fps-badge${fps < 8 ? " fps-low" : ""}`}>{fps} fps</span>
            {recording && <span className="rec-badge">● REC {recCount}</span>}
            {error && <span className="error-badge">⚠ {error}</span>}
          </div>
          <div className="toolbar-right">
            <button className="btn btn-ghost btn-sm" onClick={stopCamera}>Stop</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPanelOpen(o => !o)}>Controls</button>
          </div>
        </div>
      )}

      <div className="main-layout">
        <div className="ascii-area">
          {!running && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={startCamera}>Start Camera</button>
              <p className="splash-hint">Live video → ASCII art · fully in your browser</p>
              <p className="splash-hint">Works offline after first load</p>
              {error && <p className="error-badge">⚠ {error}</p>}
            </div>
          )}
          <pre ref={preRef} className="ascii-output" style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }} />
        </div>
        {panelOpen && (
          <ControlsPanel opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={onReset} />
        )}
      </div>

      {/* Mobile camera-app controls */}
      {isMobile && running && (
        <div className="cam-controls-mobile">
          <button
            className="cam-side-btn"
            onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")}
            title="Copy"
          >⎘</button>
          {!recording ? (
            <>
              <button className="cam-capture-btn" onClick={captureFrame} title="Capture frame" />
              <button className="cam-record-btn" onClick={startRecording} title="Start recording">●</button>
            </>
          ) : (
            <>
              <button className="cam-side-btn" onClick={discardRecording} title="Discard">✕</button>
              <button className={`cam-record-btn recording`} onClick={stopRecordingAndSave} title="Stop & save">■</button>
            </>
          )}
          <button
            className="cam-side-btn"
            onClick={captureFrame}
            title="Save frame"
          >↓</button>
        </div>
      )}

      {confirm === "stop-save" && (
        <Modal
          title="Save Recording"
          message={`Save ${recCount} frames? Choose format — .asv is recommended (compact, re-importable).`}
          confirmLabel="Save .asv"
          cancelLabel="Save .txt"
          onConfirm={() => doSave("asv")}
          onCancel={() => doSave("txt")}
          extraAction={{ label: "Discard", onClick: () => { setRecording(false); setConfirm(null); }, danger: true }}
        />
      )}
      {confirm === "discard" && (
        <Modal
          title="Discard Recording"
          message={`Discard all ${recCount} recorded frames? This cannot be undone.`}
          confirmLabel="Discard"
          cancelLabel="Keep Recording"
          onConfirm={() => { recordedRef.current = []; setRecording(false); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
          danger
        />
      )}
    </div>
  );
}

function triggerDownload(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
