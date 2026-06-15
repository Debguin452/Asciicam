import { useCallback, useEffect, useRef, useState } from "react";
import { processFrame, frameToHtml, DEFAULT_CHARSET, type AsciiOptions, type AsciiFrame } from "../lib/ascii";
import { encodeFramesToBinary, encodeFramesToText, gzipCompress } from "../lib/binary";
import { saveLibraryItem, makeThumbnail, genId } from "../lib/library";
import ControlsPanel from "./ControlsPanel";
import Modal from "./Modal";

interface CameraTabProps {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
  onLibraryUpdated: () => void;
}

export default function CameraTab({ opts, updateOpt, fontSize, setFontSize, onReset, onLibraryUpdated }: CameraTabProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const fpsCounterRef = useRef<{ times: number[] }>({ times: [] });
  const recordedFramesRef = useRef<AsciiFrame[]>([]);
  const recordDimsRef = useRef<{ w: number; h: number; charset: string } | null>(null);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [confirmAction, setConfirmAction] = useState<"txt" | "bin" | "save" | null>(null);

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
    if (running) {
      rafRef.current = requestAnimationFrame(renderFrame);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, renderFrame]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const startCamera = async () => {
    setError(null);
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
    fpsCounterRef.current = { times: [] };
  };

  const copyAscii = () => {
    if (!preRef.current) return;
    navigator.clipboard.writeText(preRef.current.innerText);
  };

  const downloadAscii = () => {
    if (!preRef.current) return;
    const blob = new Blob([preRef.current.innerText], { type: "text/plain" });
    triggerDownload(blob, "ascii-frame.txt");
  };

  const triggerDownload = (data: Blob, filename: string) => {
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
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

  const doExportText = () => {
    const dims = recordDimsRef.current;
    const frames = recordedFramesRef.current;
    if (!dims || frames.length === 0) return;
    const text = encodeFramesToText(frames, dims.charset, dims.w, dims.h);
    triggerDownload(new Blob([text], { type: "text/plain" }), "ascii-video.txt");
    setConfirmAction(null);
  };

  const doExportBinary = async () => {
    const dims = recordDimsRef.current;
    const frames = recordedFramesRef.current;
    if (!dims || frames.length === 0) return;
    const raw = encodeFramesToBinary(frames, dims.charset, dims.w, dims.h);
    const compressed = await gzipCompress(raw);
    triggerDownload(new Blob([compressed as BlobPart], { type: "application/octet-stream" }), "ascii-video.bin.gz");
    setConfirmAction(null);
  };

  const doSaveToLibrary = async () => {
    const dims = recordDimsRef.current;
    const frames = recordedFramesRef.current;
    if (!dims || frames.length === 0) return;
    const indexFrames = frames.map(f => f.map(row => row.map(c => c.charIdx)));
    await saveLibraryItem({
      id: genId(),
      name: `Recording ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      source: "recording",
      charset: dims.charset,
      asciiW: dims.w,
      asciiH: dims.h,
      frameCount: indexFrames.length,
      frames: indexFrames,
      thumbnail: makeThumbnail(indexFrames, dims.charset, dims.w, dims.h),
    });
    onLibraryUpdated();
    setConfirmAction(null);
  };

  return (
    <div className="tab-content">
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      <div className="toolbar">
        <div className="toolbar-left">
          {running && <span className="fps-badge">{fps} fps</span>}
          {recording && <span className="rec-badge">● rec {recordedCount}</span>}
          {error && <span className="error-badge">⚠ {error}</span>}
        </div>
        <div className="toolbar-right">
          {running && (
            <>
              <button className="btn btn-ghost" onClick={copyAscii} title="Copy current frame">Copy</button>
              <button className="btn btn-ghost" onClick={downloadAscii} title="Save current frame as .txt">Save Frame</button>
              <button
                className={`btn ${recording ? "btn-danger" : "btn-ghost"}`}
                onClick={toggleRecording}
              >
                {recording ? "Stop Recording" : "Record"}
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmAction("txt")} disabled={recordedCount === 0}>
                Export TXT
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmAction("bin")} disabled={recordedCount === 0}>
                Export BIN
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmAction("save")} disabled={recordedCount === 0}>
                Save to Library
              </button>
            </>
          )}
          <button
            className={`btn ${running ? "btn-danger" : "btn-primary"}`}
            onClick={running ? stopCamera : startCamera}
          >
            {running ? "Stop" : "Start Camera"}
          </button>
          <button className="btn btn-ghost panel-toggle" onClick={() => setPanelOpen(o => !o)}>
            {panelOpen ? "Hide Controls" : "Show Controls"}
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div className="ascii-area">
          {!running && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={startCamera}>
                Start Camera
              </button>
              <p className="splash-hint">Live video to ASCII, rendered entirely in your browser</p>
            </div>
          )}
          <pre
            ref={preRef}
            className="ascii-output"
            style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }}
          />
        </div>

        {panelOpen && (
          <ControlsPanel opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={onReset} />
        )}
      </div>

      {confirmAction === "txt" && (
        <Modal
          title="Export as TXT"
          message={`Download ${recordedCount} recorded frames as a plain-text ASCII video file?`}
          confirmLabel="Export"
          onConfirm={doExportText}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === "bin" && (
        <Modal
          title="Export as compressed binary"
          message={`Download ${recordedCount} recorded frames as a gzip-compressed .bin file?`}
          confirmLabel="Export"
          onConfirm={doExportBinary}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === "save" && (
        <Modal
          title="Save to Library"
          message={`Save this recording (${recordedCount} frames) to your local library for playback later?`}
          confirmLabel="Save"
          onConfirm={doSaveToLibrary}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
