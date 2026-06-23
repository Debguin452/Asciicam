import Peer, { type DataConnection, type MediaConnection } from "peerjs";

export type CallStatus = "idle"|"connecting"|"waiting"|"connected"|"error"|"closed";

export interface RemoteFrame {
  w: number; h: number;
  charset: string;
  charIndices: Uint16Array;
  colors?: Uint8Array; // r,g,b per cell
}

export interface CallManagerEvents {
  onStatus: (status: CallStatus, detail?: string) => void;
  onRemoteFrame: (frame: RemoteFrame) => void;
  onRemoteHangup: () => void;
  onRemoteStream: (stream: MediaStream) => void;
}

// Free STUN + Open Relay free TURN (no signup required)
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:global.stun.twilio.com:3478" },
  // Open Relay free TURN — handles symmetric NAT (no account needed)
  { urls: "turn:openrelay.metered.ca:80",       username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",      username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  // PeerJS "binary" (BinaryPack) typically decodes to Uint8Array
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  // BinaryPack may wrap as { data: number[], type: "Buffer" }
  if (data && typeof data === "object" && "data" in data) {
    const inner = (data as { data: unknown }).data;
    if (inner instanceof Uint8Array) return inner.buffer.slice(inner.byteOffset, inner.byteOffset + inner.byteLength) as ArrayBuffer;
    if (Array.isArray(inner)) return new Uint8Array(inner as number[]).buffer;
  }
  if (data instanceof Blob) return null; // handled async by caller
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
    // Delta: [pos u16, charIdx u16] pairs for changed cells only
    const changed: number[] = [];
    for (let i = 0; i < N; i++) {
      if (charIndices[i] !== prevIndices[i]) changed.push(i, charIndices[i]);
    }
    const buf = new Uint16Array(changed.length);
    for (let i = 0; i < changed.length; i++) buf[i] = changed[i];
    streamBytes = new Uint8Array(buf.buffer);
  } else {
    // RLE keyframe: [charIdx u16, runLen u16] pairs
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
  private pendingCall: MediaConnection | null = null;
  private events: CallManagerEvents;
  private localStream: MediaStream | null = null;
  private prevSentIndices: Uint16Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private frameCount = 0;
  private keyframeInterval = 30;
  private lastSentAt = 0;
  private targetFps = 30;

  constructor(events: CallManagerEvents) { this.events = events; }

  setLocalStream(stream: MediaStream) { this.localStream = stream; }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use PeerJS cloud (free, no account needed)
      const peer = new Peer({
        config: { iceServers: ICE_SERVERS },
        // debug: 1, // uncomment to see connection logs
      });
      this.peer = peer;

      peer.on("open", id => {
        this.events.onStatus("waiting", id);
        resolve(id);
      });

      peer.on("connection", conn => this.attachData(conn));

      peer.on("call", call => {
        this.mediaConn = call;
        this.pendingCall = call;
        if (this.localStream) this.answerWithStream(this.localStream);
        this.events.onStatus("connected");
      });

      peer.on("error", err => {
        this.events.onStatus("error", err.message);
        reject(err);
      });

      peer.on("disconnected", () => {
        // Auto-reconnect
        setTimeout(() => { try { peer.reconnect(); } catch {} }, 2000);
      });
    });
  }

  answerWithStream(localStream: MediaStream) {
    this.localStream = localStream;
    if (this.pendingCall) {
      this.pendingCall.answer(localStream);
      this.pendingCall.on("stream", s => this.events.onRemoteStream(s));
      this.pendingCall.on("close", () => this.events.onRemoteHangup());
      this.pendingCall = null;
    }
  }

  connectTo(remoteId: string, localStream: MediaStream | null) {
    if (!this.peer) return;
    this.events.onStatus("connecting", remoteId);
    this.localStream = localStream;

    // DATA channel: reliable=true so delta encoding state never diverges
    // serialization:"none" = raw binary, no msgpack wrapping (fixes ArrayBuffer receipt)
    const conn = this.peer.connect(remoteId.trim(), {
      reliable: true,
      serialization: "binary",
    });
    this.attachData(conn);

    if (localStream) {
      const call = this.peer.call(remoteId.trim(), localStream);
      this.mediaConn = call;
      call.on("stream", s => this.events.onRemoteStream(s));
      call.on("close", () => this.events.onRemoteHangup());
    }
  }

  private attachData(conn: DataConnection) {
    this.dataConn = conn;

    conn.on("open", () => {
      this.events.onStatus("connected");
    });

    conn.on("data", (data: unknown) => {
      const buf = toArrayBuffer(data);
      if (buf) {
        const frame = decode(buf, this.prevRecvFrame);
        if (frame) { this.prevRecvFrame = frame; this.events.onRemoteFrame(frame); }
      } else if (data instanceof Blob) {
        // Handle Blob asynchronously (some browsers)
        data.arrayBuffer().then(ab => {
          const frame = decode(ab, this.prevRecvFrame);
          if (frame) { this.prevRecvFrame = frame; this.events.onRemoteFrame(frame); }
        }).catch(() => {});
      }
    });

    conn.on("close",  () => { this.events.onStatus("closed"); });
    conn.on("error", err => { this.events.onStatus("error", err.message); });
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
    try {
      this.dataConn.send(buf);
      if (!isKey && this.prevSentIndices?.length === charIndices.length) {
        this.prevSentIndices.set(charIndices);
      } else {
        this.prevSentIndices = new Uint16Array(charIndices);
      }
    } catch { /* channel congested — drop frame */ }
  }

  hangup() {
    this.frameCount = 0; this.prevSentIndices = null; this.prevRecvFrame = null;
    try { this.dataConn?.close(); } catch {}
    try { this.mediaConn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.dataConn = null; this.mediaConn = null; this.peer = null;
  }

  setTargetFps(fps: number) { this.targetFps = fps; }
  get isConnected() { return !!this.dataConn?.open; }
}
