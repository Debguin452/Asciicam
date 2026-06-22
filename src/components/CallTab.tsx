import { useCallback, useEffect, useRef, useState } from "react";
import { renderToString, resetTemporalSmoothing, sortCharsetByDensity, type AsciiOptions } from "../lib/ascii";
import { CallManager, type CallStatus, type RemoteFrame } from "../lib/call";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
}

type Facing = "user" | "environment";
type Layout = "split" | "fullRemote" | "fullLocal" | "pip";

const CALL_DEFAULTS: Partial<AsciiOptions> = {
  asciiW: 60,
  asciiH: 34,
  brightness: -20,
  contrast: 160,
  gamma: 1.1,
  temporalSmoothing: true,
  color: false,
};

export default function CallTab({ opts, updateOpt, fontSize, setFontSize }: Props) {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const remoteAudioRef   = useRef<HTMLAudioElement>(null);
  const offscreen        = useRef(document.createElement("canvas"));
  const localPreRef      = useRef<HTMLPreElement>(null);
  const remotePreRef     = useRef<HTMLPreElement>(null);
  const localAreaRef     = useRef<HTMLDivElement>(null);
  const remoteAreaRef    = useRef<HTMLDivElement>(null);
  const rootRef          = useRef<HTMLDivElement>(null);
  const rafRef           = useRef(0);
  const streamRef        = useRef<MediaStream | null>(null);
  const callRef          = useRef<CallManager | null>(null);
  const optsRef          = useRef(opts);
  const localFitRef      = useRef({ cols: 60, rows: 34 });
  const fontRef          = useRef(fontSize);
  const fpsTimesRef      = useRef<number[]>([]);
  const prevLocalIndices = useRef<Uint16Array | null>(null);

  // call state
  const [myId,       setMyId]       = useState("");
  const [joinCode,   setJoinCode]   = useState("");
  const [status,     setStatus]     = useState<CallStatus>("idle");
  const [statusMsg,  setStatusMsg]  = useState("");

  // local cam state
  const [camOn,    setCamOn]    = useState(false);
  const [muted,    setMuted]    = useState(false);
  const [facing,   setFacing]   = useState<Facing>("user");
  const [fps,      setFps]      = useState(0);
  const [camErr,   setCamErr]   = useState<string | null>(null);

  // UI state
  const [layout,   setLayout]   = useState<Layout>("split");
  const [fsMode,   setFsMode]   = useState(false);
  const [copied,   setCopied]   = useState(false);
  const [remoteActive, setRemoteActive] = useState(false);
  const [callColor, setCallColor] = useState(false);
  const isMobileRef = useRef(window.innerWidth <= 720);

  const connected = status === "connected";

  useEffect(() => { optsRef.current = opts; }, [opts]);
  useEffect(() => { fontRef.current = fontSize; }, [fontSize]);

  // Apply call-optimised defaults on mount
  useEffect(() => {
    Object.entries(CALL_DEFAULTS).forEach(([k, v]) => {
      updateOpt(k as keyof AsciiOptions, v as never);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fit ASCII grids to their panels
  const makeObserver = (areaRef: React.RefObject<HTMLDivElement>, fitRef: React.MutableRefObject<{cols:number;rows:number}>) =>
    new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (!width || !height) return;
      const fs = fontRef.current;
      fitRef.current = {
        cols: Math.max(10, Math.floor(width  / (fs * 0.575))),
        rows: Math.max(5,  Math.floor(height / (fs * 1.15))),
      };
    });

  useEffect(() => {
    if (!localAreaRef.current)  return;
    const obs = makeObserver(localAreaRef, localFitRef);
    obs.observe(localAreaRef.current);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Call manager lifecycle ────────────────────────────────────
  const initCall = useCallback(() => {
    const mgr = new CallManager({
      onStatus: (s, detail) => {
        setStatus(s);
        setStatusMsg(detail ?? "");
        if (s === "connected") setRemoteActive(false);
      },
      onRemoteFrame: (frame: RemoteFrame) => {
        setRemoteActive(true);
        renderRemoteFrame(frame);
      },
      onRemoteHangup: () => {
        setStatus("closed");
        setRemoteActive(false);
      },
      onRemoteStream: (remoteStream: MediaStream) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch(() => {});
        }
      },
    });
    callRef.current = mgr;
    mgr.start().then(setMyId).catch(() => {});
  }, []);

  useEffect(() => {
    initCall();
    return () => { callRef.current?.hangup(); };
  }, [initCall]);

  // ── Remote frame rendering ────────────────────────────────────
  // Renders a RemoteFrame directly to the pre element — no React
  // state update, no re-render. Runs every incoming frame.
  const renderRemoteFrame = (frame: RemoteFrame) => {
    const pre = remotePreRef.current;
    if (!pre) return;
    const { w, h, charset, charIndices, colors } = frame;
    const N = w * h;
    const lines: string[] = new Array(h);

    if (colors) {
      for (let y = 0; y < h; y++) {
        const rowOff = y * w;
        let line = "";
        for (let x = 0; x < w; x++) {
          const i = rowOff + x;
          const ci = charIndices[i];
          const ch = charset[ci] ?? " ";
          if (ch === " ") { line += "\u00a0"; continue; }
          const ri = i * 3;
          line += `<span style="color:rgb(${colors[ri]},${colors[ri+1]},${colors[ri+2]})">${escHtml(ch)}</span>`;
        }
        lines[y] = line;
      }
      pre.innerHTML = lines.join("\n");
    } else {
      for (let y = 0; y < h; y++) {
        const rowOff = y * w;
        let line = "";
        for (let x = 0; x < w; x++) {
          const ch = charset[charIndices[rowOff + x]] ?? " ";
          line += ch === " " ? "\u00a0" : escHtml(ch);
        }
        lines[y] = line;
      }
      pre.innerHTML = lines.join("\n");
    }
  };

  // ── Local render + send loop ──────────────────────────────────
  const renderLoop = useCallback(() => {
    const video = videoRef.current;
    const pre = localPreRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }
    const o = optsRef.current;
    const fit = localFitRef.current;
    const fullOpts: AsciiOptions = { ...o, asciiW: fit.cols, asciiH: fit.rows };

    const html = renderToString(video, offscreen.current, fullOpts, facing === "user", "html");
    if (html !== null) {
      pre.innerHTML = html;

      // Send to peer if connected
      if (callRef.current?.isConnected) {
        const { cols: w, rows: h } = fit;
        const charset = sortCharsetByDensity(o.charset || " .:-=+*#%@");
        const N = w * h;

        // Reuse or allocate index buffer
        if (!prevLocalIndices.current || prevLocalIndices.current.length !== N) {
          prevLocalIndices.current = new Uint16Array(N);
        }
        // Read char indices from the pool (they were just written by renderToString)
        // We access them via the shared pool — but renderToString doesn't expose the buffer.
        // So we re-extract from the rendered html cheaply: not ideal, but the cost of
        // re-extraction is one regex pass over a string we already built. Instead, we
        // use the lower-level renderToString with mode "text" for the send path to extract
        // indices more cheaply by scanning the text vs the charset.
        const text = renderToString(video, offscreen.current, fullOpts, facing === "user", "text");
        if (text) {
          const rows = text.split("\n");
          for (let y = 0; y < h; y++) {
            const row = rows[y] ?? "";
            const rowOff = y * w;
            for (let x = 0; x < w; x++) {
              const ch = row[x] ?? " ";
              prevLocalIndices.current[rowOff + x] = charset.indexOf(ch) < 0 ? 0 : charset.indexOf(ch);
            }
          }
          const colors = o.color ? extractColors(video, offscreen.current, w, h) : null;
          callRef.current.sendFrame(prevLocalIndices.current, w, h, charset, colors);
        }
      }

      // FPS counter
      const now = performance.now();
      fpsTimesRef.current.push(now);
      if (fpsTimesRef.current.length > 30) fpsTimesRef.current.shift();
      if (fpsTimesRef.current.length > 1) {
        const elapsed = fpsTimesRef.current.at(-1)! - fpsTimesRef.current[0];
        setFps(Math.round((fpsTimesRef.current.length - 1) / elapsed * 1000));
      }
    }
    rafRef.current = requestAnimationFrame(renderLoop);
  }, [facing]);

  useEffect(() => {
    if (camOn) rafRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [camOn, renderLoop]);

  // ── Camera control ────────────────────────────────────────────
  const startCamera = async (face: Facing = facing) => {
    setCamErr(null);
    resetTemporalSmoothing();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      // Answer pending call with this stream
      callRef.current?.answerWithStream(stream);
      setCamOn(true);
    } catch (e) {
      setCamErr(e instanceof Error ? e.message : "Camera access denied");
    }
  };

  const stopCamera = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (localPreRef.current) localPreRef.current.innerHTML = "";
    setCamOn(false);
    resetTemporalSmoothing();
  };

  const switchCamera = () => {
    const next: Facing = facing === "user" ? "environment" : "user";
    setFacing(next);
    if (camOn) startCamera(next);
  };

  const toggleMute = () => {
    const audio = streamRef.current?.getAudioTracks()[0];
    if (!audio) return;
    audio.enabled = !audio.enabled;
    setMuted(!audio.enabled);
  };

  // ── Call connect ──────────────────────────────────────────────
  const dial = () => {
    if (!joinCode.trim() || !myId) return;
    callRef.current?.connectTo(joinCode.trim(), streamRef.current);
  };

  const endCall = () => {
    callRef.current?.hangup();
    setStatus("closed");
    setRemoteActive(false);
    prevLocalIndices.current = null;
    setTimeout(initCall, 500);
  };

  // ── Fullscreen ────────────────────────────────────────────────
  const toggleFullscreen = async () => {
    const el = rootRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      await el.requestFullscreen?.().catch(() => {});
      if (fontSize > 4) setFontSize(4);
    } else {
      await document.exitFullscreen?.().catch(() => {});
    }
  };

  useEffect(() => {
    const onChange = () => setFsMode(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  // Copy code helper
  const copyId = () => {
    navigator.clipboard.writeText(myId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const callFontSize = Math.max(4, Math.min(fontSize, fsMode ? 4 : fontSize));

  return (
    <div className="call-root" ref={rootRef} data-layout={layout} data-fullscreen={fsMode}>
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />

      {/* ── CALL HEADER ── */}
      <div className="call-header">
        <div className="call-header-left">
          <span className={`call-status call-status-${status}`}>
            {statusIcon(status)} {statusLabel(status, statusMsg)}
          </span>
          {camOn && <span className="call-fps">{fps}fps</span>}
          {camErr && <span className="call-err">⚠ {camErr}</span>}
        </div>
        <div className="call-header-right">
          <button className="call-icon-btn" onClick={toggleFullscreen} title="Fullscreen">
            {fsMode ? "⊡" : "⛶"}
          </button>
          <button
            className="call-icon-btn"
            onClick={() => setLayout(l => nextLayout(l))}
            title="Change layout"
          >
            {layoutIcon(layout)}
          </button>
          {camOn && (
            <button className="call-icon-btn" onClick={switchCamera} title="Flip camera">
              ⟲
            </button>
          )}
          {camOn && (
            <button className={`call-icon-btn ${muted ? "call-icon-muted" : ""}`} onClick={toggleMute} title="Mute">
              {muted ? "🔇" : "🔊"}
            </button>
          )}
        </div>
      </div>

      {/* ── CONNECT PANEL ── */}
      {!connected && (
        <div className="call-connect">
          <div className="call-connect-row">
            <div className="call-id-group">
              <span className="call-label">Your code</span>
              <div className="call-id-display">
                <code className="call-id-code">{myId || "…"}</code>
                <button className="btn btn-ghost btn-xs" onClick={copyId} disabled={!myId}>
                  {copied ? "✓" : "Copy"}
                </button>
              </div>
            </div>
            <div className="call-join-group">
              <span className="call-label">Call someone</span>
              <div className="call-join-row">
                <input
                  className="call-input"
                  placeholder="Paste their code"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && dial()}
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <button
                  className="btn btn-primary"
                  onClick={dial}
                  disabled={!joinCode.trim() || !myId || status === "connecting"}
                >
                  {status === "connecting" ? "Calling…" : "Call"}
                </button>
              </div>
            </div>
          </div>
          <p className="call-hint">
            Share your code with the other person. Works peer-to-peer — no account needed.
          </p>
        </div>
      )}

      {/* ── CALL SCREENS ── */}
      <div className="call-screens">
        {/* LOCAL */}
        {(layout === "split" || layout === "fullLocal" || layout === "pip") && (
          <div
            ref={localAreaRef}
            className={`call-screen call-screen-local ${layout === "pip" ? "call-pip" : ""}`}
          >
            <span className="call-screen-tag">
              You {facing === "environment" ? "· back cam" : ""}
            </span>
            {!camOn ? (
              <div className="call-start-cam">
                <button className="btn btn-primary btn-lg" onClick={() => startCamera()}>
                  Start Camera
                </button>
                {camErr && <p className="call-err" style={{ marginTop: 8 }}>⚠ {camErr}</p>}
              </div>
            ) : (
              <pre
                ref={localPreRef}
                className="ascii-output call-pre"
                style={{ fontSize: `${callFontSize}px`, lineHeight: "1.1" }}
              />
            )}
          </div>
        )}

        {/* REMOTE */}
        {(layout === "split" || layout === "fullRemote" || layout === "pip") && (
          <div
            ref={remoteAreaRef}
            className={`call-screen call-screen-remote ${layout === "pip" ? "call-main" : ""}`}
          >
            <span className="call-screen-tag">Peer</span>
            {!remoteActive && (
              <div className="call-waiting">
                <p className="call-waiting-text">
                  {connected ? "Waiting for peer's camera…" : "Not connected"}
                </p>
              </div>
            )}
            <pre
              ref={remotePreRef}
              className="ascii-output call-pre"
              style={{ fontSize: `${callFontSize}px`, lineHeight: "1.1", display: remoteActive ? undefined : "none" }}
            />
          </div>
        )}
      </div>

      {/* ── BOTTOM CONTROLS ── */}
      <div className="call-controls">
        {!camOn ? (
          <button className="call-ctrl-btn call-ctrl-start" onClick={() => startCamera()}>
            Start Camera
          </button>
        ) : (
          <>
            <button
              className={`call-ctrl-btn call-ctrl-mic ${muted ? "off" : ""}`}
              onClick={toggleMute}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? "🔇" : "🎤"}
            </button>
            <button className="call-ctrl-btn call-ctrl-cam" onClick={stopCamera} title="Stop camera">
              📷
            </button>
            {connected && (
              <button className="call-ctrl-btn call-ctrl-end" onClick={endCall}>
                End Call
              </button>
            )}
          </>
        )}
        {/* Color mode toggle */}
        <button
          className={`call-ctrl-btn call-ctrl-color ${callColor ? "on" : ""}`}
          onClick={() => { setCallColor(c => !c); updateOpt("color", !callColor); }}
          title="Color mode"
        >
          🎨
        </button>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────
function escHtml(s: string): string {
  return s === "&" ? "&amp;" : s === "<" ? "&lt;" : s === ">" ? "&gt;" : s;
}

function extractColors(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  w: number,
  h: number
): Uint8Array {
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    out[i*3]   = px[i*4];
    out[i*3+1] = px[i*4+1];
    out[i*3+2] = px[i*4+2];
  }
  return out;
}

function statusIcon(s: CallStatus): string {
  if (s === "connected") return "●";
  if (s === "connecting") return "◌";
  if (s === "error") return "✗";
  return "○";
}

function statusLabel(s: CallStatus, detail: string): string {
  if (s === "idle") return "Starting…";
  if (s === "waiting") return "Ready · share your code";
  if (s === "connecting") return "Connecting…";
  if (s === "connected") return "Connected";
  if (s === "closed") return "Call ended";
  if (s === "error") return `Error: ${detail}`;
  return "";
}

function nextLayout(l: Layout): Layout {
  const order: Layout[] = ["split", "fullRemote", "pip", "fullLocal"];
  return order[(order.indexOf(l) + 1) % order.length];
}

function layoutIcon(l: Layout): string {
  if (l === "split")      return "⊞";
  if (l === "fullRemote") return "▣";
  if (l === "pip")        return "⊟";
  if (l === "fullLocal")  return "◈";
  return "⊞";
}
