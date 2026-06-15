export type Tab = "camera" | "image" | "library" | "about";

export type ThemeName = "green" | "amber" | "cyan" | "mono";

export const THEMES: { id: ThemeName; label: string }[] = [
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
  { id: "cyan", label: "Cyan" },
  { id: "mono", label: "Mono" },
];

export const PRESETS = {
  Classic: { charset: " .:-=+*#%@", color: false, edges: false, dither: false, invert: false, threshold: 0 },
  Dense: { charset: " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@", color: false, edges: false, dither: false, invert: false, threshold: 0 },
  Blocks: { charset: " ░▒▓█", color: true, edges: false, dither: false, invert: false, threshold: 0 },
  Edges: { charset: " .:-=+*#%@", color: false, edges: true, dither: false, invert: false, threshold: 0 },
  Dither: { charset: " .:-=+*#%@", color: false, edges: false, dither: true, invert: false, threshold: 0 },
  Color: { charset: " .:-=+*#%@", color: true, edges: false, dither: false, invert: false, threshold: 0 },
  Dots: { charset: " ·•●", color: true, edges: false, dither: true, invert: false, threshold: 0 },
  "High Contrast": { charset: " .#@", color: false, edges: false, dither: false, invert: false, threshold: 128 },
} as const;

export const CHARSET_PRESETS: [string, string][] = [
  ["Default", " .:-=+*#%@"],
  ["Dense", " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@"],
  ["Blocks", " ░▒▓█"],
  ["Binary", " 01"],
  ["Dots", " ·•●"],
  ["Lines", " -=≡"],
];

export const FONT_SIZES = [8, 10, 12, 14, 16, 18];
