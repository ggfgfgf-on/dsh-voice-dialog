# TRANSPORT-REPORT：音频传输 从 base64+JSON 改成 二进制

## 结论（先给数字）

同一条 4 秒 / 16 kHz 真实录音（`test/.latency/speech3.wav`，64000 采样），同一台机器、同一个 keep-alive 连接、真实本地 HTTP 服务器，3 轮取中位数：

| 项目 | 旧路径 base64+JSON+WAV | 新路径 二进制 PCM16 | 差额 |
|---|---:|---:|---:|
| 客户端编码（编码+序列化） | 2.34–2.58 ms | 0.20–0.22 ms | **−2.1 ms** |
| 传输往返（localhost） | 1.17–1.19 ms | 0.59–0.64 ms | −0.55 ms |
| 服务端解码 | 0.23–0.25 ms | 0.08–0.14 ms | **−0.15 ms** |
| 合计（编码+往返） | 3.52–3.77 ms | 0.81–0.87 ms | **−2.71 ~ −2.90 ms** |
| 请求体大小 | 170,746 B | 128,044 B | **−25.0%** |

两次独立运行的差值分别是 2.90 ms 和 2.71 ms。

**必须直说**：我之前口头估的"省一两百毫秒"是错的。base64+WAV 这一层在整条链路上只占约 **3 毫秒**，端到端"说完→入队"实测 1031 ms，所以这次改造只砍掉其中约 **0.3%**。真正的成本是分离推理（DML 中位 696 ms）、尾静音判定与 hop 等待。这次的价值是：请求体小 25%、少两次全量内存拷贝（移动网络下更明显）、并把传输耗时变成可观测字段；不是延迟的救命稻草。

## 协议

容器（小端）：

```text
container: "VDP1" | u8 version=1 | u8 flags | u16 reserved | u32 sampleRate | u32 totalSamples
frame:     u16 byteLength | byteLength 字节 PCM16 采样
```

- 帧长 300 ms（4800 采样），最后一帧可短。
- 坏帧处理：帧长为 0、奇数、或声明长度超出剩余字节 → 丢弃该帧、置 `truncated` 并停止（无法可靠重同步），不抛异常、不把噪声当音频。
- 校验：magic、version、采样率范围（8k–48k）三项，任一不符直接拒绝。

## 改了什么

- 新增 `src/audio-transport.ts`：`encodeAudioFrames` / `decodeAudioFrames` / `postAudioFrames`（共享上传 + 失败记忆）。
- `src/index.ts`：新增 `POST /dsh-voice-dialog-api/separation/separate-binary`（`application/octet-stream`，会话/阈值/是否做声纹走请求头），把原 handler 抽成 `completeSeparation()`，两种传输共用同一条推理与声纹流程；新增 `readBinary`、`headerValue`、`noteTransport`。
- `src/client.tsx`：`separateSegment()` 先走二进制，任一次失败（404/400/断线）后整页回忆退 JSON，绝不让这一句丢。
- `build.mjs`：新增 `lib/audio-transport.js` 测试构建项。
- 新增 `test/audio-transport.test.mjs`（8 项）、`test/transport-route.test.mjs`（4 项，真实本地服务器）、`test/transport-benchmark.mjs`（基准，结果落 `test/.latency/transport-results.json`）。

## 埋点

每次分离请求写一条到 `%TEMP%\dsh-voice-latency.jsonl`：

```json
{"kind":"transport","sessionId":"session-…","at":"…","transport":"binary","bytes":96044,"decodeMs":0.08,"droppedFrames":0}
```

部署后对比 `transport:"json"` 与 `transport:"binary"` 的 `bytes/decodeMs` 即可看真实收益。

## 回退

1. 客户端：`binaryTransport.broken` 一旦置真，本页后续全部走 JSON。实测：没有该路由的宿主只浪费 1 次请求，之后不再尝试。
2. 宿主：旧 `/separation/separate` 与 `completeSeparation` 都保留，行为不变；二进制路由出错只回 400，不影响旧路径。
3. 代码回退：`git checkout -- src/audio-transport.ts src/index.ts src/client.tsx build.mjs` 后 `node build.mjs`（注意工作树里还有别人未提交的改动，别整体 checkout）。

## 验证

- `node build.mjs` 退出码 0。
- `node --test test/*.test.mjs`：最终一次 **185 项全部通过（0 fail）**；我的两个新文件 12 项全过。
- 过程中 `test/backpressure.test.mjs` 有两次波动（"ten consecutive utterances…"、"flush reports truncation…"），是既有的墙钟时间断言，与本改动无关：`continuous-separation.ts` 只 import `separation-align.ts`，不 import 本模块；单独连跑两次分别 4/6、5/6 通过，最后一次全绿。**这组时序断言本身偏脆，需要单独加固，不是我这次引入的。**

## 未做 / 部署注意

- 没有重启 DSH、没有改 profile。二进制路由在运行中的宿主里还**不存在**，所以端到端没跑过真实语音；客户端会先试一次、失败后回退，行为与今天一致。
- 部署时：`Copy-Item lib\* <profile>\lib\ -Force`（务必带上 `lib/audio-transport.js`），然后重启 DSH、刷新页面。
- 响应方向仍是 base64 WAV（分离出的两路音频回传），本次只改了上行；回传解码实测 0.08–0.14 ms，收益更小，如仍要改需再动一次协议。
