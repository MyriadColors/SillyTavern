# SillyTavern TypeScript + Modern Tooling Migration — Roadmap

> Status: **planning document, no code changes**. Summarizes feasibility findings + preparatory work + phased execution plan. Do not commit migration code until Phase 0 exit criteria are met.

## 1. Executive Summary

* **Verdict: feasible, but hard (7–8/10).** Do not attempt as a big-bang rewrite.
* Recommended path: **type-check JS first (JSDoc + `checkJs`) → incremental `.js → .ts` renames (backend first) → decouple frontend god-module → bundler/modern tooling last.**
* Runtimes (`bun` / `node >= 20` / `deno`, plus `src/electron/`) mean the migration must stay runtime-neutral until an explicit emit strategy is chosen. `bun`/`deno` run TS natively; Node 20 does not.

## 2. Baseline (Measured 2026-10-14)

| Area | Finding |
|---|---|
| Scale | ~**314 JS files, ~173k LOC** (`src` + `public/scripts`, excl. `lib/`, `third-party/`). `src/`: 98 files. `public/scripts/`: 205 files + 14 built-in extensions + 6 third-party dirs. |
| God-files | `public/script.js` ~12954 lines, `public/scripts/openai.js` 7468, `slash-commands.js` 7122, `world-info.js` 6530, `stable-diffusion/index.js` 5998, `src/endpoints/backends/chat-completions.js` 3064, `src/endpoints/characters.js` 2867. |
| Module system | Native ESM with relative imports **plus** globals. No `vite`/`webpack`/`rollup` config. Only `esbuild ^0.28.2` (`package.json`) used narrowly in `src/middleware/bundler-serve.js:23-29` to bundle vendors (`public/lib.js` → `public/dist/lib.js`). App code served as raw ESM. |
| Loading | `public/index.html:8240-8258`: classic global vendor scripts (`jquery`, `toastr`, `select2` → globals `$`, `toastr`) + `<script type="module">` entries (`eventemitter.js`, `scripts/i18n.js`, `script.js`) + one inline `window` script. |
| Coupling | ~100+ imports of `../script.js` (`world-info.js:3`, `reasoning.js:4`, `macros.js:2`, `tool-calling.js:3`, `backgrounds.js:2`, `openai.js:35`, `chats.js:31`, `st-context.js:71`, `group-chats.js:82`, `utils.js:10`, plus `macros/definitions/chat-macros.js:2`, `extensions/tts/index.js:1`, `extensions/expressions/index.js:3`, `slash-commands/SlashCommandClosure.js:1`). Circular god-module. Extensions deep-import (`extensions/memory/index.js:1-18` → `../../utils.js`, `../../../script.js`). |
| Globals | `toastr.` ~972 hits (`slash-commands.js:110`, `world-info.js:56`, `personas.js:41`, `stable-diffusion/index.js:39`), `window.` ~176 hits (`power-user.js:17`, `AutoComplete.js:9`), bare `$(` heavy (`openai.js:638`, `power-user.js:599`). |
| Types today | `typescript ^5.9.3` + `@types/express,node,multer,jquery,toastr,lodash…` already in `devDependencies` (`package.json:142-175`). JSDoc dense on hot paths (`utils.js` ~360 annotations, `chats.js` ~142, `slash-commands.js` ~135; backend `src/endpoints/tokenizers.js:20`, `extensions.js:73`) but inconsistent (`extensions.js:90,168` `@param {Object}`, `google.js:41` untyped, `backups.js:9` inline handler untyped). |
| Configs | `tsconfig.json:23-24` `allowJs:true, checkJs:false, strict:true, noEmit:true`, `include` only `backup.ts + src/**/*.d.ts`. `jsconfig.json:8` `checkJs:true` but `exclude: public/**` — **frontend unchecked**. `public/global.d.ts:172-191` already declares `toastr`, `SillyTavern.getContext`, jQuery plugins, `Chat*` types — viable seed. `src/backup.d.ts:1-80` + `backup.ts:8-15,161,294` is the working pilot pattern (new `.ts` + shim over `allowJs` JS + `backup.test.js`). |
| Backend shape | `src/endpoints/`: 45 `.js` files. `src/express-common.js:17,38,70,81,92` clean pure exports with `import('express').Request` JSDoc (easy to convert). `src/server-main.js:1-506` zero `export`, side-effect entry (hard, needs refactor). |
| Lint | `.eslintrc.cjs:15-66` splits `src/**` (node+ESM) vs `public/**` (browser+jquery); `:68-83` ignores `public/lib/**`, `extensions/third-party/**`, `quick-reply/lib/**`, `tts/lib/**`, `**/*.min.js`, `src/tokenizers/**`, `plugins/**`, `data/`, `backups/`, `cache/`, `docker/`. `tsconfig.exclude` must mirror this. |
| Tests | `tests/package.json:7-8` `test:unit` (jest, ~24 `*.test.js`: `backup`, `util`, `prompt-converters`, `chat-integrity`) + `test:e2e` (playwright, `baseURL 127.0.0.1:8000`, `*.e2e.js`: `MacroEngine/Lexer/Parser`, `WorldInfo`, `QuickReply`). `tests/jest.config.json:1-4` is `transform:{}, testEnvironment:node` — JS-only, needs `ts-jest`/`tsx` for TS. |
| Entry | `server.js` → `src/server-main.js` (Express). `package.json:120-126` `start: bun server.js`, plus `start:deno`, `start:bun`, `start:electron`. `engines: node >= 20`. |

## 3. Design Constraints (Do Not Break)

1. **Extension ecosystem compat.** First- and third-party extensions load as raw ESM with deep relative imports today. No alias/bundler/move that silently breaks `public/scripts/extensions/third-party/`.
2. **Multi-runtime.** `bun` / `node` / `deno` / Electron must keep working. No `tsc --emit` build step until an explicit emit strategy (e.g. `esbuild`, already a dep) is adopted and all launchers updated.
3. **PR discipline.** Target `staging` branch, ~200 lines/PR soft limit (`CONTRIBUTING.md`, `AGENTS.md`). Migration must be sliceable.
4. **Style.** 4-space indent, single quotes, semicolons, `comma-dangle: always-multiline`, 1tbs (` .eslintrc.cjs:87-129`). Run `npm run lint` before finishing any change.
5. **`data/` + `backups/` are git-ignored.** Never commit user data; keep them in `tsconfig.exclude`.

## 4. Target Architecture

* **Backend:** strict `.ts` Express handlers (`Request`/`Response`/`RequestHandler` typed), thin `server-main.js` wiring, pure logic in testable modules. `module: NodeNext`, `lib: ES2022`.
* **Frontend:** typed ESM, `script.js` demoted from god-module to composition root; shared state via `st-context.js` / `constants.js` / `events.js`; `SillyTavern.getContext()` + `libs` as the only supported extension surface. `module: ESNext`, `moduleResolution: Bundler`, `lib: ES2022 + DOM`.
* **Tooling (last):** optional Vite/esbuild for app code only after types are green and the extension contract is frozen. Vendors stay on the existing `bundler-serve.js` path until then.

## 5. Phased Plan

### Phase 0 — Type Baseline + Safety Net (days–1 week, immediate value, zero runtime change)

* [ ] Add `tsconfig.server.json` (include `src/`, `module:NodeNext`) and `tsconfig.web.json` (include `public/scripts/`, `module:ESNext/Bundler`, `DOM` lib). Keep root `tsconfig.json` as-is until cutover. Mirror `.eslintrc.cjs` ignores in `exclude`.
* [ ] Add `tsc --noEmit -p tsconfig.server.json` (and later `.web.json`) to CI alongside `npm run lint` (`AGENTS.md`). Informational at first, blocking after green.
* [ ] Enable `checkJs:true` **one directory at a time**, starting backend leaves: `src/util.js` → `src/express-common.js` → `src/endpoints/tokenizers.js, characters.js, image-metadata.js` → rest of `src/endpoints/`.
* [ ] Normalize JSDoc on touched files: `import('express').Request/Response/RequestHandler` (follow `tokenizers.js:20`, `extensions.js:73`, `express-common.js:17`).
* [ ] Plan `jest` TS transform (`ts-jest` or `tsx`); `tests/jest.config.json` currently JS-only. No test rewrites yet.
* **Exit:** `tsc -p tsconfig.server.json` green on `src/`; CI runs type-check; no runtime diff.

### Phase 1 — Backend Incremental `.ts` (2–4 weeks)

* [ ] Pilot: convert `src/express-common.js` (pure, typed, tested pattern) `.js → .ts`. Validate `bun`, `node`, `deno` launchers.
* [ ] Extract pure logic out of `src/server-main.js:1-506` into importable modules; leave it as thin wiring.
* [ ] Convert `src/endpoints/` file-by-file, typed-before-untyped (`characters.js:217`, `image-metadata.js:105-106` first; `google.js:41`, `backups.js:9` after cleanup). Keep `allowJs:true` during transition.
* [ ] Extend `src/types/` + per-module `.d.ts` shims (follow `src/backup.d.ts` pattern); remove shims as sources become `.ts`.
* [ ] Decide emit strategy before any emitted build: `noEmit` (type-check only, Bun/Deno native) vs `esbuild` transpile for Node 20. Update `start*` scripts + Electron + Docker only in that PR.
* **Exit:** backend builds/checks green on all runtimes; unit tests (`backup`, `util`, `prompt-converters`, `chat-integrity`) pass on TS transform.

### Phase 2 — Frontend Decoupling (biggest TS unlock, 1–3 months, JS-only refactors first)

* [ ] Invert `script.js` dependencies: move shared state/accessors into `st-context.js`, `constants.js`, `events.js`; `script.js` re-exports. No behavior change.
* [ ] Enforce: eslint `no-restricted-imports` banning **new** `from '../script.js'` / `from '../../../script.js'`; new code imports from `st-context.js`/`utils.js`.
* [ ] Contain globals: centralize `toastr`/`$`/`window` access behind importable wrappers; extend `public/global.d.ts:172-196` (follow existing `JQuery`, `Select2`, `SillyTavern` declarations) instead of fixing all 972+ call sites at once.
* [ ] Extract leaves first (`constants.js`, `utils.js`, `power-user.js` — already referenced by `global.d.ts:3,15-17`), god-files (`script.js`, `openai.js`, `slash-commands.js`, `world-info.js`) last.
* [ ] Enable `tsconfig.web.json` `checkJs` incrementally (leaves → pages → god-files). Expect thousands of implicit-`any`/`$` errors if enabled globally — do not enable globally.
* **Exit:** zero new `script.js` imports, `tsc -p tsconfig.web.json` green on leaves, Playwright E2E (`MacroEngine`, `WorldInfo`, `QuickReply`, `sample`) green.

### Phase 3 — Extension Contract Freeze (parallel with Phase 2)

* [ ] Document `SillyTavern.getContext()` + `libs` (`global.d.ts:177-181`) as the only supported surface.
* [ ] Ship one sample typed extension (follow `QuickReplyApi` pattern, `global.d.ts:4,174`).
* [ ] Keep raw-ESM loading; no aliases/bundler until contract is adopted.
* **Exit:** sample extension type-checks; third-party path untouched and passing E2E.

### Phase 4 — Modern Tooling / Bundler (only after Phases 1–3, +~1 month)

* [ ] Choose bundler scope: app code only; vendors stay on `bundler-serve.js` until proven.
* [ ] Update dev workflow (`npm run start` :8000), source maps, CSP, Electron (`src/electron/`), Docker, `tests/playwright.config.js` `baseURL`.
* [ ] Adopt path aliases + stable extension SDK; codemod deep relative imports (`../../utils.js`, `../../../script.js`).
* **Exit:** dev+prod+Electron parities, E2E green, extension authors' migration notes published.

## 6. First-5-Files Starter (Concrete)

1. `src/express-common.js` → `.ts` (pure, typed, low risk).
2. `src/endpoints/tokenizers.js` (already `TokenizationHandler`, `tokenizers.js:20,601-602`).
3. `src/endpoints/characters.js` (`characters.js:217` typed; `2867` lines — slice by handler).
4. `public/scripts/constants.js` (leaf, referenced by `global.d.ts:9`).
5. `public/scripts/utils.js` (`3133` lines, ~360 JSDoc annotations — slice, do not rename whole file at once).

## 7. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| `script.js` circular imports explode under `strict` (`noUncheckedIndexedAccess`, `noUnusedLocals`) | Phase 2 decoupling first; enable `checkJs` per-dir only |
| 972x `toastr` / bare `$` / `window.*` errors | Extend `global.d.ts` shims first; wrappers later |
| Breaking third-party extensions | Freeze contract (Phase 3) before any bundler/alias (Phase 4) |
| Node 20 vs Bun/Deno TS handling | `noEmit` type-check only until explicit `esbuild` emit PR covering all launchers |
| PR size (`staging`, ~200 lines) | Slice by handler/module; shims (`*.d.ts`) keep PRs small |
| Test gaps | `tsc --noEmit` in CI + existing `tests/` unit/E2E as gate; add `ts-jest`/`tsx` before backend renames |

## 8. Estimates

* Phase 0: days–1 week.
* Phase 1 (backend): 2–4 weeks.
* Phase 2 (frontend decouple + types): 1–3 months (dominated by `script.js` + E2E).
* Phase 3 (contract): overlaps Phase 2.
* Phase 4 (bundler): +~1 month, mostly compat/support.

## 9. Open Decisions

* [ ] Emit strategy: `noEmit` check-only vs `esbuild` transpile for Node?
* [ ] Scope: backend-only first, or backend+frontend leaves in parallel?
* [ ] `strict` as-is (`tsconfig.json:7-19` all on) or relaxed (`noUncheckedIndexedAccess:false`) during transition?
* [ ] `staging`-branch PR slicing order for `src/endpoints/`?

## 10. Sources

* `package.json` (deps, `typescript ^5.9.3`, scripts `start/lint`, `engines: node >= 20`).
* `tsconfig.json`, `jsconfig.json`, `.eslintrc.cjs`, `server.js`, `src/server-main.js`, `src/express-common.js`, `src/middleware/bundler-serve.js`.
* `public/index.html:8240-8258`, `public/global.d.ts`, `public/scripts/{utils,chats,slash-commands,openai,world-info}.js`, `public/scripts/extensions/memory/index.js:1-18`.
* `src/endpoints/{tokenizers,characters,image-metadata,google,backups}.js`, `src/backup.d.ts`, `backup.ts`, `src/util.d.ts`.
* `tests/package.json`, `tests/jest.config.json`, `tests/playwright.config.js`, `AGENTS.md`, `CONTRIBUTING.md`.
