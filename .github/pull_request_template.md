## 关联议题

Closes #

## 改了什么

<!-- 一段话说清，附关键文件 -->

## 写入范围

<!-- 本 PR 触碰的目录/文件，例如 lib/index.js, test/plugin-contract.test.mjs -->

## 第一性原则审查

<!-- docs/PLAN.md §4.5：本改动对应 §1.3 的哪一维（D1-D5）、触发了哪条不变量（C1-C5）？
     纯基建/文档改动写"不对应 D1-D5：无策略改动"即可。 -->

## 验证

<!-- 命令 + 关键输出（CI 之外的本地验证） -->

```sh
node --test "test/**/*.test.mjs"
DSH_HOME="${TMPDIR:-/tmp}/dsh-home" node scripts/assert-isolated-home.mjs
npm pack --dry-run
```

## 平台影响

- [ ] Linux
- [ ] Windows
- [ ] macOS
- [ ] 只影响文档/CI

## 回滚

<!-- 出问题怎么退回去 -->

## 清单

- [ ] 关联了议题
- [ ] 本地跑过 `node --test "test/**/*.test.mjs"`
- [ ] 新增/修改的逻辑有测试覆盖
- [ ] 没有把 `@deepseek-ai/*` 放进 `dependencies`（peer + dev 成对）
- [ ] 没有触碰真实 `~/.dsh`（测试只用临时 DSH_HOME）
- [ ] PR diff <= 1000 行（docs/PLAN.md §4.2）
- [ ] 文档与代码同一次改动内更新
