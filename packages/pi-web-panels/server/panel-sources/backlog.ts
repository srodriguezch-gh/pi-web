/**
 * Backlog panel source — "what is queued but not started".
 *
 * Sources (all real files, read per poll):
 *   1. `<plans>/task-board.md`           — `##` sections + open `- [ ]` items
 *   2. `<plans>/cac-llc-migration/BACKLOG.md` — same treatment
 *   3. `<plans>/queued/*.md`             — a doc whose own header says
 *      `Status: queued` IS backlog; that status string is surfaced verbatim.
 *
 * Honesty rules applied here:
 *  - Sections that are already finished ("✅ Done", "Verified Done", "Resolved",
 *    "History", "synthesis-only") and the "In Progress (live)" section are NOT
 *    counted as backlog: finished work must not be re-listed to look busy, and
 *    live work belongs to the in-progress panel. What was skipped is reported in
 *    `counts.excluded*` so the number can be audited instead of trusted.
 *  - A missing/unreadable file is reported in `sources[]` with its exact error,
 *    never silently dropped. If every source fails the envelope is `ok:false`.
 *  - `ageMs` is the age of the file's mtime (the only honest age a markdown
 *    list has) and `stale` means "this source has not been touched in >24h" —
 *    i.e. the board itself is going stale, which is worth seeing.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DAY_MS,
  HOUR_MS,
  PANEL_CACHE_TTL_MS,
  ageOf,
  asArray,
  asString,
  boundLine,
  fileMtimeMs,
  isRecord,
  nowIso,
  plansRoot,
  readPanel,
  readTextFile,
  urgencyForAgeMs,
  type PanelEnvelope,
  type PanelItemBase,
  type PanelSeverity,
} from "./cache";

export const BACKLOG_SOURCE = "backlog";

/** Source is considered stale when its file has not changed in this long. */
export const BACKLOG_SOURCE_STALE_MS = 24 * HOUR_MS;
/** Bound the payload: the board is a glance, not an export. */
export const BACKLOG_MAX_ITEMS = 60;

export interface BacklogItem extends PanelItemBase {
  kind: "checkbox" | "queued-file";
  /** Short label of the file this came from, e.g. "plans/task-board.md". */
  source: string;
  /** Absolute path actually read. */
  sourcePath: string;
  /** Verbatim `##` section heading (trimmed), null for a queued file. */
  section: string | null;
  /** 0 for a top-level checkbox; nested items are 1+ (2-space indent). */
  depth: number;
  /**
   * "open" for a markdown checkbox; for a queued file the VERBATIM value of its
   * own `Status:` header line (e.g. "queued — do NOT run while …").
   */
  statusLabel: string;
  /** Lower-cased first token of statusLabel ("queued", "open", …). */
  statusToken: string;
  /** 1-based line number in the source file (null for queued files). */
  line: number | null;
  /** Age-derived badge: >=24h urgent, >=4h warning. */
  severity: PanelSeverity;
  /** Documents what ageMs is measuring, so the UI cannot mislabel it. */
  ageBasis: "source-file-mtime";
}

export interface BacklogSourceStatus {
  path: string;
  ok: boolean;
  error: string | null;
  openItems: number;
  /** Open boxes deliberately not counted (finished sections / live section). */
  excludedItems: number;
  note: string | null;
}

export interface BacklogCounts {
  openItems: number;
  /** Open `- [ ]` boxes inside sections that are already finished. */
  excludedCompleted: number;
  /** Open `- [ ]` boxes inside the "In Progress (live)" section. */
  excludedInProgress: number;
  queuedFiles: number;
  filesRead: number;
  filesFailed: number;
}

export type BacklogEnvelope = PanelEnvelope<BacklogItem> & {
  sources: BacklogSourceStatus[];
  counts: BacklogCounts;
  /** Paths that failed this poll, with the exact error, for the header chip. */
  degraded: string[];
};

interface ParsedSection {
  heading: string | null;
  disposition: "open" | "completed" | "in-progress";
  items: { title: string; depth: number; line: number }[];
}

const COMPLETED_SECTION = /(✅|☑️)|verified done|\bdone\b|completed|resolved|history|archived|synthesis-only/i;
const IN_PROGRESS_SECTION = /in progress|🔄/i;

function classifySection(heading: string | null): ParsedSection["disposition"] {
  if (heading === null) return "open";
  if (IN_PROGRESS_SECTION.test(heading)) return "in-progress";
  if (COMPLETED_SECTION.test(heading)) return "completed";
  return "open";
}

const CHECKBOX = /^(\s*)[-*]\s\[ \]\s+(.*)$/;

/** Split a markdown file into `##` sections and their open checkboxes. */
export function parseMarkdownSections(text: string): ParsedSection[] {
  const sections: ParsedSection[] = [{ heading: null, disposition: "open", items: [] }];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && !/^###/.test(line)) {
      const title = heading[1].trim();
      sections.push({ heading: title, disposition: classifySection(title), items: [] });
      continue;
    }
    const box = CHECKBOX.exec(line);
    if (!box) continue;
    const indent = box[1].replace(/\t/g, "  ").length;
    const title = boundLine(box[2].replace(/\s+/g, " "), 240);
    if (title.length === 0) continue;
    sections[sections.length - 1].items.push({
      title,
      depth: Math.min(6, Math.floor(indent / 2)),
      line: index + 1,
    });
  }
  return sections;
}

const STATUS_LINE = /^\s*(?:\*\*)?Status(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i;

/** Extract the verbatim `Status:` header value from a queued doc, if any. */
export function parseStatusLine(text: string): string | null {
  const head = text.split(/\r?\n/).slice(0, 40);
  for (const line of head) {
    const match = STATUS_LINE.exec(line);
    if (match) {
      // Strip markdown emphasis and a trailing list separator, keep the words.
      const value = match[1].replace(/\*\*/g, "").replace(/\s+$/, "").trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

/** First `# ` heading of a doc — the human title of a queued work item. */
export function parseDocTitle(text: string, fallback: string): string {
  for (const line of text.split(/\r?\n/).slice(0, 20)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return boundLine(match[1].replace(/\*\*/g, ""), 140);
  }
  return fallback;
}

function readMarkdownSource(
  absPath: string,
  label: string,
  now: number,
): { status: BacklogSourceStatus; items: BacklogItem[]; excludedCompleted: number; excludedInProgress: number } {
  const { text, error } = readTextFile(absPath);
  const mtime = fileMtimeMs(absPath);
  if (text === null) {
    return {
      status: { path: label, ok: false, error, openItems: 0, excludedItems: 0, note: null },
      items: [],
      excludedCompleted: 0,
      excludedInProgress: 0,
    };
  }

  const sections = parseMarkdownSections(text);
  const items: BacklogItem[] = [];
  let excludedCompleted = 0;
  let excludedInProgress = 0;
  let openItems = 0;
  const ageMs = ageOf(now, mtime);

  for (const section of sections) {
    for (const box of section.items) {
      if (section.disposition === "completed") {
        excludedCompleted += 1;
        continue;
      }
      if (section.disposition === "in-progress") {
        excludedInProgress += 1;
        continue;
      }
      openItems += 1;
      items.push({
        id: `${label}:${box.line}`,
        title: box.title,
        ageMs,
        stale: ageMs !== null && ageMs > BACKLOG_SOURCE_STALE_MS,
        kind: "checkbox",
        source: label,
        sourcePath: absPath,
        section: section.heading,
        depth: box.depth,
        statusLabel: "open",
        statusToken: "open",
        line: box.line,
        severity: urgencyForAgeMs(ageMs),
        ageBasis: "source-file-mtime",
      });
    }
  }

  const note =
    mtime === null
      ? "file read but has no mtime"
      : `source last modified ${new Date(mtime).toISOString()}`;
  return {
    status: {
      path: label,
      ok: true,
      error: null,
      openItems,
      excludedItems: excludedCompleted + excludedInProgress,
      note,
    },
    items,
    excludedCompleted,
    excludedInProgress,
  };
}

interface QueuedReadResult {
  status: BacklogSourceStatus;
  items: BacklogItem[];
}

function readQueuedDir(root: string, now: number): QueuedReadResult[] {
  const dir = join(root, "queued");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith("."));
  } catch (error) {
    return [
      {
        status: {
          path: "plans/queued/",
          ok: false,
          error: describeDirError(error),
          openItems: 0,
          excludedItems: 0,
          note: null,
        },
        items: [],
      },
    ];
  }

  const results: QueuedReadResult[] = [];
  for (const name of names.sort()) {
    const absPath = join(dir, name);
    const label = `plans/queued/${name}`;
    const { text, error } = readTextFile(absPath);
    if (text === null) {
      results.push({
        status: { path: label, ok: false, error, openItems: 0, excludedItems: 0, note: null },
        items: [],
      });
      continue;
    }
    const statusLine = parseStatusLine(text);
    const token = (statusLine ?? "").split(/[\s,—–-]+/).filter(Boolean)[0]?.toLowerCase() ?? "";
    const mtime = fileMtimeMs(absPath);
    const ageMs = ageOf(now, mtime);

    if (token !== "queued") {
      // Present but not queued: report it instead of quietly counting it.
      results.push({
        status: {
          path: label,
          ok: true,
          error: null,
          openItems: 0,
          excludedItems: 0,
          note:
            statusLine === null
              ? "no Status: header — not counted as backlog"
              : `Status is "${statusLine}" — not counted as backlog`,
        },
        items: [],
      });
      continue;
    }

    results.push({
      status: {
        path: label,
        ok: true,
        error: null,
        openItems: 1,
        excludedItems: 0,
        note: `Status: ${statusLine}`,
      },
      items: [
        {
          id: `queued:${name}`,
          title: parseDocTitle(text, name),
          ageMs,
          stale: ageMs !== null && ageMs > BACKLOG_SOURCE_STALE_MS,
          kind: "queued-file",
          source: label,
          sourcePath: absPath,
          section: null,
          depth: 0,
          // Verbatim, including the "do NOT run while …" clause.
          statusLabel: statusLine as string,
          statusToken: token,
          line: null,
          severity: urgencyForAgeMs(ageMs),
          ageBasis: "source-file-mtime",
        },
      ],
      items_: undefined,
    } as QueuedReadResult);
  }
  return results;
}

function describeDirError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

const SOURCE_ORDER = ["task-board.md", "BACKLOG.md", "queued"];

function sourceRank(item: BacklogItem): number {
  if (item.kind === "queued-file") return 0;
  const index = SOURCE_ORDER.findIndex((token) => item.source.includes(token));
  return 10 + (index < 0 ? SOURCE_ORDER.length : index);
}

function sectionRank(item: BacklogItem): number {
  const heading = (item.section ?? "").toLowerCase();
  if (heading.includes("backlog")) return 0;
  if (heading.includes("follow-up")) return 1;
  if (heading.includes("scheduled")) return 2;
  return 3;
}

/**
 * Produce the backlog envelope. Pure-ish: only reads files under `<plans>`.
 * Throws only on something truly unexpected; `readPanel` converts that to an
 * `ok:false` envelope, so the route itself cannot fail.
 */
export async function readBacklogPanel(now: number): Promise<BacklogEnvelope> {
  const root = plansRoot();
  const sources: BacklogSourceStatus[] = [];
  const items: BacklogItem[] = [];
  let excludedCompleted = 0;
  let excludedInProgress = 0;
  let queuedFiles = 0;

  const board = readMarkdownSource(join(root, "task-board.md"), "plans/task-board.md", now);
  sources.push(board.status);
  items.push(...board.items);
  excludedCompleted += board.excludedCompleted;
  excludedInProgress += board.excludedInProgress;

  const migration = readMarkdownSource(
    join(root, "cac-llc-migration", "BACKLOG.md"),
    "plans/cac-llc-migration/BACKLOG.md",
    now,
  );
  sources.push(migration.status);
  items.push(...migration.items);
  excludedCompleted += migration.excludedCompleted;
  excludedInProgress += migration.excludedInProgress;

  for (const queued of readQueuedDir(root, now)) {
    sources.push(queued.status);
    items.push(...queued.items);
    queuedFiles += queued.items.length;
  }

  items.sort((a, b) => {
    const bySource = sourceRank(a) - sourceRank(b);
    if (bySource !== 0) return bySource;
    const bySection = sectionRank(a) - sectionRank(b);
    if (bySection !== 0) return bySection;
    const byFile = a.source.localeCompare(b.source);
    if (byFile !== 0) return byFile;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const degraded = sources.filter((entry) => !entry.ok).map((entry) => `${entry.path}: ${entry.error ?? "unknown error"}`);
  const counts: BacklogCounts = {
    openItems: items.length,
    excludedCompleted,
    excludedInProgress,
    queuedFiles,
    filesRead: sources.filter((entry) => entry.ok).length,
    filesFailed: sources.length - sources.filter((entry) => entry.ok).length,
  };

  // Every source failed: do not present an empty backlog as if it were real.
  if (counts.filesRead === 0) {
    return {
      source: BACKLOG_SOURCE,
      ok: false,
      error: degraded.join(" | "),
      fetchedAt: nowIso(now),
      cacheAgeMs: 0,
      stale: false,
      count: 0,
      items: [],
      lastGoodAt: null,
      lastGoodCount: null,
      sources,
      counts,
      degraded,
    };
  }

  const bounded = items.slice(0, BACKLOG_MAX_ITEMS);
  return {
    source: BACKLOG_SOURCE,
    ok: true,
    error: null,
    fetchedAt: nowIso(now),
    cacheAgeMs: 0,
    stale: false,
    count: bounded.length,
    items: bounded,
    lastGoodAt: null,
    lastGoodCount: null,
    sources,
    counts,
    degraded,
  };
}

/** Cached read used by `app/api/panels/backlog/route.ts`. */
export async function getBacklogPanel(): Promise<BacklogEnvelope> {
  return readPanel<BacklogItem>(BACKLOG_SOURCE, (now) => readBacklogPanel(now)) as Promise<BacklogEnvelope>;
}

/** Cache TTL re-exported so the UI can label "refreshed every Ns" honestly. */
export const BACKLOG_REFRESH_MS = PANEL_CACHE_TTL_MS;
export { DAY_MS };

// Keep unused-import lint quiet for helpers intentionally re-exported for tests.
void asArray;
void asString;
void isRecord;
