# ferdium-chrome-extensions-patch

A patch script that adds **Chrome extension support** to an installed [Ferdium](https://ferdium.org/) application — no source build required.

---

## Features

- 📁 **Add unpacked extensions** — point to any extension folder that contains a `manifest.json`
- 🌐 **Install from Chrome Web Store** — paste a CWS URL or 32-character extension ID
- 🔄 **Auto-update** — checks for updates 10 seconds after Ferdium starts; manual check also available
- ✅ **Enable / Disable toggle** — temporarily unload an extension from all sessions without deleting it
- 📊 **Memory usage** — see per-process memory usage from inside Ferdium's settings
- 🔒 **Non-destructive** — creates `app.asar.backup` before the first patch; run `--revert` to restore

---

## Usage

```bash
# Apply patch
node apply-chrome-extensions-installed.js

# Check whether the patch is already applied
node apply-chrome-extensions-installed.js --check

# Restore original app.asar
node apply-chrome-extensions-installed.js --revert
```

- Windows: double-click **`apply-chrome-extensions-installed.bat`**
- macOS / Linux: `./apply-chrome-extensions-installed.sh`

After the script finishes, **restart Ferdium**. A new "Extensions" entry appears in Settings.

### macOS note

Patching `app.asar` invalidates Ferdium's code signature. If macOS refuses
to open Ferdium afterwards ("Ferdium is damaged"), run:

```bash
sudo codesign --force --deep --sign - /Applications/Ferdium.app
```

---

## Requirements

- [Node.js](https://nodejs.org/) (any recent LTS)
- Ferdium installed — Windows, macOS, and Linux (deb/rpm) default paths are auto-detected
  - AppImage / snap / flatpak builds on Linux are **not supported**

---

## Tech stack

| Aspect | Detail |
|---|---|
| Language | Node.js (built-in modules only, no npm dependencies) |
| Target runtime | Electron + React (Ferdium's bundled runtime) |
| Patch format | Electron `asar` archive (extract → inject → repack) |
| CI/CD | GitHub Actions (auto release on every push to `main`) |

---

## How it works

1. Extracts the `app.asar` archive to a temporary directory
2. Injects `extensions-main.js` (main-process IPC handlers) and `ExtensionsScreen.js` (React UI)
3. Patches `index.js`, `routes.js`, and `SettingsNavigation.js` to wire up the new screen
4. Repacks the archive in place

The script is idempotent — re-running it after a Ferdium update will re-apply only what changed.

---

## Extension compatibility

| Works ✅ | Limited / Broken ⚠️ |
|----------|----------------------|
| Content Scripts (page injection) | Toolbar popup (action / browser_action) |
| Manifest V2 extensions | Manifest V3 (Service Worker) |
| `storage`, `cookies` APIs | `chrome.tabs`, `bookmarks`, `history` |

Ferdium uses Electron's built-in `session.loadExtension()` API, so extensions that rely on a full browser environment will not work.

---

## Settings storage

Extension paths and disabled state are stored in:

```
%AppData%\Ferdium\config\extensions.json
```

---

## Download

Grab the latest `apply-chrome-extensions-installed.js` (+ `.bat` / `.sh` launcher)
from the [Releases page](https://github.com/yumebi/ferdium-chrome-extensions-patch/releases/latest) —
no need to clone the repo. A new release is cut automatically on every push to `main`.

---

## License

[MIT License](LICENSE)
