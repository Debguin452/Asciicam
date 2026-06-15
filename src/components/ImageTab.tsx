import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { processFrame, frameToHtml, type AsciiOptions } from "../lib/ascii";
import ControlsPanel from "./ControlsPanel";

interface ImageTabProps {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
}

export default function ImageTab({ opts, updateOpt, fontSize, setFontSize, onReset }: ImageTabProps) {
  const imgRef = useRef<HTMLImageElement>(new Image());
  const offscreenRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imageLoaded, setImageLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fileName, setFileName] = useState("");

  const render = useCallback(() => {
    const img = imgRef.current;
    const pre = preRef.current;
    if (!pre || !img.complete || !img.naturalWidth) return;
    const frame = processFrame(img, offscreenRef.current, opts, false);
    if (frame) {
      pre.innerHTML = frameToHtml(frame, opts.color);
    }
  }, [opts]);

  useEffect(() => {
    if (imageLoaded) render();
  }, [imageLoaded, render]);

  const handleFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = imgRef.current;
    img.onload = () => {
      setImageLoaded(true);
      setFileName(file.name);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) handleFile(file);
  };

  const copyAscii = () => {
    if (!preRef.current) return;
    navigator.clipboard.writeText(preRef.current.innerText);
  };

  const downloadAscii = () => {
    if (!preRef.current) return;
    const blob = new Blob([preRef.current.innerText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ascii-image.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="toolbar-left">
          {imageLoaded && <span className="fps-badge">{fileName}</span>}
        </div>
        <div className="toolbar-right">
          {imageLoaded && (
            <>
              <button className="btn btn-ghost" onClick={copyAscii}>Copy</button>
              <button className="btn btn-ghost" onClick={downloadAscii}>Save TXT</button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            {imageLoaded ? "Replace Image" : "Upload Image"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={onFileChange}
          />
          <button className="btn btn-ghost panel-toggle" onClick={() => setPanelOpen(o => !o)}>
            {panelOpen ? "Hide Controls" : "Show Controls"}
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div
          className="ascii-area"
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
        >
          {!imageLoaded && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={() => fileInputRef.current?.click()}>
                Upload Image
              </button>
              <p className="splash-hint">Or drag and drop an image here to convert it to ASCII art</p>
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
    </div>
  );
}
