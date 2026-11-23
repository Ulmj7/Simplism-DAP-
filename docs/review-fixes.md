# Review repairs against main 82ac929

These repairs address the ten assigned findings. They do not complete additional M1 tasks,
implement a reference host, or expand the optional dependency/attack catalogue.

| Finding | Change and focused evidence |
|---|---|
| EXEC-01 | Execute reads only status and optional affected-resource metadata, without traversing application value. `tests/security/review-fixes.test.ts` uses real guarded executors returning Date, Map, class instances, bigint, JSON and unreadable optional metadata; success remains success with no value leakage. |
| LOGIC-01 | Check binding before ALLOW; retain a proven committed receipt and an execution-result checkpoint. Budget exhaustion, lost binding, hung result appends and outer stage throws/timeouts/malformed answers cannot reverse policy or change known success to retry feedback. Invalid execution preconditions still prevent invocation. |
| AUDIT-01 | Empty attempted names are absent in intake and NULL in the central event builder. `tests/integration/audit-postgres.test.ts` persists raw JSON with an empty action through the real PostgreSQL sink: PROPOSED + one INVALID_ACTION denial, both with NULL action_id, no execution. |
| RATE-01 | Malformed intake invokes existing proposal admission once before rejecting. Valid intake continues to the existing rate stage and is charged once there; replay still follows admission. A 200-envelope flood is throttled with bounded state traffic; a mixed three-proposal budget proves no double charge. |
| AUTHZ-01 | Include changesState in the proven definition; deny state changes without an extracted target at authorization. Null-resource reads remain valid; the normal MEDIUM state-changing control still obtains resource authorization. Constitution IX and action-definition.ts's extractor requirement supply the invariant; no global-resource semantics are added. |
| TEST-01 | Focused SC-007 regressions assert post-ALLOW failures and known-success outcomes, complementing existing PostgreSQL durable-before-execution proof. The stale invariant TODO is replaced with evidence pointers; exhaustive optional cases remain separate. |
| TEST-02 | A restricted registered capability uses the same world and real gateway: allowed/other/unknown page, throwing/hung/malformed page hook, and missing permission on the allowed page. Rejections never execute; the page grants no permission. |
| TEST-03 | Production-backed PostgreSQL assertions, raw JSON including duplicate keys, and real defineExecutor bodies bypass relevant capture/recorder/parser blind spots. No second world or reference-host implementation is added. |
| LIMIT-02 | Exclude audit_unavailable from user-abuse denial counts. Six outages execute nothing, then recovery succeeds immediately. Actual policy abuse still triggers the session throttle. |
| RISK-01 | Registry validation enforces the runtime's existing 1000-character justification bound. Lengths 1/1000 execute; empty, blank and 1001 reject at registration. |

Existing post-ALLOW binding-tamper tests now expect ALLOWED/try_later with zero executor calls;
pre-ALLOW tampering continues to deny. The intake-stage fixture supplies trusted run/budget
for admission; the authorization getter fixture supplies changesState and checks one read.
Event-builder properties permit NULL for empty attempted names, matching the database contract.

## Retained limits

ALLOWED is a policy decision, not proof that a side effect happened. An authorized attempt
that cannot start or whose result is unknown reports execution failure/try_later. Known success
keeps success/ok even if result recording fails. Result recording remains best effort and bounded;
a missing EXECUTED row can still require operator investigation. Proposal and non-ALLOW
decision writes also retain their existing best-effort semantics: a selectively failing sink
can leave an ALLOWED record without its PROPOSED record. Complete trails are asserted with
healthy storage; this repair does not guarantee persistence of every event during outages.
These repairs do not provide
exactly-once side effects or cancellation of a running trusted executor after timeout.

The PostgreSQL abort signal, rollback checks and database timeouts from 82ac929 are unchanged.
They cannot make the writer's deadline and PostgreSQL COMMIT atomic: a COMMIT already sent
before cancellation may succeed while its acknowledgement is lost or late. Only a confirmed
successful append becomes a durable receipt for the pipeline. This residual acknowledgement
window remains; no cross-system atomicity is claimed.

The in-memory recorder/capture remains a lightweight adapter, not a PostgreSQL contract
validator or general arbitrary-object recorder. Production-backed tests cover these specific
differences. Reference-host integration (T131/T132/T136) remains separate work.

## Independent QA follow-up

The runner accepts commit and execution checkpoints only as opaque, evaluation-bound
objects produced by the real stages. Structural audit facts, a JSON callback argument,
a reused receipt, or an execute fixture's claimed status cannot attest a write or execution.
This protects the internal stage protocol; it does not sandbox malicious trusted server code.
`tests/security/review-probes.test.ts` pins these cases and a complete real execution chain.

The execution outcome is checkpointed before optional affected-resource metadata is read.
A getter that throws or consumes the remaining time cannot reverse a known success.
Registry justification length uses UTF-16 code units, matching the runtime check: 500
astral characters fit, while one additional character is rejected at registration.

The reconstructed 200-malformed-proposal flood drops shared-store calls from 395 to 32.
It still records 400 audit events (one proposal and one decision per request). Admission
bounds shared limiter work, not the number of received proposals or their required audit
records; these repairs introduce no ingress load shedding or audit suppression.

The PostgreSQL regression cases additionally read back missing-binding, spent-budget,
and hung-executor/result-write outcomes. Confirmed ALLOW remains the sole policy decision;
failed or canceled result recording never creates a contradictory denial.

Isolated stage tests observe publication before execution and still expect the incomplete
chain to deny at execute. Runner status and execution-deadline controls use the existing real
stage chain and its real allow write, rather than stand-ins that return ALLOWED. Post-ALLOW
fixture failures report ALLOWED with failed execution, while pre-ALLOW failures still deny.
