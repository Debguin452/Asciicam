import { useEffect, useRef, useState } from "react";

interface PlayerProps {
  frames: number[][][];
  colorFrames?: number[][][][];
  charset: string;
  asciiW: number;
  asciiH: number;
  fontSize: number;
  fps?: number;
  isImage?: boolean;
}

export default function Player({ frames, colorFrames, charset, asciiW, asciiH, fontSize, fps = 15, isImage }: PlayerProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [playing, setPlaying] = useState(!isImage);
  const [index, setIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const indexRef = useRef(0);

  const draw = (i: number) => {
    const pre = preRef.current;
    if (!pre || !frames[i]) return;
    const grid = frames[i];
    const cf = colorFrames?.[i];
    const lines: string[] = [];
    for (let y = 0; y < asciiH; y++) {
      if (!grid[y]) { lines.push(""); continue; }
      if (cf) {
        let line = "";
        for (let x = 0; x < asciiW; x++) {
          const ch = charset[grid[y][x]] ?? " ";
          const rgb = cf[y]?.[x];
          const out = ch === " " ? "\u00a0" : ch;
          if (rgb) line += `<span style="color:rgb(${rgb[0]},${rgb[1]},${rgb[2]})">${out}</span>`;
          else line += out;
        }
        lines.push(line);
      } else {
        let line = "";
        for (let x = 0; x < asciiW; x++) {
          const ch = charset[grid[y][x]] ?? " ";
          line += ch === " " ? "\u00a0" : ch;
        }
        lines.push(line);
      }
    }
    if (cf) pre.innerHTML = lines.join("\n");
    else pre.textContent = lines.join("\n");
  };

  useEffect(() => { draw(index); }, [index, frames, colorFrames]);

  useEffect(() => {
    if (!playing || isImage || frames.length <= 1) return;
    const id = window.setInterval(() => {
      indexRef.current = (indexRef.current + 1) % frames.length;
      setIndex(indexRef.current);
    }, 1000 / (fps * speed));
    return () => clearInterval(id);
  }, [playing, frames.length, fps, speed, isImage]);

  const skip = (delta: number) => {
    const n = Math.max(0, Math.min(frames.length - 1, index + delta));
    setIndex(n);
    indexRef.current = n;
  };

  const isVideo = !isImage && frames.length > 1;

  return (
    <div className="player">
      <pre
        ref={preRef}
        className="ascii-output"
        style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }}
      />
      {isVideo && (
        <div className="player-controls">
          <button className="btn btn-ghost btn-sm" onClick={() => { setIndex(0); indexRef.current = 0; }} title="Restart">⏮</button>
          <button className="btn btn-ghost btn-sm" onClick={() => skip(-10)} title="-10 frames">⏪</button>
          <button className="btn btn-primary btn-sm" onClick={() => setPlaying(p => !p)}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => skip(10)} title="+10 frames">⏩</button>
          <select
            className="speed-select"
            value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
          >
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={index}
            onChange={e => { const n = Number(e.target.value); setIndex(n); indexRef.current = n; }}
            className="slider player-scrub"
          />
          <span className="player-frame-count">{index + 1}/{frames.length}</span>
        </div>
      )}
    </div>
  );
}
