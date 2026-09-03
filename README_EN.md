# AI Quota Widget

A Windows desktop widget for viewing Codex quota and local token usage from Codex, Claude Code, OpenCode, Gemini CLI, Cline, and Antigravity, with complete Chinese and English interfaces.

[中文](README.md) · [Download](https://github.com/w1ndwill/ai-quota-widget/releases)

## Screenshots

These screenshots come from the current application running with local data; quota, token, and model values vary by machine. Click an image to open it at full size.

### Quota and usage overview

[![AI Quota dashboard](docs/images/en/dashboard-overview.jpg)](docs/images/en/dashboard-overview.jpg)

View Codex quota, reset cards, 24-hour and cumulative token usage, trends, a daily heatmap, and cache-hit rates.

### Filter models by source

[![Model source filter](docs/images/en/model-source-filter.jpg)](docs/images/en/model-source-filter.jpg)

Aggregate or filter model usage by Codex, Claude Code, OpenCode, Gemini CLI, Cline, and Antigravity.

### Data sources and appearance

[![Data-source and appearance settings](docs/images/en/settings-data-sources.jpg)](docs/images/en/settings-data-sources.jpg)

Enable each data source independently and configure the language, theme, and global shortcuts. Language changes update the dashboard, charts, model picker, and accessibility labels together.

### Compact mode

[![Compact mode](docs/images/en/compact-mode.jpg)](docs/images/en/compact-mode.jpg)

Shrink the window to `336 × 72` logical pixels with only the two quota periods plus pin and expand controls.

## Features

- Reads the current account quota and reset time from the local Codex `app-server`.
- Refreshes the shared Gemini 5-hour and weekly quota every five minutes while Antigravity is running; when it is closed, only an explicit refresh briefly starts the official background service and then exits.
- Shows reset-card counts, status, and expiry details.
- Calculates token usage from local Codex, Claude Code, OpenCode, Gemini CLI, and Cline sessions.
- Estimates the USD value of tokens from each model's public standard text API rates (not a subscription bill).
- Estimates Gemini-model token usage from local Antigravity sessions; external models are excluded and this is not official billing data.
- Provides model filters, trend charts, a daily heatmap, and cache-hit rates where available.
- Provides complete Chinese and English interfaces with light and dark themes.
- Supports tray operation, always-on-top, a `336 × 72` compact mode, and single-instance startup.
- Supports configurable shortcuts for panel visibility, compact mode, refresh, and always-on-top.

### Supported data sources

| Source | Read method |
| :--- | :--- |
| Codex | Local `app-server` quota and session JSONL |
| Claude Code | Local project-session JSONL |
| OpenCode | Local OpenCode CLI statistics and sanitized session exports |
| Gemini CLI | Session token summaries under `~/.gemini/tmp/<project>/chats/` |
| Cline | Task logs in VS Code-family global storage and `~/.cline/data` |
| Antigravity | Short-lived official background service for Gemini 5h/weekly quota, plus local transcript estimates |

OpenCode, Gemini CLI, and Cline are the new agent sources prioritized by public adoption, and the interface follows that order. The ranking uses reproducible GitHub stars as a popularity proxy (2026-08-10 snapshot: OpenCode 195.7k, Gemini CLI 106.4k, Cline 65.9k), not as a claim of actual active-user counts. OpenCode requires an installed local CLI. Gemini CLI reads token summaries from its official session records. Cline covers common data locations for VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf, and Cline CLI.

### Application architecture

| Layer | Responsibility |
| :--- | :--- |
| `main.js` | Electron lifecycle, window/tray behavior, shortcuts, and IPC orchestration |
| `app-config-store.js` / `dashboard-snapshot-store.js` | Configuration and dashboard-snapshot persistence |
| `usage-coordinator.js` / `usage-worker-client.js` | Usage caches, request coalescing, and worker lifecycle |
| `usage-worker.js` and Agent services | Local-session scanning and aggregation off the main thread |
| `renderer.js` / `model-usage.js` | UI interaction, chart rendering, and pure model aggregation |

While the window is visible, the usage worker is reused across the one-minute history refresh cadence. Hiding the window still releases the worker and Codex subprocess under the existing idle policy. The model menu is rebuilt only when its structure or selection actually changes.

Default shortcuts:

- `Ctrl+Shift+Space`: show or hide the main panel
- `Ctrl+Shift+M`: toggle compact mode

## Getting started

1. Download the Windows installer from [Releases](https://github.com/w1ndwill/ai-quota-widget/releases).
2. To view official Codex quota, install and sign in to the Codex desktop app first.
3. Start AI Quota Widget. It finds the local `codex.exe` automatically.

If Codex is unavailable, local usage statistics from other enabled agents still work while the Codex quota area reports a read failure. An unused or unavailable data source simply has no usage data.

The application reads session files for the current user only. OpenCode sessions are parsed through the official CLI's read-only sanitized export; Gemini CLI and Cline readers only extract token, model, and time fields. Transcript text is not written to the widget cache. Settings and usage caches are stored in the `.userdata` folder beside the application.

The UI's HTML, CSS, and JavaScript load once when the window starts. While running, only quota and local-log data are refreshed as needed. Hiding the app to the tray pauses UI refreshes and releases the log worker and app-managed Codex subprocess after an idle period.

## Development

Node.js 20 or newer is required.

```powershell
npm install
npm start
npm test
```

Build the unpacked Windows application:

```powershell
npm run build:win
```

Build the Windows installer:

```powershell
npm run release:win
```

Build artifacts are written to `release/`. See [CHANGELOG.md](CHANGELOG.md) for version history.
When rebuilding the unpacked app, the build script preserves settings and caches in `release/win-unpacked/.userdata`.

## Project structure

```text
src/      Application source
test/     Automated tests
docs/     Documentation images
scripts/  Build scripts
```

## License

[MIT](LICENSE)
