import { object, validateCompositeModel, type CompositeModelDocument, type CompositePart } from "./descriptor.js";
export interface CompositeImportOptions {
  readonly width?: number;
  readonly height?: number;
  readonly scale?: number;
}
export interface CompositeImportResult {
  readonly document: CompositeModelDocument;
  readonly diagnostics: readonly string[];
}
const numeric = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const kind = (source: string, type: unknown): string => {
  if (type === "video" || /\.(mp4|webm|ogv)([?#]|$)/i.test(source)) return "video";
  if (type === "gif" || /\.gif([?#]|$)/i.test(source)) return "gif";
  if (type === "image" || /\.(png|jpe?g|webp|avif|svg)([?#]|$)/i.test(source)) return "static-portrait";
  return /\.model3\.json([?#]|$)/i.test(source)
    ? "cubism3"
    : /\.(jsonl|wmdl)([?#]|$)/i.test(source)
      ? "composite"
      : "cubism2";
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && Boolean(v)))] : [];
const dimensions = (options: CompositeImportOptions) => {
  const width = Math.max(1, numeric(options.width, 2560)),
    height = Math.max(1, numeric(options.height, 1440));
  return { width, height, scale: Math.max(0.001, numeric(options.scale, 1)) };
};
const partIds = () => {
  const occurrences = new Map<string, number>();
  return (key: string): string => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    let first = 2166136261,
      second = 2246822507;
    for (const byte of new TextEncoder().encode(`${key}\0${occurrence}`)) {
      first = Math.imul(first ^ byte, 16777619);
      second = Math.imul(second ^ byte, 3266489909);
    }
    return `part_${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
  };
};
export function importJsonlModel(source: string, options: CompositeImportOptions = {}): CompositeImportResult {
  const { width, height, scale } = dimensions(options),
    rows: Record<string, unknown>[] = [],
    diagnostics: string[] = [];
  let summary: Record<string, unknown> = {};
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row = object(JSON.parse(line));
      if (typeof row.path === "string" && row.path.trim()) rows.push(row);
      else summary = { ...summary, ...row };
    } catch {
      diagnostics.push(`Invalid JSONL at line ${index + 1}`);
    }
  }
  const version = numeric(summary.version, 1);
  const sourceOrder = new Map(rows.map((row, index) => [row, index]));
  if (version >= 2) rows.sort((a, b) => numeric(a.index, sourceOrder.get(a)!) - numeric(b.index, sourceOrder.get(b)!));
  const id = partIds();
  const parts: CompositePart[] = rows.map((row) => {
    const path = String(row.path).replace(/\\/g, "/"),
      format = kind(path, row.type);
    const media = ["static-portrait", "video", "gif"].includes(format);
    const flags = Object.fromEntries(
      ["loop", "muted", "autoplay", "playsinline"]
        .filter((key) => typeof row[key] === "boolean")
        .map((key) => [key, row[key]]),
    );
    return {
      id: id(String(row.id ?? path)),
      source: path,
      format,
      optional: true,
      position: [numeric(row.x, 0) / height, -numeric(row.y, 0) / height || 0, 0],
      scale: [numeric(row.xscale, 1), numeric(row.yscale, 1), 1],
      fit: { width: width / height, height: 1, scale: media ? 1 : scale },
      ...(summary.import !== undefined && !media ? { parameters: { PARAM_IMPORT: numeric(summary.import, 0) } } : {}),
      options: {
        ...flags,
        ...(path.startsWith("game/") ? { projectRoot: true } : {}),
      },
    };
  });
  const document: CompositeModelDocument = {
    format: "model",
    version: 1,
    pixelsPerUnit: height,
    ...(parts.at(-1) ? { frame: parts.at(-1)!.id } : {}),
    parts,
    motions: strings(summary.motions),
    expressions: strings(summary.expressions),
  };
  return { document: validateCompositeModel(document), diagnostics };
}
export function importWmdlModel(source: string, options: CompositeImportOptions = {}): CompositeImportResult {
  const input = object(JSON.parse(source)),
    { width, height, scale } = dimensions(options);
  const rows = [
    typeof input.modelRelativePath === "string" ? { modelRelativePath: input.modelRelativePath } : null,
    ...(Array.isArray(input.subModels) ? input.subModels.map(object) : []),
  ].filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row.modelRelativePath === "string" && Boolean(row.modelRelativePath),
  );
  const id = partIds();
  const parts: CompositePart[] = rows.map((row) => ({
    id: id(String(row.modelRelativePath)),
    source: String(row.modelRelativePath),
    format: kind(String(row.modelRelativePath), "live2d"),
    optional: true,
    position: [numeric(row.offsetX, 0) / height, -numeric(row.offsetY, 0) / height || 0, 0],
    fit: { width: width / height, height: 1, scale },
  }));
  const document: CompositeModelDocument = {
    format: "model",
    version: 1,
    pixelsPerUnit: height,
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(parts.at(-1) ? { frame: parts.at(-1)!.id } : {}),
    parts,
  };
  return { document: validateCompositeModel(document), diagnostics: [] };
}
