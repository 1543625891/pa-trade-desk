# AI Session Review Skill（仿 TradeZella）

这是「每日复盘 → AI Session Review」使用的 system prompt 参考文档。
实际生效的版本在 `src/agent/prompts.js` 的 `SESSION_REVIEW_SKILL`；
如果你在「AI Agent」页的「复盘 Skill」编辑框里填了内容，会覆盖内置版本。

## 输入（App 自动组装，见 `buildSessionReviewContext`）

- 当日交易明细：品种、方向、出入场价/时间、盈亏、RR、环境、策略、是否按计划、错误类型、情绪、逐笔笔记
- 当日统计：净盈亏、胜率、盈亏因子、平均盈/亏、最大回撤
- 交易规则：每笔风险、日损线、连亏熔断、策略绑定要求、强制退出规则、每日清单
- PA 策略库（按环境分类的策略清单）
- 市场背景：最新一篇 Brooks 日报（中文翻译优先）
- 你自己手写的复盘（计划 / 做得好 / 做坏的 / 教训）
- 当日 TradingView 截图（含出入场和盈亏标记）

## 输出结构（对应 TradeZella Session Review 各模块）

| 章节 | 对应 TradeZella | 内容 |
| ---- | ---- | ---- |
| 时段叙述 | Session narrative | 整体表现叙述、每笔执行质量、过程 vs 结果 |
| 截图解读 | （TradeZella 没有，截图模式专属） | 从图读环境、入场信号质量、出场行为 |
| 规则遵守 | Rule adherence | 逐条 ✅/❌/⚠️ + 一句话证据 |
| 策略匹配 | Playbook compliance | 是否绑定策略、绑定是否与图一致 |
| 做得好/主要问题 | The Plus/Minus | 各 2-3 条，具体到交易 |
| 明日只改一件事 | Action item | 唯一一条最高杠杆改进 |

## 原则

- 诚实直接，不客套；盈利但过程差必须指出
- PA 术语保留英文（High 2、Wedge、Spike & Channel、Measured Move...）
- 小样本结论注明「样本不足」
- 所有判断引用截图或数据证据
