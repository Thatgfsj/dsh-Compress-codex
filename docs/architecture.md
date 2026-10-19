# 架构：分层、接缝、事务，以及与官方 compaction-basic 的逐维差异

> 面向两类读者：**要判断"要不要换"的人**（看 §4 对照表）与**要改代码的人**（看 §1–§3）。
> 每条 dsh 行为断言要么带文件+函数级证据，要么指向已有证据文档。

## 1. 分层：三层，导入方向单向

```
┌──────────────────────────────────────────────────────────────┐
│ lib/index.js      唯一出现 '@deepseek-ai/*' 的模块（动态 import）│
│   apply(ctx, config) → validateRowConfig → mountEngine        │
│   · loadBaseClass()   → import('@deepseek-ai/dsh-compaction-basic') │
│   · loadEdgeChecks()  → import('@deepseek-ai/dsh-compaction') │
├──────────────────────────────────────────────────────────────┤
│ lib/engine.js     引擎工厂；宿主能力靠**注入**，自身零宿主 import │
│   createCodexCompactionEngine(Base, hooks, helpers)           │
│   · 注入 capacity { windowTokens } | null（异步 llm 查询的结果）│
│   · 把官方 resolveConfig 认识的键（BASE_CONFIG_KEYS）与我们的    │
│     策略键（POLICY_KEYS）切分，避免触发官方校验器               │
├──────────────────────────────────────────────────────────────┤
│ lib/core/**       纯决策层：不 import 任何 '@deepseek-ai/*'      │
│   trigger.js(D1) select.js(D2/D3) prompt.js(D4) summarize.js(#7)│
│   idempotence.js(#9) errors.js(#10) telemetry.js(#13 模块层)     │
│   config.js / keys.js（策略面）                                  │
└──────────────────────────────────────────────────────────────┘
```

**为什么分层是硬约束**：门禁以 `node --test` 运行且**不装依赖**（[CI 配置](../.github/workflows/ci.yml)），
`lib/core` 里任何宿主 import 都会让所有后续 PR 变红；该不变量由 `test/layering.test.mjs` 断言。

### 1.1 注入的两样宿主能力

| 能力 | 来源 | 失败时的行为 |
|---|---|---|
| 基类 `BasicCompactionEngine` | `lib/index.js#loadBaseClass` → `import('@deepseek-ai/dsh-compaction-basic')` | **整个接缝不安装**；`reportMountFailure` 打一条日志，官方后端继续跑。原因：0.2.1-rc.2 上被拒绝的 `apply` 会被加载器静默吞掉，这行日志是操作者唯一的信号 |
| C1 切割助手 `toolPairingBalancedBefore/After` | `lib/index.js#loadEdgeChecks` → `import('@deepseek-ai/dsh-compaction')` | **不致命**：返回 `{}`，选择器退回自己的纯 C1 检查 |

## 2. 接缝：`ctx.compaction`

本插件不实现 `ctx.compaction`，它**替换提供者**：`cordis.patch.yml` 先 `disabled: true` 掉官方行，
再 `insert` 我们的行；`lib/index.js#mountEngine` 用 `ctx.plugin(Engine, config)` 挂载一个继承自官方
`BasicCompactionEngine` 的子类（方案 B：**只换策略，复用机械层**；见 `docs/PLAN.md` §2.2）。

三个被覆盖的决策函数（契约见 [`docs/design-m1-m2.md`](design-m1-m2.md) §2.1）：

| 方法 | 覆盖后我们负责 | 归属 |
|---|---|---|
| `compactIfNeeded(agent, trigger, signal)` | D1 触发 + D2/D3 范围选择 | #4 / #5 |
| `compactNow(agent, signal, sourceCommandId)` | 手动路径的范围选择与零写入 | #5 |
| `summarize(input, agent, signal)` | D4 提示词与输出投影 | #6 / #7 |

**复用而不重写的机械层**：`this.compactRegion(start, end, agent, signal)`（锁、事务、重试、
崩溃恢复）与 `this.regionDependencies()`（把 `this.summarize` 包成闭包，因此**动态分派**到我们的 override）。

> **运行时证据**：`disabled: true` 不是可选项。若官方行仍启用，两个引擎会同时 `provide('compaction')`，
> 组合期 fatal（`service "compaction" has been registered at <BasicCompactionEngine>`）。
> 见 [`docs/runtime-verification.md`](runtime-verification.md) §5.2。

## 3. 事务序列（由基类执行，我们不重写）

```
agent/pre-step (pressure)
  └─> compactIfNeeded(agent, 'pressure', signal)      [我们: D1 判阈值 → delegate|skip|compact]
        └─> 自研选择器                                 [我们: D2/D3, 返回 {start,end} 或 null]
              └─> this.compactRegion(start, end, ...) [基类: 事务]
                    ├─ compaction/start        （同步，即锁）
                    ├─ summarize(input, ...)   [我们: D4]  → ctx.llm.stream({purpose:'compaction'})
                    ├─ 重新校验 range
                    ├─ compaction/summary      （含 shadowedRange / 影子计价）
                    ├─ 替换 user/message       （compactCheckpointSource 标记）
                    └─ compaction/end          （释放锁）

agent/request-error (CONTEXT_WINDOW_EXCEEDED)
  └─> compactIfNeeded(agent, 'context-overflow', signal) [我们: 旁路阈值，强制一次最大平衡头部缩减]
```

契约要点（证据：`@deepseek-ai/dsh-compaction` 的 `types.d.ts` 注释）：

- `compaction/summary` 与紧随其后的替换 `user/message` **必须相邻**——"adjacency is contractual"，
  影子计价依赖这个顺序；
- **C2**：范围起点必须跳过 surface 节点 0 的 `system/message`；
- **C1**：切割点两侧必须 tool-call/result 配对平衡（`toolPairingBalancedBefore/After`）。

### 3.1 D1 的三态返回（"不接管" ≠ "不压缩"）

`lib/core/trigger.js` 返回 `delegate | skip | compact`：窗口未知时返回 **delegate**（让官方策略继续决策），
而不是 `skip`——`skip` 会连官方策略一起停掉，那是更糟的失败模式。

## 4. 与官方 `compaction-basic` 的逐维差异（核心表）

官方默认值来自其 README：触发 `floor(min(W × 0.8, W − O − B))`（`B = 65,536`），保留 `W − O` 的 16%。

| 维度 | 官方 `compaction-basic` | 本插件（D1/D4 取 Codex 策略；D3 与 #9 防漂移为 DSH 自研） | 状态 |
|---|---|---|---|
| **D1 触发** | 单一比例：`floor(min(W×thresholdRatio, W−O−headroomTokens))`，`thresholdRatio=0.8`、`headroom=65536` | **三段式**：`full = floor(W×0.95)`；`limit = min(triggerLimitTokens ?? ∞, floor(W×0.9))`；触发 = `scope≥limit+buffer \|\| active≥full`；另有独立轮末百分比（默认 0=关） | 已实现 #4 |
| **D1 溢出** | `agent/request-error` → 旁路阈值，一次最大平衡头部缩减 | 相同语义（`overflowRecovery: true`），由引擎转成 `context-overflow` 触发 | 已实现 #4 |
| **D2 切分** | 最旧的**平衡范围**，起点跳过 `system/message` | 结构单元划分 + C1 双端吸附；找不到安全 cut 则**零写入** | 已实现 #5 |
| **D3 保留** | `retainRatio = 0.16` × `W − O` 逐字保留 | 按**结构单元**保留（`retainRecentUnits` 默认 3）；`retainTokens` 是**软**上限，整单元进/出 | 已实现 #5 |
| **D4 摘要** | 自由文本；单轮 `ctx.llm.stream({purpose:'compaction'})`，回放 system+tools+被遮蔽区域 | `codex-v1` 结构化模板：Codex 四条 bullet + `files`/`pitfalls` 两扩展字段；投影只取文本 | 已实现 #6 模板 / #7 调用 |
| **D5 注入** | 一条带 `<compacted-summary>` 框定与 `compactCheckpointSource` 的替换 `user/message` | **不改**（外层框架由基类事务生成，改它就等于放弃 C3 复用） | 受约束，非未完成 |

**"要不要换"的一句话**：如果你只需要"到阈值就总结历史"，官方后端够用且更便宜；
如果你需要**按对话结构保留近期任务上下文**、**面向续跑的稳定摘要字段**，
本插件才是目标——但请先读 §5。

## 5. 已知边界（写进架构，不只写进验证文档）

1. **宿主包只在 dsh 启动进程内可解析**：profile 目录里裸 `node` 解析官方包会
   `ERR_MODULE_NOT_FOUND`，而启动进程内成功。任何"裸 node 解析"的断言都是假阴性。
   见 [`docs/runtime-verification.md`](runtime-verification.md) §5.1。
2. **`web` 模板假绿**：该模板自身禁用 `compaction-basic`，别用它验证本 bundle。
   见 [`docs/runtime-verification.md`](runtime-verification.md) §1。
3. **会话级已实测通过，但有边界**：真实两轮会话已在真实模型上产生
   `compaction/start → summary → user/message → end`（见
   [`docs/runtime-verification.md`](runtime-verification.md) §4）。它**不**证明长会话质量、
   **默认 `0.9 × W` 阈值**下的触发时机、或跨 tool-call 的切割——边界逐条列在 §4.3。
   仍未闭合的是 **#8**（D5 注入形态"不给模型漏内部 id"没有断言）；**#13** 的模块与接线都已合
   （`lib/engine.js` 已 import `lib/core/telemetry.js`），但**它的报告行尚未在真实会话日志中被
   观察过**，这条边界仍然成立。
4. **防漂移是 DSH 自研**：Codex 侧**没有任何**显式防漂移机制（只有"每次重新总结" + 一句警告），
   所以 #9 的版本号/稳定标记必须自己定义，不能声称照搬。
   见 [`docs/codex-notes.md`](codex-notes.md) §6.2 与 [`docs/codex-dsh-mapping.md`](codex-dsh-mapping.md) §3。

## 6. 证据索引

| 想确认什么 | 看哪 |
|---|---|
| Codex 到底怎么做（含行号与 URL） | [`docs/codex-notes.md`](codex-notes.md) |
| 哪些能照搬、哪些不能 | [`docs/codex-dsh-mapping.md`](codex-dsh-mapping.md) |
| 每个策略维度的实现顺序与伪码 | [`docs/codex-impl-checklist.md`](codex-impl-checklist.md) |
| 继承点与配置面契约 | [`docs/design-m1-m2.md`](design-m1-m2.md) |
| 内核约束 C1–C5 与自由度 D1–D5 | [`docs/PLAN.md`](PLAN.md) §1.2–§1.3 |
| 什么已验证/未验证、怎么复现 | [`docs/runtime-verification.md`](runtime-verification.md) |
