# pi-codex-image-gen

Pi extension package that registers an `image_gen` tool. The tool calls ChatGPT/Codex's Responses endpoint with the native `image_generation` tool, so it reuses pi's `openai-codex` login instead of requiring `OPENAI_API_KEY`.

## Install/use locally

```bash
pi install /home/ubuntu/dev/pi-codex-image-gen
# or for a one-off run:
pi -e /home/ubuntu/dev/pi-codex-image-gen
```

Then run `/login` in pi and choose **ChatGPT Plus/Pro (Codex Subscription)** if `openai-codex` auth is not already configured.

## Tool

`image_gen` generates or edits one image and returns:

- a text summary,
- an inline image attachment,
- optional saved file details.

Defaults:

- image model: `gpt-image-2`
- Codex Responses model: active `openai-codex` model, then `gpt-5.5`
- output format: `png`
- quality: `medium`
- size: `auto`
- save mode: `global` (`~/.pi/agent/generated-images/codex-image-gen`)

Useful params include `prompt`, `imagePaths`, `model`, `responseModel`, `size`, `quality`, `outputFormat`, `save`, `saveDir`, `outputPath`, and `overwrite`.

## Configuration

Optional config files, with project overriding global:

- `~/.pi/agent/extensions/codex-image-gen.json`
- `<project>/.pi/extensions/codex-image-gen.json`

Example:

```json
{
  "save": "project",
  "imageModel": "gpt-image-2",
  "responseModel": "gpt-5.5",
  "quality": "medium",
  "size": "1536x1024"
}
```

Environment overrides:

- `PI_CODEX_IMAGE_MODEL`
- `PI_CODEX_IMAGE_RESPONSE_MODEL`
- `PI_CODEX_IMAGE_BASE_URL`
- `PI_CODEX_IMAGE_QUALITY`
- `PI_CODEX_IMAGE_SIZE`
- `PI_CODEX_IMAGE_OUTPUT_FORMAT`
- `PI_CODEX_IMAGE_SAVE_MODE`
- `PI_CODEX_IMAGE_SAVE_DIR`
- `PI_CODEX_IMAGE_WIDTH_CELLS`
- `PI_CODEX_IMAGE_TMUX_INLINE=0` to disable the tmux Kitty passthrough renderer

## Transparency

`gpt-image-2` does not support native transparent backgrounds. For simple transparent assets, prompt for a flat chroma-key background and run the bundled helper:

```bash
python /home/ubuntu/dev/pi-codex-image-gen/skills/imagegen/scripts/remove_chroma_key.py \
  --input <source> \
  --out <final.png> \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```
