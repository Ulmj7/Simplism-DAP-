import { expect, it } from "vitest";
import { renderDemo } from "./demo-render.js";
it("renders only readable result text", () => {
 expect(renderDemo({ kind: "answer", answer: "Answer text.", sources: [{ id: "secret-id", title: "Title" }] })).toBe("Answer:\nAnswer text.\n\nSources:\n- Title");
 expect(renderDemo({ kind: "clarify", message: "Which guide?" })).toBe("Clarification:\nWhich guide?");
 expect(renderDemo({ kind: "walkthrough", walkthroughId: "profileUpdate" })).toContain("Walkthrough started:\nprofileUpdate");
 expect(renderDemo({ kind: "unsupported", message: "Unavailable.", reason: "unavailable" })).toBe("Unsupported:\nUnavailable.");
});
