import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { decodeBinaryFrames, decodeTextFrames, gzipDecompress, textFramesToIndices } from "../lib/binary";
import { loadAsv } from "../lib/format";
import { getLibraryItems, deleteLibraryItem, saveLibraryItem, makeThumbnail, genId, type LibraryItem } from "../lib/library";
import Player from "./Player";
import Modal from "./Modal";

interface Props {
  fontSize: number;
  refreshKey: number;
}

export default function LibraryTab({ fontSize, refreshKey }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try { setItems(await getLibraryItems()); } catch { setItems([]); }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const handleImport = async (file: File) => {
    setError(null);
    setImporting(true);
    try {
      let item: LibraryItem;
      const name = file.name;
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);

      if (isImage) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
        const canvas = document.createElement("canvas");
        const W = 120, H = 50;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        const px = ctx.getImageData(0, 0, W, H).data;
        const chars = " .:-=+*#%@";
        const frame: number[][] = [];
        const colorFrame: number[][][] = [];
        for (let y = 0; y < H; y++) {
          const row: number[] = [], cr: number[][] = [];
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const r = px[i], g = px[i+1], b = px[i+2];
            const lum = 0.299*r + 0.587*g + 0.114*b;
            row.push(Math.min(Math.floor(lum / 256 * chars.length), chars.length - 1));
            cr.push([r, g, b]);
          }
          frame.push(row);
          colorFrame.push(cr);
        }
        item = {
          id: genId(), name, createdAt: Date.now(), source: "import", kind: "image",
          charset: chars, asciiW: W, asciiH: H, frameCount: 1,
          frames: [frame], colorFrames: [colorFrame],
          thumbnail: makeThumbnail([frame], chars, W, H),
        };
      } else if (name.endsWith(".asv")) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const decoded = await loadAsv(buf);
        item = {
          id: genId(), name, createdAt: Date.now(), source: "import", kind: "video",
          charset: decoded.charset, asciiW: decoded.asciiW, asciiH: decoded.asciiH,
          frameCount: decoded.frames.length,
          frames: decoded.frames, colorFrames: decoded.colorFrames,
          thumbnail: makeThumbnail(decoded.frames, decoded.charset, decoded.asciiW, decoded.asciiH),
        };
      } else if (name.endsWith(".gz") || name.endsWith(".bin")) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const raw = await gzipDecompress(buf);
        const decoded = decodeBinaryFrames(raw);
        item = {
          id: genId(), name, createdAt: Date.now(), source: "import", kind: "video",
          charset: decoded.charset, asciiW: decoded.asciiW, asciiH: decoded.asciiH,
          frameCount: decoded.frameCount, frames: decoded.frames,
          colorFrames: decoded.colorFrames as number[][][][] | undefined,
          thumbnail: makeThumbnail(decoded.frames, decoded.charset, decoded.asciiW, decoded.asciiH),
        };
      } else {
        const text = await file.text();
        const decoded = decodeTextFrames(text);
        const frames = textFramesToIndices(decoded);
        item = {
          id: genId(), name, createdAt: Date.now(), source: "import", kind: "video",
          charset: decoded.charset, asciiW: decoded.asciiW, asciiH: decoded.asciiH,
          frameCount: frames.length, frames,
          thumbnail: makeThumbnail(frames, decoded.charset, decoded.asciiW, decoded.asciiH),
        };
      }

      await saveLibraryItem(item);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImport(file);
    e.target.value = "";
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteLibraryItem(pendingDelete.id);
    if (selected?.id === pendingDelete.id) setSelected(null);
    setPendingDelete(null);
    await load();
  };

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="toolbar-left">
          <span className="section-label-inline">Library — {items.length} items</span>
          {error && <span className="error-badge">⚠ {error}</span>}
          {importing && <span className="fps-badge">importing…</span>}
        </div>
        <div className="toolbar-right">
          {selected && (
            <button className="btn btn-ghost" onClick={() => setSelected(null)}>← Back</button>
          )}
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".asv,.txt,.bin,.gz,.png,.jpg,.jpeg,.gif,.webp,.bmp"
            style={{ display: "none" }}
            onChange={onFileChange}
          />
        </div>
      </div>

      <div className="library-layout">
        {selected ? (
          <div className="library-player">
            <Player
              frames={selected.frames}
              colorFrames={selected.colorFrames}
              charset={selected.charset}
              asciiW={selected.asciiW}
              asciiH={selected.asciiH}
              fontSize={fontSize}
              isImage={selected.kind === "image"}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="splash">
            <button className="btn btn-primary btn-lg" onClick={() => fileInputRef.current?.click()}>
              Import File
            </button>
            <p className="splash-hint">Import .asv · .txt · .bin.gz · .png · .jpg · .webp</p>
            <p className="splash-hint">Recordings from Camera tab are auto-saved here</p>
          </div>
        ) : (
          <div className="library-grid">
            {items.map(item => (
              <div key={item.id} className="library-card" onClick={() => setSelected(item)}>
                <pre className="library-thumb">{item.thumbnail}</pre>
                <div className="library-card-info">
                  <span className="library-card-name">{item.name}</span>
                  <span className="library-card-meta">
                    {item.kind === "image" ? "Image" : `${item.frameCount}f`} · {item.asciiW}×{item.asciiH}
                    {" · "}{item.source === "recording" ? "Recorded" : "Imported"}
                  </span>
                </div>
                <div className="library-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="btn btn-primary btn-sm" onClick={() => setSelected(item)}>
                    {item.kind === "image" ? "View" : "Play"}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => setPendingDelete(item)}>Del</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingDelete && (
        <Modal
          title="Delete item"
          message={`Remove "${pendingDelete.name}" from your library?`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
