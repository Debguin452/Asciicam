# AsciiCam Web

Live webcam → ASCII art, right in your browser. Adjustable charset, presets,
color/edge/dither modes, and recording/export of ASCII video as text or a
compressed binary format that can be re-imported and played back.

## Features

- Live camera → ASCII rendering with adjustable resolution, font size,
  brightness/contrast, color, edge detection, and dithering
- Presets (Classic, Dense, Blocks, Edges, Dither, Color, Dots) and a custom
  character set input
- Copy/save the current frame as text
- Record frames, then export the recording as:
  - **TXT** — plain-text multi-frame ASCII video
  - **BIN** — each frame's characters packed into a custom binary format
    (charset + dimensions embedded in the header) and gzip-compressed
- Import a previously exported `.txt` or `.bin.gz` file to play it back as
  ASCII video in the browser

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Deploy to Cloudflare Pages (via GitHub)

1. Push this repo to GitHub (push the contents of this folder, including `wrangler.toml`, `package.json`, `index.html`, `src/`).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, select this repo.
3. Framework preset: **None / Vite**
4. Build settings (these matter — a blank page usually means one of these is wrong):
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `/` (leave default, unless your repo nests this folder)
5. Deploy. No environment variables required.

### Blank white page checklist
- Output directory must be `dist`, not `/` or `build`. If Cloudflare serves the *source* `index.html` (the one with `/src/main.tsx`), you'll get a blank page because that file only exists in dev.
- Make sure `package.json`, `vite.config.ts`, `tsconfig.json`, and `src/` are all at the repo root (or set "Root directory" to wherever they are).
- Open the deployed site's browser console — a 404 on `/assets/*.js` confirms the output-directory mismatch above.

## Credits & License

This project is by **Deb Guin** ([github.com/Debguin452/Asciicam](https://github.com/Debguin452/Asciicam)).

It is inspired by / derived from
[AsciiCam](https://github.com/Harshit-Dhanwalkar/AsciiCam) by Harshit
Dhanwalkar, which is released under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).

This project is therefore also licensed under the **PolyForm Noncommercial
License 1.0.0** — see [LICENSE.md](./LICENSE.md) for the full text.

In short: you're free to use, modify, and share this for any
**noncommercial** purpose (personal projects, learning, research, hobby
use, education, nonprofits, etc.). Commercial use is not permitted under
this license. If you redistribute this code (with or without changes), you
must keep the `LICENSE.md` file (or a link to it) along with the
`Required Notice` crediting the original AsciiCam project.

