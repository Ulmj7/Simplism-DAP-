/**
 * The trusted host loader for the approved product knowledge base (Feature 003, T308). All file reading and parsing happens HERE; `@dap/ai` only sees
 * validated plain data.
 *
 * It reads `*.md` files from ONE directory (not recursive, sorted by file name, regular files only: a symlink, a directory or anything resolving outside
 * the directory is refused), parses a tiny strict front matter by hand, validates every document with `parseKnowledgeDoc` / `parseKnowledgeSet`, and refuses
 * any document whose text the injected `scrub` function would change (an obvious secret pattern). Any invalid document FAILS STARTUP with a
 * `KnowledgeLoadError` that names only the file and a generic code, never document content. A document with a `tenantId` is refused: the knowledge base is
 * shared, and tenant filtering does not exist yet.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { chunkKnowledge, parseKnowledgeDoc } from "@dap/ai";
import type { KnowledgeChunk, KnowledgeDoc } from "@dap/ai";

export const MAX_KNOWLEDGE_FILES = 200;
export const MAX_KNOWLEDGE_FILE_BYTES = 64 * 1024;

export type KnowledgeLoadCode =
  | "directory_unreadable" | "too_many_files" | "symlink" | "not_a_regular_file" | "outside_directory" | "too_large" | "unreadable" | "invalid_encoding"
  | "bad_front_matter" | "duplicate_front_matter_key" | "unknown_front_matter_key" | "missing_front_matter_key" | "empty_body"
  | "invalid_document" | "tenant_scoped_document" | "duplicate_id" | "secret_pattern" | "secret_scan_failed";

/** Names the file (or `.` for the directory) and a generic code. Never document content. */
export class KnowledgeLoadError extends Error {
  readonly file: string;
  readonly code: KnowledgeLoadCode;
  constructor(file: string, code: KnowledgeLoadCode) {
    super(`Knowledge document refused: ${file}: ${code}`);
    this.name = "KnowledgeLoadError";
    this.file = file;
    this.code = code;
  }
}

export interface LoadedKnowledge {
  readonly docs: readonly KnowledgeDoc[];
  readonly chunks: readonly KnowledgeChunk[];
}

const REQUIRED = ["id", "title", "tags", "visibility"] as const;
const OPTIONAL = ["topic"] as const;

/**
 * The injected scrubber preserves the first 1024 clean characters, but detects secrets before truncating.
 * Scan complete suffixes so a long token is never cut before detection; compare only an uncapped,
 * overlapping 1000-character prefix. A truncation alone is not evidence of a secret.
 */
function changedByScrub(text: string, scrub: (text: string) => string): boolean {
  const WINDOW = 1000;
  const STEP = 500;
  for (let start = 0; start === 0 || start < text.length - STEP; start += STEP) {
    const part = text.slice(start);
    const clean = scrub(part);
    if (part.length <= WINDOW ? clean !== part : !clean.startsWith(part.slice(0, WINDOW))) return true;
  }
  return false;
}

function parseFrontMatter(text: string, file: string): { readonly meta: Readonly<Record<string, string>>; readonly body: string } {
  if (!text.startsWith("---\n")) throw new KnowledgeLoadError(file, "bad_front_matter");
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new KnowledgeLoadError(file, text.endsWith("\n---") ? "empty_body" : "bad_front_matter");
  const meta: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([A-Za-z]+):[ \t]*(.*)$/.exec(line);
    if (match === null) throw new KnowledgeLoadError(file, "bad_front_matter");
    const key = match[1]!;
    if (key === "tenantId") throw new KnowledgeLoadError(file, "tenant_scoped_document");
    if (!(REQUIRED as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key)) throw new KnowledgeLoadError(file, "unknown_front_matter_key");
    if (key in meta) throw new KnowledgeLoadError(file, "duplicate_front_matter_key");
    meta[key] = match[2]!.trim();
  }
  for (const key of REQUIRED) if (!(key in meta)) throw new KnowledgeLoadError(file, "missing_front_matter_key");
  const body = text.slice(end + 5).trim();
  if (body === "") throw new KnowledgeLoadError(file, "empty_body");
  return { meta, body };
}

export function loadKnowledge(options: { readonly dir: string; readonly scrub: (text: string) => string }): LoadedKnowledge {
  let base: string;
  let names: string[];
  try {
    base = realpathSync(options.dir);
    names = readdirSync(base).filter((name) => name.endsWith(".md"));
  } catch { throw new KnowledgeLoadError(".", "directory_unreadable"); }
  if (names.length > MAX_KNOWLEDGE_FILES) throw new KnowledgeLoadError(".", "too_many_files");
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const docs: KnowledgeDoc[] = [];
  const seen = new Map<string, string>();
  for (const file of names) {
    const path = join(base, file);
    let text: string;
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new KnowledgeLoadError(file, "symlink");
      if (!info.isFile()) throw new KnowledgeLoadError(file, "not_a_regular_file");
      if (info.size > MAX_KNOWLEDGE_FILE_BYTES) throw new KnowledgeLoadError(file, "too_large");
      if (!realpathSync(path).startsWith(base + sep)) throw new KnowledgeLoadError(file, "outside_directory");
      const bytes = readFileSync(path);
      if (bytes.length > MAX_KNOWLEDGE_FILE_BYTES) throw new KnowledgeLoadError(file, "too_large");
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n"); } catch { throw new KnowledgeLoadError(file, "invalid_encoding"); }
    } catch (error) {
      throw error instanceof KnowledgeLoadError ? error : new KnowledgeLoadError(file, "unreadable");
    }
    let changed: boolean;
    try { changed = changedByScrub(text, options.scrub); } catch { throw new KnowledgeLoadError(file, "secret_scan_failed"); }
    if (changed) throw new KnowledgeLoadError(file, "secret_pattern");
    const { meta, body } = parseFrontMatter(text, file);
    const parsed = parseKnowledgeDoc({
      id: meta.id, title: meta.title, content: body, tags: (meta.tags ?? "").split(",").map((tag) => tag.trim()), visibility: meta.visibility,
      ...(meta.topic === undefined ? {} : { topic: meta.topic }),
    });
    if (!parsed.ok) throw new KnowledgeLoadError(file, parsed.reason);
    if (seen.has(parsed.doc.id)) throw new KnowledgeLoadError(file, "duplicate_id");
    seen.set(parsed.doc.id, file);
    docs.push(parsed.doc);
  }
  return Object.freeze({ docs: Object.freeze(docs), chunks: Object.freeze(chunkKnowledge(docs)) });
}
