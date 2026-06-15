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

