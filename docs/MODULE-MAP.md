# Module Map

How the qqqide client runtime is put together: the process shape, where each
module lives, and the global integration points modules use to talk to each
other. Companion docs: `README.md` (build & test), `docs/GLOSSARY.md`
(terminology), `SECURITY.md`, `PRIVACY.md`.

## 1 · Runtime shape

| Process | Role | Source |
| --- | --- | --- |
| Launcher | Verified atomic self-update, then starts the shell | *(separate distribution)* |
| Shell (`joker.exe`, Electron 22) | Windows, IPC, process/component management | `shell/*.ts` → esbuild → `shell-out/` |
| Runner (`ghrun.exe`, Rust) | One child process per command, kernel resource limits | `ghrun/` |
| Payload | The IDE itself — everything the user sees | `server-app/` |

Inside the payload:

- **Main window** — one document (`server-app/index.html`) loads `core/*.js` in a
  fixed order (the authoritative order is the file itself); `core/shell.js` is the
  orchestrator; `core/gaea-host.js` hosts the component system.
- **AI panels** — three independent iframes of `ai-panel/index.html` (left wing,
  center, right wing). Chat state lives per iframe; the shared agent pool and
  cross-panel registries live on the parent window.
- **goods** — self-contained components under `server-app/goods/*`, registered via
  `core/gaea-host.js`: HTML iframes or Python/Qt processes managed by the shell.
- **Separate windows** — timeline diff, git diff and similar are standalone
  `BrowserWindow`s loading their own HTML.
- **Service worker** — `service-worker.js` caches the payload for offline boot.

All native access goes through one bridge: `shell/preload.ts` exposes
`window.qqqideBridge` via `contextBridge` (context isolation on, Node integration
off). No module talks to the OS any other way.

## 2 · Repository layout

| Path | What |
| --- | --- |
| `shell/` | Electron main process (TypeScript → `shell-out/`) |
| `server-app/` | The payload: IDE UI, editors, AI panel, goods, locales |
| `ghrun/` | Rust process runner + watchdog |
| `shell-build/` | esbuild bundling, dev server, packaging |
| `engines/` | Component manifest + prebuilt binaries + Python bridges |
| `ci/` | Static checks, unit tests, end-to-end smoke |
| `docs/` | This map, glossary, public notes |
| `assets/` | App-local VC++ runtime DLLs (Windows 7 support) |

## 3 · `server-app/core/` — main window

### Window chrome & layout

| File | Role |
| --- | --- |
| shell.js | Main-window orchestrator: boot, layout, cross-module wiring |
| sash.js | Split sashes (pane width reallocation) |
| shell-menu.js | Top menu bar (brand menus) |
| help-menu.js | Help dropdown (contact / video / community) |
| menu-schema.js | Built-in menu schema |
| shell-lang.js | Language switch button + flag rendering |
| shell-wings.js | Left/right wing panels (open/close, window sizing) |
| shell-statusbar.js | Status bar (version, probe, memory, activity widgets) |
| shell-mem-hover.js | Memory/CPU hover card (24 h curves, process list) |
| ui-zoom.js | App-level UI zoom consumer |
| squad-btn.js | Window-squad button + slot dropdown |
| shell-activities.js | Activity widgets + free-window policy |
| update-health.js | Update health pill + diagnostics viewer |
| update-machine.js | Update-check UI machine |

### Platform & persistence

| File | Role |
| --- | --- |
| state-sdk.js | Renderer persistence SDK (`qgs` / `qgs.simple`) |
| ipc-bridge.js | Browser-dev shim for the preload bridge |
| defaults.js | Factory defaults for preferences |
| cooldown-guard.js | Global button debounce |
| qqq-prefs.js | User preference registry |
| qqq-links.js | Server-pushed external links (offline fallback inside) |
| guard-meta.js | Server guard-meta fetch (context-backpack estimates) |
| first-run.js | First-run dialog chain |
| qqq-notice.js | Notice dot + notification centre |
| entitlement.js | Feature gates (activation / VIP truth consumption) |
| login.js | Auth state, LV display, purchase checks |

### Editor & documents

| File | Role |
| --- | --- |
| editor.js | Monaco editor manager (instances, external-change machine) |
| editor-breadcrumb.js | Breadcrumb bar + copy-path + encoding badge |
| tab-manager.js | Tab groups & tabs state machine |
| char-undo.js | Char-level undo snapshots for programmatic inserts |
| qqq-codelens.js | Inline file-action buttons above pasted anchors |
| md-preview.js | Markdown live-preview machine (tab wiring) |
| md-render.js | Markdown renderer (shared with the AI panel) |
| lpl.js | Linkify local paths (+ existence probe + Roam jump) |
| export-machine.js | Doc / ZIP export entry |
| download-machine.js | Unified user-facing download entry |

### Paste & WYSIWYG

| File | Role |
| --- | --- |
| klipzap.js | Clipboard centre (file paste, CF_HDROP) |
| paste-router.js | Paste pipeline: vault write → anchor insert |
| drop-overlay.js | Editor drop target overlay |
| viewport-machine.js | WYSIWYG frame anchors + view zones |
| frame-renderer.js | Frame rendering (media / text / icon) |

### Media & overlay

| File | Role |
| --- | --- |
| media-engine.js | Shared media player engine (three hosts) |
| player-card.js | In-window player card host |
| shell-overlay.js | Overlay host (lightboxes, previews) |
| wq-stats.js | Status-bar probe widget + cache card |

### Tools & misc

| File | Role |
| --- | --- |
| qqq-tools.js | "qqq" workbench menu (export / sync / savor …) |
| savor.js | Savor machine (sound bank + stats) |
| floor-favs.js | Floor-favourites store + jump routing |
| qqq-center.js | Settings-centre card |
| ensure-gitignore.js | `.gitignore` completeness check |
| secret-guard.js | Credential scan/redact engine |
| mem-warning.js | Memory-watchdog notice receiver |
| key-hook.js | Renderer key-hook registry |
| audio-volume.js | Volume panel + SFX scene registry |
| qqqide-theme.js | Theme machine + layout constants + Monaco themes |
| i18n.js | i18n runtime (language chain + DOM translation) |
| qqqide-qoast.js | Toast notifications (qoast) |
| qqqide-ioast.js | Task-dock cards (ioast) |
| ai-viewport.js | AI viewport (folder formation, git badges) |
| settings.js | Settings panel |
| gaea-host.js | goods host: registration, A-zone, tabs |
| __stamp.js | Build stamp (SW cache vs disk compare) |
| shell-base.css / shell-main.css / shell-widgets.css | Shell styles |
| key-bindings.json | Default key map |

## 4 · `server-app/ai-panel/` — one iframe per AI panel

### Agents & gateways

| File | Role |
| --- | --- |
| ai-panel.js | Panel orchestrator (iframe entry) |
| agent-loop.js | The floor loop: houses, tool calls, recovery |
| agent-gateway.js | Model call path: failover, context caps |
| agent-sse.js | SSE parsing + text tool-call finalize |
| agent-context.js | System-prompt assembly + context backpack |
| agent-exec.js | Parallel tool execution |
| agent-envelope.js | Envelope stripper (text tool-call formats) |
| agent-vision.js | Vision (image) request path |
| ai-gateway.js | Unified gateway entry (chat / vision / image / embed) |
| byok.js | BYOK intercept, config, identity preamble |

### State & content

| File | Role |
| --- | --- |
| card-pool.js | Quest cards pool (floor cap, eviction) |
| compress-machine.js | Automatic context compression |
| content-gateway.js | Content gate (single cap source) |
| embedding-service.js | Embeddings for semantic search |
| only-store.js | Project preferences store (`only.sq3`) |
| quest-store.js | Quest/floor store (all.json + index) |
| system-prompt.js | System-prompt builder |
| time-util.js | Time formatting helpers |

### Tools

| File | Role |
| --- | --- |
| tools.js | Tool dispatcher |
| tools-defs.js | Tool definitions sent to the model |
| tools-exec.js | Tool execution core |
| tools-exec-effect.js | Effect tools (web search/fetch, images) |
| tools-exec-write.js | Write tools (edit/create/delete/write) |

### Panel UI (per iframe)

| File | Role |
| --- | --- |
| panel-quest.js | Quest lifecycle & ownership |
| panel-quest-ui.js | Quest dropdown / rename / menus |
| panel-registry.js | Central building-state registry (cross-panel) |
| panel-pipeline.js | Send pipeline orchestration |
| panel-send.js | Send/stop buttons, queue, keyboard |
| panel-input.js | Input box: images, attachments, drafts |
| panel-render.js | Floor DOM rendering (streaming + restore) |
| panel-floor.js | Per-floor `all.txt` archive generation |
| panel-alltxt.js | all.txt streaming, stop, rules editing |
| panel-a4.js | Per-floor file-change snapshot block |
| panel-clock.js | Floor timers |
| panel-fav.js | Floor-favourite star + naming UI |
| panel-search.js | In-panel search |
| panel-drop.js | Drag&drop into AI panels |
| panel-expert.js | E-Flow expert-docs panel |
| panel-floor-indicator.js | Floor position indicator |
| panel-health.js | Module health check (red banner on missing exports) |
| panel-state.js | Panel UI state (queue, tier persistence) |
| expert-template/ | Expert-docs skeleton (E-Flow) |
| index.html | Panel document |

## 5 · `server-app/goods/` — built-in components

| Directory | Component |
| --- | --- |
| conv | Context-backpack viewer (per-panel conversation page) |
| dm | Inbox: clipboard history → message attachments |
| dsecret | secret-guard UI (queue / audit log / whitelist) |
| file-explorer | Roam file explorer |
| git | Git panel (multi-repo, log graph) |
| kmd | Line-mode terminal (cmd / PowerShell / git-bash) |
| kope-a | Clipboard-history keeper (Qt process) |
| mdview | Markdown preview iframe host |
| navigator | Quick-open navigator (Ctrl+P, recents) |
| qmd | Full-interactive terminal (ConPTY + xterm.js) |
| search | Search panel (ripgrep + smart index) |
| solar-house | Remote-hosted game panel |
| window-there | Window-layout keeper (3W/3X hotkeys, Qt) |
| _shim.js / _goods_i18n.py / _singleton.py | Shared helpers (dev shim, Qt i18n, single-instance) |

## 6 · Window globals registry

Two tiers: **integration points** — intended cross-module API, stable enough to
build on; **internal intrinsics** (`__qqq*`) — cross-frame plumbing that lives on
`window` only because iframes cannot share modules; treat as private.

### Integration points (owner = the file that defines it)

| Global | Owner | Purpose |
| --- | --- | --- |
| qqqideBridge | shell/preload.ts | The one native bridge (§7) |
| _i / _qq | core/i18n.js / ai-panel | Translate (main window / AI panel) |
| qqqideQoast / qqqideIoast | core/qqqide-qoast.js / -ioast.js | Toasts / task-dock cards |
| qqqTabs | core/tab-manager.js | Open files, manage tabs |
| qqqGaea | core/gaea-host.js | goods host API (register / open) |
| qqqLogin | core/login.js | Auth state, LV, openProfile |
| qqqCharUndo | core/char-undo.js | Mark undo checkpoints |
| qqqSettings | core/settings.js | Settings store (open panel, queries) |
| qqqEditor / qqqEditorBreadcrumb | core/editor.js / -breadcrumb.js | Editor access / breadcrumb refresh |
| qqqPrefs | core/qqq-prefs.js | User preference machine |
| __qqq_roamRevealPath | core/shell-overlay.js | The reveal-in-Roam entry (used widely) |
| qqqAudio | core/audio-volume.js | Audio engine API (play / volume) |
| qqqideTheme | core/qqqide-theme.js | Theme switch + layout constants |
| qqqideViewport | core/ai-viewport.js | AI viewport API |
| qqqGitPoll | core/ai-viewport.js | Git badge poller (`stats()` diagnostics) |
| qqqByok | ai-panel/byok.js | BYOK state |
| qqqEntitlement | core/entitlement.js | Feature-gate checks |
| qqqBootInfo | core/shell.js | Boot info (version, dev flags) |
| qqqViewportMachine / qqqFrameRenderer | core/viewport-machine.js / -frame-renderer.js | WYSIWYG frame machinery |
| __qqqKmdOpen | core/shell.js | Open a kmd/qmd tab (from anywhere) |
| qqqCenter | core/qqq-center.js | Settings-centre card |
| qqqideDefaults | core/defaults.js | Factory defaults |
| qqqMdPreview / qqqMdAttachAction | core/md-preview.js / -editor.js | Markdown preview control / attach action |
| qqqPasteRouter | core/paste-router.js | Paste entry |
| __qqq_aiFeedFile | core/ai-viewport.js | Feed a file to the AI panel |
| __qqqUiShown | core/shell.js | UI-ready flag (boot gates) |
| _qqqFlagImg | core/login.js | Flag image renderer (no emoji flags) |
| qqqCodelens | core/qqq-codelens.js | Codelens buttons API |
| qqqExport / qqqideDownload | core/export-machine.js / -download-machine.js | Export / download entries |
| qqqidePanel | ai-panel/ai-panel.js | AI panel API (per panel) |
| qqqideSash / qqqLayout | core/sash.js | Sash & layout APIs |
| qqqPlayerCard | core/player-card.js | In-window player card control |
| qqqSysInterpAsk (+ compat aliases) | core/settings.js | System-interpreter confirm dialog |
| qqqToolsMenu / qqqHelpMenu | core/qqq-tools.js / -help-menu.js | Workbench / help menus |
| qqqSavor | core/savor.js | Savor control |
| qqqFloorFavs | core/floor-favs.js | Floor favourites API |
| qqqAZone | core/shell.js | A-zone width API |
| qqqDefaultMenuSchema | core/menu-schema.js | Built-in menu schema |
| qqqideKeyHook | core/key-hook.js | Key-hook registration |
| qqqideKlipzap | core/klipzap.js | Clipboard API |
| qqqIsElectron | core/ipc-bridge.js | Environment flag |
| qqqWqStats / qqqEnsureGitignore | core/wq-stats.js / -ensure-gitignore.js | Probe widget / gitignore flow |
| __qqqSecretGuard | core/secret-guard.js | Secret-guard engine (used by dsecret) |

### Internal intrinsics

| Global | Purpose |
| --- | --- |
| __qqq_agentPool | Shared agent pool on the parent window |
| __qqq_buildingRegistry | Cross-panel building-state registry |
| __qqq_questOwners / __qqq_claimQuest / __qqq_releaseQuest | Quest ownership registry (inline in index.html) |
| __qqq_aiTarget / __qqq_updateAiTarget | Which panel a file feeds |
| __qqq_localBuildingQuests | Quests building in this window |
| __qqq_userBubbleEl | Current user-bubble element (Enter feedback) |
| __qqqGlobalRefreshLock | Editor global refresh lock |
| __qqq_reloading | iframe reload guard (double-ended protocol) |
| __qqqCompressMachine / _qqqAiGateway / _qqqEmbedding | Singleton machines re-exposed across frames |
| __qqqIsFreeWindow / __qqqCoreReady / __qqqAiReadyPending | Boot / free-window flags |
| __qqq_file_log / __qqq_floorToken / _qqqCurrentTrace | Per-floor diagnostics plumbing |
| __qqqLastKeyPath / __qqqXPress | x-key handoff state |
| __qqqImgSizes | Image size cache |
| _qqqEnoentCache / _qqqPathResolve / _qqqReadFilesThisFloor / _qqqToolCacheThisFloor | Tool-loop caches |
| __qqqQmdOpen / __qqqPlayerStowed | Window-stack hooks |
| _initA1Block / _initClockBlock / _initA4Block | Floor-block initializers |
| __qqq_getQuestOwner / __qqq_questIndex | Favourites ↔ quest-ownership bridge |
| __qqqHealth / __qqqUpdHealthRefresh | Health hooks |
| __qqqSecretGuard (engine) | See integration points — dual-role by design |

> The complete list (104 distinct `window.*` assignments at the last sweep) can be
> regenerated: `rg -o "window\.(qqq|__qqq)[A-Za-z0-9_]*" server-app | sort -u`.

## 7 · Bridge namespaces (`shell/preload.ts` — authoritative)

`window.qqqideBridge.*` — one namespace per capability area: `app`, `auth`,
`fs`, `shell`, `qz`, `search`, `ai`, `state`, `cache`, `qgf`, `timeline`,
`media`, `audio`, `wq`, `vig`, `clipboard`, `download`, `export`, `update`,
`boot`, `gaeaProcess`, `sysPy`, `kope`, `roam`, `wsState`, `searchState`,
`aiState`, `projectLock`, `squad`, `kmd`, `qmd`, `mem`, `secure`, `player`,
`sync`, `key`, `desktop`, `crashNet`. The full list with every method and its IPC
channel is `shell/preload.ts`.

## 8 · Cross-window messages (postMessage — non-exhaustive)

| Message | Purpose |
| --- | --- |
| qqq-lang-change | Language switched; every iframe re-renders |
| qqqide-theme-change | Theme switched (`dark` boolean) |
| qqqide-overlay | Open the shared lightbox/overlay (media, tables, images) |
| qqq-sfx | Play a sound effect through the shell audio engine |
| qqq-fav-open / qqq-fav-state / qqq-fav-query / qqq-fav-jump | Floor favourites (panels ⇄ main window) |
| qqq-ai-ready → qqqide:renderer-ready | Boot readiness handshake that controls the splash screen |

## Where to start reading

1. `README.md` — build & test.
2. `server-app/index.html` — the main-window load order.
3. `server-app/core/shell.js` — the orchestrator.
4. `server-app/ai-panel/index.html` + `ai-panel/ai-panel.js` — the AI panel.
5. `server-app/core/gaea-host.js` + `server-app/goods/_shim.js` — components.
