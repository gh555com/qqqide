# Privacy — qqqide

Short version: **your code and your conversations stay on your machine.** We
collect a small, documented set of aggregate diagnostics to keep installs
healthy — never file contents, never prompts, never keystrokes.

## Local first

Everything qqqide does with your files happens locally:

- project data lives in `{project}/_qqq/`
- app-level data lives in the portable app folder
- OS-level state lives in the platform app-data folder
  (`%LOCALAPPDATA%/qqqide` on Windows)

Nothing is uploaded automatically. Sync features (Cloud Sync for settings,
clipboard history and Roam preferences) run **only when you click them**.

## Telemetry (inspectable in the source: `shell/wq-ping.ts`)

A periodic anonymous ping keeps deployment healthy. The exact field classes:

**Identity**
- `device_id`: random UUID generated on first run — not tied to hardware.
- `doer_id`: only after you log in (derived from your account) so usage can be
  attributed for billing/companionship features. Not sent when logged out.

**Environment**
- app version, OS platform/arch, language, time zone, UI theme (light/dark).

**Aggregate counters** (numbers only, cumulative; no content)
- floors/tasks created, pastes, exports, window-recall hotkey usage, window
  squadding summons, sound-bank usage, media-cache hits/misses, component
  presence.

**Health**
- update pipeline status (result codes, failure counts, version ids).
- crash counters (counts only; crash message text is never sent).

**Never sent:** file contents, source code, AI prompts or responses, clipboard
contents, keystroke sequences, window titles, project names.

## Keyboard hotkey

A global hotkey (hold Space + slot key) recalls IDE windows. On Windows it is
implemented as a read-only poll of those specific key states — it is not a
keylogger and does not record or transmit any keystrokes or text.

## Clipboard

- Clipboard history is a local convenience database (OS-level, per device).
- It is included in Cloud Sync **only** when you explicitly run an upload.

## Crash records

Crash diagnostics (`crash-net`) are written locally in the app folder for
support purposes; only counters ever ride along telemetry (see above).

## AI features

- **Your own API key (BYOK):** requests go directly to the provider you
  configured; keys are stored locally, encrypted with the OS keystore when
  available. In direct mode we never see them.
- **Platform proxy mode (optional):** the request is forwarded through our
  gateway to your configured provider; keys are not persisted there and the
  proxy does not record conversations.
- Request content is used to fulfill your request and for metering.

## Account data

Phone number (login), entitlement/purchase records and balance live on the
project's servers.

## Questions

Email **29492511@qq.com**.
