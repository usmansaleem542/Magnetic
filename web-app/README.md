# Magnetic

A desktop app for watching videos from torrents while they download. Paste a magnet link, press play, and skip to any point; the pieces you jump to are fetched first.

Built with Electron and WebTorrent.

## What you need

- **Node.js 22** (that's what it's built and tested with; 20 should also work). Get it from nodejs.org.
- macOS 13 or newer to run the Mac build. Windows and Linux builds are configured but untested.

## Run it

```bash
npm install
npm start
```

`npm install` also downloads a copy of ffmpeg (about 45 MB), which the app uses to play AC3/DTS sound.

If `npm start` fails with *"does not provide an export named 'app'"*, your terminal has `ELECTRON_RUN_AS_NODE=1` set (VS Code's terminal does this). Run it without:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

## Tests

```bash
npm test
```

## Build an app you can install

```bash
npm run dist:mac      # dist/Magnetic-<version>-arm64.dmg (Apple Silicon)
npm run dist:win      # Windows installer (untested)
npm run dist:linux    # AppImage and .deb (untested)
```

The Mac build is signed ad-hoc, not with an Apple Developer ID, so anyone who downloads it has to allow it once: drag Magnetic into Applications, try to open it, then go to **System Settings → Privacy & Security → Open Anyway**.

## Good to know

- **Uploading is off by default.** Nobody can download anything from your computer unless you turn on *Preferences → Upload to other people*. Your IP address is still visible to the people and trackers you download from, as with any torrent app.
- **Discover** searches the Internet Archive for public-domain and openly licensed films and music.
- **The bundled ffmpeg** comes from the `ffmpeg-static` package, and that build is marked GPL and "nonfree". Fine for personal use; check its licence before passing builds around widely.
- Settings and the torrent list live in the app's data folder (on a Mac, `~/Library/Application Support/Magnetic`).

## Where things are

| Path | What it does |
|---|---|
| `main.js` | Electron main process: torrents, the local streaming server, IPC, menus |
| `preload.cjs` | The bridge the window uses to talk to `main.js` |
| `renderer/` | The interface: `index.html`, `app.js`, `styles.css`, Arabic translations in `i18n.js` |
| `lib/` | Pieces with tests: subtitles, trackers, Internet Archive search, ffmpeg audio conversion, casting |
| `scripts/` | Icon generation and the Mac build hooks (ad-hoc signing, .dmg icon) |
| `test/` | `node:test` unit tests |
