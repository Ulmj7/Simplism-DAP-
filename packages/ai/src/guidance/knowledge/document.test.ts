import { describe, expect, it } from "vitest";
import { chunkDocument, chunkKnowledge, parseKnowledgeDoc, parseKnowledgeSet } from "./document.js";
import { parseGuidanceModelRequest } from "../request.js";

const doc = (over: Record<string, unknown> = {}) => ({ id: "profile-name", title: "Update your name", content: "Open Profile.\n\nType a name and press Save.", tags: ["profile", "name"], topic: "profile", visibility: "public", ...over });
const parse = (raw: unknown) => { const r = parseKnowledgeDoc(raw); return r.ok ? "ok" : r.reason; };

describe("a valid document", () => {
  it("is accepted as a frozen copy", () => {
    const r = parseKnowledgeDoc(doc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toEqual(doc());
    expect(Object.isFrozen(r.doc)).toBe(true);
    expect(Object.isFrozen(r.doc.tags)).toBe(true);
  });
  it("the topic is optional; content may hold quotes, markup characters, tabs and line breaks", () => {
    const withoutTopic: Record<string, unknown> = doc();
    delete withoutTopic.topic;
    expect(parse(withoutTopic)).toBe("ok");
    expect(parse(doc({ content: "Press \"Save\" & <wait>.\n\tIt's done." }))).toBe("ok");
  });
  it("accepts the boundaries: 48-character id, 80-character title, 20000 characters, 8 tags, a 64-character topic", () => {
    expect(parse(doc({ id: "a" + "b".repeat(47), title: "t".repeat(80), content: "c".repeat(20_000), tags: Array.from({ length: 8 }, (_, i) => `t${i}`), topic: "p".repeat(64) }))).toBe("ok");
  });
});

describe("every refusal (no value is echoed)", () => {
  it.each([
    ["a malformed id (uppercase)", { id: "Profile" }], ["an id with a space", { id: "my doc" }], ["an id with a dot", { id: "a.b" }], ["an id of 49 characters", { id: "a" + "b".repeat(48) }],
    ["an empty id", { id: "" }], ["a reserved id", { id: "constructor" }], ["a prototype id", { id: "__proto__" }], ["a non-string id", { id: 5 }],
    ["an empty title", { title: "" }], ["a blank title", { title: "  " }], ["a title with markup", { title: "<b>x</b>" }], ["a title over 80", { title: "t".repeat(81) }],
    ["empty content", { content: "" }], ["blank content", { content: " \n\t " }], ["content over 20000", { content: "c".repeat(20_001) }],
    ["a control character in content", { content: `a${String.fromCharCode(7)}b` }], ["a bidi override in content", { content: `a${String.fromCharCode(0x202e)}b` }],
    ["9 tags", { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }], ["an uppercase tag", { tags: ["Profile"] }], ["a tag with a space", { tags: ["a b"] }], ["a tag over 32", { tags: ["t".repeat(33)] }], ["tags that is not an array", { tags: "profile" }],
    ["a topic over 64", { topic: "p".repeat(65) }], ["a topic with markup", { topic: "<x>" }],
    ["private visibility", { visibility: "private" }], ["tenant visibility", { visibility: "tenant" }], ["a missing visibility", { visibility: undefined }],
    ["an unexpected field", { author: "x" }], ["a url field", { url: "https://x" }], ["a prototype key", JSON.parse('{"__proto__":{"x":1}}')],
  ])("%s", (_name, patch) => {
    const raw = { ...doc(), ...patch };
    if ((patch as { visibility?: unknown }).visibility === undefined && "visibility" in patch) delete (raw as Record<string, unknown>).visibility;
    expect(parse(raw)).not.toBe("ok");
  });
  it("a tenantId is refused explicitly, whatever its value", () => {
    for (const tenantId of ["tenant-a", "", 5, null, "00000000-0000-4000-8000-000000000001"]) expect(parse(doc({ tenantId }))).toBe("tenant_scoped_document");
  });
  it.each([null, undefined, "doc", 5, [], [doc()], () => doc()])("a non-object (%s)", (raw) => {
    expect(parse(raw)).toBe("invalid_document");
  });
  it("hostile values are refused without throwing: getters, proxies, classes", () => {
    let calls = 0;
    expect(parse({ ...doc(), get title() { calls++; return "x"; } })).toBe("invalid_document");
    expect(calls).toBe(0);
    expect(parse(new Proxy({}, { ownKeys() { throw new Error("boom"); } }))).toBe("invalid_document");
    expect(parse(new (class D { id = "a"; })())).toBe("invalid_document");
  });
  it("never echoes the offending value", () => {
    expect(JSON.stringify(parseKnowledgeDoc(doc({ content: "SECRET-CONTENT".repeat(5000) })))).not.toContain("SECRET");
  });
});

describe("a knowledge set", () => {
  it("accepts distinct documents and returns them in order", () => {
    const r = parseKnowledgeSet([doc({ id: "a-doc" }), doc({ id: "b-doc" })]);
    expect(r.ok && r.docs.map((d) => d.id)).toEqual(["a-doc", "b-doc"]);
  });
  it("refuses duplicate ids, a bad document, a tenant-scoped document, more than 200 documents and a non-array", () => {
    expect(parseKnowledgeSet([doc({ id: "a-doc" }), doc({ id: "a-doc" })])).toEqual({ ok: false, reason: "duplicate_id" });
    expect(parseKnowledgeSet([doc(), doc({ id: "B" })])).toEqual({ ok: false, reason: "invalid_document" });
    expect(parseKnowledgeSet([doc(), doc({ id: "other", tenantId: "t" })])).toEqual({ ok: false, reason: "tenant_scoped_document" });
    expect(parseKnowledgeSet(Array.from({ length: 201 }, (_, i) => doc({ id: `doc-${i}` })))).toEqual({ ok: false, reason: "too_many_documents" });
    expect(parseKnowledgeSet(Array.from({ length: 200 }, (_, i) => doc({ id: `doc-${i}` }))).ok).toBe(true);
    expect(parseKnowledgeSet("docs" as never)).toEqual({ ok: false, reason: "invalid_document" });
    expect(parseKnowledgeSet(new Array(2))).toEqual({ ok: false, reason: "invalid_document" });
    expect(parseKnowledgeSet([])).toEqual({ ok: true, docs: [] });
  });
});

const make = (content: string) => { const r = parseKnowledgeDoc(doc({ content })); if (!r.ok) throw new Error("fixture"); return r.doc; };

describe("chunking", () => {
  it("splits on blank lines, merges to at most 800 characters, and keeps the doc id, title and tags", () => {
    const chunks = chunkDocument(make("First paragraph.\n\nSecond paragraph."));
    expect(chunks).toEqual([{ id: "profile-name.1", docId: "profile-name", title: "Update your name", text: "First paragraph. Second paragraph.", tags: ["profile", "name"] }]);
    const big = chunkDocument(make(`${"a ".repeat(300).trim()}\n\n${"b ".repeat(300).trim()}`)); // two 599-character paragraphs
    expect(big.map((c) => c.id)).toEqual(["profile-name.1", "profile-name.2"]);
    expect(big[0]!.text.startsWith("a a")).toBe(true);
    expect(big[1]!.text.startsWith("b b")).toBe(true);
  });
  it("every chunk is non-empty, at most 800 characters, has a valid source id and no whitespace run", () => {
    const content = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`).join("\n\n");
    const chunks = chunkDocument(make(content));
    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((chunk, index) => {
      expect(chunk.id).toBe(`profile-name.${index + 1}`);
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.text.length).toBeLessThanOrEqual(800);
      expect(chunk.text).not.toMatch(/\s{2}|^\s|\s$|[\n\t]/);
    });
  });
  it("nothing is lost: the chunk texts joined with a space are the normalised content", () => {
    const content = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}   with\tmixed \r\n spacing ${"w ".repeat(i * 7)}`).join("\r\n\r\n");
    const normalised = content.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map((p) => p.replace(/\s+/g, " ").trim()).join(" ");
    expect(chunkDocument(make(content)).map((c) => c.text).join(" ")).toBe(normalised);
  });
  it("a single 2000-character paragraph splits cleanly at whitespace, without dropping or cutting words", () => {
    const words = Array.from({ length: 450 }, (_, i) => `w${i}`);
    const paragraph = words.join(" ").slice(0, 2000).replace(/\s\S*$/, "");
    const chunks = chunkDocument(make(paragraph));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((c) => c.text).join(" ")).toBe(paragraph);
    for (const chunk of chunks) { expect(chunk.text.length).toBeLessThanOrEqual(800); expect(chunk.text.startsWith(" ")).toBe(false); }
  });
  it("a word longer than 800 characters is hard-cut, still without dropping anything", () => {
    const chunks = chunkDocument(make("x".repeat(2000)));
    expect(chunks.map((c) => c.text.length)).toEqual([800, 800, 400]);
    expect(chunks.map((c) => c.text).join("")).toBe("x".repeat(2000));
  });
  it("is deterministic: the same document gives byte-identical chunks", () => {
    const content = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"text ".repeat(40)}`).join("\n\n");
    expect(JSON.stringify(chunkDocument(make(content)))).toBe(JSON.stringify(chunkDocument(make(content))));
  });
  it("chunks of a document fit the Slice 1 request schema as sources", () => {
    const chunks = chunkDocument(make("Press \"Save\" & it's done.\n\nSecond."));
    const request = { input: { query: "How?", semanticContext: { route: "profile", elements: [] }, walkthroughSummaries: [], sources: chunks.map((c) => ({ id: c.id, title: c.title, text: c.text })) }, maxOutputChars: 1200 };
    expect(parseGuidanceModelRequest(request).ok).toBe(true);
  });
  it("chunkKnowledge keeps document order", () => {
    const set = parseKnowledgeSet([doc({ id: "a-doc", content: "x" }), doc({ id: "b-doc", content: "y" })]);
    expect(set.ok && chunkKnowledge(set.docs).map((c) => c.id)).toEqual(["a-doc.1", "b-doc.1"]);
  });
});
