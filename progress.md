# 语音链路延迟优化 - 进度记录

## 步骤 1：代码路径确认（已完成）

- 确认声纹为宿主原生 `sherpa-onnx-node`（`src/voiceprint.ts` 的 `SpeakerEmbeddingExtractor`），不是浏览器 WASM。
- 确认连续模式 `src/client.tsx` 的 `enqueueContinuous` 把每个分段的声纹识别放在 `classifyRef` 串行链里，且 ASR 在 `await identifySpeaker(...)` 之后才启动；ASR 被声纹串行阻塞。
- 确认分离为宿主 `onnxruntime-node` 原生 MossFormer2，经 `child_process.fork` 子进程推理（`src/separation.ts` / `src/separation-worker.ts`）；连续窗口默认 4000 ms、步进 1000 ms。
- 确认连续分离器源码已有每源 VAD，但默认每源尾静音 1600 ms；并且 `drainReady()` 会让后开始的源等待更早开始的活跃源结束，仍可能表现为全局等待。
- 未修改任何 `src`/`test` 文件；下一段先做至少 3 次基线测量。


## 声纹误判修复 - 步骤 1：根因确认（已完成）

- 实读 `src/voiceprint.ts` 确认：`OWNER_SOFT_FLOOR=0.4`、`OWNER_SOFT_FLOOR_AFTER_OWNER=0.35`、`OWNER_HISTORY_FLOOR=0.45` 均低于 `DEFAULT_THRESHOLD=0.52`，低于阈值的主人分数仍会经软分支返回 `owner:true`。
- `priorOwnerException` 在上一轮标签为“我”且主人相似度 `>=0.45` 时，即使客人簇相似度明显更高（只要不是命名客人更强）也会覆盖为“我”。
- 高于阈值的主人分支只检查命名客人是否更强，未检查匿名客人簇；因此主人刚过阈值而客人簇分数更高时仍可能判主人。
- 结论：误判来自“低于默认阈值的软下限 + 历史标签例外 + 主人分支忽略客人簇最高分”，不是单一常量问题。
