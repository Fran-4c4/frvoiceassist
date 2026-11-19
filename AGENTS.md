# AGENTS.md

Guide for coding agents working in this repository.

## Overview

Local text-to-speech service with voice cloning. FastAPI serves a web UI and an API. The **Qwen3-TTS** engine
(`*-Base` models, PyPI package `qwen-tts`) generates English audio in the user's voice from reference audio and
its transcript. It runs in Docker with an NVIDIA GPU. UI text and error messages are in **Spanish**; spoken
content is in **English**.

## Commands

```powershell
.\.venv\Scripts\python -m pytest                    # tests (fake engine, no GPU)
.\.venv\Scripts\ruff check app tests scripts         # lint
docker compose --profile test run --rm tests         # tests inside the image
docker compose build; docker compose up -d           # build and start with GPU
docker compose logs -f tts                           # logs
docker compose run --rm tts python scripts/check_gpu.py
node --test tests/js/sentences.test.js               # JS sentence-splitting tests
# UI e2e (headless Chrome + fake server on :8799): see tests/e2e/README.md
$env:TTS_ENGINE="fake"; $env:QUALITY_STT="none"; .\.venv\Scripts\uvicorn app.main:main_app --factory --reload
```

## User data

Voices, presentations, outputs, and the clip cache live under `~/frvoiceassist` (`Settings.workspace_dir`,
`WORKSPACE_DIR` variable), **outside the repository**. Docker mounts this directory at `/workspace`
(`FRVOICEASSIST_HOME` > `USERPROFILE` > `HOME`). On Linux, the container runs as `APP_UID:APP_GID`, exported by
`scripts/start.sh`. See `docs/data-folder.md`.

## Architecture

- `app/main.py`: `create_app(settings, engine, transcriber)` is the application factory (tests inject
  `FakeEngine` and `FakeTranscriber`). Uvicorn uses `main_app` with `--factory`; importing the module creates no
  directories and loads nothing. The model loads in a background thread; `/api/health` returns `loading`,
  `ready`, or `error`.
- `app/service.py`: `SpeechService.synthesize` validates and splits text (`app/text.py`), calls the engine for
  each chunk, concatenates the results with pauses, normalizes the audio, and saves it under `outputs/`.
  `clip()` generates **one sentence** of audio and caches it at `cache/clips/<sha1>.wav`. The key includes the
  model, voice, voice fingerprint, language, mode, and normalized text.
- `app/presentations.py`: `PresentationStore` saves presentations (blocks containing `{id, title, text}`, plus
  voice, language, and mode) as JSON under `presentations/`.
- Sentence splitting: `static/sentences.js` (browser) and `app/sentences.py` (server) implement **the same
  algorithm** and are tested against the same cases (`tests/fixtures/sentences.json`). When changing one, change
  the other and add cases to the fixture.
- `app/presentation_io.py`: exports/imports `.md` (`<!-- frvoiceassist {json} -->` header plus `# title` blocks)
  and `.zip` files (presentation.json, guion.md, clips/<sha1>.wav, presentacion_completa.wav, manifest.json).
  Imports accept only `clips/<40 hex>.wav` paths. It also handles cleanup: `delete_unreferenced` deletes a clip
  only when no presentation uses it.
- A voice fingerprint hashes the **content** (audio plus transcript), not its timestamp. This keeps cached clips
  and exported `.zip` files valid when `~/frvoiceassist` is copied to another computer.
- Presentation mode (`static/present.js`):
  - Requests each sentence from `/api/clips` and plays from the cursor to the end of the block. Text inside
    `[brackets]` is not spoken.
  - A browser queue prepares audio in the background. `enqueue(texts, front)` prioritizes newly written blocks.
  - The inline editor (`N`, ✎) can add or edit blocks without interrupting playback.
  - `mutateItems()` keeps the cursor and playback attached to the same blocks (by ID) after insertions or
    deletions.
  - Playback speed is stored in the browser and shared with Free text. The presentation playbar can seek within
    the current sentence; clicking a sentence remains the way to move across the wider script.
  - `window.FVA.present` exposes state for e2e tests (`tests/e2e`).
- Audio output (`static/audio-router.js`, `window.FVARouter`): all cloned speech passes through a single
  `AudioContext` using `setSinkId` (CABLE Input), registered through `FVA.registerOutput(el)` →
  `createMediaElementSource`. The real microphone is mixed into the same context with gain controlled by
  `micro.js`: `M` toggles it, it is always closed on load, and it auto-mutes while cloned speech is playing.
  `mictest.js` verifies the chain by recording `CABLE Output`. Monitor elements (speakers) **do not** pass
  through the router.
- `app/tts/`: the `TTSEngine` interface lives in `base.py`. `QwenEngine` imports `torch` and `qwen_tts` **only
  inside `load()`** so the app and tests work without a GPU. It caches the voice-cloning prompt per voice and
  mode (`create_voice_clone_prompt`) and invalidates it when the audio or transcript changes. A lock allows only
  one generation at a time. `Settings.model_id` supports both Qwen3-TTS Base variants (1.7B by default and 0.6B
  as the lighter option); changing it also changes the sentence-cache key.
- `app/voices.py`: `VoiceStore` manages `voices/<name>/{reference.wav,reference.txt}`. It converts audio to
  24 kHz mono with ffmpeg, or with soundfile when ffmpeg is unavailable. Valid duration is 3 to 60 seconds.
- `app/quality.py`: checks reference-recording quality using signal metrics and Whisper through faster-whisper
  (CPU int8, loaded on demand). It passes 16 kHz numpy audio to faster-whisper because its PyAV decoder is
  incompatible with the image's `av` version. The report is saved at `voices/<name>/quality.json` and tied to
  the voice fingerprint. Tests inject `FakeTranscriber`.
- Cloning modes: `full` (ICL prompt with reference audio and text) or `timbre`
  (`x_vector_only_mode=True`). Prompts are cached per voice and mode.
- `app/static/`: framework-free HTML/CSS/JS with no build step. It uses `HTMLMediaElement.setSinkId` to send
  audio to a virtual cable (Teams/Meet).

## qwen-tts API (verified against the official v0.1.1 README)

```python
from qwen_tts import Qwen3TTSModel
model = Qwen3TTSModel.from_pretrained(model_id, device_map="cuda:0", dtype=torch.bfloat16,
                                      attn_implementation="flash_attention_2")  # sdpa is the default here
prompt = model.create_voice_clone_prompt(ref_audio=path, ref_text=text, x_vector_only_mode=False)
wavs, sr = model.generate_voice_clone(text=..., language="English", voice_clone_prompt=prompt,
                                      max_new_tokens=2048)   # accepts HF generate kwargs
```

Languages use their full English names (`"English"`, `"Spanish"`, and so on). `qwen-tts` pins
`transformers==4.57.3`. **Do not upgrade transformers separately.**

## Conventions

- Python ≥ 3.11, type annotations, and `ruff` with a 120-character line limit.
- Every behavior change requires a test. Tests must **never** require a GPU, network access, or the real model;
  use `FakeEngine` or mocks.
- Configuration is provided only through environment variables (`app/config.py`). Document every new variable
  in `.env.example` and the README.
- The Dockerfile pins torch and torchaudio through `/etc/pip-constraints.txt`. Every new `pip install` must use
  `-c /etc/pip-constraints.txt` to avoid breaking the CUDA build.
- To add another TTS engine, implement `TTSEngine` under `app/tts/` and register it in `build_engine`.

## Do not

- Do not store user data in the repository or image. It belongs under `~/frvoiceassist`; voices are biometric
  data.
- Do not expose the port beyond `127.0.0.1` without adding authentication.
- Do not load the model during module import or in tests.
- Do not clone third-party voices without consent.

## Roadmap

See `docs/roadmap.md`. Phase 2 is a near-real-time pipeline: Spanish microphone input → STT (faster-whisper) →
translation → Qwen3-TTS in English → virtual microphone.
