# 语音识别链路延迟治理（识别延迟）

## 结论

这一轮把「说完到进入队列」的串行等待拆掉了三段：尾静音从 1600 ms 降到 900 ms（用户可调 400–4000），分离推理在尾静音期间提前预热并在句末复用，空闲时先入队再并行跑组织器。空闲且单说话人的最好路径从约 3.0 s 降到约 1.0 s；播放中/有排队时按原串行路径回退，不丢话、不乱序。

实测（本机，2026-10-28，三条链路各自独立测量）：

| 测点 | 中位数 | 方式 |
| --- | ---: | --- |
| 分离推理（每窗一次，DML） | 695.6 ms | `node test/latency-benchmark.mjs --label after-clean` 3 轮 |
| 句末→分段回调（单源，含分离等待） | 700.9 ms | 同上，真实 ContinuousSeparation + 延迟等于实测值的桩 |
| ASR（SenseVoice，含传输） | 137.5 ms | 同上（inference 126.5 + transport 12.4） |
| 声纹（CAM++） | 36.6 ms | 同上 |
| 组织器 /organize（线上已部署版本） | 611 ms | 对 `http://127.0.0.1:3080/dsh-voice-dialog-api/organize` 真实 POST 3 次：611 / 708 / 496 |

> 说明：GPU-REPORT.md 记录过 DML 374 ms，本次同机干净复测为 695.6 ms（线程/提供者配置与负载不同）。报告以本次可复现脚本的数字为准。

## 每句八段埋点

新增 [src/latency.ts](src/latency.ts:1)，固定八段：`utterance_end`、`separation_done`、`asr_done`、`organize_start`、`organize_done`、`enqueue`、`first_token`、`play_start`。

- 相对 `utterance_end` 的毫秒数；缺失段显式为 `null`，不编造。
- 并发段各保留自己的时间戳：乐观入队会让 `enqueue` 早于 `organize_done`，此时不强行拉平、不置 `clamped`。
- 只有早于 `utterance_end` 的标记夹到 0，并记 `clamped: true`。
- 宿主新增 `POST /latency`（[src/index.ts](src/index.ts:661)）：16 KB 上限，只保留白名单字段，`preview` ≤ 20 字，**不含音频**，追加 JSONL 到 `%TEMP%\dsh-voice-latency.jsonl`（本机 `C:\Users\chesand\AppData\Local\Temp\dsh-voice-latency.jsonl`）。
- `llm/stream` 首个文本增量另记 `{"kind":"first_token"}`，带 `sinceEnqueueMs`。

现场样本行（当前由最终构建的模块生成，链路部署后才会出现真实语音行）：

```json
{"kind":"utterance","sessionId":"session-68c86ef1-7a17-4277-b1f1-20b5e1e67214","at":"2026-10-28T12:59:47.575Z","id":"cont-12-0","lane":"owner","preview":"把刚才那个报错再解释一遍","organizerAction":"queue","prewarm":"miss","textLength":12,"totalMs":2380,"fastPath":true,"retracted":false,"stagesMs":{"utterance_end":0,"separation_done":374,"asr_done":890,"organize_start":891,"organize_done":1502,"enqueue":892,"first_token":1710,"play_start":2380}}
```

## 改了什么

### 1. 尾静音提前 + 预分离（[src/mic.ts](src/mic.ts)、[src/continuous-separation.ts](src/continuous-separation.ts)）

- 连续模式在静音达到 250 ms 时回调一次 `onSpeechTail`，客户端立即调用 `separator.prewarm()`，比 `pauseMs` 提前启动那一窗分离。
- 预热的窗口按 hop 对齐：`windowStart = previous.start + hop`，`available = min(windowSamples, received - windowStart)`，和句末 flush 用同一套计算，才能命中。
- 复用条件（全部相等才复用）：`windowStart`、`available`、`received`、`lastActivity`。命中后 `reused += 1`，该 job 立即清空，最多复用一次。
- 失效条件：尾静音之后又出现超过噪声门限的语音，`token` 自增、`discarded += 1`，在途结果永远不会被复用；句末照常重算一窗。
- 同一时刻只允许一次在途推理；`prewarm()` 被尾静音重复触发时是 no-op。
- 统计由 `prewarmReport()` 暴露：`{started, reused, discarded, missed, hitRate}`，部署后可直接读真实命中率。
- 尾静音默认值从 1600 ms 收到 900 ms（`prefs.pauseMs`，范围 400–4000，设置页可选预设/自定义），同时驱动 VAD 与分离侧。

### 2. 单说话人复用投机 ASR（[src/routing.ts](src/routing.ts)、[src/client.tsx](src/client.tsx)）

句末同时提交混合尾流的投机 ASR。分段带 `siblingActive === false`（另一声道没有真正重叠）时，若混合尾流不超过 8 s、样本长度差 ≤ 1600 采样（100 ms），直接复用该结果，不再对分离后的音轨二次识别。两个说话人重叠时一律走两路 ASR，不做这个优化。

### 3. 空闲乐观入队（[src/routing.ts](src/routing.ts)、[src/client.tsx](src/client.tsx)）

- 触发条件：`!playing && queued === 0 && scheduler.status().active === 0`。满足时立刻交给模型，`/organize` 并行发起，不再同步等待。
- 组织器返回后裁决：`drop`/`ignore` 且该条目**尚未开始播放**（`entry.started() === false`）→ 撤回；`interrupt` → 走既有打断（`cut` + `steer`）；其余一律保留。
- 非空闲、或任何异常/超时，回退到原来的串行路径（先 `/organize` 再入队），绝不因为省延迟丢话。
- 保守点：空闲时调度器通常在组织器回答前就已开始播放，所以撤回实际几乎不触发——这是有意的「宁可多说一句，不吞话」。收益完全在延迟：组织器的 611 ms 不再挡在入队前面。

### 4. 空闲时的紧凑组织器（[src/organizer-compact.ts](src/organizer-compact.ts)）

空闲、无排队、无待播句时改用极简提示词（只要 `{"action":"queue|drop","reason":"≤10字"}`），`maxTokens: 48`，不带历史与待播列表；播放中/有排队仍走原带历史提示词与 `maxTokens: 120`、900 ms 上限。只把纯噪声（嗯/啊/The/Yeah 这类）判为 `drop`，不确定就 `queue`。

### 5. 幂等（[src/continuous-separation.ts](src/continuous-separation.ts)、[src/client.tsx](src/client.tsx)）

每个分离分段带 `utteranceId = cont-<序号>-<声道>`，客户端 `deliveredIdsRef` 去重（`firstDelivery`），重复投递直接忽略；单说话人复用路径不会因此重复入队或改变顺序。

## 改前 / 改后

以主人单说话人、开启分离、空闲且无排队为例（每格为实测中位数）：

| 阶段 | 改前 | 改后·最好路径 | 改后·回退路径 |
| --- | ---: | ---: | ---: |
| 尾静音判定 | 1600 ms | 900 ms | 900 ms |
| 分离推理 | 695.6 ms | 0 ms（命中预热） | 695.6 ms（未命中/被新语音污染） |
| 声纹（与 ASR 并行） | 36.6 ms | 36.6 ms | 36.6 ms |
| ASR | 137.5 ms | 137.5 ms（或复用投机结果） | 137.5 ms |
| 组织器（入队前） | 611 ms 同步 | 0 ms（并行，不挡入队） | 611 ms |
| 句末→入队 | ≈ 3.0 s | ≈ 1.04 s | ≈ 2.34 s |

### 回退路径清单

| 场景 | 行为 |
| --- | --- |
| 正在播放 / 有排队 / 有非空调度 | 走原串行 `/organize`，超时或解析失败按 `queue` 保留 |
| 尾静音后又说话 | 预热作废，句末重算，不重复推理 |
| 两声道重叠 | 不做单说话人复用，两路 ASR |
| 组织器超时 / 无模型目标 / 异常 | 保留这句话，按到达顺序入队 |
| 插话打断 | 走既有 `cut` + `steer`，不改优先级语义 |

## 测试

`node build.mjs` 通过；`node --test "test/*.test.mjs"` = **139 pass / 0 fail**（约 8.8 s）。本轮新增覆盖：

- [test/latency.test.mjs](test/latency.test.mjs:1)：八段相对时间、缺失段为 null、首次标记生效、preview 20 字、并发段不被拉平、入队早于组织器完成、早于句末的标记夹零并置 `clamped`、宿主净化器丢未知字段/拒绝无 kind。
- [test/routing.test.mjs](test/routing.test.mjs:1)：只有全空闲才走乐观路径、撤回仅限未开始播放、单源判定保守、投机 ASR 容差、幂等首次投递。
- [test/prewarm.test.mjs](test/prewarm.test.mjs:1)：预热命中只推理一次、新语音使预热作废且句末重算、双声道重叠标 sibling、无声活动声道时预热是 no-op。

## 未验证 / 下一步

- 本轮**没有部署**：`lib\*` 未复制到 profile，DSH 未重启。上面的现场样本行由最终模块生成，部署后才会出现真实语音行。
- 紧凑组织器只做了组件级改动，未在生产链路上实测延迟（线上仍是旧提示词，611 ms 即它的实测值）。
- 预热真实命中率依赖用户停顿分布，需部署后读 `prewarmReport()` 与 JSONL 统计；单测里命中/失效各 1 次，不代表线上比例。
- 端到端「说完→首字」需要部署后按 `%TEMP%\dsh-voice-latency.jsonl` 的 `stagesMs` 汇总，本轮未做。
- 撤回路径预期几乎不触发（调度器会在组织器之前开始播放），这是设计选择，不是缺陷。

## 回滚

源码：撤销 [src/latency.ts](src/latency.ts)、[src/routing.ts](src/routing.ts)、[src/organizer-compact.ts](src/organizer-compact.ts) 及 [src/mic.ts](src/mic.ts)、[src/continuous-separation.ts](src/continuous-separation.ts)、[src/client.tsx](src/client.tsx)、[src/index.ts](src/index.ts)、[src/scheduler.ts](src/scheduler.ts) 中对应改动，删掉三个新测试与 `build.mjs` 的三段构建，重新 `node build.mjs` 即可。已部署副本请先备份 profile 下 `lib\index.js`、`lib\client.js` 与新增的 `lib\latency.js`、`lib\routing.js`、`lib\organizer-compact.js`，回滚时覆盖回去。
