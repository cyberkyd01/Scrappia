# @scrappia/desktop

Electron desktop app for Scrappia: the visual **recorder** (point-and-click recipe builder driving a
headed stealth Chromium), a **run monitor** with live rows/stats/drift, **exports**, **scheduling**
and **settings** (AI providers, secrets vault, browser install).

Stack: Electron 44, electron-vite 5, React 19, Vite 7, plain CSS. All dependencies live in the
repository root `package.json` (no workspaces, no symlinks; `@scrappia/*` resolve through stub packages
in the root `node_modules` that point at each package's `dist`).

## Develop

```sh
# from the repository root
npm install --no-audit --no-fund          # once; also runs scripts/link-packages.mjs
npm run build --prefix packages/core      # core must be built (main process imports its dist)
npm run build --prefix packages/inspector # overlay bundle (optional: a stub overlay is used when missing)

npm run dev --prefix apps/desktop         # electron-vite dev server with HMR for the renderer
```

Other scripts (all `--prefix apps/desktop`): `typecheck`, `test` (vitest: recipe reducer,
pick-to-field helper and the copilot chat-log helper), `build` (produces `out/main`, `out/preload`, `out/renderer`), `package`
(build + electron-builder: Windows NSIS + portable, macOS dmg, Linux AppImage; see
`electron-builder.yml`).

Launching the built app without the dev server: `npx electron apps/desktop` from the repo root. If the
`ELECTRON_RUN_AS_NODE` environment variable is set in your shell (some IDE terminals set it), unset it
first or the Electron binary starts as plain Node.

Data lives in `app.getPath('userData')/data` (Windows: `%APPDATA%\Scrappia\data`): the SQLite database
(`scrappia.db`, via `node:sqlite`), exports written with relative paths, and browser profiles under
`profiles/` (the recorder uses the persistent profile `recorder`, so logins survive restarts).

## Architecture

```
src/shared/ipc.ts      typed contract: IpcApi (invoke channels) + IpcEvents (push channels)
src/main/index.ts      app bootstrap: ScrappiaApp (storage + scheduler), window, single-instance lock, shutdown
src/main/ipc.ts        one ipcMain.handle per IpcApi channel
src/main/recorder.ts   RecorderSession: headed patchright Chromium with the inspector overlay injected
src/main/copilot.ts    RecorderCopilotHost (core CopilotHost over the recorder) + CopilotManager (session, log, pick forwarding)
src/main/inspector.ts  loads @scrappia/inspector's bundle (falls back to a stub overlay)
scripts/e2e-copilot.mjs end-to-end test of the copilot in the built app (plain node, see "Copilot")
src/preload/index.ts   contextBridge -> window.scrappia { invoke, on } (channel allow-list)
src/renderer/          React UI: views (Home, Recorder, RunMonitor, Settings), recipe reducer, editors
```

Security: `contextIsolation: true`, `nodeIntegration: false`, the preload only forwards channels listed
in `src/shared/ipc.ts`, and the renderer never imports `@scrappia/core` at runtime (types only; validation
goes through the `app.validateRecipe` IPC call).

## How the recorder works

1. **Open browser**: the main process launches a headed Chromium through core's `PlaywrightProvider`
   (patchright, stealth args, persistent profile `recorder`) positioned next to the app window, and
   injects the inspector overlay from `@scrappia/inspector` into every page via `addInitScript`.
2. **Overlay -> app**: the overlay calls `window.__scrappiaHost(message)` (a Playwright
   `exposeBinding`). `RecorderSession` forwards every `OverlayMessage` (`ready`, `picked`,
   `list.detected`, `hover`, `preview`, `navigated`, `error`, `log`) to the renderer as the
   `inspector:message` event.
3. **App -> overlay**: the renderer calls `recorder.*` IPC methods; the session evaluates
   `window.__scrappiaInspector.<method>(...)` in the page. patchright evaluates in an isolated world
   by default, so those calls pass `isolatedContext = false` (4th `page.evaluate` argument) to reach
   the overlay's main-world global. The picking mode is re-applied after every navigation.
4. **Capture flow** (renderer): a click in *Pick field* mode yields a `PickedElement` with ranked
   selector candidates (document scope and, inside repeating records, selectors relative to the
   record). The capture panel builds a `Field` from it (`src/renderer/lib/pickToField.ts`), lets you
   edit name/type/attr/transforms/candidates, test candidates (highlight + match count), capture more
   content (walk up), set the record list (with suggested fields and alternative lists), follow the
   link into a new template, set pagination (next / load more / infinite scroll) or add actions.
5. **Preview**: the bottom panel evaluates core's `domExtract` in the live page with the current
   template (same wrapper as core's `pageRunner`) and shows records plus per-column match stats.
   *Test run (5 pages)* starts a `dryRun` with `maxRequests: 5` through the real engine and streams rows.
6. **Save / Run**: recipes are validated with core's zod schema (via IPC), saved to storage
   (versioned), scheduled when they carry a `schedule`, and runs stream `RunEvent`s to the run monitor.

## Copilot

The recorder has a **Copilot** chat panel at the bottom (toggle with the *Copilot* button in the top
bar, `Ctrl+/` focuses the input, drag its top edge to resize, the collapsed state is remembered).
It drives core's `CopilotSession` (`packages/core/src/ai/copilot.ts`): every turn the model answers
with a JSON plan (`reply` + tool calls) and the desktop executes the tools against the live recorder.

- **Provider requirement**: the copilot needs an AI provider in Settings > AI providers (Anthropic or
  any OpenAI-compatible endpoint: OpenAI, OpenRouter, Ollama, LM Studio, ...). Without one the panel
  shows an empty state with an *Open Settings* button. The provider selector in the panel header
  switches models mid-conversation (history is kept); *Default provider* and *Copilot instructions*
  (extra system-prompt guidance, passed as `extraInstructions`) live in Settings > AI providers.
- **How it works** (`src/main/copilot.ts`): `RecorderCopilotHost` implements core's `CopilotHost`
  over the `RecorderSession` + `ScrappiaApp`: page/content (`pageHtml` -> `htmlToMarkdown`/`cleanHtml`),
  `detectLists`, selector tests (highlight for ~2 s), previews (`extractPreview`), navigation, live
  actions, `test_run` (a `dryRun` through the real engine in a separate headless browser, never the
  recorder page), `start_run` (`app.startRun(..., { trigger: 'copilot' })`), save, secrets and sink
  types. `CopilotManager` keeps one session per recorder session **in main memory**: the chat log,
  the working recipe and the model history survive view changes (e.g. visiting the run monitor) but
  not app restarts. Every turn result's recipe is applied to the recorder's working recipe
  (`replaceRecipe`), so the template tree, JSON and data preview update live.
- **Picking hand-off**: when the model calls `enable_picking` the recorder switches to that mode, the
  panel shows *"Copilot is waiting for you to click ... in the browser window. Say "done" when
  finished."*, and the user's clicks (`picked` overlay messages; `list.detected` only when it did not
  come with a pick) are forwarded to the copilot as events, which turns them into the record list and
  fields. While the copilot waits, the capture panel ignores those picks. Quick replies: *Let's start
  scraping*, *I'm done picking*, *Detail pages*, *Next page*, *Run it*, *Save recipe*.
- **Runs**: when the copilot starts a full run the app switches to the run monitor (with a
  *Back to recorder* button that restores the conversation); when that run finishes a
  `run.finished` event is sent to the copilot so it can summarise the result.
- **IPC**: `copilot.available | start | turn | history | reset | cancel` and the push events
  `copilot:progress`, `copilot:log`, `copilot:status`, `copilot:recipe`, `copilot:run`
  (see `src/shared/ipc.ts`).

### End-to-end test

`node apps/desktop/scripts/e2e-copilot.mjs` (plain Node, not part of vitest; needs core, inspector and
the desktop app built and patchright's Chromium installed) starts a local 3-page product listing and
a scripted OpenAI-compatible mock LLM (`startMockLlm` from core), seeds the AI provider into a
throw-away userData directory, launches the built Electron app with `--remote-debugging-port`, drives
the UI with patchright over CDP (New recipe -> recorder -> Copilot), performs a **real click** on a
product card in the recorder browser (reached through `SCRAPPIA_RECORDER_CDP_PORT`), and asserts the
`set_list` chip, the template tree fields, the pagination in the recipe JSON, the switch to the run
monitor with rows > 0 and the copilot's final summary after returning to the recorder. A second
scenario checks the "no AI provider" empty state. `--no-ai` runs only that scenario, `--keep` keeps the
temp directories. Environment hooks used by the harness: `SCRAPPIA_USER_DATA` (Electron userData
directory, applied before the single-instance lock) and `SCRAPPIA_RECORDER_CDP_PORT`.

## Troubleshooting

- **"Executable doesn't exist" / recorder does not open**: the Chromium build used by patchright is
  not installed. Settings > Browsers > *Install Chromium* runs `npx patchright install chromium` and
  streams its output; or run that command manually from the repo root.
- **Overlay never becomes ready** ("overlay loading…" persists on a loaded page): the inspector
  package is not built (`npm run build --prefix packages/inspector`); the app then uses a stub overlay
  that only supports `highlight` / `regionHtml` and cannot pick elements. Some pages with strict CSP
  or heavy iframes can also delay injection; reload the page.
- **Clicks in the recorder browser do not navigate**: that is the picking mode intercepting clicks.
  Switch the mode to *Off* to browse/log in normally (actions run from the app disable it automatically).
- **`node:sqlite` errors**: the app requires the Node runtime bundled with Electron 44 (Node 24). Do not
  run the built main bundle with an older system Node.
- **Second window does not open**: the app holds a single-instance lock; the existing window is focused.
- **Where are my files?** Settings > About shows the data directory and browser profiles; relative sink
  paths resolve under Settings > Defaults > *Output directory* (default: the data directory).
