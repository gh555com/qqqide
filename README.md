<p align="center">
  <img src="https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/FPXKHX4NKOZJ6.gif" width="100%" alt="qd (qqqide)">
  © 2005 <a href="https://www.gh555.com">gh555.com</a> All Rights Reserved.
</p>

# qd (qqqide)

**A portable AI-powered IDE for Windows 7–11 (x64) and macOS.** Paste anything with WYSIWYG preview, roam any directory, keep every file version in a timeline, and plan / build / review with an integrated AI panel — from a single folder, no installer required.

**Download:** <https://gh555.com/dl/qqqide> ｜ **Website:** <https://gh555.com/qd>

> **What this repository is.** The client runtime source of qqqide: the Electron shell, the IDE payload, the Rust process-runner sources, the component manifest and the build scripts — published so the code can be read and audited (see `LICENSE`; source-available, not open source).
>
> The **VS Code / Code-OSS / VSCodium sibling** — paste-everything and rich-media inside the VS Code family, with roadmap discussions — lives at **[gh555com/qqq](https://github.com/gh555com/qqq)**. Same idea base, two different products: an extension for editors you already run, and a standalone IDE.

## Highlights

- **Paste everything, WYSIWYG.** Screenshots, image / video / audio files, folders, HTML pages and clipboard fragments paste straight into any document — `.md`, `.txt`, custom extensions, even extension-less files — and render in place as live frames you can preview, play and export.
- **Roam file explorer.** Keyboard-first navigation across your whole machine (not just the current project), recent locations, transactional copy / move / delete with resume, and clipboard integration with the OS file manager.
- **AI panel.** Multi-task chat with floors that persist, context compaction, per-task AI tiers, tool-calling (files, search, terminals, web), and **BYOK** — bring your own API key, direct to the endpoint you configure.
- **Editor & timeline.** Monaco-based editor with a local file-version timeline (snapshots on edits and on AI/tool-driven writes), side-by-side diffs, and restore.
- **goods — built-in components.** A component host drives first-party tools (terminal, inbox, search, git, image paste, file explorer, …) with a single registration protocol.
- **Signed, atomic self-update.** Full-package updates verified with Ed25519 signatures (public key embedded in the launcher) are staged in the background and swapped in atomically at startup. Details in `SECURITY.md`.
- **Portable by design.** No installer — the app runs from a folder, and project + app data travel with it. A small OS-level state folder (`%LOCALAPPDATA%\qqqide` on Windows) holds cross-window state; see `PRIVACY.md` for the exact list. Win7 SP1 → Win11 supported from one x64 build.

## Architecture

qqqide is a four-layer desktop system:

| Layer | Directory | Role |
| --- | --- | --- |
| Launcher | *(separate distribution)* | Tiny native launcher: dispatch, verified atomic self-update |
| Shell | `shell/` | Electron main process (TypeScript → esbuild): windows, IPC bridge, process & component management |
| Runner | `ghrun/` | Rust process runner: one process per command, kernel-level resource limits, stall watchdog |
| Payload | `server-app/` | The IDE itself: UI, editor, AI panel, built-in components (hot-reloadable) |

Electron is pinned at **22.3.27** on purpose — it is the last line that runs on Windows 7 SP1. The trade-offs this implies, and the compensating defenses, are documented in `SECURITY.md`.

## Repository layout

```
shell/            Electron main process sources (TypeScript)
server-app/       IDE payload: core, AI panel, editor, goods, locales (13 languages)
ghrun/            Rust process-runner + watchdog sources
shell-build/      Build scripts: esbuild bundling, dev server, packaging
engines/          Component manifest + prebuilt binaries (process runner, ripgrep) + Python bridges
assets/           App-local VC++ runtime DLLs (Windows 7 compatibility)
ci/               Static checks (node --check) and unit tests (node:test)
docs/             Glossary and public-facing notes
.github/          CI workflows
```

## Build & test

Requirements: **Node.js ≥ 16** (CI runs on Node 20), npm. The product targets Windows; the build scripts run on Windows, Linux and macOS.

```bash
npm ci              # install dev toolchain (esbuild, TypeScript, …)
npm run build       # bundle shell/*.ts → shell-out/ (esbuild)
npm test            # unit tests (node:test) — encoding machine, version compare, cmd tokenizer, …
npm run check       # full local gate: syntax + types + tests
npm run smoke       # end-to-end smoke: boot → probe → exit (isolated temp data dir, non-zero on failure)
npm run dev         # dev loop: esbuild watch + dev server + Electron
```

`npm test` covers the parts where a bug corrupts data rather than merely misbehaving: the text-encoding machine (BOM / strict UTF-8 / GBK), the Windows command tokenizer (quote splitting / array-spawn routing), semantic version comparison, the `.gitignore` probe parser, and the multi-instance merge rules for window squads. CI (`.github/workflows/static-checks.yml`) runs the syntax gate, `tsc --noEmit` and the test suite on every push. `npm run smoke` boots the real shell against the bundled webapp in an isolated temp data directory, waits for the renderer-ready signal, probes the preload bridge over IPC, then exits with a status code — CI (`.github/workflows/smoke.yml`) runs it on every push as well.

## What is intentionally not in this repository

To keep the published tree reviewable, these parts live outside it:

| Part | Why |
| --- | --- |
| `launcher/` | The native launcher is distributed as a binary; its sources are maintained separately |
| `op/`, `tools/`, `proxy/` | Internal translation pipeline, release tooling, network helpers |
| `do/` | Internal engineering documentation |
| Build outputs | `shell-out/`, packaged packs and release artifacts are never committed |

Because of that, this repository is not a one-command reproduction of the shipped product — it is the readable, auditable core: shell + payload + runner + build scripts, with the update-integrity paths fully in view.

## Security & privacy

- `SECURITY.md` — threat model, defenses in place (signed updates, navigation hardening, atomic writes), and the known trade-offs (why `webSecurity`/`sandbox` are relaxed for local content; why Electron 22).
- `PRIVACY.md` — the exact telemetry field classes (aggregate counters and environment only; never file contents, prompts or keystrokes), plus the local-only nature of project and clipboard data.
- `secret-guard` — an opt-in local scanner that detects well-known credential formats before they get committed.

Security reports are genuinely welcome: see `SECURITY.md` for the private channel.

## Contributing

This is not a community project — we are not accepting external pull requests at this time. Bug reports and security reports are welcome; see `CONTRIBUTING.md`.

New to the terminology (`floor`, `house`, `goods`, `qgs`, …)? See `docs/GLOSSARY.md`.

## License

**Source Code Public & Auditable — not an open-source license.** You may view and clone the code for personal study, research, and security/audit review. Commercial use, redistribution, forks/mirrors, derivative works and imitating the product's UI/trade dress are not permitted. Full terms: [`LICENSE`](LICENSE).

## Contact

- Official site: <https://www.gh555.com/qd> · Downloads: <https://gh555.com/dl/qqqide>
- Discussions / roadmap: <https://github.com/gh555com/qqq/discussions>
- Email: **ky@gh555.com** (general) · **29492511@qq.com** (security)

<p align="center">
Sichuan Dream Technology Co., Ltd. · Chengdu, China
</p>

<sub>Keywords: AI IDE, portable IDE, WYSIWYG paste, paste image, file explorer, rich media, markdown preview, media preview, timeline, diff, encrypted update, Ed25519, editor, Windows 7, 粘贴图片, 文件管理器, 富媒体, 所见即所得, 预览, 时间线, 便携, 画像の貼り付け, ファイルマネージャー, プレビュー, Bild einfügen, Dateimanager, Vorschau, 이미지 붙여넣기, 파일 관리자, 미리보기, Вставить изображение, Проводник, WYSIWYG, Предварительный просмотр, لصق الصورة, مدير الملفات, معاينة, Pegar imagen, Gestor de archivos, Vista previa, Coller une image, Gestionnaire de fichiers, Aperçu, Colar imagem, Gerenciador de arquivos, Pré-visualização, छवि चिपकाएं, फ़ाइल प्रबंधक, पूर्वावलोकन, Dán hình ảnh, Trình quản lý tệp, Xem trước</sub>
