import type { Page } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import type {
  CapturedPage,
  CrawlConfig,
  FormCapture,
  FormField,
  TableCapture,
  InteractiveElement,
} from "./types.js";

/**
 * Capture everything about a single page: screenshot, HTML, CSS, JS, forms, tables.
 */
export async function capturePage(
  page: Page,
  url: string,
  config: CrawlConfig
): Promise<CapturedPage> {
  const title = await page.title();

  // Screenshot
  const slug = urlToSlug(url);
  const screenshotDir = path.join(config.outputDir, "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `${slug}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // HTML
  const html = await page.content();
  const htmlDir = path.join(config.outputDir, "html");
  await fs.mkdir(htmlDir, { recursive: true });
  await fs.writeFile(path.join(htmlDir, `${slug}.html`), html, "utf-8");

  // CSS — collect all stylesheets (inline + external)
  const css = await collectCSS(page);
  const cssDir = path.join(config.outputDir, "css");
  await fs.mkdir(cssDir, { recursive: true });
  await fs.writeFile(path.join(cssDir, `${slug}.css`), css, "utf-8");

  // JS source URLs
  const jsUrls = await collectJSUrls(page);

  // Forms
  const forms = await captureForms(page);

  // Tables
  const tables = await captureTables(page);

  // Interactive elements
  const interactiveElements = await captureInteractiveElements(page);

  // Links for crawl frontier
  const discoveredLinks = await discoverLinks(page);

  return {
    url,
    normalizedPath: "",
    title,
    screenshotPath,
    html,
    css,
    jsUrls,
    forms,
    tables,
    discoveredLinks,
    interactiveElements,
    apiCalls: [], // populated by caller via network interception
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Collect all CSS — inline <style> tags + external stylesheet contents.
 */
async function collectCSS(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];

    // Inline <style> tags
    for (const style of document.querySelectorAll("style")) {
      parts.push(`/* Inline <style> */\n${style.textContent}\n`);
    }

    // External stylesheets via CSSOM
    for (const sheet of document.styleSheets) {
      try {
        const href = sheet.href ?? "inline";
        const rules = Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join("\n");
        parts.push(`/* Stylesheet: ${href} */\n${rules}\n`);
      } catch {
        // Cross-origin stylesheet — can't read rules
        if (sheet.href) {
          parts.push(`/* External stylesheet (cross-origin, unreadable): ${sheet.href} */\n`);
        }
      }
    }

    return parts.join("\n");
  });
}

/**
 * Collect all JS script source URLs referenced by the page.
 */
async function collectJSUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const urls: string[] = [];
    for (const script of document.querySelectorAll("script[src]")) {
      const src = (script as HTMLScriptElement).src;
      if (src) urls.push(src);
    }
    return urls;
  });
}

/**
 * Capture all forms on the page with their fields.
 */
async function captureForms(page: Page): Promise<FormCapture[]> {
  return page.evaluate(() => {
    const forms: FormCapture[] = [];
    for (const form of document.querySelectorAll("form")) {
      const fields: FormField[] = [];
      const inputs = form.querySelectorAll("input, select, textarea");
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        const name =
          el.name ||
          el.id ||
          el.getAttribute("placeholder") ||
          el.getAttribute("aria-label") ||
          "";
        const type =
          el.tagName.toLowerCase() === "select"
            ? "select"
            : el.tagName.toLowerCase() === "textarea"
              ? "textarea"
              : el.type || "text";

        // Find label
        let label = "";
        if (el.id) {
          const labelEl = document.querySelector(`label[for="${el.id}"]`);
          if (labelEl) label = (labelEl.textContent ?? "").trim();
        }
        if (!label) {
          const closest = el.closest("label");
          if (closest) label = (closest.textContent ?? "").trim();
        }
        if (!label) label = el.getAttribute("placeholder") ?? "";

        // Options for selects
        let options: string[] | undefined;
        if (el.tagName.toLowerCase() === "select") {
          options = Array.from((el as unknown as HTMLSelectElement).options).map(
            (o) => o.textContent?.trim() ?? o.value
          );
        }

        fields.push({
          name,
          type,
          label,
          required: el.required ?? false,
          options,
        });
      }

      forms.push({
        action: form.action || "",
        method: (form.method || "GET").toUpperCase(),
        fields,
      });
    }
    return forms;
  });
}

/**
 * Capture data tables — headers, row count, sample rows.
 */
async function captureTables(page: Page): Promise<TableCapture[]> {
  return page.evaluate(() => {
    const tables: TableCapture[] = [];
    for (const table of document.querySelectorAll("table")) {
      const headers: string[] = [];
      for (const th of table.querySelectorAll("thead th, thead td, tr:first-child th")) {
        headers.push((th.textContent ?? "").trim());
      }

      const rows = table.querySelectorAll("tbody tr, tr");
      const sampleRows: string[][] = [];
      const rowCount = rows.length;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const cells: string[] = [];
        for (const td of rows[i].querySelectorAll("td, th")) {
          cells.push((td.textContent ?? "").trim());
        }
        if (cells.length > 0) sampleRows.push(cells);
      }

      if (headers.length > 0 || sampleRows.length > 0) {
        tables.push({ headers, rowCount, sampleRows });
      }
    }
    return tables;
  });
}

/**
 * Capture interactive elements — buttons, dropdowns, modals triggers.
 */
async function captureInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  return page.evaluate(() => {
    const results: InteractiveElement[] = [];
    const seen = new Set<string>();

    const selectors = [
      "button",
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      "a[href]",
      "select",
      '[data-toggle="modal"]',
      '[data-bs-toggle="modal"]',
      '[data-toggle="dropdown"]',
      '[data-bs-toggle="dropdown"]',
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const htmlEl = el as HTMLElement;
        const text = (htmlEl.textContent ?? "").trim().slice(0, 100);
        const key = `${htmlEl.tagName}-${text}-${htmlEl.getAttribute("href") ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let selector = "";
        if (htmlEl.id) selector = `#${htmlEl.id}`;
        else {
          const classes = Array.from(htmlEl.classList).slice(0, 3).join(".");
          selector = classes
            ? `${htmlEl.tagName.toLowerCase()}.${classes}`
            : htmlEl.tagName.toLowerCase();
        }

        results.push({
          tag: htmlEl.tagName.toLowerCase(),
          type: htmlEl.getAttribute("type") ?? "",
          text,
          selector,
          ariaLabel: htmlEl.getAttribute("aria-label") ?? undefined,
        });
      }
    }

    return results.slice(0, 100);
  });
}

/**
 * Discover all same-origin links on the page.
 */
async function discoverLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const links: string[] = [];
    const origin = window.location.origin;

    for (const a of document.querySelectorAll("a[href]")) {
      const href = (a as HTMLAnchorElement).href;
      if (href && href.startsWith(origin)) {
        links.push(href);
      }
    }

    // Also capture SPA-style routes from onclick handlers and router links
    for (const el of document.querySelectorAll("[href], [to], [routerlink]")) {
      const attr =
        el.getAttribute("href") ??
        el.getAttribute("to") ??
        el.getAttribute("routerlink");
      if (attr && attr.startsWith("/")) {
        links.push(new URL(attr, origin).href);
      }
    }

    return [...new Set(links)];
  });
}

/**
 * Convert a URL to a filesystem-safe slug.
 */
function urlToSlug(url: string): string {
  try {
    const parsed = new URL(url);
    const pathPart = parsed.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "_") || "index";
    const query = parsed.search ? "_" + parsed.search.slice(1).replace(/[&=]/g, "_") : "";
    return (pathPart + query).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  } catch {
    return "page_" + Date.now();
  }
}
