/** HOST-OWNED demo fixture, not a real model or general inference engine. */
import type { GuidanceModel } from "@dap/ai";
export const demoModel: GuidanceModel = { async generate(request) {
  const query = request.input.query.trim().toLowerCase();
  if (query === "how do i change my profile name?") return { kind: "start_walkthrough", walkthroughId: "profileUpdate" };
  if (query === "help me with settings.") return { kind: "start_walkthrough", walkthroughId: "findSecuritySettings" };
  if (query === "what is two-factor authentication?" && request.input.sources[0]) return { kind: "answer", answer: "Two-factor authentication adds a second proof of identity when you sign in.", sources: [request.input.sources[0].id] };
  return { kind: "unsupported", message: "This demo does not cover that question." };
} };
