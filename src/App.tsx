import { useState } from "react";
import { DEFAULT_OPTIONS, type AsciiOptions } from "./lib/ascii";
import { THEMES, type Tab, type ThemeName } from "./types";
import CameraTab from "./components/CameraTab";
import ImageTab from "./components/ImageTab";
import LibraryTab from "./components/LibraryTab";
import AboutTab from "./components/AboutTab";

export default function App() {
  const [tab, setTab] = useState<Tab>("camera");
  const [theme, setTheme] = useState<ThemeName>("green");
  const [opts, setOpts] = useState<AsciiOptions>({ ...DEFAULT_OPTIONS });
  const [fontSize, setFontSize] = useState(10);
  const [libraryKey, setLibraryKey] = useState(0);

  const updateOpt = <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) =>
    setOpts(o => ({ ...o, [key]: val }));

  const resetOpts = () => setOpts({ ...DEFAULT_OPTIONS });

  const tabs: { id: Tab; label: string }[] = [
    { id: "camera", label: "Camera" },
    { id: "image",   label: "Image"  },
    { id: "library", label: "Library"},
    { id: "about",   label: "About"  },
  ];

  const isLight = THEMES.find(t => t.id === theme)?.light ?? false;

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
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? "tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="theme-switcher">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-dot theme-dot-${t.id} ${theme === t.id ? "theme-dot-active" : ""}`}
              title={t.label}
              onClick={() => setTheme(t.id)}
            />
          ))}
        </div>
      </header>

      <main className="app-main">
        {tab === "camera" && (
          <CameraTab
            opts={opts}
            updateOpt={updateOpt}
            fontSize={fontSize}
            setFontSize={setFontSize}
            onReset={resetOpts}
            onLibraryUpdated={() => setLibraryKey(k => k + 1)}
          />
        )}
        {tab === "image" && (
          <ImageTab
            opts={opts}
            updateOpt={updateOpt}
            fontSize={fontSize}
            setFontSize={setFontSize}
            onReset={resetOpts}
            onLibraryUpdated={() => setLibraryKey(k => k + 1)}
          />
        )}
        {tab === "library" && (
          <LibraryTab fontSize={fontSize} refreshKey={libraryKey} />
        )}
        {tab === "about" && <AboutTab />}
      </main>
    </div>
  );
}
