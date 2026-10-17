# Codex 压缩语义规格（源码级证据）

> **调研对象**：<https://github.com/openai/codex>
> **固定基线 commit**：`ce0323f2f2d3b25e82806cd555237da3db4e1897`（2026-10-17T04:02:21Z，`Support typed content in contextual prompt fragments (#54776)`）
> **复现方式**：`git clone --depth 1 --filter=blob:none --sparse https://github.com/openai/codex.git codex && git -C codex sparse-checkout set codex-rs/core codex-rs/protocol codex-rs/prompts codex-rs/history codex-rs/context-fragments codex-rs/config`
> **行号约定**：本文所有 `path#Lx` 与裸行号均针对上述 commit，链接形如 `https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/<path>#Lx`。
> **图例**：**[证据]** = 已直接读到源码/模板原文；**[推断]** = 由源码推导；**[未验证]** = 未查证（并在 §8 列出查询路径）。
> **用途**：M2 议题 #4/#5/#6 的设计输入。与 DSH C1–C5 的对齐见 `docs/codex-dsh-mapping.md`。

---

## 0. 全景：Codex 不是"一种"压缩，而是四条并行路径

| 路径 | 入口 | 是否产生摘要 |
|---|---|---|
| 本地摘要压缩（Responses API） | `codex-rs/core/src/compact.rs` | 是 |
| 远程压缩 V2（服务端） | `codex-rs/core/src/compact_remote_v2.rs` | 服务端返回压缩项 [未验证] |
| token-budget 压缩 | `codex-rs/core/src/compact_token_budget.rs` | **否**，直接 `start_new_context_window()`（`:55-58`） |
| 后台投机压缩（async） | `codex-rs/core/src/session/async_compaction.rs` | 预生成候选，前台采纳 |

**[证据]** 本地/远程/预算三分支见 `codex-rs/core/src/tasks/compact.rs#L53-L96`；预算模式**不摘要**见 `compact_token_budget.rs#L16-L27`（注释：`skips model/server summarization and installs a fresh context window`）。
**[推断]** 本文 §1–§7 描述的是"本地摘要压缩"这一条，因为只有它对应 DSH 的 D1–D5；预算模式对我们无参考价值（DSH 无等价能力，且不满足 C3/C4 的摘要契约）。

---

## 1. D1 触发：阈值百分比、token 计数、overflow 判定

### 1.1 自动压缩的三个独立阈值

**(a) auto-compact 绝对上限（派生自 90%）** [证据]
`codex-rs/protocol/src/openai_models.rs#L529-L541`，`ModelInfo::auto_compact_token_limit()`：

```rust
let context_limit = self.resolved_context_window().map(|w| (w * 9) / 10);   // 90%
let config_limit = self.auto_compact_token_limit;
if let Some(context_limit) = context_limit {
    return Some(config_limit.map_or(context_limit, |l| std::cmp::min(l, context_limit)));
}
config_limit
```
配置注释原文（`:461-463`）：`Token threshold for automatic compaction. When omitted, core derives it from context_window (90%). When provided, core clamps it to 90% of the context window when available.`

**(b) 模型满窗口上限（默认 95%）** [证据]
`default_effective_context_window_percent() = 95`（`openai_models.rs#L392-L395`，默认值装配见 `:470-L472` 与 `:1102`）。
`codex-rs/core/src/session/context_window.rs#L84-L86`：
```rust
let full_context_window_limit = model_info.resolved_context_window()
    .map(|w| w.saturating_mul(model_info.effective_context_window_percent) / 100);
```

**(c) 轮末百分比（默认关闭）** [证据]
`model_post_turn_compact_threshold_percent`，默认 `u8::default() = 0`（`codex-rs/core/src/config/mod.rs#L663-L664`、`:4437-L4439`），文档注释：`Omitted or zero disables turn-end compaction; valid values are 0–100`（`codex-rs/config/src/config_toml.rs#L187-L191`）。

**(d) 后台投机压缩阈值（默认 65%）** [证据]
`const DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT: u8 = 65;`（`config/mod.rs#L226`）；判定式在 `codex-rs/core/src/session/async_compaction.rs#L70-L78`：`active_context_tokens * 100 < limit * async_compaction_threshold_percent` 时**不**启动。

### 1.2 触发算式（唯一权威实现）

[证据] `codex-rs/core/src/session/context_window.rs#L53-L129`，`context_window_token_status_with_config()`：

```
active_context_tokens        = sess.get_total_token_usage()                        // :58
scope ∈ {Total, BodyAfterPrefix}                                                   // :62, 默认 Total
  Total:           scope_tokens = active;                   baseline = None
  BodyAfterPrefix: scope_tokens = active - prefill_baseline  // :70-79
scope_limit                  = config.model_auto_compact_token_limit ?? model.auto_compact_token_limit()
full_context_window_limit    = context_window * effective_context_window_percent / 100   // :84-86
buffered_auto_compact_limit  = scope_limit + fallback_buffer_tokens                       // :102-103
full_context_window_limit_reached = active >= full_context_window_limit                   // :106-107
token_limit_reached = (scope_tokens >= buffered_auto_compact_limit) || full_context_window_limit_reached  // :108-110
turn_end_compaction_threshold_reached =
      post_turn_percent > 0 && (token_limit_reached || active * 100 >= full_limit * post_turn_percent)     // :111-117
```
`AutoCompactTokenLimitScope` 枚举与 `Total` 默认值：`codex-rs/protocol/src/config_types.rs#L43-L60`。
`fallback_buffer_tokens` 默认 **0**（未配置时），仅当设置了 `auto_compact_fallback_prompt` 才要求为正（`codex-rs/core/src/config/mod.rs#L1244`、`:1298-L1323`）。

### 1.3 触发点（四个时机）

| 时机 | 位置 | 说明 |
|---|---|---|
| 每步采样之后 | `session/turn.rs#L592-L716` | `should_roll_over = auto_compaction_enabled && needs_follow_up && (new_window_requested \|\| token_limit_reached \|\| async_candidate_ready)`；随后 `run_auto_compact(..., MidTurn, CompactionReason::ContextLimit)` |
| 轮末（无 follow-up） | `session/turn.rs#L781-L804` | 条件：`auto_summarization_enabled && post_turn_percent > 0 && !has_pending_input`；`phase = PostTurn` |
| 轮前 | `session/turn.rs#L193-L199` | `run_pre_sampling_compact()`；模型切换 / `comp_hash` 变化时另走 `turn.rs#L1425-L1497`（`ModelDownshift` / `CompHashChanged`，`PreTurn`） |
| 手动 `/compact` | `tasks/compact.rs#L29-L96` | `CompactionTrigger::Manual` |

**[证据]** 开关：`auto_compaction_enabled` 由 thread-extension `AutoCompactionDisabled` 决定（`turn.rs#L174-L178`）；`auto_summarization_enabled = auto_compaction_enabled && !Feature::TokenBudget`（`turn.rs#L179-L180`）。

### 1.4 overflow 判定与恢复

- **采样阶段溢出**：请求返回 `CodexErrorDetails::ContextWindowExceeded` → `sess.set_total_tokens_full()` 后把错误抛给上层（`turn.rs#L1792-L1796`）。即：**不在采样内原地压缩**，由下一步的 `token_limit_reached`（`set_total_tokens_full` 会把用量顶到满窗口）驱动 `MidTurn` 压缩。**[推断]**（`:1794` 到 `:605-L663` 的因果链是两个函数拼出来的）。
- **压缩调用自身溢出**：`compact.rs#L359-L371` —— 从**最前面**逐条 `history.remove_first_item()` 后重试，注释原文：`Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact.`；只剩 1 条时 `set_total_tokens_full` 并放弃。**[证据]**
- **轮前证据溢出**：guardian 输入导致 `ContextWindowExceeded` 时，先做一次 `PreTurn` 压缩再重选（`turn.rs#L345-L375`）。**[证据]**

### 1.5 token 计数方式（关键）

[证据] `codex-rs/core/src/context_manager/history.rs#L939-L956`，`History::get_total_token_usage()`：

```
total = last_token_usage.total_tokens           // 最近一次服务端上报的 prompt 用量
      + (server_reasoning_included ? 0 : get_non_last_reasoning_items_tokens())
      + Σ estimate_item_token_count(最后一条模型生成项之后新增的条目)   // 本地估算补齐尾部
```
→ **服务端观测优先，尾部增量用本地估算补齐**。估算基元是 `approx_token_count`（字节启发式），源码自述为 `This is a coarse lower bound, not a tokenizer-accurate count`（`history.rs#L650-L651`）。

---

## 2. D2/D3 输入选择：保留边界怎么定

### 2.1 送进摘要模型的是什么

[证据] `codex-rs/core/src/compact.rs#L277-L324`：
1. `let mut history = sess.clone_history().await` —— **当前完整模型可见历史**（含上一轮的压缩摘要）；
2. 把压缩指令作为一条 user input `record_items` 追加进该 history（`:279-L282`）；
3. `let mut turn_input = history.clone().for_prompt(&model_info.input_modalities)`（`:301-L303`），再 `attach_to_compaction_prompt()`；
4. `Prompt { input: turn_input, base_instructions, .. }`（`:319-L324`）交给 `client_session.stream()`（`drain_to_completed`，`:826-L851`）。

→ **不是**"只喂被遮蔽区域"，而是"整段会话 + 尾部一条指令"（这点与 DSH 不同，见对齐表 C4）。

### 2.2 保留边界 = 20k token 预算内的**最近 user 消息**（不是条数，不是轮次）

[证据] `compact.rs#L64`：`const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;`
[证据] `compact.rs#L715-L819`，`build_compacted_history_with_limit()`：

```
selected = []
remaining = max_tokens (20_000)
for message in user_messages.iter().rev() {          // :724 从最新往旧
    if remaining == 0 { break }
    tokens = approx_token_count(message.message)      // :728
    preserve_content = tokens <= remaining && 全部是 InputText
    if !preserve_content { 截断文本 truncate_annotated_text(parts, remaining) }  // :788
    selected.push(item)
    if tokens > remaining { break }                   // :799-L801 超预算的最后一条也留下，但已截断
    remaining -= tokens
}
selected.reverse()                                    // :804 恢复时间序
history.extend(selected)                              // :806
history.push(CompactionSummary(summary_text))         // :814-L816 摘要在最后
```

**谁算"user 消息"** [证据] `compact.rs#L604-L620`，`compacted_user_message()`：必须是 `TurnItem::UserMessage`，且 `!is_summary_message(&message)`（`is_summary_message` 判前缀 `SUMMARY_PREFIX + "\n"`，`:622-L624`）。
→ 结论：**assistant 消息与 tool 结果/工具调用一律不逐字保留**；它们只通过摘要存活。**[证据]**

### 2.3 系统提示词与工具定义

[证据] 它们**不参与摘要**，而是在压缩后**重新渲染并置顶**：
- `compact.rs#L85-L116`，`build_compaction_replacement_history()` / `assemble_compaction_history()`：`sess.build_initial_context_with_world_state()` 拿到 updates，`split_prefix_updates()` 拆成 `prefix` + `context`；`prefix` 直接 `chain` 到历史最前面（`:111-L115`）。
- `context` 由 `insert_initial_context_before_last_real_user_or_summary()` 插入（`compact.rs#L651-L700`）：优先插在最后一条真实 user/agent 消息之前；没有则插在摘要之前（保持摘要在最后）；都没有则追加。
- base instructions 的取用与回退：`compact.rs#L283-L318`（历史里已有 `BaseInstructionsFragment` 就用它，否则用 fallback）。

→ **没有**"摘要 system prompt"或"摘要工具定义"的路径。**[证据]**

---

## 3. D4 摘要提示词：逐字段清单

### 3.1 常量与文件

[证据] `codex-rs/prompts/src/compact.rs#L1-L2`：
```rust
pub const SUMMARIZATION_PROMPT: &str = include_str!("../templates/compact/prompt.md");
pub const SUMMARY_PREFIX: &str = include_str!("../templates/compact/summary_prefix.md");
```
再导出：`codex-rs/core/src/compact.rs#L62-L63`（`pub use codex_prompts::SUMMARIZATION_PROMPT / SUMMARY_PREFIX`）。
可被配置覆盖：`config.compact_prompt`（`compact.rs#L126-L131`、`tasks/compact.rs#L83-L92`）。

### 3.2 提示词原文（`codex-rs/prompts/templates/compact/prompt.md`，全文 9 行）

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

### 3.3 逐字段拆解

| # | 要求输出的内容（原文） | 对应"续跑必需状态变量" |
|---|---|---|
| 0 | **角色指令**：`You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.` | 是"你是摘要器"的显式声明 |
| 1 | `Current progress and key decisions made` | 进展 + 关键决策 |
| 2 | `Important context, constraints, or user preferences` | 约束/偏好 |
| 3 | `What remains to be done (clear next steps)` | 待办 |
| 4 | `Any critical data, examples, or references needed to continue` | 关键数据/引用 |

**结构性质** [证据]：纯自然语言 bullet，**没有** JSON/XML schema、**没有**必填字段校验、**没有** few-shot 示例；仅以 `Be concise, structured, and focused` 软约束收尾。
**与议题 #6 期望字段的差距** [证据+推断]：Codex **没有**"触碰的文件与状态"独立字段，也**没有**"已知坑/失败尝试"独立字段（最多被第 4 条 `critical data, examples, or references` 半覆盖）。→ 这是 DSH 需要**扩展**而非照搬的部分。

### 3.4 摘要前缀（元描述，不是提示词的一部分）

[证据] `codex-rs/prompts/templates/compact/summary_prefix.md`（1 行，全文）：
```text
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```
拼接方式 [证据]：`compact.rs#L404` —— `let summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}");`

---

## 4. D5 注入形态：角色、标记、如何告知"历史被压缩"

[证据] `codex-rs/core/src/context/compaction_summary.rs#L1-L41`，`CompactionSummary`：
- `role() -> "user"` —— 注入为 **user 角色**消息（`:26-L28`）；
- `content_kind() -> COMPACTION_SUMMARY_KIND`，值为 `"compaction.summary"`（`codex-rs/context-fragments/src/lib.rs#L22`）；
- `markers() -> ("", "")`、`type_markers() -> ("", "")`（`:30-L36`）→ 按 `render()` 语义（`context-fragments/src/fragment.rs#L94-L107`：两个 marker 都空则**直接返回 body，不加任何包裹**）→ **模型侧看到的是纯文本，无 XML 标签**。
- `body() -> input_text(summary)`。

**注入文本** [证据]：`{SUMMARY_PREFIX}\n{摘要正文}`（`compact.rs#L404`）；摘要在历史中的位置是**最后一条**（`compact.rs#L814-L816`）；空摘要写占位 `"(no summary available)"`（`:808-L812`）；该 item 会补 `turn_id`（`:408-L412`）。

**模型如何知道"历史被压缩过"** [证据+推断]：仅靠 SUMMARY_PREFIX 的自然语言元描述（"Another language model started to solve this problem…"）。[证据] harness 侧的 `content_kind` 元数据**不进入模型可见文本**，只用于分类与 Guardian 过滤（`context-fragments/src/lib.rs#L21-L22` 注释：`produced by core and filtered by Guardian`）。→ **没有**结构化"已压缩"标记供模型消费。

**续跑提示** [证据]：SUMMARY_PREFIX 里 `Use this to build on the work that has already been done and avoid duplicating work.`

**另一分支** [证据]：`PostTurn` 阶段的摘要取**本次压缩调用自身**的最后一条 assistant 文本（`compact.rs#L393-L403`，`get_last_assistant_message_from_turn(compaction_response.output...)`，取不到就报 `Post-turn compaction completed without an assistant summary`）；其余阶段取历史里的最后一条 assistant 文本。

---

## 5. 持久化与回放（rollout / resume）

### 5.1 落盘结构

[证据] `codex-rs/history/src/lib.rs#L215-L231`：`RolloutItem::Compacted(CompactedItem)`；结构体定义 `:289-L310`：

```rust
pub struct CompactedItem {
    pub message: String,                          // = SUMMARY_PREFIX + "\n" + 摘要正文
    pub replacement_history: Option<Vec<ResponseItemEnvelope>>,  // 完整替换历史（含 metadata sidecar）
    pub guardian_history: Option<GuardianHistoryCheckpoint>,
    pub retained_context: Option<RetainedContext>,
    pub mcp_resource_origins: Option<McpResourceOriginCheckpoint>,
    pub window_number: Option<u64>,
    pub first_window_id / previous_window_id / window_id: Option<String>,
    pub compaction_response_id: Option<String>,
    pub latest_token_usage_record: Option<TokenUsageRecord>,
    pub resume_metadata: Option<CompactionResumeMetadata>,
}
```

[证据] 写入：`codex-rs/core/src/session/mod.rs#L4325-L4372` —— `replace_compacted_history()` 构造 `compacted_item` 后一次性 persist 四项：`RolloutItem::Compacted / WorldState / TurnContext / EventMsg`（`:4360-L4372`）。
[证据] 序列化把替换历史与它的元数据拆成**对齐 sidecar**：`codex-rs/history/src/rollout_payload.rs#L248-L298`（`replacement_history` + `replacement_history_metadata`）。

### 5.2 resume 重建

[证据] `codex-rs/core/src/session/rollout_reconstruction.rs#L64-L91`，`select_input_compaction()`：
- 取**最后一条** `RolloutItem::Compacted`（`:70-L77`，注释：`Only the newest compaction can bound replay`）；
- 若 `replacement_history` 缺失、`window_number` 缺失，或 `resume_metadata` 缺失且非 paginated 模式 → 返回 `None`（**放弃用压缩点截断**，`:80-L86`）；
- 否则以 `ReplayCheckpoint { compacted, suffix: &rollout_items[index+1..] }` 返回。

[证据] `:492-L558`：
```
if let Some(checkpoint) { history.replace_annotated(items.clone());   // :497 直接用 replacement_history
                          history.restore_review_context(retained_context, guardian_history, None); }  // :498-504
for item in rollout_suffix { ... }                                    // :506-L508 顺序重放 suffix
```
- `RolloutItem::Compacted` 在 suffix 里的处理（`:521-L546`）：若 `replacement_history.is_none()`（legacy），用 `collect_annotated_user_messages + build_compacted_history` **重建**，并放弃 `reference_context_item`（`:525-L545`）。
- resume 元数据：`codex-rs/history/src/compaction_resume_metadata.rs#L12-L33`（`multi_agent_version / last_started_turn_id / turn_attribution / previous_turn_settings`），回填处 `:479-L482`。
- fork 场景会改写 `replacement_history`：`codex-rs/core/src/agent/control/spawn.rs#L1121`、`:1260-L1280`。**[证据]**

---

## 6. 多次压缩叠加（压缩的压缩）与防漂移

### 6.1 旧摘要怎么处理

[证据] 两条事实，合起来就是 Codex 的叠加语义：
1. **新替换历史里不保留旧摘要条目**：`compacted_user_message()` 用 `is_summary_message()` 把摘要消息过滤掉（`compact.rs#L612-L614`、`:622-L624`），`build_compacted_history` 只用"真实 user 消息 + 新摘要"重建（`:702-L819`）。
2. **但生成新摘要的输入里包含旧摘要**：压缩请求输入是 `sess.clone_history()` 的完整历史（`compact.rs#L277-L303`），而上一轮的 `CompactionSummary` 就在这份历史里。
→ 语义 = **每次都把"旧摘要 + 之后的新历史"整体再摘要一次**（链式再编码），而不是把两段摘要拼接起来。

### 6.2 显式防漂移机制：**未找到**

[证据] 我在上述 commit 上搜索了 `codex-rs` 下 `drift / anchor / summary version / dedupe` 相关标识，未发现任何"摘要漂移抑制"专用逻辑（版本号、字段级合并、摘要校验）。
**只找到一条用户可见警告** [证据]：`compact.rs#L442-L445`，每次压缩完成后发 `WarningEvent`：
```text
Heads up: Long threads and multiple compactions can cause the model to be less accurate.
Start a new thread when possible to keep threads small and targeted.
```
**相邻机制（不是防漂移，但可能与议题 #9 相关）**：
- `window_number` / `first_window_id` / `previous_window_id` / `window_id` 每次压缩 `advance()`（`codex-rs/core/src/state/auto_compact_window.rs#L77-L85`；调用点 `compact.rs#L413`），用于界定 scope 计量窗口，**不用于摘要合并**。**[证据]**
- `RetainedContext`（`codex-rs/history/src/retained_context.rs`）在压缩点保留"已核实问答"并随 `CompactedItem` 持久化、replay 时 `restore_review_context` 还原（`rollout_reconstruction.rs#L498-L504`）。**[证据]** 作用域是 review/guardian，不是通用历史保全 [推断]。

→ **结论**：Codex 的"防漂移"就是"每次重新全量总结（含旧摘要）+ 一句警告"。**DSH 议题 #9 必须自建**版本号/稳定标记/字段契约，不能声称"照搬 Codex"。

---

## 7. 压缩后 token 预算如何重算 / 何时再触发

[证据] 压缩成功后立即重算：`compact.rs#L437-L438`：
```rust
sess.recompute_token_usage(&replacement_step_context.turn).await;
```
实现：`codex-rs/core/src/session/mod.rs#L5144-L5182`，`Session::recompute_token_usage()`：
1. `history.estimate_token_count_with_base_instructions(&base_instructions)`（`:5147-L5148`）；
2. 用估算值**覆盖** `last_token_usage.total_tokens`，其余字段清零（`:5160-L5168`）；
3. 更新 `model_context_window`（`:5170-L5172`）；
4. `set_auto_compact_window_estimated_prefill_for_scope(...)`（`:5176-L5180`）→ 在 `BodyAfterPrefix` scope 下把估算值设为**新 baseline prefill**（`state/auto_compact_window.rs#L121-L130`）；
5. `send_token_count_event()`（`:5181`）。

[证据] **服务端观测覆盖本地估算**：`AutoCompactWindow::ensure_server_observed_prefill_from_usage()`（`state/auto_compact_window.rs#L108-L119`）——一旦有服务端 `usage.input_tokens`，就固定用它作为 baseline，后续 `set_estimated_prefill` 直接 return（`:121-L127`）。

[证据] **何时再次触发**：下一次采样后再次调用 `context_window_token_status()`（`turn.rs#L592-L620`），轮末再算一次（`turn.rs#L786-L791`）。压缩完成后不设冷却期，靠判定式自然收敛；源码注释（`turn.rs#L675-L676`）：
```text
as long as compaction works well in getting us way below the token limit, we shouldn't worry about being in an infinite loop.
```

---

## 8. 空白项与"未找到"清单（含查询路径）

| # | 未找到/未验证的点 | 我查了哪些路径 |
|---|---|---|
| 1 | **单一"阈值百分比"**不存在：Codex 用 4 个不同阈值（90% 派生 limit / 95% effective window / post-turn 默认 0 / async 65%）。不要把它简化成"0.9 触发" | `openai_models.rs`、`context_window.rs`、`config/mod.rs`、`config_toml.rs`、`async_compaction.rs` |
| 2 | **摘要输出格式硬约束**（schema / 必填字段校验 / few-shot）：无 | `prompts/templates/compact/prompt.md`（全文 9 行） |
| 3 | **"触碰的文件" / "已知坑" 独立字段**：无 | 同上 |
| 4 | **多次压缩的显式防漂移机制**（版本号/锚点/字段合并）：无，只有 WarningEvent | 全文 grep `compact`/`drift`/`summary`；`compact.rs`、`auto_compact_window.rs` |
| 5 | **system 提示词 / 工具定义参与摘要**：无此路径，只有"重渲染 prefix" | `compact.rs#L85-L116`、`:283-L324` |
| 6 | **"保留最近 N 条消息/轮次"计数式边界**：不存在，实际是 20k token 预算内的 user 消息 | `compact.rs#L64`、`:715-L819` |
| 7 | **Codex 侧的 tool_call/tool_result 配对切割约束**：不存在。只有 `normalize_history()` 对**内存历史**强制 call/output 配对不变量（`history.rs#L964-L967`），与"选切割点"无关 | `history.rs`、`compact.rs`、`context_manager/` |
| 8 | **远程压缩 V2 的具体摘要协议**：未验证（只确认存在与分支入口） | `tasks/compact.rs#L63-L76`、`compact_remote_v2.rs`（未逐行读） |
| 9 | **token-budget 模式的"新窗口"具体内容**：未验证 | `compact_token_budget.rs` 已读，`start_new_context_window` 实现未读 |
| 10 | **`FallbackBuffer`/`auto_compact_fallback_prompt` 的完整语义**：只确认默认 buffer=0、prompt 有 2000 字节上限 | `config/mod.rs#L1235-L1323` |

### 外部引用

- 仓库：<https://github.com/openai/codex>
- 基线 commit：<https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897>
- 摘要提示词：<https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/prompts/templates/compact/prompt.md>
- 摘要前缀：<https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/prompts/templates/compact/summary_prefix.md>
- 本地压缩实现：<https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/compact.rs>
- 触发判定：<https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/session/context_window.rs>

> 本文只做规格记录，不提出 DSH 侧设计结论；适配方案见 `docs/codex-dsh-mapping.md`。
> 本次调研未修改 `docs/PLAN.md`；PLAN §1.5 的"待填字段"回填需由 lead 在合并本 PR 后单独执行。
