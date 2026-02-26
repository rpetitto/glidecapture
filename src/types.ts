/** A single discovered page/screen in the webapp */
export interface CapturedPage {
  /** URL of the page */
  url: string;
  /** Normalized path used as a dedup key (strips query params, trailing slash) */
  normalizedPath: string;
  /** Page title */
  title: string;
  /** Full-page screenshot as a PNG file path */
  screenshotPath: string;
  /** Raw outer HTML of the page */
  html: string;
  /** All CSS rules (inline + external stylesheets) */
  css: string;
  /** All JS source URLs discovered on the page */
  jsUrls: string[];
  /** Form fields found on the page */
  forms: FormCapture[];
  /** Data tables found on the page */
  tables: TableCapture[];
  /** Links discovered on this page (for crawl frontier) */
  discoveredLinks: string[];
  /** Interactive elements (buttons, dropdowns, modals triggers) */
  interactiveElements: InteractiveElement[];
  /** API calls observed via network interception */
  apiCalls: ApiCall[];
  /** Timestamp of capture */
  capturedAt: string;
}

export interface FormCapture {
  /** Form action URL */
  action: string;
  /** HTTP method */
  method: string;
  /** Fields inside the form */
  fields: FormField[];
}

export interface FormField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  options?: string[]; // for select/radio
}

export interface TableCapture {
  /** Column headers */
  headers: string[];
  /** Number of rows */
  rowCount: number;
  /** Sample rows (first 5) */
  sampleRows: string[][];
}

export interface InteractiveElement {
  tag: string;
  type: string;
  text: string;
  selector: string;
  ariaLabel?: string;
}

export interface ApiCall {
  url: string;
  method: string;
  requestBody?: string;
  responseStatus: number;
  responseBody?: string;
  contentType?: string;
}

/** An entity inferred from the captured data */
export interface Entity {
  name: string;
  fields: EntityField[];
  /** Where this entity was discovered */
  sources: string[];
}

export interface EntityField {
  name: string;
  type: string;
  required: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  referencesEntity?: string;
  referencesField?: string;
}

export interface Relationship {
  from: string;
  to: string;
  type: "one-to-one" | "one-to-many" | "many-to-many";
  throughField: string;
}

export interface ERDResult {
  entities: Entity[];
  relationships: Relationship[];
}

export interface CrawlConfig {
  /** Starting URL */
  startUrl: string;
  /** Max pages to crawl */
  maxPages: number;
  /** Max depth from start page */
  maxDepth: number;
  /** Output directory */
  outputDir: string;
  /** Whether to click buttons/tabs to discover dynamic content */
  clickInteractive: boolean;
  /** Domains to stay within (auto-derived from startUrl if empty) */
  allowedDomains: string[];
  /** Wait time (ms) after navigation for dynamic content */
  waitAfterNav: number;
  /** Viewport width */
  viewportWidth: number;
  /** Viewport height */
  viewportHeight: number;
  /** Whether to run in headless mode */
  headless: boolean;
  /** Optional login steps before crawling */
  login?: LoginConfig;
}

export interface LoginConfig {
  /** URL of the login page */
  loginUrl: string;
  /** CSS selector for the username/email field */
  usernameSelector: string;
  /** CSS selector for the password field */
  passwordSelector: string;
  /** CSS selector for the submit button */
  submitSelector: string;
  /** Username value */
  username: string;
  /** Password value */
  password: string;
  /** URL to wait for after login (confirms success) */
  successUrl?: string;
}

export interface CrawlState {
  /** Pages already visited */
  visited: Map<string, CapturedPage>;
  /** Frontier of URLs to visit: [url, depth] */
  frontier: [string, number][];
  /** Set of normalized URLs already seen */
  seen: Set<string>;
}
