# AGENTS.md

SillyTavern — self-hosted AI chat frontend + Node/Express backend. No browser framework; vanilla JS + jQuery.

## Commands

- Start dev server: `npm run start` (port 8000; config in `config.yaml`, data root `./data/`)
- Lint (root): `npm run lint` (or `npm run lint:fix`). Run before finishing any change.
- **Tests live in `tests/` with their own package.json** — there is no root test script.
  - Setup once: `npm ci --prefix tests`
  - Unit tests: `npm run test:unit --prefix tests` (jest; requires `--experimental-vm-modules`, already in the script)
  - Single unit test: `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json path/to.test.js` (run in `tests/`)
  - E2E (playwright): `npm run test:e2e --prefix tests` — needs a running server; base URL via `ST_BASE_URL` (default `http://127.0.0.1:8000`)
- Node >= 20 required. Deps tracked by `bun.lock` (authoritative lockfile); Start.bat uses bun.

## Architecture

- Entrypoint `server.js` → `src/server-main.js` (Express app). ES modules everywhere (`"type": "module"`).
- Server routes per domain in `src/endpoints/*.js` (openai, anthropic, characters, chats, ...).
- Browser client: `public/scripts/*.js` (jQuery, globals like `toastr`, `SillyTavern`), extensions in `public/scripts/extensions/`, UI in `public/`.
- Server plugins loaded via `src/plugin-loader.js`; UI extensions register through `SillyTavern` globals.
- `.eslintrc.cjs` differentiates server (`src/`, `./*.js`) vs browser (`public/`) envs — client code must not assume Node globals and vice versa.

## Conventions / gotchas

- Style (enforced by ESLint): 4-space indent, single quotes, semicolons, `comma-dangle: always-multiline`, 1tbs braces. Match existing code.
- jsdoc comments used on server code; ESLint `jsdoc/no-undefined-types` is active.
- `data/` (user data) and `backups/` are git-ignored; don't commit user data.

## Contributing workflow

- PRs target the **`staging`** branch (not `release`). `release` only for README/GitHub Actions/critical hotfixes.
- Soft limit ~200 lines changed per PR; split larger work. English only.
- License: AGPL-3.0. See `CONTRIBUTING.md` for full details.
