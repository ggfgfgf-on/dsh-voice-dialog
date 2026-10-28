# Design

## Goals

- One composer microphone, no separate conversation mode and no floating status surface.
- Continuous listening with natural pauses; the transcript joins the current turn as a steering message.
- Read assistant replies aloud with a selectable Edge voice.
- Never read reasoning, tool arguments, compaction summaries or session titles.
- A barge-in is soft: duck playback, keep the reply, let the model decide when to respond.

## Host

`src/index.ts` registers the SSE transport, config/settings/preview routes and the `llm/stream` tap.

The tap uses two filters (`src/speech-filter.ts`):

1. `shouldSpeak(options, enabled)` rejects missing sessions, `purpose: compaction` and `purpose: session-title`.
2. `isSpeakableChunk(chunk)` accepts only non-empty `text-delta`. Reasoning and tool-call deltas are dropped.

Accepted deltas flow into `SentenceSegmenter`, then `TtsQueue`. The queue serializes Edge synthesis per host, retries with backoff, and emits `{sessionId, seq, text, audio}` frames over SSE. A trailing fragment is flushed only for a completed, non-aborted stream.

The generated speech Remote contribution is mounted by the client itself (`ctx.remote.$mount`), then a nested `ctx.inject(["remote.speech", ...])` registers the UI. This removes the dependency on the built-in voice-input client plugin.

## Client

`src/mic.ts` keeps one `AudioContext` + `ScriptProcessor` alive and uses RMS endpointing with a pre-roll buffer. It emits 16 kHz mono `Float32Array` utterances.

`src/client.tsx` shadows `conversation.input.activity` at priority `-100`, so only this microphone renders even when the built-in UI is installed. Clicking it starts/stops `MicrophoneLoop`; segments are transcribed and sent with `session.prompt(text, "steer")`.

`TtsPlayer` owns a single Web Audio graph with a gain node. Speech start sets `ducked`, speech end restores it. Playback is never paused by a barge-in. Blocked autoplay frames are kept and replayed on the first gesture.

## Settings

`plugins.bundle.config` for key `dsh-voice-dialog` renders `VoiceSettings`: browser-local preferences, Edge voice + host preview, ASR provider/language, model preparation and input device. The host persists only the voice id, under `~/.dsh/voice-dialog/settings.json`.

## Compatibility

The bundle composes the same speech host rows as the built-in voice-input bundle. Only one of them may be enabled in a profile. The built-in bundle is not a client dependency; its UI is shadowed if present, but its host rows are not reused.
