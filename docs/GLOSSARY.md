# Glossary

Terms you meet in the qqqide source. One line each; deeper docs live under
`do/拓扑/`. Display names of goods components are all lowercase (except **Roam**).

| Term | Meaning |
| --- | --- |
| **qd (qqqide)** | The product. This repository is its client runtime. |
| **Launcher** | Tiny C Win32 exe that starts everything and performs verified, atomic updates. |
| **Shell** | Electron layer (`shell/`): windows, IPC bridge, process/component management. |
| **ghrun** | Rust process runner: one process per command, kernel-level memory/time limits. |
| **Payload / webapp** | The UI + editors + business logic under `server-app/`. |
| **goods** | Self-contained IDE components (panels or processes) registered through the gaea host. |
| **Roam** | The file explorer goods (the only goods with a capitalised display name). |
| **kmd / qmd** | Two terminal goods: line-mode (pipe) and full-interactive (ConPTY + xterm.js). |
| **Savor** | The sound-bank feature and its statistics. |
| **dsecret** | Opt-in credential scanner/redactor goods (secret-guard engine). |
| **quest** | One conversation session — a task you started. |
| **floor** | One user "send" (may contain multiple API calls). |
| **house** | One API round-trip inside a floor. |
| **room** | One tool call inside a house. |
| **qgs / qgs.simple** | Persistence entrypoints — global SQLite stores (app-wide). |
| **qg / qgf** | Persistence entrypoints — project file-based key/value under `_qqq/`. |
| **only.sq3 / quest.sq3** | Project-level SQLite: assets & preferences / quest index. |
| **qwr** | The write machine: per-file serial queue + re-read on edit + external-change detection. |
| **qz** | The unified process-spawn pipeline (ghrun first, Node fallback). |
| **qoast / ioast** | qoast notifications / task-dock cards. |
| **Context Backpack** | The per-quest context carried between floors (Z → facts → biscuit → floor). |
| **Grid** | The facts grid (`fx`) extracted by "only facts" compression. |
| **VIG** | The local usage ledger whose aggregate counters ride along telemetry. |
| **BYOK** | Bring your own API key (direct or via the platform proxy). |
| **squad** | Window slots (`1 2 q w a s z x`) recallable with a global hotkey. |
| **timeline** | The per-project file version ledger (`_qqq/timeline/`). |
| **codelens** | Inline file-action buttons rendered above pasted file anchors. |
| **WYSIWYG frame** | The rendered preview frame that replaces a pasted 📎 anchor line. |
| **klipzap** | Clipboard centre used for file paste (CF_HDROP and friends). |
| **lpl** | "Linkify local paths" — turns local paths in text into Roam jumps. |
| **hardenWebContents** | The strict window/navigation guard (deny all new windows, origin-pin navigation). |
