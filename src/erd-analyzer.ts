import type {
  CapturedPage,
  Entity,
  EntityField,
  Relationship,
  ERDResult,
} from "./types.js";

/**
 * Analyze all captured pages to infer an Entity-Relationship Diagram.
 *
 * Strategy:
 * 1. Extract entities from forms (each form = potential entity with fields)
 * 2. Extract entities from data tables (each table = potential entity with columns)
 * 3. Extract entities from API responses (JSON objects = entities)
 * 4. Infer relationships from foreign-key-like fields and nested objects
 * 5. Merge duplicate entities found across multiple pages
 */
export function analyzeERD(pages: CapturedPage[]): ERDResult {
  const rawEntities: Map<string, Entity> = new Map();
  const relationships: Relationship[] = [];

  for (const page of pages) {
    // 1. Entities from forms
    for (const form of page.forms) {
      const entity = entityFromForm(form, page.url);
      if (entity) mergeEntity(rawEntities, entity);
    }

    // 2. Entities from tables
    for (const table of page.tables) {
      const entity = entityFromTable(table, page.url, page.title);
      if (entity) mergeEntity(rawEntities, entity);
    }

    // 3. Entities from API responses
    for (const api of page.apiCalls) {
      const entities = entitiesFromApi(api.url, api.responseBody, api.method);
      for (const entity of entities) {
        mergeEntity(rawEntities, entity);
      }
    }
  }

  // 4. Infer relationships from foreign key fields
  const entities = Array.from(rawEntities.values());
  inferRelationships(entities, relationships);

  return { entities, relationships };
}

/**
 * Derive an entity from a form.
 */
function entityFromForm(
  form: { action: string; method: string; fields: Array<{ name: string; type: string; label: string; required: boolean; options?: string[] }> },
  pageUrl: string
): Entity | null {
  if (form.fields.length === 0) return null;

  // Derive entity name from form action URL or page context
  let name = entityNameFromUrl(form.action || pageUrl);
  if (!name || name === "index") name = "FormEntity";

  const fields: EntityField[] = form.fields
    .filter((f) => f.name && !isMetaField(f.name))
    .map((f) => ({
      name: cleanFieldName(f.name),
      type: inferFieldType(f.type, f.name, f.options),
      required: f.required,
      isPrimaryKey: isIdField(f.name),
      isForeignKey: isForeignKeyField(f.name),
      referencesEntity: isForeignKeyField(f.name) ? fkTarget(f.name) : undefined,
      referencesField: isForeignKeyField(f.name) ? "id" : undefined,
    }));

  if (fields.length === 0) return null;

  // Ensure there's an ID field
  if (!fields.some((f) => f.isPrimaryKey)) {
    fields.unshift({
      name: "id",
      type: "integer",
      required: true,
      isPrimaryKey: true,
      isForeignKey: false,
    });
  }

  return { name: toPascalCase(name), fields, sources: [pageUrl] };
}

/**
 * Derive an entity from a data table.
 */
function entityFromTable(
  table: { headers: string[]; rowCount: number; sampleRows: string[][] },
  pageUrl: string,
  pageTitle: string
): Entity | null {
  if (table.headers.length === 0) return null;

  const name = entityNameFromUrl(pageUrl) || cleanName(pageTitle) || "TableEntity";

  const fields: EntityField[] = table.headers
    .filter((h) => h.trim().length > 0)
    .map((h) => {
      const fieldName = cleanFieldName(h);
      // Try to infer type from sample data
      const colIndex = table.headers.indexOf(h);
      const sampleValues = table.sampleRows
        .map((row) => row[colIndex])
        .filter(Boolean);

      return {
        name: fieldName,
        type: inferTypeFromSamples(fieldName, sampleValues),
        required: false,
        isPrimaryKey: isIdField(fieldName),
        isForeignKey: isForeignKeyField(fieldName),
        referencesEntity: isForeignKeyField(fieldName) ? fkTarget(fieldName) : undefined,
        referencesField: isForeignKeyField(fieldName) ? "id" : undefined,
      };
    });

  if (fields.length === 0) return null;

  if (!fields.some((f) => f.isPrimaryKey)) {
    fields.unshift({
      name: "id",
      type: "integer",
      required: true,
      isPrimaryKey: true,
      isForeignKey: false,
    });
  }

  return { name: toPascalCase(name), fields, sources: [pageUrl] };
}

/**
 * Extract entities from a JSON API response.
 */
function entitiesFromApi(
  url: string,
  responseBody: string | undefined,
  method: string
): Entity[] {
  if (!responseBody) return [];

  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch {
    return [];
  }

  const entities: Entity[] = [];
  const baseName = entityNameFromUrl(url);

  // Unwrap common response wrappers: { data: [...] }, { results: [...] }, { items: [...] }
  const unwrapped = unwrapResponse(data);

  if (Array.isArray(unwrapped) && unwrapped.length > 0 && isPlainObject(unwrapped[0])) {
    const entity = entityFromObject(unwrapped[0] as Record<string, unknown>, baseName, url);
    if (entity) entities.push(entity);
  } else if (isPlainObject(unwrapped)) {
    const entity = entityFromObject(unwrapped as Record<string, unknown>, baseName, url);
    if (entity) entities.push(entity);
  }

  return entities;
}

/**
 * Create an entity from a JSON object's keys.
 */
function entityFromObject(
  obj: Record<string, unknown>,
  name: string,
  sourceUrl: string
): Entity | null {
  const keys = Object.keys(obj).filter((k) => !isMetaField(k));
  if (keys.length === 0) return null;

  const fields: EntityField[] = keys.map((key) => ({
    name: cleanFieldName(key),
    type: inferTypeFromValue(key, obj[key]),
    required: obj[key] !== null && obj[key] !== undefined,
    isPrimaryKey: isIdField(key),
    isForeignKey: isForeignKeyField(key),
    referencesEntity: isForeignKeyField(key) ? fkTarget(key) : undefined,
    referencesField: isForeignKeyField(key) ? "id" : undefined,
  }));

  if (!fields.some((f) => f.isPrimaryKey)) {
    fields.unshift({
      name: "id",
      type: "integer",
      required: true,
      isPrimaryKey: true,
      isForeignKey: false,
    });
  }

  return {
    name: toPascalCase(name || "ApiEntity"),
    fields,
    sources: [sourceUrl],
  };
}

/**
 * Infer relationships between entities by matching foreign key fields to entity names.
 */
function inferRelationships(entities: Entity[], relationships: Relationship[]): void {
  const entityNames = new Set(entities.map((e) => e.name.toLowerCase()));

  for (const entity of entities) {
    for (const field of entity.fields) {
      if (!field.isForeignKey || !field.referencesEntity) continue;

      const targetName = toPascalCase(field.referencesEntity);
      // Check if the target entity actually exists
      if (entityNames.has(targetName.toLowerCase())) {
        const existing = relationships.find(
          (r) => r.from === entity.name && r.to === targetName && r.throughField === field.name
        );
        if (!existing) {
          relationships.push({
            from: entity.name,
            to: targetName,
            type: "many-to-one" as "one-to-many",
            throughField: field.name,
          });
        }
      }
    }
  }

  // Look for many-to-many junction tables (tables with 2+ FK fields and few other fields)
  for (const entity of entities) {
    const fkFields = entity.fields.filter((f) => f.isForeignKey);
    const nonFkFields = entity.fields.filter((f) => !f.isForeignKey && !f.isPrimaryKey);
    if (fkFields.length >= 2 && nonFkFields.length <= 2) {
      // This looks like a junction/pivot table
      for (let i = 0; i < fkFields.length; i++) {
        for (let j = i + 1; j < fkFields.length; j++) {
          const a = toPascalCase(fkFields[i].referencesEntity ?? "");
          const b = toPascalCase(fkFields[j].referencesEntity ?? "");
          if (a && b && entityNames.has(a.toLowerCase()) && entityNames.has(b.toLowerCase())) {
            relationships.push({
              from: a,
              to: b,
              type: "many-to-many",
              throughField: entity.name,
            });
          }
        }
      }
    }
  }
}

/**
 * Merge a new entity into the existing map, combining fields.
 */
function mergeEntity(map: Map<string, Entity>, newEntity: Entity): void {
  const key = newEntity.name.toLowerCase();
  const existing = map.get(key);

  if (!existing) {
    map.set(key, newEntity);
    return;
  }

  // Merge fields — add any fields not already present
  const existingFieldNames = new Set(existing.fields.map((f) => f.name.toLowerCase()));
  for (const field of newEntity.fields) {
    if (!existingFieldNames.has(field.name.toLowerCase())) {
      existing.fields.push(field);
    }
  }

  // Merge sources
  for (const src of newEntity.sources) {
    if (!existing.sources.includes(src)) {
      existing.sources.push(src);
    }
  }
}

// --- Heuristic helpers ---

function entityNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split("/")
      .filter((s) => s && !s.match(/^\d+$/) && !s.match(/^[0-9a-f-]{20,}$/));
    // Take the last meaningful segment
    const last = segments[segments.length - 1];
    if (last) return singularize(cleanName(last));
  } catch {
    // not a valid URL
  }
  return "";
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes"))
    return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function cleanName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function cleanFieldName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function toPascalCase(s: string): string {
  if (!s) return "";
  return s
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^./, (c) => c.toUpperCase());
}

function isIdField(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "id" || lower === "_id" || lower === "pk";
}

function isForeignKeyField(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (lower.endsWith("_id") || lower.endsWith("id")) &&
    lower !== "id" &&
    lower !== "_id" &&
    lower.length > 2
  );
}

function fkTarget(fieldName: string): string {
  const lower = fieldName.toLowerCase();
  if (lower.endsWith("_id")) return lower.slice(0, -3);
  if (lower.endsWith("id") && lower.length > 2) return lower.slice(0, -2);
  return "";
}

function isMetaField(name: string): boolean {
  const meta = [
    "csrf",
    "_token",
    "csrfmiddlewaretoken",
    "utf8",
    "authenticity_token",
    "__requestverificationtoken",
    "_method",
    "honeypot",
  ];
  return meta.includes(name.toLowerCase());
}

function inferFieldType(inputType: string, name: string, options?: string[]): string {
  if (options && options.length > 0) return "enum";
  const lower = name.toLowerCase();
  const typeLower = inputType.toLowerCase();
  if (typeLower === "email" || lower.includes("email")) return "string (email)";
  if (typeLower === "number" || lower.includes("price") || lower.includes("amount"))
    return "decimal";
  if (typeLower === "date" || lower.includes("date") || lower.includes("_at")) return "datetime";
  if (typeLower === "checkbox") return "boolean";
  if (typeLower === "file" || typeLower === "image") return "file";
  if (typeLower === "password") return "string (password)";
  if (typeLower === "url" || lower.includes("url") || lower.includes("link")) return "string (url)";
  if (typeLower === "tel" || lower.includes("phone")) return "string (phone)";
  if (typeLower === "textarea" || lower.includes("description") || lower.includes("bio"))
    return "text";
  if (isIdField(lower) || isForeignKeyField(lower)) return "integer";
  return "string";
}

function inferTypeFromValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "datetime";
    if (/^[\w.-]+@[\w.-]+\.\w+$/.test(value)) return "string (email)";
    if (/^https?:\/\//.test(value)) return "string (url)";
    if (value.length > 200) return "text";
    return "string";
  }
  if (Array.isArray(value)) return "json (array)";
  if (typeof value === "object") return "json (object)";
  return "string";
}

function inferTypeFromSamples(fieldName: string, samples: string[]): string {
  if (samples.length === 0) return inferFieldType("text", fieldName);

  const allNumeric = samples.every((s) => /^-?\d+(\.\d+)?$/.test(s.replace(/,/g, "")));
  if (allNumeric) {
    return samples.some((s) => s.includes(".")) ? "decimal" : "integer";
  }

  const allDates = samples.every((s) => !isNaN(Date.parse(s)) && s.length > 5);
  if (allDates) return "datetime";

  const allBool = samples.every((s) =>
    ["true", "false", "yes", "no", "0", "1"].includes(s.toLowerCase())
  );
  if (allBool) return "boolean";

  return inferFieldType("text", fieldName);
}

function unwrapResponse(data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const obj = data as Record<string, unknown>;
  // Common wrapper keys
  for (const key of ["data", "results", "items", "records", "rows", "content", "payload"]) {
    if (key in obj && (Array.isArray(obj[key]) || isPlainObject(obj[key]))) {
      return obj[key];
    }
  }
  return data;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
