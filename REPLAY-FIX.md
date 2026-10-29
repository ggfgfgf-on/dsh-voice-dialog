# 语音链路修复报告：重复朗读 + 组织层职责重划

日期：2026-10-28　构建：`node build.mjs` 退出码 0　测试：`node --test test/*.test.mjs` → 164 pass / 0 fail

## 一、结论先说

1. 重复朗读的根因在**客户端没有任何单调帧序**：服务端发的 `seq` 每会话严格递增、`replyId` 每轮唯一（`src/index.ts:1084-1092`、`src/tts-queue.ts:339-347`），但客户端从不读 `seq`，任何一次重投/延迟帧都照播。
2. 第二根因是**打断后的 afterCut 回灌**：`cut()` 把淡出 260ms 内到达的旧轮帧暂存，淡出结束后原样重新入队（`src/client.tsx:715` 与 `cut()` 内回灌段），旧回答的下一句会在新回答前被念出来。
3. 第三根因是**“重复一遍”只认 lastFrames**：`repeatLast()` 直接重播上一轮缓存的帧（`src/client.tsx:617`），旧帧没有与当前轮次做任何比较；`halt()` 也不清该缓存（这是有意的，但必须由轮次水位兜底）。
4. 组织层职责按你的纠正重划：慢判层只做**输出编排**（reorder / dropSentences，禁止新增内容），快判层只做**正在播时要不要立刻停**，没在播不调用（`src/routing.ts:32-35`）。

## 二、五个假设的排查结果（代码行号为当前树）

| 假设 | 结论 | 证据 |
| --- | --- | --- |
| H1 客户端重投不丢帧 | 成立（主因） | 改前 `enqueue` 只按 `replyId` 清队列（现 `src/client.tsx:680-720`），全文件无 `seq` 读取；SSE 只按 `frame.sessionId` 过滤（`src/client.tsx` 的 `useAutoRead` audio 监听段） |
| H2 打断后旧句回灌 | 成立 | `cut()` 把淡出窗口内的帧塞进 `afterCut`，淡出结束逐个 `enqueue`（`src/client.tsx:715` 起） |
| H3 重复指令重播旧轮 | 成立（需水位兜底） | `repeatLast()` 用 `lastFrames` 重播（`src/client.tsx:617`），旧帧与新轮无比较 |
| H4 双标签页同时播 | 成立（已有部分防御） | 仅 `sessionId` 相等 + `active` 判断；两个标签都开麦时会双播（`src/client.tsx:649` 的 `shouldPlayFrame` 之前只有粗略判断） |
| H5 服务端序号本身重复 | 不成立 | `seq: q.seq++` 每会话单调、每轮 `replyId` 唯一（`src/index.ts:1084`、`src/tts-queue.ts:339-347`）；问题全在客户端消费侧 |

## 三、修复内容

### 1. 帧序水位（`src/frame-order.ts`，新增）

- `FrameWindow`：按 `(epoch, seq)` 单调水位判定 `accept` / `stale-epoch` / `stale-seq` / `duplicate`；水位只升不降。
- 宿主每轮回答 `epoch = replySequence++` 写进每帧（`src/index.ts:1084` → `queue.enqueue(..., round)` → `src/tts-queue.ts:347`）。
- 客户端 `enqueue()` 先 `classify` 后 `accept`，`speakFallback()` 同一套判定（`src/client.tsx:661`、`:697`）。
- 重置点只有三种：换会话（`beginSession`，`src/client.tsx:427`）、显式 `reset()`、页面重载（水位本就在内存）。**stop / cut / clear 一律不回退水位**，所以“停了以后旧句复活”不可能发生。

### 2. 遥测（JSONL）

- 每帧 `received` / `dropped`（带 `reason=stale-epoch|stale-seq|duplicate|inactive`）/ `played`（`src/client.tsx:726` 的 `reportFrame`）。
- 落盘到 `%TEMP%\dsh-voice-latency.jsonl`，记录 `kind=frame`、`sessionId`、`replyId`、`epoch`、`seq`、`phase`、`reason`；宿主白名单已放行这些字段（`src/latency.ts:72-80`）。
- 命令行自检：`Get-Content $env:TEMP\dsh-voice-latency.jsonl | Select-String '"phase":"dropped"' | Measure-Object`。

### 3. 组织层职责重划

| 层 | 唯一职责 | 输入 | 输出 | 预算 | 调用条件 |
| --- | --- | --- | --- | --- | --- |
| 快判 `/organize` | 正在播时要不要立刻停 | 新话 + 是否在播 | `interrupt` / `queue` | 提示 219 字（system 184 + user 35），maxTokens 24，超时 400ms | `shouldCallGate` 只认 `playing === true`（`src/routing.ts:32-35`；客户端 `src/client.tsx:1249`） |
| 慢判 `/plan` | 输出编排：先说什么、删哪句、哪些合并 | 待播句子 + 新话 + 历史 | `reorder` / `dropSentences` / `queuePlan` | 提示最坏 1522 字（上限 1600），maxTokens 200，超时 900ms | 每轮输入后异步调用，从不挡回复 |

- 慢判系统提示词已改成编排口径：只允许调顺序和删整句，明确禁止新增内容、改写文字、编造数字，禁止动正在播/已播的句子（`src/planner.ts` 的 `PLANNER_SYSTEM_PROMPT`，380 字）。
- 规则兜底（纯函数，`src/arrange.ts`）：识别“先说结论 / 别讲背景”这类指令，把结论句提前、只删背景句，其余句子一句不丢；模型超时/空输出/无效输出时宿主直接用这条规则（`src/index.ts` 的 `ruleDecision`，超时与 catch 分支同样返回）。
- 索引校验：`sanitizeArrangement` 只接受快照范围内的编号，去重、去越界、补齐未点名句子，天然无法引入新内容；`applyReorganization` 仍保留“不删第 0 句”的约束。

## 四、有用率：两层分开算

定义（严格按你的口径）：

- **输出编排层**：`reorder` 或 `dropSentences` 实际产生顺序/删除变化的次数 ÷ 调用次数。
- **打断层**：`action=interrupt` 实际触发 stop 的次数 ÷ 调用次数。

日志已加 `layer=` / `changed=` / `playing=` 字段，并提供统计脚本：

```powershell
node tools/organizer-stats.mjs            # 默认读 $env:TEMP\dsh-voice-organizer.log
node tools/organizer-stats.mjs <日志路径>  # 指定别的日志
```

阈值建议（脚本内置）：编排层 < 20% → 只保留纯规则兜底、关掉模型 plan；打断层 < 15% → 关掉快判，只保留确定性的“别说了/停”命令。

### 当前可测数据（诚实标注）

- 现有 `dsh-voice-organizer.log` 33 行全部是**旧格式**（没有 `layer/changed/playing`，时间戳 12:58–13:03），无法拆层统计；脚本对这些行输出 `calls: 0`。
- 旧口径（混在一起统计）30 条决策：queue 23（76.7%）、interrupt 2（6.7%）、drop 5（16.7%），旧“有用率”合计算 23.3%。
- 新口径要等宿主重启加载本构建后产生样本；重启后执行上面的脚本即可得到两层各自的比率，报告里不再猜测。

## 五、测试（新增/更新）

| 文件 | 覆盖 | 用例数 |
| --- | --- | --- |
| `test/frame-order.test.mjs` | 旧轮迟到帧丢弃、新轮不误丢、reorder 重投不双播、stop 后不复活、双标签只播一个、无序号旧帧兼容 | 6 |
| `test/arrange.test.mjs` | 5 句 + “先说结论/别讲背景”：结论提前、只删背景、其余一句不丢、不新增内容、第 0 句不可删、索引净化 | 5 |
| `test/organizer-stats.test.mjs` | 两层分母/分子分开算、空日志不除零 | 2 |
| `test/routing.test.mjs` | 没在播时快判一次都不调用（含 imperative 入参） | +1 |

全量：**164 pass / 0 fail**（`node --test test/*.test.mjs`）。

## 六、部署与回滚

- 部署：`lib\*.js` 复制到 `D:\deepseek-harness-dsh-v0.2.1rc2\.dsh-home\profiles\web\local-packages\dsh-voice-dialog-0.8.1\lib`，宿主改动需重启一次；客户端 bundle 需刷新页面。
- 回滚：`git checkout -- src/ test/ build.mjs` 后重新 `node build.mjs`（本次未提交 git，改动都在工作树）。
- 本任务按要求**没有**执行 `dsh_restart`、没有改 profile。

## 七、未验证 / 待实测

- 双标签页真实双播只做了纯函数级验证（`shouldPlayFrame`），没有开两个浏览器实例实测。
- “重复一遍”在真实音频链路上的行为未实测；水位只保证旧帧不会被误当新帧播放，显式 repeat 仍按设计重播上一轮。
- 两层有用率尚无重启后的新样本，只有旧格式历史数据；阈值建议需用新样本复核。
- 编排层真实音频效果（结论句提前听感）未做人工听测。