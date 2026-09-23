import { parseDocument, stringify } from "yaml";
import { validateCompositeModel, type CompositeModelDocument } from "./descriptor.js";
export * from "./descriptor.js";

export function parseCompositeModel(source: string): CompositeModelDocument {
  if (source.length > 8 * 1024 * 1024) throw new RangeError("Model document is too large");
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    resolveKnownTags: false,
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
  });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  return validateCompositeModel(document.toJS({ maxAliasCount: 100 }));
}
export function serializeCompositeModel(document: CompositeModelDocument): string {
  return stringify(validateCompositeModel(document), { lineWidth: 100, aliasDuplicateObjects: false });
}
