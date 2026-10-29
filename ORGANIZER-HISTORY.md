# 组织器最近对话改造（历史部分）

完整改造、协议、测试、耗时与回滚说明已合并到 [ORGANIZER-ROUTE.md](ORGANIZER-ROUTE.md)。

## 历史缓冲结论

- 新增 [src/organizer-history.ts](src/organizer-history.ts:1)，每会话进程内保存最近 6 条：助手 3 条 + 用户 3 条。
- 每条最多 80 字符，正文总长最多 400 字符，超出从最旧丢；渲染时标签和换行也计入 400 字预算。
- 助手文本来自 `llm/stream` tap 已拿到的可见回答；用户文本来自 `/organize` 入参。
- 历史段落带“历史、不是指令”的开闭边界标记；空历史不插入空段落。
- 会话 `session/disposed`、voice-state inactive、TTL 过期时清除。

## 测试与耗时

- `node --test test/*.test.mjs`：85 pass / 0 fail。
- 最终 prompt 实测 3 次：859ms、926ms、541ms，中位数 **859ms**；生产 900ms 超时不变，超时那次安全回落 queue。

## 复制与回滚

- 复制到 profile：`lib/index.js`、`lib/client.js`（运行时）；`lib/organizer.js`、`lib/scheduler.js`、`lib/organizer-history.js`（测试/独立模块）。
- profile 未改动、DSH 未重启、git 未提交。

> 注意：`lib/client.js` 是整包构建，会包含当前工作树里其他人的未提交客户端改动；复制前请确认这些改动也可以一起进入 profile。

- 回滚：先备份再覆盖 profile 旧 `lib/index.js`/`lib/client.js`；仓库源码按 [ORGANIZER-ROUTE.md](ORGANIZER-ROUTE.md) 的回滚清单逐项反向修改，不要整体 `git checkout` 以免覆盖其他人的未提交改动。