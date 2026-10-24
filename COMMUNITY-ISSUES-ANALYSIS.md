# Community Issues Analysis & Ordering

Research date: 2026-10-24
Source: SillyTavern/SillyTavern GitHub (open issues sorted by 👍 and by comment count, plus top Discussions).
Note: GitHub HTML does not expose full multi-emoji reaction totals; counts shown are those surfaced by the issue list. Treat as a proxy for community demand, not exact tallies.

## Method

- Pulled open issues sorted by `sort:reactions-+1-desc` and `sort:comments-desc`.
- Cross-referenced top Discussions (Ideas / General) for recurring themes not filed as issues.
- Effort estimated against the actual codebase (file/line inspected, not guessed).
- Effort scale: `S` ≈ 1 file / <50 LOC, `M` ≈ 150–300 LOC / 2–4 files, `L` ≈ architectural.

## Most-cited unimplemented requests (by theme)

### A. Per-character model / connection binding
- #3139 `[EPIC] Merge Personas into Characters` (12👍, open)
- Discussion #3785 "A different AI in each character" (top Ideas)
- #2476 bind multi-API + pick characters per API (8👍, closed *Out of Scope*)
- Status: no plan; maintainers marked out of scope.

### B. Tool calling / MCP
- #3335 Implement Model Context Protocol (MCP) for Tool Calling (top 👍 open, `Keep Open`)
- #4857 DeepSeek V3.2 tool-call 400 bug (missing `reasoning_content`)

### C. Customizable hotkeys / editing navigation
- #2146 Customizable Hotkeys (`Approved`, `Help Wanted`)
- #4129 keyboard shortcuts for editing/navigation
- #2304 shortcut to delete last message

### D. World Info (lorebook) upgrades (densest cluster)
- #3344 negative depth (19 comments)
- #5655 insertion improvements (16)
- #3762 activation groups (11)
- #5852 "freeze to history" for prefix caching (11)
- #4430 no-line-break-before-entry checkbox
- #3469 multiple lorebooks per chat

### E. OpenAI-compatible endpoints for side services
- #4851 custom image-gen endpoint
- #3027 STT custom server (opened Oct 2024)
- #3903 OpenAI-compatible vectorization source (`Approved`)
- #5672 service-tier support (`Approved`)

### F. Media
- #3524 video attachments (`Approved`)
- #3355 JXL / modern image formats
- #5112 local caching of external media

### G. UX / display
- #4357 separate in-chat name vs card name (16👍, Under Consideration)
- Discussion #4715 "Display Names"
- #2813 keep character cards unchanged
- #1320 disable autosave on cards
- #2694 screen-reader accessibility (20 comments, `In Progress`)

### H. Infrastructure
- #4562 run under a subpath/subdirectory (`Stale`)
- #6044 Ollama: drop `typical_p` from completion requests

## Effort vs impact

| Request | Community impact | Code effort | Ratio |
|---|---|---|---|
| #2146 Customizable hotkeys | High (Approved, Help Wanted) | M — `processHotkeys` hardcoded if-chain (RossAscends-mods.js:993) → config map + prefs UI + conflict handling | Best |
| #4357 separate in-chat name | High (16👍, Under Consideration) | M — card schema field + macro + editor UI + group handling | Strong |
| #4430 no-line-break WI entry | Medium | S — one checkbox + render join in WI entry editor | Excellent |
| #3344 negative WI depth | Medium (19 comments) | S/M — allow negative depth, adjust insertion calc | Good |
| #6044 Ollama drop `typical_p` | Low | S — remove one entry from Ollama key list (src/constants.js:336) | Trivial freebie |
| #3903 OpenAI-compat vector source | Medium (Approved) | M — new source branch in vectors/index.js | Fair |
| #3027 STT custom endpoint | Medium | M — generalize STT provider | Fair |
| #3524 video attachments | Medium | L/M — upload + multimodal plumbing | Weak |
| #3335 MCP tool calling | High | L — protocol layer | Weak |
| #3139 per-character model | Highest | L — data model + prompt pipeline; marked Out of Scope | Poor |

## Recommended ordering

1. **#6044 Ollama `typical_p`** — one-line removal from the Ollama key list; bank a shipped fix and confirm the release path.
2. **#4430 no-line-break WI entry** — small, self-contained, isolated to the WI entry editor.
3. **#2146 Customizable Hotkeys** — best effort/impact win.
   - Demand already validated (`Approved` + `Help Wanted`), low controversy.
   - Scope contained: hotkeys are hardcoded in one function (`processHotkeys`, RossAscends-mods.js:980–1039); extract into a keybinding registry + prefs page.
   - No server changes, no schema migration.
   - One implementation also addresses #4129 and #2304 (same subsystem).
4. **#3344 negative WI depth** — bundles naturally with the World Info workstream.
5. **#4357 separate display name** — higher raw 👍 (16) but touches card schema and prompt rendering; more regression surface, schedule after the hotkey/WI wins.
6. **#3903 / #3027** — generalizing side-service endpoints; medium effort, batch together.
7. **#3524 / #3335** — high effort; only with dedicated scope.
8. **#3139 per-character model** — highest demand but architectural and currently out of scope; revisit only if the data model is touched for another reason.

## Cross-cutting observations

- Top single theme: per-character model/preset/persona merge (#3139 + #3785 + #2476), argued for ~2 years, still unanswered.
- Second cluster: integration plumbing (MCP/tools; OpenAI-compatible endpoints for image/STT/vector; service tiers).
- Third cluster: World Info power features — the area where maintainers are most receptive.
- Several high-interest items are tagged `Approved` but never implemented (hotkeys, video, vectorization, service tier) — a backlog of promises, not merely ideas.

## Caveats

- Reaction totals are scraped proxies; for exact ranking use `gh api graphql` against the issues.
- Effort estimates are from code inspection of the named files; they exclude review, docs, i18n, and tests.
