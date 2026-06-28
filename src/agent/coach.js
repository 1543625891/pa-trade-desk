// 周度 / 月度 / 全量教练报告：汇总量化数据 + 日志文本 → Claude 模式提炼

import { STRATEGIES, ENVS } from "../data";

export const COACH_SYSTEM = `你是一名基于 Al Brooks 价格行为学的交易教练，专门做周度/月度复盘总结。
你拿到的是用户这段时间的完整量化数据（策略胜率、错误类型损耗、情绪相关性）+ 每日复盘文字。
你的任务是从这些数据里提炼模式，不是逐笔分析。

请严格按以下结构输出（中文，markdown，PA 术语保留英文）：

## 本期概览
2-3 句话：整体盈亏结论、交易质量评价（过程好不好，和结果分开说）、数据量是否够得出可信结论。

## 正在起效的（保留并扩大）
列 2-3 条，每条必须有数据支撑（如「通道回踩策略 8 笔 75% 胜率 +$420」）。这些是你的 edge，要继续做。

## 持续漏钱的（必须修）
列 2-3 条重复错误，注明出现次数和总损耗。如果同一个错误上周报告也出现过，标注「⚠️ 再次出现」。

## 情绪与执行
情绪状态分布和盈亏关系（如「FOMO 状态下 4 笔全亏 -$280」），1-2 条关键结论。

## 策略调整建议
不超过 2 条具体可操作的调整，必须基于数据。格式：「目前做法 → 建议调整 → 预期效果」。不要泛泛而谈。

## 下期只改一件事
唯一一条，是本期最高杠杆的改进。要说清楚怎么执行、怎么验证。

要求：样本不足 10 笔时，所有结论加「样本不足，仅供参考」；有上期报告时，检查上期「只改一件事」有没有被执行；诚实直接，不要客套。`;

const num = (v) => { const n = parseFloat(String(v || "").replace(/[$,()]/g, "").replace(/[^\d.-]/g, "")); return String(v).includes("(") ? -Math.abs(n) : n; };
const fmt = (v, d = 0) => Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = d.getUTCFullYear();
  const w = Math.ceil((((d - new Date(Date.UTC(y, 0, 1))) / 86400000) + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

export function periodKey(type, refDate = new Date()) {
  return type === "weekly" ? isoWeek(refDate) : `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, "0")}`;
}

export function periodLabel(key) {
  if (key.includes("W")) {
    const [y, w] = key.split("-W");
    return `${y} 年第 ${w} 周`;
  }
  const [y, m] = key.split("-");
  return `${y} 年 ${Number(m)} 月`;
}

function tradesInPeriod(trades, type, refDate) {
  const ref = refDate || new Date();
  return trades.filter((t) => {
    const d = new Date(t.date || "");
    if (Number.isNaN(d.getTime())) return false;
    if (type === "weekly") return isoWeek(d) === isoWeek(ref);
    return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
  });
}

function groupBy(items, keyFn) {
  const groups = {};
  items.forEach((item) => {
    const k = keyFn(item);
    (groups[k] = groups[k] || []).push(item);
  });
  return groups;
}

function strategyName(id) { return STRATEGIES.find((s) => s.id === id)?.name || "未绑定策略"; }

export function buildCoachContext({ trades, dailyReviews, type, refDate, lastReport }) {
  const ref = refDate || new Date();
  const periodTrades = tradesInPeriod(trades, type, ref);
  const closedTrades = periodTrades.filter((t) => !Number.isNaN(num(t.pnl)));
  const wins = closedTrades.filter((t) => num(t.pnl) > 0);
  const totalNet = closedTrades.reduce((acc, t) => acc + num(t.pnl), 0);
  const winRate = closedTrades.length ? (wins.length / closedTrades.length * 100) : 0;

  // 策略分组
  const byStrategy = groupBy(closedTrades, (t) => t.strategy || "__none__");
  const strategyTable = Object.entries(byStrategy).map(([id, items]) => {
    const w = items.filter((t) => num(t.pnl) > 0);
    const net = items.reduce((acc, t) => acc + num(t.pnl), 0);
    return `  - ${strategyName(id)}：${items.length} 笔，胜率 ${Math.round(w.length / items.length * 100)}%，净盈亏 $${fmt(net)}`;
  }).join("\n") || "  无数据";

  // 错误类型分组
  const withError = closedTrades.filter((t) => t.errorType);
  const byError = groupBy(withError, (t) => t.errorType);
  const errorTable = Object.entries(byError).map(([type, items]) => {
    const cost = items.reduce((acc, t) => acc + num(t.pnl), 0);
    return `  - ${type}：${items.length} 次，损耗 $${fmt(cost)}`;
  }).join("\n") || "  无标注错误类型的交易";

  // 情绪分组
  const withEmotion = closedTrades.filter((t) => t.emotion);
  const byEmotion = groupBy(withEmotion, (t) => t.emotion);
  const emotionTable = Object.entries(byEmotion).map(([emotion, items]) => {
    const net = items.reduce((acc, t) => acc + num(t.pnl), 0);
    const w = items.filter((t) => num(t.pnl) > 0);
    return `  - ${emotion}：${items.length} 笔，胜率 ${Math.round(w.length / items.length * 100)}%，净盈亏 $${fmt(net)}`;
  }).join("\n") || "  无标注情绪状态的交易";

  // 日志文字（当期每日计划+总结）
  const periodKey_ = periodKey(type, ref);
  const journalDays = Object.entries(dailyReviews || {})
    .filter(([date]) => {
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) return false;
      return type === "weekly" ? isoWeek(d) === isoWeek(ref) : d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
    })
    .sort(([a], [b]) => a.localeCompare(b));

  const journalText = journalDays.map(([date, r]) => {
    const parts = [];
    if (r.plan) parts.push(`计划: ${r.plan}`);
    if (r.summary || r.lesson) parts.push(`总结: ${r.summary || r.lesson}`);
    if (r.aiReview) parts.push(`AI复盘摘要: ${r.aiReview.slice(0, 300)}...`);
    return parts.length ? `【${date}】\n${parts.join("\n")}` : null;
  }).filter(Boolean).join("\n\n") || "本期无每日日志记录";

  const lines = [
    `# ${type === "weekly" ? "周度" : "月度"}教练报告 · ${periodLabel(periodKey_)}`,
    `## 本期量化数据`,
    `总交易笔数：${closedTrades.length}，净盈亏：$${fmt(totalNet)}，胜率：${fmt(winRate, 1)}%`,
    `其中按计划执行：${closedTrades.filter((t) => t.followedPlan === "yes").length} 笔，强制退出遗漏：${closedTrades.filter((t) => t.forcedExit === "missed").length} 笔`,
    `\n## 策略表现\n${strategyTable}`,
    `\n## 错误类型分布\n${errorTable}`,
    `\n## 情绪与盈亏\n${emotionTable}`,
    `\n## 当期每日日志\n${journalText}`,
  ];

  if (lastReport?.markdown) {
    lines.push(`\n## 上期报告的「只改一件事」\n${lastReport.markdown.split("## 下期只改一件事").pop()?.split("##")[0]?.trim() || "无法提取"}`);
  }

  lines.push("\n请基于以上数据生成本期教练报告。");
  return lines.join("\n");
}

/* ============ 全量深度分析 ============ */

export const DEEP_ANALYSIS_SYSTEM = `你是一名基于 Al Brooks 价格行为学的专业交易分析师。
你拿到的是用户所有历史交易的量化数据，任务是从中提炼出可操作的提升建议。

请严格按以下结构输出（中文，markdown，PA 术语保留英文）：

## 策略胜率排行
按胜率从高到低列出所有策略（格式：「策略名称：X 笔 · 胜率 Y% · 平均盈亏 $Z · 总盈亏 $W」）。
重点标注：胜率 ≥ 60% 标记为 ✅ 核心优势，胜率 < 40% 且样本 ≥ 5 笔标记为 ⚠️ 考虑减少。

## 最强 Edge（前 2-3 名策略）
逐一分析：这个策略为什么有效？在什么市场环境下触发？胜率高的可能原因是什么？

## 最大漏钱点
列出 2-3 个核心问题，每条必须有数据支撑（亏损金额、出现次数）。
优先级从高到低排。

## 持仓与执行模式
分析：持仓时间分布 / 同一天多笔交易表现差异 / 入场 vs 出场质量（如有数据）。

## 情绪陷阱分析
哪种情绪状态下亏损最严重？FOMO / 报复性交易 / 过度自信的具体数据。

## 3 个最高优先级改进行动
每条格式：「问题 → 具体行动 → 验证方式 → 预期影响」。
只给最重要的 3 条，不要列长清单。

要求：样本不足 15 笔时所有结论加「样本有限」标注；聚焦数据，不要客套；对于数据不支持的结论不要猜测。`;

export function buildDeepAnalysisContext({ trades, dailyReviews }) {
  const closed = trades.filter((t) => !Number.isNaN(num(t.pnl || "")));
  const wins = closed.filter((t) => num(t.pnl) > 0);
  const losses = closed.filter((t) => num(t.pnl) < 0);
  const totalNet = closed.reduce((a, t) => a + num(t.pnl), 0);
  const winRate = closed.length ? (wins.length / closed.length * 100) : 0;
  const avgWin = wins.length ? wins.reduce((a, t) => a + num(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + num(t.pnl), 0) / losses.length : 0;

  // 策略明细（多策略逗号分割）
  const stratMap = {};
  closed.forEach((t) => {
    const keys = (t.strategy || "未标注策略").split(",").map((s) => s.trim()).filter(Boolean);
    keys.forEach((k) => {
      (stratMap[k] = stratMap[k] || []).push(t);
    });
  });
  const stratTable = Object.entries(stratMap)
    .map(([id, items]) => {
      const w = items.filter((t) => num(t.pnl) > 0);
      const net = items.reduce((a, t) => a + num(t.pnl), 0);
      const avg = net / items.length;
      const rate = Math.round(w.length / items.length * 100);
      return { id, items, net, avg, rate };
    })
    .sort((a, b) => b.rate - a.rate)
    .map(({ id, items, net, avg, rate }) =>
      `  - ${strategyName(id)}：${items.length} 笔，胜率 ${rate}%，平均盈亏 $${fmt(avg, 1)}，总盈亏 $${fmt(net)}`
    ).join("\n") || "  无数据";

  // 错误类型
  const errMap = {};
  closed.forEach((t) => { if (t.errorType) (errMap[t.errorType] = errMap[t.errorType] || []).push(t); });
  const errTable = Object.entries(errMap)
    .map(([type, items]) => {
      const cost = items.reduce((a, t) => a + num(t.pnl), 0);
      return { type, items, cost };
    })
    .sort((a, b) => a.cost - b.cost) // 损耗最大排前
    .map(({ type, items, cost }) => `  - ${type}：${items.length} 次，总损耗 $${fmt(cost)}`)
    .join("\n") || "  无标注错误类型";

  // 情绪明细
  const emoMap = {};
  closed.forEach((t) => { if (t.emotion) (emoMap[t.emotion] = emoMap[t.emotion] || []).push(t); });
  const emoTable = Object.entries(emoMap).map(([emo, items]) => {
    const net = items.reduce((a, t) => a + num(t.pnl), 0);
    const w = items.filter((t) => num(t.pnl) > 0);
    return `  - ${emo}：${items.length} 笔，胜率 ${Math.round(w.length / items.length * 100)}%，净盈亏 $${fmt(net)}`;
  }).join("\n") || "  无标注情绪状态";

  // 环境明细
  const envMap = {};
  closed.forEach((t) => { const k = t.env || "未标注"; (envMap[k] = envMap[k] || []).push(t); });
  const envTable = Object.entries(envMap).map(([env, items]) => {
    const net = items.reduce((a, t) => a + num(t.pnl), 0);
    const w = items.filter((t) => num(t.pnl) > 0);
    return `  - ${ENVS.find((e) => e.k === env)?.t || env}：${items.length} 笔，胜率 ${Math.round(w.length / items.length * 100)}%，净盈亏 $${fmt(net)}`;
  }).join("\n") || "  无标注环境";

  // 时间分布（每天平均几笔）
  const byDate = groupBy(closed, (t) => t.date || "");
  const totalDays = Object.keys(byDate).length;
  const avgPerDay = totalDays ? (closed.length / totalDays).toFixed(1) : "—";
  const multiTradeDays = Object.values(byDate).filter((d) => d.length > 1);
  const firstTradePerf = multiTradeDays.map((dayTrades) => num(dayTrades[0].pnl));
  const firstWinRate = firstTradePerf.length
    ? Math.round(firstTradePerf.filter((v) => v > 0).length / firstTradePerf.length * 100)
    : null;

  const lines = [
    `# 全量历史交易深度分析`,
    `（共 ${closed.length} 笔已平仓交易，跨越 ${totalDays} 个交易日）`,
    ``,
    `## 总体概览`,
    `净盈亏：$${fmt(totalNet)}，胜率：${fmt(winRate, 1)}%，平均盈亏：$${fmt(totalNet / (closed.length || 1), 1)}`,
    `平均盈利笔：$${fmt(avgWin, 1)}，平均亏损笔：$${fmt(avgLoss, 1)}，盈亏比：${losses.length && avgLoss ? fmt(-avgWin / avgLoss, 2) : "—"}`,
    `每交易日平均 ${avgPerDay} 笔`,
    firstWinRate !== null ? `多笔交易日中，第一笔胜率 ${firstWinRate}%（${multiTradeDays.length} 个多笔日）` : "",
    ``,
    `## 策略胜率数据（按胜率排序）`,
    stratTable,
    ``,
    `## 错误类型分布（按损耗排序）`,
    errTable,
    ``,
    `## 情绪与盈亏关联`,
    emoTable,
    ``,
    `## 市场环境适应性`,
    envTable,
    ``,
    `## 执行质量`,
    `按计划执行：${closed.filter((t) => t.followedPlan === "yes").length} 笔 / 偏离计划：${closed.filter((t) => t.followedPlan === "no").length} 笔`,
    `强制退出条件触发但未执行：${closed.filter((t) => t.forcedExit === "missed").length} 次`,
  ].filter((l) => l !== undefined);

  lines.push("\n请基于以上全量历史数据生成深度分析报告。");
  return lines.join("\n");
}
