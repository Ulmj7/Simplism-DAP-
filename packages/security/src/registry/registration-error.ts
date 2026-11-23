import type { RegistrationIssue } from "@dap/contracts";

export class RegistrationError extends Error {
  readonly issues: readonly RegistrationIssue[];

  constructor(issues: readonly RegistrationIssue[]) {
    const snapshot = Object.freeze(issues.map(({ actionId, rule, detail }) => Object.freeze({ actionId, rule, detail })));
    super(`Registration failed:\n${snapshot.map(({ actionId, rule, detail }) => `${actionId}: ${rule}: ${detail}`).join("\n")}`);
    this.name = "RegistrationError";
    this.issues = snapshot;
    Object.freeze(this);
  }
}
