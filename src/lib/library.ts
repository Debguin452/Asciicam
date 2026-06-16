export interface LibraryItem {
  id: string;
  name: string;
  createdAt: number;
  source: "recording" | "import";
  kind: "video" | "image";
  charset: string;
  asciiW: number;
  asciiH: number;
  frameCount: number;
  frames: number[][][];
  colorFrames?: number[][][][];
  thumbnail: string;
}

const DB_NAME = "asciicam-library";
const DB_VERSION = 1;
const STORE = "items";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLibraryItem(item: LibraryItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLibraryItems(): Promise<LibraryItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const items = req.result as LibraryItem[];
      items.sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function makeThumbnail(frames: number[][][], charset: string, asciiW: number, asciiH: number): string {
  const frame = frames[Math.floor(frames.length / 2)] ?? frames[0];
  if (!frame) return "";
  const lines: string[] = [];
  const maxRows = Math.min(asciiH, 12);
  const step = Math.max(1, Math.floor(asciiW / 40));
  for (let y = 0; y < maxRows; y++) {
    let line = "";
    for (let x = 0; x < asciiW; x += step) {
      line += charset[frame[y]?.[x] ?? 0] ?? " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
