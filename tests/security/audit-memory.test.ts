import { InMemoryAuditStore } from "@dap/security";
import { runAuditConformance } from "../../packages/security/src/state/conformance/audit.conformance.js";

runAuditConformance(async () => ({ store: new InMemoryAuditStore() }));
