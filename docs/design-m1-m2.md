# M1/M2 实现规格（接口冻结）

> 作者：Lead。状态：**冻结待用**，作为议题 #2-#8 的实现契约。改动需 Lead 复核。
> 证据基准：`dsh 0.2.1-rc.2`。

## 1. 可用 API 面（决定架构边界）

### 1.1 运行时**可** import 的（peer）

| 来源 | 可用符号 |
|---|---|
| `@deepseek-ai/dsh-compaction`（`lib/index.js` L175） | `CompactionEngine`, `CompactionId`, `ManualCompactionError`, `compactCheckpointSource`, `isCompactCheckpointSource`, `toolPairingBalancedBefore`, `toolPairingBalancedAfter` |
| `@deepseek-ai/dsh-compaction-basic`（`lib/index.js` L1027） | **仅** `BasicCompactionEngine`（`CompactionEngine` 子类，默认导出同） |

### 1.2 **不可** import 的（已核实）

| 符号 | 声明位置 | 为何不可用 |
|---|---|---|
| `selectCompactableRange` | `lib/types/region.d.ts` | `package.json` 的 `exports` 无 `./region`；`files` 只含 `lib/index.js` + `lib/types/**/*.d.ts`，运行时无 `region.js`。有 `.d.ts`（类型）/ `src`（未打包）两条歧路，**不要**试图绕 |
| `compactSurfaceRegion` | 同上 | 同上 |
| `summarizeWithLlm` / `frameSummary` | `lib/types/summarizer.d.ts` | 同上 |

> 这条边界直接决定：**D2/D3（切分与保留）必须自研**；但**事务机械层可通过 `this.compactRegion()` 复用**。

## 2. 继承点契约（方案 B）

```js
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

export class CodexCompactionEngine extends BasicCompactionEngine {
  compactIfNeeded(agent, trigger, signal) { /* D1 + D2 + D3 */ }
  compactNow(agent, signal, sourceCommandId) { /* 手动路径：D2 + D3 */ }
  summarize(input, agent, signal) { /* D4 */ }
}
export default CodexCompactionEngine;
```

### 2.1 必须覆盖的三个决策函数

| 方法 | 签名 | 基类行为（我们要替换的） | 覆盖后我们负责 |
|---|---|---|---|
| `compactIfNeeded` | `(agent, trigger: 'pressure'\|'context-overflow', signal) => Promise<CompactionResult\|null>` | 用 `ctx.tokenMeter` 定价最新路由 envelope，按 `thresholdRatio`/`retainRatio` 选最旧平衡范围 | **D1 触发判定 + D2/D3 范围选择**，然后调 `this.compactRegion(start,end,agent,signal)` |
| `compactNow` | `(agent, signal, sourceCommandId?) => Promise<CompactionResult\|null>` | `agent.runMaintenance` 内选范围并走 `owner:null` / `stability:'selected-span'` 事务 | 手动路径的范围选择与无操作时**零写入** |
| `summarize` | `(input: SummarizationInput, agent, signal?) => Promise<SummaryResult>` | 默认 cache-reusing `ctx.llm.stream()` 单轮调用 | **D4 提示词与输出投影** |

### 2.2 复用（不要重写）的机械层

- `this.compactRegion(start, end, agent, signal)` → 内部 `compactSurfaceRegion(..., {owner:'current-turn', stability:'whole-surface'}, ...)`，负责：锁校验、`compaction/start`、等待摘要、重新校验、`compaction/summary`、替换 `user/message`、`compaction/end`。
- `this.regionDependencies()` → `{ meter: this.ctx.tokenMeter, summarize: (...)=>this.summarize(...), recover: (...)=>ctx.waterfall('compaction/summary-error', ...) }`。**动态分派**：它把 `this.summarize` 包成闭包，所以我们的 override 会被事务层调用到。
- 自动 listener 注册（构造函数内 `if (config.auto) this._registerAutomaticCompaction()`）：`agent/pre-step` → `this.compactIfNeeded(agent,'pressure',signal)`；`agent/request-error` → `this.compactIfNeeded(agent,'context-overflow',signal)`。**继承即继承，无需自建**（证据见 `PLAN.md` §2.3）。

### 2.3 类型契约（照抄，勿改）

```ts
interface SummarizationInput {
  tools?: readonly ToolSchema[];   // 会话工具 schema，用于前缀缓存对齐
  messages: readonly Message[];    // 派生 system 头 + 被遮蔽区域（surface 顺序）
}
type SummaryResult = {
  summary: ContentBlock[];         // 纯文本，排除推理/工具调用
  provider: string; model: string; maxTokens?: number; usage?: TokenUsage;
} & (
  { rawOutput: ContentBlock[]; llmStreamCall: true }          // 走 ctx.llm.stream()
| { rawOutput?: ContentBlock[]; llmStreamCall?: never }       // 模板/远程摘要器
);
```

## 3. D1-D5 的落点（关键：哪些能改、哪些受机械层约束）

| 维 | 落点 | 自由度 | 备注 |
|---|---|---|---|
| **D1 触发** | override `compactIfNeeded` | **完全自由** | 但 `context-overflow` 分支是自愈路径，**不得**因自定义阈值而失效 |
| **D2 切分** | override `compactIfNeeded`/`compactNow` 内自研选择器 | **完全自由**（`selectCompactableRange` 不可用，必须自研） | 须满足 C1 配对平衡、C2 节点 0 不被遮蔽 |
| **D3 保留** | 同上 | **完全自由** | 可从"按 token 比例"改为"按对话结构" |
| **D4 摘要** | override `summarize` | **完全自由** | 提示词与输出投影都由我们定 |
| **D5 注入** | ⚠️ **受机械层约束** | **受限** | 替换消息的框架（标签/检查点 source）由基类事务生成，我们**不能**改变外层框架 |

**D5 的结论与对策**：基类框架是不可改的（且这正是 C3 契约要求的）。因此 Codex 风格的"注入形态"通过 **D4 的摘要内容结构**实现——即在被框架包裹的摘要体内，使用 Codex 的结构化字段与"历史已压缩、如何续跑"的说明。
若审阅坚持要改外层框架，则必须放弃 `compactRegion` 复用、改走方案 A（自研事务）——成本见 `PLAN.md` §2.2。

## 4. 数据流

```
agent/pre-step (pressure)
  └─> this.compactIfNeeded(agent, 'pressure', signal)     [我们: D1 判阈值]
        └─> 自研选择器                                    [我们: D2/D3]
              └─> this.compactRegion(start, end, agent, signal)   [基类: 事务]
                    ├─ compaction/start  (同步, 即锁)
                    ├─ this.regionDependencies().summarize(input, agent, signal)
                    │     └─> this.summarize(...)         [我们: D4]
                    │           └─> ctx.llm.stream({purpose:'compaction'})
                    ├─ 重新校验 range
                    ├─ compaction/summary  (含 shadowedRange/发电价)
                    ├─ 替换 user/message (compactCheckpointSource)
                    └─ compaction/end
```

## 5. 配置面（议题 #3 冻结，已按 Codex 源码证据修正）

> **修正记录**：初稿的单一 `triggerRatio`（0.8）是错的。证据（`docs/codex-notes.md` §1）显示 Codex 是**三段式**：
> `limit = min(config.limit, W * 0.9)`、`full = W * 0.95`，触发条件 `scope_tokens >= limit + buffer || active_tokens >= full`，
> 另有轮末百分比检查（默认 0 = 关闭）与后台投机检查（65%）。故配置面按此重构。

```ts
interface CodexCompactionConfig {
  // ── D1 触发（Codex 三段式）
  triggerLimitTokens?: number;      // 绝对上限（可选，对应 Codex config.limit）
  triggerLimitRatio?: number;       // 窗口比例上限，默认 0.9；范围 (0,1)
  effectiveWindowPercent?: number;  // 硬满上限比例，默认 0.95；必须 > triggerLimitRatio
  triggerBufferTokens?: number;     // limit 之上的缓冲
  turnEndPercent?: number;          // 轮末检查比例，默认 0（关闭）
  overflowRecovery?: boolean;       // 默认 true：CONTEXT_WINDOW_EXCEEDED 时强制一次缩减
  // ── D2/D3 切分与保留
  retainMode?: 'structural';        // 默认：以 C1 平衡区间为原子，绝不单留半对
  retainRecentUnits?: number;       // 保留最近 N 个结构单元（轮/步）
  retainTokens?: number;            // 近期预算上限（兜底，非唯一依据）
  // ── D4 摘要
  summaryTemplate?: 'codex-v1';     // 模板版本号，用于度量漂移
  summaryExtraFields?: ('files' | 'pitfalls')[];  // Codex 4 条之外的扩展字段，默认全开
  // ── 路由
  summarizationProvider?: string;
  summarizationModel?: string;
  maxTokens?: number;
  modelPolicies?: { provider: string; model: string; /* 同上子集 */ }[];
  auto?: boolean;
}
```

**token 计数**：不引入第二套估算，沿用 DSH 的 `ctx.tokenMeter` 影子计价；仅在缺少 provider usage 时用 DSH 自带 estimator 兜底（证据 `docs/codex-dsh-mapping.md` 的 D1' 行）。

**D4 字段基线**（Codex 原文 4 条 bullet）：进展与关键决策 / 重要上下文·约束·偏好 / 待办 / 关键数据与引用。
Codex **没有**"触碰的文件"与"已知坑"独立字段 → 由 `summaryExtraFields` 显式扩展，默认开启（这是本项目的立项理由之一）。

校验必须快速失败：未知键、`triggerLimitRatio` 越界、`effectiveWindowPercent <= triggerLimitRatio`、`retainRecentUnits < 1`、保留预算 >= 触发阈值、路由只给一半。

## 6. 测试装置要求（议题 #11 前置）

- **假 Session**：只需满足选择器与事务读取的 surface 形态；用最小桩对象，不启动真实会话。
- **假 LLM**：`ctx.llm.stream()` 返回可编程的 `ContentBlock[]`（含"带推理/工具调用的脏输出"用例以验证 C5 投影）。
- **不触网、不触真实 `~/.dsh`**：CI 有隔离守卫兜底。
- 断言优先级：**不变量（C1/C2 配对平衡、节点 0 不可遮蔽、零写入）> 事件序列 > 文本内容**。

## 7. 实现顺序与依赖冻结

```
#2 骨架(接入 + disable/insert + 冒烟)
    └─> #3 配置面/schema
          ├─> #4 D1 触发        ─┐
          ├─> #5 D2/D3 选择器   ─┼─> #11 测试矩阵
          └─> #6 D4 模板        ─┘
                └─> #7 D4 调用（回放+路由+取消）
                      └─> #8 D5 注入（摘要内结构）
#9 幂等防漂移（依赖 #5,#7）  #10 失败降级（依赖 #2,#7）
```

**并行安全**：`#4`/`#5`/`#6` 三者写入范围互不重叠（`lib/core/trigger.js` / `select.js` / `prompt.js`），可三人并行；`#7` 依赖 `#6` 的模板签名冻结后再动。
