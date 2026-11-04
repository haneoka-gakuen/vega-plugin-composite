import {
  defineVegaPlugin,
  type StoryCharacterProvider,
  type StoryCharacterResource,
  type StoryCharacterResourceEnumerationContext,
  type StoryCharacterRendererModelContext,
} from "@haneoka/vega/plugin";
import type { AdvCharacterModelEntry } from "@haneoka/vega/renderer-kit";
import {
  object,
  resolveModelSource,
  validateCompositeModel,
  type CompositeModelDocument,
  type CompositePart,
} from "./descriptor.js";
export type { CompositeModelDocument, CompositePart } from "./descriptor.js";

export const compositeSource = (entry: AdvCharacterModelEntry): string => String(object(entry.runtime).model ?? "");
export function compositeChildEntry(part: CompositePart, base: string, projectRoot?: string): AdvCharacterModelEntry {
  const source = part.options?.projectRoot
    ? projectRoot
      ? resolveModelSource(`${projectRoot.replace(/\/?$/u, "/")}__root__`, part.source.replace(/^\/+/, ""))
      : /^[a-z][a-z\d+.-]*:\/\//i.test(base)
        ? new URL(`/${part.source}`, base).href
        : part.source
    : resolveModelSource(base, part.source);
  return {
    runtime: {
      ...part.options,
      ...(projectRoot ? { projectRoot } : {}),
      format: part.format,
      ...(part.format === "static-portrait" || part.format === "gif" || part.format === "video"
        ? { imageUrl: source }
        : { model: source }),
    },
  };
}
export async function loadCompositeModel(
  context: Pick<StoryCharacterResourceEnumerationContext, "entry" | "resources" | "signal">,
): Promise<CompositeModelDocument> {
  const runtime = object(context.entry.runtime);
  if (runtime.document) return validateCompositeModel(runtime.document);
  const source = compositeSource(context.entry);
  if (!source) throw new TypeError("A composite model requires a document or source");
  const text = new TextDecoder().decode(await context.resources.load(source, context.signal));
  context.signal.throwIfAborted();
  if (/\.(jsonl|wmdl)([?#]|$)/i.test(source)) {
    const { importJsonlModel, importWmdlModel } = await import("./import.js");
    const layout = object(object(context.entry.profile).placement);
    const options = {
      width: Number(layout.referenceWidth ?? 2560),
      height: Number(layout.referenceHeight ?? 1440),
      scale: Number(layout.scale ?? 1),
    };
    const imported = /\.jsonl([?#]|$)/i.test(source) ? importJsonlModel(text, options) : importWmdlModel(text, options);
    for (const diagnostic of imported.diagnostics) console.warn(`[Composite model] ${source}: ${diagnostic}`);
    return imported.document;
  }
  const { parseCompositeModel } = await import("./model.js");
  return parseCompositeModel(text);
}
export function createCompositeCharacterProvider(): StoryCharacterProvider {
  return {
    id: "vega.composite",
    supports(entry) {
      return ["composite", "gif", "video"].includes(String(object(entry.runtime).format));
    },
    async enumerateResources(context) {
      const runtime = object(context.entry.runtime);
      if (runtime.format !== "composite")
        return [
          {
            source: String(runtime.imageUrl ?? runtime.model),
            label: "Animated media",
          },
        ];
      const document = await loadCompositeModel(context),
        source = compositeSource(context.entry);
      const resources: StoryCharacterResource[] = source ? [{ source, label: "Model document" }] : [];
      const children = await Promise.all(
        document.parts.map(async (part) => {
          if (part.optional) return [];
          const entry = compositeChildEntry(
              part,
              source,
              typeof runtime.projectRoot === "string" ? runtime.projectRoot : undefined,
            ),
            childSource = String(object(entry.runtime).model ?? object(entry.runtime).imageUrl);
          try {
            const dependencies = (await context.enumerateChildResources?.(entry, context.animationUsage)) ?? [];
            return [
              {
                source: childSource,
                ...(part.format === "static-portrait" ? { kind: "texture" as const } : {}),
              },
              ...dependencies,
            ];
          } catch (error) {
            if (context.signal.aborted || !part.optional) throw error;
            console.warn(`[Composite model] Part ${part.id} could not be prepared`, error);
            return [];
          }
        }),
      );
      for (const child of children) resources.push(...child);
      return [...new Map(resources.map((resource) => [resource.source, resource])).values()];
    },
    create() {
      throw new Error("The active renderer does not provide composed model surfaces");
    },
    async createForRenderer(context: StoryCharacterRendererModelContext) {
      const renderer = object(context.rendererContext);
      if (!renderer.gl || !renderer.threeRenderer)
        throw new Error(`Composed models are unavailable in renderer ${context.renderer}`);
      if (object(context.entry.runtime).format !== "composite") {
        const { createMediaModel } = await import("./media.js");
        return createMediaModel(context);
      }
      if (!context.children) throw new Error("The renderer must provide child model creation");
      const document = await loadCompositeModel(context);
      const { createThreeCompositeModel } = await import("./three.js");
      return createThreeCompositeModel(context, document);
    },
  };
}
export const createCompositePlugin = () =>
  defineVegaPlugin({
    manifest: {
      id: "haneoka.composite",
      name: "Vega Composed Models",
      version: "0.1.0",
      apiVersion: 1,
      capabilities: ["character"],
    },
    setup(context) {
      context.contribute("character", createCompositeCharacterProvider());
    },
  });
export default createCompositePlugin;
