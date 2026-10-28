# dsh-voice-dialog

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的连续语音对话插件：输入框旁只有一个麦克风，语音输入期间朗读助手回复，支持模型响应“轻一点/重复/闭嘴”等语音意图；插话会以“软打断”的方式交给正在运行的模型，而不是硬切断回答。

## 功能

- **只有一个麦克风。** 不再有“电话模式”按钮、悬浮面板或第二套工具栏控件；点麦克风开始/结束连续收音。
- **连续听写。** 静音约 1.4 秒后自动结束一句，调用 DSH 语音识别转写。登记过的本人默认用 `session.prompt(..., "queue")` 排在当前回答之后；可以在设置里改成 `steer` 立即插话。其他人默认也走排队。最多三句同时识别；识别是并行的，投递严格按说话先后排一条队列，后来的话不会抢到前面。
- **只在语音输入时朗读。** Host 监听 `llm/stream`，把助手文本按句切分后用 Edge TTS 合成，通过 SSE 推给浏览器排队播放。麦克风启动才接收新句子；关闭麦克风后不再读新内容，但会把已经排队的剩余音频读完。Edge 端点不可达时，这一句会退到系统语音朗读，不会静默消失。
- **按优先级插话。** 你开口时只把朗读音量压低，不停止播放。本人的话默认等当前回答说完，再用 `session.prompt(..., "queue")` 交给模型，不会把你正在听的回答截断；设置里可以改成 `steer` 立即插话。旁边其他人的话也按说话顺序排队，不抢当前回答；也可以改成直接插话或忽略。
- **队列里的最新意图。** 最新一句说“打断 / 停一下”会立刻停朗读、清掉还没送出的队列，并把后面的请求用插话送进去；说“忽略客人1 / 别理老婆”会当场改声纹策略，把那个人还在排队的句子删掉；说“恢复”重新排队。普通句子仍然严格按先后顺序走，不会因为识别快就超车。
- **不整段读思维链。** 通过 `GenerateOptions.purpose` 过滤 compaction / 会话标题等内部调用；reasoning 只扫描显式的 `[[voice: ...]]` 指令，不会把整段思维链读出来。工具参数永远不会进入 TTS。
- **模型决定说什么、说多快。** 模型可以在 reasoning 里写 `[[voice: 要说的内容]]` 指定朗读文本，或用 `[[voice: volume +0.15]]`、`[[voice: rate +10]]`、`[[voice: repeat]]`、`[[voice: stop]]` 控制。说“慢一点/快一点/语速调到…”时，模型通过 `voice_dialog` 的 `rate` 动作调整后续句子；say 指令只增加朗读前缀，不替代可见回复。
- **模型语音控制。** 新增 `voice_dialog` 工具：轻一点/响一点（`volume`）、听不清/什么/重复一遍（`repeat`）、别说了/闭嘴/停（`stop`）。Host 通过同一条 SSE 把动作广播给浏览器；`stop` 会静音后续句子，直到用户再次开口。同样的动作和指定朗读文本也可以直接用 reasoning 标记表达，模型不必每次走工具调用。
- **后台子代理直接播报。** 开麦时客户端把当前会话标记为语音活跃；子代理结束时 host 读取它的最终文本，压成一句摘要直接排进父会话的 TTS，不需要主模型再开一轮。客户端用心跳续期，标签页消失后状态自动过期。
- **声纹前缀与优先级。** 本地 CAM++ 声纹模型（由 `sherpa-onnx-node` 运行，不调用云端）识别登记过的本人，并把其他声音聚类；每段转写前加 `[声纹：我]` 或 `[声纹：客人1]`，模型能看出是谁在说。本人是高优先级，其他人是低优先级。设置页录制本人声纹；对话中判定为本人时会用该段特征慢慢强化模板，可选的“只回应我的声音”会丢弃不匹配的语音。模型也可以按声纹决定：调用 `voice_dialog` 的 `speaker` 动作，把 `客人1` 设为 `ignore` 就不再收这个人的后续语音，设为 `queue` 恢复排队，`speaker: "*"` 作用于所有其他人；带 `name` 可以给声纹改名（例如 `"老婆"`），之后用原名或新名字都能设置策略，转写也会显示新名字。主人 `我` 不能被改名或忽略。一个麦克风无法把同一瞬间的两个声音真正分开：先后接话可以并行识别，完全重叠仍需双麦克风或声源分离。
- **插件设置页。** 自动朗读、音量、压低比例、朗读音色与语速、试听、识别服务/语言、模型准备、我说话时/其他人插话策略、并行识别、输入麦克风都在 **插件 → dsh-voice-dialog** 页面里。麦克风激活后，输入框会展开成内置语音输入插件风格的整行：波形、取消和停止按钮。

## 要求

- DSH `0.2.1-rc.2` 或兼容版本。
- Node.js 22+。
- DSH 语音识别服务。本插件的 bundle 自己组合了三条 host 行：`speech-to-text`、`speech-to-text-sensevoice`、`api-speech-to-text`。
- 朗读需要能访问 Microsoft Edge TTS（用于所选音色）；访问不了会自动退到浏览器系统语音。首次使用 SenseVoice 可能需要下载模型。
- 需要代理才能访问 Edge 时，插件自动读取 `HTTPS_PROXY` / `HTTP_PROXY`，WebSocket 通过 CONNECT 隧道；可用 `DSH_VOICE_TTS_PROXY` 覆盖，`NO_PROXY` 可让 Edge 直连。
- 麦克风需要安全上下文：`https://` 或 `http://localhost` / `http://127.0.0.1`。
- 声纹前缀可选：`sherpa-onnx-node`（可选依赖，自带当前平台的原生模块）和一次约 27 MB 的 CAM++ 模型下载。没有它们时语音输入仍可用，只是不带说话人前缀。

## 安装

从 GitHub 安装（仓库内已提交构建后的 `lib/`）：

```bash
dsh plugin --profile web add github:ggfgfgf-on/dsh-voice-dialog
```

或从本地目录安装：

```bash
dsh plugin --profile web add file:D:/path/to/dsh-voice-dialog
```

确认 profile 的 bundle 列表包含：

```json
"dsh": { "profile": { "bundles": [ "...", "dsh-voice-dialog" ] } }
```

### 重要：不要同时启用内置语音输入 bundle

本插件和 `@deepseek-ai/dsh-experimental-voice-input-bundle` 需要同样的三条语音 host 行。
同一个 profile 里同时启用会重复注册服务。请在 `dsh.profile.bundles` 里移除内置
语音输入 bundle（或在插件页停用它），只保留 `dsh-voice-dialog`。麦克风界面由本插件接管，功能不会少。

## 使用

1. 打开会话，点输入框右侧的麦克风。
2. 正常说话；停顿会自动结束一句并插入当前轮次。
3. 语音输入期间助手回复会自动朗读；关闭麦克风后不再读新内容，已经排队的剩余音频会读完。
4. 再点一下红色麦克风（或展开行里的停止按钮）结束收音。说“轻一点/响一点/重复一遍/别说了”时，模型会调用 `voice_dialog` 调整朗读。

语音模型没准备好时，点麦克风会自动打开本插件设置页，可在那里下载/准备模型；页面也会显示实时状态和下载进度。

## 设置

全部在 **插件 → dsh-voice-dialog**：

| 设置 | 存储位置 | 说明 |
| --- | --- | --- |
| 自动朗读、音量、压低比例、输入设备 | 浏览器 `localStorage` | 每个浏览器/设备独立 |
| Edge 朗读音色、语速 | Host `~/.dsh/voice-dialog/settings.json` | 立即生效，重启后保留 |
| 识别服务、语言 | DSH speech selection | 与其他语音客户端共享 |
| 模型准备 | DSH speech host | 下载 / 取消 / 重试 |
| 语速 | Host `~/.dsh/voice-dialog/settings.json` | -50% 到 +50%；模型也能改 |
| 声纹前缀、只回应我的声音、阈值 | 浏览器 `localStorage` | 控制加不加前缀、是否过滤 |
| 我说话时、其他人插话策略、并行识别 | 浏览器 `localStorage` | 我默认排队（也可立即插话）；其他人排队（默认）/ 直接插话 / 忽略；最多三路识别，投递严格按说话顺序 |
| 本人声纹 | Host `~/.dsh/voice-dialog/voiceprint.json` | 只保存特征向量，不保存原始录音 |
| 声纹模型 | Host `~/.dsh/voice-dialog/models/` | 从设置页下载 |

音色包含普通话、粤语、台湾国语、英语、日语等 Edge 声音；**试听**会通过 host 合成一小段，不会打扰正在播放的回复队列。Edge 不可达时会自动改用系统语音试听并显示提示。

## 实现

```text
llm/stream ──过滤(purpose, text-delta)──► 句子切分 ──► TtsQueue(Edge) ──► SSE
                                                                       ▲
subagent/end ──父会话语音状态──► 摘要 ──────────────────────────────────┘
                                                                       │
输入框麦克风 ──► MicrophoneLoop(VAD) ──► 并行识别 ──► 全局 FIFO 队列 ──► prompt(queue)
                                                              └──► 打断/忽略控制
                                                                       │
SSE ──► TtsPlayer(Web Audio gain) ◄── 开口时 duck ─────────────────────┘
```

- Host 不朗读 reasoning、工具参数、compaction 摘要和会话标题。
- 插话不取消回答，只压低播放音量。本人和其他人的话都按说话顺序排队，后来的话不会因为识别更快而超车；只有明确的“打断”命令会立刻停朗读并清空待送队列。
- 语音转写 Remote 的生成代码内置在 `src/speech-remote.js`，客户端不再依赖内置语音输入 UI 来挂载它。

## 隐私

- 音频交给当前配置的 DSH 识别服务；默认 SenseVoice 完全在本机。
- 只有最终句子文本会发给 Microsoft Edge TTS 朗读。
- 声纹比对在本机 host 完成：浏览器只把这一小段音频发到 `127.0.0.1`，host 只保存 192 维特征向量（不保存原始录音），不会上传到云端。其他人的声纹只在当前会话内存里聚类，不落盘。
- 浏览器偏好保存在 `localStorage`；音色 id 保存在 `~/.dsh/voice-dialog/settings.json`，不使用 API Key。

## 常见问题

- **麦克风没权限**：必须 HTTPS 或 localhost；Android Edge 可临时用 `edge://flags/#unsafely-treat-insecure-origin-as-secure` 放行局域网地址。
- **没有声音**：先在页面上点一下以解锁 Web Audio；检查自动朗读开关和音量。
- **试听失败 / 日志出现 `read ECONNRESET`**：通常是直连 `speech.platform.bing.com` 被网络重置。设置 `HTTPS_PROXY` 后重启 DSH；host 日志会打印 `Edge TTS via proxy http://…`。若系统语音也失败，检查浏览器是否允许语音合成。
- **设置页提示语音服务不可用**：可能同时启用了两个语音 bundle，或 host 行没挂载。只保留 `dsh-voice-dialog`。
- **模型未就绪**：打开插件页点“准备语音模型”。
- **没有声纹前缀**：打开插件页确认声纹模型已就绪，再点“录制我的声纹”。如果提示缺少本地组件，在 profile 目录执行 `pnpm add sherpa-onnx-node` 后重启 DSH。
- **本人被标成客人**：把声纹阈值稍微调低（建议从 0.52 开始），或在安静环境重新录一遍。

## 开发

```bash
npm install
npm run build
npm test
```

`npm run build` 生成 host ESM、客户端 `__ModuleLoader__` 闭包和测试用的纯 Node 模块；`npm test` 覆盖优先级车道、句子切分、Markdown 过滤、不读思维链、WAV 编码、音色切换和声纹 WAV 解码/余弦相似度。原生声纹模型在开发时单独验证，`npm test` 不会下载模型。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
