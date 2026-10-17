# 压缩可观测性（issue #13）

> 面向：运维/维护者。回答三个问题：**为什么（没）压缩**、**选了哪一段**、**释放了多少 token**。
> 数据来源：`lib/core/telemetry.js`（归一与渲染）、D1 `lib/core/trigger.js`、选择器 `lib/core/select.js`、失败分级 `lib/core/errors.js`。

## 0. 接线状态

报告模块与 engine 接线均已落地：`compactIfNeeded` 保留完整的 D1 结果与选择结果，按 outcome 调
`buildCompactionReport(...)` → `renderCompactionReport(...)` → `ctx.logger[reportLevel(outcome)]`，第二个参数是结构化报告对象。

两条实现细节值得知道：

- **blocked 是唯一多付一次代价的路径**：注入的选择器 hook 在"无安全范围"时只回答 `null`（冻结契约，带不了原因），
  因此只有这条路径额外跑一次**只读**的 `planCompactionRange` 取原因；正常决策路径不多跑选择器。
- **没有 debug 通道的 logger 不会收到 per-step 报告**（见 §6），所以默认日志级别下不会因为可观测性而刷屏。

接线由 `test/telemetry.test.mjs` 的引擎级用例锁定（skipped/delegated/blocked/noop/compacted/degraded/failed 各一条）。

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

## 2. 七种 outcome

| outcome | 含义 | 级别 |
|---|---|---|
| `delegated` | 本层不接管（如窗口未知），官方后端继续决策 | debug |
| `skipped` | 本层拥有决策且未跨阈值：零写入 | debug |
| `blocked` | 本层要压，但找不到 C1/C2 安全范围（选择器给出原因） | info |
| `noop` | **本层拥有决策但刻意不跑**：区间里只有既有 checkpoint（#9 R1），或该区间已按同一代+同一内容指纹压过（#9 账本） | debug |
| `compacted` | 事务成功提交 | info |
| `degraded` | 摘要失败、重试一次后仍失败：锁已释放，会话继续（#10） | info（另有 #10 的 warn/error 告警） |
| `failed` | 失败原样抛出（busy/changed/commit/persistence/取消） | info（重试/降级另由 #10 告警；被抛出的错误由宿主呈现） |

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
4. `noop` → 到阈值且有范围，但**刻意没跑**：`r1-pure-checkpoint-region`（区间里只有既有 checkpoint，再压一次是纯损失）或 `i2-same-range-same-checkpoint`（同区间同代同指纹已压过，见 #9）；
5. `degraded`/`failed` → 看 `error.code`：`summary` 是摘要失败（已重试一次）；`busy` 说明锁已被占用（真正的问题在别处）；`cancelled` 是调用方取消。

## 5. token 账目怎么读

- **released**：被遮蔽范围内 priced 节点的实测 token 之和。**`released unmeasured` 不等于 0**——没有可用计价就没有数字，绝不编造。
- **retained tail**：选择器实测的尾部保留 token（软预算 `retainTokens` 下可超）。
- **barrier cost**：为让历史中的 `system/message` 保持可见而**少释放**的节点数；它解释了"为什么 released 小于整个 span 的节点量"。
- **window**：参与 D1 比例计算的容量（解析不到时显示 unknown）。

## 6. 噪声策略

`skipped`/`delegated`/`noop` 可能出现在**每一步**，所以固定为 `debug`；`blocked`/`compacted`/`degraded`/`failed` 为 `info`。失败细节另由 #10 走 `warn`（重试）/`error`（降级）。**不新增会话事件 type**（PLAN §4.7 红线），只走 `ctx.logger`。

logger 若**没有 debug 通道**，per-step 报告直接不发（而不是升级到 info）——避免把每步决策变成噪声；`info` 及以上始终发送。

## 7. 验证边界（逐条区分，2026-10-18）

- **模块与接线**：`test/telemetry.test.mjs` 20 条用例（含 6 条引擎级接线用例）覆盖；变异测试 7/7 被抓。
- **会话级 D4 事务**：**已验证**，由 #12/A7 在真实模型上完成（见 `docs/runtime-verification.md` §4：
  真实两轮会话产生完整序列 `compaction/start → compaction/summary → user/message → compaction/end`，
  且 `compaction/summary` 的 provider/model 非空）。注意那次运行发生在**本接线之前**，它证明的是
  "压缩真的发生"，**不是**"本报告在真实会话里被打印过"。
- **本报告的运行时输出**（真实会话日志里实际出现的 report 行）：**未验证**。需要在有凭据的环境按
  `SMOKE_SESSION=1` 复跑一次并采集日志；A7 的凭据是一次性豁免（真实凭据复制进临时 home），
  普通运行会 SKIP（`skip 不是 pass`）。
- **Web UI 展示**与 **npm publish**：未验证，口径见 `docs/runtime-verification.md` §9 与 `docs/release.md`。

不要把本页读成"端到端已验证"：端到端验证的是压缩事务；本页新增的是**接线与报告格式**，它的证据是单元与变异测试。
