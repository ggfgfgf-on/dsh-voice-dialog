# dsh-voice-dialog

Continuous voice conversation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one microphone in the composer, automatic read-aloud of assistant replies, and soft interruptions that are handed to the running model instead of hard-cancelling it.

## What it does

- **One microphone, no mode button.** The composer microphone starts and stops continuous listening. There is no floating panel and no second toolbar control.
- **Continuous dictation.** A small VAD closes an utterance after ~1.4 s of silence, transcribes it through DSH speech-to-text, and sends the text with `session.prompt(..., "steer")`. If the assistant is still talking, the text is delivered at its next step boundary.
- **Automatic read-aloud.** The host taps `llm/stream`, segments visible assistant text into sentences, synthesizes Edge TTS audio, and streams it over SSE. The browser queues playback.
- **Soft barge-in.** When you start speaking, the reply is ducked (not stopped). The transcript is steered into the model. The assistant may finish its current thought, and its remaining audio is not cancelled.
- **No chain-of-thought.** Compaction and session-title calls are filtered by `GenerateOptions.purpose`; only `text-delta` chunks are spoken. `reasoning-delta` and tool arguments never reach TTS.
- **Settings page.** Auto-read, volume, duck level, Edge voice + audition, ASR provider/language, model preparation and input device all live in the plugin page under **Plugins → dsh-voice-dialog**.

## Requirements

- DSH `0.2.1-rc.2` or a compatible build.
- Node.js 22+ (DSH requirement).
- A working DSH speech-to-text provider. This bundle composes the host rows itself:
  `speech-to-text`, `speech-to-text-sensevoice`, `api-speech-to-text`.
- Network access to Microsoft Edge TTS for read-aloud. The first SenseVoice use may need a model download.
- A secure browser context for the microphone: `https://` or `http://localhost` / `http://127.0.0.1`.

## Install

From GitHub (the built `lib/` is committed):

```bash
dsh plugin --profile web add github:ggfgfgf-on/dsh-voice-dialog
```

Or from a local checkout:

```bash
dsh plugin --profile web add file:D:/path/to/dsh-voice-dialog
```

Then make sure the bundle is listed in the profile manifest:

```json
"dsh": { "profile": { "bundles": [ "...", "dsh-voice-dialog" ] } }
```

### Important: disable the built-in voice-input bundle

This plugin owns the same three speech host rows as
`@deepseek-ai/dsh-experimental-voice-input-bundle`. Do **not** enable both in one
profile; they would register the same services twice. Remove the built-in bundle
from `dsh.profile.bundles` (or disable it in the Plugins page) before enabling
`dsh-voice-dialog`. The microphone UI is replaced by this plugin, so nothing is lost.

## Use

1. Open a conversation and click the microphone in the composer.
2. Speak normally. Pauses close an utterance and insert it into the running turn.
3. Assistant replies are read aloud automatically.
4. Click the red microphone again to stop listening. Read-aloud can be turned off in the plugin settings.

If the speech model is not prepared, the microphone opens this plugin page so you can download/prepare it. The page also shows the live provider state and download progress.

## Settings

All preferences are in **Plugins → dsh-voice-dialog**:

| Setting | Storage | Notes |
| --- | --- | --- |
| Auto-read, volume, duck level, input device | Browser `localStorage` | Per browser/device |
| Edge TTS voice | Host `~/.dsh/voice-dialog/settings.json` | Applies immediately; survives restart |
| ASR provider, language | DSH speech selection | Shared with other speech clients |
| Model preparation | DSH speech host | Download / cancel / retry |

The voice selector includes Mandarin, Cantonese, Taiwanese, English and Japanese Edge voices. **Audition** synthesizes a short sample through the host without touching the live reply queue.

## Architecture

```text
llm/stream ──filter(purpose, text-delta)──► SentenceSegmenter ──► TtsQueue(Edge) ──► SSE
                                                                                   │
composer microphone ──► MicrophoneLoop(VAD) ──► speech.transcribe ──► session.prompt(steer)
                                                                                   │
SSE ──► TtsPlayer(Web Audio gain) ◄── duck on speech start ────────────────────────┘
```

- The host never reads reasoning, tool arguments, compaction summaries or session titles.
- A reply is **not** cancelled on barge-in. Only playback gain is ducked; the transcript reaches the model at the next step.
- The generated speech Remote contribution is vendored in `src/speech-remote.js`, so the client does not need the built-in voice-input UI module to mount it.

## Privacy

- Audio is transcribed by the configured DSH provider. With the default SenseVoice provider it stays on this machine.
- Only the final sentence text is sent to Microsoft Edge TTS for read-aloud.
- Browser preferences stay in `localStorage`; the voice id is stored under `~/.dsh/voice-dialog/settings.json`. No API keys are used.

## Troubleshooting

- **Microphone error / no permission**: use HTTPS or localhost. On Android Edge you can temporarily allow an insecure origin via `edge://flags/#unsafely-treat-insecure-origin-as-secure`.
- **No sound**: click once anywhere on the page to unlock Web Audio; check the auto-read toggle and volume.
- **Voice preview fails**: Edge TTS needs network access; check the host log for `[dsh-voice-dialog]`.
- **Settings page says speech service unavailable**: both voice bundles may be enabled, or the host rows did not mount. Keep only `dsh-voice-dialog`.
- **Model not ready**: open the plugin page and click **准备语音模型**.

## Development

```bash
npm install
npm run build
npm test
```

`npm run build` creates the host ESM bundle, the client `__ModuleLoader__` closure, and plain-node test surfaces. `npm test` covers sentence segmentation, Markdown filtering, the no-CoT filter, WAV encoding and voice switching.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
