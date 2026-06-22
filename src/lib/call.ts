import Peer, { type DataConnection, type MediaConnection } from "peerjs";

// ── Wire protocol ───────────────────────────────────────────────────────────
//
// Binary frame packet (ArrayBuffer):
//   [0]    u8   version = 1
//   [1]    u8   flags: bit0=color, bit1=delta, bit2=keyframe
//   [2..3] u16  width  (cols)
//   [4..5] u16  height (rows)
//   [6..7] u16  charset length (bytes, UTF-8)
//   [8..N] u8[] charset UTF-8 bytes
//   then:  run-length-encoded (RLE) cell stream
//          each run: [u16 charIdx][u16 runLen]
//          if color flag: after all runs, Uint8Array of r,g,b per cell
//
// Delta packets: only changed cells are sent.
//   flags.delta=1: packet is a diff against previous keyframe.
//   Each run encodes: [u16 offset][u16 count][u16 charIdx repeat] or
//   uses a simpler flat diff: just the changed (idx, pos) pairs.
//
// In practice for ASCII at 60×34 cells = 2040 chars, a keyframe is
// ~4 KB uncompressed but ~800 bytes after RLE for typical scenes.
// Deltas for static scenes are near-zero bytes.

export type CallStatus =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "error"
  | "closed";

export interface RemoteFrame {
  w: number;
  h: number;
  charset: string;
  charIndices: Uint16Array;
  colors?: Uint8Array; // r,g,b per cell if color mode
}

export interface CallManagerEvents {
  onStatus: (status: CallStatus, detail?: string) => void;
  onRemoteFrame: (frame: RemoteFrame) => void;
  onRemoteHangup: () => void;
  onRemoteStream: (stream: MediaStream) => void;
}

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

function encode(
  charIndices: Uint16Array,
  w: number,
  h: number,
  charset: string,
  colors: Uint8Array | null,
  prevIndices: Uint16Array | null
): ArrayBuffer {
  const N = w * h;
  const charsetBytes = new TextEncoder().encode(charset);
  const isDelta = prevIndices !== null && prevIndices.length === N;
  const hasColor = colors !== null && colors.length === N * 3;

  // Build RLE stream (or delta stream)
  // Delta: array of [pos: u16, charIdx: u16] pairs for changed cells only
  // Key: RLE of [charIdx: u16, runLen: u16] pairs
  let streamBytes: Uint8Array;

  if (isDelta && prevIndices) {
    const changed: number[] = [];
    for (let i = 0; i < N; i++) {
      if (charIndices[i] !== prevIndices[i]) {
        changed.push(i, charIndices[i]);
      }
    }
    const buf = new Uint16Array(changed.length);
    for (let i = 0; i < changed.length; i++) buf[i] = changed[i];
    streamBytes = new Uint8Array(buf.buffer);
  } else {
    // RLE keyframe
    const runs: number[] = [];
    let i = 0;
    while (i < N) {
      const val = charIndices[i];
      let len = 1;
      while (i + len < N && charIndices[i + len] === val && len < 65535) len++;
      runs.push(val, len);
      i += len;
    }
    const buf = new Uint16Array(runs.length);
    for (let j = 0; j < runs.length; j++) buf[j] = runs[j];
    streamBytes = new Uint8Array(buf.buffer);
  }

  let flags = 0;
  if (hasColor) flags |= 0x01;
  if (isDelta)  flags |= 0x02;
  else          flags |= 0x04; // keyframe

  const headerSize = 8 + charsetBytes.length;
  const colorSize = hasColor ? N * 3 : 0;
  const total = headerSize + streamBytes.length + colorSize;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, flags);
  view.setUint16(2, w, false);
  view.setUint16(4, h, false);
  view.setUint16(6, charsetBytes.length, false);
  out.set(charsetBytes, 8);
  out.set(streamBytes, headerSize);
  if (hasColor && colors) out.set(colors, headerSize + streamBytes.length);
  return out.buffer;
}

function decode(buf: ArrayBuffer, prevFrame: RemoteFrame | null): RemoteFrame | null {
  try {
    console.log(
  "RECV",
  w,
  h,
  charIndices.length,
  isDelta ? "DELTA" : "KEY"
);
    const view = new DataView(buf);
    const flags = view.getUint8(1);
    const w = view.getUint16(2, false);
    const h = view.getUint16(4, false);
    const csLen = view.getUint16(6, false);
    const charset = new TextDecoder().decode(new Uint8Array(buf, 8, csLen));
    const N = w * h;
    const hasColor = !!(flags & 0x01);
    const isDelta  = !!(flags & 0x02);

    const streamStart = 8 + csLen;
    const streamEnd = hasColor ? buf.byteLength - N * 3 : buf.byteLength;
    const streamBytes = new Uint8Array(buf, streamStart, streamEnd - streamStart);
    const stream = new Uint16Array(streamBytes.buffer.slice(streamBytes.byteOffset, streamBytes.byteOffset + streamBytes.byteLength));

    const charIndices = new Uint16Array(N);

    if (isDelta) {
  if (!prevFrame || prevFrame.charIndices.length !== N) {
    console.warn("Delta frame without base frame");
    return null;
  }

  charIndices.set(prevFrame.charIndices);

  for (let i = 0; i < stream.length - 1; i += 2) {{
        const pos = stream[i], idx = stream[i + 1];
        if (pos < N) charIndices[pos] = idx;
      }
    } else {
      // RLE decode
      let pos = 0;
      for (let i = 0; i < stream.length - 1; i += 2) {
        const val = stream[i], len = stream[i + 1];
        for (let j = 0; j < len && pos < N; j++) charIndices[pos++] = val;
      }
    }

    let colors: Uint8Array | undefined;
    if (hasColor) {
      colors = new Uint8Array(buf, streamEnd, N * 3);
    }

    return { w, h, charset, charIndices, colors };
  } catch {
    return null;
  }
}

export class CallManager {
  private peer: Peer | null = null;
  private dataConn: DataConnection | null = null;
  private mediaConn: MediaConnection | null = null;
  private events: CallManagerEvents;
  private localStream: MediaStream | null = null;

  private prevSentIndices: Uint16Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private keyframeInterval = 10; // send a full keyframe every N frames
  private frameCount = 0;

  private lastSentAt = 0;
  private targetFps = 30;

  constructor(events: CallManagerEvents) {
    this.events = events;
  }

  setLocalStream(stream: MediaStream) {
    this.localStream = stream;
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const peer = new Peer({
        config: { iceServers: STUN_SERVERS },
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
        // If camera is already running, answer immediately — don't wait for startCamera()
        if (this.localStream) {
          this.answerWithStream(this.localStream);
        }
        this.events.onStatus("connected");
      });

      peer.on("error", err => {
        this.events.onStatus("error", err.message);
        reject(err);
      });

      peer.on("disconnected", () => {
        peer.reconnect();
      });
    });
  }

  private pendingCall: MediaConnection | null = null;

  answerWithStream(localStream: MediaStream) {
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

    // Data channel for ASCII frames
    const conn = this.peer.connect(remoteId.trim(), {
  reliable: true,
  serialization: "binary",
});
    this.attachData(conn);

    // Media channel for audio
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
      if (this.events) this.events.onStatus("connected");
      console.log("DATA CHANNEL OPEN");
    });
    conn.on("data", async (data: unknown) => {
  let buf: ArrayBuffer | null = null;

  if (data instanceof ArrayBuffer) {
    buf = data;
  } else if (data instanceof Uint8Array) {
    buf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    );
  } else if (data instanceof Blob) {
    buf = await data.arrayBuffer();
  }

  if (!buf) return;

  const frame = decode(buf, this.prevRecvFrame);

  if (frame) {
    this.prevRecvFrame = frame;
    console.log(
      "FRAME",
      frame.w,
      frame.h,
      frame.charIndices.length
    );
    this.events.onRemoteFrame(frame);
  }
});
    conn.on("close",  () => this.events.onStatus("closed"));
    conn.on("error", err => this.events.onStatus("error", err.message));
  }

  sendFrame(
    charIndices: Uint16Array,
    w: number,
    h: number,
    charset: string,
    colors: Uint8Array | null
    
  ) {
    if (!this.dataConn?.open) return;
    const now = performance.now();
    const minInterval = 1000 / this.targetFps;
    if (now - this.lastSentAt < minInterval) return;
    this.lastSentAt = now;
    console.log(
  "SEND",
  w,
  h,
  charIndices.length,
  isKey ? "KEY" : "DELTA"
);

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
    } catch { /* channel backed up — drop */ }
  }

  hangup() {
    this.frameCount = 0;
    this.prevSentIndices = null;
    this.prevRecvFrame = null;
    try { this.dataConn?.close(); } catch {}
    try { this.mediaConn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.dataConn = null;
    this.mediaConn = null;
    this.peer = null;
  }

  setTargetFps(fps: number) { this.targetFps = fps; }

  get isConnected() { return !!this.dataConn?.open; }
}
