# Contributing

## Setup

```bash
npm install                      # single root install; local packages are linked by scripts/link-packages.mjs
npx patchright install chromium
npm run build
npm test
```

Node 22.13+ is required (the storage layer uses the built-in `node:sqlite`).

## Layout rules

- All dependencies go in the **root** `package.json`. Sub-packages declare no dependencies. This
  keeps the repo working on filesystems without symlinks and gives one lockfile.
- `packages/core` must stay free of Electron and UI code. Everything the desktop app, CLI, server
  and MCP server need goes through `ScrappiaApp` in `packages/core/src/app.ts`.
- The recipe schema (`packages/core/src/recipe/schema.ts`) is the public contract. Additive changes
  are fine; breaking changes need a migration in `recipe/migrate.ts` and a version bump.
- `packages/core/src/dom/extractor.ts` runs inside the browser via `fn.toString()`. It must not
  reference module-scope identifiers or Node APIs.
- The inspector overlay (`packages/inspector/src/inject`) is bundled to a single IIFE and must not
  import Node modules at runtime.

## Tests

- `vitest` everywhere. Core tests run a local fixture site (`src/test/fixtureSite.ts`); browser
  tests need the Chromium install and are skipped-free (they run for real).
- Add a test with every bug fix.

## Commit style

Conventional-ish: `core: …`, `desktop: …`, `server: …`, `cli: …`, `inspector: …`, `docs: …`.
