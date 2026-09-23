import type { ParsedFrame } from "gifuct-js";
import type { StoryCharacterRendererModelContext } from "@haneoka/vega/renderer-kit";
import {
  StaticPortraitModel,
  type ThreeRendererContext,
  type ThreeStoryCharacterModel,
} from "@haneoka/vega-renderer-three";
import { object } from "./descriptor.js";

interface MediaClock {
  readonly source: TexImageSource;
  readonly width: number;
  readonly height: number;
  update(delta: number): boolean;
  setPaused(value: boolean): void;
  setSpeed(value: number): void;
  snapshot(): unknown;
  restore(value: unknown): Promise<void>;
  dispose(): void;
}
const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

async function gifClock(context: StoryCharacterRendererModelContext, source: string): Promise<MediaClock> {
  const { parseGIF, decompressFrame } = await import("gifuct-js");
  const bytes = await context.resources.load(source, context.signal),
    parsed = parseGIF(bytes.slice().buffer);
  context.signal.throwIfAborted();
  const frames = parsed.frames.filter((frame): frame is Extract<typeof frame, { image: unknown }> => "image" in frame);
  if (!frames.length || parsed.lsd.width <= 0 || parsed.lsd.height <= 0) throw new TypeError("GIF has no image frames");
  const canvas = document.createElement("canvas"),
    patch = document.createElement("canvas");
  canvas.width = parsed.lsd.width;
  canvas.height = parsed.lsd.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!,
    patchContext = patch.getContext("2d")!;
  const decoded = new Map<number, ParsedFrame>();
  const read = (index: number) => {
    let frame = decoded.get(index);
    if (!frame) {
      frame = decompressFrame(frames[index]!, parsed.gct, true);
      decoded.set(index, frame);
      if (decoded.size > 8) decoded.delete(decoded.keys().next().value!);
    }
    return frame;
  };
  const ends: number[] = [];
  let total = 0;
  for (const frame of frames) {
    total += Math.max(10, (frame.gce?.delay || 10) * 10);
    ends.push(total);
  }
  const options = object(context.entry.runtime),
    looping = options.loop !== false;
  let time = 0,
    speed = 1,
    paused = false,
    active = options.autoplay !== false,
    current = -1,
    previous: ImageData | undefined;
  const clear = (frameIndex: number) => {
    const frame = read(frameIndex),
      { left, top, width, height } = frame.dims;
    ctx.clearRect(left, top, width, height);
    const color = parsed.gct?.[parsed.lsd.backgroundColorIndex];
    if (frame.transparentIndex === undefined && color) {
      ctx.fillStyle = `rgb(${color.join(",")})`;
      ctx.fillRect(left, top, width, height);
    }
  };
  const draw = (index: number) => {
    if (index === current) return false;
    if (index < current) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      current = -1;
      previous = undefined;
    }
    if (current < 0) {
      const first = read(0),
        background = parsed.gct?.[parsed.lsd.backgroundColorIndex];
      if (first.transparentIndex === undefined && background) {
        ctx.fillStyle = `rgb(${background.join(",")})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
    for (let next = current + 1; next <= index; next++) {
      if (current >= 0) {
        const before = read(current);
        if (before.disposalType === 2) clear(current);
        else if (before.disposalType === 3 && previous) ctx.putImageData(previous, 0, 0);
      }
      const frame = read(next);
      previous = frame.disposalType === 3 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : undefined;
      patch.width = frame.dims.width;
      patch.height = frame.dims.height;
      const pixels = new Uint8ClampedArray(frame.patch);
      patchContext.putImageData(new ImageData(pixels, patch.width, patch.height), 0, 0);
      ctx.drawImage(patch, frame.dims.left, frame.dims.top);
      current = next;
    }
    return true;
  };
  const select = () => {
    const at = looping ? time % total : Math.min(time, total - 0.001);
    let low = 0,
      high = ends.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (at < ends[middle]!) high = middle;
      else low = middle + 1;
    }
    return draw(low);
  };
  draw(0);
  return {
    source: canvas,
    width: canvas.width,
    height: canvas.height,
    update(delta) {
      if (!paused && active) {
        time += Math.max(0, delta) * 1000 * speed;
        return select();
      }
      return false;
    },
    setPaused(value) {
      paused = value;
    },
    setSpeed(value) {
      speed = value;
    },
    snapshot() {
      return { time, speed, paused, active };
    },
    async restore(value) {
      const state = object(value);
      time = Math.max(0, finite(state.time));
      speed = Math.max(0.001, finite(state.speed, 1));
      paused = state.paused === true;
      active = state.active !== false;
      select();
    },
    dispose() {
      decoded.clear();
      canvas.width = canvas.height = patch.width = patch.height = 0;
    },
  };
}

function waitVideo(video: HTMLVideoElement, event: string, signal: AbortSignal, ready?: () => boolean): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (ready?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      video.removeEventListener(event, loaded);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish(),
      failed = () => finish(new Error(video.error?.message || "Video decoding failed")),
      aborted = () => finish(signal.reason || new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(() => finish(new Error("Video decoding timed out")), 15000);
    video.addEventListener(event, loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
async function videoClock(context: StoryCharacterRendererModelContext, source: string): Promise<MediaClock> {
  const lease = await context.resources.resolveRenderable(source, context.signal),
    video = document.createElement("video"),
    options = object(context.entry.runtime);
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.playsInline = options.playsinline !== false;
  video.muted = options.muted !== false;
  video.loop = options.loop !== false;
  const lifetime = new AbortController();
  let paused = false,
    active = options.autoplay !== false,
    lastTime = -1,
    disposed = false,
    playPending = false,
    blocked = false;
  let frameRevision = 0,
    uploadedRevision = -1,
    frameRequest = 0;
  const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";
  const decoded = () => {
    frameRevision++;
    if (!disposed) frameRequest = video.requestVideoFrameCallback(decoded);
  };
  if (hasFrameCallback) frameRequest = video.requestVideoFrameCallback(decoded);
  const play = () => {
    if (paused || !active || disposed || playPending || blocked || !video.paused) return;
    playPending = true;
    void video
      .play()
      .catch((error) => {
        if (disposed || paused) return;
        if (error?.name === "NotAllowedError") {
          blocked = true;
          document.addEventListener("pointerdown", retry, { once: true });
          document.addEventListener("keydown", retry, { once: true });
        } else if (error?.name !== "AbortError") console.warn("Video part playback failed", error);
      })
      .finally(() => {
        playPending = false;
        if (paused || disposed) video.pause();
      });
  };
  const retry = () => {
    blocked = false;
    play();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    if (frameRequest) video.cancelVideoFrameCallback(frameRequest);
    document.removeEventListener("pointerdown", retry);
    document.removeEventListener("keydown", retry);
    video.pause();
    video.removeAttribute("src");
    video.load();
    lease.release();
  };
  try {
    video.src = lease.url;
    await waitVideo(video, "loadeddata", context.signal, () => video.readyState >= 2);
    context.signal.throwIfAborted();
    return {
      source: video,
      width: video.videoWidth,
      height: video.videoHeight,
      update() {
        play();
        const changed =
          !video.seeking &&
          video.readyState >= 2 &&
          (hasFrameCallback ? uploadedRevision !== frameRevision : lastTime !== video.currentTime);
        if (changed) {
          lastTime = video.currentTime;
          uploadedRevision = frameRevision;
        }
        return changed;
      },
      setPaused(value) {
        paused = value;
        if (value) video.pause();
        else play();
      },
      setSpeed(value) {
        video.playbackRate = Math.max(0.0625, Math.min(16, value));
      },
      snapshot() {
        return {
          time: video.currentTime,
          speed: video.playbackRate,
          paused,
          active,
        };
      },
      async restore(value) {
        const state = object(value);
        video.pause();
        active = state.active !== false;
        const target = Math.max(0, Math.min(finite(video.duration, Infinity), finite(state.time)));
        if (Math.abs(video.currentTime - target) > 0.00001) {
          const pending = waitVideo(video, "seeked", lifetime.signal);
          video.currentTime = target;
          await pending;
        }
        video.playbackRate = Math.max(0.0625, Math.min(16, finite(state.speed, 1)));
        lastTime = -1;
        if (!paused && active) play();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
export async function createMediaModel(context: StoryCharacterRendererModelContext): Promise<ThreeStoryCharacterModel> {
  const runtime = object(context.entry.runtime),
    source = String(runtime.imageUrl ?? runtime.model ?? "");
  const renderer = context.rendererContext as ThreeRendererContext;
  const clock = runtime.format === "gif" ? await gifClock(context, source) : await videoClock(context, source);
  let surface: StaticPortraitModel;
  try {
    surface = StaticPortraitModel.createSurface(
      {
        gl: renderer.gl,
        imageUrl: source,
        pixelsPerUnit: finite(runtime.pixelsPerUnit, 100),
      },
      clock.source,
      clock.width,
      clock.height,
    );
  } catch (error) {
    clock.dispose();
    throw error;
  }
  let paused = false,
    suspended = true,
    released = false;
  clock.setPaused(true);
  const overrides: Partial<ThreeStoryCharacterModel> = {
    format: String(runtime.format),
    setPaused(value) {
      paused = value;
      clock.setPaused(paused || suspended);
    },
    setClockSuspended(value) {
      suspended = value;
      clock.setPaused(paused || suspended);
    },
    setMotionSpeed(value) {
      clock.setSpeed(Math.max(0.001, finite(value, 1)));
    },
    update(delta, frame) {
      if (clock.update(delta)) surface.updateSurface(clock.source);
      surface.update(delta, frame);
    },
    createSnapshot() {
      return { clock: clock.snapshot(), paused };
    },
    async restoreSnapshot(value) {
      const state = object(value);
      paused = state.paused === true;
      clock.setPaused(true);
      await clock.restore(state.clock);
      surface.updateSurface(clock.source);
      clock.setPaused(paused || suspended);
    },
    release() {
      if (released) return;
      released = true;
      surface.release();
      clock.dispose();
    },
  };
  const methods = new Map<PropertyKey, { method: unknown; bound: unknown }>();
  return new Proxy(surface, {
    get(target, key) {
      const value = Reflect.has(overrides, key) ? Reflect.get(overrides, key) : Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached && cached.method === value) return cached.bound;
      const bound = value.bind(target);
      methods.set(key, { method: value, bound });
      return bound;
    },
  });
}
