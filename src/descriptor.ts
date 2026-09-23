export type ModelVector = readonly [number, number, number];
export interface CompositePart {
  readonly id: string;
  readonly source: string;
  readonly format: string;
  readonly parent?: string;
  readonly position?: ModelVector;
  readonly rotation?: ModelVector;
  readonly scale?: ModelVector;
  readonly opacity?: number;
  readonly optional?: boolean;
  readonly parameters?: Readonly<Record<string, number>>;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly fit?: {
    readonly width: number;
    readonly height: number;
    readonly scale?: number;
  };
}
export interface CompositeModelDocument {
  readonly format: "model";
  readonly version: 1;
  readonly name?: string;
  readonly pixelsPerUnit?: number;
  readonly frame?: string;
  readonly parts: readonly CompositePart[];
  readonly motions?: readonly string[];
  readonly expressions?: readonly string[];
}
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export function number(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Model values must be finite numbers");
  return value;
}
function vector(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} requires three numbers`);
  value.forEach((component) => number(component, 0));
}
function validateValue(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 128) throw new RangeError("Model document nesting exceeds 128 levels");
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    number(value, 0);
    return;
  }
  if (typeof value !== "object") throw new TypeError("Model documents require plain data values");
  if (ancestors.has(value)) throw new TypeError("Model document aliases must not form cycles");
  if (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new TypeError("Model documents require plain mappings");
  ancestors.add(value);
  for (const nested of Object.values(value)) validateValue(nested, ancestors, depth + 1);
  ancestors.delete(value);
}
export function validateCompositeModel(input: unknown): CompositeModelDocument {
  validateValue(input);
  const document = object(input);
  if (document.format !== "model" || document.version !== 1) throw new TypeError("Unsupported model format or version");
  if (!Array.isArray(document.parts) || document.parts.length > 256)
    throw new RangeError("A model supports at most 256 parts");
  if (document.name !== undefined && typeof document.name !== "string")
    throw new TypeError("Model name must be a string");
  for (const key of ["motions", "expressions"])
    if (
      document[key] !== undefined &&
      (!Array.isArray(document[key]) || document[key].some((value) => typeof value !== "string" || !value.trim()))
    )
      throw new TypeError(`Model ${key} must be an array of nonempty names`);
  if (number(document.pixelsPerUnit, 100) <= 0) throw new RangeError("Model density must be positive");
  const parts = new Map<string, Record<string, unknown>>();
  for (const inputPart of document.parts) {
    const part = object(inputPart);
    if (typeof part.id !== "string" || !part.id.trim() || parts.has(part.id))
      throw new TypeError("Model part IDs must be unique nonempty strings");
    if (
      typeof part.source !== "string" ||
      !part.source.trim() ||
      typeof part.format !== "string" ||
      !part.format.trim()
    )
      throw new TypeError(`Part ${part.id} requires a source and format`);
    if (part.parent !== undefined && typeof part.parent !== "string")
      throw new TypeError(`Part ${part.id} has an invalid parent`);
    if (part.optional !== undefined && typeof part.optional !== "boolean")
      throw new TypeError(`Part ${part.id} optional flag must be a boolean`);
    for (const key of ["parameters", "options"])
      if (part[key] !== undefined && (part[key] === null || typeof part[key] !== "object" || Array.isArray(part[key])))
        throw new TypeError(`Part ${part.id} ${key} must be a mapping`);
    vector(part.position, "Position");
    vector(part.rotation, "Rotation");
    vector(part.scale, "Scale");
    const alpha = number(part.opacity, 1);
    if (alpha < 0 || alpha > 1) throw new RangeError("Part opacity must be between 0 and 1");
    if (part.fit !== undefined) {
      const fit = object(part.fit);
      if (!(number(fit.width, 0) > 0 && number(fit.height, 0) > 0 && number(fit.scale, 1) > 0))
        throw new RangeError("A part fit requires positive dimensions and scale");
    }
    for (const [id, value] of Object.entries(object(part.parameters))) {
      if (!id.trim()) throw new TypeError("Parameter IDs must be nonempty");
      number(value, 0);
    }
    parts.set(part.id, part);
  }
  for (const part of parts.values()) {
    let current = part;
    const ancestors = new Set<unknown>([part.id]);
    while (current.parent !== undefined) {
      if (ancestors.has(current.parent) || ancestors.size >= 32)
        throw new RangeError("Model part hierarchy is cyclic or too deep");
      ancestors.add(current.parent);
      const parent = parts.get(String(current.parent));
      if (!parent) throw new TypeError(`Missing model parent: ${String(current.parent)}`);
      current = parent;
    }
  }
  if (document.frame !== undefined && !parts.has(String(document.frame)))
    throw new TypeError("Model frame must reference an existing part");
  return input as CompositeModelDocument;
}
export function resolveModelSource(base: string, source: string): string {
  const value = source.replace(/\\/g, "/");
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return value;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(base)) return new URL(value, base).href;
  const opaque = /^([a-z][a-z\d+.-]*:)(?!\/\/)([^?#]*)/i.exec(base);
  const path = opaque ? opaque[2]! : base,
    root = "https://model.invalid/";
  const resolved = new URL(value, new URL(path.replace(/^\//, ""), root));
  if (resolved.origin !== new URL(root).origin) return resolved.href;
  const result = resolved.pathname + resolved.search + resolved.hash;
  return opaque
    ? opaque[1] + result.slice(1)
    : path.startsWith("/") || value.startsWith("/")
      ? result
      : result.slice(1);
}
