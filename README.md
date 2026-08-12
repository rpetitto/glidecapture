# GlideCapture

AI agent that systematically browses a webapp — every screen and button — takes screenshots, captures HTML/CSS/JS, and determines an Entity-Relationship Diagram (ERD) you can take to another builder to clone the app.

## How It Works

1. **Crawl** — Playwright-based browser agent performs a BFS crawl starting from your URL. It follows all same-domain links, clicks buttons/tabs/nav items to discover dynamic content, and intercepts API calls.

2. **Capture** — For every page/screen discovered:
   - Full-page screenshot (PNG)
   - Raw HTML
   - All CSS rules (inline + external stylesheets)
   - JS source URLs
   - Form fields with types, labels, validation
   - Data tables with headers and sample rows
   - Interactive elements (buttons, dropdowns, modal triggers)
   - API calls with request/response bodies

3. **Analyze** — Infers an ERD from the captured data:
   - Entities from forms (each form → entity with fields)
   - Entities from data tables (column headers → fields, sample data → types)
   - Entities from JSON API responses (object keys → fields)
   - Relationships from foreign-key patterns (`user_id` → `User`)
   - Junction table detection for many-to-many relationships

4. **Report** — Generates output in multiple formats:
   - `REPORT.md` — Full Markdown summary with embedded Mermaid ERD
   - `erd.mmd` — Mermaid diagram source (paste into [mermaid.live](https://mermaid.live))
   - `erd.json` — Structured ERD data for programmatic use
   - `schema.dbml` — DBML schema (import into [dbdiagram.io](https://dbdiagram.io))
   - `pages.json` — Page manifest with metadata

## Install

```bash
npm install
npx playwright install chromium
```

### Glide MCP server (optional)

`.mcp.json` registers the Glide MCP server for this project, so Claude Code can
build a Glide app directly from the captured schema. Claude Code will prompt to
approve the server the first time you open the repo; then run `/mcp` and select
`glide` to authorize it. Each person who clones the repo authorizes separately.

## Usage

```bash
# Basic — crawl a public webapp
npx tsx src/index.ts https://example.com

# With options
npx tsx src/index.ts https://myapp.com \
  --max-pages 100 \
  --max-depth 8 \
  --output ./my-capture \
  --headed

# With login — verification code (email + OTP)
# The CLI will pause and prompt you to enter the code
npx tsx src/index.ts https://myapp.com/dashboard \
  --login-url https://myapp.com/login \
  --login-email admin@example.com \
  --headed

# With login — password flow
npx tsx src/index.ts https://myapp.com/dashboard \
  --login-url https://myapp.com/login \
  --login-flow password \
  --login-email admin@example.com \
  --login-password secret123 \
  --login-success-url https://myapp.com/dashboard
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output <dir>` | `./output` | Output directory |
| `-m, --max-pages <n>` | `50` | Maximum pages to crawl |
| `-d, --max-depth <n>` | `5` | Maximum link depth from start page |
| `-w, --wait <ms>` | `2000` | Extra wait after each navigation (for SPAs) |
| `--width <px>` | `1440` | Browser viewport width |
| `--height <px>` | `900` | Browser viewport height |
| `--no-click` | — | Skip clicking buttons/tabs to discover dynamic content |
| `--headed` | — | Show the browser window |
| `--login-url` | — | Login page URL |
| `--login-flow` | `verification-code` | Login flow: `verification-code` or `password` |
| `--login-email` | — | Login email address |
| `--login-email-selector` | auto | CSS selector for email input |
| `--login-email-submit-selector` | auto | CSS selector for submit after email |
| `--login-password` | — | Password (password flow only) |
| `--login-pass-selector` | auto | CSS selector for password input |
| `--login-pass-submit-selector` | — | CSS selector for submit after password |
| `--login-code-selector` | auto | CSS selector for verification code input |
| `--login-code-submit-selector` | — | CSS selector for submit after code |
| `--login-success-url` | — | URL to confirm login success |

## Output Structure

```
output/
├── REPORT.md          # Human-readable summary with ERD
├── erd.mmd            # Mermaid diagram source
├── erd.json           # Structured ERD (JSON)
├── schema.dbml        # DBML schema for dbdiagram.io
├── pages.json         # Page manifest
├── screenshots/       # Full-page PNGs
│   ├── index.png
│   ├── dashboard.png
│   └── ...
├── html/              # Raw HTML per page
│   ├── index.html
│   └── ...
└── css/               # Extracted CSS per page
    ├── index.css
    └── ...
```

## Taking Results to a Builder

The output is designed to give a builder everything they need:

1. **Schema** — Import `schema.dbml` into [dbdiagram.io](https://dbdiagram.io) to visualize and refine the database schema
2. **ERD** — Open `erd.mmd` in [mermaid.live](https://mermaid.live) for an interactive entity diagram
3. **Screenshots** — Visual reference for every screen in the app
4. **HTML/CSS** — Exact markup and styling to replicate the UI
5. **API patterns** — `erd.json` contains captured API endpoints showing the data flow
6. **REPORT.md** — Hand this to a developer as a complete spec
