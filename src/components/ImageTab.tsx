import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { processFrame, frameToHtml, type AsciiOptions } from "../lib/ascii";
import { saveLibraryItem, makeThumbnail, genId } from "../lib/library";
import { makeFilename } from "../types";
import ControlsPanel from "./ControlsPanel";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
  onLibraryUpdated: () => void;
}

export default function ImageTab({ opts, updateOpt, fontSize, setFontSize, onReset, onLibraryUpdated }: Props) {
  const imgRef = useRef<HTMLImageElement>(new Image());
  const offscreen = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastFrameRef = useRef<ReturnType<typeof processFrame>>(null);

  const [loaded, setLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fileName, setFileName] = useState("");
  const [saved, setSaved] = useState(false);

  const render = useCallback(() => {
    const img = imgRef.current;
    const pre = preRef.current;
    if (!pre || !img.complete || !img.naturalWidth) return;
    const frame = processFrame(img, offscreen.current, opts, false);
    if (frame) {
      lastFrameRef.current = frame;
      pre.innerHTML = frameToHtml(frame, opts.color);
    }
  }, [opts]);

  useEffect(() => { if (loaded) render(); }, [loaded, render]);

  const handleFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = imgRef.current;
    img.onload = () => {
      setLoaded(true);
      setFileName(file.name);
      setSaved(false);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (file) handleFile(file); e.target.value = "";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith("image/")) handleFile(file);
  };

  const copyAscii = () => { if (preRef.current) navigator.clipboard.writeText(preRef.current.innerText); };

  const downloadAscii = () => {
    if (!preRef.current) return;
    const blob = new Blob([preRef.current.innerText], { type: "text/plain" });
    triggerDownload(blob, makeFilename("asciiphoto", "txt"));
  };

  const saveToLibrary = async () => {
    const frame = lastFrameRef.current;
    if (!frame) return;
    const charset = opts.charset || " .:-=+*#%@";
    const idxFrame = frame.map(row => row.map(c => c.charIdx));
    const colorFrame = opts.color ? frame.map(row => row.map(c => [c.r, c.g, c.b])) : undefined;
    await saveLibraryItem({
      id: genId(),
      name: makeFilename(fileName ? fileName.replace(/\.[^.]+$/, "") : "asciiphoto", "asp"),
      createdAt: Date.now(),
      source: "import",
      kind: "image",
      charset,
      asciiW: opts.asciiW,
      asciiH: opts.asciiH,
      frameCount: 1,
      frames: [idxFrame],
      colorFrames: colorFrame ? [colorFrame] : undefined,
      thumbnail: makeThumbnail([idxFrame], charset, opts.asciiW, opts.asciiH),
    });
    onLibraryUpdated();
    setSaved(true);
  };

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="toolbar-left">
          {loaded && <span className="fps-badge">{fileName}</span>}
          {saved && <span className="fps-badge">✓ in library</span>}
        </div>
        <div className="toolbar-right">
          {loaded && (
            <>
              <button className="btn btn-ghost" onClick={copyAscii}>Copy</button>
              <button className="btn btn-ghost" onClick={downloadAscii}>Save TXT</button>
              <button className="btn btn-ghost" onClick={saveToLibrary}>Save to Library</button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            {loaded ? "Replace" : "Upload Image"}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileChange} />
          <button className="btn btn-ghost panel-toggle" onClick={() => setPanelOpen(o => !o)}>
            {panelOpen ? "▼" : "▲"} Controls
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div className="ascii-area" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
          {!loaded && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={() => fileInputRef.current?.click()}>
                Upload Image
              </button>
              <p className="splash-hint">Or drag and drop an image</p>
            </div>
          )}
          <pre ref={preRef} className="ascii-output" style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }} />
        </div>
        {panelOpen && (
          <ControlsPanel opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={onReset} />
        )}
      </div>
    </div>
  );
}

function triggerDownload(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
