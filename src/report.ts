import type { CapturedPage, ERDResult, Entity, Relationship } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Generate all output reports: ERD Mermaid diagram, JSON schema, Markdown summary.
 */
export async function generateReports(
  pages: CapturedPage[],
  erd: ERDResult,
  outputDir: string
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all([
    writeERDMermaid(erd, outputDir),
    writeERDJson(erd, outputDir),
    writePageManifest(pages, outputDir),
    writeSummaryMarkdown(pages, erd, outputDir),
    writeDbmlSchema(erd, outputDir),
  ]);
}

/**
 * Write a Mermaid erDiagram — can be pasted into Mermaid Live Editor or GitHub markdown.
 */
async function writeERDMermaid(erd: ERDResult, outputDir: string): Promise<void> {
  const lines: string[] = ["erDiagram"];

  for (const entity of erd.entities) {
    lines.push(`    ${entity.name} {`);
    for (const field of entity.fields) {
      const pk = field.isPrimaryKey ? "PK" : "";
      const fk = field.isForeignKey ? "FK" : "";
      const tag = [pk, fk].filter(Boolean).join(",");
      const tagStr = tag ? ` "${tag}"` : "";
      lines.push(`        ${field.type.replace(/[^a-zA-Z0-9_]/g, "_")} ${field.name}${tagStr}`);
    }
    lines.push(`    }`);
  }

  for (const rel of erd.relationships) {
    const cardinality = mermaidCardinality(rel.type);
    lines.push(`    ${rel.from} ${cardinality} ${rel.to} : "${rel.throughField}"`);
  }

  await fs.writeFile(path.join(outputDir, "erd.mmd"), lines.join("\n"), "utf-8");
}

/**
 * Write the ERD as structured JSON for programmatic consumption.
 */
async function writeERDJson(erd: ERDResult, outputDir: string): Promise<void> {
  await fs.writeFile(
    path.join(outputDir, "erd.json"),
    JSON.stringify(erd, null, 2),
    "utf-8"
  );
}

/**
 * Write a DBML schema — can be imported into dbdiagram.io.
 */
async function writeDbmlSchema(erd: ERDResult, outputDir: string): Promise<void> {
  const lines: string[] = [];

  for (const entity of erd.entities) {
    lines.push(`Table ${entity.name} {`);
    for (const field of entity.fields) {
      const attrs: string[] = [];
      if (field.isPrimaryKey) attrs.push("pk");
      if (field.required) attrs.push("not null");
      if (field.isForeignKey && field.referencesEntity) {
        attrs.push(`ref: > ${toPascalCase(field.referencesEntity)}.id`);
      }
      const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
      lines.push(`  ${field.name} ${dbmlType(field.type)}${attrStr}`);
    }
    lines.push(`}`);
    lines.push("");
  }

  await fs.writeFile(path.join(outputDir, "schema.dbml"), lines.join("\n"), "utf-8");
}

/**
 * Write a manifest of all captured pages.
 */
async function writePageManifest(pages: CapturedPage[], outputDir: string): Promise<void> {
  const manifest = pages.map((p) => ({
    url: p.url,
    title: p.title,
    screenshotPath: p.screenshotPath,
    formsCount: p.forms.length,
    tablesCount: p.tables.length,
    apiCallsCount: p.apiCalls.length,
    interactiveElementsCount: p.interactiveElements.length,
    capturedAt: p.capturedAt,
  }));

  await fs.writeFile(
    path.join(outputDir, "pages.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
}

/**
 * Write a human-readable Markdown summary.
 */
async function writeSummaryMarkdown(
  pages: CapturedPage[],
  erd: ERDResult,
  outputDir: string
): Promise<void> {
  const lines: string[] = [];

  lines.push("# GlideCapture — App Reverse-Engineering Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Pages Captured:** ${pages.length}`);
  lines.push(`**Entities Discovered:** ${erd.entities.length}`);
  lines.push(`**Relationships Found:** ${erd.relationships.length}`);
  lines.push("");

  // Pages summary
  lines.push("## Pages");
  lines.push("");
  lines.push("| # | URL | Title | Forms | Tables | API Calls |");
  lines.push("|---|-----|-------|-------|--------|-----------|");
  pages.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | ${p.url} | ${p.title} | ${p.forms.length} | ${p.tables.length} | ${p.apiCalls.length} |`
    );
  });
  lines.push("");

  // ERD summary
  lines.push("## Entity-Relationship Diagram");
  lines.push("");
  lines.push("```mermaid");
  lines.push("erDiagram");
  for (const entity of erd.entities) {
    lines.push(`    ${entity.name} {`);
    for (const field of entity.fields) {
      const pk = field.isPrimaryKey ? "PK" : "";
      const fk = field.isForeignKey ? "FK" : "";
      const tag = [pk, fk].filter(Boolean).join(",");
      const tagStr = tag ? ` "${tag}"` : "";
      lines.push(`        ${field.type.replace(/[^a-zA-Z0-9_]/g, "_")} ${field.name}${tagStr}`);
    }
    lines.push(`    }`);
  }
  for (const rel of erd.relationships) {
    lines.push(`    ${rel.from} ${mermaidCardinality(rel.type)} ${rel.to} : "${rel.throughField}"`);
  }
  lines.push("```");
  lines.push("");

  // Entity details
  lines.push("## Entities");
  lines.push("");
  for (const entity of erd.entities) {
    lines.push(`### ${entity.name}`);
    lines.push("");
    lines.push(`**Sources:** ${entity.sources.join(", ")}`);
    lines.push("");
    lines.push("| Field | Type | Required | PK | FK | References |");
    lines.push("|-------|------|----------|----|----|------------|");
    for (const field of entity.fields) {
      const ref = field.referencesEntity
        ? `${toPascalCase(field.referencesEntity)}.${field.referencesField ?? "id"}`
        : "";
      lines.push(
        `| ${field.name} | ${field.type} | ${field.required ? "Yes" : "No"} | ${field.isPrimaryKey ? "Yes" : ""} | ${field.isForeignKey ? "Yes" : ""} | ${ref} |`
      );
    }
    lines.push("");
  }

  // Relationships
  if (erd.relationships.length > 0) {
    lines.push("## Relationships");
    lines.push("");
    lines.push("| From | To | Type | Through |");
    lines.push("|------|----|------|---------|");
    for (const rel of erd.relationships) {
      lines.push(`| ${rel.from} | ${rel.to} | ${rel.type} | ${rel.throughField} |`);
    }
    lines.push("");
  }

  // Captured assets inventory
  lines.push("## Captured Assets");
  lines.push("");
  lines.push("All captured assets are stored in the output directory:");
  lines.push("");
  lines.push("- `screenshots/` — Full-page screenshots of every screen");
  lines.push("- `html/` — Raw HTML of every page");
  lines.push("- `css/` — Extracted CSS rules per page");
  lines.push("- `erd.json` — Structured ERD data (JSON)");
  lines.push("- `erd.mmd` — Mermaid diagram source");
  lines.push("- `schema.dbml` — DBML schema (import into dbdiagram.io)");
  lines.push("- `pages.json` — Page manifest with metadata");
  lines.push("");

  await fs.writeFile(path.join(outputDir, "REPORT.md"), lines.join("\n"), "utf-8");
}

function mermaidCardinality(type: Relationship["type"]): string {
  switch (type) {
    case "one-to-one":
      return "||--||";
    case "one-to-many":
      return "||--o{";
    case "many-to-many":
      return "}o--o{";
    default:
      return "||--o{";
  }
}

function dbmlType(type: string): string {
  if (type.includes("integer") || type.includes("int")) return "int";
  if (type.includes("decimal") || type.includes("float")) return "decimal";
  if (type.includes("boolean") || type.includes("bool")) return "bool";
  if (type.includes("datetime") || type.includes("date")) return "datetime";
  if (type.includes("text")) return "text";
  if (type.includes("json")) return "json";
  if (type.includes("enum")) return "varchar";
  if (type.includes("file")) return "varchar";
  return "varchar";
}

function toPascalCase(s: string): string {
  if (!s) return "";
  return s
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^./, (c) => c.toUpperCase());
}
