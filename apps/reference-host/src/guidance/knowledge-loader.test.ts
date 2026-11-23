import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubText } from "@dap/security";
import { KnowledgeLoadError, MAX_KNOWLEDGE_FILE_BYTES, loadKnowledge } from "./knowledge-loader.js";

const SHIPPED = fileURLToPath(new URL("../../knowledge", import.meta.url));
const front = (over: Record<string, string | null> = {}, body = "A short article body about the app.") => {
  const meta: Record<string, string | null> = { id: "an-article", title: "An article", tags: "one, two", topic: "demo", visibility: "public", ...over };
  const lines = Object.entries(meta).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "knowledge-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
const load = () => loadKnowledge({ dir, scrub: scrubText });
const refusal = (): { file: string; code: string; message: string } => {
  try { load(); } catch (error) { if (error instanceof KnowledgeLoadError) return { file: error.file, code: error.code, message: error.message }; throw error; }
  throw new Error("expected a refusal");
};

describe("the shipped knowledge base", () => {
  it("loads, validates and chunks, with at most 6 documents on clearly different topics", () => {
    const loaded = loadKnowledge({ dir: SHIPPED, scrub: scrubText });
    expect(loaded.docs.length).toBeGreaterThanOrEqual(5);
    expect(loaded.docs.length).toBeLessThanOrEqual(6);
    const ids = loaded.docs.map((d) => d.id);
    expect(ids).toEqual([...ids].sort());
    const topics = loaded.docs.map((d) => d.topic);
    expect(topics.every((t) => t !== undefined)).toBe(true);
    expect(new Set(topics).size).toBeGreaterThanOrEqual(4); // clearly different topics, so ranking tests mean something
    for (const doc of loaded.docs) expect(doc.visibility).toBe("public");
    expect(loaded.chunks.length).toBeGreaterThanOrEqual(loaded.docs.length);
    for (const chunk of loaded.chunks) expect(chunk.text.length).toBeLessThanOrEqual(800);
    expect(loaded.docs.map((d) => d.id)).toContain("two-factor-authentication");
  });
  it("the two-factor article answers the question and is honest that the demo control is a placeholder", () => {
    const doc = loadKnowledge({ dir: SHIPPED, scrub: scrubText }).docs.find((d) => d.id === "two-factor-authentication")!;
    expect(doc.content).toMatch(/second/i);
    expect(doc.content).toMatch(/placeholder/i);
    expect(doc.content).toMatch(/Advanced/);
  });
  it("contains no URL, address, key-like token or personal data", () => {
    for (const doc of loadKnowledge({ dir: SHIPPED, scrub: scrubText }).docs) {
      expect(`${doc.title} ${doc.content}`).not.toMatch(/https?:|www\.|@[a-z0-9-]+\.[a-z]|sk-[A-Za-z0-9]|\b\d{3}[- ]\d{3}[- ]\d{4}\b/i);
    }
  });
  it("loading twice gives identical results (sorted by file name)", () => {
    expect(JSON.stringify(loadKnowledge({ dir: SHIPPED, scrub: scrubText }))).toBe(JSON.stringify(loadKnowledge({ dir: SHIPPED, scrub: scrubText })));
  });
});

describe("a valid directory", () => {
  it("loads documents in file-name order, ignores non-.md files and does not recurse", () => {
    write("b-second.md", front({ id: "second" }));
    write("a-first.md", front({ id: "first" }));
    write("notes.txt", "not a document");
    mkdirSync(join(dir, "nested"));
    write("nested/hidden.md", front({ id: "hidden" }));
    const loaded = load();
    expect(loaded.docs.map((d) => d.id)).toEqual(["first", "second"]);
    expect(loaded.chunks.map((c) => c.id)).toEqual(["first.1", "second.1"]);
    expect(loaded.docs[0]).toMatchObject({ title: "An article", tags: ["one", "two"], topic: "demo", visibility: "public" });
  });
  it("the topic is optional, CRLF line endings are accepted, and a long body is chunked without loss", () => {
    write("a.md", front({ topic: null }).replace(/\n/g, "\r\n"));
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"words ".repeat(25)}`).join("\n\n");
    write("b.md", front({ id: "long-one" }, long));
    const loaded = load();
    expect(loaded.docs[0]!.topic).toBeUndefined();
    expect(loaded.chunks.filter((c) => c.docId === "long-one").length).toBeGreaterThan(2);
  });
  it("an empty directory loads as an empty knowledge base", () => {
    expect(load()).toEqual({ docs: [], chunks: [] });
  });
});

describe("every refusal fails startup naming only the file and a generic code", () => {
  it.each([
    ["no front matter", "just text", "bad_front_matter"],
    ["an unterminated front matter", "---\nid: a-doc\ntitle: T\n", "bad_front_matter"],
    ["a malformed front matter line", front().replace("title: An article", "title An article"), "bad_front_matter"],
    ["a blank line inside the front matter", front().replace("id: an-article", "id: an-article\n"), "bad_front_matter"],
    ["a duplicate key", front().replace("tags: one, two", "tags: one, two\nid: another"), "duplicate_front_matter_key"],
    ["an unknown key", front().replace("topic: demo", "topic: demo\nauthor: me"), "unknown_front_matter_key"],
    ["a url key", front().replace("topic: demo", "topic: demo\nurl: x"), "unknown_front_matter_key"],
    ["a missing required key", front({ title: null }), "missing_front_matter_key"],
    ["a missing visibility", front({ visibility: null }), "missing_front_matter_key"],
    ["a tenantId", front().replace("topic: demo", "topic: demo\ntenantId: tenant-a"), "tenant_scoped_document"],
    ["an empty body", "---\nid: a-doc\ntitle: T\ntags: x\nvisibility: public\n---\n\n  \n", "empty_body"],
    ["a malformed id", front({ id: "Bad Id" }), "invalid_document"],
    ["a private visibility", front({ visibility: "private" }), "invalid_document"],
    ["an empty tag", front({ tags: "a,,b" }), "invalid_document"],
    ["an empty tag list", front({ tags: "" }), "invalid_document"],
    ["a title with markup", front({ title: "<b>Bold</b>" }), "invalid_document"],
    ["a secret-shaped key in the body", front({}, "Use the key sk-abcdefghijklmnopqrstuvwx to sign in."), "secret_pattern"],
    ["a JWT-shaped token in the title", front({ title: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop" }), "secret_pattern"],
  ])("%s", (_name, text, code) => {
    write("doc.md", text);
    const r = refusal();
    expect(r).toMatchObject({ file: "doc.md", code });
    expect(r.message).toBe(`Knowledge document refused: doc.md: ${code}`);
  });
  it("a secret deep inside a long document is found (checked in overlapping windows, not truncated away)", () => {
    for (const offset of [990, 1500, 3000]) {
      const body = `${"filler ".repeat(Math.ceil(offset / 7))}`.slice(0, offset) + " sk-abcdefghijklmnopqrstuvwx " + "tail ".repeat(100);
      write("doc.md", front({}, body));
      expect(refusal().code, String(offset)).toBe("secret_pattern");
    }
  });
  it("does not split a long JWT before secret detection", () => {
    const token = `eyJhbGciOiJIUzI1NiJ9.${"Z".repeat(1500)}.${"Q".repeat(43)}`;
    expect(scrubText(token)).toBe("[redacted][truncated]"); // the injected scanner recognises the complete token
    for (const offset of [0, 990, 1500]) {
      write("doc.md", front({}, `${"word ".repeat(offset / 5)}${token}`));
      expect(refusal(), String(offset)).toMatchObject({ file: "doc.md", code: "secret_pattern" });
    }
  });
  it("a long document with no secret is accepted (the scrubber's own 1024-character cap is not mistaken for a secret)", () => {
    write("doc.md", front({}, "plain words here ".repeat(400)));
    expect(load().docs).toHaveLength(1);
  });
  it("a duplicate id across files names the later file", () => {
    write("a.md", front());
    write("b.md", front());
    expect(refusal()).toMatchObject({ file: "b.md", code: "duplicate_id" });
  });
  it("a symlink is refused, whatever it points at", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "real.md"), front({ id: "outside" }));
    symlinkSync(join(outside, "real.md"), join(dir, "link.md"));
    expect(refusal()).toMatchObject({ file: "link.md", code: "symlink" });
    rmSync(outside, { recursive: true, force: true });
  });
  it("a directory named like a document is refused", () => {
    mkdirSync(join(dir, "folder.md"));
    expect(refusal()).toMatchObject({ file: "folder.md", code: "not_a_regular_file" });
  });
  it("a file over 64 KiB is refused", () => {
    write("big.md", front({}, "x ".repeat(MAX_KNOWLEDGE_FILE_BYTES)));
    expect(refusal()).toMatchObject({ file: "big.md", code: "too_large" });
  });
  it("invalid UTF-8 is refused", () => {
    writeFileSync(join(dir, "bad.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]));
    expect(refusal()).toMatchObject({ file: "bad.md", code: "invalid_encoding" });
  });
  it("a missing directory fails startup, naming no path", () => {
    expect(() => loadKnowledge({ dir: join(dir, "nope"), scrub: scrubText })).toThrow(/^Knowledge document refused: \.: directory_unreadable$/);
  });
  it("more than 200 files is refused", () => {
    for (let i = 0; i < 201; i++) write(`d${String(i).padStart(3, "0")}.md`, "x");
    expect(refusal()).toMatchObject({ file: ".", code: "too_many_files" });
  });
  it("a scrub function that throws fails startup safely", () => {
    write("a.md", front());
    expect(() => loadKnowledge({ dir, scrub: () => { throw new Error("secret-detail"); } })).toThrow(/secret_scan_failed$/);
  });
  it("an error never carries document content, in its message or its fields", () => {
    write("doc.md", front({}, "Use the key sk-abcdefghijklmnopqrstuvwx now."));
    try { load(); } catch (error) { expect(JSON.stringify(error)).not.toContain("abcdefghijkl"); expect((error as Error).message).not.toContain("abcdefghijkl"); expect((error as Error).stack ?? "").not.toContain("abcdefghijkl"); }
  });
});
