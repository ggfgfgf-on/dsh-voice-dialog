# 语音对话插件审计（主线自证版）

> 这份报告由主线根据已验证证据整理。原子代理在收尾前被停止，未留下报告，故本文件不引用其内容。
> 行号以当前工作树为准；标「已装」的改动已复制到 profile，标「待重启」的需重启 DSH 才生效。

## 结论摘要

- 开麦变小：插件侧**存在**一条可影响音量的路径（说话时 duck 到 18%），但用户明确说不相关；真正原因仍未定位。见 P0-3。
- 识别延迟：声纹只要 ~50ms，分离推理 ~774ms，**主要等待是每源 1.6s 尾静音 + 最多 1s 窗步进**。已做两刀（ASR 并行、说完即 flush），尾静音未动。
- 队列：组织层现在能看到队列原文（已装），FIFO 头不再被 hold（已装）。
- 组织层：实测三次全部 `invalid-model-output`，模型输出解析失败，等于一直空转还白等 1 秒。已移出关键路径（已装）。

## P0

### P0-1 组织层模型输出全部解析失败
- 现象：`/organize` 连续三次返回 `invalid-model-output`，每次 1.0–1.2s。
- 根因：模型返回不符合 `parseOrganizerResponse` 的 JSON 约定（可能带推理段落），解析器兜不住。
- 证据：`src/index.ts` organizerHandler；`src/organizer.ts` parseOrganizerResponse。
- 现状：客户端已改为「打断不依赖模型」，模型只保留 veto（ignore），所以空转不再拖慢播放；但打断/排队语义仍名存实亡。
- 建议：抓一次原始输出落日志，按实际格式修 parser；再给 3 条固定样本做单测。

### P0-2 可见正文出现控制标记
- 现象：助手的可见回答里出现方括号语音标记。
- 根因：标记写在 text 里，segmenter 只从朗读里剥掉，显示那一份原样放行。
- 现状：已在 tap 里做流式剥离（含半截标记缓冲），**待重启**。
- 证据：`src/index.ts` tapStream 内 stripVisible / partialMarkerAt。
- 建议：补一条单测，覆盖「标记跨两个 chunk」「标记在句中断开」两种切分。

### P0-3 开麦后播放变小（原因未定位）
- 已确认可疑路径：`preferences.ts` duckLevel 默认 0.18；`client.tsx` onSpeechStart -> sharedPlayer.duck()，onSpeechEnd 才 restore；continuous 模式 restore 依赖 VAD 结束事件。
- 但用户判断与此无关，故不能当作结论。
- 待办：加一次性测量（不改音量）：播放固定音频，开麦前后各采样输出 RMS；RMS 不变而耳朵变小即系统侧，反之插件侧。
- 风险：无测量就改音量相关代码，属于盲改。

## P1

### P1-1 每源 1.6s 尾静音 + 1s 窗步进
- 证据：`continuous-separation.ts` silenceMs 默认 1600；窗 4000、步进 1000。
- 现状：已做「说完即 flush」（client.tsx onSpeechEnd），省掉最多 1s 步进等待；尾静音未改（这是用户明确要的每源端点语义，需用户拍板降到多少）。
- 建议：先降到 900ms 试，听感与误切权衡。

### P1-2 ASR 被声纹串行阻塞
- 证据：`client.tsx` enqueueContinuous 原先把 ASR 放在 classifyRef 链内、identifySpeaker 之后。
- 现状：已改为分段一结束就启动 ASR，标签后合并（已装）。

### P1-3 cut 的版本语义容易被误用
- 现象：`sharedPlayer.cut(expectedVersion, isCurrent)` 需要恒真回调才能无条件打断；传 organizer.isCurrent 时会被版本号卡成 false。
- 现状：主路径已用 `cut(0, () => true)`；另一处调用仍依赖 organizer.isCurrent(plan)。
- 建议：拆成两个方法：`cutNow()` 与 `cutIfCurrent(plan)`，从 API 上消除误用。

### P1-4 scheduler.drop 不释放 hold
- 证据：`scheduler.ts` drop() 只移除条目，hold 仍挂起。
- 现状：主路径已不传 hold，问题暂时不影响；但 hold 能力仍在，未来复用会踩。
- 建议：drop 时 resolve hold，或删除 hold 特性。

### P1-5 TtsQueue.cancel 无调用方
- 证据：`tts-queue.ts` cancel 存在，宿主路由未接。
- 影响：客户端 cut 只清浏览器队列，宿主仍在合成旧句，稍后回放。
- 建议：cut 走一条 host 路由取消该 replyId 的剩余合成。

### P1-6 连续分离 flush 早退
- 证据：`continuous-separation.ts` flush() 在 processing 时直接返回。
- 现状：已从 client 侧在说话结束时调用 flush；flush 本身的早退逻辑未改。
- 建议：flush 改为 await 当前 processing 后继续。

## P2

- 未知来源默认判主人（client.tsx enqueueSeparated / 连续路径），宁可为 unknown。
- 组织层只对 owner lane 生效，客人插话无组织。
- snapshot 只取 8 条，超出部分模型看不到。
- 组织层 5s 安全计时从入队开始，而不是从 ASR 完成开始。

## 未验证

- 开麦变小是系统侧还是插件侧：无测量，未下结论。
- 组织层修好 parser 后的决策质量：未测。
- 改后「说完到出声」的端到端中位数：未测（只有改前 996–1241ms 的间接数据）。

## 测试缺口

- 组织层解析：无任何用真实模型输出样本的单测。
- 标记剥离：无跨 chunk 切分用例。
- 队列 snapshot：无「播放中 + 多条等待」的快照用例。
- 声纹：无「客人分数高于主人」的回归用例（本次已撤回该规则改动）。
