import { DEFAULT_CHARSET, type AsciiOptions } from "../lib/ascii";
import { PRESETS, CHARSET_PRESETS, FONT_SIZES } from "../types";

interface ControlsPanelProps {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
}

export default function ControlsPanel({ opts, updateOpt, fontSize, setFontSize, onReset }: ControlsPanelProps) {
  const applyPreset = (name: keyof typeof PRESETS) => {
    const p = PRESETS[name];
    Object.entries(p).forEach(([k, v]) => updateOpt(k as keyof AsciiOptions, v as never));
  };

  return (
    <aside className="controls-panel">
      <div className="panel-section">
        <label className="section-label">Presets</label>
        <div className="preset-grid">
          {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map(name => (
            <button key={name} className="btn btn-preset" onClick={() => applyPreset(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-section">
        <label className="section-label">Display</label>
        <div className="control-row">
          <span>Font size</span>
          <div className="btn-group">
            {FONT_SIZES.map(s => (
              <button
                key={s}
                className={`btn btn-sm ${fontSize === s ? "btn-active" : "btn-ghost"}`}
                onClick={() => setFontSize(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-section">
        <label className="section-label">Output Size</label>
        <SliderRow label="Columns" value={opts.asciiW} min={20} max={220} step={1}
          onChange={v => updateOpt("asciiW", v)} />
        <SliderRow label="Rows" value={opts.asciiH} min={10} max={100} step={1}
          onChange={v => updateOpt("asciiH", v)} />
      </div>

      <div className="panel-section">
        <label className="section-label">Image</label>
        <SliderRow label="Brightness" value={opts.brightness} min={-128} max={128} step={1}
          onChange={v => updateOpt("brightness", v)} showSign />
        <SliderRow label="Contrast" value={opts.contrast} min={10} max={300} step={5}
          onChange={v => updateOpt("contrast", v)} unit="%" />
        <SliderRow label="Threshold" value={opts.threshold} min={0} max={255} step={1}
          onChange={v => updateOpt("threshold", v)} />
      </div>

      <div className="panel-section">
        <label className="section-label">Mode</label>
        <div className="toggle-grid">
          <ToggleRow label="Color" value={opts.color} onChange={v => updateOpt("color", v)} />
          <ToggleRow label="Edges" value={opts.edges} onChange={v => updateOpt("edges", v)} />
          <ToggleRow label="Dither" value={opts.dither} onChange={v => updateOpt("dither", v)} />
          <ToggleRow label="Invert" value={opts.invert} onChange={v => updateOpt("invert", v)} />
        </div>
      </div>

      <div className="panel-section">
        <label className="section-label">Character Set</label>
        <input
          className="charset-input"
          value={opts.charset}
          onChange={e => updateOpt("charset", e.target.value || DEFAULT_CHARSET)}
          spellCheck={false}
        />
        <div className="charset-presets">
          {CHARSET_PRESETS.map(([name, set]) => (
            <button key={name} className="btn btn-xs btn-ghost"
              onClick={() => updateOpt("charset", set)}>
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-section">
        <button className="btn btn-ghost btn-full" onClick={onReset}>
          Reset all
        </button>
      </div>
    </aside>
  );
}

function SliderRow({
  label, value, min, max, step, onChange, unit = "", showSign = false,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; unit?: string; showSign?: boolean;
}) {
  const display = showSign && value > 0 ? `+${value}${unit}` : `${value}${unit}`;
  return (
    <div className="slider-row">
      <div className="slider-header">
        <span>{label}</span>
        <span className="slider-value">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="slider"
      />
    </div>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle-btn ${value ? "toggle-on" : ""}`} onClick={() => onChange(!value)}>
      <span className="toggle-indicator">{value ? "●" : "○"}</span>
      {label}
    </button>
  );
}
