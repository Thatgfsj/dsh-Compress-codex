# codex × ptc 组合模式：可行性调查（task-24）

> **只调查，不实现**：本文不改 profile、不建 preset。与 [`docs/community-maintenance-notes.md`](community-maintenance-notes.md)
> （"没有 inherit 时如何接管 preset 隔离服务"）配套：那份讲**用什么机制**，这份讲 **ptc 这个具体 base 的差异、
> 用户会丢什么、以及组合起来有哪些 ptc 特有的风险**。
> 证据标记：[证据] 本机实测/源码原文；[推断] 由证据推导；[未验证] 未跑过。

---

## 0. 结论先行

1. **ptc 相对 standard 只差三处**（其余 128/134 行逐字相同）：多一行 `tool-presentation`（`mode: ptc`）、
   把 `workflow-ptc` 与 `tool-workflow` 改成 `disabled: true`、以及 `id/order`。**[证据]**
2. **用户切到我们现在的 `codex`（standard 基座）只会丢一样东西：PTC 的工具呈现** —— 模型从
   "只看见 `run_code` + 生成的 SDK" 变回 "每个工具一个 schema"。这几乎肯定就是他选 ptc 的原因。**[证据+推断]**
   反向还有一处**行为改变**：`workflow-ptc`/`tool-workflow` 会**重新启用**（不是丢失，但同样改变工具目录与模型行为）。
3. **组合在技术上是安全的**：ptc 的隔离 compaction 组与 standard **逐字节相同**；`ptc-runtime` 是**顶层部署行**
   而不是 preset 内的行。所以"ptc roster + 我们的 compaction"不需要额外依赖，现有生成器的 retarget 逻辑可直接复用。**[证据]**
4. **UI 里的"暂无描述。"是因为 preset 行缺 `config.description`** —— 该字段是官方支持的
   （`@deepseek-ai/dsh-agent-preset` 的 `Config` 声明了 `id/name/description/order/plugins`），补齐即可。**[证据]**
5. **推荐**：生成**新增** preset `codex-ptc`（方案 A），而不是覆盖现有 `preset-ptc`（方案 B）。
   两者机制相同，区别只在"多一个可选 preset"还是"替换掉用户日常那个"；A 可一键切回、可 A/B 对照。**[推断]**

---

## 1. ptc vs standard 逐项差异表

两个来源互证：官方源文件 `dsh-web-app/presets/*.patch.yml`，以及 `dsh --profile web --dump-config`
里两个 preset 的实际 roster（组成树）。两者结论一致。

| # | 项 | standard | ptc | 说明 |
|---|---|---|---|---|
| 1 | `config.id` | `standard` | `ptc` | registry 的键 |
| 2 | `config.order` | `1` | `2` | UI 排序用（见 §5） |
| 3 | `workflow-ptc`（在 `delegation` 组内） | 启用 | **`disabled: true`** | 关掉 JS workflow 编排 |
| 4 | `tool-workflow`（同组） | 启用 | **`disabled: true`** | 关掉对应工具 |
| 5 | `tool-presentation` | **不存在** | `@deepseek-ai/dsh-agent-tool-presentation`，`config.mode: ptc` | **PTC 呈现的开关** |

**其余全部逐字相同**，包括：`persona`（含 prefix 文案）、`agent-instructions`、`time-context`、
`tool-bash`/`tool-pwsh` 的平台条件、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-schedule`、
`skill-filesystem`、`tool-skill`、`command-goal`、`tool-goal`、`planning` 隔离组（含整段 plan-mode prompt）、
**`compaction` 隔离组**（`isolate: {compaction, toolResultPruner}` + `compaction-basic`/`command-compact`/
`tool-result-pruner` 及其 8192/4096/1024 配置）、`delegation` 的其余行、`tool-ask-user`、`tool-todo`、
`tool-web`、`present`、两个 `disabled: true` 的 plugin-manager/market 行。

复现：

```sh
diff -u "$DSH_NODE/@deepseek-ai/dsh-web-app/presets/standard.patch.yml" \
        "$DSH_NODE/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml"
```

---

## 2. PTC 到底是什么，用户会丢什么

`@deepseek-ai/dsh-agent-tool-presentation` 的 README（原文）：

> `native` presents each visible tool schema as a function definition; `ptc` presents only the
> `run_code` transport plus a generated SDK and the rule that only `run_code` may be called directly.

- **PTC = programmatic tool calling**：模型不再逐个调用工具，而是写一段 JS 调 `run_code`，
  由生成的 SDK 在沙箱里调其他工具。`mode` 在该行存在时**必填**；不写这一行则跟随部署默认。**[证据]**
- 选 `ptc` **需要一个兼容的 PTC runtime**；部署里没有的话，preset 会在**挂载期**（第一次 prompt 之前）被拒绝。**[证据]**
- 本机 web profile 里 `ptc-runtime`（`@deepseek-ai/dsh-ptc-runtime-node`）是**顶层行**，不在任何 preset 内。**[证据]**
  ⇒ **它不是 preset 的负担**，任何 preset 选 `mode: ptc` 都能用（只要部署有这行）。

### 切到 `standard + codex` 会丢什么（这就是组合模式的必要性清单）

| 类别 | 具体 | 影响 |
|---|---|---|
| **丢失** | PTC 工具呈现（`tool-presentation: mode=ptc`） | 模型改看 native 工具目录：工具调用风格、上下文占用、模型行为都变 |
| **新增**（反向） | `workflow-ptc`、`tool-workflow` 恢复启用 | 工具目录变大；不是丢失，但同样是行为改变 |
| 不变 | 其余 roster（见 §1 的"逐字相同"清单） | —— |

**因此判断很直接**：如果用户依赖"模型只看到 run_code + SDK"这件事，就必须做组合；
如果他其实只是"习惯了 ptc 这个名字"，那把默认 preset 换掉即可，**不需要**新 preset。**[推断]**
这一点建议直接问用户，不要替他决定。

---

## 3. 组合的可行性与技术风险

| # | 风险问题 | 事实（证据） | 结论 |
|---|---|---|---|
| 1 | ptc 是否也有 compaction 隔离组？ | 有，且与 standard **逐字节相同**（同一 `isolate` 键与三个子行、同一 config） | 生成器的 retarget（`compaction-basic`→`compaction-codex`）**可直接复用** |
| 2 | `toolResultPruner` 是否也要照抄？ | 是。`isolate.toolResultPruner: true` 与 `thresholdChars/headChars/tailChars` 两版一致 | 复制 roster 时**必须整组保留**，不能只留 compaction |
| 3 | 组合会不会破坏 ptc 的 runtime 依赖？ | `ptc-runtime` 是顶层行，不在 preset 内 | **不会**；组合不新增也不删除任何 runtime |
| 4 | `workflow-ptc`/`tool-workflow` 的 `disabled` 会不会被生成器弄丢？ | 生成器逐行复制 roster（只改 compaction 两行） | 不会丢，**但要有断言**（见 §6） |
| 5 | `order` 冲突？ | registry：`.sort((a,b) => (a.order ?? Infinity) - (b.order ?? Infinity) \|\| a.id.localeCompare(b.id))` | 内置占 1–4；我们的 `codex` 用 `0` ⇒ **排在最前**（当前行为的 UX 值得复核）；新变体建议取 `5` |
| 6 | PTC 呈现改变工具调用形状，**影响我们的压缩选择器**（C1 配对）？ | [未验证] PTC 下工具调用被折叠进 `run_code`，surface 上的 tool-call/tool-result 配对预期变少、变粗 | **必须实测**（§7 实验 4）：确认切分点仍平衡、且不会因为"一个巨大的 run_code 结果"而无法释放 |
| 7 | 摘要调用的 tools 回放（C4）在 ptc 下是否仍匹配？ | [未验证] `SummarizationInput.tools` 来自最近一次路由请求；ptc 的 "tools" 是生成的 SDK | **必须实测**（§7 实验 4）：若回放的工具集与请求不一致，KV 缓存收益会退化为 0 |
| 8 | 副本漂移（通用问题） | 见 [`community-maintenance-notes.md`](community-maintenance-notes.md) §4/§5 | **本调查不重复**；沿用其结论：构建/安装期生成 + anchor 校验 |

---

## 4. 方案对比

**共同机制**（三案都必须做）：把某个 preset 的整个 roster 复制出来，只把隔离组里的
`compaction-basic` 换成 `dsh-compress-codex` —— 因为 preset 无 inherit、patch 只能整行替换
（[证据] 见 `docs/web-preset.md` 与 `community-maintenance-notes.md`）。

| | 方案 A：新增 `codex-ptc` preset | 方案 B：覆盖现有 `preset-ptc` | 方案 C：不做组合，只换默认 preset |
|---|---|---|---|
| 做法 | 以 ptc 为 base 生成**新行** `preset-codex-ptc`（插在顶层），用户在新会话选择器里选它 | 生成 `- id: preset-ptc / config:` 覆盖行，用户界面里仍叫 PTC，但压缩已是 Codex | 保持现状；建议用户改默认 preset 或接受 native 呈现 |
| 保留 stock ptc | ✅ 随时切回、可 A/B 对照 | ❌ 被替换（要回退需删掉覆盖行） | ✅ |
| 用户操作变化 | 每个新会话要在 chip 里选一次 "Codex (PTC)" | **零变化**（还是点 PTC） | 无 |
| 维护面 | 多一个副本要跟上游 drift | 同样的副本，但**静默**替换了官方 preset 的语义（别人看到 "PTC" 会以为是官方 ptc） | 无副本 |
| 风险 | UI 多一个条目；需给它 order/description | 出问题时用户**失去 PTC 模式本身**，且不易判断是压缩还是呈现的锅 | 用户丢掉 PTC 呈现（若不接受则方案不成立） |
| 工作量 | 生成器参数化（§6）+ 一次生成 + 验证 | 同上，只是 `--override` | 0 |

**推荐 A**，理由：组合模式的价值在于"**可对照**"——用户能一键在 stock PTC 与 Codex(PTC) 之间切换，
出问题时能立刻判断是压缩层还是呈现层；B 把两件事绑死，排障成本更高。**[推断]**
若用户明确表示"不想改日常点击习惯"，B 也是合法的，只要在文档里写清"这个 PTC 已被本地覆盖"。

**方案 C 的前提**是用户其实不需要 PTC 呈现 —— 这需要先问（见 §2 末）。

---

## 5. 命名与 UI 呈现（`暂无描述。` 的正确修法）

**根因**：UI 显示的是 **preset 行 `config` 里的 `name`/`description`**。我们生成的 `codex` 行只有
`id` 与 `order`，于是座位卡片回退到 `t('noDescription')`（中文 `暂无描述。`）。**[证据]**

- `@deepseek-ai/dsh-agent-preset` 的 `Config`：`{ id: string(required), name: string, description: string, order: number, plugins: array(required) }`。**[证据]**
- `@deepseek-ai/dsh-agent-preset-registry` 把 `config.{id,name,description}` 透传给客户端，
  并按 `order ?? Infinity`（同序再按 id）排序。**[证据]**
- 客户端 `presetOptions()` 原样使用 host 给的 `{id,name?,description?}`；座位卡片渲染
  `text.description ?? t('noDescription')`。**[证据]**
- **只有 4 个内置 id 有本地化文案**（`PresetGuideDialog` 里硬编码 `['standard']/['ptc']/['minimal']/['cordis']`）；
  自定义 id（如 `codex`、`codex-ptc`）**只能靠 `config.name/description`**，没有别的入口。**[证据]**

**正确填法**（写入生成的 preset 行）：

```yaml
- insert:
    - id: preset-codex-ptc
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: 'codex-ptc'
        name: 'Codex (PTC)'
        description: 'PTC 工具呈现（run_code + SDK）保持不变，压缩改用 dsh-compress-codex。'
        order: 5
        plugins:
          # …ptc 的整份 roster，其中 compaction 组已 retarget…
```

命名建议：**id `codex-ptc`**（kebab；它是 registry/存储里的键，别用空格），
**显示名 `Codex (PTC)`**；若要同时提供 standard 基座版，把现有的 `codex` 显示名补成 `Codex (Standard)`，
两个条目在同一选择器里就能一眼区分。**[推断]**

---

## 6. 生成器改造清单（`scripts/sync-preset-codex.mjs`）

现状（84 行）：已支持 `--profile/--base/--out/--plugin`，从 `dsh --profile web --dump-config` 取
`preset-<base>` 的 `plugins:` roster，逐行复制并只改两行（`compaction-basic` → `compaction-codex`、
包名 → 本插件），然后缩进 +4 塞进 `- insert:`。**硬编码**：输出行 id `preset-codex`、`config.id: 'codex'`、
`order: 0`、头部注释文案；并断言"恰好一个嵌套 `compaction-basic`"。**[证据]**

需要的参数化：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--preset-id` | `preset-codex` | 顶层行 id；决定是 insert 还是 override |
| `--config-id` | `codex` | `config.id`（registry 的键） |
| `--order` | `0` | 排序；新变体建议 `5`（内置占 1–4） |
| `--name` / `--description` | 省略 | 写入 `config.name/description`，修掉"暂无描述。" |
| `--override` | `false` | 目标行已存在时产出 `- id: <existing>\n  config:` 覆盖（方案 B），否则 `- insert:` |
| `--base ptc` 的默认派生 | —— | 例如 base=ptc → config-id `codex-ptc`、order `5`、预置中英文描述 |

另外两处**应当加强**（现在的断言不够）：
1. 断言目标 `compaction-basic` 必须**位于 `isolate.compaction` 组内**，而不只是"恰好一个"——避免上游改动后误改别处；
2. 对 base 的关键行做 **anchor 校验**（例如断言 `tool-presentation` 存在且 `mode: ptc`、
   `workflow-ptc`/`tool-workflow` 为 `disabled: true`），把"漂移"从静默变成失败——
   这正是 [`community-maintenance-notes.md`](community-maintenance-notes.md) §5 的建议。

---

## 7. 待实验清单（可执行命令，全部只读/临时 DSH_HOME）

```sh
# 0) 准备：一切都在临时 home 里做，绝不碰真实 ~/.dsh
export DSH_HOME=$(mktemp -d)
node scripts/assert-isolated-home.mjs
dsh --profile web --from-default-profile web --dump-config > /tmp/web.txt

# 1) 确认两版 roster 的真实差异（本报告的 §1 表格）
awk '/^- id: preset-standard/,/^- id: preset-ptc/' /tmp/web.txt > /tmp/r-std.txt
awk '/^- id: preset-ptc/,/^- id: preset-minimal/' /tmp/web.txt > /tmp/r-ptc.txt
diff -u /tmp/r-std.txt /tmp/r-ptc.txt

# 2) 用现有生成器产出 ptc 基座副本（注意：当前版本产出的 id 仍是 codex，见 §6）
node scripts/sync-preset-codex.mjs --profile web --base ptc --out /tmp/preset-codex-ptc.yml
grep -n 'tool-presentation\|workflow-ptc\|tool-workflow\|compaction-codex' /tmp/preset-codex-ptc.yml

# 3) 叠加后核对组成（隔离组是否已 retarget、ptc 的三处差异是否保留）
dsh --profile web --patch /tmp/preset-codex-ptc.yml --dump-config > /tmp/with-codex-ptc.txt
grep -n -A3 -E 'id: preset-codex-ptc|id: compaction-codex|id: tool-presentation' /tmp/with-codex-ptc.txt

# 4) 【关键】真实会话验证（需要凭据；沿用 SMOKE_SESSION 的做法）
#    要回答两件事：
#    (a) PTC 呈现是否仍然生效（工具目录里只有 run_code + SDK）；
#    (b) 压缩是否照常触发并写出 compaction/start→summary→user/message→end，
#        且摘要调用的 tools 回放与请求一致（C4），切分点仍 C1 平衡。
SMOKE_SESSION=1 node scripts/smoke-runtime.mjs   # 现有脚本走 standard 基座；ptc 变体需另配

# 5) 漂移检查（升级 dsh 后）：把上次生成的产物存一份，重跑后 diff
cp /tmp/preset-codex-ptc.yml /tmp/preset-codex-ptc.prev.yml      # 升级前留档
node scripts/sync-preset-codex.mjs --profile web --base ptc --out /tmp/preset-codex-ptc.yml
diff -u /tmp/preset-codex-ptc.prev.yml /tmp/preset-codex-ptc.yml
```

**必须先做实验 4**：(a)(b) 任一不成立，方案 A/B 都不该上。**[推断]**

---

## 8. 未解决 / 需要用户回答的问题

1. 你选 ptc 是因为**工具呈现**（run_code + SDK），还是只是习惯了这个 preset 名字？→ 决定要不要做组合（§2）。
2. 你希望日常点击习惯不变（方案 B），还是愿意在切换器里多选一个条目以换取可回滚（方案 A）？
3. 是否需要**同时**提供 standard 基座与 ptc 基座两个 Codex preset？（生成器参数化后成本很低）

## 9. 证据索引

| 结论 | 来源 |
|---|---|
| ptc 与 standard 的 5 处差异 | `dsh-web-app/presets/{standard,ptc}.patch.yml`；`dsh --profile web --dump-config` 两段 roster 的 `diff -u` |
| PTC 语义、`mode` 必填、需要 runtime | `@deepseek-ai/dsh-agent-tool-presentation/README.md`（原文见 §2） |
| `ptc-runtime` 是顶层行 | web profile 组成树中 `- id: ptc-runtime` / `@deepseek-ai/dsh-ptc-runtime-node` |
| preset 行接受的字段 | `@deepseek-ai/dsh-agent-preset/lib/index.js` 的 `static Config` |
| name/description 透传与 order 排序 | `@deepseek-ai/dsh-agent-preset-registry/lib/index.js`（`.sort((a,b) => (a.order ?? Infinity) - …)`） |
| UI 回退文案与内置 id 白名单 | `dsh-src/packages/client/ui-agent-preset/src/client/{locales.ts,settings-store.ts,PresetGuideDialog.tsx}` |
| 生成器现状 | `scripts/sync-preset-codex.mjs` |
| 无法 inherit / 如何避免漂移 | [`docs/community-maintenance-notes.md`](community-maintenance-notes.md)、[`docs/web-preset.md`](web-preset.md) |
