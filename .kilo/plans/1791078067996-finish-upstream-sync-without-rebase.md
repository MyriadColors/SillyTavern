# Finish the upstream/staging sync without the rebase

## Context

`git pull upstream staging` started a rebase because `~/.config/git/config` sets
`[pull] rebase = true`. The rebase replays 22 local commits that were authored against an
old base (`380e31e8c`) onto upstream's tip, producing conflicts that must be resolved
again for every commit.

That work is unnecessary. Verified facts:

- `git rev-list --count ad29cbda6 --not cd6f0442a` → **1**. Local `staging` (`cd6f0442a`,
  also `origin/staging`) already contains all upstream commits except `ad29cbda6`.
- `git show --stat ad29cbda6` ("docs: route new provider contributions before
  implementation (#6099)") touches only `CONTRIBUTING.md` and
  `.github/pull_request_template.md`.
- `git diff --name-only bc81b9f7e cd6f0442a` (the full local delta vs. the last merged
  upstream commit) contains neither file → a merge is **conflict-free**.
- `git status --porcelain` shows only staged/`A`/`D` entries, one unmerged path
  (`package-lock.json`), and untracked `PRs/`. Nothing uncommitted would be lost by aborting.
- Local history already contains `7916649a5 "Merge branch 'upstream/staging' into staging"`,
  so merging is this fork's established sync workflow.

Outcome of the recommended path: one merge commit, zero conflicts, tree identical to
`cd6f0442a` plus upstream's two doc files. All 23 local commits stay intact.

## Decisions taken

- **Abort the rebase, merge instead of rebasing.** Do not continue resolving the 22 commits.
- **Leave `public/dist/lib.js` tracked.** It is a 1.9 MB minified esbuild bundle that
  `bun run start` regenerates via `bundlerMiddleware.runCompiler()`. Untracking it is a
  separate cleanup, out of scope here.
- **Do not push.** Stop after the local merge commit; report the result.

## Steps

1. Abort the rebase and return to a clean `staging`.
   ```
   git rebase --abort
   git status
   git log --oneline -3
   ```
   Expect: branch `staging` at `cd6f0442a`, clean tree, untracked `PRs/` still present.
   `node_modules/`, `tests/node_modules/`, `public/dist/` are ignored and untouched.
   If anything unexpected is dirty, stop and report instead of continuing.

2. Create a safety tag on the pre-merge tip (local `backup/pre-sync-staging` already
   exists at `5f181b429`, but does not cover `cd6f0442a`).
   ```
   git tag pre-upstream-merge-2026-10-04 cd6f0442a
   ```

3. Merge upstream. `upstream/staging` is already fetched at `ad29cbda6`; no fetch needed.
   ```
   git merge --no-edit upstream/staging
   ```
   Expected: fast content merge, no conflict, one merge commit.
   Verify the scope of the change:
   ```
   git diff --stat HEAD^1 HEAD
   git status
   ```
   Expected diff: `CONTRIBUTING.md` + `.github/pull_request_template.md` only, clean tree.

4. Confirm history is intact.
   ```
   git log --oneline -3
   git rev-list --count ad29cbda6..HEAD
   ```
   Expect `0` commits in `ad29cbda6..HEAD` (upstream fully contained) and the 23 local
   commits still reachable (`git log --oneline origin/staging..HEAD` shows only the merge).

## Validation

The merge changes no `.js`/`.ts`/`.json`/`.html` file, so behavior is unchanged and no code
validation is strictly required. Run these as cheap confirmation that the
abort/reset/merge round-trip left the tree intact:

- `npm run lint` — should report the same result as before the abort. If it fails, confirm
  the failure pre-exists on `cd6f0442a` (`git stash list` is irrelevant here; compare by
  checking out the tag in a scratch worktree) rather than assuming the merge caused it.
- `npm run test:unit --prefix tests` — optional, informational. `tests/node_modules` is
  already installed. Expect the fork's own suites to be state-dependent (e.g.
  `tests/private-request-filter.test.js` reads `config.yaml`, which is git-ignored and may
  be absent).
- `bun install` — no-op; `bun.lock` is unchanged by the merge.
- `bun run start` — optional; confirm the esbuild step runs and the server boots. Expect
  `public/dist/lib.js` to be rewritten and show as modified afterwards. That is the known
  tracked-artifact behaviour, not a regression. Do not commit it.

## Risks and notes

- **`git rebase --abort` performs a hard reset.** Any uncommitted manual edit made during
  the earlier conflict resolution would be lost. Verified absent in step 1's `git status`;
  the rerere cache in `.git/rr-cache` (7 entries) stays on disk and becomes unused.
- **Rollback:** `git reset --hard pre-upstream-merge-2026-10-04`.
- **Prevent recurrence:** `~/.config/git/config` has `[pull] rebase = true`, so future
  `git pull upstream staging` will rebase again and produce the same storm. Use
  `git pull --no-rebase upstream staging` going forward, or set
  `git config --global pull.rebase false`. Optional per-branch override:
  `git config branch.staging.rebase false`.
- **`git status` will keep showing `package-lock.json` semantics.** The fork deletes
  `package-lock.json` and ignores it via `/package-lock.json` in `.gitignore`; that is
  already committed locally and is unaffected by this merge. Upstream still tracks
  `package-lock.json`, so future upstream merges will re-introduce the modify/delete
  conflict — resolve by deleting it again.

## Out of scope

- Untracking `public/dist/lib.js`.
- Reconciling `backup.ts` / `tsconfig.json` (added by `20578460b`) with upstream's type setup.
- Any code, lint, or dependency change beyond the two upstream doc files.