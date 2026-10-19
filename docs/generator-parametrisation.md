# 生成器参数化调查（`scripts/sync-preset-codex.mjs`）

> **只调查，不改代码。** 本文基于**逐行读完的 358 行实现**（`6d1df9d`/#53 之后的版本），
> 每条结论给出**行号**或**跑过的命令**。标记：[证据] 读过的代码/跑过的命令；[推断] 由证据推导；[未验证] 未跑过。
> 关联：[codex-ptc-options.md](codex-ptc-options.md) §6（缺什么）、[community-maintenance-notes.md](community-maintenance-notes.md)（为什么必须复制）。

---

## 0. 结论先行

1. **参数化是 5 个新 flag + 4 处改动点，不动骨架**：改动集中在 `transform()` 的三条 rewrite 规则
   （L177/L178/L179）与头部文案（L188-196），加上 `main()` 的默认值（L250-257）。**[证据]**
2. **无参输出可以做到逐字节不变**，前提是"新值的默认值 === 今天的字面量"，且
   `--name`/`--description` **缺省时不插入任何行**。证明方法见 §2.3（一条 `cmp` + 一条可长期保留的回归断言）。**[推断+可执行]**
3. **`--name`/`--description` 推荐"在 `config.id` 行后插入"**（复用 rewrite 捕获的缩进 `m[1]`），
   值用**单引号标量 + `'` 双写**；实测 5 组对抗性取值（含 `'`、`:`、`#`、`{}`、全角括号、中文）round-trip 全 EXACT。**[证据]**
4. **ptc 的 anchor 不需要改结构**：`sources.<base>` 天然按 base 分键（L204/L224），`--update-anchor` 只加不改；
   但 `baseline` 是**单一全局字段**（L212），且只在"当前为 null 且传了 `--baseline`"时才写（L225）——见 §4 的取舍。**[证据]**
5. **`--override` 不是小改动**：上游文件是完整 `- insert:` patch（L157 锚点），改成覆盖要换外壳并整体反缩进，
   属于结构性重写，建议**单列一个脚本或推迟**。**[证据]**
6. **组内断言（Q4）不需要 YAML 依赖**：脚本零依赖是硬约束（L35-40 只 import `node:` 内建），
   用"分组区间切片 + 缩进比较"即可，约 15 行。**[推断]**

---

## 1. 现有实现地图（带行号，回答"改哪里"）

| 区块 | 行 | 作用 |
|---|---|---|
| 常量 | L42-48 | `HERE`、`DEFAULT_ANCHORS = <script dir>/preset-anchors.json`、`EXIT_OK/FAIL/INCOMPLETE` |
| 参数读取 | L50-59 | `argValue(name)` = `argv[argv.indexOf('--'+name) + 1]`；`flag(name)` = `argv.includes` |
| 源定位 | L74-120 | `sourceUnder()` 两个候选路径（含 `dist/presets`）；`dshOnPath()`（win32 试 `dsh.cmd/.exe/dsh`）；`sourceFromDshBinary()` 向上最多 8 层 |
| 源解析顺序 | L122-146 | `--source` → `DSH_PRESET_DIR` → `DSH_BIN`/`PATH` → 否则 `{reason}`（INCOMPLETE） |
| **transform()** | L148-198 | L157 以 `- insert:` 为切片锚点；L162-175 `rewrite()` **计数必须恰为 1**，否则 throw；L177-186 六条规则；L188-196 头部 7 行；L197 拼接 |
| anchor 读写 | L200-217 | `readAnchors` 容忍缺文件；`writeAnchors` 以**固定键序 + 2 空格**重写整个 JSON |
| anchor 校验 | L219-247 | L223-229 `--update-anchor` 分支；L230-235 无 anchor ⇒ FAIL；L236-243 不匹配 ⇒ FAIL（打印 expected/actual） |
| main() | L249-282 | L250-257 默认值；L258-263 源不可达 ⇒ INCOMPLETE(2)；L267-268 anchor 不过 ⇒ 原样返回；L269-272 `--check` **在 transform 之前返回**；L274-281 transform + `writeFileSync(options.out)` |
| selftest | L284-356 | 临时目录 + 真实上游文件副本；L309 临时文件名写死 `standard.patch.yml`；L318-345 **8 条**期望 |
| 入口 | L358 | `process.exit(flag('selftest') ? selftest() : main())` |

### 1.1 六条 rewrite 规则（L177-186）

| # | 行 | 匹配 | 产出 | 计数 |
|---|---|---|---|---|
| 1 | L177 | `^(\s*)- id: preset-<base>$` | `- id: preset-codex` | 1 |
| 2 | L178 | `^(\s*)id: <base>$` | `id: codex` | 1 |
| 3 | L179 | `^(\s*)order:\s*\d+$` | `order: 0` | 1 |
| 4 | L180 | `^(\s*)compaction:\s*true$` | 原样 | 1（**纯计数守卫**） |
| 5 | L181 | `^(\s*)- id:\s*compaction-basic$` | `- id: compaction-codex` | 1 |
| 6 | L182-186 | `^(\s*)name:\s*'@deepseek-ai/dsh-compaction-basic'$` | `name: '<plugin>'` | 1 |

**[证据]** `rewrite()`（L162-175）对每条规则统计命中数，`seen !== 1` 就抛
`expected exactly 1 <label> row(s) in the upstream patch, found N` —— 这正是"上游形状变化 ⇒ 大声失败"的实现。

---

## 2. Q1 参数化设计 + 无参输出逐字节不变

### 2.1 新增 flag 与默认值（默认值 = 今天的字面量）

| flag | 默认 | 落到哪一行 |
|---|---|---|
| `--preset-id` | `preset-codex` | L177 的产出、L189 头部首行 |
| `--config-id` | `codex` | L178 的产出 |
| `--order` | `0` | L179 的产出 |
| `--name` | **缺省 = 不插入** | L178 之后插入一行 |
| `--description` | **缺省 = 不插入** | 同上 |
| `--out`（已有） | `preset-codex.patch.yml` → **建议改为 `<preset-id>.patch.yml`** | L254；默认时两者同值，故仍是逐字节兼容 |

### 2.2 最小侵入改法（4 处）

1. **`main()` L250-257**：把 `options` 扩成 `{ base, plugin, out, anchors, baseline, presetId, configId, order, name, description }`；
   `presetId` 默认 `'preset-codex'`、`configId` 默认 `'codex'`、`order` 默认 `0`（**都是今天的字面量**）。
2. **L177/L178/L179**：把写死的字符串换成上面的值。
3. **L178 的 `build` 改为可返回多行**：见 §3。**[证据]** `body.map(...)`（L164）的返回值会被 `header.concat(body).join('\n')`（L197）
   直接拼接，因此返回含 `\n` 的字符串是安全的——不需要改 `rewrite()` 的签名。
4. **L189 头部首行**：`'# preset-codex -- the shipped "' + base + '" preset whose isolated compaction'`
   → 用 `options.presetId` 替换 `preset-codex`。默认时字符串完全相同。**[证据]** L190-196 不含 `preset-codex`，故无需改动。

### 2.3 如何保证并证明"无参输出与今天逐字节相同"

**三条不变式**（实现时必须满足）：
1. 所有新默认值 === 今天的字面量（§2.1）；
2. `--name`/`--description` 缺省时，`build` 返回**与今天完全相同的那一行**，不追加空行/空格；
3. L162-175 的"计数必须为 1"逻辑与 L197 的拼接方式不变（含**文件尾**：当前产物以 `\n\n` 结束）。

**证明方法（一次性，对比改前/改后二进制）**：

```sh
# 0) 改前先留 golden（在未修改的 checkout 上）
node scripts/sync-preset-codex.mjs --out /tmp/before.yml && sha256sum /tmp/before.yml

# 1) 参数化之后，用**完全无参**跑
node scripts/sync-preset-codex.mjs --out /tmp/after.yml

# 2) 判定
cmp /tmp/before.yml /tmp/after.yml && echo 'IDENTICAL'
```

**[证据] 本机当前（参数化之前）的 golden**：`1f529f3aa64164646d96e6175248060cca392d785e4cd64c15f181bda53a7209`，
133 行，文件尾为 `...ue\n\n`（`tail -c 4 | od -c` = `u e \n \n`）——**比对必须比整文件，不能只比行**。

> **跑老脚本的两个坑**（实测必然踩到）：`DEFAULT_ANCHORS` 是 **脚本所在目录** 的相对路径（L43），
> 所以把旧脚本 `git show` 到 `/tmp` 再跑会找不到 anchor，必须显式 `--anchors <repo>/scripts/preset-anchors.json`；
> 源文件可继续由 `PATH` 上的 dsh 解析（L105-120），也可 `--source` 指定。

**可长期保留的回归断言**（不依赖 golden 文件，适合进 selftest）：

```sh
node scripts/sync-preset-codex.mjs --out /tmp/a.yml
node scripts/sync-preset-codex.mjs --preset-id preset-codex --config-id codex --order 0 --out /tmp/b.yml
cmp /tmp/a.yml /tmp/b.yml && echo 'defaults are exactly the literals'
```

它证明的是"**默认值 == 显式传字面量**"，因此今后任何人把默认值改掉都会立刻变红。**[推断]**

---

## 3. Q2 `--name`/`--description` 的 YAML 注入

### 3.1 两种做法与可靠性

| 做法 | 机制 | 可靠性 |
|---|---|---|
| **A. 在 `config.id` 行后插入（推荐）** | 把 L178 的 `build` 改成返回 `id: …` + 若干新行，缩进复用捕获组 `m[1]` | **[证据]** `m[1]` 就是上游 `id:` 行的真实缩进（standard/ptc 均为 8 空格），因此插入行的缩进天然正确；不需要重新计算层级 |
| B. 改写 id 行的同时追加（与 A 等价） | 同上，只是写法不同 | 无独立优势 |
| C. 在 `order:` 行后插入 | 需要额外捕获另一条规则的行 | 与 A 等价但多一处耦合；且 Config 的字段顺序是 id/name/description/order（`@deepseek-ai/dsh-agent-preset` 的 `static Config`），插在 id 后更易读 |

> 位置不影响 YAML 语义（映射无序），这里只为**可读性与最小 diff** 选择 A。**[推断]**

### 3.2 引号规则：单引号标量 + `'` 双写（本机实测）

**[证据]** 用 dsh 自带的 `yaml` 包解析"单引号标量"策略，5 组对抗性取值全部 round-trip **EXACT**：

| 取值 | 结果 |
|---|---|
| `Codex (PTC)` | OK |
| `PTC 呈现保持 run_code; 压缩改用 codex（含全角括号与中文）` | OK |
| `含有 ' 单引号` | OK（`'` 双写成 `''`） |
| `含有 : 冒号 与 # 井号` | OK |
| `x: {a: 1}  # not a comment` | OK |

推荐实现（约 4 行）：`yamlScalar(s) = "'" + s.replaceAll("'", "''") + "'"`，并**拒绝**含 `\n`/`\r` 的取值（直接 FAIL，
不要试图折叠成多行标量）。

**必须显式拒绝的两类输入**（否则是"静默产出坏 YAML"）：
1. 值里含换行 —— 单引号标量不能跨行；
2. **`argValue()` 的取值为另一个 flag**：L51-53 是"取下一个 token"，`--name --out x` 会让 `name === '--out'`；
   而 `--name` 位于末尾时 `argv[index+1]` 是 `undefined`，表现得像"没传"——**静默吞掉用户意图**。
   建议：`value === undefined || value.startsWith('--')` ⇒ FAIL 并提示。**[证据]**

---

## 4. Q3 ptc 的 anchor 与 `baseline`

- **结构不用改**：`readAnchors`（L200-206）返回 `sources` 映射；`verifyAnchor` 只读写 `sources[options.base]`（L222/L224）；
  `writeAnchors`（L208-217）把解析到的 `sources` 原样写回（键序固定、2 空格缩进）。因此给 ptc 记 anchor
  **不会覆盖 standard**。**[证据]**
- **`baseline` 是单一全局字段**（L212），且 L225 只在 `anchors.baseline === null` 且传了 `--baseline` 时写入
  ⇒ **已经写过 baseline 之后，再 `--update-anchor` 无法更新它**，只能手改 JSON。**[证据]**
- 建议（保守）：**保持结构**，把 `baseline` 语义明确为"所有已登记 anchor 取自同一个 dsh 版本"，
  升级时对**所有 base** 一起 `--update-anchor`，并在文档里写清"`baseline` 不会自动跟进"。**[推断]**
- 可选（较大改动）：`sources.<base> = { sha256, baseline }`，让每个 base 自带版本；代价是改
  `readAnchors/writeAnchors/verifyAnchor` 三处与 `//sources` 注释（L213），并且 selftest 里 L317/L327/L330 的
  `writeAnchors({baseline, sources})` 调用形态全部要改。**不建议**在本次参数化里一并做。**[推断]**
- 另注：`--update-anchor`（L223-229）**不做二次确认、也不打印 diff**，它假定操作者已经看过生成结果。**[证据]**

---

## 5. Q4 把"恰好 1 处 `compaction-basic`"升级为"必须位于 `isolate.compaction` 组内"

**现状**：L181 只统计全文件出现次数（L162-175 的计数守卫），因此"同一行恰好出现一次"成立，
但**不保证它在隔离组里**——上游若在别处再放一个 `compaction-basic`，计数变 2 会失败（算幸运），
而"把组内这行挪出去、别处留一个"形态会让计数仍为 1 却改错对象。**[证据+推断]**

**上游真实形状**（standard/ptc 一致）：

```text
          - id: compaction              (10 空格)
            name: cordis:group          (12)
            group: true                 (12)
            isolate:                    (12)
              compaction: true          (14)  ← L180 已计数
            config:                     (12)
              - id: compaction-basic    (14)  ← L181 改这一行
```

注意：**`compaction: true` 与 `- id: compaction-basic` 缩进相同（14）**，
所以"子行缩进 > `compaction: true` 缩进"这种判据是**错的**（容易写成看似合理却失败的检查）。**[证据]**

**推荐实现（零依赖，约 15 行，插在 L180 与 L181 之间）**：
1. 找到 `- id: compaction`（组头，记缩进 `gi`）；找不到或多于 1 个 ⇒ FAIL；
2. 从组头往后切出**该组区间**：直到出现缩进 `<= gi` 的下一行（或文件尾）；
3. 断言区间内：`isolate:` 恰 1、`compaction: true` 恰 1、`config:` 恰 1、`- id: compaction-basic` 恰 1，
   且 `compaction: true` 出现在 `config:` 之前、`compaction-basic` 出现在 `config:` 之后；
4. 之后的 L181 改写仍走 `rewrite()`（保持"计数=1"的既有风格），只是把范围限定在第 2 步切出的区间内。

**对现有 selftest 的影响**：8 条期望**全部保留有效**——
`lost retarget row fails`（L338）改的是行名，仍会因区间内找不到行而失败。**需新增**一条反向用例：
把 `- id: compaction-basic` 移到组外（例如反缩进到与 `- id: compaction` 同级）⇒ 必须 FAIL。**[推断]**
零依赖约束不可破：L35-40 只 import 内建模块，**不要**引入 `yaml` 包。**[证据]**

---

## 6. Q5 selftest 如何覆盖 ptc（反向证明扩展清单）

现状 8 条（L318-345）：pristine 生成 / 产物确实被 retarget / anchor 被篡改 / 模拟上游改动 / 重新 baseline 后通过 /
丢掉 retarget 行 / 缺 anchor / 源缺失 ⇒ INCOMPLETE(2)。**[证据]**

**实现细节要注意**：selftest 把上游文件复制成**写死的临时文件名** `standard.patch.yml`（L309），
但通过 `--source` 显式指路（L316），所以 `--base ptc --selftest` 也能跑；L321-324 的产物断言用的是
**写死的 `preset-codex`/`compaction-codex`/`dsh-compress-codex`** —— 参数化之后**必须让这些断言使用"本次传入的 id"**，
否则一改默认值，selftest 就会变成"永远通过的空壳"。**[推断]**

建议新增（每条给出期望退出码）：

| # | 用例 | 期望 |
|---|---|---|
| 9 | `--name` 含 `'`/`:`/`#`/全角括号 → 产物可被 YAML 解析且值 round-trip | 0（解析断言需在外部；见 §8 实验 3） |
| 10 | `--name` 含换行 | 1（显式拒绝） |
| 11 | `--name` 后紧跟另一个 flag（`--name --out x`） | 1（拒绝，而非静默吞掉） |
| 12 | `--base ptc` + 已有 ptc anchor | 0 |
| 13 | `--base ptc` + 无 ptc anchor | 1（现有第 7 条的定向版本） |
| 14 | 给 ptc 记 anchor 后，standard 条目仍在 | 0（`sources` 未被清空） |
| 15 | 产物保留 ptc 三处差异（`tool-presentation`/`mode: ptc`/两个 `disabled: true`） | 结构化断言 |
| 16 | `compaction-basic` 被移到组外 | 1（Q4） |
| 17 | 无参输出 == 显式传默认字面量输出（§2.3 的回归断言） | 0 |

**[推断]** 9/15 需要"读产物"级别的断言，现有 selftest 已有先例（L319-325 读产物并做 `includes` 检查）。

---

## 7. Q6 风险清单

| # | 风险 | 依据 | 建议 |
|---|---|---|---|
| 1 | **默认输出名撞车**：`--out` 默认 `preset-codex.patch.yml`（L254）且写入 **CWD**（L279） | [证据] | `--out` 默认改为 `<preset-id>.patch.yml`；默认时字符串不变 |
| 2 | **`argValue` 静默吞值**：末尾缺值 → `undefined` 等同于"没传"；值可被下一个 flag 顶掉（L51-53） | [证据] | 新增显式校验：缺值或值以 `--` 开头 ⇒ FAIL |
| 3 | **`--override` 被低估**：上游文件是完整 `- insert:` patch（L157 锚点），覆盖模式要换成 `- id: preset-<base>` + `config:` 并把整段**反缩进 2 格** | [证据] | **不在本次参数化内**；单列一个脚本/议题，或明确"仅支持 insert 形态" |
| 4 | **其它 base**：standard/ptc/minimal/cordis **都恰好有 1 个 `compaction-basic`、1 个 `order:`**（实测），因此规则 3/5 对四个 base 均成立；minimal 只有 2 个 `isolate:`（其余 3），但不影响规则 | [证据] | 每个新 base 都要先记 anchor；把"四个 base 的计数自检"写进 selftest |
| 5 | **Windows**：`dshOnPath` 已试 `dsh.cmd/.exe`（L85）；路径全用 `join`；头部注释用字面 `/`（L193）无影响 | [证据] | 无需改动；在 CI 的 windows 腿跑一次 `--selftest` 更稳（现有 selftest 不含 dsh 依赖，可跑） |
| 6 | **CI 调用面**：`ci / preset-drift` 跑 `--check`（ci.yml:135）与 `--selftest`（ci.yml:142）；`compat.yml:88` 跑 `--check`；`preset-drift-check.sh` 把 0→PASS、2→INCOMPLETE+warning、其它→FAIL | [证据] | `--check` 在 transform 之前返回（L269-272），**name/description 不可能影响它**；只要默认路径退出码不变，CI 语义不变 |
| 7 | **零依赖约束**：脚本只 import `node:` 内建（L35-40） | [证据] | Q4 的结构化检查**不得**引入 `yaml` 包 |
| 8 | **selftest 断言写死 id**（L321-324）：参数化后若不改成"用传入的 id"，会退化为空壳 | [推断] | 见 §6 末段 |
| 9 | **`baseline` 不会自动跟进**（L225） | [证据] | 文档写清；或纳入"升级流程：两个 base 一起 `--update-anchor`" |
| 10 | 生成物**未被提交进仓库**（无 golden 文件），漂移只能靠 anchor 发现 | [证据] | 保持现状即可；若要更严，可把产物纳入 git 并让 CI diff（与 anchor 重复，暂不建议） |

---

## 8. 待实验清单（可执行命令）

```sh
# 0) 记录今天的 golden（参数化前，必须在未修改的 checkout 上）
node scripts/sync-preset-codex.mjs --out /tmp/before.yml
sha256sum /tmp/before.yml        # 期望 1f529f3a…（133 行，文件尾 \n\n）

# 1) 参数化后：无参输出必须逐字节相同
node scripts/sync-preset-codex.mjs --out /tmp/after.yml
cmp /tmp/before.yml /tmp/after.yml && echo IDENTICAL

# 2) 默认值回归断言（可进 selftest）
node scripts/sync-preset-codex.mjs --out /tmp/a.yml
node scripts/sync-preset-codex.mjs --preset-id preset-codex --config-id codex --order 0 --out /tmp/b.yml
cmp /tmp/a.yml /tmp/b.yml && echo 'defaults are the literals'

# 3) YAML 注入实测：生成一份带中文/引号/全角括号描述的 patch，再用**宿主自己的解析器**验证
#    （比任何自写校验都强——能过 dsh 的 YAML 解析才算数）
export DSH_HOME=$(mktemp -d)
node scripts/assert-isolated-home.mjs
node scripts/sync-preset-codex.mjs --base ptc \
  --preset-id preset-codex-ptc --config-id codex-ptc --order 5 \
  --name "Codex (PTC)" --description "保持 ptc 呈现；压缩改用 codex（实验 '引号' : 冒号 # 井号）" \
  --out "$DSH_HOME/probe.yml"
dsh --profile probe --from-default-profile headless --dump-config >/dev/null   # 建 profile
# 把 probe.yml 当作 --patch 叠加，若 YAML 有问题会在解析期直接报错
dsh --profile probe --patch "$DSH_HOME/probe.yml" --dump-config | grep -A6 'id: preset-codex-ptc'

# 4) ptc anchor 两 base 共存
node scripts/sync-preset-codex.mjs --base ptc --check          # 预期 exit 1：no anchor recorded for "ptc"
node scripts/sync-preset-codex.mjs --base ptc --update-anchor  # 写入 sources.ptc，保留 sources.standard
node scripts/sync-preset-codex.mjs --base ptc --check          # 预期 exit 0
node scripts/sync-preset-codex.mjs --check                     # standard 仍 exit 0
node -e "const a=require('./scripts/preset-anchors.json');console.log(Object.keys(a.sources), a.baseline)"

# 5) 反向证明（每条都必须按预期退出码失败）
node scripts/sync-preset-codex.mjs --selftest                  # 现有 8 条
# …参数化后新增 §6 的 9–17 条，由 selftest 统一跑
```

**[未验证]** 上面 3) 的"用 dsh 解析生成的 patch"这条链路我**没有跑过**（需要先生成 ptc 产物）；
它是本次调查里**唯一**需要在实现阶段补做的验证，也是最有说服力的那一条。

## 9. 证据索引

| 结论 | 来源 |
|---|---|
| 六条 rewrite 规则与"计数必须为 1" | `scripts/sync-preset-codex.mjs` L162-186 |
| 头部 7 行与文件尾 `\n\n` | 同上 L188-197 + `tail -c 4 /tmp/before.yml \| od -c` |
| 默认值（base/plugin/out/anchors/baseline） | 同上 L250-257 |
| 源解析顺序与 Windows 名字 | 同上 L74-146 |
| anchor 读写与 baseline 语义 | 同上 L200-247 |
| `--check` 早于 transform 返回 | 同上 L269-272 |
| selftest 8 条与写死的产物断言 | 同上 L309-345 |
| 退出码 0/1/2 与 CI 映射 | 同上 L30-33；`scripts/preset-drift-check.sh`；`ci.yml:135,142`、`compat.yml:88` |
| 四个 base 的 `compaction-basic`/`order:`/`isolate:` 计数 | 本机 `grep -c` 四个 `presets/*.patch.yml` |
| 单引号 YAML 策略 round-trip | 本机用 dsh 自带 `yaml` 包解析 5 组对抗取值的实测输出 |
| golden 输出 sha256/行数/尾部字节 | 本机 `--out /tmp/before.yml` + `sha256sum` + `wc -l` + `od -c` |
| 上游 ptc 结构与两版差异 | [codex-ptc-options.md](codex-ptc-options.md) §1 |
