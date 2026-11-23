import type { GuidanceResult } from "@dap/ai";
export function renderDemo(result: GuidanceResult): string {
  switch (result.kind) {
    case "answer": return `Answer:\n${result.answer}\n\nSources:\n${result.sources.map(s => `- ${s.title}`).join("\n")}`;
    case "clarify": return `Clarification:\n${result.message}`;
    case "walkthrough": return `Walkthrough started:\n${result.walkthroughId}\nNo browser is attached; the demo starter only recorded the trusted start.`;
    case "unsupported": return `Unsupported:\n${result.message}`;
  }
}
