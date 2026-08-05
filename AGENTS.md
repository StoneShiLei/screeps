# AGENTS.md

## Cursor Cloud specific instructions

### What this project is
This is `screeps-typescript-starter` — a Screeps AI written in TypeScript. The
"application" is not a standalone server: `src/` is bundled by Rollup into
`dist/main.js`, which is then executed by a Screeps game server (the hosted
`screeps.com` MMO/season, the in-browser simulator, or a self-hosted private
server). There is no local web/GUI service and no database to run.

### Node version (important)
The repo pins Node via `.nvmrc` (`v20.19.5`), but the sandbox's default `node`
on `PATH` may be Cursor infrastructure Node v22 at `/exec-daemon/node`. `nvm`'s
`default` alias is set to `v20.19.5`, so login shells resolve Node 20. If a
shell ever shows v22, activate the pinned version from the repo root:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use   # reads .nvmrc
```

There are no native/compiled dependencies, so `node_modules` is portable across
Node 20/22.

### Standard commands (see `package.json`)
- `npm run lint` — ESLint over `src/**/*.ts`
- `npm run build` — Rollup compile to `dist/main.js` (dry run, no upload)
- `npm test` / `npm run test-unit` — Mocha unit tests (`test/unit/**/*.ts` via `ts-node`)

`dist/` is git-ignored and produced by the build.

### Running / deploying the AI (needs credentials)
Uploading the bundle to a real Screeps server uses `npm run push-*` /
`npm run watch-*` (e.g. `push-main`, `watch-sim`). These require a
`screeps.json` at the repo root (copy `screeps.sample.json` → `screeps.json`,
git-ignored) filled with a Screeps account **token** (MMO/season) or
email/password (private server). No such credential is provided in this
environment, so live pushes are not possible here. To verify the AI executes
without a live server, run the unit tests (they invoke the real `main.ts`
`loop()`), or build and drive `dist/main.js` through mocked game ticks.

### Integration tests (optional, not installed)
`npm run test-integration` is a no-op until you install
`screeps-server-mockup` and wire up the script per
`docs/in-depth/testing.md`. It pulls in a full embedded Screeps server; treat
it as optional.

### `tools/` scripts (optional)
The `ts-node` scripts in `tools/` call the live Screeps HTTP API (hardcoded to
`shard3`) and need a token in `screeps.json`; they are offline analysis
helpers, not part of the core build/test loop.
