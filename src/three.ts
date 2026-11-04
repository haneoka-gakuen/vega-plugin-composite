import type { StoryCharacterRendererModelContext } from "@haneoka/vega/renderer-kit";
import {
  isThreeStoryCharacterModel,
  type ThreeStoryCharacterModel,
  type ThreeCharacterBounds,
  type ThreeCharacterParameterFrame,
  type ThreeCharacterDrawState,
  type ThreeRendererLightState,
  type ThreeRendererMultiplyTextureOptions,
} from "@haneoka/vega-renderer-three";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { compositeChildEntry, compositeSource } from "./index.js";
import { type CompositeModelDocument, type CompositePart } from "./descriptor.js";
interface PartView {
  readonly definition: CompositePart;
  readonly model: ThreeStoryCharacterModel;
  readonly matrix: Matrix4;
  readonly canvas: ThreeCharacterBounds;
  readonly color: [number, number, number, number];
  readonly drawState: { objectToWorld: Matrix4; timeSeconds?: number };
  opacity: number;
}
const transformBounds = (bounds: ThreeCharacterBounds, matrix: Matrix4): ThreeCharacterBounds => {
  const point = new Vector3();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ]) {
    point.set(bounds.x + x! * bounds.width, bounds.y + y! * bounds.height, 0).applyMatrix4(matrix);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
export async function createThreeCompositeModel(
  context: StoryCharacterRendererModelContext,
  document: CompositeModelDocument,
): Promise<ThreeStoryCharacterModel> {
  const children = context.children!,
    base = compositeSource(context.entry);
  const disposed = new Set<Parameters<typeof children.dispose>[0]>();
  const dispose = async (model: Parameters<typeof children.dispose>[0]) => {
    if (disposed.has(model)) return;
    disposed.add(model);
    await children.dispose(model);
  };
  const results = await Promise.allSettled(
    document.parts.map(async (definition) => {
      const projectRoot = (context.entry.runtime as Record<string, unknown> | undefined)?.projectRoot;
      const model = await children.create(
        definition.id,
        compositeChildEntry(definition, base, typeof projectRoot === "string" ? projectRoot : undefined),
      );
      if (!isThreeStoryCharacterModel(model)) {
        await dispose(model);
        throw new TypeError(`Invalid surface for part ${definition.id}`);
      }
      return { definition, model };
    }),
  );
  const loaded = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failure = results.find((result, index) => result.status === "rejected" && !document.parts[index]!.optional);
  if (context.signal.aborted || failure) {
    await Promise.allSettled(loaded.map(({ model }) => dispose(model)));
    context.signal.throwIfAborted();
    throw failure?.status === "rejected" ? failure.reason : new Error("No model parts could be loaded");
  }
  for (const [index, result] of results.entries())
    if (result.status === "rejected")
      console.warn(`[Composite model] Part ${document.parts[index]!.id} was skipped`, result.reason);
  try {
    const retained = new Map(loaded.map((part) => [part.definition.id, part]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, part] of retained) {
        if (part.definition.parent && !retained.has(part.definition.parent) && part.definition.optional) {
          retained.delete(id);
          await dispose(part.model);
          changed = true;
        }
      }
    }
    return new ThreeCompositeModel(context, document, [...retained.values()]);
  } catch (error) {
    await Promise.allSettled(loaded.map(({ model }) => dispose(model)));
    throw error;
  }
}
class ThreeCompositeModel implements ThreeStoryCharacterModel {
  readonly format = "composite";
  readonly modelUrl: string;
  readonly pixelsPerUnit: number;
  private readonly parts: PartView[];
  private readonly bounds: ThreeCharacterBounds;
  private readonly mvp = new Matrix4();
  private released = false;
  private updateCount = 0;
  private drawCount = 0;
  constructor(
    private readonly context: StoryCharacterRendererModelContext,
    document: CompositeModelDocument,
    loaded: readonly {
      definition: CompositePart;
      model: ThreeStoryCharacterModel;
    }[],
  ) {
    this.modelUrl = compositeSource(context.entry);
    this.pixelsPerUnit = document.pixelsPerUnit ?? 100;
    const views = new Map<string, PartView>();
    this.parts = loaded.map(({ definition, model }) => {
      const bounds = model.canvasBounds(),
        fit = definition.fit;
      const factor = fit
        ? Math.min(fit.width / Math.max(0.000001, bounds.width), fit.height / Math.max(0.000001, bounds.height)) *
          (fit.scale ?? 1)
        : 1;
      const p = definition.position ?? [0, 0, 0],
        r = definition.rotation ?? [0, 0, 0],
        s = definition.scale ?? [1, 1, 1];
      const q = new Quaternion().setFromEuler(
        new Euler((r[0] * Math.PI) / 180, (r[1] * Math.PI) / 180, (r[2] * Math.PI) / 180, "YXZ"),
      );
      q.set(-q.x, -q.y, q.z, q.w);
      const matrix = new Matrix4().compose(
        new Vector3(p[0], p[1], -p[2]),
        q,
        new Vector3(s[0] * factor, s[1] * factor, s[2] * factor),
      );
      if (fit)
        matrix.multiply(new Matrix4().makeTranslation(-bounds.x - bounds.width / 2, -bounds.y - bounds.height / 2, 0));
      const canvas = fit
        ? {
            x: (-bounds.width * factor) / 2,
            y: (-bounds.height * factor) / 2,
            width: bounds.width * factor,
            height: bounds.height * factor,
          }
        : transformBounds(bounds, matrix);
      const view: PartView = {
        definition,
        model,
        matrix,
        canvas,
        color: [1, 1, 1, 1],
        drawState: { objectToWorld: new Matrix4() },
        opacity: definition.opacity ?? 1,
      };
      views.set(definition.id, view);
      return view;
    });
    const resolved = new Set<string>();
    const resolve = (part: PartView): void => {
      if (resolved.has(part.definition.id)) return;
      const parent = part.definition.parent ? views.get(part.definition.parent) : undefined;
      if (part.definition.parent && !parent) throw new Error(`Missing loaded parent ${part.definition.parent}`);
      if (parent) {
        resolve(parent);
        part.matrix.premultiply(parent.matrix);
        part.opacity *= parent.opacity;
      }
      resolved.add(part.definition.id);
    };
    for (const part of this.parts) resolve(part);
    const frame = document.frame ? (views.get(document.frame) ?? this.parts.at(-1)) : undefined;
    this.bounds = frame ? frame.canvas : (this.drawableBounds(false) ?? { x: 0, y: 0, width: 1, height: 1 });
  }
  get isOperational() {
    return !this.released && (this.parts.length === 0 || this.parts.some((part) => part.model.isOperational));
  }
  get updateSerial() {
    return this.updateCount;
  }
  get drawSerial() {
    return this.drawCount;
  }
  get isMotionPlaying() {
    return this.parts.some((part) => part.model.isMotionPlaying);
  }
  get motionSyncStatus() {
    return this.released
      ? ("released" as const)
      : (this.parts.find((part) => part.model.motionSyncStatus === "ready")?.model.motionSyncStatus ??
          ("unconfigured" as const));
  }
  private each(action: (model: ThreeStoryCharacterModel) => void) {
    if (!this.released) for (const part of this.parts) action(part.model);
  }
  private selected(name: string) {
    let selected: PartView | undefined;
    for (const part of this.parts) {
      if (
        name.startsWith(`${part.definition.id}::`) &&
        (!selected || part.definition.id.length > selected.definition.id.length)
      )
        selected = part;
    }
    return selected
      ? { parts: [selected], name: name.slice(selected.definition.id.length + 2) }
      : { parts: this.parts, name };
  }
  private any(name: string, action: (model: ThreeStoryCharacterModel, name: string) => boolean) {
    const selected = this.selected(name);
    return selected.parts.map((part) => action(part.model, selected.name)).some(Boolean);
  }
  setClockSuspended(value: boolean) {
    this.each((model) => model.setClockSuspended?.(value));
  }
  createSnapshot() {
    return {
      parts: this.parts.map((part) => ({
        id: part.definition.id,
        state: part.model.createSnapshot?.(),
      })),
    };
  }
  async restoreSnapshot(snapshot: unknown) {
    const value = snapshot as { parts?: { id: string; state?: unknown }[] };
    for (const item of value.parts ?? []) {
      const part = this.parts.find((part) => part.definition.id === item.id);
      if (part && item.state !== undefined) await part.model.restoreSnapshot?.(item.state);
    }
  }
  setPaused(value: boolean) {
    this.each((model) => model.setPaused(value));
  }
  setMotionSpeed(value: number) {
    this.each((model) => model.setMotionSpeed(value));
  }
  setEyeBlinkEnabled(value: boolean) {
    this.each((model) => model.setEyeBlinkEnabled(value));
  }
  resetExpressionParametersToDefault() {
    this.each((model) => model.resetExpressionParametersToDefault());
  }
  stopMotions() {
    this.each((model) => model.stopMotions());
  }
  resetMotionSync() {
    this.each((model) => model.resetMotionSync());
  }
  hasMotion(name: string) {
    return this.any(name, (model, value) => model.hasMotion(value));
  }
  hasExpression(name: string) {
    return this.any(name, (model, value) => model.hasExpression?.(value) ?? false);
  }
  playMotion(name: string, fade?: number) {
    return this.any(name, (model, value) => model.hasMotion(value) && model.playMotion(value, fade));
  }
  playExpression(name: string, fade?: number) {
    return this.any(
      name,
      (model, value) => (model.hasExpression?.(value) ?? true) && model.playExpression(value, fade),
    );
  }
  async prepareMotion(name: string) {
    const selected = this.selected(name);
    return (
      await Promise.all(
        selected.parts.map((part) =>
          part.model.hasMotion(selected.name) ? part.model.prepareMotion(selected.name) : false,
        ),
      )
    ).some(Boolean);
  }
  async prepareExpression(name: string) {
    const selected = this.selected(name);
    return (
      await Promise.all(
        selected.parts.map((part) =>
          part.model.hasExpression?.(selected.name) === false ? false : part.model.prepareExpression(selected.name),
        ),
      )
    ).some(Boolean);
  }
  isCurrentExpression(name: string) {
    return this.any(name, (model, value) => model.isCurrentExpression(value));
  }
  refreshCurrentExpressionFadeIn(name: string, fade?: number) {
    const selected = this.selected(name);
    for (const part of selected.parts)
      if (part.model.isCurrentExpression(selected.name)) part.model.refreshCurrentExpressionFadeIn(selected.name, fade);
  }
  private frame(part: PartView, frame: ThreeCharacterParameterFrame) {
    return part.definition.parameters
      ? {
          ...frame,
          overrides: { ...part.definition.parameters, ...frame.overrides },
        }
      : frame;
  }
  primeInitialFrame(frame: ThreeCharacterParameterFrame) {
    for (const part of this.parts) part.model.primeInitialFrame(this.frame(part, frame));
  }
  setParameter(id: string, value: number, weight?: number) {
    const selected = this.selected(id);
    for (const part of selected.parts) part.model.setParameter(selected.name, value, weight);
  }
  parameterRange(id: string) {
    const selected = this.selected(id);
    return selected.parts.map((part) => part.model.parameterRange(selected.name)).find(Boolean) ?? null;
  }
  eyeBallPosition() {
    return this.parts[0]?.model.eyeBallPosition() ?? { x: 0, y: 0 };
  }
  setEyeBallPosition(x: number, y: number) {
    this.each((model) => model.setEyeBallPosition(x, y));
  }
  forceEyeBallPosition(x: number, y: number) {
    this.each((model) => model.forceEyeBallPosition(x, y));
  }
  update(delta: number, frame: ThreeCharacterParameterFrame) {
    if (this.released) return;
    for (const part of this.parts) part.model.update(delta, this.frame(part, frame));
    this.updateCount++;
  }
  canvasBounds() {
    return { ...this.bounds };
  }
  drawableBounds(visibleOnly = true): ThreeCharacterBounds | null {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const part of this.parts) {
      if (visibleOnly && part.opacity <= 0) continue;
      const bounds = part.model.drawableBounds(visibleOnly);
      if (!bounds) continue;
      const transformed = transformBounds(bounds, part.matrix);
      minX = Math.min(minX, transformed.x);
      minY = Math.min(minY, transformed.y);
      maxX = Math.max(maxX, transformed.x + transformed.width);
      maxY = Math.max(maxY, transformed.y + transformed.height);
    }
    return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  draw(
    mvp: Matrix4,
    framebuffer: WebGLFramebuffer | null,
    viewport: readonly [number, number, number, number],
    color: readonly [number, number, number, number],
    state?: ThreeCharacterDrawState,
  ) {
    if (this.released) return;
    for (const part of this.parts) {
      if (part.opacity <= 0) continue;
      this.mvp.multiplyMatrices(mvp, part.matrix);
      part.color[0] = color[0];
      part.color[1] = color[1];
      part.color[2] = color[2];
      part.color[3] = color[3] * part.opacity;
      if (state?.objectToWorld) part.drawState.objectToWorld.copy(state.objectToWorld).multiply(part.matrix);
      else part.drawState.objectToWorld.copy(part.matrix);
      if (state?.timeSeconds !== undefined) part.drawState.timeSeconds = state.timeSeconds;
      else delete part.drawState.timeSeconds;
      part.model.draw(this.mvp, framebuffer, viewport, part.color, part.drawState);
    }
    this.drawCount++;
  }
  setRendererLighting(state: ThreeRendererLightState) {
    this.each((model) => model.setRendererLighting?.(state));
  }
  async loadRendererMultiplyTexture(source: string, options: ThreeRendererMultiplyTextureOptions) {
    await Promise.all(this.parts.map((part) => part.model.loadRendererMultiplyTexture?.(source, options)));
  }
  clearRendererMultiplyTexture() {
    this.each((model) => model.clearRendererMultiplyTexture?.());
  }
  release() {
    if (this.released) return;
    this.released = true;
    for (const part of [...this.parts].reverse())
      void Promise.resolve(this.context.children!.dispose(part.model)).catch((error) =>
        console.error("Model part disposal failed", error),
      );
  }
}
