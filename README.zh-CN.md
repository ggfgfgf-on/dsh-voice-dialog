# dsh-voice-dialog

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的连续语音对话插件：输入框旁只有一个麦克风，助手回复自动朗读，插话会以“软打断”的方式交给正在运行的模型，而不是硬切断回答。

## 功能

- **只有一个麦克风。** 不再有“电话模式”按钮、悬浮面板或第二套工具栏控件；点麦克风开始/结束连续收音。
- **连续听写。** 静音约 1.4 秒后自动结束一句，调用 DSH 语音识别转写，再通过 `session.prompt(..., "steer")` 插入当前轮次。助手还在说话时，文字会在下一个 step 边界送到模型。
- **自动朗读。** Host 监听 `llm/stream`，只取可见的 `text-delta`，按句切分后用 Edge TTS 合成，通过 SSE 推给浏览器排队播放。
- **软打断。** 你开口时只把朗读音量压低，不停止播放；转写文字插给模型。模型可以说完当前这句，剩下的朗读也不会被取消。
- **不读思维链。** 通过 `GenerateOptions.purpose` 过滤 compaction / 会话标题等内部调用，只朗读 `text-delta`；`reasoning-delta` 和工具参数永远不会进入 TTS。
- **插件设置页。** 自动朗读、音量、压低比例、朗读音色与试听、识别服务/语言、模型准备、输入麦克风都在 **插件 → dsh-voice-dialog** 页面里。

## 要求

- DSH `0.2.1-rc.2` 或兼容版本。
- Node.js 22+。
- DSH 语音识别服务。本插件的 bundle 自己组合了三条 host 行：`speech-to-text`、`speech-to-text-sensevoice`、`api-speech-to-text`。
- 朗读需要能访问 Microsoft Edge TTS；首次使用 SenseVoice 可能需要下载模型。
- 麦克风需要安全上下文：`https://` 或 `http://localhost` / `http://127.0.0.1`。

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
3. 助手回复会自动朗读。
4. 再点一下红色麦克风结束收音；自动朗读可在插件设置里关闭。

语音模型没准备好时，点麦克风会自动打开本插件设置页，可在那里下载/准备模型；页面也会显示实时状态和下载进度。

## 设置

全部在 **插件 → dsh-voice-dialog**：

| 设置 | 存储位置 | 说明 |
| --- | --- | --- |
| 自动朗读、音量、压低比例、输入设备 | 浏览器 `localStorage` | 每个浏览器/设备独立 |
| Edge 朗读音色 | Host `~/.dsh/voice-dialog/settings.json` | 立即生效，重启后保留 |
| 识别服务、语言 | DSH speech selection | 与其他语音客户端共享 |
| 模型准备 | DSH speech host | 下载 / 取消 / 重试 |

音色包含普通话、粤语、台湾国语、英语、日语等 Edge 声音；**试听**会通过 host 合成一小段，不会打扰正在播放的回复队列。

## 实现

```text
llm/stream ──过滤(purpose, text-delta)──► 句子切分 ──► TtsQueue(Edge) ──► SSE
                                                                       │
输入框麦克风 ──► MicrophoneLoop(VAD) ──► speech.transcribe ──► session.prompt(steer)
                                                                       │
SSE ──► TtsPlayer(Web Audio gain) ◄── 开口时 duck ─────────────────────┘
```

- Host 不朗读 reasoning、工具参数、compaction 摘要和会话标题。
- 插话不取消回答，只压低播放音量；转写文字在下一个 step 交给模型。
- 语音转写 Remote 的生成代码内置在 `src/speech-remote.js`，客户端不再依赖内置语音输入 UI 来挂载它。

## 隐私

- 音频交给当前配置的 DSH 识别服务；默认 SenseVoice 完全在本机。
- 只有最终句子文本会发给 Microsoft Edge TTS 朗读。
- 浏览器偏好保存在 `localStorage`；音色 id 保存在 `~/.dsh/voice-dialog/settings.json`，不使用 API Key。

## 常见问题

- **麦克风没权限**：必须 HTTPS 或 localhost；Android Edge 可临时用 `edge://flags/#unsafely-treat-insecure-origin-as-secure` 放行局域网地址。
- **没有声音**：先在页面上点一下以解锁 Web Audio；检查自动朗读开关和音量。
- **试听失败**：Edge TTS 需要网络；看 host 日志里的 `[dsh-voice-dialog]`。
- **设置页提示语音服务不可用**：可能同时启用了两个语音 bundle，或 host 行没挂载。只保留 `dsh-voice-dialog`。
- **模型未就绪**：打开插件页点“准备语音模型”。

## 开发

```bash
npm install
npm run build
npm test
```

`npm run build` 生成 host ESM、客户端 `__ModuleLoader__` 闭包和测试用的纯 Node 模块；`npm test` 覆盖句子切分、Markdown 过滤、不读思维链、WAV 编码和音色切换。

## 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
