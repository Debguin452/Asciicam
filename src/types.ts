export type Tab = "camera" | "image" | "library" | "about";

export type ThemeName = "green" | "amber" | "cyan" | "mono" | "green-light";

export const THEMES: { id: ThemeName; label: string; light?: boolean }[] = [
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
  { id: "cyan", label: "Cyan" },
  { id: "mono", label: "Mono" },
  { id: "green-light", label: "Paper", light: true },
];

export const PRESETS = {
  Classic:        { charset: " .:-=+*#%@",  color: false, edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  Dense:          { charset: " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@", color: false, edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  Blocks:         { charset: " \u2591\u2592\u2593\u2588", color: true,  edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: true,  noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  Edges:          { charset: " .:-=+*#%@",  color: false, edges: true,  gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  "Edge Lines":   { charset: " .:-=+*#%@",  color: false, edges: true,  gradientDirs: true,  dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  Sketch:         { charset: " .:-=+*#%@",  color: false, edges: true,  gradientDirs: true,  dither: false, ditherMode: "floyd" as const, invert: true,  threshold: 0, brailleMode: false, blockMode: false, noiseReduction: true,  localContrast: false, histEq: false, gamma: 1.2 },
  Dither:         { charset: " .:-=+*#%@",  color: false, edges: false, gradientDirs: false, dither: true,  ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  "Bayer Dither": { charset: " .:-=+*#%@",  color: false, edges: false, gradientDirs: false, dither: true,  ditherMode: "bayer" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  Color:          { charset: " .:-=+*#%@",  color: true,  edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  Braille:        { charset: " .:-=+*#%@",  color: false, edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: true,  blockMode: false, noiseReduction: false, localContrast: false, histEq: false, gamma: 1.0 },
  "High Contrast":{ charset: " .#@",        color: false, edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 128, brailleMode: false, blockMode: false, noiseReduction: false, localContrast: true,  histEq: false, gamma: 1.0 },
  Enhanced:       { charset: " .:-=+*#%@",  color: false, edges: false, gradientDirs: false, dither: false, ditherMode: "floyd" as const, invert: false, threshold: 0, brailleMode: false, blockMode: false, noiseReduction: true,  localContrast: true,  histEq: true,  gamma: 1.2 },
} as const;

export type PresetName = keyof typeof PRESETS;

export const CHARSET_PRESETS: [string, string][] = [
  ["Default", " .:-=+*#%@"],
  ["Dense",   " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@"],
  ["Blocks",  " \u2591\u2592\u2593\u2588"],
  ["Binary",  " 01"],
  ["Dots",    " \u00b7\u2022\u25cf"],
  ["Lines",   " -=\u2261"],
  ["Mixed",   " .+|\\/-*#@"],
];

export const FONT_SIZES = [6, 8, 10, 12, 14, 16];

export function makeTimestamp(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function makeFilename(prefix: string, ext: string): string {
  return `${prefix}_${makeTimestamp()}.${ext}`;
}
