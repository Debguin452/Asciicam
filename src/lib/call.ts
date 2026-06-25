import Peer, { type DataConnection, type MediaConnection } from "peerjs";

export interface RemoteState {
  micMuted: boolean;
  camOff: boolean;
}

export type CallStatus = "idle"|"connecting"|"waiting"|"connected"|"error"|"closed";

export type CallQualityLevel = "ultra" | "high" | "med" | "low" | "min";

export interface QualityParams {
  cols: number;
  rows: number;
  color: boolean;
  keyframeInterval: number;
  charset: string;
}

export const QUALITY_STEPS: Record<CallQualityLevel, QualityParams> = {
  ultra: { cols: 80,  rows: 46, color: true,  keyframeInterval: 60, charset: " .:-=+*#%@" },
  high:  { cols: 60,  rows: 34, color: false, keyframeInterval: 30, charset: " .:-=+*#%@" },
  med:   { cols: 44,  rows: 25, color: false, keyframeInterval: 20, charset: " .:-+*#@" },
  low:   { cols: 28,  rows: 16, color: false, keyframeInterval: 15, charset: " .:#@" },
  min:   { cols: 20,  rows: 12, color: false, keyframeInterval: 10, charset: " @" },
};

const QUALITY_ORDER: CallQualityLevel[] = ["min", "low", "med", "high"];

export interface RemoteFrame {
  w: number; h: number;
  charset: string;
  charIndices: Uint16Array;
  colors?: Uint8Array;
}

export interface CallManagerEvents {
  onStatus: (status: CallStatus, detail?: string) => void;
  onRemoteFrame: (frame: RemoteFrame) => void;
  onRemoteHangup: () => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteState?: (state: RemoteState) => void;
  onQualityChange?: (level: CallQualityLevel, params: QualityParams) => void;
}

// Free STUN + open TURN relays — enough for most NAT situations
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "turn:openrelay.metered.ca:80",               username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",              username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp",username: "openrelayproject", credential: "openrelayproject" },
];

function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (data && typeof data === "object" && "data" in data) {
    const inner = (data as { data: unknown }).data;
    if (inner instanceof Uint8Array) return inner.buffer.slice(inner.byteOffset, inner.byteOffset + inner.byteLength) as ArrayBuffer;
    if (Array.isArray(inner)) return new Uint8Array(inner as number[]).buffer;
  }
  return null;
}

function encode(
  charIndices: Uint16Array, w: number, h: number,
  charset: string, colors: Uint8Array | null,
  prevIndices: Uint16Array | null
): ArrayBuffer {
  const N = w * h;
  const charsetBytes = new TextEncoder().encode(charset);
  const isDelta = prevIndices !== null && prevIndices.length === N;
  const hasColor = colors !== null && colors.length === N * 3;
  let streamBytes: Uint8Array;

  if (isDelta && prevIndices) {
    const changed: number[] = [];
    for (let i = 0; i < N; i++) {
      if (charIndices[i] !== prevIndices[i]) changed.push(i, charIndices[i]);
    }
    const buf = new Uint16Array(changed.length);
    for (let i = 0; i < changed.length; i++) buf[i] = changed[i];
    streamBytes = new Uint8Array(buf.buffer);
  } else {
    const runs: number[] = [];
    let i = 0;
    while (i < N) {
      const val = charIndices[i]; let len = 1;
      while (i+len < N && charIndices[i+len] === val && len < 65535) len++;
      runs.push(val, len); i += len;
    }
    const buf = new Uint16Array(runs.length);
    for (let j = 0; j < runs.length; j++) buf[j] = runs[j];
    streamBytes = new Uint8Array(buf.buffer);
  }

  let flags = 0;
  if (hasColor) flags |= 0x01;
  if (isDelta)  flags |= 0x02;
  else          flags |= 0x04;

  const headerSize = 8 + charsetBytes.length;
  const colorSize = hasColor ? N * 3 : 0;
  const total = headerSize + streamBytes.length + colorSize;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1); view.setUint8(1, flags);
  view.setUint16(2, w, false); view.setUint16(4, h, false);
  view.setUint16(6, charsetBytes.length, false);
  out.set(charsetBytes, 8);
  out.set(streamBytes, headerSize);
  if (hasColor && colors) out.set(colors, headerSize + streamBytes.length);
  return out.buffer;
}

function decode(buf: ArrayBuffer, prevFrame: RemoteFrame | null): RemoteFrame | null {
  try {
    const view = new DataView(buf);
    const flags = view.getUint8(1);
    const w = view.getUint16(2, false), h = view.getUint16(4, false);
    const csLen = view.getUint16(6, false);
    const charset = new TextDecoder().decode(new Uint8Array(buf, 8, csLen));
    const N = w * h;
    const hasColor = !!(flags & 0x01), isDelta = !!(flags & 0x02);
    const streamStart = 8 + csLen;
    const streamEnd = hasColor ? buf.byteLength - N * 3 : buf.byteLength;
    const streamBytes = new Uint8Array(buf, streamStart, streamEnd - streamStart);
    const stream = new Uint16Array(streamBytes.buffer.slice(streamBytes.byteOffset, streamBytes.byteOffset + streamBytes.byteLength));
    const charIndices = new Uint16Array(N);

    if (isDelta) {
      if (prevFrame && prevFrame.charIndices.length === N) charIndices.set(prevFrame.charIndices);
      for (let i = 0; i < stream.length - 1; i += 2) {
        const pos = stream[i], idx = stream[i+1];
        if (pos < N) charIndices[pos] = idx;
      }
    } else {
      let pos = 0;
      for (let i = 0; i < stream.length - 1; i += 2) {
        const val = stream[i], len = stream[i+1];
        for (let j = 0; j < len && pos < N; j++) charIndices[pos++] = val;
      }
    }

    let colors: Uint8Array | undefined;
    if (hasColor) colors = new Uint8Array(buf.slice(streamEnd, streamEnd + N * 3));
    return { w, h, charset, charIndices, colors };
  } catch { return null; }
}

export class CallManager {
  private peer: Peer | null = null;
  private dataConn: DataConnection | null = null;
  private mediaConn: MediaConnection | null = null;
  private events: CallManagerEvents;
  private localStream: MediaStream | null = null;
  // Pending incoming call — answered as soon as we have a stream
  private pendingIncomingCall: MediaConnection | null = null;
  private prevSentIndices: Uint16Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private frameCount = 0;
  private keyframeInterval = 30;
  private lastSentAt = 0;
  private targetFps = 30;

  private qualityLevel: CallQualityLevel = "high";
  private recentSends = 0;
  private recentDrops = 0;
  private qualityCheckCounter = 0;
  private consecutiveGood = 0;
  private readonly CHECK_FRAMES = 30;

  constructor(events: CallManagerEvents) { this.events = events; }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: { iceServers: ICE_SERVERS } });
      this.peer = peer;

      peer.on("open", id => {
        this.events.onStatus("waiting", id);
        resolve(id);
      });

      // Incoming data channel from the caller
      peer.on("connection", conn => this.attachData(conn));

      // Incoming media call — answer immediately if we have a stream,
      // otherwise hold it until answerWithStream() is called
      peer.on("call", call => {
        this.mediaConn = call;
        if (this.localStream) {
          // Stream already available — answer right away
          call.answer(this.localStream);
          call.on("stream", s => this.events.onRemoteStream(s));
          call.on("close",  () => this.events.onRemoteHangup());
          call.on("error",  () => this.events.onRemoteHangup());
        } else {
          // Stream not ready yet — buffer, answer when stream arrives
          this.pendingIncomingCall = call;
        }
      });

      peer.on("error", err => {
        this.events.onStatus("error", err.message);
        reject(err);
      });

      peer.on("disconnected", () => {
        setTimeout(() => { try { peer.reconnect(); } catch { /**/ } }, 2000);
      });
    });
  }

  /** Call this as soon as the local MediaStream is available (after getUserMedia). */
  answerWithStream(stream: MediaStream) {
    this.localStream = stream;
    if (this.pendingIncomingCall) {
      const call = this.pendingIncomingCall;
      this.pendingIncomingCall = null;
      call.answer(stream);
      call.on("stream", s => this.events.onRemoteStream(s));
      call.on("close",  () => this.events.onRemoteHangup());
      call.on("error",  () => this.events.onRemoteHangup());
    }
  }

  /** Initiate an outgoing call + data connection to a remote peer. */
  connectTo(remoteId: string, stream: MediaStream | null) {
    if (!this.peer) return;
    this.events.onStatus("connecting", remoteId);
    this.localStream = stream;

    // Data channel — use "binary" serialization (BinaryPack)
    const conn = this.peer.connect(remoteId.trim(), { reliable: true, serialization: "binary" });
    this.attachData(conn);

    // Media call for audio (and optionally video if desired later)
    if (stream) {
      const call = this.peer.call(remoteId.trim(), stream);
      this.mediaConn = call;
      call.on("stream", s => this.events.onRemoteStream(s));
      call.on("close",  () => this.events.onRemoteHangup());
      call.on("error",  () => this.events.onRemoteHangup());
    }
  }

  private adaptQuality() {
    const dropRate = this.recentSends > 0 ? this.recentDrops / this.recentSends : 0;
    const idx = QUALITY_ORDER.indexOf(this.qualityLevel);
    if (idx === -1) return; // "ultra" — user-controlled

    if (dropRate > 0.3 && idx > 0) {
      this.consecutiveGood = 0;
      const next = QUALITY_ORDER[idx - 1];
      this.qualityLevel = next;
      this.keyframeInterval = QUALITY_STEPS[next].keyframeInterval;
      this.events.onQualityChange?.(next, QUALITY_STEPS[next]);
    } else if (dropRate < 0.05) {
      this.consecutiveGood++;
      if (this.consecutiveGood >= 3 && idx < QUALITY_ORDER.length - 1) {
        this.consecutiveGood = 0;
        const next = QUALITY_ORDER[idx + 1];
        this.qualityLevel = next;
        this.keyframeInterval = QUALITY_STEPS[next].keyframeInterval;
        this.events.onQualityChange?.(next, QUALITY_STEPS[next]);
      }
    } else {
      this.consecutiveGood = 0;
    }
  }

  private attachData(conn: DataConnection) {
    this.dataConn = conn;
    conn.on("open", () => this.events.onStatus("connected"));
    conn.on("data", (data: unknown) => {
      // State message — JSON object sent as-is over BinaryPack
      if (data && typeof data === "object" && !ArrayBuffer.isView(data)
          && !(data instanceof Blob) && !(data instanceof ArrayBuffer)
          && "type" in (data as Record<string, unknown>)
          && (data as { type: string }).type === "state") {
        const st = data as { type: string; micMuted: boolean; camOff: boolean };
        this.events.onRemoteState?.({ micMuted: st.micMuted, camOff: st.camOff });
        return;
      }
      // Binary frame
      const buf = toArrayBuffer(data);
      if (buf) {
        const frame = decode(buf, this.prevRecvFrame);
        if (frame) { this.prevRecvFrame = frame; this.events.onRemoteFrame(frame); }
        return;
      }
      // Blob fallback (shouldn't happen with binary serialization but guard anyway)
      if (data instanceof Blob) {
        data.arrayBuffer().then(ab => {
          const frame = decode(ab, this.prevRecvFrame);
          if (frame) { this.prevRecvFrame = frame; this.events.onRemoteFrame(frame); }
        }).catch(() => {});
      }
    });
    conn.on("close",  () => this.events.onStatus("closed"));
    conn.on("error", err => this.events.onStatus("error", err.message));
  }

  sendFrame(
    charIndices: Uint16Array, w: number, h: number,
    charset: string, colors: Uint8Array | null
  ) {
    if (!this.dataConn?.open) return;
    const now = performance.now();
    if (now - this.lastSentAt < 1000 / this.targetFps) return;
    this.lastSentAt = now;
    this.frameCount++;
    const isKey = this.frameCount % this.keyframeInterval === 1;
    const prev = isKey ? null : this.prevSentIndices;
    const buf = encode(charIndices, w, h, charset, colors, prev);

    this.recentSends++;
    try {
      this.dataConn.send(buf);
      if (!isKey && this.prevSentIndices?.length === charIndices.length) {
        this.prevSentIndices.set(charIndices);
      } else {
        this.prevSentIndices = new Uint16Array(charIndices);
      }
    } catch { this.recentDrops++; }

    this.qualityCheckCounter++;
    if (this.qualityCheckCounter >= this.CHECK_FRAMES) {
      this.adaptQuality();
      this.qualityCheckCounter = 0;
      this.recentSends = 0;
      this.recentDrops = 0;
    }
  }

  sendState(micMuted: boolean, camOff: boolean) {
    if (!this.dataConn?.open) return;
    try { this.dataConn.send({ type: "state", micMuted, camOff }); } catch { /**/ }
  }

  hangup() {
    this.frameCount = 0; this.prevSentIndices = null; this.prevRecvFrame = null;
    this.pendingIncomingCall = null;
    this.recentSends = 0; this.recentDrops = 0;
    this.qualityCheckCounter = 0; this.consecutiveGood = 0;
    this.qualityLevel = "high"; this.keyframeInterval = 30;
    try { this.dataConn?.close(); }  catch { /**/ }
    try { this.mediaConn?.close(); } catch { /**/ }
    try { this.peer?.destroy(); }    catch { /**/ }
    this.dataConn = null; this.mediaConn = null; this.peer = null;
    this.localStream = null;
  }

  setTargetFps(fps: number)        { this.targetFps = fps; }
  getQualityLevel(): CallQualityLevel { return this.qualityLevel; }
  setQualityLevel(level: CallQualityLevel) {
    this.qualityLevel = level;
    this.keyframeInterval = QUALITY_STEPS[level].keyframeInterval;
  }
  get isConnected() { return !!this.dataConn?.open; }
}
