# codex-ptc 的 CI 判据与作业调查（task-26）

> **只调查，不改 workflow。** 本文只回答「判什么 / 能不能离线判 / 作业长什么样 / 怎么不假绿」。
> 证据标记：**[证据]** 本机实测或源码原文；**[推断]** 由证据推导；**[未验证]** 没跑过。
> 配套阅读：[`docs/codex-ptc-options.md`](codex-ptc-options.md)（codex × ptc 组合可行性）、
> [`docs/community-maintenance-notes.md`](community-maintenance-notes.md)（机制选型）。

---

## 0. 结论先行

1. **离线（不连模型、不需要凭据）能判的是一大类静态/组合/挂载事实**：生成物里 `tool-presentation` 存在且
   `mode: ptc`、`workflow-ptc`/`tool-workflow` 仍 `disabled: true`、compaction 组已 retarget、与上游
   `ptc.patch.yml` 的逐行 diff 只有预期行、装进临时 profile 后组合树可挂载。**这些已实测**（§2）。
2. **CI 今天跑不了真实会话。** 仓库没有任何 secret（`actions/secrets` → `total_count: 0`，
   `environments` → `total_count: 0`），没有任何 workflow 注入 `DEEPSEEK_API_KEY`，`compat.yml` 还把
   smoke 的 `SMOKE_ALLOW_SKIP=1` 打开 —— 所以 `smoke-runtime.mjs` 的 A7（真实多轮会话）在 CI 里**恒为 SKIP**。
   **[证据]**
3. **但「会话判据」本身可以离线重放**：`scripts/smoke-runtime.mjs` 里已经有会话日志解码器（含多帧 zstd 的坑）
   和 compaction 序列断言，缺的只是「日志从哪来」。**[证据]**
4. **建议**：离线判据并入现有 `ci / preset-drift`（同一份 dsh 安装，省一次 ~36s 安装），**不进必需门禁**；
   真实会话判据做成**非门禁**作业 + 一个**离线校验器**，缺凭据时明确报 `INCOMPLETE — SKIPPED`，
   绝不出现 PASS 字样。**[推断]**

---

## 1. 判据候选表

### 1.1 可离线验证（无凭据、不连模型）

| # | 判据 | 实测结论 | 依据 |
|---|---|---|---|
| O1 | 生成物含 `tool-presentation`，且 `config.mode: ptc` | 成立（生成物 127–130 行） | **[证据]** 本机跑生成器 |
| O2 | `workflow-ptc` 与 `tool-workflow` 仍是 `disabled: true` | 成立（108–115 行） | **[证据]** 同上 |
| O3 | 隔离 compaction 组已 retarget：`compaction-codex` / `dsh-compress-codex`，且 `command-compact`、`tool-result-pruner` 保留 | 成立 | **[证据]** 同上 |
| O4 | 生成物与上游 `ptc.patch.yml` 的逐行 diff = 预期行集合 | 实测共 21 行差异：头部 3 行→7 行、`preset-<base>`→`preset-codex`、`config.id`/`order`、compaction 两行、末尾空行 | **[证据]** `diff` 输出 |
| O5 | 上游 ptc 源文件的 SHA256 anchor 已记录 | **未成立**：`scripts/preset-anchors.json` 目前只有 `standard`；ptc 的哈希是 `9e355c947bf61c3d2fe9bf3214b386f83c0d99d37579ce22576d4b82cb6e1a2c` | **[证据]** 实测 |
| O6 | 组合层：把生成物装进临时 profile 后 `--dump-config` 能看到该 preset 行、其内 `tool-presentation(mode: ptc)`、`compaction-codex`，且**无** `patch: entry ... not found` | 成立（dump exit 0，未解析 patch 目标 0 条） | **[证据]** 临时 `DSH_HOME` 实测 |
| O7 | 挂载层：`ptc` 模式在部署缺少兼容 PTC runtime 时，registry 会在**挂载期拒绝**并指名该行；因此「能挂载」本身就是可判据 | 官方 README 原文成立；A6 式 boot 探测**不需要凭据**（boot 到 `a task is required` 即返回，无模型调用） | **[证据]** `dsh-agent-tool-presentation/README.md` + `smoke-runtime.mjs` A6 源码 |
| O8 | UI 元数据：生成物 `config.name`/`config.description` 非空（修「暂无描述。」） | 取决于生成器参数化（见 `codex-ptc-options.md` §6），当前仍硬编码 | **[推断]** |

### 1.2 只能在真实会话里验证（需要真实 provider）

| # | 判据 | 说明 | 依据 |
|---|---|---|---|
| S1 | **PTC 呈现**：会话 `request/header` 事件的 `header.tools` 长度为 1 且唯一项 `name === 'run_code'`（native 基座同一字段是 40 个工具） | `header` 由 agent loop `session.append("request/header", { header, reason })` 落盘，`header.tools` 即呈现给模型的工具表；仅首帧/变更/新序列时记录 | **[证据]** Lead 第一手实测 + `dsh-agent-loop/lib/index.js` 源码 |
| S2 | **压缩**：出现 `compaction/start → compaction/summary → user/message → compaction/end`（同一 `compactionId`、`user/message` 紧邻 summary 的 seq = C3 相邻），且 `end.error` 为空、summary 的 `provider`/`model`/文本非空 | 该断言**已实现**在 `smoke-runtime.mjs` A7 中 | **[证据]** `scripts/smoke-runtime.mjs` 266–300 行 |
| S3 | 隐含项：PTC 的 `run_code` + 生成 SDK 往返真的跑通（不是挂载就算数） | —— | **[未验证]** |

---

## 2. 离线判据的命令与实测结果

以下命令全部在临时环境跑过，未改仓库文件、未碰真实 `~/.dsh`：

```sh
# O1–O4：用临时 anchors（不动仓库的 scripts/preset-anchors.json）
cp scripts/preset-anchors.json /tmp/ptc-anchors.json
node -e 'const fs=require("node:fs"),c=require("node:crypto");const p="/tmp/ptc-anchors.json";
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.sources.ptc=c.createHash("sha256").update(fs.readFileSync(process.argv[1],"utf8")).digest("hex");
  fs.writeFileSync(p,JSON.stringify(j,null,2))' "$DSH_NODE/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml"
node scripts/sync-preset-codex.mjs --base ptc --anchors /tmp/ptc-anchors.json --out /tmp/codex-ptc.yml
grep -n -A 3 'tool-presentation' /tmp/codex-ptc.yml        # O1
grep -n -A 1 'workflow-ptc\|tool-workflow' /tmp/codex-ptc.yml  # O2
grep -n 'compaction-codex\|dsh-compress-codex' /tmp/codex-ptc.yml  # O3
diff "$DSH_NODE/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml" /tmp/codex-ptc.yml  # O4
```

实测要点：

- ptc 源文件 **134 行**，SHA256 `9e355c947bf61c3d2fe9bf3214b386f83c0d99d37579ce22576d4b82cb6e1a2c`；
- 生成器对 `--base ptc` **已能工作**（6 处计数重写全部命中）；但 `--preset-id/--config-id/--order`
  仍硬编码为 `preset-codex`/`codex`/`0`，产出 `codex-ptc` 前需要先做 `codex-ptc-options.md` §6 的参数化；
- diff 的 21 行里，**只有 6 行是语义改动**（preset id、config.id、order、两行 compaction），其余是头部注释与一个空行。

```sh
# O6：装进临时 profile 再 dump（组合作层验证）
export DSH_HOME=$(mktemp -d)
dsh --profile ptcck --from-default-profile web --dump-config >/dev/null
cp /tmp/codex-ptc.yml "$DSH_HOME/profiles/ptcck/cordis.patch.yml"
dsh --profile ptcck --dump-config > /tmp/dump-ptc.yml
grep -c 'patch: entry .* not found' /tmp/dump-ptc.yml   # => 0
```

注意：新 profile 的 `cordis.patch.yml` 默认是**空数组占位符 `[]`**，必须整文件替换（`cp`）而不是 `cat >>`，
否则 YAML 解析失败（已在 `docs/web-preset.md` 记录）。**[证据]**

---

## 3. 真实会话：CI 里能不能跑？（必须回答：**不能**）

### 3.1 读脚本得到的边界

- `scripts/smoke-runtime.mjs` 的 **A1–A6 不需要凭据**：A1–A5 是 profile/dump 层；A6 是**真 boot**，
  但它在无任务时 boot 到 `a task is required` 就返回，**不发起模型调用**。**[证据]**
- **A7 需要凭据**：`SMOKE_SESSION=1` 才尝试；凭据来源是 `DEEPSEEK_API_KEY` 环境变量，
  否则**读取真实 home 的 `~/.dsh/.credentials.yaml`** 复制进临时 home；两者都没有 → `SKIPPED`。
  它还会强制 `triggerLimitTokens: 2000` 并重新启用 `credentials` 行（headless 模板默认禁用）。**[证据]**
- 该脚本自己声明：`a skip is NOT a pass`；`SMOKE_ALLOW_SKIP=1` 只影响退出码，**结论行仍写 INCOMPLETE**。**[证据]**

### 3.2 读 workflow 得到的现状

| 事实 | 值 | 出处 |
|---|---|---|
| 仓库级 secret 数 | `total_count: 0` | `gh api .../actions/secrets` **[证据]** |
| environment 数 | `total_count: 0` | `gh api .../environments` **[证据]** |
| workflow 里出现的 secret | 只有 `release.yml` 的 `secrets.NPM_TOKEN`（且缺失时**报错拒发**） | `grep -rn 'secrets\.' .github/workflows` **[证据]** |
| workflow 里是否注入过 `DEEPSEEK_API_KEY` | **没有** | 同上 **[证据]** |
| `compat.yml` 跑 smoke 的方式 | `SMOKE_ALLOW_SKIP=1`，无凭据 → A7 恒 SKIP | `compat.yml` **[证据]** |

**结论：CI 里不能跑真实会话**，因为没有凭据；即使忽略凭据，真实会话还要连模型（网络、配额、按量计费）
且天然抖动。**不要把「没凭据」包装成 PASS**：本项目 F4/F5 的教训就在这。

### 3.3 替代方案（三档）

| 档 | 做法 | 代价 / 风险 | 建议 |
|---|---|---|---|
| A | 加 `DEEPSEEK_API_KEY` secret + 非门禁作业（`workflow_dispatch` 或 label 触发） | 每跑一次真实计费；fork PR **拿不到 secret**（必须降级为 INCOMPLETE）；超时/抖动 | 可选，**不进必需门禁** |
| B | 把真实会话日志提交进仓库当 fixture | 隐私（含真实 prompt/请求头）、体积、日志格式漂移；脱敏后「真实性」下降 | **不推荐** |
| C | **离线校验器 + 人工留档**：把 A7 的解码器与断言抽成 `scripts/check-session-criteria.mjs <log...>`，对任意会话日志重放 S1/S2；真实运行由一次人工（或 A 档作业）产出日志 artifact | 需要一次真实运行来产出证据；校验器本身无凭据、确定性强 | **推荐**（与 A 档可叠加） |

C 档的关键性质：**CI 判的是「这份日志满足判据」，而不是「CI 刚刚跑了一个会话」**。
因此判词必须写清来源（artifact 名 + 运行链接 + 日志 sha256），否则又会变成一种新的假绿。

---

## 4. 新作业形态（推荐）

### 4.1 离线判据：**不新增作业**，并入 `ci / preset-drift`

- 该作业已经安装 dsh 并校验 anchor；O1–O4/O6/O7 需要**同一份** dsh 安装。[证据] 实测 `ci / preset-drift`
  单次 43s，其中约 36s 是 `npm install`；新开作业等于把这 36s 再付一次。
- 建议把 O 系列做成该作业的**独立步骤**（每步各自打印判词），作业名保持 `ci / preset-drift` 不变；
  若将来判据需要 pnpm 或不同 dsh 版本，再拆成 `ci / codex-ptc`。
- 备选：若坚持要独立判词与独立重跑，则新增 `ci / codex-ptc`，但必须共享 dsh 安装（actions/cache 或
  artifact），否则是纯重复。**[推断]**

### 4.2 真实会话判据：`ci / codex-ptc-session`（**非门禁**）

- 触发：`workflow_dispatch`（+ 可选 label），**不在 PR 主路径上**；
- 有 `DEEPSEEK_API_KEY` 时：跑一次真实会话 → 产出日志 → **同一作业内**用离线校验器判 S1/S2；
- 无凭据时：`PRESET-PTC-SESSION: INCOMPLETE — SKIPPED (no credential)` + `::warning::`，**不出现 PASS**。

### 4.3 是否加入必需门禁：**不加**

| 理由 | 证据 |
|---|---|
| 现有必需清单是 `ci / linux`、`ci / windows`、`ci / macos`、`ci / node22`；`dump-smoke`、`preset-drift` 都因「需要真实 dsh/registry」而**故意非必需** | 分支保护 API + workflow 注释 **[证据]** |
| main 保护是 `strict: true` + `enforce_admins: true`，已实测出现 `BLOCKED`；新增必需作业会把「上游 preset 变了」升级成阻塞合并 | **[证据]** |
| 判据本质是「上游是否变了」的信号，不是本仓库的正确性；registry 抖动不该阻塞 main | **[推断]** |

---

## 5. 反假绿设计（针对 F4/F5 教训）

1. **三态退出码 + 判词字面**：`0 → PASS`、`1 → FAIL`、`2 → INCOMPLETE — SKIPPED`。
   INCOMPLETE 分支**禁止出现 PASS 字样**，并用 `grep -q 'PASS'` 在作业内自测这条性质（别靠人眼）。**[推断]**
2. **空集合断言陷阱**：断言「生成物里有 `mode: ptc`」之前，必须先断言「**源文件里本来就有** `mode: ptc` /
   两条 `disabled: true`」。否则上游哪天删掉该行，产物侧断言会退化成对不存在的东西做检查而**假绿**。
   这与 `smoke-runtime.mjs` 的 A5 negative control 是同一手法。**[推断]**
3. **fault injection（必须变红的变异）**：生成物 `mode: ptc` → `native`；删一条 `disabled: true`；
   `compaction-codex` → `compaction-basic`；篡改 anchor（单字节）→ 每条都必须让判据红。沿用
   `sync-preset-codex.mjs --selftest` 的既有模式，在 CI 里每次跑。**[推断]**
4. **O4 的期望差异必须由脚本计算**（比对「源 → 生成物」的 6 处重写），**不要写死 21 行**：
   写死的话，上游新增一段 roster 只会让 diff 变长，断言仍可能通过。**[推断]**
5. **证据留档**：输出源文件路径 + 源 sha256 + 生成物 sha256 + 被判据命中的行号，使「到底验了什么」可复核。**[推断]**
6. **禁止**：`|| true`、把断言步骤包进 `continue-on-error`（只允许包住「安装 dsh」这类外部依赖步骤）。**[推断]**

---

## 6. 待补 / 待验证清单

1. `scripts/preset-anchors.json` 需要补 `ptc` 的 anchor（`9e355c94…`）——否则 `--base ptc` 会以
   「no anchor recorded」失败。**[证据]**
2. 生成器需要参数化 `--preset-id/--config-id/--order/--name/--description`，O8（UI 元数据）才可断言。**[推断]**
3. O7 的 boot 探测在 **codex-ptc** 下是否也能像 A6 一样在无凭据时走到 app stage：**未跑过**。**[未验证]**
4. 若走 A 档真实会话：单轮 token 成本、超时上限、fork PR 的行为都需要实测。**[未验证]**
5. S1 的 `request/header` 会不会因为 `headerEquals`（仅在首帧/变更/新序列时记录）而在真实会话里**缺失**：
   按源码应有 `reason: initial` 的首帧；但**未在真实会话日志里核对过**。**[未验证]**

---

## 7. 复现命令（判定 CI 是否有凭据）

```sh
gh api repos/Thatgfsj/dsh-Compress-codex/actions/secrets      # {"total_count":0}
gh api repos/Thatgfsj/dsh-Compress-codex/environments         # {"total_count":0}
grep -rn 'secrets\.\|DEEPSEEK_API_KEY' .github/workflows      # 只有 release.yml 的 NPM_TOKEN
gh api repos/Thatgfsj/dsh-Compress-codex/branches/main/protection   # strict=true, 4 个必需上下文
```
