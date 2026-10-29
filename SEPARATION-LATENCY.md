# SEPARATION-LATENCY：把「说完 → 进队列」从 2.3 s 降到约 1.0 s

## 结论先说

- **真实最新 3 条**（`%TEMP%\dsh-voice-latency.jsonl`）：`separationWaitMs` = 1310 / 1547 / 1375 ms，`totalMs` = 2298 / 2527 / 2338 ms。
- 根因不是模型慢，而是 **预热窗口没有被复用，句末又跑了一遍模型**；同时 ASR 其实早已完成，却被分离结果挡在 enqueue 后面。
- 改后默认走 **单人快路径**：不跑 MossFormer2，直接送原始混音 ASR；只有声纹自相似度/owner 相似度不够时才跑一次分离。
- 本机 9 轮真实组件基准（SenseVoice + CAM++ + MossFormer2 DML）：
  - 句末判定后到可入队：**138 ms 中位**（改前 1375 ms）；
  - 含 900 ms 尾静音的 `totalMs`：**1038 ms 中位**；
  - 3.3 s 短句：990 ms；5.5 s：1038 ms；11.2 s 长句：1153 ms（长句由 ASR 本身主导）。
- `node --test test/*.test.mjs`：**202 pass / 0 fail**。

> 注意口径：900 ms 的 endpoint 等待是用户明确说“正常”的固定成本。**端点判定之后**的等待已从 1.3-1.6 s 降到约 0.14 s；如果把 900 ms 也算进去，绝对下限就是 900 ms + ASR。短句能进 1 s，长句会超过 1 s。

## 1. 先量化：1.3-1.5 s 到底花在哪

改前遥测（最近三条真实 utterance）：

| 项 | 三条 | 中位 |
|---|---:|---:|
| endpointWaitMs | 900 / 900 / 900 | 900 |
| separationWaitMs | 1310 / 1547 / 1375 | 1375 |
| asrQueueMs | 5 / 3 / — | 4 |
| asrInferMs | 69 / 53 / 81 | 69 |
| asrWallMs | 127 / 76 / 172 | 127 |
| totalMs | 2298 / 2527 / 2338 | 2338 |

补充观察：

- 有 2 条记录里 **ASR 比 separation 早完成 1190 / 1468 ms**，但 `enqueue` 仍等到 separation 回来（`asr_done=1085`，`enqueue=2338`）。
- 当前本机 MossFormer2 DML 单窗复测中位 **387.5 ms**；历史报告同机为 **695.6 ms**。`separationWaitMs ≈ 2 × 单窗`，正好对上“句末又跑一遍”。
- 代码层根因在 `ContinuousSeparation.resolveWindow()`：预热任务记录的是 250 ms 尾静音时的 `received` 和 `available`，但麦克风到 900 ms endpoint 之间还会继续送约 650 ms 静音。旧匹配条件要求 `job.received === this.received && job.available === available`，所以 **预热结果永远不命中**；flush 时重新发起一次分离，排在同一个 host 单 worker 链后面，形成 1.3-1.6 s。
- 旧遥测没有 worker queue 字段，不能直接证明“积压”；但 `separationWait ≈ 2 × 单窗`、且 ASR 已在等待期间完成，说明主因是**同一窗口被推理两次**，不是 hop 等窗口或 worker 排队。新字段 `separationQueueMs` 部署后可直接验证这一点。
- 首次冷启动也被 `void warmSeparation()` 放在后台：如果第一句来得快，ONNX session 创建会落在首句等待里。

新增遥测字段（本轮起生效）：
`separationMode`、`separationPrewarm`、`separationQueueMs`、`separationModelMs`、`separationWallMs`、`separationPrewarmWaitMs`、`separationWindowMs`、`separationModelCalls`、`separationGate`、`separationSelfSimilarity`、`separationOwnerSimilarity`。
`node tools/latency-summary.mjs` 会额外打印 separation composition 和 mode/prewarm/gate 分布。

## 2. 改了什么

### 2.1 单人快路径：默认不跑分离

新增 [src/separation-gate.ts](src/separation-gate.ts:1)：

1. 从整句混合音频里按 100 ms 能量帧去掉首尾静音；
2. 取**句首**和**句尾**两段各约 1.6 s 的语音；
3. 用现成 CAM++ 分别算 embedding，得到：
   - `minSimilarity`：两段是否像同一个人；
   - `ownerSimilarity`：两段与已登记 owner 模板的平均相似度（没登记 owner 时省略）。
4. 只有 **`minSimilarity >= 0.62` 且 owner 相似度 >= 0.5** 才返回 `singleSpeaker=true`；
   - 小于 0.48：疑似换人/重叠；
   - 0.48-0.62：不确定；
   - 音频太短、模型未就绪、超时：全部 **fallback**。

没有“两路 VAD”可用：当前是单声道麦克风，分离前拿不到两路独立 VAD。这里用等价可测的**声纹自相似度低 / owner 相似度低**作为疑似双人信号；比能量/双 VAD 更适合单麦，也不会把“同一个人说不同字”误判成两个人。

[src/voiceprint.ts](src/voiceprint.ts:349) 新增 `overlap()`，只算两段 embedding，**不更新 owner 模板、不建 guest cluster**；host 新增 `POST /voiceprint/overlap`（[src/index.ts](src/index.ts:719)），返回相似度和原因。

[src/client.tsx](src/client.tsx:1609) 的 `handleFastSegment()`：

- 端点一到，**同时**启动原始混音 ASR 和声纹 gate；
- gate 命中 `same-voice` 后才对整句做 identify（避免拿混合双人音频污染 owner/guest cluster），然后直接 enqueue 原始 ASR 文本；
- gate 不确定/疑似双人/报错/450 ms 超时：调用一次 `separateSegment()` 走原分离路径；
- 分离只返回一路、或分离失败：仍然用已经跑完的原始 ASR 兜底，不丢话；
- 分离回两路：进入原有 `enqueueSeparated()`，两路各自 ASR/声纹/路由。

门控默认值在 [src/preferences.ts](src/preferences.ts:38)：`separationFastPath: true`。**没有改客户端 UI**，开关只存在于 localStorage。

### 2.2 麦克风连续模式补齐整句音频

[src/mic.ts](src/mic.ts:310) 的 continuous 分支现在会在 speech 期间累积完整音频，并在 endpoint 时像非连续模式一样调用 `onSegment(samples)`。快路径需要整句，而不是旧代码只给分离器的 3 s `mixedTail`；长句也不会只送最后 3 s。

### 2.3 修复预热窗口复用

[src/continuous-separation.ts](src/continuous-separation.ts:587) 把匹配条件改成：

```text
windowStart 相同
且 lastActivity 相同
且 prewarm.available >= 到最后一个语音样本所需的长度
```

tail hint 之后新增的只有静音，零填充等价；不会再为 trailing silence 重跑一次模型。新语音仍会 `discarded++` 并让句末重新计算。预热统计也修正为只把“已有预热但没命中”算 miss，首个普通窗口不再污染命中率。

### 2.4 会话开始就建 ONNX session

[src/client.tsx](src/client.tsx:1853)：状态 ready 时 **await warmSeparation()**，再打开麦克风；失败则关掉 separation 并继续普通听写，不会卡死启动。

### 2.5 不阻塞 enqueue 的拆分

- 快路径：ASR 和 gate 并行，enqueue 只等两者中较慢的；不再等分离。
- 分离路径：host 端新增 `queueMs` / `workerMs` / `wallMs`，遥测能区分“排队等 worker”与“模型本身”。
- ASR 先完成时，`asrDone` 不会再把 `enqueue` 拖到 `separation_done`。

## 3. 前后数字

### 3.1 真实遥测（改前，最近三条）

| ID | endpoint | separation | asrWall | total |
|---|---:|---:|---:|---:|
| ...:6 | 900 | 1547 | 76 | 2527 |
| ...:7 | 900 | 1375 | 172 | 2338 |
| ...:8 | 900 | 1260 | 127 | 2290 |
| 用户给出的另一条 | 900 | 1310 | 81 | 2298 |

中位：separation **1375 ms**，total **2338 ms**。

### 3.2 改后本机基准（真实组件，9 轮）

命令：`node test/latency-benchmark.mjs --label separation-fastpath`

| 组件 | 中位 |
|---|---:|
| endpoint（固定） | 900 ms |
| CAM++ overlap gate | 24.3 ms |
| gate + identify 串行上界 | 62.2 ms |
| SenseVoice ASR wall | 138 ms |
| **端点后到可入队（max(gate+route, ASR)）** | **138 ms** |
| **含 endpoint 的 totalMs** | **1038 ms** |

分文件：

| 音频 | 时长 | 快路径 total（3 轮中位） |
|---|---:|---:|
| speech1.wav | 3.3 s | 990 ms |
| speech2.wav | 5.5 s | 1038 ms |
| speech3.wav | 11.2 s | 1153 ms |

9/9 个样本 gate 都判为 `same-voice`，没有把单人误送去分离。真实短句若 ASR 仍是改前遥测的 76 ms，则 total ≈ 900 + 76 = **976 ms**。

### 3.3 预热修复的实测

真实 DML 复测（3 s 窗）：

- `prewarmReport() = {started:1, reused:1, discarded:0, missed:0, hitRate:1.0}`
- 单窗模型 `modelMs=380 ms`，flush 只等 `311 ms` 就拿到结果；
- 回归测试断言：tail 之后继续送 250 ms 静音，模型调用仍为 **2 次而不是 3 次**（首个 hop 1 次 + 预热 1 次）。

## 4. 验证

```powershell
cd D:\DSHwork\dsh-voice-dialog
node build.mjs
node --test "test/*.test.mjs"
```

结果：

- build 通过；
- **202 pass / 0 fail**（2026-10-28，最近一次约 5.7 s）；
- 新增/更新覆盖：
  - `test/separation-gate.test.mjs`：窗口裁剪、短音频 fallback、同声/换声/owner 不匹配/不确定四类判定；
  - `test/prewarm.test.mjs`：tail 后继续来静音仍复用同一窗，不重复推理；新语音仍作废；
  - `test/latency.test.mjs`：快路径并发 ASR/gate 的 decomposed 不重复计数，新字段落盘。

部署（本轮已执行，未重启 DSH）：

```text
源：D:\DSHwork\dsh-voice-dialog\lib\*
目标：D:\deepseek-harness-dsh-v0.2.1rc2\.dsh-home\profiles\web\local-packages\dsh-voice-dialog-0.8.1\lib\
```

30 个文件已覆盖，包含新增 `separation-gate.js`。未调用 `dsh_restart`；是否重启/刷新由父会话按约束决定。

## 5. 回退方法

### 5.1 只关快路径（推荐先试这个）

在语音设置页的浏览器控制台执行一次，然后刷新：

```js
const k = 'dsh-voice-dialog.preferences'
const p = JSON.parse(localStorage.getItem(k) || '{}')
localStorage.setItem(k, JSON.stringify({ ...p, separationFastPath: false }))
location.reload()
```

效果：回到“连续分离 + 预热复用”的旧路径；预热 bug 已修，但单人句仍要跑分离。

### 5.2 完整回滚 lib

本轮覆盖前已备份到：

```text
D:\DSHwork\dsh-voice-dialog\.local-backups\profile-lib-2026-10-28T23-35-52-594Z
```

把该目录内容覆盖回 profile 的 `...\dsh-voice-dialog-0.8.1\lib\` 即可。源码回滚：

```powershell
git checkout -- src/client.tsx src/mic.ts src/preferences.ts src/continuous-separation.ts src/separation.ts src/voiceprint.ts src/latency.ts src/index.ts build.mjs
git clean -f src/separation-gate.ts test/separation-gate.test.mjs
node build.mjs
```

> 回滚前先确认这些文件里没有你要保留的其它未提交改动；当前工作树本来就有其它并行改动，建议用备份目录做二进制回滚，不要盲目 checkout 全部文件。

## 6. 还没验证 / 风险

- **没有在部署后的真实麦克风上复测**：本轮按约束没有重启 DSH，真实 JSONL 的 `separationMode=fast` 样本要等刷新/重启后才会出现。上面的“改后”是真实组件级基准，不是线上流量。
- **900 ms endpoint 固定成本**：端点后已经约 0.14 s；若要求“从最后一个语音样本算起绝对 <1 s”，需要把 `pauseMs` 从 900 降到约 800，或另做“边说边送”的投机 ASR，本轮没有改默认尾静音。
- **声纹 gate 的边界**：同音色两个人可能被判成 single；owner 相似度阈值 0.5 是保守兜底，不是数学保证。无法确定时一律回退分离，因此默认行为不会比旧路径更差（最差只是多一次 gate ~24 ms）。
- **fallback 双人路径**：先跑原始 ASR 再跑分离，会多一次“被丢弃”的 ASR 计算；换来的好处是分离失败/单源时仍能立即用原始结果，不丢话。
