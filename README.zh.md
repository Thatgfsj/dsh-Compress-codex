# dsh-compress-codex

一个 DSH **bundle**：在 `ctx.compaction` 接缝上把压缩策略换成 **Codex 风格**——
事务契约仍用 DSH 的，只换策略。

- 五个自由度 **D1 触发 / D2 切分 / D3 保留 / D4 摘要 / D5 注入**：[`docs/PLAN.md`](docs/PLAN.md) §1.3
- Codex 源码级规格（每条结论都带文件+行号证据）：[`docs/codex-notes.md`](docs/codex-notes.md)
- Codex → DSH 对齐表（含"不可照搬"清单）：[`docs/codex-dsh-mapping.md`](docs/codex-dsh-mapping.md)
- 分层、接缝与事务：[`docs/architecture.md`](docs/architecture.md)
- 已验证 / 未验证边界：[`docs/runtime-verification.md`](docs/runtime-verification.md)

> **接入前请先看这四条**——它们比功能清单重要：
> 1. **宿主包只在 dsh 启动进程内可解析**，见 [§5.1](#51-宿主包无法从-profile-目录解析)。
> 2. **不要用 `web` 模板做冒烟**——它本身就禁用了 `compaction-basic`，会得到假绿（[§5.2](#52-web-模板是假绿)）。
> 3. **`disabled: true` 是承重的**：少了它两个引擎会同时注册 `compaction`，组合期直接 fatal（[§5.3](#53-禁用官方行是承重的)）。
> 4. **并非全部已验证**，见 [§6](#6-当前状态哪些能用)。

---

## 1. 为什么做这个

官方 `@deepseek-ai/dsh-compaction-basic` 本身是可靠的后端，但它有三点策略特性，本项目视为缺陷
（[`docs/PLAN.md`](docs/PLAN.md) §1.4）：

| # | 官方行为 | 为什么有害 |
|---|---|---|
| 1 | 保留是 **token 比例**（`retainRatio: 0.16` × `W − O`） | 分不清"最近三轮任务上下文"和"更早的 5 万 token 工具日志"；它不建模对话结构 |
| 2 | 摘要是 **自由文本** | 没有面向续跑的稳定字段（进展/决策/下一步/触碰的文件），resume 后要重新学上下文 |
| 3 | 多次压缩 **没有防漂移约定** | 每轮再编码一次，质量静默衰减 |

Codex 对这三条都有答案——但只有一部分能通过 DSH 的 C1–C5 约束。对齐表逐条标了
**可照搬 / 需改造 / 不可照搬**。

## 2. 怎么接入

它是一个 bundle：`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`，
后者对 `dsh-base` 拥有的层只做两件事：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true                 # 保证 ctx.compaction 只有一个实现
- insert:
    - id: compaction-codex
      name: 'dsh-compress-codex'
      config: {}
```

`command-compact`（`/compact`）与 `tool-result-pruner` 刻意不动：它们与后端无关。

## 3. 安装

需要带插件 CLI 的 DSH（已在 `dsh 0.2.1-rc.2` 验证）以及 `PATH` 上的 `pnpm`。

```sh
# 从本地 checkout
dsh plugin --profile <你的 profile> add /path/to/dsh-Compress-codex

# 或从 registry / tarball
dsh plugin --profile <你的 profile> add dsh-compress-codex
```

然后**不启动任何东西**先确认层已生效：

```sh
dsh --profile <你的 profile> --dump-config | grep -B1 -A3 -E 'id: compaction-(basic|codex)'
```

期望：`compaction-basic` 为 `disabled: true`，**并且**带
`patched by dsh-compress-codex` 标注；`compaction-codex` 解析到 `dsh-compress-codex`。
**标注很关键**——单看 `disabled: true` 无法排除"模板本来就禁用了"（[§5.2](#52-web-模板是假绿)）。

### peer 依赖

`@deepseek-ai/cordis`、`@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/schemastery`
是 **peerDependencies**（同时也是 devDependencies）。**绝不能**挪进 `dependencies`：
宿主共享同一实例，第二份拷贝会导致解析失败。link 安装时它们在 profile 的
`node_modules` 里不会被解析——这是正常的，也正是 [§5.1](#51-宿主包无法从-profile-目录解析) 存在的原因。

### 配置

行 `config` 是**整体替换**而非深合并。所有键可选；未知键在挂载期直接失败，
不会静默退回默认值。完整说明见 [`docs/codex-impl-checklist.md`](docs/codex-impl-checklist.md) §1.1。

| 键 | 默认 | 含义 |
|---|---|---|
| `triggerLimitTokens` | — | 绝对触发上限（对应 Codex `config.limit`） |
| `triggerLimitRatio` | `0.9` | `limit = min(triggerLimitTokens ?? ∞, floor(W × ratio))` |
| `effectiveWindowPercent` | `0.95` | 硬满上限 `full = floor(W × percent)` |
| `triggerBufferTokens` | `0` | 缓冲**加在 limit 侧** |
| `turnEndPercent` | `0` | 轮末检查；`0` 表示关闭 |
| `overflowRecovery` | `true` | `CONTEXT_WINDOW_EXCEEDED` 时旁路阈值 |
| `retainMode` | `'structural'` | 按对话结构保留，而非 token 比例 |
| `retainRecentUnits` | `3` | 逐字保留最近 N 个结构单元 |
| `retainTokens` | — | **软**上限：整单元进/出，绝不切半对 |
| `summaryTemplate` | `'codex-v1'` | 模板版本号，用于度量漂移 |
| `summaryExtraFields` | `['files','pitfalls']` | Codex 四条 + 我们的两条扩展字段 |

## 4. 验证

三级阶梯，从最便宜的开始：

1. **组合层** —— `dsh --profile <p> --dump-config`（见 §3）。任何陈旧的 override 会打印
   `patch: entry "<id>" not found`；**这条警告只在 `--dump-config` 里出现**。
2. **真实启动（离线）** —— `node scripts/smoke-runtime.mjs`：用临时 `DSH_HOME` 把本 bundle
   装进极小 profile，断言组合层、负控，**以及在真实启动的 dsh 进程内真的挂载成功**。
3. **会话层** —— 尚不可用，见 §6。

```sh
node scripts/smoke-runtime.mjs          # A1-A6；A7 在 M2 完成前 SKIP
SMOKE_KEEP=1 node scripts/smoke-runtime.mjs   # 保留临时 home 以便排障
```

**skip 不是 pass**：缺少 `dsh`/`pnpm` 时脚本打印 `SMOKE RESULT: SKIPPED` 并退出 0
（以免阻塞门禁），此时必须按"未验证"上报。

## 5. 四个坑

### 5.1 宿主包无法从 profile 目录解析

```sh
cd "$DSH_HOME/profiles/<p>" && node --input-type=module -e "await import('@deepseek-ai/dsh-compaction-basic')"
# -> ERR_MODULE_NOT_FOUND
```

但在 dsh 启动进程内**同样的 import 会成功**：宿主包的解析由启动期的安装域解析提供。
profile 的 `node_modules` 里只有 link 进来的插件本体。
**所以"用裸 node 从 profile 目录解析宿主包"的断言会得到假阴性**；正确做法是在真实启动内断言挂载
（`smoke-runtime.mjs` 的 A6 就是这么做的）。证据：[`docs/runtime-verification.md`](docs/runtime-verification.md) §5.1。

### 5.2 `web` 模板是假绿

`web` 模板**本身就禁用了 `compaction-basic`**（该行归属 `@deepseek-ai/dsh-web-app`）。
用它做 `--dump-config`，即使本 bundle 不存在也会显示 `disabled: true`——断言恒真。
请用 `dsh plugin add` 的极小栈，并始终保留负控 profile。证据：
[`docs/runtime-verification.md`](docs/runtime-verification.md) §1。

### 5.3 `disabled: true` 是承重的

少了它，两个引擎都会注册 `compaction`，组合期直接崩：

```
dsh: fatal load failure: Error: service "compaction" has been registered at <BasicCompactionEngine>
  at new CodexCompactionEngine (lib/engine.js)
```

所以不要"顺手清理"这条 op。证据：[`docs/runtime-verification.md`](docs/runtime-verification.md) §5.2。

### 5.4 `--help` 不能当冒烟入口

`dsh --profile <p> --help` 在 plugin-add 的 profile 上会**挂住**（实测 60s / 120s 均超时）。
改用无提示词的离线启动——不联网、不需凭据、约 2s 退出：

```sh
dsh --profile <p> --patch <overlay.yml> </dev/null
```

## 6. 当前状态：哪些能用

| 维度 | Codex 目标 | 状态 |
|---|---|---|
| D1 触发 | 三段式（`0.9` / `0.95` / 轮末 / buffer） | **已实现**（#4） |
| D2 切分 | 结构单元、C1 配对切割 | **已实现**（#5） |
| D3 保留 | 最近结构单元逐字保留 | **已实现**（#5） |
| D4 摘要 | `codex-v1` 模板 + 输出投影 | **已实现**（#6 模板、#7 调用） |
| D5 注入 | DSH 既有框架（不应自行发明） | 受基类事务约束——这是设计使然 |

**已验证**（[`docs/runtime-verification.md`](docs/runtime-verification.md)）：
- 装配 + 真实启动（§3）：装进极小 profile；`compaction-basic` 被禁用**且归因到本 bundle**；
  `compaction-codex` 已挂载；无陈旧 override 警告；负控仍然启用；**真实启动内**解析出真基类
  并构造出 `CodexCompactionEngine`；
- **真实模型上的端到端**（§4）：真实两轮会话产生
  `compaction/start(21) → compaction/summary(23) → user/message(24) → compaction/end(25)`，
  且 `provider=deepseek-official`、`model=deepseek-flash`、`cacheReadTokens=8064`。

**未验证**：展示元数据在 **Web UI 中的实际渲染**（`scripts/verify-pack.mjs` 已断言其可解析且完整，
但**没有截图**，见 §9）；`npm publish` 本身（本仓库无 `NPM_TOKEN`）；多次压缩叠加下的长会话质量（#9）；
以及**默认 `0.9 × W` 阈值**在真实长会话中的触发时机（§4.3）。

## 7. 回滚

```sh
dsh plugin --profile <你的 profile> remove dsh-compress-codex   # 依赖 + 层一起移除
dsh --profile <你的 profile> --dump-config | grep -B1 -A3 'id: compaction-basic'
```

`compaction-basic` 必须恢复为**启用**，且**不再**带 `patched by dsh-compress-codex` 标注。
核选项：用 `dsh plugin --profile <你的 profile> --from-default-profile <模板>` 重建，
或确认绝对路径后直接删除 `$DSH_HOME/profiles/<你的 profile>`。所有写入都在 `$DSH_HOME` 内。

## 8. 仓库结构

```
lib/core/**   纯决策层——完全不 import '@deepseek-ai/*'
lib/engine.js 引擎工厂；宿主部分靠注入，自身仍不 import 宿主包
lib/index.js  唯一出现宿主包名的地方，且用动态 import
cordis.patch.yml  bundle 层（disable + insert）
scripts/       隔离守卫、dump-config 冒烟、运行时冒烟
test/          node --test 套件，零 node_modules 也能跑
docs/          PLAN、Codex 规格、对齐表、实现清单、架构、运行时验证
```

分层不是装饰：门禁以 `node --test` 运行且**不装依赖**，所以 `lib/core` 里任何宿主 import
都会让后续每个 PR 变红（由 `test/layering.test.mjs` 断言）。

## 9. 许可证

MIT —— 见 [LICENSE](LICENSE)。
