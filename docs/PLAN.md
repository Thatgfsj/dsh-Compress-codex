# dsh-Compress-codex — 项目计划（已实施；附终态复核）

> 状态：**计划已实施**。本文档保留立项时的第一性原则、约束推导与拆解方式；**当前真实状态
> 以 [§5.1 终态复核](#51-终态复核2026-10-18) 为准**（2026-10-18 逐项核对源码与验证记录），
> §7 的决策点也已逐条收敛。
> 仓库：https://github.com/Thatgfsj/dsh-Compress-codex
> 已验证基线：本机 `dsh --version = 0.2.1-rc.2`（真实模型端到端见
> [`docs/runtime-verification.md`](runtime-verification.md) §4）

## 0. 一句话

一个**侵入 DSH 压缩层**（`ctx.compaction` 服务接缝）的插件：把官方 `@deepseek-ai/dsh-compaction-basic` 的**触发 / 切分 / 保留 / 摘要 / 注入**五维策略替换为 Codex 风格策略，同时**保留** DSH 既有的持久化事务契约与 `/compact` 命令兼容。

---

## 1. 第一性原则

### 1.1 问题的本质

上下文窗口 `W` 有限，会话历史 `H` 单调增长。压缩在数学上是一个投影：

```
pi: H -> H'      |H'| << |H|      subject to  TaskSuccess(H') ~= TaskSuccess(H)
```

它**不是**"删消息"，而是"在有损信道上做一次信息重编码"。因此先确定**不可违反的约束**，剩下的才是设计自由度。

### 1.2 不可违反的约束（来自 dsh 内核契约，非策略选择）

| # | 约束 | 理由 |
|---|---|---|
| C1 | 切割点必须让 assistant tool_call 与其 tool_result 成对 | 否则请求在 provider 侧非法；dsh 提供 `toolPairingBalancedBefore/After` 正是为此 |
| C2 | surface 节点 0 的 `system/message` 不可被遮蔽 | 系统提示词必须常驻；范围选择须从第一个非 system 节点开始 |
| C3 | 必须是一次持久化事务：`compaction/start` → `compaction/summary` → 紧随一条替换 `user/message` → `compaction/end` | 锁、崩溃恢复、投影折叠、纯消费端计价都依赖这对标记 |
| C4 | 摘要调用须回放会话自身前缀（system + tools + 被遮蔽区域） | 复用 provider KV cache，否则成本模型崩 |
| C5 | 摘要只取返回文本；推理与 tool_call 一律排除 | 检查点必须是纯文本块 |

### 1.3 由约束导出的自由度（压缩策略只有这 5 维）

| 维 | 含义 |
|---|---|
| **D1 触发** | 何时压（压力阈值 / 溢出恢复 / 手动） |
| **D2 切分** | 压哪一段（范围选择语言学） |
| **D3 保留** | 哪一段逐字留（近期尾部预算） |
| **D4 摘要** | 怎么压（提示词结构与输出投影） |
| **D5 注入** | 压缩结果以什么形态回到模型可见面 |

评价函数：**token 释放量 ↑、任务保真度 ↑、额外成本 ↓、行为可预测性 ↑**。

### 1.4 基线：官方 `compaction-basic` 当前策略（已核实）

| 维 | 现状 | 证据 |
|---|---|---|
| D1 | 压力 `>= floor(min(W x 0.8, W - O - 65536))`；`CONTEXT_WINDOW_EXCEEDED` 时旁路阈值强制一次最大平衡头部缩减 | `dsh-compaction-basic/README.zh.md` §使用本包 / §理解实现 |
| D2 | 替换**最旧的平衡范围**，起点跳过 surface 节点 0 | 同上 |
| D3 | `retainRatio = 0.16` of `(W - O)` 逐字保留近期尾部 | `lib/types/config.d.ts`、README 配置表 |
| D4 | 自由文本摘要（单轮 `ctx.llm.stream()`，`GenerateOptions.purpose = 'compaction'`），回放 system + 被遮蔽消息 | README §摘要机制 |
| D5 | 一条 `<compacted-summary>` 标签的替换 `user/message`；原文留在 `compaction/summary` 事件 | README §摘要机制、`dsh-compaction/lib/types/types.d.ts` |

**可观察到的原生缺陷（这就是本项目的立项理由）**：保留比例是**按 token 预算**而非**按对话结构**的——它不知道"最近 3 轮任务上下文"比"更早的 5 万 token 工具日志"更该逐字保留；摘要格式是自由文本，缺少面向"续跑"的稳定字段（进展 / 决策 / 待办 / 触碰的文件）；多次压缩叠加时没有防漂移约定。Codex 正是针对这三点设计的。

### 1.5 目标：Codex 策略（已按源码证据回填）

证据：`docs/codex-notes.md`（337 行、41 处 [证据]）与 `docs/codex-dsh-mapping.md`（D1-D5 + C1-C5 对齐表）。

| 维 | Codex 做法（源码证据） | 能否照搬 | 我们的取向 |
|---|---|---|---|
| **D1** | 三段式：`limit = min(config.limit, W*0.9)`；`full = W*0.95`；触发 `scope_tokens >= limit + buffer \|\| active >= full`；轮末检查默认 0（关闭）；后台投机 65% | ✅ 照搬（换输入） | 保留三段式，`W` 映射为 DSH 已解析容量；溢出仍走 DSH 的 `CONTEXT_WINDOW_EXCEEDED` |
| **D2** | **不选切割点**：整体重建 `replacement_history` 并持久化 | ❌ 不可照搬 | DSH 是"在既有 surface 上替换一段"；必须自研范围选择器（议题 #5） |
| **D3** | `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` 预算内只保留 **user 消息**，assistant/tool 一律进摘要 | ❌ 不可照搬 | Codex 有 `normalize_history` 兜底配对，DSH 没有 → 保留单元必须是 **C1 平衡区间**，绝不单留半对 |
| **D4** | 9 行自由文本 + 4 条 bullet（进展与关键决策 / 重要上下文·约束·偏好 / 待办 / 关键数据与引用），有角色指令，无 schema、无必填校验 | ⚠️ 改造 | 以 4 条为最小基线，**扩展**"触碰的文件"与"已知坑/失败尝试"两个独立字段（立项理由之一），并加模板版本号 |
| **D5** | 一条 **user 角色纯文本**，无 XML 标记，文本 = `SUMMARY_PREFIX + "\n" + 摘要`，置历史最后；靠 `content_kind` 做 harness 分类 | ⚠️ 改造 | 保留 SUMMARY_PREFIX 的续跑语义（"另一个模型已开始…不要重复工作"），但外层**必须**走 DSH 形态：`compactCheckpointSource` + `<compacted-summary>` 框定（C3） |

**两条必须写进设计的负面结论**：
1. **防漂移：Codex 没有任何显式机制**（只有"把旧摘要连同新历史再摘要一遍" + 一句 WarningEvent）→ 议题 #9 必须自研；文档不得声称"照搬 Codex"。
2. **Codex 侧不存在 tool_call/result 切割约束**（只有内存历史的 `normalize_history` 不变量）→ 不能指望"事后 normalize"，必须**事前**用 `toolPairingBalancedBefore/After` 吸附边界。

---

## 2. 架构

### 2.1 侵入点（已核实）

`dsh-base` bundle 中压缩层只有两行：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'   # ctx.compaction 唯一实现
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'    # /compact，backend-independent
```

本插件作为 **bundle** 分发，patch 层做两件事：

```yaml
- id: compaction-basic
  disabled: true                 # 抛弃原生压缩方式
- insert:
    - id: compaction-codex
      name: 'dsh-compress-codex' # 我们注册 ctx.compaction
```

`command-compact` 与 `tool-result-pruner` **保持不动**：它们按注释是 backend-independent 的，这让我们天然继承 `/compact` 与超大工具输出修剪能力。

### 2.2 三个候选架构（**已拍板：方案 B**）

| 方案 | 做法 | 优点 | 代价 / 风险 |
|---|---|---|---|
| **A 全自研** | `extends CompactionEngine`，自己实现全部三个抽象方法 + 事务 + 溢出恢复 | 最彻底 | 需重写事务、锁、drop/重试、持久化、replay、图片处理；#工作量 3-5x，回归面大 |
| **B 策略层继承（推荐）** | `extends BasicCompactionEngine`，override `compactIfNeeded` / `compactNow` / `summarize`，复用其 `compactRegion` 事务内核 | 只替换 D1-D5 决策层，机械层（事务/计价/重试/持久化）复用官方实现；官方文档明确 `compactIfNeeded` 为动态分派，是**设计好的继承点** | 依赖 `dsh-compaction-basic` 内部结构稳定性；须声明 peerDependency |
| C 旁路改写 | 不 disable 原生，监听事件改写 | 无 | 无法真正替换策略，**不满足"抛弃原生压缩方式"**，淘汰 |

**推荐 B**，理由是第一性原则的取舍：*保留被验证过的机械不变量，只替换信息论决策*。若审阅要求"完全不依赖官方 basic 实现"，则退 A，需相应延长里程碑。

### 2.3 关键未知 —— 已核实（源码级证据）

| 问题 | 结论 | 证据 |
|---|---|---|
| 覆盖 `compactIfNeeded` 后是否被调用 | **是**。自动路径两处都是 `this.compactIfNeeded(...)` 动态分派 | `dsh-compaction-basic/lib/index.js` L839 `ctx.on("agent/pre-step")` → L841；L861 `ctx.on("agent/request-error")` → L872。源码注释原文：`compactIfNeeded` stays dynamically dispatched so subclass overrides are honored at event time |
| disable 原生行会丢失溢出恢复吗 | **不会**。两个 listener 由**实例自己的构造函数**注册（L827 `if (this.config.auto) this._registerAutomaticCompaction()`）。我们实例化自己的子类，listener 照旧注册，决策走我们的 override | 同上 L827 / L834 |
| `compactRegion` 可复用性 | **可复用**（public），内部走 `compactSurfaceRegion(regionDependencies(), ...)` | `compactRegion` 实现 + `regionDependencies()` 提供 `{meter, summarize, recover}` |
| 内部切分函数能否复用 | **不能**。`selectCompactableRange`（L410）未导出，唯一导出是 `BasicCompactionEngine`（L1027） | 故 D2/D3 必须自研（议题 #5） |
| 核心包可用的公开工具 | `CompactionEngine, CompactionId, ManualCompactionError, compactCheckpointSource, isCompactCheckpointSource, toolPairingBalancedBefore/After` | `dsh-compaction/lib/index.js` L175 |

**结论：方案 B 可行性已证实**，且比预想更稳：继承既有引擎 = 同时继承其自动触发注册、溢出恢复、事务内核与锁语义，我们只替换**决策函数**。

**新识别的实现风险**：官方自动路径对其 turn 归属与稳定性有更严的校验，而 `compactRegion` 的封装参数固定；override 后直接转调是否仍满足校验，列为议题 #4 的验收项。

---

## 3. 模块拆分与议题

拆解原则：**一个议题 = 一个可独立验收的能力 = 一个 <= 1000 行的 PR = 一个 owner**。

### M0 基建（**优先合并**）

| # | 议题 | 交付 | 依赖 |
|---|---|---|---|
| 1 | 仓库骨架 + CI 流水线 | package.json(`dsh.bundle.patch`/exports/engines) + cordis.patch.yml + `.github/workflows/ci.yml`(linux/win/mac + node22 lts) + 测试框架 + **禁止触碰真实 `~/.dsh` 的隔离守卫** | — |

> M0 单独先合：后续每个 PR 都必须在这条流水线上跑绿才允许合并，所以它必须最先进 main。

### M1 契约与接入层

| # | 议题 | 交付 | 依赖 |
|---|---|---|---|
| 2 | 引擎骨架 + 行替换接入 | `CodexCompactionEngine` 骨架（继承/自研按 2.2 决策）、disable 原生行 + insert 本插件、`--dump-config` 与 `--help` 冒烟脚本、假 session/假 llm 测试装置 | 1 |
| 3 | 类型契约与配置 schema | `Config`（schemastery）+ 加载期校验（非法值快速失败）+ 类型导出 | 2 |

### M2 决策层（Codex 策略）

| # | 议题 | 交付 | 依赖 |
|---|---|---|---|
| 4 | D1 触发策略 | Codex 风格触发算式 + 溢出恢复路径 | 3 |
| 5 | D2/D3 切分与保留 | 结构化范围选择器：按对话结构保留近期窗口、C1 配对平衡、C2 跳过节点 0、无安全范围时零写入 | 3 |
| 6 | D4 摘要模板 | Codex 风格结构化摘要提示词 + 输出投影（稳定字段、纯文本、排除推理/工具调用） | 3 |
| 7 | D4 摘要调用 | 缓存友好回放（system+tools+被遮蔽区域）、路由与输出上限解析、取消转发 | 6 |
| 8 | D5 注入与续跑提示 | 替换消息的注入形态（与 `compactCheckpointSource` 契约一致） | 6 |

### M3 稳定性层

| # | 议题 | 交付 | 依赖 |
|---|---|---|---|
| 9 | 幂等与防漂移 | 多次压缩叠加语义、压缩的压缩、稳定标记与摘要漂移抑制 | 5,7 |
| 10 | 失败与降级 | 摘要失败恢复（`compaction/summary-error` waterfall）、取消语义、错误分级（`ManualCompactionError` 码） | 2,7 |

### M4 验证层

| # | 议题 | 交付 | 依赖 |
|---|---|---|---|
| 11 | 引擎级测试矩阵 | 表驱动单测：触发边界、切分不变量（C1/C2）、零写入、事务序列断言 | 4,5,10 |
| 12 | 真实运行时冒烟 | 装进隔离 profile、`--dump-config`、真实会话触发一次压缩、与 `dsh@next` 兼容检查 | 1..10 |
| 13 | 可观测性 | `/compact` 端到端、压缩前后 token 账目、诊断日志 | 8,11 |

### M5 交付层

| # | 议题 | 交付 | 依赖 |
|---|---|---|---|
| 14 | 文档 | README / README.zh / 架构说明（含"与原生策略差异"对照表）/ 安装与回滚 | 12,13 |
| 15 | 发布 | `release.yml`、npm pack 校验、安装验证指南 | 14 |

---

## 4. 协作规约（硬约束）

1. **议题认领制**：每个议题先 `claim` 再动手；未认领的议题不得开 PR。一个议题同一时刻只有一个 owner。
2. **PR <= 1000 行**（含测试与文档，按 diff 行数计）。超限即拆成新议题，不破例。
3. **强制 CI**：main 分支保护要求 `ci / linux`、`ci / windows`、`ci / macos` 全绿才可合并。合并前本地必须跑同一套脚本（`node --test`、隔离守卫、自检、`npm pack --dry-run`）。
4. **写入范围互斥**：开工前登记本议题会碰的文件前缀；与他人重叠即停，先协调。
5. **第一性原则审查**：每个 PR 必须回答"本改动对应 1.3 的哪一维、触发了哪条不变量"；答不出即设计未收敛。
6. **证据纪律**：所有对 dsh 行为的断言须给出文件+函数级证据；区分 [证据] / [推断] / [未验证]。外部资料一律不作为实现依据。
7. **红线**（来自 `dsh-plugin-construction` skill）：`@deepseek-ai/*` 共享宿主包只能进 `peerDependencies` + `devDependencies`，**绝不进 `dependencies`**；不新增会话事件 `type`；不读写未 `inject` 的服务；覆盖已存在行时 `config` 是整体替换。
8. **不碰真实环境**：测试一律用临时 `DSH_HOME`，CI 有守卫脚本兜底。

---

## 5. 里程碑顺序

```
M0(#1) --> [合并门禁] --> M1(#2,#3) --> M2(#4..#8) --> M3(#9,#10) --> M4(#11..#13) --> M5(#14,#15)
```

M2 的 #5 / #6 可并行（不同 owner、写入范围不重叠）；#7、#8 依赖 #6 的模板定型。

### 5.1 终态复核（2026-10-18）

立项时的里程碑已全部走完。**下表是复核过的真实状态**，不是计划意图；证据可逐条回查。

| 议题 | 终态 | 证据 |
|---|---|---|
| #1 骨架 + CI | ✅ 完成 | 三平台 `node --test` + 隔离守卫 + `npm pack`；分支保护 strict |
| #2 引擎骨架 + 行替换 | ✅ 完成（自动化载体是**非门禁**的 `ci / compat-next`，见终验 F5） | `cordis.patch.yml`；`smoke-runtime.mjs` A1–A3 实测 |
| #3 配置 schema | ✅ 完成 | `lib/core/config.js` `CONFIG_FIELDS`；`test/config.test.mjs` |
| #4 D1 三段式 | ✅ 完成 | `lib/core/trigger.js`；`test/trigger.test.mjs` |
| #5 D2/D3 结构化切分与保留 | ✅ **完成**（不再是"进行中"） | `lib/core/select.js`（C1 平衡单元 + 双端吸附 + 零写入）；`test/select.test.mjs` |
| #6 D4 摘要模板与投影 | ✅ 完成 | `lib/core/prompt.js`；`test/prompt.test.mjs` |
| #7 D4 摘要调用（回放/路由/取消） | ✅ **完成**（不再是"未开始"） | `lib/core/summarize.js`；`test/summarize.test.mjs`；真实会话 `cacheReadTokens` 非零 |
| #8 D5 注入形态 | ⚠️ **未达成** | issue 仍 OPEN；相邻性与 `source.kind` 已由 `test/transaction-sequence.test.mjs` 断言，但"不给模型漏内部 id"无断言 |
| #9 幂等与防漂移 | ✅ 完成 | `lib/core/idempotence.js` + 引擎 ledger/admit/antiDrift；`test/idempotence.test.mjs` |
| #10 失败与降级 | ✅ 完成 | `lib/core/errors.js`；`test/errors.test.mjs`、`test/transaction-sequence.test.mjs` |
| #11 测试矩阵 | ✅ 完成：终验的 2 条存活变异（F1 屏障比例、F2 单元起点）已由 #46 修复。**已在 rebase 后的 main 上独立复测这两条变异，均被抓住**：F1（`releasesEnough` 恒为 true）→ `test/select.test.mjs` 24 pass / 1 fail；F2（单元起点去掉平衡守卫）→ 全量 257 pass / 1 fail；未变异基线 258 / 0 | `test/select.test.mjs`、`test/invariants.test.mjs` |
| #12 真实运行时冒烟 | ✅ 完成：装配层 + **会话级已在真实模型上验证通过** | `scripts/smoke-runtime.mjs` A1–A7；`runtime-verification.md` §3/§4 |
| #13 可观测性 | ✅ **模块 + 接线已合**；边界：**报告行尚未在真实会话日志中被观察过** | `lib/core/telemetry.js` + 测试；`lib/engine.js` 已 import `buildCompactionReport/renderCompactionReport/reportLevel` |
| #14 文档 | ✅ 完成 | README / README.zh / architecture / release / runtime-verification |
| #15 发布 | ✅ 完成 | `release.yml` + `scripts/verify-pack.mjs`（10/10 故障注入）；Web UI 外观未验证 |

**仍未闭合的两处**（不要读成"项目还早"，也不要读成"全部完成"）：**#8**（D5 注入形态缺断言），
以及 **#13 的报告行尚未在真实会话日志中被观察过**（模块与接线都已合，但没有实测过它的输出）；
另有 A7 **不**证明的三件事（长会话质量 / 默认 `0.9 × W` 阈值下的时机 / 跨 tool-call 切割），
见 [`docs/runtime-verification.md`](runtime-verification.md) §4.3。

---

## 6. 风险与未验证项

| 风险 | 影响 | 缓解 | 终态 |
|---|---|---|---|
| 溢出恢复 listener 随 `disabled: true` 丢失 | 上下文溢出后无法自愈 | #4 的验证任务先出结论；必要时自建 listener | ✅ **已消解**：两个 listener 由实例构造函数注册，继承即继承（§2.3 源码证据） |
| `dsh-compaction-basic` 内部结构随版本变动 | 继承点破裂 | 版本区间锁定 + `ci / compat-next` 作业（非门禁，红不阻塞） | ⏳ **持续**：`compat.yml` 已上线 |
| Codex 语义与 DSH 契约不完全对齐（如 Codex 无 tool-pairing 约束） | 直接照搬会产出非法请求 | 以 C1-C5 为上位约束，Codex 只借**策略**不借**契约** | ✅ **已按此实施**（`docs/codex-dsh-mapping.md`） |
| 摘要成本上升（结构化模板更长） | 每次压缩更贵 | 模板字段按"续跑必需"最小集，expensive 字段可选 | ✅ 已实施；真实会话实测 `cacheReadTokens=8064`（前缀缓存命中） |
| 多轮压缩语义漂移 | 长会话质量衰减 | #9 专项 | ✅ 已实施（#9）；**但长会话质量仍未实测**（A7 只观测到一次压缩） |

## 7. 决策点（**已逐条收敛**）

- **Q1 架构** → **B（策略层继承）**，已实施；§2.3 的源码证据 + A7 实测共同证实。
- **Q2 兼容基线** → 只锁 `0.2.1-rc.2` 并验证；`dsh 0.2.0-rc.2` **未验证**（`engines.dsh` 未声明，
  因此兼容性由 peer 区间决定）。`ci / compat-next` 持续观察 `dsh@next`。
- **Q3 配置默认** → **Codex 三段式**（`triggerLimitRatio 0.9` / `effectiveWindowPercent 0.95` /
  `turnEndPercent 0` / `triggerBufferTokens 0`）+ 结构保留，见 `docs/design-m1-m2.md` §5。
- **Q4 交付形态** → 发 npm 包（bundle 形态）；安装走 `dsh plugin add`，未做"一键替换 profile"脚本。
- **Q5 议题粒度** → 保持 15 个议题 + 后续补充议题（#22 守卫、#38 幂等接线等），未再合并。
