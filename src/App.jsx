import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { DEFAULT_NOTES, DEFAULT_STATE, DEFAULT_TASKS, ENVS, FIELDS, PHASES, STRATEGIES, STRATEGY_IMAGES } from "./data";
import { BaseDirectory, readDir, readTextFile as readTextFileFs, stat } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { imageDataUrl, loadState, readImageBase64, revealDataFile, saveImage, saveState } from "./storage";
import { callClaude, DEFAULT_MODEL, imageBlock, testConnection, textBlock } from "./agent/claude";
import { buildSessionReviewContext, SESSION_REVIEW_SKILL } from "./agent/prompts";
import { syncPosts, translatePost } from "./agent/brooks";
import { buildCoachContext, buildDeepAnalysisContext, COACH_SYSTEM, DEEP_ANALYSIS_SYSTEM, periodKey, periodLabel } from "./agent/coach";
import Markdown from "./agent/Markdown";

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function Ic({ n, s = 16, cls = "" }) {
  const w = (ch) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={cls}>{ch}</svg>;
  switch (n) {
    case "chevDown": return w(<path d="M6 9l6 6 6-6" />);
    case "chevRight": return w(<path d="M9 6l6 6-6 6" />);
    case "up": return w(<path d="M3 17l6-6 4 4 8-8" />);
    case "down": return w(<path d="M3 7l6 6 4-4 8 8" />);
    case "x": return w(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>);
    case "alert": return w(<><path d="M12 3l10 18H2z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>);
    case "ban": return w(<><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>);
    case "shield": return w(<path d="M12 2l8 3v6c0 5-4 8-8 10-4-2-8-5-8-10V5z" />);
    case "activity": return w(<path d="M3 12h4l3 8 4-16 3 8h4" />);
    case "calc": return w(<><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h.01M13 11h.01M9 15h.01M13 15h.01" /></>);
    case "book": return w(<path d="M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />);
    case "upload": return w(<><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 20h14" /></>);
    case "file": return w(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
    case "bar": return w(<path d="M4 20V10M10 20V4M16 20v-8M20 20H3" />);
    case "refresh": return w(<><path d="M20 11a8 8 0 1 0-1.5 5" /><path d="M20 4v5h-5" /></>);
    case "check": return w(<path d="M20 6L9 17l-5-5" />);
    default: return null;
  }
}

function num(value) {
  if (value == null || value === "") return NaN;
  const parsed = parseFloat(String(value).replace(/[$,()]/g, "").replace(/[^\d.-]/g, ""));
  return String(value).includes("(") ? -Math.abs(parsed) : parsed;
}

function fmt(value, digits = 2) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? "—" : parsed.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function guessMap(headers) {
  const pick = (...keys) => headers.find((x) => keys.some((k) => x.toLowerCase().includes(k))) || "";
  return {
    date: pick("date", "trade date", "日期"),
    symbol: pick("symbol", "instrument", "contract", "ticker", "品种"),
    side: pick("side", "b/s", "buy", "sell", "direction", "方向", "long", "short"),
    qty: pick("qty", "quantity", "size", "contracts", "手", "lot"),
    entry: pick("entry", "open price", "buyprice", "buy price", "avg entry", "入场", "开仓"),
    exit: pick("exit", "close price", "sellprice", "sell price", "avg exit", "出场", "平仓"),
    entryTime: pick("entry time", "open time", "boughttimestamp", "bought", "入场时间", "开仓时间", "timestamp"),
    exitTime: pick("exit time", "close time", "soldtimestamp", "sold", "出场时间", "平仓时间"),
    pnl: pick("pnl", "p&l", "profit", "net", "realized", "盈亏", "损益"),
    rr: pick("rr", "r multiple", "r-multiple", "risk reward", "盈亏比"),
  };
}

function parseDateTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  // MM/DD/YYYY HH:MM:SS (Tradovate format)
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (us) {
    const [, month, day, year, hour, minute, second = "0"] = us;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  // YYYY-MM-DD HH:MM:SS (local datetime with space — new Date() treats as invalid in strict mode)
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (iso) {
    const [, year, month, day, hour, minute, second = "0"] = iso;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(date) {
  if (!date) return today();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateTime(date) {
  if (!date) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${formatDate(date)} ${hh}:${mm}:${ss}`;
}

function isPerformanceCsv(headers) {
  const set = new Set(headers.map((h) => h.toLowerCase()));
  return ["buyprice", "sellprice", "boughttimestamp", "soldtimestamp", "pnl"].every((key) => set.has(key));
}

function performanceRowToTrade(row, i) {
  const boughtAt = parseDateTime(row.boughtTimestamp);
  const soldAt = parseDateTime(row.soldTimestamp);
  const isLong = boughtAt && soldAt ? boughtAt <= soldAt : true;
  const entryTime = isLong ? boughtAt : soldAt;
  const exitTime = isLong ? soldAt : boughtAt;
  return {
    id: `t-${uid()}-${i}`,
    date: formatDate(entryTime || exitTime),
    symbol: row.symbol ?? "—",
    side: isLong ? "Long" : "Short",
    qty: row.qty ?? "",
    entry: isLong ? row.buyPrice ?? "" : row.sellPrice ?? "",
    exit: isLong ? row.sellPrice ?? "" : row.buyPrice ?? "",
    entryTime: formatDateTime(entryTime),
    exitTime: formatDateTime(exitTime),
    pnl: row.pnl ?? "",
    rr: "",
    env: "",
    strategy: "",
    errorType: "",
    emotion: "",
    followedPlan: "",
    forcedExit: "",
    source: "Tradovate Performance.csv",
    sourceId: `${row.buyFillId || ""}-${row.sellFillId || ""}`,
    duration: row.duration || "",
  };
}

function tradeDate(trade) {
  const source = trade.date || trade.entryTime || trade.exitTime || "";
  const match = String(source).match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = parseDateTime(source);
  return parsed ? formatDate(parsed) : today();
}

function normalizeState(data) {
  const daily = data.daily?.date === today() ? data.daily : { date: today(), pnl: 0, streak: 0 };
  return {
    ...DEFAULT_STATE,
    ...data,
    settings: { ...DEFAULT_STATE.settings, ...(data.settings || {}) },
    daily,
    notes: { ...DEFAULT_NOTES, ...(data.notes || {}) },
    tasks: data.tasks?.length ? data.tasks : DEFAULT_TASKS,
    dailyReviews: data.dailyReviews || {},
    trades: (data.trades || []).map((t) => ({ date: tradeDate(t), ...t })),
    studyTrades: data.studyTrades || [],
    journal: data.journal || {},
    notebook: data.notebook || [],
    agent: {
      ...DEFAULT_STATE.agent,
      ...(data.agent || {}),
      claude: { ...DEFAULT_STATE.agent.claude, ...(data.agent?.claude || {}) },
      marketBriefing: { ...DEFAULT_STATE.agent.marketBriefing, ...(data.agent?.marketBriefing || {}) },
      autoTagger: { ...DEFAULT_STATE.agent.autoTagger, ...(data.agent?.autoTagger || {}) },
      sessionReview: { ...DEFAULT_STATE.agent.sessionReview, ...(data.agent?.sessionReview || {}) },
    },
    brooks: { ...DEFAULT_STATE.brooks, ...(data.brooks || {}), posts: data.brooks?.posts || [] },
    autoImport: { ...DEFAULT_STATE.autoImport, ...(data.autoImport || {}), files: data.autoImport?.files || {} },
    coachReports: data.coachReports || {},
    // strategies 存到 state，支持用户编辑；首次加载从 data.js 初始化
    strategies: Array.isArray(data.strategies)
      ? data.strategies
      : STRATEGIES.map((s) => ({ ...s, userImages: [] })),
  };
}

/* ===== 同一笔交易合并：只有共享同一个 buyFillId 或 sellFillId 的行才属于同一笔拆单 ===== */
function mergePerformanceTrades(trades) {
  // 批内先按 sourceId 去重
  const seenIds = new Set();
  const unique = trades.filter((t) => {
    if (t.sourceId && seenIds.has(t.sourceId)) return false;
    if (t.sourceId) seenIds.add(t.sourceId);
    return true;
  });
  if (unique.length === 0) return [];

  // Union-Find：按共享 fillId 分组（sourceId = "buyFillId-sellFillId"）
  const parent = unique.map((_, i) => i);
  function find(i) { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
  function union(i, j) { parent[find(i)] = find(j); }

  const byBuyFill = {};
  const bySellFill = {};
  unique.forEach((t, idx) => {
    const [buyId, sellId] = (t.sourceId || "").split("-");
    if (buyId) {
      if (byBuyFill[buyId] != null) union(idx, byBuyFill[buyId]);
      else byBuyFill[buyId] = idx;
    }
    if (sellId) {
      if (bySellFill[sellId] != null) union(idx, bySellFill[sellId]);
      else bySellFill[sellId] = idx;
    }
  });

  const components = {};
  unique.forEach((t, idx) => {
    const root = find(idx);
    (components[root] = components[root] || []).push(t);
  });

  return Object.values(components).map(mergeFillGroup);
}

function mergeFillGroup(items) {
  if (items.length === 1) {
    const t = items[0];
    return { ...t, fillIds: t.sourceId ? [t.sourceId] : [] };
  }
  const totalQty = items.reduce((acc, t) => acc + (parseFloat(t.qty) || 0), 0);
  const weightedAvg = (key) => {
    let sum = 0;
    let weight = 0;
    items.forEach((t) => {
      const price = parseFloat(t[key]);
      const q = parseFloat(t.qty) || 1;
      if (!Number.isNaN(price)) { sum += price * q; weight += q; }
    });
    return weight ? sum / weight : NaN;
  };
  const avgEntry = weightedAvg("entry");
  const avgExit = weightedAvg("exit");
  const entryTimes = items.map((t) => parseDateTime(t.entryTime)).filter(Boolean).map((d) => d.getTime());
  const exitTimes = items.map((t) => parseDateTime(t.exitTime)).filter(Boolean).map((d) => d.getTime());
  const totalPnl = items.reduce((acc, t) => {
    const v = num(t.pnl);
    return acc + (Number.isNaN(v) ? 0 : v);
  }, 0);
  const ids = items.map((t) => t.sourceId).filter(Boolean).sort();
  // 用最早入场的那笔决定方向（避免同时间戳的 fill 被误判方向后污染整组）
  const earliest = items.reduce((best, t) => {
    const ms = parseDateTime(t.entryTime)?.getTime() ?? Infinity;
    return ms < (parseDateTime(best.entryTime)?.getTime() ?? Infinity) ? t : best;
  }, items[0]);
  return {
    ...items[0],
    side: earliest.side,
    qty: totalQty || items[0].qty,
    entry: Number.isNaN(avgEntry) ? items[0].entry : String(+avgEntry.toFixed(2)),
    exit: Number.isNaN(avgExit) ? items[0].exit : String(+avgExit.toFixed(2)),
    entryTime: entryTimes.length ? formatDateTime(new Date(Math.min(...entryTimes))) : items[0].entryTime,
    exitTime: exitTimes.length ? formatDateTime(new Date(Math.max(...exitTimes))) : items[0].exitTime,
    pnl: String(+totalPnl.toFixed(2)),
    duration: "",
    sourceId: ids.join("+"),
    fillIds: ids,
    mergedFills: items.length,
  };
}

/* ===== 导入自动匹配：把 CSV 精确数据合并进实盘时的手动记录，避免重复 ===== */
function symbolLooseMatch(a, b) {
  const sa = String(a || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const sb = String(b || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!sa || !sb) return true; // 一方没填品种 = 不限制
  return sa.startsWith(sb) || sb.startsWith(sa); // MES ↔ MESM6
}

function tradeMatchScore(manual, csv) {
  if ((manual.date || "") !== (csv.date || "")) return 0;
  if (!symbolLooseMatch(manual.symbol, csv.symbol)) return 0;
  if (manual.side && csv.side && manual.side[0].toLowerCase() !== csv.side[0].toLowerCase()) return 0;
  let score = 0;
  const manualEntry = parseFloat(manual.entry);
  const csvEntry = parseFloat(csv.entry);
  if (!Number.isNaN(manualEntry) && !Number.isNaN(csvEntry) && Math.abs(manualEntry - csvEntry) <= Math.max(2, csvEntry * 0.001)) score += 2;
  const manualPnl = num(manual.pnl);
  const csvPnl = num(csv.pnl);
  if (!Number.isNaN(manualPnl) && !Number.isNaN(csvPnl) && Math.abs(manualPnl - csvPnl) <= Math.max(5, Math.abs(csvPnl) * 0.15)) score += 2;
  const manualTime = parseDateTime(manual.entryTime);
  const csvTime = parseDateTime(csv.entryTime);
  if (manualTime && csvTime && Math.abs(manualTime - csvTime) <= 15 * 60 * 1000) score += 2;
  // entryTime 为空时，用手动记录的创建时刻（createdAt）兜底匹配，窗口放宽到 2 小时
  if (!manualTime && manual.createdAt && csvTime) {
    const created = new Date(manual.createdAt).getTime();
    if (!Number.isNaN(created) && Math.abs(created - csvTime) <= 2 * 60 * 60 * 1000) score += 2;
  }
  return score;
}

function hasExecutionData(trade) {
  return !Number.isNaN(parseFloat(trade.entry)) || !Number.isNaN(num(trade.pnl)) || Boolean(parseDateTime(trade.entryTime));
}

/** 导入 incoming：sourceId 重复的跳过；能匹配手动记录的合并（保留标注和笔记）；其余新增 */
function applyImportToTrades(existing, incoming) {
  // 已入库的成交指纹：整笔 sourceId + 每个子成交 fillId（兼容合并前导入的旧数据）
  const seen = new Set(existing.flatMap((t) => [t.sourceId, ...(t.fillIds || []), ...(t.sourceId?.includes("+") ? t.sourceId.split("+") : [])]).filter(Boolean));
  let trades = existing.slice();
  let added = 0;
  let merged = 0;

  for (const csv of incoming) {
    if (csv.sourceId && seen.has(csv.sourceId)) continue;
    if (csv.fillIds?.length && csv.fillIds.every((id) => seen.has(id))) continue;
    if (csv.sourceId) seen.add(csv.sourceId);
    (csv.fillIds || []).forEach((id) => seen.add(id));

    let best = null;
    let bestScore = 1; // 需要 ≥2（至少一项强信号）才按评分合并
    for (const t of trades) {
      if (t.sourceId) continue;
      const score = tradeMatchScore(t, csv);
      if (score > bestScore) { best = t; bestScore = score; }
    }
    if (!best) {
      // 兜底1：当天只有一条没填任何执行数据的手动记录 → 视为同一笔
      const bare = trades.filter((t) => !t.sourceId && t.date === csv.date && symbolLooseMatch(t.symbol, csv.symbol) && !hasExecutionData(t));
      if (bare.length === 1) best = bare[0];
    }
    if (!best) {
      // 兜底2：同一天、同方向、只有唯一一笔手动记录候选、PnL 差在 $20 以内 → 直接匹配
      const csvPnl = num(csv.pnl);
      const sameDaySameDir = trades.filter((t) =>
        !t.sourceId &&
        t.date === csv.date &&
        symbolLooseMatch(t.symbol, csv.symbol) &&
        (!t.side || !csv.side || t.side[0].toLowerCase() === csv.side[0].toLowerCase()) &&
        !Number.isNaN(num(t.pnl)) &&
        Math.abs(num(t.pnl) - csvPnl) <= 20
      );
      if (sameDaySameDir.length === 1) best = sameDaySameDir[0];
    }

    if (best) {
      const target = best;
      trades = trades.map((t) => (t.id === target.id ? {
        ...csv, // CSV 的精确执行数据为准
        id: target.id, // 保留原 id，逐笔笔记不丢
        env: target.env || "",
        strategy: target.strategy || "",
        errorType: target.errorType || "",
        emotion: target.emotion || "",
        followedPlan: target.followedPlan || "",
        forcedExit: target.forcedExit || "",
        rr: target.rr || csv.rr || "",
      } : t));
      merged += 1;
    } else {
      trades = [csv, ...trades];
      added += 1;
    }
  }
  return { trades, added, merged };
}

function calcStats(trades) {
  const rows = trades.map((trade) => ({ ...trade, pnlNum: num(trade.pnl), rrNum: num(trade.rr) })).filter((trade) => !Number.isNaN(trade.pnlNum));
  const wins = rows.filter((t) => t.pnlNum > 0);
  const losses = rows.filter((t) => t.pnlNum < 0);
  const sum = (items) => items.reduce((acc, t) => acc + t.pnlNum, 0);
  const net = sum(rows);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const rrValues = rows.map((t) => t.rrNum).filter((v) => !Number.isNaN(v));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const curve = rows.slice().reverse().map((t, i) => {
    equity += t.pnlNum;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    return { index: i + 1, equity };
  });

  return {
    count: rows.length,
    winRate: rows.length ? (wins.length / rows.length) * 100 : 0,
    net,
    pf: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWin,
    avgLoss,
    rr: rrValues.length ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length : avgLoss ? avgWin / avgLoss : 0,
    expectancy: rows.length ? net / rows.length : 0,
    maxDrawdown,
    curve,
  };
}

export default function App() {
  const [state, setState] = useState(normalizeState(DEFAULT_STATE));
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("dashboard");
  const [selectedDate, setSelectedDate] = useState(today());
  const [status, setStatus] = useState("正在加载本机数据...");

  useEffect(() => {
    loadState().then((data) => {
      setState(normalizeState(data));
      setLoaded(true);
      setStatus("数据已就绪");
    }).catch((error) => setStatus(`加载失败：${error.message}`));
  }, []);

  useEffect(() => {
    if (loaded) saveState(state).catch((error) => setStatus(`保存失败：${error.message}`));
  }, [state, loaded]);

  const brooksRunning = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  async function syncBrooks(force = false) {
    // 强制刷新时重置锁，确保不被卡住
    if (force) brooksRunning.current = false;
    if (brooksRunning.current) return;
    brooksRunning.current = true;
    try {
      setStatus("正在检查 Brooks 日报...");
      // force = true 时清空现有缓存，所有文章视为新增
      const cached = force ? [] : (stateRef.current.brooks?.posts || []);
      const { posts, added } = await syncPosts(cached);
      // 合并翻译：力保用户已有的中文翻译不丢失
      const zhMap = {};
      (stateRef.current.brooks?.posts || []).forEach((p) => { if (p.zh) zhMap[p.id] = { zh: p.zh, translatedAt: p.translatedAt }; });
      const mergedPosts = posts.map((p) => ({ ...p, ...(zhMap[p.id] || {}) }));
      setState((s) => ({ ...s, brooks: { ...s.brooks, posts: mergedPosts, lastChecked: new Date().toISOString(), latestPostId: mergedPosts[0]?.id ?? s.brooks.latestPostId } }));

      const cfg = stateRef.current.agent?.claude || {};
      if (cfg.apiKey) {
        const targets = mergedPosts.filter((p) => !p.zh).slice(0, 3);
        for (const post of targets) {
          setStatus(`正在翻译《${post.title}》...`);
          const zh = await translatePost(post, cfg);
          setState((s) => ({
            ...s,
            brooks: { ...s.brooks, posts: s.brooks.posts.map((p) => (p.id === post.id ? { ...p, zh, translatedAt: new Date().toISOString() } : p)) },
          }));
        }
      }
      setStatus(added ? `Brooks 日报已更新（新增/更新 ${added} 篇）` : "Brooks 日报检查完成，已是最新");
    } catch (error) {
      setStatus(`Brooks 同步失败：${error.message}`);
    } finally {
      brooksRunning.current = false;
    }
  }

  async function scanDownloads(manual = false) {
    if (!("__TAURI_INTERNALS__" in window)) {
      if (manual) setStatus("自动导入需要在桌面 App 里运行");
      return;
    }
    try {
      if (manual) setStatus("正在扫描下载文件夹...");
      // 扫描范围：下载根目录的 Performance*.csv + 下载目录下任意子文件夹里的所有 .csv（表头校验后才导入）
      const top = await readDir("", { baseDir: BaseDirectory.Download });
      const candidates = [];
      for (const entry of top) {
        if (!entry.isDirectory && /^performance.*\.csv$/i.test(entry.name)) candidates.push(entry.name);
        else if (entry.isDirectory && !entry.name.startsWith(".")) {
          const sub = await readDir(entry.name, { baseDir: BaseDirectory.Download }).catch(() => []);
          for (const file of sub) {
            if (!file.isDirectory && /\.csv$/i.test(file.name)) candidates.push(`${entry.name}/${file.name}`);
          }
        }
      }

      const known = stateRef.current.autoImport?.files || {};
      const fileRecords = {};
      const csvTrades = [];
      let newFiles = 0;

      for (const path of candidates) {
        const info = await stat(path, { baseDir: BaseDirectory.Download }).catch(() => null);
        const mtime = info?.mtime ? new Date(info.mtime).getTime() : Date.now();
        const key = `${path}|${info?.size || 0}|${mtime}`;
        if (known[key]) continue;
        // 自动扫描只看最近 48 小时的文件（今天刚导出的）；手动「立即扫描」不限时间，可补导历史
        if (!manual && Date.now() - mtime > 48 * 60 * 60 * 1000) continue;
        fileRecords[key] = new Date().toISOString();
        const text = await readTextFileFs(path, { baseDir: BaseDirectory.Download });
        const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
        if (!isPerformanceCsv(parsed.meta?.fields || [])) continue;
        newFiles += 1;
        parsed.data.forEach((row, i) => csvTrades.push(performanceRowToTrade(row, i)));
      }

      const result = applyImportToTrades(stateRef.current.trades, mergePerformanceTrades(csvTrades));
      if (Object.keys(fileRecords).length) {
        setState((s) => ({
          ...s,
          trades: result.trades,
          tasks: result.added || result.merged ? s.tasks.map((task) => (task.id === "import" ? { ...task, done: true } : task)) : s.tasks,
          autoImport: { ...s.autoImport, files: { ...s.autoImport.files, ...fileRecords }, lastScan: new Date().toISOString() },
        }));
      }
      if (result.added || result.merged) setStatus(`自动导入完成：新增 ${result.added} 笔${result.merged ? `，自动匹配合并 ${result.merged} 笔手动记录` : ""}（${newFiles} 个新 CSV）`);
      else if (manual) setStatus("下载文件夹里没有新的 Performance CSV");
    } catch (error) {
      setStatus(`自动导入失败：${error.message}`);
    }
  }

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      if (state.autoImport?.enabled !== false) await scanDownloads();
      if (state.brooks?.autoFetch) syncBrooks();
    })();
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // 从浏览器切回 App 时自动扫描下载文件夹（配合「去 Tradovate 导出」按钮 = 一键导入）
  useEffect(() => {
    if (!loaded) return;
    let lastScan = 0;
    const onFocus = () => {
      if (stateRef.current.autoImport?.enabled === false) return;
      const now = Date.now();
      if (now - lastScan < 5000) return;
      lastScan = now;
      scanDownloads();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openTradovate() {
    try {
      await openUrl("https://trader.tradovate.com/");
      setStatus("已打开 Tradovate，导出 Performance CSV 后切回来即可自动入库");
    } catch {
      setStatus("打开浏览器失败，请手动访问 trader.tradovate.com");
    }
  }

  const dailyTrades = useMemo(
    () => state.trades
      .filter((t) => tradeDate(t) === selectedDate)
      .slice()
      .sort((a, b) => {
        const ta = parseDateTime(a.entryTime || a.exitTime)?.getTime();
        const tb = parseDateTime(b.entryTime || b.exitTime)?.getTime();
        // 没有时间戳的手动新增交易排最前（-Infinity），方便用户即时看到
        if (!ta && !tb) return 0;
        if (!ta) return -1;
        if (!tb) return 1;
        return ta - tb;
      }),
    [state.trades, selectedDate],
  );
  const allStats = useMemo(() => calcStats(state.trades), [state.trades]);
  const dayStats = useMemo(() => calcStats(dailyTrades), [dailyTrades]);
  const dailyReview = state.dailyReviews[selectedDate] || {};

  const nav = [
    ["dashboard", "总览", "bar"],
    ["daily", "每日复盘", "activity"],
    ["records", "交易记录", "file"],
    ["notebook", "笔记本", "book"],
    ["reports", "数据报告", "up"],
    ["strategy", "策略库", "book"],
    ["replay", "交易回放", "refresh"],
    ["study", "复盘练习", "book"],
    ["progress", "进步追踪", "check"],
    ["coach", "教练报告", "shield"],
    ["brooks", "Brooks 日报", "book"],
    ["resources", "资源库", "alert"],
    ["ai", "AI Agent", "alert"],
  ];

  const ctx = {
    state, setState, selectedDate, setSelectedDate, dailyTrades, allStats, dayStats, dailyReview, status, scanDownloads, openTradovate,
  };

  return (
    <main className="min-h-screen bg-[#f7f6fb] text-sm text-[#1f1f29]">
      <div className="grid min-h-screen grid-cols-[56px_190px_1fr]">
        <aside className="flex flex-col items-center bg-[#210035] py-4 text-white">
          <button className="mb-7 rounded-md p-2 text-white/90 hover:bg-white/10"><Ic n="bar" s={22} /></button>
          {nav.slice(0, 6).map(([id, , icon]) => (
            <button key={id} onClick={() => setView(id)} className={`mb-3 rounded-md p-2 ${view === id ? "bg-[#6d44d9] text-white" : "text-white/65 hover:bg-white/10 hover:text-white"}`}>
              <Ic n={icon} s={18} />
            </button>
          ))}
          <div className="mt-auto space-y-3">
            <button className="rounded-md p-2 text-white/65 hover:bg-white/10"><Ic n="file" s={18} /></button>
            <button className="rounded-md p-2 text-white/65 hover:bg-white/10"><Ic n="book" s={18} /></button>
          </div>
        </aside>

        <aside className="border-r border-[#e9e6f2] bg-white px-3 py-4">
          <div className="mb-5 flex items-center gap-2 px-1">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#6d44d9] text-white"><Ic n="bar" s={18} /></div>
            <div>
              <h1 className="text-sm font-semibold text-[#2b2037]">复盘工作台</h1>
              <p className="text-[10px] text-[#91899f]">本地交易日志</p>
            </div>
          </div>
          <button onClick={() => setView("records")} className="mb-4 flex w-full items-center justify-center gap-2 rounded-md bg-[#6d44d9] px-3 py-2 text-sm font-medium text-white hover:bg-[#5d35c6]">
            + 新增交易
          </button>
          <nav className="space-y-1">
            {nav.map(([id, label, icon]) => (
              <button key={id} onClick={() => setView(id)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${view === id ? "bg-[#efeafd] text-[#5f3bc6]" : "text-[#3d3747] hover:bg-[#f4f1fb]"}`}>
                <Ic n={icon} s={15} /> {label}
              </button>
            ))}
          </nav>
          <div className="mt-5 border-t border-[#eeeaf5] pt-4">
            <button onClick={revealDataFile} className="w-full rounded-md border border-[#e1dceb] px-3 py-2 text-xs text-[#6b6475] hover:border-[#c9bfee]">数据文件夹</button>
            <p className="mt-3 text-[11px] leading-relaxed text-[#9a93a6]">{status}</p>
          </div>
        </aside>

        <section className="min-w-0 overflow-auto bg-[#f7f6fb]">
          {view === "dashboard" && <Dashboard {...ctx} setView={setView} />}
          {view === "daily" && <DailyReview {...ctx} />}
          {view === "records" && <Records {...ctx} />}
          {view === "notebook" && <Notebook {...ctx} />}
          {view === "reports" && <Reports {...ctx} />}
          {view === "strategy" && <StrategyLibrary {...ctx} />}
          {view === "replay" && <TradeReplay {...ctx} />}
          {view === "progress" && <ProgressTracker {...ctx} />}
          {view === "coach" && <CoachReportPage {...ctx} />}
          {view === "brooks" && <BrooksPage {...ctx} syncBrooks={syncBrooks} />}
          {view === "resources" && <Resources />}
          {view === "ai" && <AgentConsole {...ctx} />}
          {view === "study" && <StudyRoom {...ctx} />}
        </section>
      </div>
    </main>
  );
}

function Dashboard({ state, setState, selectedDate, setSelectedDate, dailyTrades, allStats, dayStats, setView, scanDownloads }) {
  const lastTrade = state.trades.slice().sort((a, b) => String(b.exitTime || b.entryTime || b.date).localeCompare(String(a.exitTime || a.entryTime || a.date)))[0];
  const dailyDays = getTradingDays(state.trades);
  const zellaScore = Math.round((progressRuleRows(state).reduce((acc, row) => acc + row.followRate, 0) / progressRuleRows(state).length) || 0);
  const monthStats = monthSummary(state.trades, selectedDate);

  return (
    <div className="mx-auto max-w-[1500px] px-6 py-5">
      <div className="mb-9 flex items-center gap-4">
        <h2 className="text-lg font-semibold text-[#191622]">总览</h2>
        <div className="ml-auto flex items-center gap-3">
          <button className="flex h-9 min-w-20 items-center justify-between gap-2 rounded-md border border-[#e6e1ef] bg-white px-3 text-xs font-medium text-[#6f6680]">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-[#eee9fb] text-[#6d44d9]">$</span><Ic n="chevDown" s={14} />
          </button>
          <button className="flex h-9 items-center gap-2 rounded-md border border-[#e6e1ef] bg-white px-4 text-xs font-medium text-[#6f6680]"><Ic n="alert" s={14} cls="text-[#6d44d9]" />筛选<Ic n="chevDown" s={14} /></button>
          <label className="flex h-9 items-center gap-2 rounded-md border border-[#e6e1ef] bg-white px-4 text-xs font-medium text-[#6f6680]">
            <Ic n="file" s={14} cls="text-[#6d44d9]" />
            <input className="w-[104px] bg-transparent outline-none" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </label>
          <button className="flex h-9 items-center gap-2 rounded-md border border-[#e6e1ef] bg-white px-4 text-xs font-medium text-[#6f6680]">全部账户<Ic n="chevDown" s={14} /></button>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <span className="text-xs font-medium text-[#8c8499]">最近导入：{lastTrade ? formatDashboardDate(lastTrade.exitTime || lastTrade.entryTime || lastTrade.date) : "暂无导入"}</span>
        <button onClick={() => scanDownloads(true)} className="text-xs font-semibold text-[#6d44d9] underline">重新同步</button>
        <button onClick={() => setView("daily")} className="ml-auto flex h-10 items-center gap-2 rounded-md bg-[#6d44d9] px-5 text-sm font-semibold text-white hover:bg-[#5d35c6]"><Ic n="refresh" s={15} />开始交易日</button>
        <button className="grid h-10 w-10 place-items-center rounded-md border border-[#e6e1ef] bg-white text-[#8f86a3]"><Ic n="book" s={17} /></button>
      </div>

      <div className="mb-4 grid grid-cols-5 gap-4">
        <DashboardMetric title="净盈亏" value={`$${fmt(allStats.net)}`} tone={allStats.net >= 0 ? "good" : "bad"} badge={allStats.count} />
        <DashboardMetric title="交易胜率" value={`${fmt(allStats.winRate, 0)}%`} ring={allStats.winRate} chips={[state.trades.filter((t) => num(t.pnl) > 0).length, state.trades.filter((t) => num(t.pnl) === 0).length, state.trades.filter((t) => num(t.pnl) < 0).length]} />
        <DashboardMetric title="盈亏因子" value={allStats.pf === Infinity ? "∞" : allStats.pf ? fmt(allStats.pf) : "--"} ring={Math.min((allStats.pf || 0) * 35, 100)} />
        <DashboardMetric title="盈利日占比" value={`${fmt(dayWinRate(dailyDays), 0)}%`} ring={dayWinRate(dailyDays)} chips={[dailyDays.filter((d) => d.pnl > 0).length, dailyDays.filter((d) => d.pnl === 0).length, dailyDays.filter((d) => d.pnl < 0).length]} />
        <DashboardMetric title="平均盈利/亏损" value={allStats.avgWin && allStats.avgLoss ? `${fmt(allStats.avgWin, 0)} / -${fmt(allStats.avgLoss, 0)}` : "--"} bar avgWin={allStats.avgWin} avgLoss={allStats.avgLoss} />
      </div>

      <div className="grid grid-cols-[2fr_1fr] gap-4 items-start">
        {/* 左侧：两列小卡 + 日历 */}
        <div className="grid grid-cols-2 gap-4">
          <DashboardCard title="纪律评分" className="min-h-[380px]">
            <RadarScore stats={allStats} score={zellaScore} />
          </DashboardCard>
          <DashboardCard title="进步追踪" action={<button onClick={() => setView("progress")} className="text-xs font-semibold text-[#6d44d9]">查看更多</button>} className="min-h-[380px]">
            <ProgressMiniTracker state={state} />
          </DashboardCard>

          <DashboardCard title="按日净盈亏" className="min-h-[360px]">
            <DailyBarChart days={dailyDays} />
          </DashboardCard>
          <DashboardCard title="最近交易" className="min-h-[360px]">
            <RecentTradesTable trades={state.trades.slice(0, 6)} />
          </DashboardCard>

          <DashboardCard className="col-span-2 min-h-[760px]" title={<CalendarTitle selectedDate={selectedDate} monthStats={monthStats} />}>
            <MonthCalendar trades={state.trades} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
          </DashboardCard>
        </div>

        {/* 右侧：策略看板占满全高 */}
        <DashboardCard title="策略胜率看板" className="self-stretch">
          <StrategyStatsBoard trades={[...state.trades, ...(state.studyTrades || [])]} />
        </DashboardCard>
      </div>
    </div>
  );
}

function DashboardCard({ title, action, children, className = "" }) {
  return (
    <section className={`overflow-hidden rounded-lg border border-[#ece8f2] bg-white shadow-[0_1px_0_rgba(27,18,43,0.03)] ${className}`}>
      {(title || action) && (
        <div className="flex h-14 items-center justify-between border-b border-[#eeeaf3] px-4">
          <h3 className="text-sm font-semibold text-[#262231]">{title}</h3>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

function DashboardMetric({ title, value, tone, ring, chips, bar, avgWin, avgLoss, badge }) {
  const valueCls = tone === "bad" ? "text-[#ff6269]" : tone === "good" ? "text-[#2fbf84]" : "text-[#191622]";
  return (
    <section className="flex min-h-[118px] flex-col gap-2 overflow-hidden rounded-lg border border-[#ece8f2] bg-white p-4">
      <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-[#8a8295]">
        <span className="truncate">{title}</span>
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-[#b9b1c8] text-[10px]">i</span>
        {badge != null && <span className="rounded-full bg-[#f0edf6] px-2 py-0.5 text-[#5f596b]">{badge}</span>}
      </div>
      {bar ? (
        <WinLossBar avgWin={avgWin} avgLoss={avgLoss} />
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <div className={`min-w-0 truncate text-xl font-bold ${valueCls}`}>{value}</div>
          {ring != null && <Ring value={ring} />}
        </div>
      )}
      {chips && (
        <div className="flex justify-end gap-2 text-[11px]">
          <span className="rounded-full bg-[#dff8ed] px-2 text-[#45bf8a]">{chips[0]}</span>
          <span className="rounded-full bg-[#e8edff] px-2 text-[#6b7ce6]">{chips[1]}</span>
          <span className="rounded-full bg-[#ffe1e4] px-2 text-[#ff6269]">{chips[2]}</span>
        </div>
      )}
    </section>
  );
}

function Ring({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const circumference = 2 * Math.PI * 20;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0">
      <circle cx="26" cy="26" r="20" fill="none" stroke="#f1edf5" strokeWidth="6" />
      <circle cx="26" cy="26" r="20" fill="none" stroke="#ff6269" strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pct / 100)} transform="rotate(-90 26 26)" />
    </svg>
  );
}

function WinLossBar({ avgWin, avgLoss }) {
  const win = Math.max(0, avgWin || 0);
  const loss = Math.max(0, avgLoss || 0);
  const total = win + loss || 1;
  return (
    <div className="w-full min-w-0 self-center">
      <div className="mb-1.5 flex justify-between gap-2 text-sm font-bold">
        <span className="truncate text-[#2fbf84]">{win ? `$${fmt(win, 0)}` : "--"}</span>
        <span className="truncate text-[#ff6269]">{loss ? `-$${fmt(loss, 0)}` : "--"}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-[#f1edf5]">
        <div style={{ width: `${(win / total) * 100}%` }} className="bg-[#49c69a]" />
        <div style={{ width: `${(loss / total) * 100}%` }} className="bg-[#ff6269]" />
      </div>
    </div>
  );
}

function RadarScore({ stats, score }) {
  const axes = [
    ["胜率", stats.winRate],
    ["盈亏因子", Math.min((stats.pf || 0) * 35, 100)],
    ["盈亏比", stats.avgLoss ? Math.min((stats.avgWin / stats.avgLoss) * 40, 100) : 0],
    ["恢复因子", stats.maxDrawdown ? Math.min((Math.max(stats.net, 0) / stats.maxDrawdown) * 40, 100) : stats.net > 0 ? 100 : 0],
    ["最大回撤", Math.max(0, 100 - Math.min(stats.maxDrawdown, 1000) / 10)],
    ["一致性", Math.max(0, 100 - Math.abs(stats.expectancy < 0 ? stats.expectancy : 0))],
  ];
  const cx = 210;
  const cy = 142;
  const maxR = 86;
  const point = (i, pct) => {
    const angle = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
    const r = maxR * pct / 100;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };
  const poly = axes.map(([, pct], i) => point(i, pct).join(",")).join(" ");
  const rings = [0.25, 0.5, 0.75, 1].map((scale) => axes.map((_, i) => point(i, scale * 100).join(",")).join(" "));

  return (
    <div>
      <svg className="h-[255px] w-full" viewBox="0 0 420 255">
        {rings.map((ring) => <polygon key={ring} points={ring} fill="none" stroke="#eeeaf3" />)}
        {axes.map(([label], i) => {
          const [x, y] = point(i, 122);
          return <text key={label} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill="#8b8497" fontSize="13">{label}</text>;
        })}
        <polygon points={poly} fill="rgba(109,68,217,0.15)" stroke="#6d44d9" strokeWidth="2" />
        {axes.map(([, pct], i) => {
          const [x, y] = point(i, pct);
          return <circle key={i} cx={x} cy={y} r="3.5" fill="#6d44d9" />;
        })}
      </svg>
      <div className="border-t border-[#eeeaf3] pt-4">
        <div className="mb-1 text-xs font-medium text-[#6f6680]">你的纪律评分</div>
        <div className="flex items-center gap-4">
          <div className="w-20 text-2xl font-bold text-[#191622]">{score}</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#ebe7f0]">
            <div className="h-full rounded-full bg-[#ff6269]" style={{ width: `${Math.max(5, score)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgressMiniTracker({ state }) {
  const dayLabels = ["日", "一", "二", "三", "四", "五", "六"];
  const done = state.tasks.filter((task) => task.done).length;

  // 真实交易热力图：最近 12 周，按日净盈亏着色
  const byDay = {};
  state.trades.forEach((trade) => {
    const d = tradeDate(trade);
    const v = num(trade.pnl);
    byDay[d] = (byDay[d] || 0) + (Number.isNaN(v) ? 0 : v);
  });
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay() - 7 * 11);
  const weeks = Array.from({ length: 12 }, (_, w) => Array.from({ length: 7 }, (_, d) => {
    const date = new Date(start);
    date.setDate(start.getDate() + w * 7 + d);
    return date;
  }));
  const maxAbs = Math.max(...Object.values(byDay).map((v) => Math.abs(v)), 1);
  const cellFor = (date) => {
    const key = formatDate(date);
    const pnl = byDay[key];
    if (date > now || pnl === undefined) return { style: { backgroundColor: "#fff" }, title: key };
    const alpha = 0.3 + 0.6 * Math.min(1, Math.abs(pnl) / maxAbs);
    return {
      style: { backgroundColor: pnl >= 0 ? `rgba(14,159,110,${alpha})` : `rgba(229,72,77,${alpha})` },
      title: `${key}  ${pnl >= 0 ? "+" : ""}${fmt(pnl, 0)}`,
    };
  };
  const monthLabels = weeks.map((week, i) => {
    const month = week[0].getMonth();
    return i === 0 || month !== weeks[i - 1][0].getMonth() ? `${month + 1}月` : "";
  });

  return (
    <div>
      <div className="grid grid-cols-[24px_repeat(12,1fr)] gap-1">
        <span />
        {monthLabels.map((label, i) => <span key={i} className="text-center text-[10px] font-medium text-[#7b55df]">{label}</span>)}
        {dayLabels.map((label, row) => (
          <Fragment key={label}>
            <span className="text-[10px] leading-6 text-[#8290a0]">{label}</span>
            {weeks.map((week, col) => {
              const cell = cellFor(week[row]);
              return <div key={`${col}-${row}`} className="h-6 rounded-sm border border-[#eeeaf3]" style={cell.style} title={cell.title} />;
            })}
          </Fragment>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 text-[11px] text-[#8c8499]">
        <span className="flex items-center gap-1"><b className="h-3.5 w-3.5 rounded-sm bg-[#2fbf84]" /> 盈利日</span>
        <span className="flex items-center gap-1"><b className="h-3.5 w-3.5 rounded-sm bg-[#ff6269]" /> 亏损日</span>
        <span>深浅 = 金额 · 空白 = 未交易</span>
      </div>
      <div className="mt-5 flex items-center justify-between border-t border-[#eeeaf3] pt-4">
        <div>
          <div className="text-xs font-medium text-[#6f6680]">今日清单完成</div>
          <div className="text-2xl font-bold text-[#1f1b2a]">{done}/{state.tasks.length}</div>
        </div>
        <span className="text-[11px] text-[#9a93a6]">清单在「每日复盘」左栏勾选</span>
      </div>
    </div>
  );
}

function AreaLineChart({ curve }) {
  const points = curve.length ? curve : [{ index: 1, equity: 0 }, { index: 2, equity: 0 }];
  const width = 430;
  const height = 280;
  const values = points.map((p) => p.equity);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const xy = points.map((p, i) => [points.length === 1 ? 0 : (i / (points.length - 1)) * width, height - ((p.equity - min) / span) * height]);
  const line = xy.map((p) => p.join(",")).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const zeroY = height - ((0 - min) / span) * height;
  return (
    <svg className="h-[280px] w-full" viewBox={`0 0 ${width} ${height}`}>
      <defs><linearGradient id="lossArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff6269" stopOpacity="0.35" /><stop offset="1" stopColor="#ff6269" stopOpacity="0.05" /></linearGradient></defs>
      {Array.from({ length: 7 }, (_, i) => <line key={i} x1="0" x2={width} y1={(i / 6) * height} y2={(i / 6) * height} stroke="#eeeaf3" strokeDasharray="3 3" />)}
      <line x1="0" x2={width} y1={zeroY} y2={zeroY} stroke="#e3deec" />
      <polygon points={area} fill="url(#lossArea)" />
      <polyline points={line} fill="none" stroke="#7960dd" strokeWidth="2" />
      <text x="0" y="12" fill="#8c8499" fontSize="12">${fmt(max, 0)}</text>
      <text x="0" y={height - 4} fill="#8c8499" fontSize="12">${fmt(min, 0)}</text>
    </svg>
  );
}

function DailyBarChart({ days }) {
  const sorted = days.slice().reverse(); // 最旧在左，最新在右
  const maxAbs = Math.max(...sorted.map((d) => Math.abs(d.pnl)), 1);
  if (!sorted.length) return <div className="pb-28 text-xs text-neutral-600">导入交易后这里按交易日显示每天的净盈亏</div>;
  return (
    <div>
      <div className="mb-2 flex justify-center gap-5 text-[11px] text-[#8c8499]">
        <span className="flex items-center gap-1.5"><b className="h-2.5 w-2.5 rounded-sm bg-[#2fbf84]" />盈利日</span>
        <span className="flex items-center gap-1.5"><b className="h-2.5 w-2.5 rounded-sm bg-[#ff6269]" />亏损日</span>
        <span>柱高 = 当日净盈亏大小</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex h-[250px] items-end gap-4 border-b border-[#eeeaf3] px-4" style={{ minWidth: `${Math.max(sorted.length * 56, 300)}px` }}>
          {sorted.map((day) => (
            <div key={day.date} className="flex h-full flex-shrink-0 flex-col items-center justify-end">
              <div className={`mb-1 whitespace-nowrap text-[11px] font-semibold ${day.pnl >= 0 ? "text-[#0e9f6e]" : "text-[#e5484d]"}`}>{day.pnl >= 0 ? "+" : ""}{fmt(day.pnl, 0)}</div>
              <div className={`w-9 rounded-t-sm ${day.pnl >= 0 ? "bg-[#2fbf84]" : "bg-[#ff6269]"}`} style={{ height: `${Math.max(6, Math.abs(day.pnl) / maxAbs * 165)}px` }} />
              <div className="mt-2 text-[11px] text-[#8c8499]">{day.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RecentTradesTable({ trades }) {
  if (!trades.length) return <p className="text-xs text-neutral-600">暂无最近交易。</p>;
  return (
    <table className="w-full table-fixed text-left">
      <thead className="bg-[#f3f0fb] text-xs text-[#36303f]"><tr><th className="w-[30%] px-3 py-2.5 font-semibold">日期</th><th className="px-3 py-2.5 font-semibold">品种</th><th className="px-3 py-2.5 text-right font-semibold">净盈亏</th></tr></thead>
      <tbody className="text-[13px]">
        {trades.map((trade) => (
          <tr key={trade.id} className="border-b border-[#eeeaf3]">
            <td className="px-3 py-2.5 text-[#564f63]">{tradeDate(trade).slice(5)}</td>
            <td className="truncate px-3 py-2.5">{trade.symbol || "—"}</td>
            <td className={`whitespace-nowrap px-3 py-2.5 text-right font-semibold ${num(trade.pnl) >= 0 ? "text-[#2fbf84]" : "text-[#ff6269]"}`}>{num(trade.pnl) >= 0 ? "+" : ""}{fmt(num(trade.pnl))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StrategyStatsBoard({ trades }) {
  // 单策略统计：每个策略 ID 单独计算
  const single = {};
  trades.forEach((trade) => {
    const ids = (trade.strategy || "").split(",").map((s) => s.trim()).filter(Boolean);
    const keys = ids.length ? ids : ["__none__"];
    keys.forEach((k) => { (single[k] = single[k] || []).push(trade); });
  });

  const buildRow = (key, items, name, env) => {
    const closed = items.filter((t) => !Number.isNaN(num(t.pnl)));
    const wins = closed.filter((t) => num(t.pnl) > 0);
    const net = closed.reduce((acc, t) => acc + num(t.pnl), 0);
    const rrs = items.map((t) => num(t.rr)).filter((v) => !Number.isNaN(v));
    return {
      key, name, env,
      count: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      net,
      avgRR: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : NaN,
      r1: rrs.length ? (rrs.filter((v) => v >= 1).length / rrs.length) * 100 : NaN,
      r2: rrs.length ? (rrs.filter((v) => v >= 2).length / rrs.length) * 100 : NaN,
      rrN: rrs.length,
    };
  };

  const singleRows = Object.entries(single).map(([key, items]) =>
    buildRow(key, items,
      key === "__none__" ? "未绑定策略" : strategyLabel(key),
      key === "__none__" ? "" : envLabel(STRATEGIES.find((s) => s.id === key)?.env),
    )
  ).sort((a, b) => (a.key === "__none__") - (b.key === "__none__") || b.count - a.count);

  // 组合策略统计：选了 2+ 个策略的交易，按完整组合分组
  const combos = {};
  trades.forEach((trade) => {
    const ids = (trade.strategy || "").split(",").map((s) => s.trim()).filter(Boolean).sort();
    if (ids.length < 2) return;
    const key = ids.join(" + ");
    (combos[key] = combos[key] || { ids, items: [] }).items.push(trade);
  });

  const comboRows = Object.entries(combos)
    .map(([key, { ids, items }]) =>
      buildRow(key, items, ids.map(strategyLabel).join(" + "), "组合")
    )
    .filter((r) => r.count >= 1)
    .sort((a, b) => b.count - a.count);

  if (!trades.length) return <p className="text-xs text-neutral-500">导入交易并在交易卡片上绑定策略后，这里会统计每个策略的胜率和盈亏比分布。</p>;

  const StatCard = ({ row, combo }) => (
    <div className={`rounded-lg border p-3.5 ${row.key === "__none__" ? "border-dashed border-[#e0dbea] bg-[#fbfafd]" : combo ? "border-[#d4c5f5] bg-[#faf7ff]" : "border-[#e9e5f1] bg-white"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-[#262231]">{row.name}</span>
        {row.env && <span className={`rounded px-1.5 py-0.5 text-[10px] ${combo ? "bg-[#ede5ff] text-[#5f3bc6]" : "bg-[#f1edf9] text-[#6d44d9]"}`}>{row.env}</span>}
        <span className={`ml-auto text-sm font-bold ${row.net >= 0 ? "text-[#0e9f6e]" : "text-[#e5484d]"}`}>{row.net >= 0 ? "+" : ""}{fmt(row.net, 0)}</span>
      </div>
      <div className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-[#f1edf5]">
        <div className="bg-[#2fbf84]" style={{ width: `${row.winRate}%` }} />
        <div className="bg-[#ff6269]" style={{ width: `${100 - row.winRate}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#837b91]">
        <span>{row.count} 笔</span>
        <span>胜率 <b className="text-[#262231]">{fmt(row.winRate, 0)}%</b></span>
        <span>平均RR {Number.isNaN(row.avgRR) ? "—" : fmt(row.avgRR, 1)}</span>
        <span>≥1R {Number.isNaN(row.r1) ? "—" : `${fmt(row.r1, 0)}%`}</span>
        <span>≥2R {Number.isNaN(row.r2) ? "—" : `${fmt(row.r2, 0)}%`}</span>
        {row.rrN < row.count && <span className="text-[#b45309]">RR 样本 {row.rrN}/{row.count}</span>}
      </div>
    </div>
  );

  return (
    <div className="max-h-[700px] space-y-3 overflow-auto pr-1">
      {singleRows.map((row) => <StatCard key={row.key} row={row} />)}

      {comboRows.length > 0 && (
        <>
          <div className="flex items-center gap-2 pt-2">
            <div className="h-px flex-1 bg-[#e9e5f1]" />
            <span className="text-[11px] font-semibold text-[#6d44d9]">策略组合</span>
            <div className="h-px flex-1 bg-[#e9e5f1]" />
          </div>
          {comboRows.map((row) => <StatCard key={row.key} row={row} combo />)}
        </>
      )}

      <p className="pt-1 text-[11px] leading-relaxed text-[#9a93a6]">RR 取自交易卡片上的 RR 字段（按你实际拿到的盈亏比填，如 2 = 拿到 2 倍风险）。策略组合 = 同时选了多个策略的交易单独汇总。</p>
    </div>
  );
}

function DrawdownChart({ curve }) {
  const dd = [];
  let peak = 0;
  curve.forEach((point) => {
    peak = Math.max(peak, point.equity);
    dd.push({ index: point.index, equity: -(peak - point.equity) });
  });
  return <AreaLineChart curve={dd.length ? dd : [{ index: 1, equity: 0 }, { index: 2, equity: 0 }]} />;
}

function CalendarTitle({ selectedDate, monthStats }) {
  const date = parseDateTime(selectedDate) || new Date();
  return (
    <div className="flex w-full items-center gap-4">
      <button className="text-[#8c8499]">◀</button>
      <span className="font-semibold">{date.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
      <button className="text-[#8c8499]">▶</button>
      <span className="rounded-md border border-[#e6e1ef] px-3 py-1 text-xs">This month</span>
      <span className="ml-auto text-xs font-semibold">Monthly stats: <span className={monthStats.pnl >= 0 ? "text-[#2fbf84]" : "text-[#ff6269]"}>{fmt(monthStats.pnl, 0)}</span></span>
      <span className="rounded-full bg-[#eee9fb] px-2 py-1 text-xs text-[#6d44d9]">{monthStats.days} day</span>
    </div>
  );
}

function MonthCalendar({ trades, selectedDate, setSelectedDate }) {
  const base = parseDateTime(selectedDate) || new Date();
  const year = base.getFullYear();
  const month = base.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const byDay = trades.reduce((acc, trade) => {
    const day = tradeDate(trade);
    acc[day] = acc[day] || { pnl: 0, count: 0 };
    acc[day].pnl += Number.isNaN(num(trade.pnl)) ? 0 : num(trade.pnl);
    acc[day].count += 1;
    return acc;
  }, {});
  const cells = Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - startOffset + 1;
    if (dayNum < 1 || dayNum > total) return null;
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    return { date, dayNum, stats: byDay[date] };
  });
  const weeks = [1, 2, 3, 4, 5].map((week) => {
    const slice = cells.slice((week - 1) * 7, week * 7).filter(Boolean);
    const pnl = slice.reduce((acc, cell) => acc + (cell.stats?.pnl || 0), 0);
    const days = slice.filter((cell) => cell.stats).length;
    return { week, pnl, days };
  });

  return (
    <div className="grid grid-cols-[1fr_160px] gap-5">
      <div>
        <div className="mb-2 grid grid-cols-7 gap-1">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <div key={day} className="rounded-md border border-[#eeeaf3] py-2 text-center text-xs font-semibold">{day}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((cell, i) => {
            const pnl = cell?.stats?.pnl;
            const tone = !cell ? "border-transparent bg-white"
              : cell.stats
                ? pnl > 0 ? "border-[#bfe8d4] bg-[#e6f8ef]" : pnl < 0 ? "border-[#f3c5c8] bg-[#fdeeee]" : "border-[#eeeaf3] bg-[#f7f7f8]"
                : "border-[#eeeaf3] bg-[#f7f7f8]";
            const selected = cell?.date === selectedDate ? "ring-2 ring-[#6d44d9] border-[#6d44d9]" : "";
            return (
              <button key={i} onClick={() => cell && setSelectedDate(cell.date)} className={`h-[100px] rounded-md border p-2 text-right align-top ${tone} ${selected}`}>
                {cell && <><div className="text-sm text-[#36303f]">{cell.dayNum}</div>{cell.stats && <div className={`mt-3 text-center text-sm font-bold ${pnl > 0 ? "text-[#0e9f6e]" : pnl < 0 ? "text-[#e5484d]" : "text-[#564f63]"}`}>{fmt(pnl, 0)}<div className="text-xs font-normal text-[#8c8499]">{cell.stats.count} trades</div></div>}</>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-2 pt-9">
        {weeks.map((week) => {
          const tone = !week.days ? "border-[#eeeaf3] bg-white"
            : week.pnl > 0 ? "border-[#bfe8d4] bg-[#e6f8ef]" : week.pnl < 0 ? "border-[#f3c5c8] bg-[#fdeeee]" : "border-[#eeeaf3] bg-white";
          return (
            <div key={week.week} className={`rounded-lg border p-4 ${tone}`}>
              <div className="text-xs text-[#8c8499]">Week {week.week}</div>
              <div className={`mt-1 text-lg font-bold ${!week.days ? "text-[#564f63]" : week.pnl > 0 ? "text-[#0e9f6e]" : week.pnl < 0 ? "text-[#e5484d]" : "text-[#564f63]"}`}>{fmt(week.pnl, 0)}</div>
              <span className="rounded-full bg-white/70 px-2 py-1 text-xs text-[#6d44d9]">{week.days} days</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function dayWinRate(days) {
  return days.length ? (days.filter((day) => day.pnl > 0).length / days.length) * 100 : 0;
}

function monthSummary(trades, selectedDate) {
  const base = parseDateTime(selectedDate) || new Date();
  const prefix = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
  const days = new Set();
  const pnl = trades.reduce((acc, trade) => {
    const date = tradeDate(trade);
    if (!date.startsWith(prefix)) return acc;
    days.add(date);
    return acc + (Number.isNaN(num(trade.pnl)) ? 0 : num(trade.pnl));
  }, 0);
  return { pnl, days: days.size };
}

function formatDashboardDate(value) {
  const date = parseDateTime(value);
  return date ? date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }) : String(value || "");
}

function formatShortDate(value) {
  const date = parseDateTime(value);
  if (!date) return value || "—";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

function durationToMinutes(value) {
  if (!value) return 0;
  const text = String(value);
  const hours = Number(text.match(/(\d+)\s*h/)?.[1] || 0);
  const minutes = Number(text.match(/(\d+)\s*min/)?.[1] || 0);
  const seconds = Number(text.match(/(\d+)\s*sec/)?.[1] || 0);
  return hours * 60 + minutes + seconds / 60;
}

function DailyReview({ state, setState, selectedDate, setSelectedDate, dailyTrades, dayStats, dailyReview, scanDownloads, openTradovate }) {
  const tradingDays = useMemo(() => getTradingDays(state.trades), [state.trades]);
  return (
    <Page wide title="Journal 每日复盘" subtitle="选日期 → 拖截图 → 标注每笔交易 → 写计划/总结 → 生成 AI 复盘。">
      <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
            <span className="text-xs text-neutral-500">Date</span>
            <input className="bg-transparent text-sm text-neutral-100 outline-none" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </div>
          <button className="rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:border-neutral-600">Account: All</button>
          <button className="rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:border-neutral-600">Tags: All</button>
          <span className="ml-auto rounded-md border border-[#d9c9f5] bg-[#f5f0ff] px-3 py-2 text-xs text-[#6d44d9]">AI Session Review 在页面底部 ↓</span>
        </div>
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-4">
        <aside className="space-y-4">
          <Panel title="Daily Entries">
            <JournalDayList days={tradingDays} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
          </Panel>
          <Panel title="Session Rules">
            <TaskBoard state={state} setState={setState} />
          </Panel>
        </aside>

        <div className="min-w-0">
          {/* 盈亏指标：横向一行铺满 */}
          <MetricGrid stats={dayStats} prefix="当日" row />

          {/* 复盘主工作区：截图 + 计划/总结 + 逐笔标注，全宽 */}
          <Panel title="当日复盘 · 截图 / 计划 / 逐笔标注" className="mt-4">
            <DayScreenshots state={state} setState={setState} selectedDate={selectedDate} />
            <DailySummary date={selectedDate} review={dailyReview} setState={setState} />
            <div className="mb-3 flex justify-between items-center">
              <span className="text-xs font-medium text-[#6f6680]">逐笔交易 ({dailyTrades.length})</span>
              <button
                onClick={() => addManualTrade(setState, selectedDate)}
                className="rounded-md border border-dashed border-[#c9bfee] px-3 py-1.5 text-xs text-[#6d44d9] hover:bg-[#f5f0ff]"
              >
                + 新增交易
              </button>
            </div>
            <TradeCards trades={dailyTrades} state={state} setState={setState} selectedDate={selectedDate} />
          </Panel>

          <AiSessionReview state={state} setState={setState} selectedDate={selectedDate} dailyTrades={dailyTrades} dayStats={dayStats} />

          <div className="mt-4 grid gap-4 md:grid-cols-[1fr_380px]">
            <Panel title="Intraday Cumulative Net P&L">
              <EquityChart curve={dayStats.curve} />
            </Panel>
            <DailyGuard state={state} setState={setState} />
          </div>

          <div className="mt-4">
            <CsvImporter setState={setState} compact scanDownloads={scanDownloads} openTradovate={openTradovate} autoImport={state.autoImport} />
          </div>
        </div>
      </div>
    </Page>
  );
}

/* ============ 当日截图（在 Trades 面板内：拖拽/粘贴即显示，AI 复盘共用） ============ */
function DayScreenshots({ state, setState, selectedDate }) {
  const images = state.dailyReviews[selectedDate]?.aiImages || [];
  const [thumbs, setThumbs] = useState({});
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [lightbox, setLightbox] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      for (const image of images) {
        next[image.name] = await imageDataUrl(image).catch(() => "");
      }
      if (!cancelled) setThumbs(next);
    })();
    return () => { cancelled = true; };
  }, [selectedDate, images.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addFiles(fileList) {
    setError("");
    try {
      const saved = [];
      for (const file of [...(fileList || [])]) {
        if (file.type && !file.type.startsWith("image/")) continue;
        const record = await saveImage(file);
        saved.push({ ...record, mediaType: file.type || "image/png" });
      }
      if (saved.length) {
        setState((s) => {
          const current = s.dailyReviews[selectedDate]?.aiImages || [];
          return { ...s, dailyReviews: { ...s.dailyReviews, [selectedDate]: { ...(s.dailyReviews[selectedDate] || {}), aiImages: [...current, ...saved] } } };
        });
      }
    } catch (e) {
      setError(`截图保存失败：${e.message}`);
    }
  }

  // ⌘V 粘贴截图（焦点在某笔交易截图区内时不拦截，交给该区域自己处理）
  useEffect(() => {
    const onPaste = (e) => {
      if (document.activeElement?.closest("[data-trade-screenshots]")) return;
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 放大查看时锁定背景页面滚动，滚轮只作用于图片
  useEffect(() => {
    const root = document.querySelector("section.min-w-0.overflow-auto");
    if (lightbox) {
      document.body.style.overflow = "hidden";
      if (root) root.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
      if (root) root.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
      if (root) root.style.overflow = "";
    };
  }, [lightbox]);

  function removeImage(name) {
    setState((s) => ({
      ...s,
      dailyReviews: { ...s.dailyReviews, [selectedDate]: { ...(s.dailyReviews[selectedDate] || {}), aiImages: (s.dailyReviews[selectedDate]?.aiImages || []).filter((img) => img.name !== name) } },
    }));
  }

  return (
    <div
      className={`mb-4 rounded-md border border-dashed px-3 py-3 transition ${dragOver ? "border-[#6d44d9] bg-[#f3edff]" : "border-[#d9cef0] bg-[#fbfaff]"}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer?.files); }}
    >
      <div className="flex items-center gap-2 text-xs text-[#6f6680]">
        <Ic n="upload" s={14} cls="text-[#6d44d9]" />
        大级别背景图（15分钟 / 1小时 / 日线）：拖入或 ⌘V 粘贴，AI 复盘用作市场背景参考
        <label className="ml-auto cursor-pointer font-medium text-[#6d44d9] underline">
          选择文件
          <input className="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </div>
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      {images.length > 0 && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {images.map((image) => (
            <div key={image.name} className="group relative">
              {thumbs[image.name]
                ? <img src={thumbs[image.name]} alt={image.name} onClick={() => setLightbox(thumbs[image.name])} className="w-full cursor-zoom-in rounded-md border border-[#ece8f2] transition hover:brightness-95" />
                : <div className="grid h-48 w-full place-items-center rounded-md border border-[#ece8f2] text-[10px] text-neutral-400">加载中</div>}
              <button onClick={() => removeImage(image.name)} className="absolute right-2 top-2 hidden h-6 w-6 rounded-full bg-[#ff6269] text-white shadow group-hover:grid place-items-center"><Ic n="x" s={13} /></button>
            </div>
          ))}
        </div>
      )}
      {lightbox && (
        <div className="fixed inset-0 z-50 cursor-zoom-out overflow-auto overscroll-contain bg-black/80 p-6" onClick={() => setLightbox("")}>
          <img src={lightbox} alt="screenshot" className="mx-auto w-full max-w-[1800px] rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}

/* ============ AI Session Review（仿 TradeZella：截图 + 当日数据 → Claude 复盘） ============ */
function AiSessionReview({ state, setState, selectedDate, dailyTrades, dayStats }) {
  const review = state.dailyReviews[selectedDate] || {};
  const images = review.aiImages || [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const patchReview = (patch) => setState((s) => ({
    ...s,
    dailyReviews: { ...s.dailyReviews, [selectedDate]: { ...(s.dailyReviews[selectedDate] || {}), ...patch } },
  }));

  async function generate() {
    const cfg = state.agent?.claude || {};
    setError("");
    if (!cfg.apiKey) { setError("还没有配置 Claude API Key —— 去「AI Agent」页填写。"); return; }
    if (!images.length && !dailyTrades.length) { setError("先在上方 Trades 面板拖入当日截图，或至少录入当日交易。"); return; }
    setBusy(true);
    try {
      const tradeImages = review.tradeImages || {};
      const content = [textBlock(buildSessionReviewContext({ date: selectedDate, trades: dailyTrades, stats: dayStats, state }))];

      // 逐笔发送：交易文字标签 → 该笔绑定的截图（AI 能精准对应）
      const fmtNum = (v) => (Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(2));
      const hhmm = (v) => { const d = parseDateTime(v); return d ? `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}` : "?"; };
      content.push(textBlock("以下按交易顺序逐笔附上截图（截图已与对应交易绑定，请逐笔分析）："));
      for (const [i, trade] of dailyTrades.entries()) {
        const label = `【交易${i + 1}】${trade.symbol || "?"} ${trade.side || "?"} ${hhmm(trade.entryTime)}→${hhmm(trade.exitTime)}  入场${trade.entry || "?"}→出场${trade.exit || "?"}  盈亏$${fmtNum(trade.pnl)}`;
        content.push(textBlock(label));
        const tImgs = tradeImages[trade.id] || [];
        if (tImgs.length) {
          for (const img of tImgs) {
            const data = await readImageBase64(img);
            if (data) content.push(imageBlock(data.base64, data.mediaType));
          }
        } else {
          content.push(textBlock("（该笔未上传截图）"));
        }
      }

      // 全局截图（当日市场背景总览，未绑定到具体交易）
      if (images.length) {
        content.push(textBlock("以下是当日整体图表（未绑定到具体交易，可作为市场背景参考）："));
        for (const image of images) {
          const data = await readImageBase64(image);
          if (data) {
            content.push(textBlock(`截图：${image.name}`));
            content.push(imageBlock(data.base64, data.mediaType));
          }
        }
      }
      const markdown = await callClaude(cfg, {
        system: state.agent?.sessionReview?.template?.trim() || SESSION_REVIEW_SKILL,
        messages: [{ role: "user", content }],
        maxTokens: 8000,
      });
      patchReview({ aiReview: markdown, aiReviewAt: new Date().toISOString() });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-[#d9c9f5] bg-white">
      <div className="flex items-center gap-2 border-b border-[#eee7fb] px-4 py-3">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-[#6d44d9] text-white"><Ic n="activity" s={15} /></span>
        <div>
          <h3 className="text-sm font-semibold text-[#262231]">AI Session Review</h3>
          <p className="text-[11px] text-neutral-500">用上方 Trades 面板里的截图 + 当日交易数据 + 你的规则 + Brooks 市场背景生成复盘</p>
        </div>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-neutral-500">{dailyTrades.length} 笔交易 · {images.length} 张截图</span>
          {review.aiReviewAt && <span className="text-[11px] text-neutral-400">上次 {String(review.aiReviewAt).slice(5, 16).replace("T", " ")}</span>}
          <button onClick={generate} disabled={busy} className="rounded-md bg-[#6d44d9] px-4 py-2 text-xs font-semibold text-white hover:bg-[#5d35c6] disabled:opacity-50">
            {busy ? "Claude 分析中..." : review.aiReview ? "重新生成复盘" : "生成 AI 复盘"}
          </button>
        </span>
      </div>

      <div className="space-y-3 p-4">
        {error && <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"><Ic n="alert" s={13} />{error}</div>}
        {review.aiReview
          ? <div className="rounded-md border border-[#eeeaf3] bg-[#fcfbfe] p-4"><Markdown text={review.aiReview} /></div>
          : !busy && <p className="text-xs text-neutral-500">还没有生成过这一天的 AI 复盘。截图建议带上 TradingView 持仓工具的出入场标记，AI 能读出入场质量。</p>}
      </div>
    </section>
  );
}

/* ============ 教练报告（周度 / 月度 / 全量深度分析） ============
   存储结构：coachReports[uniqueKey] = { generatedAt, markdown, reportType, period? }
   - uniqueKey = "weekly-2024-W25-1719200000000" / "monthly-2024-06-..." / "deep-..."
   - 每次生成都新建 key，历史永久保留，不覆盖
   ========================================================== */
function CoachReportPage({ state, setState }) {
  const [type, setType] = useState("weekly");
  const [refDate, setRefDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState(null); // 当前查看哪条报告

  const isDeep = type === "deep";
  const ref = new Date(refDate);
  const curPeriod = isDeep ? null : periodKey(type, ref); // e.g. "2024-W25"

  // 所有报告，按生成时间倒序
  const allReports = Object.entries(state.coachReports || {})
    .map(([k, v]) => ({ key: k, ...v }))
    .filter((r) => r.reportType === type || (!r.reportType && (
      // 兼容旧格式（无 reportType 字段）
      type === "weekly" ? r.key?.includes("W") :
      type === "monthly" ? (!r.key?.includes("W") && !r.key?.startsWith("deep") && r.key !== "__deep__") :
      (r.key?.startsWith("deep") || r.key === "__deep__")
    )))
    .sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));

  // 当前周期的报告（周/月用）
  const periodReports = isDeep ? [] : allReports.filter((r) => r.period === curPeriod || (
    !r.period && (r.key === curPeriod || r.key?.startsWith(`${type === "weekly" ? "weekly" : "monthly"}-${curPeriod}`))
  ));

  // 当前显示的报告：selectedKey 指向的 或 同周期最新 或 深度分析最新
  const viewReport = selectedKey
    ? allReports.find((r) => r.key === selectedKey)
    : (isDeep ? allReports[0] : periodReports[0]) || null;

  // 上一期的最新报告，用于 coach context
  const prevPeriod = (() => {
    if (isDeep) return null;
    const d = new Date(refDate);
    if (type === "weekly") d.setDate(d.getDate() - 7); else d.setMonth(d.getMonth() - 1);
    return periodKey(type, d);
  })();
  const prevReport = prevPeriod
    ? allReports.find((r) => r.period === prevPeriod) || null
    : null;

  async function generate() {
    const cfg = state.agent?.claude || {};
    setError("");
    if (!cfg.apiKey) { setError("还没有配置 Claude API Key —— 去「AI Agent」页填写。"); return; }
    setBusy(true);
    try {
      let context, system;
      if (isDeep) {
        context = buildDeepAnalysisContext({ trades: state.trades, dailyReviews: state.dailyReviews });
        system = DEEP_ANALYSIS_SYSTEM;
      } else {
        context = buildCoachContext({ trades: state.trades, dailyReviews: state.dailyReviews, type, refDate: ref, lastReport: prevReport });
        system = COACH_SYSTEM;
      }
      const markdown = await callClaude(cfg, {
        system,
        messages: [{ role: "user", content: context }],
        maxTokens: 6000,
      });
      const ts = Date.now();
      const newKey = isDeep ? `deep-${ts}` : `${type}-${curPeriod}-${ts}`;
      const newReport = {
        generatedAt: new Date().toISOString(),
        markdown,
        reportType: type,
        ...(isDeep ? {} : { period: curPeriod }),
      };
      setState((s) => ({ ...s, coachReports: { ...s.coachReports, [newKey]: newReport } }));
      setSelectedKey(newKey); // 自动跳到刚生成的
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function deleteReport(key) {
    setState((s) => {
      const next = { ...s.coachReports };
      delete next[key];
      return { ...s, coachReports: next };
    });
    if (selectedKey === key) setSelectedKey(null);
  }

  // 左侧列表项：深度分析显示所有，周/月显示所有期+该期下的多条记录
  const listItems = isDeep
    ? allReports
    : (() => {
        // 按 period 分组，每期显示最新一条 + 该期有多条时可展开
        const periodMap = {};
        allReports.forEach((r) => {
          const p = r.period || r.key;
          (periodMap[p] = periodMap[p] || []).push(r);
        });
        return Object.entries(periodMap)
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([p, items]) => ({ period: p, items }));
      })();

  const panelTitle = viewReport
    ? `${isDeep ? "深度分析" : periodLabel(viewReport.period || curPeriod)} · ${String(viewReport.generatedAt).slice(0, 16).replace("T", " ")} 生成`
    : isDeep ? "全量深度分析 · 待生成" : `${curPeriod ? periodLabel(curPeriod) : ""} · 待生成`;

  return (
    <Page wide title="教练报告" subtitle="所有生成记录永久保留，左侧点击查看任意历史版本。">
      {/* 顶部控制栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-[#e9e5f1] bg-white p-1">
          {[["weekly", "周报"], ["monthly", "月报"], ["deep", "🔍 深度分析"]].map(([t, lbl]) => (
            <button key={t} onClick={() => { setType(t); setSelectedKey(null); }}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${type === t ? "bg-[#6d44d9] text-white" : "text-[#564f63] hover:bg-[#f1edf9]"}`}>{lbl}</button>
          ))}
        </div>
        {!isDeep && (
          <label className="flex items-center gap-2 text-sm text-[#564f63]">
            基准日期
            <input type="date" value={refDate} onChange={(e) => { setRefDate(e.target.value); setSelectedKey(null); }}
              className="rounded-md border border-[#e9e5f1] bg-white px-3 py-1.5 text-sm outline-none focus:border-[#6d44d9]" />
          </label>
        )}
        {!isDeep && curPeriod && <span className="text-sm font-semibold text-[#6d44d9]">{periodLabel(curPeriod)}</span>}
        {isDeep && (
          <span className="rounded-lg border border-[#c9bfee] bg-[#f5f1ff] px-3 py-1.5 text-xs text-[#6d44d9]">
            分析全部 <strong>{state.trades.length}</strong> 笔历史交易
          </span>
        )}
        <button onClick={generate} disabled={busy}
          className="ml-auto rounded-md bg-[#6d44d9] px-5 py-2 text-sm font-semibold text-white hover:bg-[#5d35c6] disabled:opacity-50">
          {busy ? "Claude 分析中..." : isDeep ? "生成新一轮分析" : "生成本期报告"}
        </button>
      </div>

      {error && <div className="mb-4 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"><Ic n="alert" s={14} />{error}</div>}

      <div className="grid gap-4 lg:grid-cols-[230px_1fr]">
        {/* 左：历史记录列表 */}
        <Panel title={isDeep ? `历史分析（${allReports.length}）` : "历史报告"}>
          {allReports.length === 0 ? (
            <p className="text-xs text-neutral-500">还没有记录，点右上角生成第一份。</p>
          ) : isDeep ? (
            <div className="space-y-1.5">
              {allReports.map((r) => {
                const active = (selectedKey === r.key) || (!selectedKey && r.key === allReports[0]?.key);
                return (
                  <div key={r.key} className={`group flex items-start gap-1 rounded-lg border px-2.5 py-2 ${active ? "border-[#6d44d9] bg-[#efeafd]" : "border-[#e9e5f1] bg-white hover:border-[#c9bfee]"}`}>
                    <button className="flex-1 text-left" onClick={() => setSelectedKey(r.key)}>
                      <div className={`text-xs font-semibold ${active ? "text-[#5f3bc6]" : "text-[#564f63]"}`}>
                        {String(r.generatedAt).slice(0, 10)}
                      </div>
                      <div className="mt-0.5 text-[11px] text-neutral-400">{String(r.generatedAt).slice(11, 16)}</div>
                    </button>
                    <button onClick={() => deleteReport(r.key)} className="mt-0.5 hidden group-hover:block text-neutral-300 hover:text-red-400 flex-shrink-0">
                      <Ic n="x" s={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {(listItems).map(({ period, items }) => {
                const isActivePeriod = period === curPeriod;
                return (
                  <div key={period}>
                    <div className={`mb-1 text-[11px] font-semibold ${isActivePeriod ? "text-[#6d44d9]" : "text-[#9b8fd4]"}`}>{periodLabel(period)}</div>
                    <div className="space-y-1 border-l-2 border-[#e4ddf7] pl-2">
                      {items.map((r) => {
                        const active = selectedKey === r.key || (!selectedKey && isActivePeriod && r.key === items[0].key);
                        return (
                          <div key={r.key} className={`group flex items-center gap-1 rounded-lg border px-2 py-1.5 ${active ? "border-[#6d44d9] bg-[#efeafd]" : "border-[#e9e5f1] bg-white hover:border-[#c9bfee]"}`}>
                            <button className="flex-1 text-left" onClick={() => { setSelectedKey(r.key); setRefDate(period.includes("W")
                              ? (() => { const [y, w] = period.split("-W"); const d = new Date(Number(y), 0, 1 + (Number(w) - 1) * 7); d.setDate(d.getDate() + (1 - d.getDay())); return formatDate(d); })()
                              : `${period}-15`); }}>
                              <div className={`text-[11px] ${active ? "text-[#5f3bc6] font-medium" : "text-[#564f63]"}`}>
                                {String(r.generatedAt).slice(0, 10)} {String(r.generatedAt).slice(11, 16)}
                              </div>
                            </button>
                            <button onClick={() => deleteReport(r.key)} className="hidden group-hover:block text-neutral-300 hover:text-red-400 flex-shrink-0">
                              <Ic n="x" s={11} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* 右：报告内容 */}
        <Panel title={panelTitle}>
          {viewReport ? (
            <Markdown text={viewReport.markdown} />
          ) : (
            <div className="flex h-56 flex-col items-center justify-center gap-3 text-[#837b91]">
              <Ic n={isDeep ? "activity" : "shield"} s={36} cls="text-[#c9bfee]" />
              <p className="text-sm text-center max-w-xs">
                {isDeep
                  ? "Claude 会分析所有历史交易，给出策略胜率排行、最大漏钱点和 3 个最优先改进行动。"
                  : "点击「生成本期报告」，Claude 汇总本期所有交易数据和复盘日志。"}
              </p>
              <p className="text-xs text-neutral-400">
                {isDeep ? "建议积累 15 笔以上再生成，结论更可靠。" : "建议每周五收盘后生成周报，月末生成月报。"}
              </p>
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}

/* ============ Brooks 日报（自动抓取 + 中文翻译） ============ */
function BrooksPage({ state, setState, syncBrooks }) {
  const posts = state.brooks?.posts || [];
  const [activeId, setActiveId] = useState(null);
  const [showOriginal, setShowOriginal] = useState(false);

  // 每次刷新后自动跳到最新文章
  useEffect(() => {
    const id = state.brooks?.latestPostId;
    if (id) setActiveId(id);
    else if (posts.length) setActiveId(posts[0].id);
  }, [state.brooks?.latestPostId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const post = posts.find((p) => p.id === activeId) || posts[0];

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      // 直接调 fetchLatestPosts 验证网络是否通
      const { fetchLatestPosts: fetcher } = await import("./agent/brooks");
      const raw = await fetcher(5);
      if (!raw?.length) { setError("API 返回空数据，可能网络不通或被限流"); setBusy(false); return; }
      // 强制刷新
      await syncBrooks(true);
    } catch (e) {
      setError(`刷新失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function translateOne(target) {
    const cfg = state.agent?.claude || {};
    if (!cfg.apiKey) { setError("先到「AI Agent」页配置 Claude API Key 才能翻译。"); return; }
    setBusy(true);
    setError("");
    try {
      const zh = await translatePost(target, cfg);
      setState((s) => ({
        ...s,
        brooks: { ...s.brooks, posts: s.brooks.posts.map((p) => (p.id === target.id ? { ...p, zh, translatedAt: new Date().toISOString() } : p)) },
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const setBrooks = (patch) => setState((s) => ({ ...s, brooks: { ...s.brooks, ...patch } }));

  return (
    <Page title="Brooks 日报" subtitle="每天自动抓取 Brooks Trading Course 的 E-mini 每日报告（今日复盘 + 明日展望），用 Claude 翻译成中文。报告在美股开盘约 2 小时后对所有人开放。">
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#ece8f2] bg-white p-3">
        <button onClick={refresh} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-[#6d44d9] px-4 py-2 text-xs font-semibold text-white hover:bg-[#5d35c6] disabled:opacity-50">
          <Ic n="refresh" s={14} /> {busy ? "同步中..." : "检查新文章"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          <input type="checkbox" checked={!!state.brooks?.autoFetch} onChange={(e) => setBrooks({ autoFetch: e.target.checked })} /> 打开 App 自动抓取
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          <input type="checkbox" checked={!!state.brooks?.autoTranslate} onChange={(e) => setBrooks({ autoTranslate: e.target.checked })} /> 抓到新文章自动翻译
        </label>
        <span className="ml-auto text-[11px] text-neutral-500">上次检查：{state.brooks?.lastChecked ? String(state.brooks.lastChecked).slice(0, 16).replace("T", " ") : "从未"}</span>
      </div>

      {error && <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"><Ic n="alert" s={13} />{error}</div>}

      {!posts.length ? (
        <Panel title="还没有文章"><p className="text-xs text-neutral-500">点「检查新文章」抓取最新的 Brooks 每日报告。</p></Panel>
      ) : (
        <div className="grid grid-cols-[250px_1fr] gap-4">
          <Panel title="最近报告">
            <div className="max-h-[640px] space-y-2 overflow-auto pr-1">
              {posts.map((p) => (
                <button key={p.id} onClick={() => setActiveId(p.id)} className={`w-full rounded-md border px-3 py-2 text-left ${post?.id === p.id ? "border-[#6d44d9] bg-[#efeafd]" : "border-[#ece8f2] bg-white hover:border-[#c9bfee]"}`}>
                  <div className="text-xs font-semibold text-[#262231]">{p.date}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-neutral-500">{p.title}</div>
                  <div className="mt-1 text-[10px]">{p.zh ? <span className="text-emerald-600">已翻译</span> : <span className="text-amber-600">未翻译</span>}</div>
                </button>
              ))}
            </div>
          </Panel>

          {post && (
            <div className="min-w-0 space-y-4">
              <Panel title={`${post.date} · ${post.title}`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {!post.zh && <button onClick={() => translateOne(post)} disabled={busy} className="rounded-md bg-[#6d44d9] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#5d35c6] disabled:opacity-50">{busy ? "翻译中..." : "翻译这篇"}</button>}
                  {post.zh && (
                    <button onClick={() => setShowOriginal(!showOriginal)} className="rounded-md border border-[#e6e1ef] px-3 py-1.5 text-xs text-[#6f6680] hover:border-[#c9bfee]">
                      {showOriginal ? "看中文翻译" : "看英文原文"}
                    </button>
                  )}
                  <a href={post.link} target="_blank" rel="noreferrer" className="text-xs text-[#6d44d9] underline">在 Brooks 官网打开 ↗</a>
                  {post.translatedAt && <span className="ml-auto text-[10px] text-neutral-400">翻译于 {String(post.translatedAt).slice(0, 16).replace("T", " ")}</span>}
                </div>

                {post.setupsImage && (
                  <div className="mb-4 rounded-md border border-[#e6e1ef] bg-[#faf8ff] p-3">
                    <div className="mb-2 text-xs font-semibold text-[#6d44d9]">Yesterday's E-mini Setups（昨日入场标注图）</div>
                    <a href={post.setupsImage} target="_blank" rel="noreferrer">
                      <img src={post.setupsImage} alt="Yesterday's E-mini setups" className="w-full rounded-md border border-[#ece8f2]" />
                    </a>
                  </div>
                )}

                <article
                  className="brooks-article max-w-none text-[13px] leading-relaxed text-[#3d3747]"
                  dangerouslySetInnerHTML={{ __html: post.zh && !showOriginal ? post.zh : post.html }}
                />
              </Panel>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}

function Records({ state, setState }) {
  return (
    <Page title="交易记录" subtitle="每一笔交易都可以绑定环境、策略、错误类型和复盘笔记。">
      <div className="mb-4 flex items-center justify-between">
        <button onClick={() => addManualTrade(setState)} className="rounded-md bg-emerald-600 px-3 py-2 text-xs text-white hover:bg-emerald-500">新增交易</button>
        <span className="text-xs text-neutral-600">{state.trades.length} 笔</span>
      </div>
      <TradeEditorTable state={state} setState={setState} />
    </Page>
  );
}

/* ===== 复盘练习 ===== */
function StudyRoom({ state, setState }) {
  const [selected, setSelected] = useState([]);

  const strategyGroups = useMemo(() =>
    ENVS.map((e) => ({
      label: e.t,
      options: STRATEGIES.filter((s) => s.env === e.k).map((s) => [s.id, s.name]),
    })).filter((g) => g.options.length > 0)
  , []);

  function record(win) {
    if (!selected.length) return;
    // 用 pnl: 1 代表盈，-1 代表亏（只用于胜率统计，不表示具体金额）
    const trade = { id: `study-${uid()}`, strategy: selected.join(","), pnl: win ? 1 : -1, createdAt: new Date().toISOString() };
    setState((s) => ({ ...s, studyTrades: [trade, ...(s.studyTrades || [])] }));
  }

  function del(id) {
    setState((s) => ({ ...s, studyTrades: (s.studyTrades || []).filter((t) => t.id !== id) }));
  }

  const toggleStrategy = (id) => setSelected((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);

  const studyTrades = (state.studyTrades || []);
  const wins = studyTrades.filter((t) => Number(t.pnl) > 0).length;
  const total = studyTrades.length;
  const winRate = total ? Math.round(wins / total * 100) : 0;

  return (
    <Page title="复盘练习" subtitle="选策略 → W 或 L → 胜率自动统计，数据合并到总览策略看板。">

      {/* 快速录入区 */}
      <Panel className="mb-5">
        <div className="mb-3 text-xs font-medium text-[#6f6680]">选择策略（可多选）</div>

        {/* 策略按钮区：按环境分组平铺，避免下拉 */}
        <div className="space-y-3">
          {strategyGroups.map((g) => (
            <div key={g.label}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a93a6]">{g.label}</div>
              <div className="flex flex-wrap gap-2">
                {g.options.map(([id, name]) => (
                  <button key={id} type="button" onClick={() => toggleStrategy(id)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      selected.includes(id)
                        ? "border-[#6d44d9] bg-[#6d44d9] text-white"
                        : "border-[#e0dbea] bg-white text-[#564f63] hover:border-[#c4b7ee]"
                    }`}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* W / L 按钮 */}
        <div className="mt-5 flex items-center gap-3">
          <button onClick={() => record(true)} disabled={!selected.length}
            className="flex-1 rounded-xl border-2 border-[#2fbf84] bg-[#edfaf4] py-4 text-lg font-bold text-[#0e9f6e] transition-all hover:bg-[#2fbf84] hover:text-white disabled:cursor-not-allowed disabled:opacity-30">
            ✓ Win
          </button>
          <button onClick={() => record(false)} disabled={!selected.length}
            className="flex-1 rounded-xl border-2 border-[#ff6269] bg-[#fff0f0] py-4 text-lg font-bold text-[#e5484d] transition-all hover:bg-[#ff6269] hover:text-white disabled:cursor-not-allowed disabled:opacity-30">
            ✗ Loss
          </button>
          {selected.length > 0 && (
            <button onClick={() => setSelected([])} className="rounded-lg border border-[#e0dbea] px-3 py-2 text-xs text-[#9a93a6] hover:bg-[#f4f1fb]">清除</button>
          )}
        </div>
        {selected.length === 0 && <p className="mt-2 text-center text-[11px] text-[#c0b8cc]">先选择至少一个策略</p>}
      </Panel>

      {/* 汇总统计 */}
      {total > 0 && (
        <div className="mb-4 flex items-center gap-4">
          <div className="rounded-lg border border-[#e9e5f1] bg-white px-5 py-3 text-center">
            <div className="text-[11px] text-[#8c8499]">总笔数</div>
            <div className="text-2xl font-bold text-[#262231]">{total}</div>
          </div>
          <div className="rounded-lg border border-[#e9e5f1] bg-white px-5 py-3 text-center">
            <div className="text-[11px] text-[#8c8499]">胜率</div>
            <div className={`text-2xl font-bold ${winRate >= 50 ? "text-[#0e9f6e]" : "text-[#e5484d]"}`}>{winRate}%</div>
          </div>
          <div className="rounded-lg border border-[#e9e5f1] bg-white px-5 py-3 text-center">
            <div className="text-[11px] text-[#8c8499]">盈 / 亏</div>
            <div className="text-2xl font-bold text-[#262231]">{wins} / {total - wins}</div>
          </div>
          <span className="ml-1 text-[11px] text-[#9a93a6]">已合并到总览策略胜率 ↗</span>
        </div>
      )}

      {/* 记录流水 */}
      {total > 0 && (
        <div className="space-y-1.5">
          {studyTrades.map((t, i) => {
            const win = Number(t.pnl) > 0;
            const strategies = (t.strategy || "").split(",").map((s) => s.trim()).filter(Boolean);
            return (
              <div key={t.id} className="flex items-center gap-3 rounded-lg border border-[#e9e5f1] bg-white px-4 py-2.5">
                <span className="w-5 shrink-0 text-center text-xs text-[#b0a8be]">#{total - i}</span>
                <span className={`w-8 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-bold ${win ? "bg-[#edfaf4] text-[#0e9f6e]" : "bg-[#fff0f0] text-[#e5484d]"}`}>
                  {win ? "W" : "L"}
                </span>
                <div className="flex flex-1 flex-wrap gap-1">
                  {strategies.map((id) => (
                    <span key={id} className="rounded-full bg-[#f1edf9] px-2 py-0.5 text-[10px] text-[#6d44d9]">{strategyLabel(id)}</span>
                  ))}
                </div>
                <span className="text-[10px] text-[#c0b8cc]">{t.createdAt ? new Date(t.createdAt).toLocaleTimeString("zh", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                <button onClick={() => del(t.id)} className="text-[11px] text-[#e5484d] opacity-40 hover:opacity-100">✕</button>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}

// 字段类型 → 视觉主题
const FIELD_THEME = {
  "核心逻辑":   { bg: "bg-[#f0ecff]", border: "border-[#c9bfee]", key: "text-[#5f3bc6]",  dot: "bg-[#6d44d9]" },
  "逻辑":       { bg: "bg-[#f0ecff]", border: "border-[#c9bfee]", key: "text-[#5f3bc6]",  dot: "bg-[#6d44d9]" },
  "背景":       { bg: "bg-[#f4f4f8]", border: "border-[#ddd8f0]", key: "text-[#6b6b8a]",  dot: "bg-[#9b99bb]" },
  "关键位":     { bg: "bg-[#f4f4f8]", border: "border-[#ddd8f0]", key: "text-[#6b6b8a]",  dot: "bg-[#9b99bb]" },
  "市场背景":   { bg: "bg-[#f4f4f8]", border: "border-[#ddd8f0]", key: "text-[#6b6b8a]",  dot: "bg-[#9b99bb]" },
  "准入条件":   { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "条件":       { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "结构要素":   { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "适用结构":   { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "硬性规则":   { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "回调限制":   { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "风险分类":   { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "空间":       { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "一致性":     { bg: "bg-[#eff8ff]", border: "border-[#bde0f8]", key: "text-[#2a7ab5]",  dot: "bg-[#3b9de0]" },
  "入场":       { bg: "bg-[#f0f9f4]", border: "border-[#b5e5cb]", key: "text-[#1a7a45]",  dot: "bg-[#22a85e]" },
  "入场方式1（左侧）": { bg: "bg-[#f0f9f4]", border: "border-[#b5e5cb]", key: "text-[#1a7a45]", dot: "bg-[#22a85e]" },
  "入场方式2（右侧）": { bg: "bg-[#f0f9f4]", border: "border-[#b5e5cb]", key: "text-[#1a7a45]", dot: "bg-[#22a85e]" },
  "止盈":       { bg: "bg-[#f0f9f4]", border: "border-[#b5e5cb]", key: "text-[#1a7a45]",  dot: "bg-[#22a85e]" },
  "动态风控":   { bg: "bg-[#fff8ed]", border: "border-[#f5d4a0]", key: "text-[#9a5500]",  dot: "bg-[#d97706]" },
  "止损":       { bg: "bg-[#fff8ed]", border: "border-[#f5d4a0]", key: "text-[#9a5500]",  dot: "bg-[#d97706]" },
  "强制退出":   { bg: "bg-[#fff0f0]", border: "border-[#f5b8b8]", key: "text-[#c0392b]",  dot: "bg-[#e74c3c]" },
  "禁止":       { bg: "bg-[#fff0f0]", border: "border-[#f5b8b8]", key: "text-[#c0392b]",  dot: "bg-[#e74c3c]" },
};
const DEFAULT_THEME = { bg: "bg-[#f9f7ff]", border: "border-[#ddd8f0]", key: "text-[#6b5fa0]", dot: "bg-[#9b8fd4]" };

/* ============ 新增策略弹窗 ============ */
function AddStrategyModal({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const [env, setEnv] = useState("trend");
  const [tag, setTag] = useState("突破单");
  function submit() {
    if (!name.trim()) return;
    onAdd({ id: `custom-${uid()}`, env, name: name.trim(), tag, fields: [["核心逻辑", ""]], userImages: [] });
    onClose();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-80 rounded-xl border border-[#e4ddf7] bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-sm font-semibold text-[#2d2054]">新增策略</h3>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-[#6b6b8a]">策略名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="mt-1 field w-full" placeholder="例：EMA20 回测" autoFocus />
          </label>
          <label className="block">
            <span className="text-xs text-[#6b6b8a]">环境</span>
            <select value={env} onChange={(e) => setEnv(e.target.value)} className="mt-1 field w-full">
              {ENVS.map((e) => <option key={e.k} value={e.k}>{e.t}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-[#6b6b8a]">标签</span>
            <input value={tag} onChange={(e) => setTag(e.target.value)} className="mt-1 field w-full" placeholder="例：突破单" />
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={submit} className="flex-1 rounded-lg bg-[#6d44d9] py-2 text-xs text-white hover:bg-[#5d35c6]">创建</button>
          <button onClick={onClose} className="flex-1 rounded-lg border border-[#e4ddf7] py-2 text-xs text-[#6b6b8a] hover:bg-[#f0ecff]">取消</button>
        </div>
      </div>
    </div>
  );
}

/* ============ 策略详情 + 编辑面板 ============ */
function StrategyDetailPanel({ strategy, setState, onClose }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [thumbs, setThumbs] = useState({});
  const [lightbox, setLightbox] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  const phase = PHASES[strategy.id];
  const envObj = ENVS.find((e) => e.k === strategy.env);
  const staticImgs = STRATEGY_IMAGES[strategy.id] || [];
  const userImages = strategy.userImages || [];

  // 加载用户上传图片的 data URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      for (const img of userImages) next[img.name] = await imageDataUrl(img).catch(() => "");
      if (!cancelled) setThumbs(next);
    })();
    return () => { cancelled = true; };
  }, [userImages.length, strategy.id]); // eslint-disable-line

  function patchStrategy(updater) {
    setState((s) => ({ ...s, strategies: s.strategies.map((st) => st.id === strategy.id ? updater(st) : st) }));
  }

  function startEdit() {
    setDraft({ ...strategy, fields: strategy.fields.map(([k, v]) => [k, v]) });
    setEditing(true);
  }
  function saveDraft() {
    setState((s) => ({ ...s, strategies: s.strategies.map((st) => st.id === draft.id ? { ...st, ...draft } : st) }));
    setEditing(false);
    setDraft(null);
  }
  function cancelEdit() { setEditing(false); setDraft(null); }

  function deleteStrategy() {
    setState((s) => ({ ...s, strategies: s.strategies.filter((st) => st.id !== strategy.id) }));
    onClose();
  }

  async function addImages(fileList) {
    const saved = [];
    for (const file of [...(fileList || [])]) {
      if (!file.type?.startsWith("image/")) continue;
      const record = await saveImage(file);
      saved.push({ ...record, mediaType: file.type || "image/png" });
    }
    if (saved.length) patchStrategy((st) => ({ ...st, userImages: [...(st.userImages || []), ...saved] }));
  }
  function removeUserImage(name) { patchStrategy((st) => ({ ...st, userImages: (st.userImages || []).filter((img) => img.name !== name) })); }

  const cur = editing ? draft : strategy;

  return (
    <div className="flex flex-col rounded-xl border border-[#e4ddf7] bg-white shadow-sm overflow-hidden h-full">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-[#e4ddf7] bg-[#f5f1ff] px-5 py-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {editing ? (
              <select value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} className="text-xs border border-[#c9bfee] rounded px-1.5 py-0.5 bg-white outline-none">
                {ENVS.map((e) => <option key={e.k} value={e.k}>{e.t}</option>)}
              </select>
            ) : (
              <span className={`text-[11px] font-semibold ${envObj?.c || "text-neutral-500"}`}>{envObj?.t}</span>
            )}
            {phase && <><span className="text-[11px] text-neutral-400">·</span><span className="text-[11px] text-neutral-500">{phase.ph}</span></>}
          </div>
          {editing
            ? <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="text-base font-bold text-[#2d2054] bg-transparent border-b-2 border-[#6d44d9] outline-none w-full" />
            : <h2 className="text-base font-bold text-[#2d2054]">{strategy.name}</h2>}
          <div className="mt-1">
            {editing
              ? <input value={draft.tag} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} className="text-[11px] border border-[#c9bfee] rounded-full px-2 py-0.5 bg-white outline-none text-[#6d44d9]" />
              : <span className="inline-block rounded-full border border-[#c9bfee] bg-[#efeafd] px-2.5 py-0.5 text-[11px] text-[#6d44d9]">{strategy.tag}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {editing ? (
            <>
              <button onClick={saveDraft} className="rounded-lg border border-[#6d44d9] bg-[#6d44d9] px-3 py-1.5 text-xs text-white hover:bg-[#5d35c6]">保存</button>
              <button onClick={cancelEdit} className="rounded-lg border border-[#e4ddf7] px-3 py-1.5 text-xs text-[#6b6b8a] hover:bg-[#f0ecff]">取消</button>
            </>
          ) : (
            <button onClick={startEdit} className="rounded-lg border border-[#c9bfee] bg-white px-3 py-1.5 text-xs text-[#6d44d9] hover:bg-[#efeafd]">✏️ 编辑</button>
          )}
          <button onClick={onClose} className="rounded-lg p-1.5 text-neutral-400 hover:bg-[#e4ddf7]"><Ic n="x" s={16} /></button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {editing ? (
          <>
            {draft.fields.map(([key, value], i) => {
              const t = FIELD_THEME[key] || DEFAULT_THEME;
              return (
                <div key={i} className={`rounded-lg border ${t.border} ${t.bg} overflow-hidden`}>
                  <div className={`flex items-center gap-2 border-b ${t.border} px-3 py-1.5`}>
                    <span className={`h-2 w-2 rounded-full flex-shrink-0 ${t.dot}`} />
                    <input
                      value={key}
                      onChange={(e) => { const f = draft.fields.map((x, j) => j === i ? [e.target.value, x[1]] : x); setDraft({ ...draft, fields: f }); }}
                      className={`flex-1 text-xs font-semibold tracking-wide bg-transparent outline-none ${t.key}`}
                      placeholder="字段名称"
                    />
                    <button onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })} className="text-neutral-400 hover:text-red-500 flex-shrink-0"><Ic n="x" s={13} /></button>
                  </div>
                  <textarea
                    value={value}
                    onChange={(e) => { const f = draft.fields.map((x, j) => j === i ? [x[0], e.target.value] : x); setDraft({ ...draft, fields: f }); }}
                    rows={4}
                    className="w-full px-3 py-2.5 text-[13px] leading-relaxed text-[#2d2054] bg-transparent outline-none resize-y"
                    placeholder="填写内容..."
                  />
                </div>
              );
            })}
            <button onClick={() => setDraft({ ...draft, fields: [...draft.fields, ["", ""]] })} className="w-full rounded-lg border-2 border-dashed border-[#c9bfee] py-2 text-xs text-[#6d44d9] hover:bg-[#f5f0ff]">
              + 添加字段
            </button>
            <div className="mt-2 border-t border-red-100 pt-3">
              {confirmDel
                ? <div className="flex items-center gap-2">
                    <span className="text-xs text-red-600">确定删除？</span>
                    <button onClick={deleteStrategy} className="rounded px-2 py-1 text-xs bg-red-500 text-white">确认</button>
                    <button onClick={() => setConfirmDel(false)} className="rounded px-2 py-1 text-xs text-neutral-500">取消</button>
                  </div>
                : <button onClick={() => setConfirmDel(true)} className="text-xs text-red-400 hover:text-red-600">删除此策略…</button>}
            </div>
          </>
        ) : (
          strategy.fields.map(([key, value], i) => {
            const t = FIELD_THEME[key] || DEFAULT_THEME;
            return (
              <div key={i} className={`rounded-lg border ${t.border} ${t.bg} overflow-hidden`}>
                <div className={`flex items-center gap-2 border-b ${t.border} px-3 py-2`}>
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${t.dot}`} />
                  <span className={`text-xs font-semibold tracking-wide ${t.key}`}>{key}</span>
                </div>
                <div className="px-3 py-2.5 text-[13px] leading-relaxed text-[#2d2054] whitespace-pre-wrap">{value}</div>
              </div>
            );
          })
        )}

        {/* 图片区（始终显示，可上传） */}
        <div className="mt-1 pt-2 border-t border-[#e4ddf7]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#6d44d9]" />
              <span className="text-xs font-semibold text-[#5f3bc6] tracking-wide">示意图 / 案例</span>
            </div>
            <label className="cursor-pointer rounded-md border border-[#c9bfee] bg-white px-2 py-1 text-[11px] text-[#6d44d9] hover:bg-[#efeafd]">
              + 上传图片
              <input className="hidden" type="file" accept="image/*" multiple onChange={(e) => { addImages(e.target.files); e.target.value = ""; }} />
            </label>
          </div>

          {/* PDF 静态图 */}
          {staticImgs.map((src, i) => (
            <div key={`static-${i}`} className="mb-3 overflow-hidden rounded-lg border border-[#e4ddf7] bg-white shadow-sm">
              <img src={src} alt={`案例图 ${i + 1}`} className="w-full object-contain cursor-zoom-in" style={{ maxHeight: "420px" }} onClick={() => setLightbox(src)} />
            </div>
          ))}

          {/* 用户上传图 */}
          {userImages.map((img) => (
            <div key={img.name} className="relative mb-3 group">
              {thumbs[img.name]
                ? <img src={thumbs[img.name]} alt={img.name} className="w-full rounded-lg border border-[#e4ddf7] object-contain cursor-zoom-in" style={{ maxHeight: "420px" }} onClick={() => setLightbox(thumbs[img.name])} />
                : <div className="h-24 rounded-lg border border-[#e4ddf7] grid place-items-center text-xs text-neutral-400">加载中…</div>}
              <button onClick={() => removeUserImage(img.name)} className="absolute right-2 top-2 hidden group-hover:flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white shadow">
                <Ic n="x" s={12} />
              </button>
            </div>
          ))}

          {/* 拖放上传区 */}
          <div
            className={`rounded-lg border-2 border-dashed py-4 text-center transition ${dragOver ? "border-[#6d44d9] bg-[#f3edff]" : "border-[#e4ddf7] bg-[#faf8ff]"}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addImages(e.dataTransfer?.files); }}
          >
            <p className="text-xs text-[#9b8fd4]">拖入图片，或点击右上角 + 上传</p>
          </div>
        </div>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 cursor-zoom-out overflow-auto bg-black/80 p-6" onClick={() => setLightbox("")}>
          <img src={lightbox} alt="大图" className="mx-auto w-full max-w-5xl rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}

function StrategyLibrary({ state, setState }) {
  const [showNotes, setShowNotes] = useState(true);
  const [openStrat, setOpenStrat] = useState(null);
  const [activeNoteTab, setActiveNoteTab] = useState("channel");
  const [noteInput, setNoteInput] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);

  const strategies = state.strategies || STRATEGIES.map((s) => ({ ...s, userImages: [] }));
  const selectedStrategy = strategies.find((s) => s.id === openStrat);

  function addNote() {
    const text = noteInput.trim();
    if (!text) return;
    setState((s) => ({ ...s, notes: { ...s.notes, [activeNoteTab]: [...(s.notes[activeNoteTab] || []), text] } }));
    setNoteInput("");
  }

  function deleteNote(index) {
    setState((s) => {
      const next = [...(s.notes[activeNoteTab] || [])];
      next.splice(index, 1);
      return { ...s, notes: { ...s.notes, [activeNoteTab]: next } };
    });
  }

  function addStrategy(newStrat) {
    setState((s) => ({ ...s, strategies: [...(s.strategies || []), newStrat] }));
    setOpenStrat(newStrat.id);
  }

  return (
    <Page title="PA 策略库" subtitle="点击左侧策略卡片查看详情，支持编辑文字和图片。">
      {/* Main: left list + right detail */}
      <div className="mb-5 flex gap-4 min-h-[580px]">
        {/* Left: strategy list */}
        <div className="w-[260px] flex-shrink-0 flex flex-col space-y-4 overflow-y-auto pr-1">
          {ENVS.map((env) => <StrategyColumn key={env.k} env={env} strategies={strategies} openStrat={openStrat} setOpenStrat={setOpenStrat} />)}
          <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-700">
            <span className="font-semibold">⚡ 命脉：</span>强趋势K + 跟随K 真突破 → 无条件离场
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="w-full rounded-lg border-2 border-dashed border-[#c9bfee] py-2.5 text-xs text-[#6d44d9] hover:bg-[#f5f0ff] transition"
          >
            + 新增策略
          </button>
        </div>

        {/* Right: detail panel or placeholder */}
        <div className="flex-1 min-w-0">
          {selectedStrategy ? (
            <StrategyDetailPanel
              key={selectedStrategy.id}
              strategy={selectedStrategy}
              setState={setState}
              onClose={() => setOpenStrat(null)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-[#c9bfee] bg-[#faf8ff] text-center">
              <Ic n="book" s={32} cls="text-[#c9bfee] mb-3" />
              <p className="text-sm text-[#9b8fd4]">点击左侧任意策略</p>
              <p className="text-xs text-[#c9bfee] mt-1">查看并编辑规则、图片</p>
            </div>
          )}
        </div>
      </div>

      {/* Notes section */}
      <Accordion title="开单前 · 各环境注意事项" icon={<Ic n="alert" s={15} cls="text-amber-400" />} open={showNotes} setOpen={setShowNotes}>
        <div className="mb-3 flex gap-2">
          {ENVS.map((env) => <button key={env.k} onClick={() => setActiveNoteTab(env.k)} className={`rounded-md border px-3 py-1.5 text-xs ${activeNoteTab === env.k ? `border-[#6d44d9] bg-[#efeafd] ${env.c}` : "border-[#e4ddf7] bg-white text-[#6b5fa0] hover:border-[#c9bfee]"}`}>{env.t}</button>)}
        </div>
        <div className="space-y-1.5">
          {(state.notes[activeNoteTab] || []).map((txt, i) => (
            <div key={`${txt}-${i}`} className="flex items-start gap-2 rounded-md border border-[#e4ddf7] bg-[#faf8ff] px-3 py-2">
              <span className="flex-1 text-xs leading-relaxed text-[#2d2054]">{txt}</span>
              <button onClick={() => deleteNote(i)} className="mt-0.5 shrink-0 text-neutral-400 hover:text-red-400"><Ic n="x" s={13} /></button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input className="field flex-1 text-sm" placeholder="加一条开单前注意事项..." value={noteInput} onChange={(e) => setNoteInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
          <button onClick={addNote} className="whitespace-nowrap rounded-md bg-[#6d44d9] px-3 py-2 text-xs text-white hover:bg-[#5d35c6]">添加</button>
        </div>
      </Accordion>

      {showAddModal && <AddStrategyModal onAdd={addStrategy} onClose={() => setShowAddModal(false)} />}
    </Page>
  );
}

function Reports({ state, allStats }) {
  const byStrategy = groupStats(state.trades, (t) => t.strategy || "未标注策略", true);
  const byEnv = groupStats(state.trades, (t) => envLabel(t.env || "none"));
  const byError = groupStats(state.trades, (t) => t.errorType || "未标注错误");
  const [tab, setTab] = useState("performance");
  const days = getTradingDays(state.trades);

  return (
    <Page title="数据报告" subtitle="按表现、概览、对比、日历和复盘洞察组织长期交易数据。">
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ["performance", "表现"],
          ["overview", "概览"],
          ["compare", "对比"],
          ["calendar", "日历"],
          ["recaps", "复盘洞察"],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`rounded-md border px-3 py-2 text-xs ${tab === id ? "border-[#6d44d9] bg-[#efeafd] text-[#5f3bc6]" : "border-neutral-800 bg-white text-neutral-500 hover:border-neutral-600"}`}>{label}</button>
        ))}
      </div>
      <MetricGrid stats={allStats} prefix="长期" />
      {tab === "performance" && (
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <GroupTable title="按策略" rows={byStrategy} />
          <GroupTable title="按环境" rows={byEnv} />
          <GroupTable title="按错误类型" rows={byError} />
        </div>
      )}
      {tab === "overview" && (
        <div className="mt-5 grid grid-cols-[1fr_340px] gap-4">
          <Panel title="累计净盈亏"><EquityChart curve={allStats.curve} /></Panel>
          <Panel title="月度日历"><CalendarHeatmap trades={state.trades} /></Panel>
        </div>
      )}
      {tab === "compare" && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <GroupTable title="策略表现对比" rows={byStrategy} />
          <GroupTable title="错误类型损耗" rows={byError} />
        </div>
      )}
      {tab === "calendar" && (
        <Panel title="按日净盈亏" className="mt-5">
          <CalendarHeatmap trades={state.trades} />
          <div className="mt-4 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {days.slice(0, 12).map((day) => <DailyTile key={day.date} day={day} />)}
          </div>
        </Panel>
      )}
      {tab === "recaps" && (
        <Panel title="复盘洞察" className="mt-5">
          <div className="space-y-3">
            {days.slice(0, 8).map((day) => <DailyInsight key={day.date} day={day} review={state.dailyReviews[day.date]} />)}
            {!days.length && <p className="text-xs text-neutral-600">导入交易后，这里会按交易日生成复盘入口，后期由 AI 自动补充洞察。</p>}
          </div>
        </Panel>
      )}
    </Page>
  );
}

function Notebook({ state, setState }) {
  const [folder, setFolder] = useState("all");
  const [query, setQuery] = useState("");
  const notes = buildNotebookNotes(state);
  const filtered = notes.filter((note) => {
    const byFolder = folder === "all" || note.folder === folder || (folder === "favorites" && note.favorite);
    const text = `${note.title} ${note.body}`.toLowerCase();
    return byFolder && text.includes(query.toLowerCase());
  });
  const [selectedId, setSelectedId] = useState("");
  const active = filtered.find((note) => note.id === selectedId) || filtered[0] || notes[0];

  function addNote() {
    const note = { id: `note-${uid()}`, title: "未命名笔记", body: "", folder: "我的笔记", favorite: false, createdAt: today() };
    setState((s) => ({ ...s, notebook: [note, ...(s.notebook || [])] }));
    setFolder("我的笔记");
    setSelectedId(note.id);
  }

  function updateActive(patch) {
    if (!active) return;
    if (active.kind === "custom") {
      setState((s) => ({ ...s, notebook: (s.notebook || []).map((note) => note.id === active.sourceId ? { ...note, ...patch } : note) }));
    }
    if (active.kind === "trade" && patch.body !== undefined) {
      setState((s) => ({ ...s, journal: { ...s.journal, [active.sourceId]: { ...(s.journal[active.sourceId] || {}), note: patch.body } } }));
    }
    if (active.kind === "daily" && patch.body !== undefined) {
      setState((s) => ({ ...s, dailyReviews: { ...s.dailyReviews, [active.sourceId]: { ...(s.dailyReviews[active.sourceId] || {}), lesson: patch.body } } }));
    }
  }

  const folders = [
    ["all", "全部笔记"],
    ["favorites", "收藏"],
    ["逐笔笔记", "逐笔笔记"],
    ["每日复盘", "每日复盘"],
    ["时段总结", "时段总结"],
    ["我的笔记", "我的笔记"],
    ["标签", "标签"],
    ["回收站", "回收站"],
  ];

  return (
    <Page title="笔记本" subtitle="把逐笔交易笔记、每日复盘、时段总结和你自己的笔记统一放到一个地方。">
      <div className="grid grid-cols-[230px_300px_1fr] gap-4">
        <Panel title="文件夹">
          <button onClick={addNote} className="mb-3 w-full rounded-md bg-[#6d44d9] px-3 py-2 text-xs text-white hover:bg-[#5d35c6]">新建笔记</button>
          <div className="space-y-1">
            {folders.map(([id, label]) => (
              <button key={id} onClick={() => setFolder(id)} className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs ${folder === id ? "bg-[#efeafd] text-[#5f3bc6]" : "text-neutral-500 hover:bg-[#f4f1fb]"}`}>
                <span>{label}</span><span>{id === "all" ? notes.length : notes.filter((n) => n.folder === id || (id === "favorites" && n.favorite)).length}</span>
              </button>
            ))}
          </div>
        </Panel>
        <Panel title="笔记">
          <input className="field mb-3 text-xs" placeholder="搜索笔记" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="max-h-[640px] space-y-2 overflow-auto pr-1">
            {filtered.map((note) => (
              <button key={note.id} onClick={() => setSelectedId(note.id)} className={`w-full rounded-md border px-3 py-2 text-left ${active?.id === note.id ? "border-[#6d44d9] bg-[#efeafd]" : "border-neutral-800 bg-white hover:border-neutral-600"}`}>
                <div className="truncate text-xs font-medium text-neutral-200">{note.title}</div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-neutral-500">{note.body || "暂无内容"}</div>
                <div className="mt-2 text-[10px] text-neutral-600">{note.folder}</div>
              </button>
            ))}
            {!filtered.length && <p className="text-xs text-neutral-600">没有匹配的笔记。</p>}
          </div>
        </Panel>
        <Panel title={active?.folder || "查看器"}>
          {active ? (
            <div className="space-y-3">
              <input className="field text-base font-medium" value={active.title} onChange={(e) => updateActive({ title: e.target.value })} readOnly={active.kind !== "custom"} />
              <div className="flex flex-wrap gap-2 text-[11px] text-neutral-500">
                <span className="rounded border border-neutral-800 px-2 py-1">{active.kind}</span>
                <span className="rounded border border-neutral-800 px-2 py-1">{active.createdAt || "local"}</span>
              </div>
              <textarea className="field min-h-[420px] resize-y text-sm leading-relaxed" value={active.body} onChange={(e) => updateActive({ body: e.target.value })} placeholder="写下你的复盘、会话总结、策略备注..." />
              {active.kind !== "custom" && <p className="text-xs text-neutral-600">这条笔记来自交易或每日复盘，编辑正文会同步回对应记录。</p>}
            </div>
          ) : <p className="text-xs text-neutral-600">创建或选择一条笔记。</p>}
        </Panel>
      </div>
    </Page>
  );
}

function ProgressTracker({ state, setState }) {
  const rows = progressRuleRows(state);
  const score = rows.length ? Math.round(rows.reduce((acc, row) => acc + row.followRate, 0) / rows.length) : 0;
  const done = state.tasks.filter((task) => task.done).length;

  return (
    <Page title="进步追踪" subtitle="按纪律追踪逻辑：今天做没做、规则守没守、长期表现有没有改善。">
      <div className="mb-4 grid gap-4 md:grid-cols-4">
        <Panel title="当前连胜"><div className="text-3xl text-[#6d44d9]">{winningStreak(getTradingDays(state.trades))}</div><p className="text-xs text-neutral-600">连续盈利交易日</p></Panel>
        <Panel title="当前评分"><div className="text-3xl text-[#6d44d9]">{score}%</div><p className="text-xs text-neutral-600">规则执行均值</p></Panel>
        <Panel title="今日进度"><div className="text-3xl text-[#6d44d9]">{done}/{state.tasks.length}</div><p className="text-xs text-neutral-600">每日清单</p></Panel>
        <Panel title="策略绑定"><div className="text-3xl text-[#6d44d9]">{fmt(ruleRate(state.trades, (t) => t.strategy), 0)}%</div><p className="text-xs text-neutral-600">交易绑定策略比例</p></Panel>
      </div>
      <div className="grid grid-cols-[1fr_340px] gap-4">
        <Panel title="当前规则">
          <table className="w-full text-left text-xs">
            <thead className="text-neutral-500"><tr><th className="py-2 font-medium">规则</th><th className="py-2 font-medium">条件</th><th className="py-2 font-medium">执行次数</th><th className="py-2 font-medium">平均表现</th><th className="py-2 font-medium">遵守率</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.rule} className="border-t border-neutral-800"><td className="py-2 text-neutral-200">{row.rule}</td><td className="py-2 text-neutral-500">{row.condition}</td><td className="py-2">{row.streak}</td><td className={`py-2 ${row.avg >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(row.avg)}</td><td className="py-2">{fmt(row.followRate, 0)}%</td></tr>)}</tbody>
          </table>
        </Panel>
        <Panel title="每日清单">
          <TaskBoard state={state} setState={setState} />
        </Panel>
      </div>
      <Panel title="进步热力图" className="mt-4">
        <CalendarHeatmap trades={state.trades} />
      </Panel>
    </Page>
  );
}

function TradeReplay({ state, selectedDate, setSelectedDate }) {
  const days = getTradingDays(state.trades);
  const trades = state.trades.filter((trade) => tradeDate(trade) === selectedDate);
  return (
    <Page title="交易回放" subtitle="先把复盘回放的入口和数据结构放好：选择日期，按交易顺序复盘入场、出场、结果和笔记。">
      <div className="grid grid-cols-[280px_1fr] gap-4">
        <Panel title="回放日期">
          <JournalDayList days={days} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />
        </Panel>
        <Panel title={`回放 ${selectedDate}`}>
          <div className="space-y-3">
            {trades.map((trade, index) => (
              <div key={trade.id} className="rounded-md border border-neutral-800 bg-white p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-neutral-200">#{index + 1} {trade.symbol || "—"} {trade.side || ""}</div>
                  <div className={num(trade.pnl) >= 0 ? "text-emerald-400" : "text-red-400"}>{fmt(num(trade.pnl))}</div>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2 text-xs text-neutral-500">
                  <span>入场 {trade.entry || "—"}</span>
                  <span>出场 {trade.exit || "—"}</span>
                  <span>{trade.entryTime || "—"}</span>
                  <span>{trade.exitTime || "—"}</span>
                </div>
                <div className="mt-2 text-xs text-neutral-500">策略：{strategyLabel(trade.strategy)} · 环境：{envLabel(trade.env)}</div>
              </div>
            ))}
            {!trades.length && <p className="text-xs text-neutral-600">这一天还没有可回放交易。</p>}
          </div>
        </Panel>
      </div>
    </Page>
  );
}

function Resources() {
  return (
    <Page title="资源库" subtitle="先放经济日历、交易规则和外部资料入口；后期再接 TradingView/日历数据源。">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="经济日历">
          <div className="space-y-2">
            {["CPI / PPI / PCE", "FOMC / Fed speakers", "NFP / Unemployment", "PMI / ISM", "Crude Oil Inventories"].map((item) => (
              <div key={item} className="flex items-center justify-between rounded-md border border-neutral-800 px-3 py-2 text-xs">
                <span>{item}</span><span className="text-neutral-600">手动标记风险日</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="交易资源">
          <div className="grid gap-2">
            {["PA 策略库", "Prop firm 规则", "Tradovate CSV 导出说明", "NotebookLM / IMA 知识库入口", "AI Prompt 模板"].map((item) => (
              <div key={item} className="rounded-md border border-neutral-800 bg-white px-3 py-2 text-xs text-neutral-400">{item}</div>
            ))}
          </div>
        </Panel>
      </div>
    </Page>
  );
}

function AgentConsole({ state, setState, selectedDate, dailyTrades, dayStats }) {
  const agent = state.agent || DEFAULT_STATE.agent;
  const setAgent = (patch) => setState((s) => ({ ...s, agent: { ...s.agent, ...patch } }));
  const setClaude = (patch) => setAgent({ claude: { ...agent.claude, ...patch } });
  const [testState, setTestState] = useState({ busy: false, msg: "" });

  const MODELS = [
    ["claude-sonnet-4-6", "Sonnet 4.6（推荐：看图复盘 + 翻译）"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5（便宜快速）"],
    ["claude-opus-4-8", "Opus 4.8（最强最贵）"],
  ];

  async function runTest() {
    setTestState({ busy: true, msg: "" });
    try {
      await testConnection(agent.claude);
      setTestState({ busy: false, msg: "✅ 连接成功，API Key 可用。" });
    } catch (e) {
      setTestState({ busy: false, msg: `❌ ${e.message}` });
    }
  }

  return (
    <Page title="AI Agent 控制台" subtitle="两个已接通的能力：① 每日复盘页的 AI Session Review（截图 + 数据 → Claude 复盘）；② Brooks 日报自动抓取 + 中文翻译。这里管理 API Key、模型和复盘 skill。">
      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Panel title="Claude API 配置">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">模型</span>
            <select className="field text-sm" value={agent.claude.model || DEFAULT_MODEL} onChange={(e) => setClaude({ model: e.target.value })}>
              {MODELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              {!MODELS.some(([v]) => v === (agent.claude.model || DEFAULT_MODEL)) && <option value={agent.claude.model}>{agent.claude.model}</option>}
            </select>
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-neutral-500">API Key（存在本机 data.json，不会上传到任何服务器；只发给 api.anthropic.com）</span>
            <input className="field text-sm" type="password" value={agent.claude.apiKey || ""} onChange={(e) => setClaude({ apiKey: e.target.value })} placeholder="sk-ant-..." />
          </label>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={runTest} disabled={testState.busy || !agent.claude.apiKey} className="rounded-md bg-[#6d44d9] px-4 py-2 text-xs font-semibold text-white hover:bg-[#5d35c6] disabled:opacity-50">
              {testState.busy ? "测试中..." : "测试连接"}
            </button>
            {testState.msg && <span className="text-xs text-neutral-500">{testState.msg}</span>}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">在 console.anthropic.com 创建 API Key。日常用量参考：一次截图复盘 ≈ $0.05-0.15，一篇 Brooks 全文翻译 ≈ $0.05-0.10（Sonnet）。</p>
        </Panel>

        <Panel title="今日 AI 上下文（发给 Claude 的数据预览）">
          <div className="grid gap-3 md:grid-cols-4">
            <MiniStat label="日期" value={selectedDate} cls="text-neutral-300" />
            <MiniStat label="交易数" value={dailyTrades.length} cls="text-neutral-300" />
            <MiniStat label="当日盈亏" value={fmt(dayStats.net)} cls={dayStats.net >= 0 ? "text-emerald-400" : "text-red-400"} />
            <MiniStat label="胜率" value={`${fmt(dayStats.winRate, 0)}%`} cls="text-neutral-300" />
          </div>
          <textarea className="field mt-3 min-h-40 text-xs" readOnly value={buildSessionReviewContext({ date: selectedDate, trades: dailyTrades, stats: dayStats, state })} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="复盘 Skill（system prompt，仿 TradeZella Session Review）">
          <textarea
            className="field min-h-72 text-xs leading-relaxed"
            value={agent.sessionReview.template || ""}
            onChange={(e) => setAgent({ sessionReview: { ...agent.sessionReview, template: e.target.value } })}
            placeholder={SESSION_REVIEW_SKILL}
          />
          <div className="mt-2 flex items-center gap-3">
            <button onClick={() => setAgent({ sessionReview: { ...agent.sessionReview, template: "" } })} className="rounded-md border border-[#e6e1ef] px-3 py-1.5 text-xs text-[#6f6680] hover:border-[#c9bfee]">恢复内置默认</button>
            <span className="text-[11px] text-neutral-500">{agent.sessionReview.template?.trim() ? "正在使用自定义模板" : "留空 = 使用上面灰色显示的内置 skill"}</span>
          </div>
        </Panel>

        <Panel title="Brooks 日报设置">
          <div className="space-y-3 text-xs text-neutral-600">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!state.brooks?.autoFetch} onChange={(e) => setState((s) => ({ ...s, brooks: { ...s.brooks, autoFetch: e.target.checked } }))} />
              打开 App 时自动检查新文章
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!state.brooks?.autoTranslate} onChange={(e) => setState((s) => ({ ...s, brooks: { ...s.brooks, autoTranslate: e.target.checked } }))} />
              抓到新文章后自动翻译成中文
            </label>
            <div className="rounded-md border border-[#ece8f2] bg-[#faf8ff] p-3 leading-relaxed">
              数据源：Brooks Trading Course「Emini &amp; Forex Daily Reports」公开 REST API。
              已缓存 {state.brooks?.posts?.length || 0} 篇 · 上次检查 {state.brooks?.lastChecked ? String(state.brooks.lastChecked).slice(0, 16).replace("T", " ") : "从未"}。
              最新一篇的内容也会作为市场背景，自动注入 AI Session Review。
            </div>
          </div>
        </Panel>
      </div>
    </Page>
  );
}

function Page({ title, subtitle, children, wide = false }) {
  return (
    <div className={`mx-auto ${wide ? "max-w-[1760px]" : "max-w-[1280px]"} px-8 py-7`}>
      <header className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-[#191622]">{title}</h2>
        {subtitle && <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-[#8d8699]">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}

function Panel({ title, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-[#e9e5f1] bg-white p-5 shadow-[0_1px_2px_rgba(27,18,43,0.05)] ${className}`}>
      {title && <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#262231] after:h-px after:flex-1 after:bg-[#f1edf7]">{title}</h3>}
      {children}
    </section>
  );
}

function MetricGrid({ stats, prefix = "", compact = false, row = false }) {
  const items = [
    ["净盈亏", fmt(stats.net), stats.net >= 0 ? "text-emerald-400" : "text-red-400"],
    ["胜率", `${fmt(stats.winRate, 1)}%`, stats.winRate >= 50 ? "text-emerald-400" : "text-amber-400"],
    ["盈亏因子", stats.pf === Infinity ? "∞" : fmt(stats.pf), stats.pf >= 1 ? "text-emerald-400" : "text-red-400"],
    ["平均 RR", fmt(stats.rr), "text-sky-400"],
    ["每笔期望", fmt(stats.expectancy), stats.expectancy >= 0 ? "text-emerald-400" : "text-red-400"],
    ["最大回撤", fmt(stats.maxDrawdown), "text-amber-400"],
    ["平均盈利", fmt(stats.avgWin), "text-emerald-400"],
    ["平均亏损", fmt(stats.avgLoss), "text-red-400"],
  ];
  const shown = compact ? items.slice(0, 4) : items;
  return <section className={`grid gap-3 ${compact ? "grid-cols-2" : row ? "grid-cols-4 min-[1500px]:grid-cols-8" : "grid-cols-2 md:grid-cols-4"}`}>{shown.map(([label, value, color]) => <div key={`${prefix}-${label}`} className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3"><div className="whitespace-nowrap text-xs text-neutral-500">{prefix}{label}</div><div className={`mt-1 truncate text-xl ${color}`}>{value}</div></div>)}</section>;
}

function DailyGuard({ state, setState }) {
  const [logAmt, setLogAmt] = useState("");
  const dailyLimit = parseFloat(state.settings.dailyLimit);
  const streakLimit = parseFloat(state.settings.streakLimit);
  const stopped = state.daily.pnl <= -dailyLimit || state.daily.streak >= streakLimit;
  const near = !stopped && state.daily.pnl <= -dailyLimit * 0.66;
  const setSetting = (key, value) => setState((prev) => ({ ...prev, settings: { ...prev.settings, [key]: value } }));
  const logResult = () => {
    const amount = parseFloat(logAmt);
    if (Number.isNaN(amount) || amount === 0) return;
    setState((prev) => ({ ...prev, daily: { date: today(), pnl: +(Number(prev.daily.pnl || 0) + amount).toFixed(2), streak: amount < 0 ? Number(prev.daily.streak || 0) + 1 : 0 } }));
    setLogAmt("");
  };

  return (
    <section className={`rounded-lg border p-4 ${stopped ? "border-red-700 bg-red-950/40" : near ? "border-amber-800 bg-amber-950/20" : "border-neutral-800 bg-neutral-900/50"}`}>
      <div className="mb-3 flex items-center gap-2 text-sm text-neutral-200"><Ic n="shield" s={15} cls={stopped ? "text-red-400" : near ? "text-amber-400" : "text-emerald-400"} /> 当日护栏 <span className="ml-auto text-xs text-neutral-600">{state.daily.date}</span></div>
      {stopped ? <Notice kind="stop" text="今日停手 — 关掉软件，不许再做一笔找回来。" /> : near ? <Notice kind="near" text="接近日损线，下一笔输了就到线。" /> : <Notice kind="ok" text="正常，可按计划交易。" />}
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <MiniStat label="当日盈亏" value={`${state.daily.pnl > 0 ? "+" : ""}${fmt(state.daily.pnl, 0)}`} cls={state.daily.pnl < 0 ? "text-red-400" : state.daily.pnl > 0 ? "text-emerald-400" : "text-neutral-300"} />
        <MiniStat label="连亏" value={`${state.daily.streak} / ${streakLimit}`} cls={state.daily.streak >= streakLimit ? "text-red-400" : state.daily.streak > 0 ? "text-amber-400" : "text-neutral-300"} />
        <MiniStat label="日损线" value={`-${fmt(dailyLimit, 0)}`} cls="text-neutral-300" />
      </div>
      <div className="flex items-center gap-2">
        <input className="field flex-1 text-sm" placeholder="记一笔结果（亏损填负数，如 -120）" value={logAmt} onChange={(e) => setLogAmt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && logResult()} />
        <button onClick={logResult} className="rounded-md bg-neutral-800 px-3 py-2 text-xs text-neutral-100 hover:bg-neutral-700">记录</button>
        <button onClick={() => setState((prev) => ({ ...prev, daily: { date: today(), pnl: 0, streak: 0 } }))} className="rounded-md border border-neutral-800 px-2 py-2 text-xs text-neutral-500 hover:text-neutral-300">清零</button>
      </div>
      <div className="mt-2 flex gap-3 text-xs text-neutral-600">
        <span>日损线 $<input className="w-12 border-b border-neutral-800 bg-transparent text-neutral-400 outline-none" value={state.settings.dailyLimit} onChange={(e) => setSetting("dailyLimit", e.target.value)} /></span>
        <span>连亏熔断 <input className="w-8 border-b border-neutral-800 bg-transparent text-neutral-400 outline-none" value={state.settings.streakLimit} onChange={(e) => setSetting("streakLimit", e.target.value)} /> 笔</span>
      </div>
    </section>
  );
}

function CsvImporter({ setState, compact = false, scanDownloads, openTradovate, autoImport }) {
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [parseError, setParseError] = useState("");
  const [template, setTemplate] = useState("");
  const [showManual, setShowManual] = useState(!scanDownloads);

  function loadCsvText(text) {
    setParseError("");
    const res = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) {
      setParseError("没解析到数据，确认粘贴的是带表头的 CSV。");
      return;
    }
    const nextHeaders = res.meta.fields || [];
    setHeaders(nextHeaders);
    setRows(res.data);
    setMapping(guessMap(nextHeaders));
    setTemplate(isPerformanceCsv(nextHeaders) ? "Tradovate Performance.csv" : "通用 CSV");
  }

  function parseCsv() {
    loadCsvText(csvText);
  }

  async function readFile(file) {
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    loadCsvText(text);
  }

  function rowToTrade(row, i) {
    if (isPerformanceCsv(headers)) return performanceRowToTrade(row, i);

    const entryTime = row[mapping.entryTime] ?? "";
    const exitTime = row[mapping.exitTime] ?? "";
    const date = row[mapping.date] || tradeDate({ entryTime, exitTime });
    return {
      id: `t-${uid()}-${i}`,
      date,
      symbol: row[mapping.symbol] ?? "—",
      side: row[mapping.side] ?? "",
      qty: row[mapping.qty] ?? "",
      entry: row[mapping.entry] ?? "",
      exit: row[mapping.exit] ?? "",
      entryTime,
      exitTime,
      pnl: row[mapping.pnl] ?? "",
      rr: row[mapping.rr] ?? "",
      env: "",
      strategy: "",
      errorType: "",
      emotion: "",
      followedPlan: "",
      forcedExit: "",
      source: "CSV",
      sourceId: "",
    };
  }

  function confirmImport() {
    let imported = rows.map(rowToTrade);
    if (isPerformanceCsv(headers)) imported = mergePerformanceTrades(imported);
    setState((s) => {
      const result = applyImportToTrades(s.trades, imported);
      return {
        ...s,
        trades: result.trades,
        tasks: s.tasks.map((task) => task.id === "import" ? { ...task, done: true } : task),
      };
    });
    setRows([]);
    setHeaders([]);
    setCsvText("");
    setMapping({});
    setTemplate("");
  }

  return (
    <section className={`${compact ? "mb-5" : "mb-5"} rounded-lg border border-emerald-900/60 bg-emerald-950/10 p-4`}>
      {scanDownloads && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[#dcd4ee] bg-[#faf8ff] px-3 py-2 text-xs text-[#6f6680]">
          <Ic n="refresh" s={13} cls="text-[#6d44d9]" />
          <span>一键导入：① 点按钮去 Tradovate 导出 Performance CSV → ② 切回 App 自动入库（去重 + 匹配手动记录）</span>
          {autoImport?.lastScan && <span className="text-[10px] text-neutral-400">上次扫描 {String(autoImport.lastScan).slice(5, 16).replace("T", " ")}</span>}
          <span className="ml-auto flex items-center gap-2">
            {openTradovate && <button onClick={openTradovate} className="rounded-md bg-[#6d44d9] px-3 py-1.5 font-semibold text-white hover:bg-[#5d35c6]">去 Tradovate 导出</button>}
            <button onClick={() => scanDownloads(true)} className="rounded-md border border-[#c9bfee] px-3 py-1.5 font-semibold text-[#6d44d9] hover:bg-[#f1edf9]">立即扫描</button>
          </span>
          <label className="flex w-full items-center gap-1.5 text-[11px] text-neutral-400">
            <input type="checkbox" checked={autoImport?.enabled !== false} onChange={(e) => setState((s) => ({ ...s, autoImport: { ...s.autoImport, enabled: e.target.checked } }))} />
            自动扫描（打开 App 时 + 从浏览器切回时）
          </label>
        </div>
      )}
      <button onClick={() => setShowManual(!showManual)} className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-[#6d44d9]">
        <Ic n={showManual ? "chevDown" : "chevRight"} s={13} /> 手动导入 CSV（粘贴 / 选文件，兼容其他来源）
      </button>
      {showManual && (<>
      <div className="mb-3 mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">支持直接选择 `Performance.csv`，也支持粘贴 Tradovate / Prop firm / TradingView 导出的 CSV。</p>
        <label className="whitespace-nowrap rounded-md bg-emerald-600 px-3 py-2 text-xs text-white hover:bg-emerald-500">
          选择 CSV 文件
          <input className="hidden" type="file" accept=".csv,text/csv" onChange={(e) => readFile(e.target.files?.[0])} />
        </label>
      </div>
      <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="也可以把 CSV 内容整段粘贴到这里（含表头那一行）..." className={`${compact ? "h-20" : "h-28"} w-full rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-300 outline-none focus:border-neutral-600`} />
      {parseError && <div className="mt-2 flex items-center gap-1 text-xs text-red-400"><Ic n="alert" s={13} /> {parseError}</div>}
      <button onClick={parseCsv} disabled={!csvText.trim()} className="mt-3 flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-40"><Ic n="file" s={14} /> 解析表头</button>
      </>)}
      {headers.length > 0 && (
        <div className="mt-5 border-t border-neutral-800 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm text-neutral-200">确认字段映射 <span className="text-xs text-neutral-500">已识别：{template}</span></div>
            <span className="text-xs text-neutral-500">{rows.length} 笔交易</span>
          </div>
          {!isPerformanceCsv(headers) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map(([key, label]) => <div key={key} className="flex items-center gap-2"><span className="w-20 shrink-0 text-xs text-neutral-400">{label}</span><select value={mapping[key] || ""} onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value }))} className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-300 outline-none focus:border-neutral-600"><option value="">— 无 —</option>{headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></div>)}
            </div>
          )}
          {isPerformanceCsv(headers) && (
            <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-400">
              这个文件会自动映射：`symbol` → 品种，`qty` → 手数，`buyPrice/sellPrice` → 出入场价格，`boughtTimestamp/soldTimestamp` → 出入场时间，`pnl` → 盈亏，并自动判断 Long / Short。
            </div>
          )}
          <button onClick={confirmImport} disabled={!isPerformanceCsv(headers) && !mapping.pnl} className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-40">确认导入，更新总览和每日复盘</button>
        </div>
      )}
    </section>
  );
}

function TaskBoard({ state, setState }) {
  return (
    <div className="space-y-2">
      {state.tasks.map((task) => (
        <label key={task.id} className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-300">
          <input type="checkbox" checked={task.done} onChange={(e) => setState((s) => ({ ...s, tasks: s.tasks.map((t) => t.id === task.id ? { ...t, done: e.target.checked } : t) }))} />
          <span className={task.done ? "text-neutral-600 line-through" : ""}>{task.text}</span>
        </label>
      ))}
      <button onClick={() => setState((s) => ({ ...s, tasks: s.tasks.map((t) => ({ ...t, done: false })) }))} className="text-xs text-neutral-500 hover:text-neutral-300">重置今日任务</button>
    </div>
  );
}

function DailySummary({ date, review, setState }) {
  const fields = [
    ["plan", "今日计划（开盘前：只允许的环境、关键位、若 A 则 B）"],
    ["summary", "当日总结（收盘后：执行质量、情绪、教训）"],
  ];
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2">
      {fields.map(([key, label]) => (
        <label key={key} className="block">
          <span className="mb-1 block text-xs text-neutral-500">{label}</span>
          <textarea className="field min-h-24 resize-y text-xs leading-relaxed" value={review[key] || ""} onChange={(e) => setState((s) => ({ ...s, dailyReviews: { ...s.dailyReviews, [date]: { ...(s.dailyReviews[date] || {}), [key]: e.target.value } } }))} />
        </label>
      ))}
    </div>
  );
}

function TradeCards({ trades, state, setState, grid = false, selectedDate }) {
  if (!trades.length) return <div className="text-xs text-neutral-600">这一天还没有交易。导入 CSV 或在交易记录里新增。</div>;
  return <div className={grid ? "grid gap-3 xl:grid-cols-2" : "space-y-3"}>{trades.map((trade) => <TradeCard key={trade.id} trade={trade} state={state} setState={setState} selectedDate={selectedDate} />)}</div>;
}

function TradeCard({ trade, state, setState, selectedDate }) {
  const pnl = num(trade.pnl);
  const journal = state.journal[trade.id] || {};
  const [confirmDel, setConfirmDel] = useState(false);

  // 拿了多少点（按方向算）+ 出入场时间，方便和 TradingView 截图对上
  const entryPrice = parseFloat(trade.entry);
  const exitPrice = parseFloat(trade.exit);
  const isShort = String(trade.side || "").toLowerCase().startsWith("s");
  const points = Number.isNaN(entryPrice) || Number.isNaN(exitPrice) ? null : (isShort ? entryPrice - exitPrice : exitPrice - entryPrice);
  const hhmm = (value) => {
    const d = parseDateTime(value);
    return d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
  };
  const timeRange = [hhmm(trade.entryTime), hhmm(trade.exitTime)].filter(Boolean).join("–");

  function removeTrade() {
    setState((s) => {
      const nextJournal = { ...s.journal };
      delete nextJournal[trade.id];
      return { ...s, trades: s.trades.filter((t) => t.id !== trade.id), journal: nextJournal };
    });
  }

  return (
    <article className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-medium text-neutral-100">{trade.symbol || "—"}</span>
          {trade.side && <span className="rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">{trade.side}</span>}
          {timeRange && <span className="rounded bg-[#eef4ff] px-1.5 py-0.5 text-xs font-semibold text-[#3b6fc9]">{timeRange}</span>}
          <span className="text-xs text-neutral-500">{trade.entry || "?"} → {trade.exit || "?"}</span>
          {points !== null && (
            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${points >= 0 ? "bg-[#e3f7ee] text-[#0e9f6e]" : "bg-[#fdecec] text-[#e5484d]"}`}>
              {points >= 0 ? "+" : ""}{fmt(points)} 点
            </span>
          )}
          {trade.source ? <span className="rounded bg-[#f1edf9] px-1.5 py-0.5 text-[10px] text-[#6d44d9]">CSV 导入</span> : <span className="rounded bg-[#fdf6e8] px-1.5 py-0.5 text-[10px] text-[#b45309]">手动录入</span>}
          {trade.mergedFills > 1 && <span className="rounded bg-[#eef4ff] px-1.5 py-0.5 text-[10px] text-[#3b6fc9]">{trade.mergedFills} 笔成交已合并 · {trade.qty} 手</span>}
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1 text-sm ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}><Ic n={pnl >= 0 ? "up" : "down"} s={14} />{fmt(pnl)}</div>
          {confirmDel ? (
            <span className="flex items-center gap-1.5">
              <button onClick={removeTrade} className="rounded-md bg-[#e5484d] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#c93d42]">确认删除</button>
              <button onClick={() => setConfirmDel(false)} className="rounded-md border border-[#e9e5f1] px-2.5 py-1 text-[11px] text-[#837b91]">取消</button>
            </span>
          ) : (
            <button onClick={() => setConfirmDel(true)} title="删除这笔交易" className="text-[#b9b1c8] hover:text-[#e5484d]"><Ic n="x" s={15} /></button>
          )}
        </div>
      </div>
      <TradeMetaEditor trade={trade} setState={setState} compact />
      <textarea value={journal.note || ""} onChange={(e) => setState((s) => ({ ...s, journal: { ...s.journal, [trade.id]: { ...(s.journal[trade.id] || {}), note: e.target.value } } }))} placeholder="我当时的想法：环境、时刻、策略、为什么进、止损、有没有守住强制退出..." className="mt-3 h-16 w-full rounded-md border border-neutral-800 bg-neutral-900 p-2.5 text-xs text-neutral-300 outline-none focus:border-neutral-600" />
      {selectedDate && <TradeScreenshots tradeId={trade.id} selectedDate={selectedDate} state={state} setState={setState} />}
    </article>
  );
}

/* ============ 每笔交易绑定截图（存到 dailyReviews[date].tradeImages[tradeId]） ============ */
function TradeScreenshots({ tradeId, selectedDate, state, setState }) {
  const images = state.dailyReviews[selectedDate]?.tradeImages?.[tradeId] || [];
  const [thumbs, setThumbs] = useState({});
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      for (const img of images) next[img.name] = await imageDataUrl(img).catch(() => "");
      if (!cancelled) setThumbs(next);
    })();
    return () => { cancelled = true; };
  }, [selectedDate, tradeId, images.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function patchImages(updater) {
    setState((s) => {
      const dr = s.dailyReviews[selectedDate] || {};
      const tm = dr.tradeImages || {};
      return { ...s, dailyReviews: { ...s.dailyReviews, [selectedDate]: { ...dr, tradeImages: { ...tm, [tradeId]: updater(tm[tradeId] || []) } } } };
    });
  }

  async function addFiles(fileList) {
    const saved = [];
    for (const file of [...(fileList || [])]) {
      if (!file.type?.startsWith("image/")) continue;
      const record = await saveImage(file);
      saved.push({ ...record, mediaType: file.type || "image/png" });
    }
    if (saved.length) patchImages((prev) => [...prev, ...saved]);
  }

  function removeImage(name) { patchImages((prev) => prev.filter((img) => img.name !== name)); }

  return (
    <div className="mt-3">
      <div
        data-trade-screenshots
        tabIndex={0}
        className={`rounded-md border border-dashed px-2 py-2 outline-none transition ${dragOver ? "border-[#6d44d9] bg-[#f3edff]" : "border-neutral-700 bg-neutral-900"} focus:border-[#8b6bde]`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer?.files); }}
        onPaste={(e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (files.length) { e.preventDefault(); e.stopPropagation(); addFiles(files); } }}
      >
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <Ic n="upload" s={12} cls="text-[#6d44d9] shrink-0" />
          <span>这笔的入场截图（点击后 ⌘V，或拖入）</span>
          <label className="ml-auto cursor-pointer text-[#8b6bde] underline shrink-0">
            添加
            <input className="hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        {images.length > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {images.map((img) => (
              <div key={img.name} className="group relative">
                {thumbs[img.name]
                  ? <img src={thumbs[img.name]} alt={img.name} onClick={() => setLightbox(thumbs[img.name])} className="w-full cursor-zoom-in rounded border border-neutral-700 transition hover:brightness-90" />
                  : <div className="grid h-24 place-items-center rounded border border-neutral-700 text-[10px] text-neutral-600">加载中</div>}
                <button onClick={() => removeImage(img.name)} className="absolute right-1 top-1 hidden h-5 w-5 rounded-full bg-[#ff6269] text-white shadow group-hover:grid place-items-center"><Ic n="x" s={11} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      {lightbox && (
        <div className="fixed inset-0 z-50 cursor-zoom-out overflow-auto bg-black/80 p-6" onClick={() => setLightbox("")}>
          <img src={lightbox} alt="screenshot" className="mx-auto w-full max-w-[1800px] rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}

const ERROR_TYPES = ["逆势抄底/摸顶", "追单（入场太晚）", "抢跑（没等信号K收线）", "没设止损/乱移止损", "提前止盈拿不住", "没守强制退出", "仓位过大", "过度交易", "计划外交易"];
const EMOTIONS = ["正常/专注", "FOMO 怕错过", "报复交易", "恐惧/不敢进", "贪婪/拿过头", "焦虑提前跑", "疲惫/分心"];

function TradeMetaEditor({ trade, setState, compact = false }) {
  const update = (patch) => setState((s) => ({ ...s, trades: s.trades.map((t) => t.id === trade.id ? { ...t, ...patch } : t) }));
  // 策略按环境分组（不受 trade.env 过滤，允许跨环境多选）
  const strategyGroups = ENVS.map((e) => ({
    label: e.t,
    options: STRATEGIES.filter((s) => s.env === e.k).map((s) => [s.id, s.name]),
  })).filter((g) => g.options.length > 0);
  const errorOptions = [["", "错误类型（没犯错留空）"], ...ERROR_TYPES.map((x) => [x, x]), ...(trade.errorType && !ERROR_TYPES.includes(trade.errorType) ? [[trade.errorType, trade.errorType]] : [])];
  const emotionOptions = [["", "情绪状态"], ...EMOTIONS.map((x) => [x, x]), ...(trade.emotion && !EMOTIONS.includes(trade.emotion) ? [[trade.emotion, trade.emotion]] : [])];

  // 策略多选：strategies 存为逗号分隔字符串
  const selectedStrategies = (trade.strategy || "").split(",").map((s) => s.trim()).filter(Boolean);
  function toggleStrategy(id) {
    const next = selectedStrategies.includes(id) ? selectedStrategies.filter((s) => s !== id) : [...selectedStrategies, id];
    update({ strategy: next.join(",") });
  }

  return (
    <div className={`mt-3 grid gap-2 ${compact ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-4"}`}>
      {!trade.sourceId && (
        <>
          <input className="field text-xs" placeholder="品种（如 MES）" value={trade.symbol === "—" ? "" : trade.symbol || ""} onChange={(e) => update({ symbol: e.target.value })} />
          <Select value={trade.side || ""} onChange={(v) => update({ side: v })} options={[["", "方向"], ["Long", "Long 做多"], ["Short", "Short 做空"]]} />
          <input className="field text-xs" placeholder="入场价（大概即可，用于匹配）" value={trade.entry || ""} onChange={(e) => update({ entry: e.target.value })} />
          <input className="field text-xs" placeholder="盈亏 $（用于匹配）" value={trade.pnl || ""} onChange={(e) => update({ pnl: e.target.value })} />
        </>
      )}
      <Select value={trade.env || ""} onChange={(v) => update({ env: v })} options={[["", "环境"], ...ENVS.map((e) => [e.k, e.t])]} />
      <MultiSelect
        groups={strategyGroups}
        selected={selectedStrategies}
        onToggle={toggleStrategy}
        placeholder="策略（可多选）"
      />
      <Select value={trade.followedPlan || ""} onChange={(v) => update({ followedPlan: v })} options={[["", "是否按计划"], ["yes", "按计划"], ["no", "未按计划"]]} />
      <Select value={trade.forcedExit || ""} onChange={(v) => update({ forcedExit: v })} options={[["", "强制退出"], ["kept", "守住"], ["missed", "没守住"], ["none", "未触发"]]} />
      <Select value={trade.errorType || ""} onChange={(v) => update({ errorType: v })} options={errorOptions} />
      <Select value={trade.emotion || ""} onChange={(v) => update({ emotion: v })} options={emotionOptions} />
      <input className="field text-xs" placeholder="RR" value={trade.rr || ""} onChange={(e) => update({ rr: e.target.value })} />
      <input className="field text-xs" placeholder="日期" value={trade.date || ""} onChange={(e) => update({ date: e.target.value })} />
    </div>
  );
}

function Select({ value, onChange, options }) {
  return <select className="field text-xs" value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>;
}

function MultiSelect({ options, groups, selected, onToggle, placeholder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  // 统一平铺选项用于展示已选标签
  const allOptions = groups ? groups.flatMap((g) => g.options) : (options || []);
  const label = selected.length === 0 ? placeholder : selected.map((id) => allOptions.find(([v]) => v === id)?.[1] || id).join("、");

  function renderOption([id, name]) {
    return (
      <label key={id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[#f5f1fd]">
        <input type="checkbox" checked={selected.includes(id)} onChange={() => onToggle(id)} className="accent-[#6d44d9]" />
        <span className={selected.includes(id) ? "font-medium text-[#5f3bc6]" : "text-[#3d3747]"}>{name}</span>
      </label>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className={`field flex w-full items-center justify-between gap-1 text-xs ${selected.length ? "text-[#262231]" : "text-[#9a93a6]"}`}>
        <span className="truncate">{label}</span>
        <Ic n="chevDown" s={13} cls="shrink-0 text-[#9a93a6]" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-full max-h-72 overflow-y-auto rounded-lg border border-[#e9e5f1] bg-white py-1 shadow-lg">
          {groups
            ? groups.map((g) => (
                <div key={g.label}>
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#9a93a6] bg-[#faf8ff]">{g.label}</div>
                  {g.options.map(renderOption)}
                </div>
              ))
            : allOptions.length === 0
              ? <div className="px-3 py-2 text-xs text-[#9a93a6]">无可用策略</div>
              : allOptions.map(renderOption)
          }
          {selected.length > 0 && (
            <button type="button" onClick={() => selected.forEach((id) => onToggle(id))} className="mt-1 w-full border-t border-[#f0edf7] px-3 py-1.5 text-left text-xs text-[#9a93a6] hover:text-[#e5484d]">清除选择</button>
          )}
        </div>
      )}
    </div>
  );
}

function TradeEditorTable({ state, setState }) {
  if (!state.trades.length) return <Panel title="空记录"><p className="text-xs text-neutral-600">先在每日复盘里导入 CSV，或点击新增交易。</p></Panel>;
  // 每张卡片传 selectedDate = 该笔交易的日期，这样截图区才会渲染
  return <div className="space-y-3">{state.trades.map((trade) => <TradeCard key={trade.id} trade={trade} state={state} setState={setState} selectedDate={tradeDate(trade)} />)}</div>;
}

function addManualTrade(setState, date) {
  const trade = { id: `manual-${uid()}`, date: date || today(), symbol: "", side: "", qty: "", entry: "", exit: "", entryTime: "", exitTime: "", pnl: "", rr: "", env: "", strategy: "", errorType: "", emotion: "", followedPlan: "", forcedExit: "", createdAt: new Date().toISOString() };
  setState((s) => ({ ...s, trades: [trade, ...s.trades] }));
}

function TradeTable({ trades }) {
  if (!trades.length) return <div className="text-xs text-neutral-600">暂无交易。</div>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-neutral-500"><tr>{["日期", "品种", "方向", "盈亏", "环境", "策略"].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}</tr></thead>
      <tbody>{trades.map((t) => <tr key={t.id} className="border-t border-neutral-800"><td className="px-2 py-2">{tradeDate(t)}</td><td className="px-2 py-2">{t.symbol || "—"}</td><td className="px-2 py-2">{t.side || "—"}</td><td className={`px-2 py-2 ${num(t.pnl) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(num(t.pnl))}</td><td className="px-2 py-2">{envLabel(t.env)}</td><td className="px-2 py-2">{strategyLabel(t.strategy)}</td></tr>)}</tbody>
    </table>
  );
}

function EquityChart({ curve }) {
  const points = curve.length ? curve : [{ index: 1, equity: 0 }];
  const max = Math.max(...points.map((p) => p.equity), 0);
  const min = Math.min(...points.map((p) => p.equity), 0);
  const span = max - min || 1;
  const width = 720;
  const height = 240;
  const line = points.map((p, i) => `${points.length === 1 ? 0 : (i / (points.length - 1)) * width},${height - ((p.equity - min) / span) * height}`).join(" ");
  return <svg className="h-64 w-full overflow-visible" viewBox={`0 0 ${width} ${height}`}><line x1="0" x2={width} y1={height - ((0 - min) / span) * height} y2={height - ((0 - min) / span) * height} stroke="#404040" /><polyline points={line} fill="none" stroke="#34d399" strokeWidth="3" /></svg>;
}

function CalendarHeatmap({ trades }) {
  const byDay = trades.reduce((acc, t) => {
    const d = tradeDate(t);
    acc[d] = (acc[d] || 0) + (Number.isNaN(num(t.pnl)) ? 0 : num(t.pnl));
    return acc;
  }, {});
  const days = Object.entries(byDay).sort(([a], [b]) => b.localeCompare(a)).slice(0, 28);
  if (!days.length) return <div className="text-xs text-neutral-600">导入交易后显示按日盈亏。</div>;
  return <div className="grid grid-cols-7 gap-2">{days.reverse().map(([day, pnl]) => <div key={day} className={`rounded-md border p-2 text-center ${pnl >= 0 ? "border-emerald-900 bg-emerald-950/40" : "border-red-900 bg-red-950/40"}`}><div className="text-[10px] text-neutral-500">{day.slice(5)}</div><div className={`text-xs ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(pnl, 0)}</div></div>)}</div>;
}

function JournalDayList({ days, selectedDate, setSelectedDate }) {
  if (!days.length) {
    return <div className="text-xs text-neutral-600">导入 CSV 后，这里会按日期列出 Daily Journal。</div>;
  }

  return (
    <div className="max-h-[520px] space-y-2 overflow-auto pr-1">
      {days.map((day) => (
        <button
          key={day.date}
          onClick={() => setSelectedDate(day.date)}
          className={`w-full rounded-md border px-3 py-2 text-left ${selectedDate === day.date ? "border-emerald-700 bg-emerald-950/30" : "border-neutral-800 bg-neutral-950 hover:border-neutral-700"}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-neutral-200">{day.date}</span>
            <span className={`text-xs ${day.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(day.pnl, 0)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-600">
            <span>{day.count} trades</span>
            <span>{fmt(day.winRate, 1)}% win</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function getTradingDays(trades) {
  const groups = trades.reduce((acc, trade) => {
    const date = tradeDate(trade);
    acc[date] = acc[date] || [];
    acc[date].push(trade);
    return acc;
  }, {});

  return Object.entries(groups)
    .map(([date, items]) => {
      const stats = calcStats(items);
      return { date, count: stats.count, pnl: stats.net, winRate: stats.winRate };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function ZellaScoreCard({ state, trades }) {
  const rows = progressRuleRows(state);
  const score = rows.length ? Math.round(rows.reduce((acc, row) => acc + row.followRate, 0) / rows.length) : 0;
  const stats = calcStats(trades);
  return (
    <div className="mb-3 rounded-md border border-[#e6e1ef] bg-[#fbf9ff] p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-neutral-500">Zella score</div>
          <div className="text-2xl text-[#6d44d9]">{score}%</div>
        </div>
        <div className="text-right text-[11px] leading-relaxed text-neutral-500">
          Profit factor <span className="text-neutral-200">{stats.pf === Infinity ? "∞" : fmt(stats.pf)}</span><br />
          Playbook link <span className="text-neutral-200">{fmt(ruleRate(trades, (t) => t.strategy), 0)}%</span>
        </div>
      </div>
    </div>
  );
}

function buildNotebookNotes(state) {
  const custom = (state.notebook || []).map((note) => ({ ...note, id: `custom-${note.id}`, sourceId: note.id, kind: "custom" }));
  const daily = Object.entries(state.dailyReviews || {}).map(([date, review]) => ({
    id: `daily-${date}`,
    sourceId: date,
    kind: "daily",
    folder: "每日复盘",
    title: `${date} 每日复盘`,
    body: [review.plan, review.summary, review.good, review.bad, review.lesson, review.ai].filter(Boolean).join("\n\n"),
    createdAt: date,
  }));
  const tradeNotes = state.trades
    .filter((trade) => state.journal?.[trade.id]?.note || trade.strategy || trade.errorType)
    .map((trade) => ({
      id: `trade-${trade.id}`,
      sourceId: trade.id,
      kind: "trade",
      folder: "逐笔笔记",
      title: `${tradeDate(trade)} ${trade.symbol || "Trade"} ${trade.side || ""}`.trim(),
      body: state.journal?.[trade.id]?.note || `策略：${strategyLabel(trade.strategy)}\n错误：${trade.errorType || "未标注"}`,
      createdAt: tradeDate(trade),
    }));
  const strategyNotes = ENVS.flatMap((env) => (state.notes?.[env.k] || []).map((body, index) => ({
    id: `strategy-${env.k}-${index}`,
    sourceId: `${env.k}-${index}`,
    kind: "strategy",
    folder: "标签",
    title: `${env.t} 注意事项`,
    body,
    createdAt: "PA library",
  })));
  const sessionRecaps = getTradingDays(state.trades).map((day) => ({
    id: `session-${day.date}`,
    sourceId: day.date,
    kind: "session",
    folder: "时段总结",
    title: `${day.date} 时段总结`,
    body: `${day.count} trades\nNet P&L: ${fmt(day.pnl)}\nWin rate: ${fmt(day.winRate, 1)}%`,
    createdAt: day.date,
  }));
  return [...custom, ...daily, ...tradeNotes, ...sessionRecaps, ...strategyNotes].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function DailyTile({ day }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-white p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-200">{day.date}</span>
        <span className={day.pnl >= 0 ? "text-emerald-400" : "text-red-400"}>{fmt(day.pnl)}</span>
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-neutral-500">
        <span>{day.count} trades</span>
        <span>{fmt(day.winRate, 1)}% win</span>
      </div>
    </div>
  );
}

function DailyInsight({ day, review }) {
  const text = review?.summary || review?.lesson || review?.bad || review?.good || "还没有写每日总结。";
  return (
    <div className="rounded-md border border-neutral-800 bg-white p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-200">{day.date}</span>
        <span className={day.pnl >= 0 ? "text-emerald-400" : "text-red-400"}>{fmt(day.pnl)}</span>
      </div>
      <p className="text-xs leading-relaxed text-neutral-500">{text}</p>
    </div>
  );
}

function progressRuleRows(state) {
  const trades = state.trades || [];
  const dailyLimit = Math.abs(num(state.settings?.dailyLimit || 0));
  const days = getTradingDays(trades);
  const stats = calcStats(trades);
  const planTasks = state.tasks || [];
  const taskRate = planTasks.length ? (planTasks.filter((task) => task.done).length / planTasks.length) * 100 : 0;
  const playbookRate = ruleRate(trades, (t) => t.strategy);
  const planRate = ruleRate(trades, (t) => t.followedPlan === "yes");
  const forcedExitRate = ruleRate(trades, (t) => t.forcedExit !== "missed");
  const dailyLossRate = days.length ? (days.filter((day) => !dailyLimit || day.pnl > -dailyLimit).length / days.length) * 100 : 0;
  return [
    { rule: "开盘前完成清单", condition: "每日任务完成", streak: `${planTasks.filter((task) => task.done).length}/${planTasks.length}`, avg: stats.expectancy, followRate: taskRate },
    { rule: "交易绑定策略", condition: "每笔交易绑定 PA 策略", streak: `${trades.filter((t) => t.strategy).length}/${trades.length || 0}`, avg: avgPnl(trades.filter((t) => t.strategy)), followRate: playbookRate },
    { rule: "按计划执行", condition: "标记为按计划", streak: `${trades.filter((t) => t.followedPlan === "yes").length}/${trades.length || 0}`, avg: avgPnl(trades.filter((t) => t.followedPlan === "yes")), followRate: planRate },
    { rule: "遵守强制退出", condition: "强制退出没有 missed", streak: `${trades.filter((t) => t.forcedExit !== "missed").length}/${trades.length || 0}`, avg: avgPnl(trades.filter((t) => t.forcedExit !== "missed")), followRate: forcedExitRate },
    { rule: "日内最大亏损", condition: `日亏损不超过 $${fmt(dailyLimit, 0)}`, streak: `${days.filter((day) => !dailyLimit || day.pnl > -dailyLimit).length}/${days.length}`, avg: stats.expectancy, followRate: dailyLossRate },
  ];
}

function ruleRate(items, predicate) {
  if (!items.length) return 0;
  return (items.filter((item) => Boolean(predicate(item))).length / items.length) * 100;
}

function avgPnl(trades) {
  const values = trades.map((trade) => num(trade.pnl)).filter((value) => !Number.isNaN(value));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function winningStreak(days) {
  let count = 0;
  for (const day of days) {
    if (day.pnl > 0) count += 1;
    else break;
  }
  return count;
}

function GroupTable({ title, rows }) {
  return <Panel title={title}><table className="w-full text-left text-xs"><thead className="text-neutral-500"><tr><th className="py-2 font-medium">名称</th><th className="py-2 font-medium">笔数</th><th className="py-2 font-medium">胜率</th><th className="py-2 font-medium">净盈亏</th></tr></thead><tbody>{rows.map((r) => <tr key={r.key} className="border-t border-neutral-800"><td className="py-2">{r.key}</td><td className="py-2">{r.stats.count}</td><td className="py-2">{fmt(r.stats.winRate, 1)}%</td><td className={`py-2 ${r.stats.net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(r.stats.net)}</td></tr>)}</tbody></table></Panel>;
}

function groupStats(trades, keyFn, multiKey = false) {
  const groups = {};
  trades.forEach((trade) => {
    if (multiKey) {
      // 多策略：按逗号分割后每个 key 都贡献
      const keys = (trade.strategy || "").split(",").map((s) => s.trim()).filter(Boolean);
      (keys.length ? keys : [keyFn(trade)]).forEach((k) => {
        (groups[k] = groups[k] || []).push(trade);
      });
    } else {
      const key = keyFn(trade);
      (groups[key] = groups[key] || []).push(trade);
    }
  });
  return Object.entries(groups).map(([key, items]) => ({ key, stats: calcStats(items) })).sort((a, b) => Math.abs(b.stats.net) - Math.abs(a.stats.net));
}

function Input({ label, value, onChange }) {
  return <label className="block"><span className="mb-1 block text-xs text-neutral-500">{label}</span><input className="field text-sm" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

function Notice({ kind, text }) {
  const styles = { stop: "border-red-700 bg-red-900/40 text-red-200", near: "border-amber-800 bg-amber-900/30 text-amber-200", ok: "border-neutral-800 bg-neutral-950 text-emerald-300" };
  return <div className={`mb-3 flex items-center gap-2 rounded-md border p-3 text-sm ${styles[kind]}`}><Ic n={kind === "stop" ? "ban" : kind === "near" ? "alert" : "activity"} s={16} />{text}</div>;
}

function MiniStat({ label, value, cls }) {
  return <div className="rounded-md border border-neutral-800 bg-neutral-950 py-2"><div className="text-xs text-neutral-500">{label}</div><div className={`text-base ${cls}`}>{value}</div></div>;
}

function Accordion({ title, icon, open, setOpen, children }) {
  return <section className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900/50"><button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-3"><span className="flex items-center gap-2 text-sm text-neutral-200">{icon}{title}</span><Ic n={open ? "chevDown" : "chevRight"} s={16} /></button>{open && <div className="px-4 pb-4">{children}</div>}</section>;
}

function StrategyColumn({ env, strategies, openStrat, setOpenStrat }) {
  const list = strategies.filter((s) => s.env === env.k).slice().sort((a, b) => {
    const pa = PHASES[a.id]?.pn ?? 999;
    const pb = PHASES[b.id]?.pn ?? 999;
    return pa - pb;
  });
  const groups = [];
  list.forEach((strategy) => {
    const phase = PHASES[strategy.id]?.ph || "自定义";
    const group = groups.find((item) => item.phase === phase);
    if (group) group.items.push(strategy);
    else groups.push({ phase, items: [strategy] });
  });

  return (
    <div>
      <div className={`mb-2 text-xs font-semibold ${env.c}`}>{env.t}</div>
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.phase}>
            <div className="mb-1 text-[10px] text-[#9b8fd4]">{group.phase}</div>
            <div className="space-y-1 border-l-2 border-[#e4ddf7] pl-2.5">
              {group.items.map((strategy) => {
                const active = openStrat === strategy.id;
                return (
                  <button
                    key={strategy.id}
                    onClick={() => setOpenStrat(active ? null : strategy.id)}
                    className={`flex w-full items-center justify-between gap-1.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      active
                        ? "border-[#6d44d9] bg-[#efeafd] shadow-sm"
                        : "border-[#e4ddf7] bg-white hover:border-[#c9bfee] hover:bg-[#faf8ff]"
                    }`}
                  >
                    <span className={`text-xs leading-tight ${active ? "text-[#5f3bc6] font-medium" : "text-[#2d2054]"}`}>{strategy.name}</span>
                    <span className={`whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] flex-shrink-0 ${active ? "border-[#c9bfee] text-[#6d44d9]" : "border-[#e4ddf7] text-neutral-400"}`}>{strategy.tag}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="text-[11px] text-neutral-400 pl-1">暂无策略</div>}
      </div>
    </div>
  );
}

function envLabel(value) {
  return ENVS.find((e) => e.k === value)?.t || "未标注环境";
}

function strategyLabel(value) {
  return STRATEGIES.find((s) => s.id === value)?.name || "未标注策略";
}
