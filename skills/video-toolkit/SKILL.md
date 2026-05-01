---
name: video-toolkit
description: Generate videos and video assets using the local claude-code-video-toolkit — FLUX.2 images, music, voiceover, and Remotion rendering. Use when the user asks to make a video, generate scene art, produce a voiceover, or render an mp4.
license: MIT
tags: [video, media, remotion, modal]
agents: [autojack, claude-code]
category: media
metadata:
  version: "0.1.0"
capabilities:
  network: true
  filesystem: readwrite
  tools: [Bash, Read, Edit]
requires-secrets:
  - name: MODAL_FLUX2_ENDPOINT_URL
    description: Modal endpoint for FLUX.2 image generation. Required for the smoke test.
    required: true
  - name: ACEMUSIC_API_KEY
    description: Free key from acemusic.ai/api-key. Optional — only needed for music generation.
    required: false
---

# Video Toolkit

Drive the local `claude-code-video-toolkit` to produce video assets and full Remotion-rendered
mp4s. The toolkit ships AI voiceover (Qwen3-TTS), image generation (FLUX.2), music (ACE-Step),
talking-head animation (SadTalker), text-to-video (LTX-2), and Remotion composition. This skill
is the lean entry point — start with the smoke test, then move to the real workflow.

## When to use

- The user asks to make a video, render an mp4, generate scene art, or produce a voiceover.
- The user asks for a "demo video" or "explainer video" of a product, sprint, or feature.
- The user asks to verify the video pipeline is working.

**Do NOT use for:** screen-recording the user's actual desktop (use OS recording), live video
editing of an existing file the user controls, or YouTube uploads (this skill produces local files
only).

## Prerequisites

- Toolkit checked out at `/Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit`. **Always
  `cd` here before running any tool command** — paths inside the toolkit are resolved relative to
  this root.
- Use the toolkit's bundled venv: `.venv/bin/python`. The repo ships with its own virtualenv
  populated from `tools/requirements.txt`; do not use system `python3` (it's missing `dotenv` and
  the GPU client libs).
- `node` 18+, `npm`, `ffmpeg` on PATH.
- Toolkit's `.env` populated with at minimum `MODAL_FLUX2_ENDPOINT_URL`. Other endpoints
  (`MODAL_MUSIC_GEN_ENDPOINT_URL`, `MODAL_QWEN3_TTS_ENDPOINT_URL`, `MODAL_SADTALKER_ENDPOINT_URL`)
  are needed only for their respective steps. Confirm with
  `.venv/bin/python tools/verify_setup.py`.

> Future: the path above should resolve from `$VIDEO_TOOLKIT_ROOT` once that env var is wired
> through autohub. For v0.1 it's hardcoded.

## Workflow — Smoke test (start here)

Run this first whenever you (or the user) want to confirm the pipeline is alive. Total cost
under $0.02, total wall time under 30s on warm GPU.

### 1. Verify setup

```bash
cd /Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit
.venv/bin/python tools/verify_setup.py
```

`flux2` should show `[x]`. Anything else marked `[ ]` is fine for the smoke test — those tools
just won't be available later.

### 2. Generate one FLUX.2 image

```bash
cd /Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit
.venv/bin/python tools/flux2.py \
  --preset title-bg \
  --output /tmp/video-toolkit-smoke.png \
  --cloud modal --progress json
```

`--progress json` emits JSONL on stderr with `stage` and `pct` fields — surface "submit",
"waiting", and "complete" to the user as they happen.

### 3. Confirm the artifact

```bash
ls -lh /tmp/video-toolkit-smoke.png
```

Expect a non-zero PNG (typically 200KB-1MB). If the file is missing or zero bytes, re-read
the JSONL output for the failing `stage`. Cold start can take 30-90s on first call.

Report success to the user with the file path. The pipeline works.

## Workflow — Make a real video

For a full multi-scene video. Per-scene assets are generated separately, then Remotion composes
and renders them into one mp4.

### 1. Create the project

```bash
cd /Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit
cp -r templates/product-demo projects/PROJECT_NAME
cd projects/PROJECT_NAME && npm install
```

Available templates: `product-demo`, `sprint-review`, `sprint-review-v2`.

### 2. Edit the config

Edit `projects/PROJECT_NAME/src/config/demo-config.ts`. Each scene needs `type`, `durationSeconds`,
and `content`. Estimate `durationSeconds` as `ceil(word_count / 2.5) + 2`; refine in step 5 once
voiceover lengths are known.

### 3. Generate background music

```bash
cd /Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit
.venv/bin/python tools/music_gen.py \
  --preset corporate-bg --duration 90 \
  --output projects/PROJECT_NAME/public/audio/bg-music.mp3 \
  --progress json
```

Presets: `corporate-bg`, `upbeat-tech`, `ambient`, `dramatic`, `tension`, `hopeful`, `cta`,
`lofi`. Default provider is acemusic (needs `ACEMUSIC_API_KEY`); pass `--cloud modal` to use
the self-hosted Modal endpoint instead.

### 4. Generate per-scene FLUX.2 images

One image per scene. Reuse the smoke-test command pattern with the scene's preset
(`title-bg`, `problem`, `solution`, `demo-bg`, `stats-bg`, `cta`) and a per-scene output path
under `projects/PROJECT_NAME/public/images/`.

### 5. Sync timing, then render

After voiceover generation (when added), measure each scene's audio duration with `ffprobe` and
update `durationSeconds` in `demo-config.ts` to `ceil(audio_duration + 2)`. Then render:

```bash
cd /Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit/projects/PROJECT_NAME
npm run render
```

Output: `out/ProductDemo.mp4`.

## Output

After the smoke test, report: the file path (`/tmp/video-toolkit-smoke.png`), file size, and
elapsed wall time. If a real render ran, also report total cost (sum the `cost` JSONL events from
each tool invocation).

## Anti-patterns

- **Don't run tool commands from inside a project directory.** Tools resolve paths relative to
  the toolkit root. Always `cd /Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit` first.
  The only command that runs from inside `projects/PROJECT_NAME/` is `npm run render`.
- **Don't omit `--progress json`** on any cloud GPU command. Without it you have no visibility
  into job stages and can't report progress to the user.
- **Don't generate a single voiceover file for the whole video.** Always one mp3 per scene under
  `public/audio/scenes/NN.mp3` — Remotion sequences them frame-accurately.
- **Don't duplicate the openclaw-video-toolkit skill.** That skill (642 lines, see "Going further"
  below) is the canonical deep reference; this skill is the lean entry point.
- **Don't background long-running tools and forget about them.** When a tool will take more than
  30s (chain_video, batch sadtalker), stay in the loop and poll the JSONL output. See
  openclaw-video-toolkit for the `yieldMs` pattern.

## Going further

For LTX-2 video clips, chained scene continuity, SadTalker talking heads, voice cloning, the
`yieldMs` polling pattern for long jobs, and the full Remotion composition guide, read:

```
/Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit/skills/openclaw-video-toolkit/SKILL.md
```

That skill assumes the toolkit lives at `~/.openclaw/workspace/claude-code-video-toolkit` — when
following its commands, substitute the actual path `/Users/jgarturo/Projects/OpenAI/claude-code-video-toolkit`.
