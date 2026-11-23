import type { PlannerPort, RawToolCall } from "@dap/ai";
import type { HostilePlanner as ScriptedPlanner, PlannerFeedback, ProposalCall } from "@dap/contracts";

/** Text scripts preserve code units, including malformed Unicode; intake alone judges them. */
export class HostilePlanner implements PlannerPort, ScriptedPlanner {
  readonly script: readonly ProposalCall[];
  private readonly calls: readonly RawToolCall[];
  private cursor = 0;
  constructor(script: readonly ProposalCall[]) {
    this.calls = Object.freeze(script.map((call) => {
      const { callId, raw } = call;
      if (typeof callId !== "string" || typeof raw !== "string") throw new TypeError("PlannerPort scripts require text arguments and call ids");
      return Object.freeze({ providerCallId: callId, arguments: raw });
    }));
    this.script = Object.freeze(this.calls.map((call) => Object.freeze({ callId: call.providerCallId, raw: call.arguments })));
  }
  async plan(feedback: readonly PlannerFeedback[]): Promise<RawToolCall | null> {
    void feedback;
    const call = this.calls[this.cursor];
    if (!call) return null;
    this.cursor++;
    return call;
  }
}
