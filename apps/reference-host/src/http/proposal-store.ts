/**
 * C01: the host-side store of walkthrough PROPOSALS handed to the browser. The browser only ever sees an opaque proposal id; the walkthrough id the
 * model proposed stays here. A proposal id is unguessable (injected generator), single use (redeeming it removes it, whatever the outcome), short-lived
 * (injected clock, a TTL), bound to the session that asked (redeeming it from another session fails and burns it), and the store is bounded (expired
 * entries are dropped first, then the oldest).
 */
export interface ProposalStoreDeps {
  /** Milliseconds since the epoch. Injected so tests control expiry. */
  readonly now: () => number;
  /** An unguessable opaque id (the default dev server uses 32 random bytes, base64url). */
  readonly newId: () => string;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}
export interface ProposalStore {
  /** Records a proposal for `sessionKey` and returns its opaque id. */
  mint(sessionKey: string, walkthroughId: string): string;
  /** The proposed walkthrough id, or `null` (unknown, expired, already used, or another session's). Always single use. */
  redeem(sessionKey: string, proposalId: string): string | null;
  size(): number;
}

export const PROPOSAL_TTL_MS = 5 * 60 * 1000;
export const MAX_PROPOSALS = 256;

interface Entry { readonly sessionKey: string; readonly walkthroughId: string; readonly expiresAt: number }

export function createProposalStore({ now, newId, ttlMs = PROPOSAL_TTL_MS, maxEntries = MAX_PROPOSALS }: ProposalStoreDeps): ProposalStore {
  const entries = new Map<string, Entry>();
  const dropExpired = (at: number) => { for (const [id, entry] of entries) if (entry.expiresAt <= at) entries.delete(id); };
  return Object.freeze({
    mint(sessionKey: string, walkthroughId: string): string {
      const at = now();
      dropExpired(at);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      const id = newId();
      if (entries.has(id)) throw new Error("proposal id collision"); // an id generator that repeats itself is broken: fail closed
      entries.set(id, Object.freeze({ sessionKey, walkthroughId, expiresAt: at + ttlMs }));
      return id;
    },
    redeem(sessionKey: string, proposalId: string): string | null {
      const entry = entries.get(proposalId);
      if (entry === undefined) return null;
      entries.delete(proposalId);
      if (entry.expiresAt <= now() || entry.sessionKey !== sessionKey) return null;
      return entry.walkthroughId;
    },
    size: () => entries.size,
  });
}
