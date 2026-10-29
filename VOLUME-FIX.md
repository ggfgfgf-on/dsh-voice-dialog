# 打断几次后朗读声音变小、回不来 —— 根因与修复

状态：已修，构建通过，`node --test test/*.test.mjs` 161 项全绿（本任务开始前基线 139）。
范围：只动 `src/client.tsx` 里 TtsPlayer 的音量/压低/切断路径，未触碰 enqueue / scheduler / planner / organizer。

## 1. 症状

主人说话时朗读被压低是对的；但连续打断几次之后，朗读音量明显变小，而且停口之后也回不来。
用户原话：「我说话的时候，然后压低声音，我多打断这几次，声音变得很小。」

## 2. 根因（修复前行号）

不是「乘性累积」。旧代码里 `target = volume * (ducked ? duckLevel : 1)` 只乘一次
（旧 client.tsx:701-705），`volumeOverride` 也只在显式音量命令时写一次（旧 :536-541）。
真正的三条是：

### 2.1 切断的「淡出到 0」会活过切断，之后一直停在 0（主因，可复现）

旧 cut() 直接排程自动化（旧 :496-504）：

```
gain.gain.cancelScheduledValues(t)
gain.gain.setValueAtTime(gain.gain.value, t)
gain.gain.linearRampToValueAtTime(0, t + 0.25)   // 结束时刻 t+0.25
```

切断的 260 ms 之后再 restore（旧 :522），但如果中途主人停口触发 `onSpeechEnd -> restore()`
（client.tsx 的 `onSpeechEnd: () => sharedPlayer.restore()`），restore 里的
`applyGain()` 用的是 `setTargetAtTime(target, t+0.1, 0.08)`（旧 :704），它在时间轴上是
**早于**那条 `t+0.25` 的线性斜坡。按 Web Audio 的时间轴语义，排程按事件时间排序：
最后一个事件是「斜坡到 0」，斜坡结束值就是参数之后一直保持的值 → **增益永久 0**。
同理，`halt()` / `clear()` 在淡出窗口内被调用（cutToken 自增、旧 cut 定时器早退不补偿）
也会留下同样的一年后的 0。

### 2.2 `setTargetAtTime` 永远到不了目标值（次因，说话时一直在低处）

旧 applyGain（旧 :701-705）用 `setTargetAtTime(target, now, 0.08)`：指数逼近，永远差一截。
而实际说话时 duck/restore 是按识别分块往返（约 200 ms 一次），所以主人一直在说话时，
增益一直在这条指数曲线中段来回，达不到 volume。

### 2.3 切断后的 duck 抑制 + 看门狗只兜得住 2.5 秒

旧 duck() 在切断后 2.5 s 内直接 return（旧 :610），`ducked` 保持原值；cut 的
`!isCurrent` 早退分支只调 `applyGain()`（旧 :511），此时若 `ducked === true`，
增益被按 0.45 写回，只有 DUCK_MAX_MS 看门狗能兜底。

### 2.4 逐条清单结论（对照任务要求）

1. **叠乘**：没有「乘两次」，但**互相打架**存在——cut 的线性斜坡是时间轴上最后一个事件时，
   会压掉后面 restore 的写入（2.1）。旧代码也确实缺 `cancelAndHoldAtTime`；
   本次改用 `cancelScheduledValues + setValueAtTime(当前值) + 单次 linearRampToValueAtTime`。
2. **数值被逐步写小**：没有。`volumeOverride` / `currentVolume()` / `prefs.volume` 都不在
   打断路径上相减相乘（唯一「逐步」是显式 `delta` 音量命令，按设计一致）。
3. **AudioContext 被重建 / 异常**：没有。`ensureContext()` 只在首次建一次（旧 :689-699），
   `enable()` 只 resume；suspend/interrupted 的表现是「全静音」不是「变小」，与本症状不符。
   仍保留 resume 兜底。
4. **MediaElement 音量 + Web Audio 增益叠加**：没有。全文件搜不到 `audio.volume = ...`；
   只有系统朗读兜底 `SpeechSynthesisUtterance.volume = currentVolume()`（旧 :642），
   而 Web Audio 增益只作用于 `<audio>`，两者不同时生效。
5. **测量**：见第 5 节，用可注入的假 AudioParam 量出来：旧路径 3 次打断后增益停在 **0.000**，
   说话期间平均 **0.676**（volume 0.9）；新路径同一串操作后精确回到 **0.900**。

## 3. 修法：单一写入者

新增 `src/volume-gain.ts` 的 `VolumeRig`，TtsPlayer 不再自己碰 `gain.gain`：

- 唯一写入口 `apply()`：`cancelScheduledValues(now)` → `setValueAtTime(参数当前值, now)`
  → `linearRampToValueAtTime(target, now + 0.06)`。**目标只能由 `target()` 算**：
  `volume`（=`override ?? prefs.volume`）或 `volume * duckLevel`，二选一，每次都从偏好重算，
  类里不保存任何「已经变小的音量」。
- `cancelScheduledValues` 在每次写入时执行 → 任何还没走完的「淡出到 0」都被清掉，
  不可能再成为时间轴上最后一个事件（2.1 结构性消失）。
- `cutFade()`：淡出 0.25 s + 设 2.5 s 抑制窗 + **自带恢复定时器**（290 ms 后 `endCut()`），
  即使上层 token 失效、会话被关，也会自己回到满音量。
- `endCut()` / `restore()`：显式把 ducked 置 false 再走同一条 apply，可单测。
- `beginSession()`：新会话清零 duck 与抑制窗，避免上一个会话的压低跟进来。
- 旧字段 `ducked / duckTimer / duckSuppressUntil / volumeOverride` 与常量
  `DUCK_MAX_MS / DUCK_SUPPRESS_MS` 全部移除，逻辑只在 rig 里一份。

改动文件：
| 文件 | 改动 |
| --- | --- |
| `src/volume-gain.ts` | 新增：VolumeRig，唯一增益写入者 + 埋点 |
| `src/volume-report.ts` | 新增：批量上报（300 ms 一批，最多 240 条，满则丢最旧） |
| `src/volume-log.ts` | 新增：host `/volume-log` 路由，白名单字段后追加 JSONL |
| `src/client.tsx` | TtsPlayer：cut/duck/restore/control/currentVolume/applyGain/beginSession 全部改为走 rig；新增 reporter |
| `src/index.ts` | 注册 `/volume-log`（2 行） |
| `build.mjs` | 增加三个测试用单文件构建 |
| `test/volume-gain.test.mjs` | 新增 11 项测试与测量 |

## 4. 测试（`node --test test/volume-gain.test.mjs`，共 11 项）

覆盖任务点名的四组：
1. 连续 5 次 duck/restore：每次 restore 后 `target === 0.9`、实测增益 0.9，不变小。
2. cut 后立即 restore（淡出未走完）：实测 0.9，而旧路径是 0。
3. cut → 抑制窗内 duck → restore：不进入死锁，`isDucked() === false`，定时器清空、
   增益回 0.9；抑制窗本身仍然有效（用于防叠加）。
4. `volumeOverride 0.6` 与 duck 组合：一次循环里 0.6 → 0.3 → 0.6，5 轮不衰减；清掉 override 回 0.9。
另外覆盖：看门狗兜底、cut 自愈定时器、埋点字段白名单（不含正文/音频）、host 侧字段裁剪与 0..1 夹取、
上报批量与丢旧策略。

## 5. 量出来的数字（确定的测量方式）

测量器：`test/volume-gain.test.mjs` 里的 `FakeParam`，按事件时间维护时间轴，`setTargetAtTime`
按指数求值，`linearRampToValueAtTime` 在结束时刻落到终止值并保持（这正是「最后一个事件说了算」的性质）。

| 场景 | 旧实现实测 | 新实现实测 |
| --- | --- | --- |
| cut 后 100 ms 内 restore（淡出未走完） | **0.000** | **0.900** |
| 连续 3 次打断后 | **0.000** | **0.900** |
| 说话期间（200 ms duck/restore 往返）平均 | **0.676** | （压低期间 0.45 是设计值；停口后精确回 0.900） |
| 5 次干净 duck/restore | 0.900（这条本身不坏，说明主因是 2.1 而非累积） | 0.900 |

`node --test` 的 diagnostic 输出里能直接看到这四行数字。

## 6. 用埋点复核（真实设备）

客户端每次 duck/restore/cut/apply/begin/override 都记一条：
`{at, event, ducked, target, actual, volumeOverride, prefsVolume, duckLevel, suppressed}`，
300 ms 一批 POST 到 `/volume-log`，host 写 `%TEMP%\dsh-voice-volume.jsonl`。
只写数字与枚举名，不写正文、不写音频；文件超过 512 KB 自动清空重建。

复核步骤：
1. 刷新页面，正常对话，连续打断 3~5 次，停口等 5 秒。
2. 看最后几条：

```powershell
Get-Content "$env:TEMP\dsh-voice-volume.jsonl" -Tail 12
```

3. 判定：最后一条 `event=restore` 的记录必须满足 `target == prefsVolume`
   （默认 0.9）；并且不该再出现 `target=0` 之后没有后续 restore 的情况。
   按事件计数看有没有异常多的 suppressed：

```powershell
Get-Content "$env:TEMP\dsh-voice-volume.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } | Group-Object event | Select-Object Name, Count
```

若 `actual` 持续低于 `target`，那是浏览器端音频被系统/标签页限流，与本修复无关，先看系统音量混音器。

## 7. 生效方式 / 回滚

- **只刷新页面即可**：增益逻辑全在客户端包里（`lib/client.js`）。
- 埋点要落地需要 host 侧 `/volume-log` 路由，也就是一次 `dsh_restart`（本次未执行，按任务要求不动运行中的服务）。
- 回滚：`git checkout -- src/client.tsx build.mjs` 会连别人未提交的改动一起丢，**不要这么回滚**。
  正确做法：删掉 `src/volume-gain.ts`、`src/volume-report.ts`、`src/volume-log.ts`、
  `test/volume-gain.test.mjs`，把 `src/client.tsx` 的 TtsPlayer 段恢复成
  `setTargetAtTime` 版本、`src/index.ts` 去掉 `VOLUME_LOG_ROUTES` 两行，再 `node build.mjs`。
  三个新文件与两个 import 是自包含的，删除不影响其他模块。
