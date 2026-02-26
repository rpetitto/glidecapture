#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "node:path";
import readline from "node:readline";
import type { CrawlConfig } from "./types.js";
import { crawl } from "./crawler.js";
import { analyzeERD } from "./erd-analyzer.js";
import { generateReports } from "./report.js";

/**
 * Prompt the user for input on stdin. Used to collect a verification code mid-login.
 */
function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

program
  .name("glidecapture")
  .description(
    "AI agent that systematically browses a webapp, captures screenshots/HTML/CSS/JS, and generates an ERD"
  )
  .version("1.0.0")
  .argument("<url>", "Starting URL of the webapp to capture")
  .option("-o, --output <dir>", "Output directory", "./output")
  .option("-m, --max-pages <n>", "Maximum pages to crawl", "50")
  .option("-d, --max-depth <n>", "Maximum crawl depth from start page", "5")
  .option("-w, --wait <ms>", "Extra wait time (ms) after each navigation", "2000")
  .option("--width <px>", "Viewport width", "1440")
  .option("--height <px>", "Viewport height", "900")
  .option("--no-click", "Disable clicking interactive elements to discover content")
  .option("--headed", "Run browser in headed (visible) mode")
  .option("--login-url <url>", "Login page URL")
  .option("--login-flow <type>", "Login flow type: password or verification-code", "verification-code")
  .option("--login-email <email>", "Login email address")
  .option("--login-email-selector <sel>", "CSS selector for the email input", '#email, [name=email], [type=email], #username, [name=username]')
  .option("--login-email-submit-selector <sel>", "CSS selector for the submit button after email entry", '[type=submit], button[type=submit], form button')
  .option("--login-password <pass>", "Login password (password flow only)")
  .option("--login-pass-selector <sel>", "CSS selector for password field (password flow)", '[type=password], #password, [name=password]')
  .option("--login-pass-submit-selector <sel>", "CSS selector for submit after password")
  .option("--login-code-selector <sel>", "CSS selector for the verification code input")
  .option("--login-code-submit-selector <sel>", "CSS selector for submit after entering code")
  .option("--login-success-url <url>", "URL that confirms successful login")
  .action(async (startUrl: string, opts) => {
    console.log(chalk.bold("\n  GlideCapture"));
    console.log(chalk.dim("  Webapp reverse-engineering agent\n"));

    const outputDir = path.resolve(opts.output);

    // Derive allowed domains from the start URL
    let allowedDomains: string[] = [];
    try {
      allowedDomains = [new URL(startUrl).hostname];
    } catch {
      console.error(chalk.red("Invalid start URL"));
      process.exit(1);
    }

    // Build login config if provided
    let login: CrawlConfig["login"];
    if (opts.loginUrl && opts.loginEmail) {
      const flow = opts.loginFlow === "password" ? "password" as const : "verification-code" as const;
      login = {
        flow,
        loginUrl: opts.loginUrl,
        email: opts.loginEmail,
        emailSelector: opts.loginEmailSelector,
        emailSubmitSelector: opts.loginEmailSubmitSelector,
        // Password flow
        password: opts.loginPassword,
        passwordSelector: opts.loginPassSelector,
        passwordSubmitSelector: opts.loginPassSubmitSelector,
        // Verification code flow
        codeSelector: opts.loginCodeSelector,
        codeSubmitSelector: opts.loginCodeSubmitSelector,
        successUrl: opts.loginSuccessUrl,
        // Interactive prompt for verification code
        promptForCode: flow === "verification-code"
          ? () => promptUser(chalk.yellow("\n  >> A verification code was sent to your email.\n  >> Enter the code: "))
          : undefined,
      };

      if (flow === "password" && !opts.loginPassword) {
        console.error(chalk.red("  --login-password is required for password login flow"));
        process.exit(1);
      }
    }

    const config: CrawlConfig = {
      startUrl,
      maxPages: parseInt(opts.maxPages, 10),
      maxDepth: parseInt(opts.maxDepth, 10),
      outputDir,
      clickInteractive: opts.click !== false,
      allowedDomains,
      waitAfterNav: parseInt(opts.wait, 10),
      viewportWidth: parseInt(opts.width, 10),
      viewportHeight: parseInt(opts.height, 10),
      headless: !opts.headed,
      login,
    };

    console.log(chalk.cyan("  Config:"));
    console.log(chalk.dim(`    Start URL:     ${config.startUrl}`));
    console.log(chalk.dim(`    Max pages:     ${config.maxPages}`));
    console.log(chalk.dim(`    Max depth:     ${config.maxDepth}`));
    console.log(chalk.dim(`    Output:        ${config.outputDir}`));
    console.log(chalk.dim(`    Click explore: ${config.clickInteractive}`));
    console.log(chalk.dim(`    Headless:      ${config.headless}`));
    if (login) {
      console.log(chalk.dim(`    Login:         ${login.loginUrl}`));
      console.log(chalk.dim(`    Login flow:    ${login.flow}`));
      console.log(chalk.dim(`    Login email:   ${login.email}`));
    }
    console.log();

    // Phase 1: Crawl
    const spinCrawl = ora("Crawling webapp...").start();
    let pages;
    try {
      pages = await crawl(config, (msg) => {
        spinCrawl.text = msg;
      });
      spinCrawl.succeed(`Crawled ${pages.length} pages`);
    } catch (err) {
      spinCrawl.fail(`Crawl failed: ${(err as Error).message}`);
      process.exit(1);
    }

    if (pages.length === 0) {
      console.log(chalk.yellow("  No pages captured. Check the URL and try again."));
      process.exit(0);
    }

    // Phase 2: Analyze ERD
    const spinERD = ora("Analyzing captured data for entities and relationships...").start();
    const erd = analyzeERD(pages);
    spinERD.succeed(
      `Discovered ${erd.entities.length} entities and ${erd.relationships.length} relationships`
    );

    // Phase 3: Generate reports
    const spinReport = ora("Generating reports...").start();
    await generateReports(pages, erd, outputDir);
    spinReport.succeed("Reports generated");

    // Summary
    console.log(chalk.bold("\n  Results:"));
    console.log(chalk.green(`    Pages captured:    ${pages.length}`));
    console.log(chalk.green(`    Entities found:    ${erd.entities.length}`));
    console.log(chalk.green(`    Relationships:     ${erd.relationships.length}`));
    console.log(chalk.green(`    Forms captured:    ${pages.reduce((s, p) => s + p.forms.length, 0)}`));
    console.log(chalk.green(`    Tables captured:   ${pages.reduce((s, p) => s + p.tables.length, 0)}`));
    console.log(chalk.green(`    API calls logged:  ${pages.reduce((s, p) => s + p.apiCalls.length, 0)}`));
    console.log();
    console.log(chalk.cyan(`  Output directory: ${outputDir}`));
    console.log(chalk.dim(`    REPORT.md        — Full summary with embedded ERD`));
    console.log(chalk.dim(`    erd.mmd          — Mermaid diagram (paste into mermaid.live)`));
    console.log(chalk.dim(`    erd.json         — Structured ERD data`));
    console.log(chalk.dim(`    schema.dbml      — DBML schema (import into dbdiagram.io)`));
    console.log(chalk.dim(`    pages.json       — Page manifest`));
    console.log(chalk.dim(`    screenshots/     — Full-page screenshots`));
    console.log(chalk.dim(`    html/            — Raw HTML per page`));
    console.log(chalk.dim(`    css/             — Extracted CSS per page`));
    console.log();
  });

program.parse();
