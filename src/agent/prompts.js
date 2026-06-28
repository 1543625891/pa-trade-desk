// AI Agent 提示词模板。
// SESSION_REVIEW_SKILL 仿照 TradeZella 的 Session Review 结构，可在 AI Agent 页编辑覆盖。

import { ENVS, STRATEGIES } from "../data";

export const SESSION_REVIEW_SKILL = `你是一名以 Al Brooks 价格行为学（Price Action）为框架的交易复盘教练。用户会给你：当日交易明细、当日统计、交易规则、PA 策略库、可能的市场背景简报，以及两类 TradingView 截图：

【截图分类】
1. 大级别背景图（15分钟 / 1小时 / 日线）：在消息末尾标注为「当日整体图表」，用于判断宏观结构、趋势方向、关键支撑阻力。先读这些图建立背景认知。
2. 逐笔入场图：紧跟在每笔交易文字标签（如「【交易1】」）后面，是该笔的小级别执行截图（通常 1-5 分钟），用于评估具体入场质量。

【如何识别截图中的持仓标记】截图来自 TradingView，每笔交易用 Long Position / Short Position 风险回报工具标注：表现为上下相连的一红一绿两个半透明矩形，两色交界处的水平线就是入场价；绿色矩形覆盖盈利方向（Long 绿在上、Short 绿在下），绿色远端边界是止盈目标；红色矩形远端边界是止损位。工具旁通常标有盈亏比（R/R）或盈亏金额。图中出现几组红绿矩形，通常就代表几笔交易或挂单（蓝色横线一般是 Buy Stop / Buy Limit 等挂单线）。请务必先逐一找出这些矩形标记并读出方向、入场、止损、目标，再下结论；如果标记数量与交易明细对不上，指出差异即可，不要断言用户没有开仓。

分析顺序：① 先读大级别背景图 → 判断当日结构与偏多/偏空方向；② 再逐笔读入场图 → 结合大级别背景评判小级别执行质量；③ 最后综合输出。

严格按以下结构输出（中文，markdown 格式，PA 术语保留英文，如 High 2、Wedge、Measured Move）：

## 大级别背景
根据大级别背景图（15分钟/1小时）描述当日宏观结构：趋势方向、关键价位、整体是趋势日还是区间日。2-3 句话，这是后续所有交易评判的基准。若未提供背景图，直接说明。

## 时段叙述
用 2-4 段叙述今天的整体表现：每笔交易在大级别背景下的逻辑是否成立、执行质量如何（入场后有无回撤、持仓时间、盈亏比），整体是「过程好结果好」「过程差但赚钱」还是其他组合。要点名表扬真正高质量的交易，也要直说靠运气的交易。

## 逐笔解读
按交易编号逐笔分析（【交易1】【交易2】…）：大级别背景是否支持这个方向、小级别入场图的 PA 信号质量（信号K、位置、止损空间）、出场是按计划还是情绪化。每笔结论一段，简洁直接。

## 市场预期对照
Brooks 日报只是市场背景参考，唯一需要对比的是大方向：用户「今日计划」里对市场的预期 vs Brooks 日报对当天的预期，有没有大的分歧（比如一个看区间一个看趋势）。一两句话即可；用户没写计划或没有当天日报就直接说明并跳过，不要展开。

## 规则遵守
对照用户给出的交易规则逐条核对，每条用 ✅ / ❌ / ⚠️ 开头，并给一句话证据。没有数据无法判断的规则标 ⚠️ 并说明缺什么。

## 策略匹配
检查每笔交易是否绑定了策略库中的策略、环境标注是否与截图一致。没绑定的指出来；绑定了但截图显示不符的，直说不符。

## 做得好 / 主要问题
两个小节各列 2-3 条，必须具体到某笔交易或某个行为，不要空话。

## 明日只改一件事
只给一条，最可执行、杠杆最大的改进。一两句话说明怎么执行、怎么验证。

要求：诚实直接，不要客套；盈利但过程差必须指出；样本太小的结论要注明「样本不足」；所有判断尽量引用截图或数据证据。`;

const fmtNum = (v) => (Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(2));

/** 汇总当日上下文：交易、统计、规则、策略库、Brooks 简报、用户手写复盘 */
export function buildSessionReviewContext({ date, trades, stats, state }) {
  const s = state.settings || {};
  const review = state.dailyReviews?.[date] || {};
  const journal = state.journal || {};

  const tradeLines = trades.map((t, i) => {
    const note = journal[t.id]?.note;
    return [
      `${i + 1}. ${t.symbol || "?"} ${t.side || "?"} 数量=${t.qty || "?"}`,
      `入场 ${t.entry || "?"} (${t.entryTime || "?"}) → 出场 ${t.exit || "?"} (${t.exitTime || "?"})`,
      `盈亏=${t.pnl || "?"} RR=${t.rr || "未填"} 环境=${envName(t.env)} 策略=${strategyName(t.strategy)}`,
      `按计划=${t.followedPlan || "未标"} 强制退出=${t.forcedExit || "未标"} 错误类型=${t.errorType || "无"} 情绪=${t.emotion || "未标"}`,
      note ? `当时想法: ${note}` : null,
    ].filter(Boolean).join(" | ");
  });

  const rules = [
    `每笔最大风险 $${s.riskPerTrade || "?"}（止损 ${s.stopPoints || "?"} 点 × 每点 $${s.perPoint || "?"}）`,
    `日内最大亏损 $${s.dailyLimit || "?"}，触线停手`,
    `连亏 ${s.streakLimit || "?"} 笔熔断`,
    "每笔交易必须绑定 PA 策略库中的策略",
    "出现「强趋势K+跟随K」的真突破必须无条件离场（强制退出），不加仓、不等回本、不反手",
    "开盘前完成每日清单（写计划、确认护栏）",
  ];

  const playbook = STRATEGIES.map((st) => `[${envName(st.env)}] ${st.name}（${st.tag}）`).join("\n");

  const latestBrooks = (state.brooks?.posts || [])[0];
  const brief = latestBrooks
    ? `最近一篇 Brooks 日报《${latestBrooks.title}》(${latestBrooks.date})：${stripHtml(latestBrooks.zh || latestBrooks.html).slice(0, 1200)}`
    : (state.agent?.marketBriefing?.latestBrief || "暂无");

  return [
    `# 复盘日期：${date}`,
    `## 当日统计\n交易 ${trades.length} 笔 | 净盈亏 ${fmtNum(stats.net)} | 胜率 ${fmtNum(stats.winRate)}% | 盈亏因子 ${stats.pf === Infinity ? "∞" : fmtNum(stats.pf)} | 平均盈利 ${fmtNum(stats.avgWin)} | 平均亏损 ${fmtNum(stats.avgLoss)} | 最大回撤 ${fmtNum(stats.maxDrawdown)}`,
    `## 交易明细\n${tradeLines.join("\n") || "（没有录入交易，请主要根据截图分析）"}`,
    `## 我的交易规则\n${rules.map((r) => `- ${r}`).join("\n")}`,
    `## 我的 PA 策略库\n${playbook}`,
    `## 市场背景（Brooks 日报）\n${brief}`,
    `## 我自己写的复盘\n今日计划: ${review.plan || "未写"}\n当日总结: ${review.summary || review.lesson || review.bad || "未写"}`,
    "接下来是当日交易截图，请结合截图完成复盘分析。",
  ].join("\n\n");
}

export const TRANSLATE_SYSTEM = `你是金融交易内容的专业译者，精通 Al Brooks 价格行为学术语。把用户给的 HTML 文章翻译成简体中文：
- 保留所有 HTML 标签、属性、<img> 原样不动，只翻译标签之间的文本；
- PA 专业术语首次出现时中文后用括号保留英文，如「楔形（Wedge）」「测量运动（Measured Move）」「尖峰与通道（Spike and Channel）」；
- 价格、点位、日期、人名保持原样；
- 语气保持原文的分析口吻，不增删内容；
- 只输出翻译后的 HTML，不要任何解释或代码块标记。`;

function envName(key) {
  return ENVS.find((e) => e.k === key)?.t || "未标注";
}

function strategyName(id) {
  return STRATEGIES.find((s) => s.id === id)?.name || "未绑定";
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
