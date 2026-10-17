# Codex 语义 → DSH 契约（C1–C5）对齐表

> **输入**：`docs/codex-notes.md`（Codex 基线 commit `ce0323f2f2d3b25e82806cd555237da3db4e1897`）。
> **DSH 侧依据**：`docs/PLAN.md` §1.2（C1–C5）、§1.4（原生 basic 基线）；本机实装 `@deepseek-ai/dsh@0.2.1-rc.2` 的
> `dsh-compaction/lib/types/types.d.ts`、`tool-pairing.d.ts`、`checkpoint.d.ts`、`dsh-compaction-basic/lib/types/summarizer.d.ts`。
> **图例**：`照搬` = 语义与 DSH 契约兼容，可直接采用；`改造` = 保留意图但必须改写形态；`不可照搬` = 直接采用会违反 C1–C5 或产出非法请求。

## 0. 结论速览

- **可照搬**：触发算式（D1，需把 W/O 换成本机容量）、前缀回放（C4）、只取返回文本（C5）。
- **必须改造**：摘要字段集（D4，补"触碰的文件/已知坑"）、注入标记（D5，DSH 要 `<compacted-summary>` 框定 + `compactCheckpointSource`）。
- **不可照搬**：**保留边界**（D3，"最近 20k token 内的 user 消息"在 DSH 必然切断 tool 配对）、**切割模型**（Codex 是"整体重建历史"，DSH 是"在既有 surface 上替换一段"）、**防漂移**（Codex 没有任何显式机制，议题 #9 必须自研）。

---

## 1. 五维对齐表（D1–D5）

| Codex 做法（含证据） | DSH 约束/契约 | 可否照搬 | 我们的适配方案 |
|---|---|---|---|
| **D1** 触发：`limit = min(config, context_window*0.9)`；`full = context_window*95%`；`token_limit_reached = scope_tokens >= limit+buffer \|\| active >= full`；轮末百分比默认 0（关闭）；后台投机 65%。（`context_window.rs#L84-L117`、`openai_models.rs#L529-L541`、`config/mod.rs#L226`） | 无 C 约束直接限制；但 native basic 的算式是 `floor(min(W*0.8, W-O-65536))`（PLAN §1.4），`W` 为 adapter 容量、`O` 为 `reservedCompletionTokens`（`dsh-compaction-basic/lib/types/config.d.ts#L29-L42`） | **照搬**（改输入） | 议题 #4：保留"绝对 limit + 满窗口硬上限 + 独立轮末百分比"三段式。把 `context_window` 映射为 `resolveCompactSpec()` 已解析的容量，把 90%/95% 显式化为配置（`limitRatio`/`effectiveWindowPercent`），溢出旁路仍走 DSH 原生的 `CONTEXT_WINDOW_EXCEEDED` 强制一次缩减 |
| **D1'** token 计数：触发用"服务端上报的 `last_token_usage.total_tokens` + 尾部本地估算"（`history.rs#L939-L956`），估算自述为"coarse lower bound"（`history.rs#L650-L651`） | DSH 计量由 `ctx.llm`/`dsh-compaction` 的影子计价提供（`types.d.ts#L79-L98`） | **改造** | 沿用 DSH 的 `shadowedTokenCount` 与最新 usage，不引入第二套估算；只在**没有** provider usage 时用 DSH 自带 estimator 兜底 |
| **D2** 切分：Codex **不选切割点**——它整体丢弃旧历史、用 `replacement_history` 整体替换（`compact.rs#L407-L436`、`session/mod.rs#L4325-L4372`） | **C1**：切割点必须让 assistant tool_call 与其 tool_result 成对（`toolPairingBalancedBefore/After`，`tool-pairing.d.ts#L8-L25`）；**C2**：surface 节点 0 的 `system/message` 不可被遮蔽（PLAN §1.2） | **不可照搬** | 议题 #5：DSH 侧是"在既有 surface 上替换一段"，范围选择器从**第一个非 system 节点**之后起步，用 `toolPairingBalancedBefore/After` 把起止点吸附到平衡位置；找不到安全范围时**零写入**（不写任何事件） |
| **D3** 保留：最近 **20k token 预算内的 user 消息**（`COMPACT_USER_MESSAGE_MAX_TOKENS=20_000`，`compact.rs#L64`、`:715-L819`），**assistant 与 tool 消息一律不逐字保留**（`compact.rs#L604-L620` 只认 user） | **C1**（同左）。保留 assistant 的 tool_call 却让它的 tool_result 进摘要 = 请求在 provider 侧非法 | **不可照搬** | 议题 #5：把"保留单元"从"user 消息"改为"**C1 平衡区间**"——以 tool_call/tool_result 配对为最小原子，按结构单元（轮/步）从最新往回保留到近期预算；user 消息优先，但**绝不**单独保留半对 |
| **D4** 摘要提示词：9 行自由文本，4 条 bullet：进展与关键决策 / 重要上下文·约束·偏好 / 待办 / 关键数据与引用（`prompts/templates/compact/prompt.md` 全文；常量 `prompts/src/compact.rs#L1`） | 无 C 约束；但 PLAN §1.4 指出原生 basic 的缺陷是"缺少面向续跑的稳定字段"，议题 #6 要求 5 字段 | **改造** | 议题 #6：以 Codex 的第 0 条角色指令 + 4 条 bullet 为**最小集基线**，扩展出议题 #6 要求的"触碰的文件与状态""已知坑/失败尝试"两个独立字段（Codex 没有，见 notes §3.3）；保持纯自然语言（DSH 的 `ContentBlock[]` 也只承载文本），加模板版本号 |
| **D5** 注入：一条 **user 角色**纯文本消息，内容 `SUMMARY_PREFIX + "\n" + 摘要`，**无 XML 标记**（`context/compaction_summary.rs#L26-L36`、`context-fragments/src/fragment.rs#L94-L107`）；靠 `content_kind="compaction.summary"` 做 harness 侧分类（`context-fragments/src/lib.rs#L22`） | **C3**：替换必须是"紧随 `compaction/summary` 的一条 `user/message`"（`types.d.ts#L26-L68`）；DSH 原生用 `<compacted-summary>` 框定并携带 `compactCheckpointSource(compactionId)`（`summarizer.d.ts#L57-L62`、`checkpoint.d.ts#L17-L31`） | **改造** | 议题 #8：**保留** SUMMARY_PREFIX 的续跑语义（"另一个模型已开始…不要重复工作"），但**必须**走 DSH 形态：`compactCheckpointSource` + `<compacted-summary>` 框定，作为紧邻 `compaction/summary` 的替换 `user/message` |

---

## 2. 逐条 C1–C5 对齐表

| Codex 做法 | DSH 约束 | 可否照搬 | 我们的适配方案 |
|---|---|---|---|
| **C1 配对**：Codex 没有"切割点必须配对"的搜索。它整体替换后由 `normalize_history()` 在内存历史上强制"每个 call 有 output、每个 output 有 call"（`context_manager/history.rs#L964-L967`） | `toolPairingBalancedBefore/After(session, seq)`；不满足即 provider 侧非法 | **不可照搬** | 用 DSH 的两个 helper 做**边界求解**：先按结构算出候选区间，再用 `BalancedBefore/After` 吸附/校验两端；两端不收敛则返回 null（零写入）。**不要**指望"事后 normalize"——DSH 的 surface 替换没有这一步 |
| **C2 节点 0**：Codex 把 prefix **重新渲染**并 `chain` 到替换历史最前（`assemble_compaction_history`，`compact.rs#L102-L116`），天然不遮蔽 system | surface 节点 0 的 `system/message` 不可被遮蔽；范围须从第一个非 system 节点开始 | **改造**（借意图，不借机制） | 借"system/prefix 永在、由框架重新渲染"的意图；机制上仍走 DSH `replace` 语义：范围起点跳过节点 0，system 不进 `shadowedSeqs` |
| **C3 事务**：Codex 用 `TurnItem::ContextCompaction` 的 started/completed 包夹（`compact.rs#L272-L274`、`:440-L441`），并一次性 persist 4 条 rollout item（`session/mod.rs#L4360-L4372`） | 必须 `compaction/start` → `compaction/summary` → **紧随**替换 `user/message` → `compaction/end`（`types.d.ts#L21-L78`，注释明确"adjacency is contractual"） | **不可照搬** | 议题 #2 决策 B：复用 `BasicCompactionEngine.compactRegion` 的事务内核，本插件只产出 D1–D5 决策；不自行发明事件序列（红线：不新增 session event type） |
| **C4 前缀回放**：压缩请求 = `history.clone().for_prompt()` **完整会话前缀** + 末尾追加一条压缩指令（`compact.rs#L277-L324`）；压缩自身溢出时从**头部**删条目以保前缀缓存（`:359-L368`，注释原文 `Trim from the beginning to preserve cache (prefix-based)`） | 摘要调用须回放 system + tools + 被遮蔽区域，复用 KV cache（PLAN §1.2 C4；`summarizer.d.ts#L15-L25`） | **照搬** | 议题 #7：保持 `SummarizationInput { tools, messages }` 的回放语义（system 头 + 被遮蔽区域逐步），指令放最后；**不要**学 Codex"喂完整历史"——DSH 只回放被遮蔽区域即可命中缓存，喂全量反而更贵 |
| **C5 只取文本**：摘要正文 = `get_last_assistant_message_from_turn(compaction_response.output)`（`compact.rs#L394`），`drain_to_completed()` 只收 `OutputItemDone` 后投影出 assistant 文本（`:826-L920`） | 只取返回文本；推理与 tool_call 一律排除，检查点必须是纯文本块 | **照搬** | 议题 #6：投影时显式丢弃 reasoning / tool_call 块，产出 `ContentBlock[]`（text only）；空结果不写空壳字段，按 DSH 语义给占位/失败分支 |

---

## 3. "不能直接照搬"的 Top 3（给评审看）

1. **D3 保留边界不能按 user 消息切。** Codex 只保留 user 消息（`compact.rs#L604-L620`），因为它有 `normalize_history` 兜底；DSH 的 surface 替换没有这一层，直接照搬会产出"有 tool_call 无 tool_result"的非法请求（违反 C1）。→ 保留单元必须是 C1 平衡区间。
2. **Codex 没有切割点，DSH 有。** Codex 是"整体重建 `replacement_history` 并持久化"（`history/src/lib.rs#L289-L310`）；DSH 是"在现有 surface 上 shadow 一段并挂一条新节点"（`types.d.ts#L115-L131`）。两者的**崩溃恢复单位不同**：照搬 Codex 的替换模型会绕过 `compaction/start…end`（违反 C3）。
3. **防漂移不能声称"照搬 Codex"。** Codex 侧唯一的防漂移手段是"每次把旧摘要连同新历史再摘要一遍" + 一句 `WarningEvent`（`compact.rs#L442-L445`），**没有任何显式机制**（notes §6.2）。议题 #9 的版本号/稳定标记/字段契约必须自研，并在文档里如实标注"Codex 无此机制"。

---

## 4. 引用

- DSH 契约：`docs/PLAN.md` §1.2 / §1.4；`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/types/{types,tool-pairing,checkpoint}.d.ts`
- DSH 摘要器接口：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/summarizer.d.ts`
- Codex 源码：见 `docs/codex-notes.md` 的"外部引用"与基线 commit `ce0323f2f2d3b25e82806cd555237da3db4e1897`
