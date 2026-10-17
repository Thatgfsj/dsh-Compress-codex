# dsh-Compress-codex — 项目计划（待审阅）

> 状态：**计划稿，等待 owner 审阅**。审阅通过前不写实现代码、不合并任何 PR。
> 仓库：https://github.com/Thatgfsj/dsh-Compress-codex
> 目标版本：本机 `dsh --version = 0.2.1-rc.2`

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

### 1.5 目标：Codex 策略（调研结论见 `docs/codex-notes.md`，随 #1 一并落库）

> 本节在 Codex 调研（`openai/codex` 源码）回填后定稿；不得以"印象中的 Codex"替代源码证据。

待填字段：D1 触发算式、D2 切分边界、D3 保留点、D4 模板字段清单、D5 注入标记与续跑提示。

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

### 2.2 三个候选架构（**待审阅拍板**）

| 方案 | 做法 | 优点 | 代价 / 风险 |
|---|---|---|---|
| **A 全自研** | `extends CompactionEngine`，自己实现全部三个抽象方法 + 事务 + 溢出恢复 | 最彻底 | 需重写事务、锁、drop/重试、持久化、replay、图片处理；#工作量 3-5x，回归面大 |
| **B 策略层继承（推荐）** | `extends BasicCompactionEngine`，override `compactIfNeeded` / `compactNow` / `summarize`，复用其 `compactRegion` 事务内核 | 只替换 D1-D5 决策层，机械层（事务/计价/重试/持久化）复用官方实现；官方文档明确 `compactIfNeeded` 为动态分派，是**设计好的继承点** | 依赖 `dsh-compaction-basic` 内部结构稳定性；须声明 peerDependency |
| C 旁路改写 | 不 disable 原生，监听事件改写 | 无 | 无法真正替换策略，**不满足"抛弃原生压缩方式"**，淘汰 |

**推荐 B**，理由是第一性原则的取舍：*保留被验证过的机械不变量，只替换信息论决策*。若审阅要求"完全不依赖官方 basic 实现"，则退 A，需相应延长里程碑。

### 2.3 关键未知（已在验证中，随审阅一并汇报）

- 覆盖 `compactIfNeeded` 后，原生的**溢出恢复** listener（`agent/request-error` / `CONTEXT_WINDOW_EXCEEDED`）是否仍生效，或随 `disabled: true` 一起丢失 → 决定我们是否要自建该 listener。
- `compactRegion` 可复用性与其 `this` 依赖清单。
- `summarize()` 的 `SummarizationInput` 精确字段。

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

---

## 6. 风险与未验证项

| 风险 | 影响 | 缓解 |
|---|---|---|
| 溢出恢复 listener 随 `disabled: true` 丢失 | 上下文溢出后无法自愈 | #4 的验证任务先出结论；必要时自建 listener |
| `dsh-compaction-basic` 内部结构随版本变动 | 继承点破裂 | 版本区间锁定 + `ci / compat-next` 作业（非门禁，红不阻塞） |
| Codex 语义与 DSH 契约不完全对齐（如 Codex 无 tool-pairing 约束） | 直接照搬会产出非法请求 | 以 C1-C5 为上位约束，Codex 只借**策略**不借**契约** |
| 摘要成本上升（结构化模板更长） | 每次压缩更贵 | 模板字段按"续跑必需"最小集，expensive 字段可选 |
| 多轮压缩语义漂移 | 长会话质量衰减 | #9 专项 |

## 7. 待审阅决策点（请 owner 逐条批复）

- **Q1 架构**：选 A（全自研）/ **B（策略层继承，推荐）**？
- **Q2 兼容基线**：是否要求同时支持 `dsh 0.2.0-rc.2`，还是只锁 `0.2.1-rc.2` 并声明 `engines.dsh`？
- **Q3 配置默认**：默认沿用官方写法（比例）还是改为 Codex 的绝对阈值 + 结构化保留？
- **Q4 交付形态**：只发 npm 包，还是要一并产出"一键替换 profile"的安装脚本？
- **Q5 议题粒度**：15 个议题是否需要再合/再拆（尤其 M2 的 #7/#8）？
