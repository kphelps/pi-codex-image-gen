---
name: imagegen
description: Generate or edit raster images through the pi `image_gen` tool using Codex/ChatGPT auth. Use when the user wants AI-created bitmap visuals such as photos, illustrations, sprites, textures, product shots, web assets, mockups, or image variants. Do not use for repo-native SVG/vector/code assets unless the user explicitly wants a generated bitmap.
---

# Image Generation

Use the `image_gen` tool for image generation and image edits.

Key behavior:

- `image_gen` calls the Codex Responses endpoint with the native `image_generation` tool.
- It reuses pi `openai-codex` auth; do **not** ask the user for `OPENAI_API_KEY`.
- The default image generation model is `gpt-image-2`.
- The tool returns an inline image and usually saves a copy globally under `~/.pi/agent/generated-images/codex-image-gen` unless a different `save`/`outputPath` is requested.

## When to use

Use `image_gen` for:

- new bitmap images: photos, illustrations, textures, sprites, covers, website heroes, product shots, product mockups, UI mockups, game assets, infographics, and raster logo explorations;
- edits or variants of local images, by passing `imagePaths` with clear instructions;
- reference-image workflows, by passing `imagePaths` and describing each image's role in the prompt.

Do not use `image_gen` when the task is better solved by editing existing SVG/vector/code-native assets or by building deterministic HTML/CSS/canvas output.

## Workflow

1. Decide whether the user wants a new image or an edit/variant.
2. If using existing local images, pass them through `imagePaths` and explain their role in the prompt.
3. Write a concise, production-oriented prompt with exact constraints and exact text.
4. Call `image_gen` once per requested final image or variant.
5. For project-bound assets, either pass `outputPath` or copy the saved generated file into the workspace before finishing.
6. Report final path(s), model, and prompt summary.

Prompt scaffold:

```text
Use case: <photo/product-mockup/ui-mockup/infographic/sprite/texture/etc>
Asset type: <where the asset will be used>
Primary request: <user's main request>
Input images: <Image 1 role; Image 2 role> (if any)
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <layout, aspect, placement>
Lighting/mood: <lighting + mood>
Text (verbatim): "<exact text>" (if any)
Constraints: <must keep / must avoid>
Avoid: <negative constraints, no watermark>
```

## Tool parameters

Common `image_gen` params:

- `prompt`: complete prompt.
- `model`: image generation model. Default: `gpt-image-2`.
- `imagePaths`: local paths for edit targets or references.
- `size`: `auto` or a supported size. For `gpt-image-2`, explicit sizes should use multiples of 16 and stay within model limits.
- `quality`: `low`, `medium`, `high`, or `auto`. Default: `medium`.
- `outputFormat`: `png`, `webp`, or `jpeg`. Default: `png`.
- `outputPath`: exact file path for the generated image.
- `save`: `none`, `project`, `global`, or `custom`. Default: `global`.
- `saveDir`: directory for `save=custom`.

Only set `responseModel` or `baseUrl` for debugging or special Codex backend routing.

## Transparent images

`gpt-image-2` does not support native `background=transparent`. For simple transparent assets, use a chroma-key workflow first:

1. Prompt the image on a perfectly flat solid chroma-key background, usually `#00ff00` or `#ff00ff` if the subject is green.
2. Save/copy the source image into the project or a temp directory.
3. Run the bundled helper at `scripts/remove_chroma_key.py` relative to this skill directory:

```bash
python scripts/remove_chroma_key.py \
  --input <source> \
  --out <final.png> \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

Prompt transparent requests like:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

If the user explicitly needs true native transparency or the subject is complex (hair, fur, glass, smoke, translucent material, reflections, soft shadows), explain that `gpt-image-2` does not support native transparency and ask before switching to a different image model.
