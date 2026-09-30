# Ullim (울림) Music Player

A Windows desktop music player for local audio and video files, built with Electron and the Web Audio API. It has an 8-band equalizer with synthesized reverb, an always-on-top mini player, a live waveform visualizer, synced lyrics, ID3 tag editing, and GitHub Releases auto-update.

*Ullim* (울림) means "resonance" in Korean.

## Features

**Playback and library**
- Plays mp3, mp4, wav, ogg, m4a, flac and webm (add with a button or drag and drop)
- Library plus multiple playlists: add many tracks at once, drag to reorder tracks and playlist tabs
- Live search by title, artist or album within the current list
- Repeat (off / all / one), shuffle, and an optional 3-second crossfade
- Reads ID3 / MP4 / Vorbis tags and album art; edits title, artist, album and year on mp3 files
- Settings, library and playlists are saved and restored between sessions

**Audio**
- 8-band graphic EQ (60 Hz to 16 kHz, ±36 dB) with Flat, Bass Boost, Vocal and Hall presets
- Convolution reverb with four synthesized spaces (Room, Hall, Plate, Cathedral): impulse responses are generated in code with early reflections and frequency-dependent decay, so no sample files are needed
- A limiter at the end of the chain so heavy EQ boosts do not clip

**Interface**
- Always-on-top mini player in two layouts: a resizable floating widget (with mini EQ) or a full-width bar along the bottom of the screen
- Waveform visualizer driven by an `AnalyserNode`, with a slow decay so the shape lingers
- Colour theme taken from the current album art
- Synced lyrics: a local `.lrc` file next to the track first, otherwise [LRCLIB](https://lrclib.net), cached on disk; karaoke-style highlight and auto-scroll
- Keeps playing from the system tray when the window is closed
- Auto-update from GitHub Releases through `electron-updater`

## Audio signal chain

```
<video> element (any supported file)
  └─ MediaElementSource
       └─ 8 × BiquadFilter in series (low shelf 60 Hz · peaking 150 Hz–12 kHz · high shelf 16 kHz)
            ├─ dry gain (fixed 0.92) ──────────────┐
            └─ ConvolverNode → wet gain (0–100%) ──┴─ master gain ─┬─ DynamicsCompressor (limiter) → speakers
                                                                   └─ AnalyserNode → waveform canvas
```

The dry level is fixed so turning up the reverb adds space without making the original quieter. An early version scaled dry down as wet went up, which made everything sound muffled.

The limiter settings (threshold −10 dB, ratio 20:1, 3 ms attack, 250 ms release) are what let several bands be boosted to +36 dB at once without hard clipping.

## Architecture

Electron runs a Node.js **main process** and separate Chromium **renderer processes**. The renderers have no direct file system access; each one gets a small, explicit API through a preload script (`contextBridge`), and everything else goes over IPC.

```
main.js (main process)
  windows, tray, auto-update, settings file, metadata / lyrics / album-art colour
      │  IPC
      ├── renderer/  main window: player, library, EQ, settings      (preload.js)
      ├── overlay/   always-on-top mini player                        (preload-overlay.js)
      └── splash/    intro video on start-up                          (preload-splash.js)
```

The mini player never touches audio. Its buttons send a command to the main process, which forwards it to the main window; the main window changes playback and broadcasts the new state (track, position, volume) back to the overlay.

Work that needs Node or is slow runs in the main process: reading tags with `music-metadata`, writing them with `node-id3`, fetching and caching lyrics, and extracting the album-art colour with `nativeImage`.

## Running from source

Requires Node.js (LTS) on Windows.

```bash
npm install
npm start
```

Building the installer (`npm run dist`, NSIS `.exe` in `dist/`) and publishing releases (`npm run publish`) also need the auto-update setup described in [PROJECT_SPEC.md](PROJECT_SPEC.md).

## Project layout

```
src/
  main.js                 main process
  preload*.js             APIs exposed to each window
  renderer/               main window (index.html, renderer.js, style.css)
  overlay/                mini player
  splash/                 intro video
build/                    app and tray icons
assets/Ullim_intro.mp4    start-up video
PROJECT_SPEC.md           full design spec: every feature, IPC channel and build step (Korean)
```

## Tech stack

Electron 31 · vanilla JavaScript, HTML and CSS (no framework) · Web Audio API · electron-builder (NSIS) · electron-updater · music-metadata · node-id3

## Ideas not built yet

- Store the library, playlists and play history in SQLite (for "most played" and "not played in a while" playlists)
- Control playback from a phone on the same Wi-Fi through a small WebSocket server
- Media-key support and taskbar thumbnail buttons
