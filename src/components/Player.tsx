import { useEffect, useRef, useState } from "react";

interface PlayerProps {
  frames: number[][][];
  charset: string;
  asciiW: number;
  asciiH: number;
  fontSize: number;
  fps?: number;
}

export default function Player({ frames, charset, asciiW, asciiH, fontSize, fps = 15 }: PlayerProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [playing, setPlaying] = useState(true);
  const [index, setIndex] = useState(0);
  const intervalRef = useRef<number>(0);

  const draw = (i: number) => {
    const pre = preRef.current;
    if (!pre) return;
    const grid = frames[i];
    if (!grid) return;
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
  };

  useEffect(() => {
    draw(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, frames]);

  useEffect(() => {
    if (!playing) return;
    intervalRef.current = window.setInterval(() => {
      setIndex(i => (i + 1) % frames.length);
    }, 1000 / fps);
    return () => clearInterval(intervalRef.current);
  }, [playing, frames.length, fps]);

  const skip = (delta: number) => {
    setIndex(i => {
      let n = i + delta;
      if (n < 0) n = 0;
      if (n >= frames.length) n = frames.length - 1;
      return n;
    });
  };

  const restart = () => setIndex(0);

  return (
    <div className="player">
      <pre
        ref={preRef}
        className="ascii-output"
        style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }}
      />
      <div className="player-controls">
        <button className="btn btn-ghost btn-sm" onClick={restart} title="Restart">⏮</button>
        <button className="btn btn-ghost btn-sm" onClick={() => skip(-10)} title="Back 10 frames">⏪</button>
        <button className="btn btn-primary btn-sm" onClick={() => setPlaying(p => !p)}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => skip(10)} title="Forward 10 frames">⏩</button>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={index}
          onChange={e => setIndex(Number(e.target.value))}
          className="slider player-scrub"
        />
        <span className="player-frame-count">{index + 1} / {frames.length}</span>
      </div>
    </div>
  );
}
