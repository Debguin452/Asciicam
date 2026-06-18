import { useEffect, useRef, useState } from "react";
import { DEFAULT_OPTIONS, type AsciiOptions } from "./lib/ascii";
import { THEMES, type Tab, type ThemeName } from "./types";
import CameraTab from "./components/CameraTab";
import ImageTab from "./components/ImageTab";
import LibraryTab from "./components/LibraryTab";
import AboutTab from "./components/AboutTab";
import type { LibraryItem } from "./lib/library";


export default function App() {
  const [tab, setTab] = useState<Tab>("camera");
  const [theme, setTheme] = useState<ThemeName>("green");
  const [themeOpen, setThemeOpen] = useState(false);
  const [opts, setOpts] = useState<AsciiOptions>({ ...DEFAULT_OPTIONS });
  const [fontSize, setFontSize] = useState(10);
  const [libraryKey, setLibraryKey] = useState(0);
  const [editItem, setEditItem] = useState<LibraryItem | null>(null);
  const themeRef = useRef<HTMLDivElement>(null);

  const updateOpt = <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) =>
    setOpts(o => ({ ...o, [key]: val }));
  const resetOpts = () => setOpts({ ...DEFAULT_OPTIONS });

  const prevIsLight = useRef(false);

  const changeTheme = (t: ThemeName) => {
    const nextIsLight = THEMES.find(th => th.id === t)?.light ?? false;
    if (nextIsLight !== prevIsLight.current) {
      setOpts(o => ({ ...o, invert: nextIsLight }));
      prevIsLight.current = nextIsLight;
    }
    setTheme(t);
    setThemeOpen(false);
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) setThemeOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleEditFromLibrary = (item: LibraryItem) => { setEditItem(item); setTab("image"); };

  const isLight = THEMES.find(t => t.id === theme)?.light ?? false;

  const tabs: { id: Tab; label: string }[] = [
    { id: "camera",  label: "Camera"  },
    { id: "image",   label: "Image"   },
    { id: "library", label: "Library" },
    { id: "about",   label: "About"   },
  ];

  return (
    <div className={`app-root${isLight ? " app-light" : ""}`} data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-prompt">$</span>
          <span className="brand-name">asciiweb</span>
          <span className="brand-cursor">_</span>
        </div>
        <nav className="tab-bar">
          {tabs.map(t => (
            <button key={t.id} className={`tab-btn${tab === t.id ? " tab-active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="theme-picker" ref={themeRef}>
          <button className="theme-trigger" onClick={() => setThemeOpen(o => !o)} title="Theme">
            <span className={`theme-dot-preview theme-dot-${theme}`} />
          </button>
          {themeOpen && (
            <div className="theme-dropdown">
              {THEMES.map(t => (
                <button key={t.id} className={`theme-option${theme === t.id ? " theme-option-active" : ""}`} onClick={() => changeTheme(t.id)}>
                  <span className={`theme-dot-preview theme-dot-${t.id}`} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <main className="app-main">
        {tab === "camera"  && <CameraTab  opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={resetOpts} onLibraryUpdated={() => setLibraryKey(k => k+1)} />}
        {tab === "image"   && <ImageTab   opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={resetOpts} onLibraryUpdated={() => setLibraryKey(k => k+1)} editItem={editItem} onEditDone={() => setEditItem(null)} />}
        {tab === "library" && <LibraryTab fontSize={fontSize} refreshKey={libraryKey} onEdit={handleEditFromLibrary} />}
        {tab === "about"   && <AboutTab />}
      </main>
    </div>
  );
}
