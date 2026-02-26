import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  CrawlConfig,
  CrawlState,
  CapturedPage,
  InteractiveElement,
  ApiCall,
} from "./types.js";
import { capturePage } from "./capture.js";

/**
 * Normalize a URL for dedup — strips trailing slash, hash, sorts query params.
 */
export function normalizeUrl(raw: string, allowedDomains: string[]): string | null {
  try {
    const url = new URL(raw);
    // Filter out non-http(s) protocols
    if (!url.protocol.startsWith("http")) return null;
    // Filter out external domains
    if (
      allowedDomains.length > 0 &&
      !allowedDomains.some((d) => url.hostname === d || url.hostname.endsWith("." + d))
    ) {
      return null;
    }
    // Strip hash
    url.hash = "";
    // Sort query params for consistency
    url.searchParams.sort();
    // Strip trailing slash
    let normalized = url.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Main crawler — launches browser, manages crawl state, and orchestrates capture.
 */
export async function crawl(
  config: CrawlConfig,
  log: (msg: string) => void
): Promise<CapturedPage[]> {
  const browser: Browser = await chromium.launch({ headless: config.headless });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    ignoreHTTPSErrors: true,
  });

  const state: CrawlState = {
    visited: new Map(),
    frontier: [[config.startUrl, 0]],
    seen: new Set([normalizeUrl(config.startUrl, config.allowedDomains) ?? config.startUrl]),
  };

  try {
    // Handle optional login
    if (config.login) {
      log("Performing login...");
      const loginPage = await context.newPage();
      await performLogin(loginPage, config);
      await loginPage.close();
      log("Login successful.");
    }

    // BFS crawl
    while (state.frontier.length > 0 && state.visited.size < config.maxPages) {
      const [url, depth] = state.frontier.shift()!;
      if (depth > config.maxDepth) continue;

      const normalized = normalizeUrl(url, config.allowedDomains);
      if (!normalized) continue;
      if (state.visited.has(normalized)) continue;

      log(
        `[${state.visited.size + 1}/${config.maxPages}] Crawling (depth ${depth}): ${url}`
      );

      const page = await context.newPage();

      // Intercept API calls
      const apiCalls: ApiCall[] = [];
      page.on("response", async (response) => {
        const req = response.request();
        const resUrl = response.url();
        const contentType = response.headers()["content-type"] ?? "";
        // Capture XHR/fetch API calls (JSON endpoints)
        if (
          contentType.includes("application/json") &&
          !resUrl.includes(".js") &&
          req.resourceType() !== "script"
        ) {
          try {
            const body = await response.text().catch(() => "");
            apiCalls.push({
              url: resUrl,
              method: req.method(),
              requestBody: req.postData() ?? undefined,
              responseStatus: response.status(),
              responseBody: body.slice(0, 5000), // cap size
              contentType,
            });
          } catch {
            // ignore response read errors
          }
        }
      });

      try {
        await page.goto(url, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        // Extra wait for JS-heavy SPAs
        await page.waitForTimeout(config.waitAfterNav);

        // Capture the page
        const captured = await capturePage(page, url, config);
        captured.apiCalls = apiCalls;
        captured.normalizedPath = normalized;
        state.visited.set(normalized, captured);

        // Discover links from the page
        for (const link of captured.discoveredLinks) {
          const normLink = normalizeUrl(link, config.allowedDomains);
          if (normLink && !state.seen.has(normLink)) {
            state.seen.add(normLink);
            state.frontier.push([link, depth + 1]);
          }
        }

        // Optionally click interactive elements to discover more content
        if (config.clickInteractive && depth < config.maxDepth) {
          await discoverViaInteraction(page, state, config, depth, log);
        }
      } catch (err) {
        log(`  Error crawling ${url}: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return Array.from(state.visited.values());
}

/**
 * Click buttons, tabs, nav items to discover dynamically-loaded content and routes.
 */
async function discoverViaInteraction(
  page: Page,
  state: CrawlState,
  config: CrawlConfig,
  currentDepth: number,
  log: (msg: string) => void
): Promise<void> {
  // Find clickable elements that might reveal new screens
  const clickables: InteractiveElement[] = await page.evaluate(() => {
    const results: InteractiveElement[] = [];
    const selectors = [
      'button:not([disabled])',
      '[role="tab"]',
      '[role="button"]',
      'a[href^="#"]',
      '[data-toggle]',
      '[data-bs-toggle]',
      '.nav-link',
      '.tab',
      '.menu-item',
      '[onclick]',
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const htmlEl = el as HTMLElement;
        // Skip tiny/hidden elements
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        if (getComputedStyle(htmlEl).display === "none") continue;
        if (getComputedStyle(htmlEl).visibility === "hidden") continue;

        results.push({
          tag: htmlEl.tagName.toLowerCase(),
          type: htmlEl.getAttribute("type") ?? "",
          text: (htmlEl.textContent ?? "").trim().slice(0, 80),
          selector: buildSelector(htmlEl),
          ariaLabel: htmlEl.getAttribute("aria-label") ?? undefined,
        });
      }
    }
    return results.slice(0, 30); // cap to avoid runaway clicking

    function buildSelector(el: HTMLElement): string {
      if (el.id) return `#${el.id}`;
      const classes = Array.from(el.classList).slice(0, 3).join(".");
      const tag = el.tagName.toLowerCase();
      if (classes) return `${tag}.${classes}`;
      return tag;
    }
  });

  for (const el of clickables) {
    try {
      const beforeUrl = page.url();
      await page.click(el.selector, { timeout: 3000 });
      await page.waitForTimeout(1000);
      const afterUrl = page.url();

      // If navigation happened, capture the new URL
      if (afterUrl !== beforeUrl) {
        const normAfter = normalizeUrl(afterUrl, config.allowedDomains);
        if (normAfter && !state.seen.has(normAfter)) {
          log(`  Discovered via click: ${afterUrl}`);
          state.seen.add(normAfter);
          state.frontier.push([afterUrl, currentDepth + 1]);
        }
        // Go back to continue exploring
        await page.goBack({ waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {
      // click failed — element gone, overlay, etc. Move on.
    }
  }
}

/**
 * Perform login before crawling. Supports two flows:
 * - "password": email → password → submit
 * - "verification-code": email → submit → wait for user to provide code → submit
 */
async function performLogin(page: Page, config: CrawlConfig): Promise<void> {
  const login = config.login!;

  // Step 1: Navigate to login page and enter email
  await page.goto(login.loginUrl, { waitUntil: "networkidle", timeout: 30000 });

  // Try to find and fill the email field, waiting for it to be visible
  await page.waitForSelector(login.emailSelector, { state: "visible", timeout: 10000 });
  await page.fill(login.emailSelector, login.email);
  await page.click(login.emailSubmitSelector);

  // Wait for the page to react (next form step, redirect, etc.)
  await page.waitForTimeout(3000);

  if (login.flow === "password") {
    // Step 2a: Password flow — fill password and submit
    const passSel = login.passwordSelector ?? '[type=password]';
    await page.waitForSelector(passSel, { state: "visible", timeout: 10000 });
    await page.fill(passSel, login.password ?? "");
    const passSubmitSel = login.passwordSubmitSelector ?? login.emailSubmitSelector;
    await page.click(passSubmitSel);
  } else {
    // Step 2b: Verification code flow — prompt user and enter code
    if (!login.promptForCode) {
      throw new Error("Login flow is 'verification-code' but no promptForCode callback provided");
    }

    const code = await login.promptForCode();

    // Find the code input — try the configured selector, then common patterns
    const codeSel = login.codeSelector ?? 'input[name="code"], input[type="number"], input[autocomplete="one-time-code"], input[inputmode="numeric"]';
    await page.waitForSelector(codeSel, { state: "visible", timeout: 30000 });
    await page.fill(codeSel, code);

    const codeSubmitSel = login.codeSubmitSelector ?? login.emailSubmitSelector;
    await page.click(codeSubmitSel);
  }

  // Step 3: Wait for login to complete
  if (login.successUrl) {
    await page.waitForURL(login.successUrl, { timeout: 30000 });
  } else {
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    // Extra wait for SPAs that redirect client-side
    await page.waitForTimeout(2000);
  }
}
