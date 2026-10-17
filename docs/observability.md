# 压缩可观测性（issue #13）

> 面向：运维/维护者。回答三个问题：**为什么（没）压缩**、**选了哪一段**、**释放了多少 token**。
> 数据来源：`lib/core/telemetry.js`（归一与渲染）、D1 `lib/core/trigger.js`、选择器 `lib/core/select.js`、失败分级 `lib/core/errors.js`。

## 0. 接线状态（诚实优先）

报告模块已经完成并有判别性测试（`test/telemetry.test.mjs`），但**engine 的接线尚未落地**：`lib/engine.js` 正被 task-14(#9 幂等) 占用，接线按协作规约拆成紧随其后的独立小 PR（不 stack、不抢同一文件）。

**在接线 PR 合并前，报告不会自动出现在日志里。** 本文档描述的字段与读法在模块层已经由测试固定；接线只是把
`buildCompactionReport(...)` 的结果交给 `ctx.logger`。

## 1. 报告长什么样

未触发（每步都可能产生，因此是 debug 级）：

```text
dsh-compress-codex: compaction report: pressure / skipped
  why   : no compaction needed: below both thresholds (window 200000, active 120000, scope 90000, limit 180000, full 190000, threshold 180000, buffer 0)
  span  : none — no range was selected for this decision
  tokens: released unmeasured, window 200000
```

触发并压缩成功（info 级）：

```text
dsh-compress-codex: compaction report: pressure / compacted
  why   : compaction ran: the scoped context reached the buffered limit (window 200000, active 150000, scope 185000, limit 180000, full 190000, threshold 180000, buffer 0) [limit reached]
  span  : [12..48] shadowing 8 unit(s) / 37 node(s), retaining 3 unit(s); token budget applied; in-history system/message kept visible; barrier cost: 2 node(s) not released (preference declined); edge checks injected
  tokens: released 7400 token(s), retained tail 4800 token(s), window 200000
```

四行固定：header（trigger / outcome）、`why`、`span`、`tokens`。`why` **永不为空**——没有数字时说"没有数字"，没有失败详情时说"没有失败详情"。

## 2. 六种 outcome

| outcome | 含义 | 级别 |
|---|---|---|
| `delegated` | 本层不接管（如窗口未知），官方后端继续决策 | debug |
| `skipped` | 本层拥有决策且未跨阈值：零写入 | debug |
| `blocked` | 本层要压，但找不到 C1/C2 安全范围（选择器给出原因） | info |
| `compacted` | 事务成功提交 | info |
| `degraded` | 摘要失败、重试一次后仍失败：锁已释放，会话继续（#10） | info + warn/error |
| `failed` | 失败原样抛出（busy/changed/commit/persistence/取消） | info + warn/error |

## 3. 字段字典

### 3.1 D1（`why` 的来源）

reason 码表（`lib/core/trigger.js`）：

| reason | 读法 |
|---|---|
| `d1-full-reached` | 活跃上下文触及硬满上限 `floor(W × effectiveWindowPercent)` |
| `d1-limit-reached` | scope 用量触及 `min(triggerLimitTokens, floor(W × triggerLimitRatio)) + triggerBufferTokens` |
| `d1-below-threshold` | 两侧都没到：不触发（零写入） |
| `d1-context-overflow-bypass` | provider 确认溢出：旁路全部阈值，强制一次缩减 |
| `d1-overflow-recovery-disabled` | 策略关闭了溢出恢复：交还官方后端 |
| `d1-no-window` | 解析不到路由窗口：本层不接管（接管并 skip 会连官方策略一起禁用） |

numbers：`windowTokens / activeTokens / scopeTokens / limitTokens / fullTokens / thresholdTokens / bufferTokens / turnEndPercent` 与三个布尔 `limitReached / fullReached / turnEndReached`。百分比一律整数运算（交叉相乘），报告直接展示参与比较的整数。

### 3.2 选择器（`span` 的来源，`lib/core/select.js`）

| 字段 | 含义 |
|---|---|
| `status` | `shadow`（有可替换范围）或 `none`（零写入 + 原因） |
| `reason` | 人话原因；`none` 时就是"为什么不压" |
| `start / end / retainFrom` | 被遮蔽范围的闭区间 seq，与首个逐字保留节点 |
| `shadowedUnitCount / retainedUnitCount / unitCount` | 结构单元数（unit = C1 平衡区间） |
| `shadowedNodeCount` | 被遮蔽的 surface 节点数 |
| `tokenBudgetApplied / retainedTokens` | 是否用了软预算 `retainTokens`，尾部实测 token |
| `systemBarrier` | `none` / `kept`（历史中的 system/message 让开保留）/ `crossed`（一并遮蔽） |
| `systemBarrierPreference / SkippedUnits / SkippedNodes` | 屏障让开的偏好与**代价**：为保留它而少释放的单元/节点数（#31） |
| `edgeChecks` | `injected`（宿主权威 C1 切点）或 `local`（纯回退实现） |

### 3.3 失败（#10）

`action`（retry/degrade）、`attempt`、`error.code`（busy/cancelled/changed/summary/commit/persistence）、`error.name`、`error.message`、`error.causes`。判读见 `lib/core/errors.js`。

## 4. 排查手册：为什么这次没压？

1. 看 `outcome`：`delegated` → 本层没接管，`why` 给出 `d1-no-window` 之类的理由；
2. `skipped` → 对比 `why` 里的 `active` vs `full`、`scope` vs `threshold`，就是没到阈值；
3. `blocked` → 到阈值了，但选择器说明为什么没有安全范围（例如"结构保留把全部可压单元都保留"、"每个候选切点都会切断 tool-call 对"）；
4. `degraded`/`failed` → 看 `error.code`：`summary` 是摘要失败（已重试一次）；`busy` 说明锁已被占用（真正的问题在别处）；`cancelled` 是调用方取消。

## 5. token 账目怎么读

- **released**：被遮蔽范围内 priced 节点的实测 token 之和。**`released unmeasured` 不等于 0**——没有可用计价就没有数字，绝不编造。
- **retained tail**：选择器实测的尾部保留 token（软预算 `retainTokens` 下可超）。
- **barrier cost**：为让历史中的 `system/message` 保持可见而**少释放**的节点数；它解释了"为什么 released 小于整个 span 的节点量"。
- **window**：参与 D1 比例计算的容量（解析不到时显示 unknown）。

## 6. 噪声策略

`skipped`/`delegated` 出现在**每一步**，所以固定为 `debug`；`blocked`/`compacted`/`degraded`/`failed` 为 `info`。失败细节仍由 #10 走 `warn`（重试）/`error`（降级）。**不新增会话事件 type**（PLAN §4.7 红线），只走 `ctx.logger`。

## 7. 未验证边界

本文档描述的字段与渲染由单元测试 + 变异测试覆盖；**真实会话端到端仍未验证**：#12 需要模型凭据，而本机凭据在 dsh 凭据存储（`~/.dsh/.credentials.yaml` 的 refs）而非环境变量，与"测试必须使用临时 DSH_HOME"的隔离约束冲突。因此不要据此文档声称"已在真实会话验证"。
