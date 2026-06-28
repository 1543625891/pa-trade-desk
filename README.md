# PA Trade Desk 复盘工作台

A desktop trading review app built for **Al Brooks Price Action** traders. Tracks trades, runs AI-powered reviews, keeps your strategy playbook, and pulls the latest Brooks daily reports — all stored locally on your machine, nothing sent to any server except the Claude API you configure.

![Tauri](https://img.shields.io/badge/Tauri-v2-blue) ![React](https://img.shields.io/badge/React-19-61dafb) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

| Module | What it does |
|---|---|
| **每日复盘** | Log trades per day, attach screenshots, write pre-market plan & EOD summary |
| **AI 复盘** | Upload session screenshots → Claude generates a structured session review |
| **AI 教练报告** | Weekly / monthly coach reports + all-time deep strategy analysis powered by Claude |
| **策略库** | Full editable playbook — add, edit, delete strategies and attach diagrams |
| **交易记录** | Search & filter all trades, attach screenshots per trade |
| **数据报告** | Win rate by strategy/environment/error type, P&L curves |
| **Brooks 日报** | Auto-fetches Al Brooks' daily E-mini reports and translates them to Chinese |
| **进度追踪** | Weekly rule-following streaks and discipline scores |
| **教练对话** | Multi-turn AI coaching chat with context from your trade history |

All data is stored in **localStorage** (and images in the app's local data directory). No account, no cloud sync required.

---

## Prerequisites

### 1. Rust (required by Tauri)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 2. Node.js 18+
Download from https://nodejs.org or use `nvm`:
```bash
nvm install 20
nvm use 20
```

### 3. Tauri system dependencies (Linux only)
```bash
# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```
macOS and Windows work out of the box after Rust is installed.

---

## Quick Start

```bash
git clone https://github.com/your-username/pa-trade-desk.git
cd pa-trade-desk
npm install
npm run tauri dev
```

First launch takes a few minutes while Cargo compiles the Rust backend. Subsequent launches are fast.

---

## Configuration

### Claude API Key (required for AI features)
1. Get an API key at https://console.anthropic.com
2. In the app, go to **AI Agent** tab → paste your key and select a model
3. The key is stored locally and never leaves your machine (it's sent directly to Anthropic's API)

### Auto-import from Tradovate
In **AI Agent** settings, enable auto-import and point it to your Downloads folder. The app watches for `Performance.csv` exports from Tradovate and imports them automatically.

---

## Strategy Playbook

The app ships with a set of Al Brooks PA strategies as a starting template (H2/L2, EMA rejection, Fibonacci 50%, breakout failures, wedges, etc.). You can:

- **Edit** any strategy: click it in the Strategy Library → click ✏️ Edit
- **Add fields**: in edit mode, click "+ 添加字段"
- **Upload diagrams**: drag-and-drop or click "+ 上传图片" in the detail panel
- **Add new strategy**: click "+ 新增策略" at the bottom of the left sidebar
- **Delete a strategy**: open it in edit mode → scroll to the bottom → "删除此策略"

All changes are saved automatically to localStorage.

---

## Customizing for Your Own Trading Style

1. **Replace strategies**: Delete the default ones and add your own setups in the UI, or edit `STRATEGIES` in `src/data.js` directly for bulk changes
2. **Change environments**: Edit `ENVS` in `src/data.js` (default: Trend / Channel / Trading Range)
3. **Change trade fields**: Edit `FIELDS` in `src/data.js` to match your journaling workflow
4. **App name**: Change `productName` in `src-tauri/tauri.conf.json`
5. **App identifier**: Change `identifier` in `src-tauri/tauri.conf.json` to your own reverse domain (e.g. `com.yourname.tradedesk`) — required if you plan to distribute the app

---

## Project Structure

```
pa-trade-desk/
├── src/
│   ├── App.jsx          # All UI components and state management
│   ├── data.js          # Strategy library, trade fields, default state
│   ├── storage.js       # Image persistence (Tauri FS) + localStorage helpers
│   └── agent/
│       ├── claude.js    # Claude API client
│       ├── prompts.js   # Session review + translation system prompts
│       ├── coach.js     # Weekly/monthly/deep analysis context builders
│       └── brooks.js    # Brooks daily report fetcher + HTML sanitizer
├── src-tauri/           # Rust/Tauri backend (minimal — mostly config)
└── public/
    └── strategy-imgs/   # Default strategy diagram images
```

---

## Building a Distributable App

```bash
npm run tauri build
```

Output is in `src-tauri/target/release/bundle/`. Creates:
- macOS: `.dmg` and `.app`
- Windows: `.msi` and `.exe`
- Linux: `.deb` and `.AppImage`

---

## Data & Privacy

- All trade data, notes, and AI reports are stored in your browser's localStorage and the app's local data directory (`$APPDATA` / `~/Library/Application Support/`)
- Images are stored on disk via the Tauri filesystem API
- The only external requests made are:
  - To **Anthropic's API** (when you trigger AI features, using your own key)
  - To **brookstradingcourse.com** public WordPress API (fetching daily reports — no login required)
- No telemetry, no analytics, no account required

---

## License

MIT — see [LICENSE](LICENSE)

---

## Contributing

PRs welcome. The codebase is intentionally single-file (`App.jsx`) for simplicity — no component framework, no router, just React + Tailwind. If you add a feature, keep it consistent with the existing purple theme (`#6d44d9`) and light color palette.
