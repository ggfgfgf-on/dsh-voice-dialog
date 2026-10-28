# dsh-voice-dialog

Continuous voice conversation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one microphone in the composer, read-aloud while voice input is active, model-controlled voice intents, and soft interruptions that are handed to the running model instead of hard-cancelling it.

## What it does

- **One microphone, no mode button.** The composer microphone starts and stops continuous listening. There is no floating panel and no second toolbar control.
- **Continuous dictation.** A small VAD closes an utterance after ~1.4 s of silence and transcribes it through DSH speech-to-text. Speech from the enrolled owner is sent with `session.prompt(..., "queue")` by default, so it waits for the current reply; a setting switches it to `steer` for immediate barge-in. Other speakers are queued by default. Up to three utterances are transcribed in parallel; recognition is parallel, while delivery is one strict FIFO queue in speaking order.
- **Read-aloud while listening.** The host taps `llm/stream`, segments assistant text into sentences, synthesizes Edge TTS audio, and streams it over SSE. A long first sentence starts at its first natural comma once it has enough words, so the first audio does not wait for the final full stop. Playback is gated by the microphone: starting the mic enables it, stopping the mic stops accepting new sentences but drains the audio already queued. If Edge is unreachable, sentences use the platform speech voice instead of disappearing.
- **Priority barge-in.** When you start speaking, the reply is ducked (not stopped). Owner speech is queued with `session.prompt(..., "queue")` by default, so the reply you are listening to is not cut off; the setting can switch it to `steer`. Guest speech enters the same FIFO queue in speaking order, so a nearby interjection does not derail the current answer; guests can also be made to steer immediately or be ignored.
- **Queue-aware voice commands.** A leading “打断 / 停一下” stops playback, clears the not-yet-sent queue, and steers the remaining request in immediately. “忽略客人1 / 别理老婆” updates the speaker policy on the spot and removes that guest's waiting lines; “恢复” queues them again. Ordinary lines keep strict speaking order.
- **No chain-of-thought reading.** Compaction and session-title calls are filtered by `GenerateOptions.purpose`. Reasoning is scanned only for explicit `[[voice: ...]]` directives; its text is never spoken wholesale. Tool arguments never reach TTS.
- **Model-directed speech.** The model can choose the exact spoken words from reasoning: `[[voice: 要说的内容]]`, `[[voice: volume +0.15]]`, `[[voice: rate +10]]`, `[[voice: repeat]]`, `[[voice: stop]]`. A say marker adds a spoken prefix rather than replacing the visible answer. The same rate control is exposed to the model through the `voice_dialog` tool, so “说慢一点/说快一点/语速调到…” adjusts following sentences immediately.
- **Model-facing voice control.** A `voice_dialog` tool lets the model react to spoken meta-commands: 轻一点/响一点 (`volume`), 听不清/什么/重复一遍 (`repeat`), 别说了/闭嘴/停 (`stop`). The host broadcasts the action to the browser over the same SSE stream. `stop` also mutes new sentences until the user speaks again. The same actions and exact speech are available as reasoning markers, so the model can decide naturally without a tool call.
- **Background subagents.** While the microphone is active, the host records that parent session's voice state. When a subagent finishes, its final assistant text is summarized and queued straight into the parent's TTS stream, so the result is spoken without starting another main-model turn. A short heartbeat expires the state if the tab disappears.
- **Speaker labels and priority.** A local CAM++ voiceprint model (run by `sherpa-onnx-node`, no cloud call) identifies the enrolled owner and clusters other voices. Each transcript is prefixed with `[声纹：我]` or `[声纹：客人1]`, so the model can tell who is speaking. The owner is high priority; guests are low priority. The settings page can enroll the owner plus other regular speakers under persistent names, so their names replace “客人1” in transcripts. Confirmed owner utterances slowly reinforce the template, and the optional **只回应我的声音** switch drops utterances that do not match. The model can also decide per speaker: `voice_dialog` action `speaker` with `speaker: "客人1"` and `policy: "ignore"` drops that guest's future lines, `"queue"` restores queuing, and `speaker: "*"` applies to all guests. A `name` renames the voiceprint (for example `"老婆"`), after which both the canonical label and the new name work for policies and transcripts. The owner `我` cannot be renamed or ignored. When two people talk over each other, an optional local MossFormer2 ONNX model splits the single microphone segment into two streams before recognition; each stream gets its own voiceprint label and queue position. The splitter handles two simultaneous speakers well and falls back to the untouched audio when only one person is talking. Three or more overlapping voices can still be merged.
- **Settings page.** Auto-read, volume, duck level, Edge voice + audition, ASR provider/language, model preparation, owner/guest delivery policy, parallel recognition and input device all live in the plugin page under **Plugins → dsh-voice-dialog**. The active microphone expands into the built-in capture-row style with a live waveform, cancel and stop controls.

## Requirements

- DSH `0.2.1-rc.2` or a compatible build.
- Node.js 22+ (DSH requirement).
- A working DSH speech-to-text provider. This bundle composes the host rows itself:
  `speech-to-text`, `speech-to-text-sensevoice`, `api-speech-to-text`.
- Network access to Microsoft Edge TTS for the selected voice; without it, read-aloud falls back to the browser's system voice. The first SenseVoice use may need a model download. When Edge needs a proxy, the plugin reads `HTTPS_PROXY` / `HTTP_PROXY` and tunnels the WebSocket with CONNECT; `DSH_VOICE_TTS_PROXY` overrides it and `NO_PROXY` can exempt Edge.
- A secure browser context for the microphone: `https://` or `http://localhost` / `http://127.0.0.1`.
- Optional speaker labels: `sherpa-onnx-node` (installed as an optional dependency; it resolves a prebuilt native addon for this platform) and a one-time ~27 MB CAM++ model download. Without them, voice input still works, just without speaker labels.
- Optional simultaneous-speech separation: `onnxruntime-node` plus a one-time ~234 MB MossFormer2 model download (an ONNX export of Alibaba's `MossFormer2_SS_16K`, Apache-2.0). DirectML is tried first (about 0.4 s per 4 s window on a supported GPU); CPU is the fallback. Without it, ordinary dictation is unchanged.

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
3. Assistant replies are read aloud automatically while the microphone is listening.
4. Click the red microphone (or the stop button in the expanded row) to stop listening. Queued audio finishes; new sentences are not read. Spoken commands such as “轻一点”, “重复一遍” or “别说了” are routed to the model, which calls `voice_dialog`.

If the speech model is not prepared, the microphone opens this plugin page so you can download/prepare it. The page also shows the live provider state and download progress.

## Settings

All preferences are in **Plugins → dsh-voice-dialog**:

| Setting | Storage | Notes |
| --- | --- | --- |
| Auto-read, volume, duck level, input device | Browser `localStorage` | Per browser/device |
| Edge TTS voice, speech rate | Host `~/.dsh/voice-dialog/settings.json` | Applies immediately; survives restart |
| ASR provider, language | DSH speech selection | Shared with other speech clients |
| Model preparation | DSH speech host | Download / cancel / retry |
| Speech rate | Host `~/.dsh/voice-dialog/settings.json` | -50%..+50%; the model can change it too |
| Speaker prefix, only-my-voice, threshold | Browser `localStorage` | Prefix / gate behavior |
| Owner delivery, guest interjection policy, parallel ASR | Browser `localStorage` | Owner queues by default (or steers); guests queue (default), steer, or ignore; up to 3 ASR lanes, strict FIFO delivery |
| Owner + named guest voiceprints | Host `~/.dsh/voice-dialog/voiceprint.json` | Embeddings only; original audio is not stored; up to 12 named guests |
| Voiceprint model | Host `~/.dsh/voice-dialog/models/` | Downloaded from the settings page |
| Simultaneous-speech separation | Browser `localStorage` + host model | Optional; splits two overlapping speakers into two labelled recognition lanes |
| Separation model | Host `~/.dsh/voice-dialog/models/mossformer2_ss_16k.onnx` | ~234 MB; downloaded from the settings page |

The voice selector includes Mandarin, Cantonese, Taiwanese, English and Japanese Edge voices. **Audition** synthesizes a short sample through the host without touching the live reply queue; if Edge is unavailable it reads the sample with the system voice and shows a notice.

## Architecture

```text
llm/stream ──filter(purpose, text-delta)──► SentenceSegmenter ──► TtsQueue(Edge) ──► SSE
                                                                                   ▲
subagent/end ──parent voice-state──► summary ───────────────────────────────────────┘
                                                                                   │
composer microphone ──► MicrophoneLoop(VAD) ──► [optional 2-way separation] ──► parallel ASR ──► global FIFO queue ──► prompt(queue)
                                                                  └──► interrupt/ignore controls
                                                                                   │
SSE ──► TtsPlayer(Web Audio gain) ◄── duck on speech start ────────────────────────┘
```

- The host never reads reasoning, tool arguments, compaction summaries or session titles.
- A reply is **not** cancelled on barge-in. Only playback gain is ducked. Owner and guest speech share one FIFO queue in speaking order, so a faster ASR result cannot overtake an earlier utterance; only an explicit “打断” command stops playback and clears the unsent queue.
- The generated speech Remote contribution is vendored in `src/speech-remote.js`, so the client does not need the built-in voice-input UI module to mount it.

## Privacy

- Audio is transcribed by the configured DSH provider. With the default SenseVoice provider it stays on this machine.
- Only the final sentence text is sent to Microsoft Edge TTS for read-aloud.
- Speaker verification and simultaneous-speech separation run on the local host. The browser sends the short segment to `127.0.0.1`; the host stores only the 192-dimensional embedding (no audio) and never sends it to a cloud service. Separated streams exist only in memory for the current request. Other speakers are clustered in memory for the current session and are not persisted.
- Browser preferences stay in `localStorage`; the voice id is stored under `~/.dsh/voice-dialog/settings.json`. No API keys are used.

## Troubleshooting

- **Microphone error / no permission**: use HTTPS or localhost. On Android Edge you can temporarily allow an insecure origin via `edge://flags/#unsafely-treat-insecure-origin-as-secure`.
- **No sound**: click once anywhere on the page to unlock Web Audio; check the auto-read toggle and volume.
- **Voice preview fails / `read ECONNRESET` in the log**: direct egress to `speech.platform.bing.com` is usually being reset. Set `HTTPS_PROXY` and restart DSH; the host log then prints `Edge TTS via proxy http://…`.
- **Settings page says speech service unavailable**: both voice bundles may be enabled, or the host rows did not mount. Keep only `dsh-voice-dialog`.
- **Model not ready**: open the plugin page and click **准备语音模型**.
- **Speaker labels missing**: open the plugin page, check that the voiceprint model is ready, then click **录制我的声纹**. If the native component is missing, run `pnpm add sherpa-onnx-node` in the profile and restart DSH.
- **The owner is labeled as a guest**: lower the voiceprint threshold slightly (0.52 is a good start), or re-record the voiceprint in a quieter place.

## Development

```bash
npm install
npm run build
npm test
```

`npm run build` creates the host ESM bundle, the client `__ModuleLoader__` closure, and plain-node test surfaces. `npm test` covers strict FIFO delivery, queue-aware voice commands, sentence segmentation, Markdown filtering, the no-CoT filter, WAV encoding, voice switching, the voiceprint WAV decoder/cosine helper, and the separation window/overlap logic with an injected runner. The native voiceprint and separation models are exercised separately in development; they are not downloaded by `npm test`.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
