# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This App Is

**PA Trade Desk 复盘工作台** — A desktop trading journal and review app for Al Brooks Price Action (PA) traders. Built with Tauri v2 + React 19 + Vite + TailwindCSS v4. All data stored locally (no backend, no cloud). Targets ES futures (E-mini S&P 500) traders using Tradovate.

## Commands

```bash
npm install               # Install JS dependencies (first time)
npm run tauri dev         # Start dev server with hot-reload (requires Rust/Cargo)
npm run dev               # Vite-only dev (no Tauri, limited functionality)
npx vite build --outDir /tmp/vite-out  # Validate build without EPERM on dist/
npm run tauri build       # Build distributable app (slow, needs Rust)
```

First `tauri dev` run compiles Rust (~5 min). Subsequent runs are fast.

The `dist/` folder has EPERM issues in some environments — use `--outDir /tmp/vite-out` to validate builds.

## Architecture

### Single-File UI
All React components live in **`src/App.jsx`** (~3500+ lines). No router, no component library. Navigation is a single `view` state variable switching between page components rendered in one `<section>`.

Page components: `Dashboard`, `DailyReview`, `Records` (TradeEditorTable), `StrategyLibrary`, `CoachReportPage`, `BrooksPage`, `AgentConsole`, `Reports`, `ProgressTracker`, `TradeReplay`, `Notebook`.

### State Management
Single global state object managed by `useState` in the root `App` component, passed as `{state, setState}` props everywhere. Persisted via `saveState`/`loadState` in `src/storage.js`.

**`normalizeState(data)`** in App.jsx is critical — it merges loaded data with `DEFAULT_STATE` defaults, handling schema migrations. When adding new state fields, always add them here.

State shape (from `DEFAULT_STATE` in `src/data.js`):
```js
{
  settings: { buffer, riskPerTrade, stopPoints, perPoint, dailyLimit, streakLimit },
  trades: [],           // All trade records
  dailyReviews: {},     // date → { plan, summary, lesson, aiReview, screenshots[], trades[] }
  notes: {},            // Per-environment sticky notes
  agent: { claude: { apiKey, model }, sessionReview, ... },
  brooks: { posts: [], autoFetch, autoTranslate },
  coachReports: {},     // "weekly-2024-W25-<ts>" / "deep-<ts>" → { generatedAt, markdown, reportType, period? }
  strategies: [],       // Editable copy of STRATEGIES from data.js (initialized on first load)
  autoImport: { enabled, files: {} },
}
```

### Data Persistence
`src/storage.js` handles two environments:
- **Tauri**: reads/writes `data.json` in `appLocalDataDir()`, images saved to `images/` subfolder
- **Browser fallback**: localStorage key `"trade-desk-data"`

Images are stored as files on disk and referenced by `{ name, path, src }` objects. Use `imageDataUrl(img)` to get a displayable data URL, `readImageBase64(img)` to get base64 for Claude API vision.

### AI Integration (`src/agent/`)

- **`claude.js`**: Direct browser→Anthropic API calls using `anthropic-dangerous-direct-browser-access` header. `callClaude(cfg, {system, messages, maxTokens})` returns text string.
- **`prompts.js`**: `SESSION_REVIEW_SKILL` (daily session review) and `TRANSLATE_SYSTEM` (Brooks translation). `buildSessionReviewContext()` assembles trade data + screenshots into the user message.
- **`coach.js`**: `COACH_SYSTEM` + `buildCoachContext()` for weekly/monthly reports; `DEEP_ANALYSIS_SYSTEM` + `buildDeepAnalysisContext()` for all-time strategy analysis.
- **`brooks.js`**: Fetches Al Brooks' daily reports from `brookstradingcourse.com` WordPress REST API (public, no auth). Category ID 153 = E-mini daily reports.

### Strategy Library
Static strategy definitions in `src/data.js` exports:
- `STRATEGIES` — array of `{ id, env, name, tag, fields: [[key, value], ...] }`
- `PHASES` — maps strategy id → `{ pn: sortOrder, ph: phaseLabel }`
- `ENVS` — `[{ k: "trend"|"channel"|"tr", t: displayName, c: tailwindColor }]`
- `STRATEGY_IMAGES` — maps strategy id → `["strategy-imgs/file.jpg", ...]` (files in `public/`)

On first app load, `normalizeState` copies `STRATEGIES` into `state.strategies` (with `userImages: []` added). All subsequent edits go to `state.strategies` (persisted), not the static `STRATEGIES` array. `StrategyColumn` and `StrategyLibrary` components read from `state.strategies`.

### Coach Reports Storage Schema
Each generated report gets a unique timestamped key:
- Weekly: `weekly-2024-W25-<timestamp>`
- Monthly: `monthly-2024-06-<timestamp>`  
- Deep analysis: `deep-<timestamp>`

Each value: `{ generatedAt: ISO string, markdown: string, reportType: "weekly"|"monthly"|"deep", period?: "2024-W25" }`. The left-panel history list groups by `period` for weekly/monthly, lists all for deep.

### Trade Data Shape
Each trade object:
```js
{
  id, date, symbol, side, qty, entry, exit,
  entryTime, exitTime, pnl, rr,
  env, strategy,           // environment key, strategy id (comma-separated for multi)
  followedPlan,            // "yes"|"no"
  forcedExit,              // "missed"|"executed"|""
  errorType, emotion,      // free text labels
  screenshots: [],         // [{ name, path, mediaType }]
  notes,                   // per-trade text
}
```

`tradeDate(trade)` extracts YYYY-MM-DD from `entryTime || exitTime || date`. `parseDateTime(str)` parses various time formats. `num(v)` converts P&L strings like `"($123.45)"` to `-123.45`.

### Auto-Import from Tradovate
`scanDownloads()` in App.jsx scans `~/Downloads` for `Performance.csv` files using Tauri FS. Deduplication via `state.autoImport.files` (filename|size|mtime fingerprint). CSV parsing uses PapaParse.

### UI Patterns
- **`<Panel title>`**: Standard card wrapper
- **`<Page title subtitle>`**: Full-page wrapper with header
- **`<Ic n="iconName" s={size} />`**: SVG icon component (all icons defined inline in `Ic` switch)
- **`FIELD_THEME` / `DEFAULT_THEME`**: Color mappings for strategy field cards (purple/green/amber/red by field name)
- TailwindCSS v4 — use CSS variables (`var(--color-*)`) or direct hex values. Primary purple: `#6d44d9`. Light bg: `#f7f6fb`.

## Key Files

| File | Purpose |
|---|---|
| `src/App.jsx` | Everything UI — all components, state, handlers |
| `src/data.js` | Static data: STRATEGIES, ENVS, PHASES, FIELDS, DEFAULT_STATE |
| `src/storage.js` | Tauri FS + localStorage persistence, image save/load |
| `src/agent/claude.js` | Claude API client |
| `src/agent/prompts.js` | Session review system prompt + context builder |
| `src/agent/coach.js` | Weekly/monthly/deep analysis prompts + context builders |
| `src/agent/brooks.js` | Brooks daily report fetcher + HTML sanitizer |
| `src/agent/Markdown.jsx` | Simple markdown renderer for AI output |
| `src-tauri/tauri.conf.json` | App config — `identifier` determines localStorage/data directory location |
| `public/strategy-imgs/` | PDF-extracted strategy diagram JPGs |

## Important Gotchas

**Changing `tauri.conf.json` identifier** breaks existing user data — the app stores data scoped to the identifier. Never change it for existing installs.

**`state.strategies` vs `STRATEGIES`**: Components must read from `state.strategies` (editable, persisted), not from the static import. `StrategyColumn` takes a `strategies` prop passed from `StrategyLibrary`.

**Image paths in Tauri**: Use `strategy-imgs/xxx.jpg` (no leading `/`) for public folder assets referenced in `STRATEGY_IMAGES`.

**Chinese quotes in JS strings**: Strategy content uses `"..."` (U+201C/U+201D curly quotes) as quotation marks inside strings — not ASCII `"` — to avoid breaking JS string literals.

**Build validation**: `npx vite build` reports "45 modules transformed" on success. The EPERM error on `dist/` cleanup is a sandboxing artifact, not a code error. Use `--outDir /tmp/vite-out` to confirm.
