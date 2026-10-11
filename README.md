# Vega Composed Models

Vega Composed Models lets one character on stage be made of several pieces: a
Live2D body with a separate Live2D accessory, a still portrait with an
animated GIF overlay, a looping video behind a model — anything Vega can
render, stacked, positioned and grouped into one figure. The figure moves,
fades and changes expression as a single character, so story commands do not
care how many layers it has.

It also plays animated media on its own: a GIF or a video can be a character
directly.

A composed model is a small YAML file. Write it by hand, generate it, or edit
it visually with [Altair Models](https://github.com/haneoka-gakuen/altair-plugin-models).
Layered models from WebGAL projects (`.jsonl` and `.wmdl`) convert into the
same format.

## Install

```sh
pnpm add @haneoka/vega @haneoka/vega-renderer-three @haneoka/vega-plugin-composite three@0.184
```

Composed models render through the Three.js renderer; the DOM fallback scene
cannot show them. ESM only.

## Use it

```ts
import { VegaEngine } from "@haneoka/vega/engine";
import createCompositePlugin from "@haneoka/vega-plugin-composite";

const engine = new VegaEngine({
  plugins: [threeRenderPlugin, cubismPlugin, createCompositePlugin()],
});
```

The plugin (`haneoka.composite`) adds one character provider, `vega.composite`,
which claims model entries whose runtime format is `composite`, `gif` or
`video`. Child parts in other formats — Cubism 2, Cubism 3, static images — are
created by whichever plugin handles that format, so install those as well.

A story shows a composed character like any other:

```json
{
  "command": 0,
  "targetName": "anon",
  "characterModel": {
    "runtime": { "format": "composite", "model": "models/anon-stage.model.yaml" }
  }
}
```

For a GIF or video character, use `"format": "gif"` or `"format": "video"` with
the file in `model` (or `imageUrl`).

## The model file

```yaml
format: model
version: 1
name: Anon (stage)
pixelsPerUnit: 1440
frame: body
motions: [idle, wave]
expressions: [smile, surprised]
parts:
  - id: body
    format: cubism3
    source: ../live2d/anon/anon.model3.json
    fit: { width: 1.78, height: 1 }
  - id: guitar
    parent: body
    format: static-portrait
    source: ../images/guitar.png
    position: [0.12, -0.3, 0.01]
    rotation: [0, 0, -8]
    scale: [0.9, 0.9, 1]
    opacity: 1
  - id: sparkle
    parent: body
    format: gif
    source: ../effects/sparkle.gif
    optional: true
```

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `model` and `1`. |
| `name` | Display name. |
| `pixelsPerUnit` | How many source pixels make one stage unit. Default 100. |
| `frame` | The part whose bounds define the figure's size and placement. |
| `motions`, `expressions` | Names the figure offers to story commands. |
| `parts` | Up to 256 layers. Depth comes from each part's third position component. |

Each part:

| Field | Meaning |
| --- | --- |
| `id` | Unique within the file. |
| `source` | Path relative to the model file, or an absolute URL. |
| `format` | `cubism2`, `cubism3`, `static-portrait`, `gif`, `video` or `composite` (models can nest). |
| `parent` | Another part this one follows. Up to 32 levels; cycles are rejected. |
| `position`, `rotation`, `scale` | Three numbers each, relative to the parent. Rotation is in degrees. |
| `opacity` | 0 to 1, multiplied by the parent's opacity. |
| `fit` | `{ width, height, scale? }` — the box the part is scaled into. |
| `parameters` | Fixed model parameters, by id (for example a Live2D arm angle). |
| `options` | Extra settings passed to the part's own renderer. |
| `optional` | If the part fails to load, the figure is shown without it instead of failing. |

`validateCompositeModel` checks all of this and throws a message naming the
part and field when something is wrong. Values must be plain data: finite
numbers, no YAML aliases that form cycles, at most 128 levels of nesting.

## Loading resources

When a story is prepared, the provider lists the model file and every
required part — and asks each part's own provider for its dependencies — so
the whole figure is preloaded before it appears. Optional parts are left out
of the preload list; if one fails to load, the figure appears without it and
a warning is logged.

## Importing WebGAL layered models

```ts
import { importJsonlModel, importWmdlModel } from "@haneoka/vega-plugin-composite/import";
import { serializeCompositeModel } from "@haneoka/vega-plugin-composite/model";

const { document, diagnostics } = importJsonlModel(text, { width: 2560, height: 1440 });
const yaml = serializeCompositeModel(document);
```

`width`, `height` and `scale` describe the stage the original was laid out
for (default 2560 × 1440 at scale 1). Part ids are generated from the source
paths, so importing the same file twice gives the same ids. JSONL lines that
are not valid JSON are skipped and reported in `diagnostics`.

## API

| Path | Exports |
| --- | --- |
| `@haneoka/vega-plugin-composite` | `createCompositePlugin` (default), `createCompositeCharacterProvider`, `loadCompositeModel`, `compositeSource`, `compositeChildEntry` |
| `/model` | `parseCompositeModel`, `serializeCompositeModel`, `validateCompositeModel`, `resolveModelSource`, and the `CompositeModelDocument` / `CompositePart` types |
| `/import` | `importJsonlModel`, `importWmdlModel` |

## License

MPL-2.0. See [LICENSE](LICENSE).
