# Security Policy — qqqide

qqqide is a portable AI IDE for Windows 7–11 (x64). This repository is its
client runtime source (see README for the component map and what is intentionally
not in-tree). We care about security and welcome good-faith reports.

## Supported versions

Only the current release line is supported (version shown at the bottom-left of
the app / as the id in `versions.json`). Older portable packs: best effort.

## Reporting a Vulnerability

- **Preferred:** open a private report via GitHub Security Advisories
  ("Security" tab → "Report a vulnerability") on this repository.
- **Alternative:** email **29492511@qq.com** with subject `[SECURITY]`.
- Please include: affected version, a description, and a minimal reproduction if
  possible.

We are a small team; we aim to acknowledge within a few business days and will
coordinate disclosure with you. Please do not open public issues for security
problems.

## What qqqide Is

A four-layer desktop system:

| Layer | What it is |
| --- | --- |
| Launcher | tiny C Win32 executable — dispatch + verified, atomic self-update |
| Shell | Electron shell (`shell/`): windows, IPC bridge, process/component management |
| Runner | Rust process runner (`ghrun`): one process per command, kernel-level limits |
| Payload | the IDE UI/editor/business logic (`server-app/`) |

The application runs with the privileges of the current user and manages the
files the user opens and edits — treat it like a developer tool, not a sandbox
for untrusted code.

## Defenses in This Codebase

### Update integrity
- Updates are full-package, **Ed25519-signed**; the public key is embedded in the
  launcher binary; signature verification has no bypass path.
- Downloads are hash-verified (SHA-512 manifests + archive CRC) and resume-safe.
- Installation is an atomic swap at startup; any verification failure rejects
  the update and keeps the previous version running.
- Executable components (Python, ffmpeg, git, …) ship inside the package or come
  from the signed update channel; there is no side-channel code download.

### Window & navigation hardening
- All windows are created with `contextIsolation: true` and
  `nodeIntegration: false`.
- `setWindowOpenHandler` denies every new-window request (external links go to
  the user's browser); `will-navigate` is origin-pinned. Both are registered
  before any window exists (`hardenWebContents` in `shell/shutdown.ts`).
- Page-level permissions (camera, microphone, geolocation, notifications, …) are
  denied by default via paired session handlers. The only allowlist is three
  user-gesture-driven capabilities used by first-party UI — clipboard read,
  clipboard write and fullscreen.
- The payload is served from the app's own origin/protocol; pages declare a
  Content-Security-Policy meta tag.

### Data handling
- Text encoding machine (BOM/UTF-8/GBK aware) with atomic writes (tmp + rename) —
  no torn writes.
- An opt-in local scanner (`secret-guard` / the dsecret goods) detects and can
  redact well-known credential formats (cloud keys, tokens, private-key blocks)
  in files before they are committed.
- State lives in the app folder / OS app-data folder; nothing is uploaded unless
  the user triggers a sync feature explicitly (see PRIVACY.md).

## Known Trade-offs (Read This Before Reporting)

- **Electron 22.3.27 (Chromium 108) is pinned on purpose** to keep Windows 7 SP1
  support. Upstream no longer patches that Chromium line. We compensate with the
  defenses above and keep the entire update channel strictly signed. A
  dual-track package (modern engine for modern Windows, frozen legacy for Win7)
  is under evaluation.
- Because the runtime loads local content (file previews, media, frames on a
  custom protocol), the windows run with `webSecurity: false` and
  `sandbox: false`, and the app's own CSP includes `unsafe-inline` /
  `unsafe-eval` for the hot-reloadable local scripts.
  `ELECTRON_DISABLE_SECURITY_WARNINGS` is enabled deliberately — documented here
  so it is not mistaken for an accident. `contextIsolation` and the
  navigation deny-listing remain enforced.
- Terminals (`kmd`, `qmd`) execute what the user types, with user privileges —
  by design.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith, avoid
privacy violations and data destruction, and give us reasonable time to fix an
issue before disclosure.
