/**
 * @dap/testkit: ids.ts (T027)
 *
 * Seeded deterministic IdGenerator for tests. Built on mulberry32 — a small PRNG that is
 * fast, deterministic, and needs no crypto. Same seed => identical sequence; different
 * seed => different sequence. Deliberately NOT crypto-grade: testkit ids only need to be
 * stable and unique within a run, and tests must be deterministic.
 */
import type { ConfirmationId, IdGenerator as IdGeneratorPort } from "@dap/contracts";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHex(length: number, next: () => number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += Math.floor(next() * 16).toString(16);
  }
  return out;
}

export class IdGenerator implements IdGeneratorPort {
  private readonly next: () => number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError("IdGenerator requires a uint32 seed");
    this.next = mulberry32(seed);
  }

  newDecisionId(): string {
    return `dec-${randomHex(16, this.next)}`;
  }

  newConfirmationId(): ConfirmationId {
    const b: number[] = [];
    for (let i = 0; i < 16; i++) {
      b.push(Math.floor(this.next() * 256));
    }
    // Force UUID v4 shape: version nibble 4, variant nibble 10xx (8/9/a/b).
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const hex = b.map((x) => x.toString(16).padStart(2, "0")).join("");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return uuid as ConfirmationId;
  }
}
