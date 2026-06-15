import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { decodeBinaryFrames, decodeTextFrames, gzipDecompress, textFramesToIndices } from "../lib/binary";
import { getLibraryItems, deleteLibraryItem, saveLibraryItem, makeThumbnail, genId, type LibraryItem } from "../lib/library";
import Player from "./Player";
import Modal from "./Modal";

interface LibraryTabProps {
  fontSize: number;
  refreshKey: number;
}

export default function LibraryTab({ fontSize, refreshKey }: LibraryTabProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const list = await getLibraryItems();
    setItems(list);
  };

  useEffect(() => {
    load();
  }, [refreshKey]);

  const handleImport = async (file: File) => {
    setError(null);
    try {
      let item: LibraryItem;
      if (file.name.endsWith(".gz") || file.name.endsWith(".bin")) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const raw = await gzipDecompress(buf);
        const decoded = decodeBinaryFrames(raw);
        item = {
          id: genId(),
          name: file.name,
          createdAt: Date.now(),
          source: "import",
          charset: decoded.charset,
          asciiW: decoded.asciiW,
          asciiH: decoded.asciiH,
          frameCount: decoded.frameCount,
          frames: decoded.frames,
          thumbnail: makeThumbnail(decoded.frames, decoded.charset, decoded.asciiW, decoded.asciiH),
        };
      } else {
        const text = await file.text();
        const decoded = decodeTextFrames(text);
        const frames = textFramesToIndices(decoded);
        item = {
          id: genId(),
          name: file.name,
          createdAt: Date.now(),
          source: "import",
          charset: decoded.charset,
          asciiW: decoded.asciiW,
          asciiH: decoded.asciiH,
          frameCount: frames.length,
          frames,
          thumbnail: makeThumbnail(frames, decoded.charset, decoded.asciiW, decoded.asciiH),
        };
      }
      await saveLibraryItem(item);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import file");
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
          <span className="section-label-inline">Library</span>
          {error && <span className="error-badge">⚠ {error}</span>}
        </div>
        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            Import Video
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.bin,.gz"
            style={{ display: "none" }}
            onChange={onFileChange}
          />
        </div>
      </div>

      <div className="library-layout">
        {selected ? (
          <div className="library-player">
            <div className="library-player-header">
              <span>{selected.name}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Back to library</button>
            </div>
            <Player
              frames={selected.frames}
              charset={selected.charset}
              asciiW={selected.asciiW}
              asciiH={selected.asciiH}
              fontSize={fontSize}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="splash">
            <p className="splash-hint">No saved recordings or imports yet</p>
            <p className="splash-hint">Record from the Camera tab and save, or import a .txt / .bin.gz file</p>
          </div>
        ) : (
          <div className="library-grid">
            {items.map(item => (
              <div key={item.id} className="library-card">
                <pre className="library-thumb">{item.thumbnail}</pre>
                <div className="library-card-info">
                  <span className="library-card-name">{item.name}</span>
                  <span className="library-card-meta">
                    {item.source === "recording" ? "Recorded" : "Imported"} · {item.frameCount} frames · {item.asciiW}×{item.asciiH}
                  </span>
                </div>
                <div className="library-card-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => setSelected(item)}>Play</button>
                  <button className="btn btn-danger btn-sm" onClick={() => setPendingDelete(item)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingDelete && (
        <Modal
          title="Delete from library"
          message={`Remove "${pendingDelete.name}" from your library? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
