# 识别段到底多慢：先量了模型，结论是"不是模型慢"

**一句话**：SenseVoice 推理只要 39–154 ms（RTF≈0.02），连 3 路并发都只有 197 ms；线上"识别段 1536 ms"里 **1400 ms 不在模型里**。埋点已经按你的要求改好（真实到达时刻 + asr_start/asr_done + asrTransport/asrInfer/endpointWait + 和≈total 校验），但 10 句真人体感数据必须等一次刷新+重启才能落到 JSONL。三条候选改法里 (b)(c) 的模型收益上限都不到 100 ms，不建议做。

## 一、先说结论表

| 候选改法 | 真实收益上限（实测外推） | 风险 | 建议 |
|---|---|---|---|
| a) 复用常驻识别会话/连接 | 冷启动 932 ms（只影响静默 >5 min 或出错重启后的第一句）；每句少 1 次 catalog RPC（已做） | 低 | 做"少杀 worker"，不做"新协议" |
| b) 边说边送/流式 | ≤ 154 ms（8.4 s 语音的整段推理时间） | 中高（改写 VAD/对齐/去重） | 不做 |
| c) 换更小/量化模型 | ≤ 100 ms（现在已是 int8，RTF 0.02） | 中（识别率下降） | 不做 |

## 二、模型本身：我直接拉起了线上同一个 worker 来测

用线上同一份模型（`.dsh-home/speech-to-text/sensevoice/models`）直接 spawn `packages/experimental/speech-to-text-sensevoice/lib/worker.js`，POST 真实中文语音 WAV（SAPI 合成，16 kHz/16 bit/mono），读服务端返回的 `inferenceSeconds`：

| 音频 | 请求总时长 | 其中模型推理 | 传输+HTTP | 文本长度 |
|---|---|---|---|---|
| 1.5 s | 46 ms | 39 ms | 7 ms | 11 字 |
| 3.0 s | 68–80 ms | 64–65 ms | 4–16 ms | 15 字 |
| 8.4 s | 164–179 ms | 154–171 ms | 10 ms | 35 字 |
| 3 × 并发（各 3 s） | 197 ms（全部完成） | 62/62/63 ms | 串行，单个 67/131/196 ms | — |

- **冷启动**（进程 spawn → 打印 ready，含模型加载，OS 文件缓存已热）：911 / 932 / 935 ms，三次。
- 推理是**串行**的（provider 用一条 `tail` 链），并发 3 路就是排队，单个服务时间仍只有 ~65 ms。
- 传输层没有坑：请求 3 s 音频总耗时 68 ms，其中模型 64 ms，链路上只有 4 ms。

推论：**线上 1536 ms 里约 1.4 s 与识别模型无关**，只可能来自（1）worker 冷启动/被 `stop()` 重启，(2) host 事件循环被别的活占住（分离模型就在 host 主进程里跑 ONNX），(3) 每句多次 RPC（catalog + 每 lane 一次 transcribe）等待。

## 三、埋点改了什么（这次的交付物）

1. `separation_done` 不再用 `closedAt`（那等于和 `utterance_end` 同一个时间戳，所以线上恒为 0），改用**分离结果真正到达客户端的时刻**（`src/client.tsx` 的 `enqueueContinuous`）。
2. 新增 `asr_start`（真正拿到识别槽位、开始发请求）与 `asr_done`（拿到文本），都是真实时刻。
3. `utterance_end` 仍是 VAD 判定时刻；trace 的基准点改成**最后一个语音采样点**（`speechEndAt`），所以 `endpointWaitMs`（尾静音等待）现在能算出来。
4. 每句新增字段：`endpointWaitMs`、`separationWaitMs`、`asrQueueMs`、`asrWallMs`、`asrTransportMs`（=asrWall−服务端推理）、`asrInferMs`（来自 `result.inferenceSeconds`）、`decomposedMs`、`residualMs`。
5. 校验：`tools/latency-summary.mjs` 直接输出每段中位数/均值/标准差，并打印"拆分与实测总时长差 ≤30 ms 的比例"和最大残差。

```bash
node tools/latency-summary.mjs            # 默认 %TEMP%\\dsh-voice-latency.jsonl
node tools/latency-summary.mjs <file> 200
```

测试：`node --test test/*.test.mjs` → **188 通过 0 失败**（新增两条：四等待相加等于入队时刻、无推理时长时只记墙钟）。

## 四、连接/会话复用：查了，也改了一处

- **worker 进程不是每句新建**：provider 自己缓存一个 worker，空闲 5 分钟才杀（`idleTimeoutMs` 默认 300 000）。**但任何一次识别异常都会 `stop()` 杀 worker**，下一句重新吃 932 ms 冷启动。
- **每句确实有重复请求**：`transcribeAudio` 原来**每条 lane 都先调一次 `catalog()`** 再 transcribe。已改为 15 秒缓存 + 失败即失效（`speechSelection()`），每句省 1–3 次 host RPC。
- worker 的 HTTP 连接由 undici 复用，实测链路开销 4–16 ms，不需要改。

## 五、10 句真人体感数据：还差一次部署

我这边不能刷新页面、也不能重启服务（约束），所以 10 句的真人分布还没落地。部署后（重启 host + 刷新客户端）说 10 句话，然后：

```bash
node tools/latency-summary.mjs
```

会直接给出：每段 n/中位数/均值/标准差、"四等待相加 ≈ 总时长"的校验比例。

**残差就是"识别之后到入队之间"的那一段**（声纹识别在 classifyRef 链上串行、调度器入场），不是噪声；残差大说明瓶颈根本不在识别，而在识别之后的处理链。三种典型读数：

| 读数 | 含义 | 下一步 |
|---|---|---|
| `asrTransportMs` 几十 ms，残差也小 | 识别段已经不慢，慢在别处 | 改看 `organize`/`play_start` |
| `asrTransportMs` 几百 ms | host 事件循环被占（分离模型同进程 ONNX） | 把分离推理挪出主进程 |
| `asrInferMs` 几百 ms | 模型真的慢（CPU 模式/争用） | 才轮到 (c) 换模型 |

## 六、没做/没验证

- 没有实现 (a)(b)(c) 任何一条改法，只给了数字。
- 没有改 `idleTimeoutMs`（在 DSH 的 provider 配置里，改它要动 profile，你禁止了）。
- 冷启动数字是 OS 文件缓存已热的情况；第一次开机后的首次加载会更高（未测）。
- `enqueue` 埋点本身仍是在 ASR promise resolve 之后打，和我新增的 `asr_done` 基本同刻；两者差值就是调度器的入场开销（通常 <5 ms）。
