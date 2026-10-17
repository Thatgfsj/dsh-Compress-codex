# Codex 策略实现清单（D1 / D3 / D4 最小集）

> **面向**：M2 实现者（议题 #4 / #5 / #6）。
> **规格与证据来源**：`docs/codex-notes.md`（Codex 基线 commit `ce0323f2f2d3b25e82806cd555237da3db4e1897`）。
> **契约与配置面来源**：`docs/design-m1-m2.md`（D1 配置面以 PR #18 的三段式修正为准）。
> **图例**：**[证据]** = 有 Codex 源码/模板直接支撑；**[推断]** = 由源码推导；**[DSH 自研]** = Codex 无此机制，本项目必须自己定义。
> **边界**：本文件只写"怎么做"，不重复源码规格；规格一律回查 `codex-notes.md`。

---

## 0. 落点与职责

| 议题 | 落点 | 覆盖方法 | 复用（不要重写） |
|---|---|---|---|
| #4 D1 触发 | `lib/core/trigger.js` | `compactIfNeeded(agent, trigger, signal)` | `this.compactRegion(...)` 事务内核 [证据 design-m1-m2 §2.2] |
| #5 D3 保留 | `lib/core/select.js` | 同上 + `compactNow` | 同上；`selectCompactableRange` **不可用**，必须自研 [证据 design-m1-m2 §3] |
| #6 D4 摘要 | `lib/core/prompt.js` | `summarize(input, agent, signal)` | `this.regionDependencies()` 动态分派保证我们的 override 被事务层调用 [证据 design-m1-m2 §2.2] |

---

## 1. D1 三段式：实现顺序

### 1.1 配置 → 运行时量（命名以 `design-m1-m2.md` §5 为准）

| 配置 | 默认 | 含义 |
|---|---|---|
| `triggerLimitTokens` | 未设 | 绝对上限，对应 Codex `config.limit` [证据 openai_models.rs#L529-L541] |
| `triggerLimitRatio` | 0.9 | 窗口比例上限：`limit = min(triggerLimitTokens ?? ∞, floor(W * ratio))` [证据 openai_models.rs#L530] |
| `effectiveWindowPercent` | 0.95 | 硬满上限：`full = floor(W * percent)` [证据 openai_models.rs#L392-L395、context_window.rs#L84-L86] |
| `triggerBufferTokens` | **0** | 只加在 limit 侧 [证据 context_window.rs#L102-L103；config/mod.rs#L1244] |
| `turnEndPercent` | 0（关闭） | 轮末独立检查 [证据 config/mod.rs#L663-L664、context_window.rs#L111-L117] |

### 1.2 容量 `W` / `O` 从哪来 [证据]

- `W` = adapter-owned capacity。走 base 已解析的 `resolveCompactSpec(policy, contextWindow, reservedCompletionTokens)`（`dsh-compaction-basic/lib/types/config.d.ts#L29-L42`），**不要**从模型名猜窗口。
- 取不到 `W`（`resolved_context_window()` 为 None）→ **不触发**。Codex 同样返回 `None` 即不判 [证据 openai_models.rs#L529-L541]。

### 1.3 判定顺序（可直接照抄的结构）

```js
// 1) 硬满上限：不依赖 scope baseline，最先算
const full = Math.floor(W * effectiveWindowPercent);            // 0.95

// 2) scope 上限与已用
const limit = Math.min(triggerLimitTokens ?? Infinity,
                       Math.floor(W * triggerLimitRatio));       // 0.9
const scopeUsed = (scope === 'body-after-prefix')
  ? activeTokens - prefillBaseline
  : activeTokens;

// 3) 两个判定都算，OR 合并（语义等价；先 full 只因它不需要 baseline）
const fullReached  = activeTokens >= full;
const limitReached = scopeUsed >= limit + triggerBufferTokens;
const triggered    = limitReached || fullReached;
```

**为什么"先 full 后 limit"**（回答实现顺序问题）：
- `A || B` 的语义与顺序无关 [推断]；顺序只影响计算代价与短路路径。
- `full` 判定只依赖 `active` 与 `W`，**不需要** scope baseline；`BodyAfterPrefix` 下 baseline 可能尚未建立 → 先判 full 能短路掉 baseline 计算 [推断]。
- 关键陷阱：恢复的长会话里，**prefix 本身**就能让 `activeTokens >= full` 而 `scopeUsed ≈ 0` → 必须保留 full 分支，不能只判 limit。**[推断，必须有测试]**

**溢出旁路（#4 验收项）** [DSH 自研]：`trigger === 'context-overflow'` 时**旁路以上全部阈值**，强制一次最大平衡头部缩减；这是自愈路径，不得因自定义阈值而失效（`design-m1-m2.md` §3、`PLAN.md` §1.2）。

**轮末检查（独立）** [证据 context_window.rs#L111-L117]：
```js
const turnEnd = turnEndPercent > 0 &&
  (triggered || activeTokens * 100 >= full * turnEndPercent);
```

### 1.4 数值细节

- buffer 加在 **limit 侧**，不是从 full 里扣 [证据 context_window.rs#L102-L103]。
- 百分比比较用**交叉乘法 + 大整数**，不要用浮点：Codex 写 `i128::from(a) * 100 >= i128::from(b) * p` [证据 context_window.rs#L115-L116]。
- `limit`/`full` 用整数 `floor`（Codex 是 `(w * 9) / 10` 与 `w * p / 100`）[证据 openai_models.rs#L530、context_window.rs#L85]。

### 1.5 边界用例（直接映射 #4 验收）

| 用例 | 期望 |
|---|---|
| `scopeUsed === limit + buffer - 1` 且 `active < full` | 不触发 |
| `scopeUsed === limit + buffer` | 触发 |
| `scopeUsed === limit + buffer + 1` | 触发 |
| `active === full - 1`（scope 远低于 limit） | 不触发 |
| `active === full`（scope 远低于 limit，如 prefix 吃满） | 触发（full 分支） |
| `turnEndPercent = 0` | 轮末永不触发 |
| `turnEndPercent = 80`、`active * 100 >= full * 80` | 仅轮末触发 |
| `trigger === 'context-overflow'` 且所有阈值均未达 | 仍强制缩减一次 |

---

## 2. D3 保留算法伪码

### 2.1 Codex 原版（**仅作对照，不可照搬**）

- 在 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` 预算内，从最新往回**只保留 user 消息**；超预算的最后一条截断 [证据 compact.rs#L64、#L715-L819]。
- **为什么不能照搬**：只留 user 会让 assistant 的 `tool_call` 与它的 `tool_result` 分居两侧 → 请求在 provider 侧非法（违反 C1）。详见 `codex-dsh-mapping.md` 的 D3 行。

### 2.2 我们的版本：以 C1 平衡区间为原子 [DSH 自研]

```text
selectRetentionRange(session, { W, O, retainTokens, retainRecentUnits }):

  # 步骤 0：可压起点（C2）
  start = 第一个非 system surface 节点的 seq
  if 不存在 start: return null                 # 零写入

  # 步骤 1：切结构单元（原子），见 2.3
  units = splitIntoUnits(surface[start .. end])

  # 步骤 2：从最新往回累计（条数与预算双约束）
  kept = []; used = 0
  for u in units.reversed():
      if kept.length >= retainRecentUnits: break
      if used + u.tokens > retainTokens and kept.length > 0: break
      kept.unshift(u); used += u.tokens

  # 步骤 3：cut = 最早被保留单元的起始边界
  if kept.isEmpty(): return null
  cut = kept.first().startSeq
  if cut <= start: return null                 # 没东西可压 → 零写入

  # 步骤 4：C1 双端吸附 —— 只整单元回退，绝不切半对
  while cut > start and not toolPairingBalancedBefore(session, cut):
      cut = cut 所属单元的前一个单元的 startSeq
  if not toolPairingBalancedBefore(session, cut): return null

  # 步骤 5：返回待遮蔽范围（交给 this.compactRegion）
  return { start, end: cut }
```

### 2.3 结构单元（unit）的定义 [DSH 自研]

一个 unit = 一段连续 surface 节点，满足三条：
1. 起点是 `user/message`（新任务输入，或 system 之外独立注入的消息）；
2. unit 内部所有 assistant `tool_call` 都能在 **unit 内部**找到配对 `tool_result`；
3. 反向也成立：unit 内不存在引用了 unit 外 `tool_call` 的 `tool_result`。

**实现建议**：单次正序遍历 surface，维护"未配对调用计数"；遇到计数为 0 的 `user/message` 就开启新 unit；计数 > 0 时一律并入当前 unit。这样天然得到 C1 平衡的原子。

**特例**：单个巨型 unit（例如一轮里连续几十次工具调用）超过 `retainTokens` → **整单元保留**，宁可超预算也不切半对 [DSH 自研]。

### 2.4 硬规则（写进属性测试）

| 规则 | 依据 |
|---|---|
| 绝不单独保留 `tool_call` 或 `tool_result` | C1（`toolPairingBalancedBefore/After`） |
| surface 节点 0 永不进 `shadowedSeqs` | C2 |
| 找不到安全 cut → 返回 null 且**不 append 任何 session event** | #5 验收（零写入） |
| `retainTokens` 是**软**上限：最后一个单元整进整出 | [DSH 自研]，替代 Codex 的"截断最后一条" |

---

## 3. D4 字段 → `ContentBlock[]` 映射

### 3.1 字段清单（续跑必需最小集）

| 字段 | 来源 | 备注 |
|---|---|---|
| 进展与关键决策 | Codex bullet 1 [证据 `prompts/templates/compact/prompt.md`] | 原文 `Current progress and key decisions made` |
| 重要上下文 / 约束 / 用户偏好 | Codex bullet 2 [证据 同上] | 原文 `Important context, constraints, or user preferences` |
| 待办（清晰的下一步） | Codex bullet 3 [证据 同上] | 原文 `What remains to be done (clear next steps)` |
| 关键数据 / 示例 / 引用 | Codex bullet 4 [证据 同上] | 原文 `Any critical data, examples, or references needed to continue` |
| **触碰的文件与状态** | **DSH 自研** | Codex **无**此独立字段（notes §3.3） |
| **已知坑 / 失败尝试** | **DSH 自研** | Codex **无**此独立字段（notes §3.3） |
| 模板版本号 | **DSH 自研** | `summaryTemplate: 'codex-v1'`，用于度量漂移（#6 验收） |

后两个字段对应配置面 `summaryExtraFields?: ('files' | 'pitfalls')[]`（**默认全开**）[证据 design-m1-m2.md §5]；关闭它们即退化为纯 Codex 字段集。

### 3.2 提示词骨架

以 Codex 原文为基线（角色指令 + 4 bullet，`prompt.md` 全文 9 行 [证据]），追加我们的两个字段：

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
- Files touched and their current state (omit if none)
- Known pitfalls or failed approaches (omit if none)

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

- 新增两行是我们加的 [DSH 自研]；Codex 的 4 行与首尾两行**逐字保留** [证据]。
- "omit if none" 是为 #6 验收"字段缺失时不产生空壳字段"服务的约束 [DSH 自研]；Codex 原文**没有**任何字段缺失处理规定 [证据 notes §3.3]。
- 续跑语义句（"另一个模型已开始…不要重复工作"）建议由 D5 的替换消息承载，不塞进模板 [DSH 自研]（见 §4）。

### 3.3 输出投影伪码

```js
function projectSummary(rawOutput /* ContentBlock[] */) {
  const texts = rawOutput
    .filter(b => b.type === 'text')            // 丢弃 reasoning / tool_call / tool_call_result / image
    .map(b => b.text)
    .filter(t => typeof t === 'string' && t.trim().length > 0);   // 空字段不产空壳
  if (texts.length === 0) return null;         // 交给 compaction/summary-error waterfall
  return [{ type: 'text', text: texts.join('\n') }];
}
```

- Codex 侧对应证据：摘要正文只取**最后一条 assistant 文本** `get_last_assistant_message_from_turn(compaction_response.output)` [证据 compact.rs#L394]；`drain_to_completed` 只收集 `OutputItemDone` 事件 [证据 compact.rs#L862]。
- 返回值必须满足 `SummaryResult` 契约：走 `ctx.llm.stream()` 时 **`rawOutput` 与 `llmStreamCall: true` 必须同时给出** [证据 design-m1-m2 §2.3]。
- 空结果**不得**返回空数组或占位块 [DSH 自研 / #6 验收]，交由 `compaction/summary-error` 分流。

---

## 4. D5 边界说明（与议题 #8 的关系）

- 替换消息的外层框架（`<compacted-summary>` + `compactCheckpointSource`）由基类事务生成，**我们改不了，也不该改** —— 那正是 C3 要求的形态 [证据 design-m1-m2 §3 "D5 受机械层约束"；`summarizer.d.ts#L57-L62`、`checkpoint.d.ts#L17-L31`]。
- 因此 Codex 的"历史已压缩 / 如何续跑"说明只能放进**摘要正文**（正文开头一句），**不能**新增外层标记 [DSH 自研]。

---

## 5. "DSH 自研"清单（Codex 无对应，复核时重点看）

1. 结构单元划分函数 `splitIntoUnits`（§2.3）
2. C1 双端吸附与"找不到安全范围即零写入"判定（§2.2 步骤 4/5）
3. `retainTokens` 软上限语义（整单元进/出，替代 Codex 的截断）（§2.4）
4. "触碰的文件与状态""已知坑/失败尝试"两个扩展字段（§3.1）
5. 模板版本号 `summaryTemplate`（§3.1）
6. 空结果不产空壳 + 转 `compaction/summary-error` 分流（§3.3）
7. `trigger === 'context-overflow'` 的阈值旁路（§1.3）

---

## 6. 引用

- `docs/codex-notes.md` — 源码规格与"未找到"清单（本文件所有 `[证据]` 的详细出处）
- `docs/codex-dsh-mapping.md` — D1–D5 / C1–C5 对齐表
- `docs/design-m1-m2.md` §2（继承点）、§3（D1–D5 落点）、§5（配置面）
- Codex 基线：<https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897>
