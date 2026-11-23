# Feature Specification: Tenant-Isolated Knowledge Retrieval

**Feature Branch**: `003-tenant-isolated-rag`

**Created**: 2026-11-13

**Status**: Draft. **SUPERSEDED (2026-11-16)** by [`specs/003-ai-guidance`](../003-ai-guidance/spec.md), a compressed, delivery-scoped feature (small deterministic retrieval, no tenant machinery while the demo holds no tenant-owned data). This document is kept for history only. Its core ideas (retrieved text is untrusted data; the knowledge base holds only product knowledge; the tenant constraint belongs in the retrieval query when tenant-owned content appears) are carried into the new feature, and the enterprise parts (tenant-isolated vector storage, update/offboarding workflows, per-retrieval audit and quotas, access-equivalence filtering, the isolation catalogue) are FUTURE there.

**Input**: User description:

> Tenant A can never retrieve Tenant B embeddings. Retrieved content is untrusted data. Retrieved
> text cannot: add tools; alter permissions; change policy; override system rules; provide
> authorization. Retrieval filtering occurs BEFORE similarity results are returned, not after. RAG
> should contain only product knowledge required for guidance.

## User Scenarios & Testing *(mandatory)*

**Who is involved.** The *end user* asks the assistant for help using their organization's product.
The *tenant* is that user's organization, and it owns a private body of product knowledge (help
articles, guides, tutorials) that the assistant draws on. *Knowledge staff* are the authorized people
at a tenant who add and maintain that knowledge. The *security reviewer* checks that nothing crosses
between tenants. The *AI* is an **untrusted consumer**: it reads retrieved passages to answer
questions, and anything inside those passages is just text, never a command.

**What this feature is.** The knowledge-retrieval capability behind the guidance assistant ("RAG":
retrieval of relevant passages to help the AI answer). It has three jobs. It keeps each tenant's
knowledge strictly separate, including the numeric representations ("embeddings") used to find
similar passages. It makes sure retrieved text can never act as an instruction, a permission, or an
authorization. And it keeps the knowledge base limited to product guidance material, so there is
little to leak and little to poison.

Every scenario below is exercised without a real LLM or external network.

### User Story 1 - A tenant can never retrieve another tenant's knowledge (Priority: P1)

A user at Tenant A can only ever get passages that belong to Tenant A. Nothing that belongs to
Tenant B can be returned to them, however the question is worded, whatever filters are requested, and
whether the request comes from the user or from the AI.

**Why this priority**: Cross-tenant disclosure is the failure that ends trust in a multi-tenant
product. It must be impossible by construction, not unlikely.

**Independent Test**: Load two tenants with unique marker passages, ask Tenant A questions engineered
to match Tenant B's markers exactly, and confirm no Tenant B content is ever returned.

**Acceptance Scenarios**:

1. **Given** Tenant B holds a passage with a unique phrase that Tenant A lacks, **When** a Tenant A user
   asks a question that matches that phrase exactly, **Then** none of Tenant B's content is returned,
   and the response looks the same as for a question with no match.
2. **Given** any phrasing, filter choice, or requested number of results, **When** Tenant A retrieves,
   **Then** every returned passage belongs to Tenant A.
3. **Given** Tenant A has only 3 relevant passages and 10 are requested, **When** retrieval runs,
   **Then** 3 are returned, and the list is never padded from another tenant.
4. **Given** identical text exists in both tenants, **When** each tenant retrieves, **Then** each gets
   only its own copy, and the copies are never merged or de-duplicated across tenants.
5. **Given** a tenant identifier appears in the question text, a filter, the AI's output, or a
   document's metadata, **When** retrieval runs, **Then** it is ignored, and the tenant is the one
   established by the caller's trusted authentication.
6. **Given** a retrieval request with no tenant scope, or an ambiguous one, **When** it reaches the
   knowledge store, **Then** the store itself refuses it and returns nothing.
7. **Given** one person who belongs to two tenants and holds a separate session for each, **When**
   they ask the same question in each, **Then** each session retrieves only that session's tenant
   knowledge.
8. **Given** one tenant's knowledge is flooded or poisoned, **When** other tenants retrieve, **Then**
   their results are unchanged.
9. **Given** keyword, hybrid, re-ranking, or query-expansion search paths, **When** they run, **Then**
   each obeys the same tenant restriction as plain similarity search.
10. **Given** two tenants add knowledge at the same moment, **When** the items are stored, **Then** each
    item carries exactly its own tenant, and none is stored under the wrong one.
11. **Given** retrieval is offered to the AI as a tool, **When** the AI calls it with extra fields, a
    tenant identifier, or filters outside the closed set, **Then** the Policy Gateway rejects the call
    and nothing is retrieved.
12. **Given** any retrieval result, **When** it is delivered, **Then** it holds passages and provenance
    only, and the numeric searchable representations (embeddings) are never returned to the AI or to
    end users.

---

### User Story 2 - The tenant restriction is part of the search itself, never applied afterward (Priority: P1)

The restriction to the caller's tenant is built into the search, so passages from other tenants are
never examined, scored, or ranked, instead of being found first and thrown away. Search that fails
does not fall back to something wider.

**Why this priority**: Filtering after the search is the classic way isolation leaks: through
ranking, result counts, caches, and mistakes in the discarding step. Applying the restriction first
removes those leaks at the root.

**Independent Test**: Instrument the knowledge store, run queries, and confirm each one carried the
tenant restriction and examined only that tenant's items. Then make components fail and confirm
nothing wider is ever searched.

**Acceptance Scenarios**:

1. **Given** any retrieval, **When** it executes, **Then** items of other tenants are never examined,
   scored, or ranked as part of it.
2. **Given** a verification probe at the store, **When** a query runs, **Then** it records that the
   restriction was present and that only the caller's tenant items were examined, and a query lacking
   the restriction is refused.
3. **Given** another tenant's item that would be the best match across all tenants, **When** a query
   runs, **Then** it never takes a place in the results or uses up a result slot.
4. **Given** Tenant B's knowledge grows, shrinks, or changes, **When** Tenant A repeats a query,
   **Then** A's passages, their order, the result count, and the response size are unchanged.
5. **Given** the knowledge store, the step that turns questions into searchable form, the audience
   check, or any filtering component is unavailable or fails, **When** retrieval is requested,
   **Then** nothing is returned and guidance continues without retrieved knowledge. There is no
   fallback to an unrestricted, shared, or other-tenant search.
6. **Given** saved results, saved question representations, or assembled prompts, **When** two tenants
   alternately issue identical questions, **Then** neither ever receives something saved for the
   other.
7. **Given** a retry or alternative path inside retrieval, **When** it runs, **Then** it keeps the same
   tenant restriction.
8. **Given** a defect that makes the calling component leave out the tenant scope, **When** a query
   runs, **Then** the layer that talks to the store, or the store itself, still refuses it.

---

### User Story 3 - Retrieved text is untrusted data and can never gain authority (Priority: P1)

Whatever a retrieved passage says, it stays text. It cannot give the AI a new tool, change anyone's
permissions, alter policy, override the system's rules, or stand in for authorization. Those things
are decided only by trusted code that retrieved text cannot reach.

**Why this priority**: Knowledge is written by people and can contain mistakes or malicious
instructions. If a passage could steer the system, anyone able to add a document could take over the
assistant.

**Independent Test**: Retrieve a set of deliberately poisoned passages and confirm the AI's tool set,
permissions, policy, rules, and authorization decisions are exactly as they would be without them.

**Acceptance Scenarios**:

1. **Given** a passage that claims the AI now has a new tool, **When** it is retrieved and shown to the
   AI, **Then** the tools available to the AI are unchanged.
2. **Given** a passage that claims to grant a user or the AI more permissions or a higher role,
   **When** it is retrieved, **Then** nobody's permissions change.
3. **Given** a passage that says to ignore earlier instructions, change policy, or override system
   rules, **When** it is retrieved, **Then** policy and system rules are unchanged.
4. **Given** a passage that claims an action is approved, pre-authorized, or already confirmed,
   **When** it is retrieved, **Then** no action is authorized on its strength; decisions rest on
   trusted authorization only.
5. **Given** a passage that imitates the markers separating system rules from retrieved material,
   **When** it is delivered to the AI, **Then** it cannot close, forge, or escape its labeled
   data area.
6. **Given** a passage containing hidden or invisible text, **When** it is processed, **Then** the
   hidden text is removed or flagged, and has the same lack of effect.
7. **Given** a passage containing links or markup, **When** it is used, **Then** it is treated as plain
   text: never fetched, never rendered as active content.
8. **Given** any decision about tenant, user, permission, risk, or confirmation, **When** it is made,
   **Then** it never consults retrieved text.
9. **Given** a poisoned passage that no detection tool recognizes, **When** the scenarios above run,
   **Then** every outcome above still holds.
10. **Given** a passage whose text claims a different source, document identifier, or version, **When**
    it is delivered, **Then** the provenance shown is the system's own record, never what the text
    claims.
11. **Given** retrieval returns more passages, or longer ones, than the configured maximums, **When**
    they are delivered, **Then** they are cut in a fixed, documented order to stay within the limits.

---

### User Story 4 - The knowledge base holds only product knowledge required for guidance (Priority: P1)

Only material that exists to help people use the product can enter the knowledge base, and only
through a trusted route used by authorized staff. Customer data, credentials, conversations, and
anything else that is not guidance material is kept out.

**Why this priority**: What is never stored can never be leaked or used to attack. Limiting the
content to guidance material also keeps the whole feature's risk small.

**Independent Test**: Submit allowed and prohibited material through the trusted route, and try to
add material from every other direction, then inspect what the knowledge base holds.

**Acceptance Scenarios**:

1. **Given** an authorized staff member submits product documentation, a how-to guide, tutorial text,
   an FAQ, release notes, or descriptions of interface elements, with its type, product area, owner,
   and source, **When** it is processed, **Then** it is accepted.
2. **Given** material of a prohibited kind (customer or end-user records, conversations or AI outputs,
   credentials, secrets, or tokens, personal or financial data, source code or configuration, internal
   tickets, logs, database exports), **When** it is submitted, **Then** it is rejected or held for
   review and is never made searchable.
3. **Given** a document missing its type, product area, owner, or source, or whose type is not on the
   allowed list, **When** it is submitted, **Then** it is rejected.
4. **Given** a document containing credential-like strings or personal-data patterns, **When** it is
   submitted, **Then** it is held for human review before it can be made searchable.
5. **Given** a document containing instruction-like text aimed at AI models, **When** it is submitted,
   **Then** it is flagged for review, and the guarantees of User Story 3 hold whether or not it is
   flagged.
6. **Given** an end user, the AI, or the interface layer tries to add, change, or remove knowledge,
   **When** the attempt is made, **Then** it is refused, because no such route exists for them.
7. **Given** user conversations, page context, or application data, **When** the system runs, **Then**
   none of it is ever written into the knowledge base automatically.
8. **Given** a source given as an arbitrary web address, **When** it is submitted, **Then** it is not
   fetched. Only authenticated uploads and explicitly registered documentation sources are accepted.
9. **Given** authorized staff open the knowledge inventory, **When** it displays, **Then** it shows each
   document's type, product area, owner, source, version, and status.
10. **Given** a document larger than the size limit, or a tenant already at its document-count limit,
    **When** more is submitted, **Then** it is rejected.

---

### User Story 5 - Users retrieve only knowledge they could access directly (Priority: P2)

Some knowledge is meant for particular roles (for example administrator guides). A user who could not
open such a document directly cannot get its contents, or even learn it exists, by asking the
assistant.

**Why this priority**: Otherwise the assistant would let people read what their role does not allow.
It builds on the P1 isolation, so it can follow it.

**Independent Test**: Mark a document as requiring a permission, then ask the same question as users
with and without that permission, before and after a permission change.

**Acceptance Scenarios**:

1. **Given** a document that requires a permission, **When** a user without it asks a matching question,
   **Then** the document is not returned and nothing hints that it exists.
2. **Given** a user who holds the permission, **When** they ask, **Then** it is returned.
3. **Given** a user loses the permission during a session, **When** they next ask, **Then** the
   document is excluded.
4. **Given** an upload names an audience such as "everyone" or a role, **When** it is processed,
   **Then** only authorized staff can set it, and only to allowed values.
5. **Given** the question, the AI's output, or a passage claims the user is entitled to something,
   **When** retrieval runs, **Then** the claim is ignored, and eligibility comes from trusted
   permission checks.
6. **Given** audience restrictions, **When** retrieval runs, **Then** they are applied as part of the
   search, in the same way as the tenant restriction.

---

### User Story 6 - Knowledge updates, deletion, and offboarding are honored fully (Priority: P2)

When knowledge changes or is removed, retrieval follows right away, and the old content truly leaves
the system, including searchable forms and saved results.

**Why this priority**: Stale or "deleted" material that can still be retrieved is both a privacy
failure and a source of wrong guidance.

**Independent Test**: Update, delete, and offboard in turn, retrieving after each step, and confirm
old content is gone from every searchable form within the stated window.

**Acceptance Scenarios**:

1. **Given** a document is updated, **When** retrieval runs, **Then** only the latest published version
   can be returned.
2. **Given** a document is deleted, **When** the deletion is confirmed, **Then** it can no longer be
   retrieved, and its text, searchable forms, indexes, and saved results are removed within the
   defined window.
3. **Given** a draft or held-for-review document, **When** retrieval runs, **Then** it is never
   returned.
4. **Given** a tenant is offboarded, **When** its removal completes, **Then** all of its knowledge is
   gone, other tenants are unaffected, and its identifier is never reused.
5. **Given** a backup is restored, **When** retrieval resumes, **Then** earlier deletions are applied
   again before anything becomes searchable.
6. **Given** a deletion is confirmed while a search is in progress, **When** the search began after
   the confirmation, **Then** the deleted item is not returned.

---

### User Story 7 - Retrievals and knowledge changes are audited and abuse-limited (Priority: P2)

Reviewers can see who retrieved what and who changed the knowledge, without the records themselves
becoming a leak. Floods of queries, including attempts to probe for other tenants' content, are
stopped.

**Why this priority**: Isolation must be demonstrable after the fact, and probing is a realistic
attack. It does not change the P1 protections themselves.

**Independent Test**: Run normal and abusive retrieval and ingestion activity, then check the records
and the limits.

**Acceptance Scenarios**:

1. **Given** any retrieval, **When** it completes, **Then** a record shows the time, tenant, user, AI
   session, filters applied, the identifiers of the documents returned, and the counts, and by default
   contains neither the question text nor passage text.
2. **Given** any ingestion, update, release from review, or deletion, **When** it completes, **Then** a
   record shows who did it, the tenant, the document, the source, and the outcome.
3. **Given** retrieval requests above the per-user or per-tenant limit, **When** they arrive, **Then**
   the excess is denied and recorded.
4. **Given** a reviewer at Tenant A reads the records, **When** they search, **Then** they see no
   Tenant B records, and the AI can neither read nor alter any record.
5. **Given** a campaign of many questions crafted to discover other tenants' content, **When** it runs,
   **Then** the limits stop it and the records show it.
6. **Given** a question above the size limit, or application code that tries to add page data or
   secrets to a question, **When** retrieval is requested, **Then** the oversized question is rejected
   and nothing is added to any question.

---

### User Story 8 - Isolation and injection tests join the shared security catalogue (Priority: P2)

The shared security test catalogue gains ready-made scenarios, fixtures, and checks for retrieval, so
every future change is tested against cross-tenant leakage and poisoned knowledge.

**Why this priority**: These guarantees are only trustworthy if they are proven repeatedly in CI.

**Independent Test**: Run the scenarios, deliberately remove the restriction from one search path,
and confirm a scenario fails and names the gap.

**Acceptance Scenarios**:

1. **Given** fixtures with two or more tenants holding unique marker passages, poisoned documents, and
   samples of prohibited material, **When** the scenarios run, **Then** no marker crosses a tenant
   boundary and every poisoned or prohibited sample has no effect.
2. **Given** the shared catalogue and coverage report, **When** this feature is added, **Then** its
   scenarios appear in the same report.
3. **Given** each protected property, **When** the coverage report runs, **Then** it has a test proving
   the protection and a test proving that legitimate retrieval inside the tenant still works.
4. **Given** the restriction is deliberately removed from one search path, **When** the scenarios run,
   **Then** at least one fails and names that path.
5. **Given** randomly generated tenants, knowledge, and questions, **When** retrieval runs repeatedly,
   **Then** no marker ever crosses a tenant boundary, and the runs need no live model and no external
   network.

---

### Edge Cases

- **Question engineered to match another tenant's unique phrase**: returns only the asking tenant's
  content or nothing, and looks the same as an ordinary no-match.
- **Fewer matches than requested**: fewer results are returned. Lists are never padded from elsewhere.
- **Same text in two tenants**: kept as two separate items. Merging them across tenants would reveal
  that another tenant holds that text.
- **Passage that mimics the separator between rules and retrieved material**: cannot escape its area.
- **Passage with hidden text** (zero-width characters, invisible styling, comments): cleaned or flagged,
  and has no effect either way.
- **Passage listing web addresses**: shown as plain text. Nothing is fetched, and no tool exists to
  fetch them.
- **Malicious or careless knowledge staff**: poisoning is limited to their own tenant and cannot affect
  any other tenant's retrieval.
- **Upload metadata that claims a tenant, an audience, or a "published" status**: the tenant comes from
  trusted authentication, and audience and status can be set only by authorized staff to allowed
  values.
- **Permission lost mid-session**: the next retrieval already excludes documents requiring it.
- **Deletion during a search**: an item whose deletion was confirmed before the search began is not
  returned.
- **Failure or odd output from the question-processing step** (error, timeout, unexpected form): treated
  as a failure, with no results and no fallback.
- **Very large question or document**: rejected or cut to the configured limit.
- **Saved results after a deletion or update**: invalidated, and always separated by tenant.
- **Identifier reuse**: a tenant identifier is never reused after offboarding, so a new tenant cannot
  inherit leftovers.
- **Backup restore**: reapplies recorded deletions so removed knowledge does not return.
- **One tenant's search load**: cannot degrade or change another tenant's results.
- **AI rewrites or expands the question**: the rewritten question is still confined to the same tenant
  and audience.

## Requirements *(mandatory)*

### Functional Requirements

**Tenant isolation of knowledge and retrieval**

- **FR-001**: Every item in the knowledge base (document, passage, searchable representation, index
  entry, saved result, and its metadata) MUST belong to exactly one tenant, assigned at the moment it
  is created from the caller's trusted authenticated context, and never taken from document content,
  upload metadata, question text, or AI output.
- **FR-002**: Each retrieval MUST run for exactly one tenant: the tenant of the caller's trusted
  context. Nothing in the question, filters, AI output, or retrieved content MUST be able to select or
  change it.
- **FR-003**: A retrieval MUST NOT return, score, rank, count, or otherwise reveal any item belonging to
  another tenant.
- **FR-004**: The tenant restriction MUST be part of the search itself and applied before any
  similarity result is produced. Searching all tenants and filtering afterward MUST NOT be used
  anywhere, including retries, fallbacks, and alternative search paths.
- **FR-005**: The knowledge store MUST refuse any search that has no tenant scope or an ambiguous one.
  No unscoped search path MAY exist, and the refusal MUST NOT depend on the caller having checked.
- **FR-006**: Isolation MUST be enforced at more than one layer (the calling component, the component
  that talks to the store, and the store itself) so that a mistake in one layer does not expose data.
- **FR-007**: A retrieval MUST NOT pad its results with other tenants' items to reach a requested
  count. Returning fewer results is normal.
- **FR-008**: What a tenant receives (content, order, count, and response size) MUST NOT depend on any
  other tenant's data. Differences in timing MUST be minimized, and any remaining limit documented.
- **FR-009**: Every cache or intermediate store used by retrieval (saved results, saved question
  representations, assembled prompts) MUST be separated by tenant, with the tenant part of how items
  are looked up, and MUST NEVER be matched by similarity across tenants.
- **FR-010**: Searchable representations ("embeddings") MUST be treated as tenant data and protected
  exactly like the text they come from, and MUST NOT be returned in any retrieval result to the AI or
  to end users.
- **FR-011**: Every search path (similarity, keyword, hybrid, re-ranking, question expansion) MUST
  apply the same tenant and audience restriction.

**Retrieved text is untrusted data**

- **FR-012**: All retrieved text MUST be treated as untrusted data in every part of the system.
- **FR-013**: The tools offered to the AI MUST be determined only by the capability registry and its
  allowlist from the AI Security Foundation. Retrieved text MUST NOT add, remove, rename, or alter a
  tool.
- **FR-014**: Retrieved text MUST NOT alter permissions, roles, policy, or system rules. The retrieval
  component MUST have no ability to write to permission data, policy configuration, the capability
  registry, or the identity of the tenant or user.
- **FR-015**: Retrieved text MUST NOT provide, imply, or substitute for authorization. Claims inside it
  ("approved", "admin", "pre-authorized") MUST have no effect, and every action decision continues to
  rest only on the trusted authorization of the AI Security Foundation.
- **FR-016**: Retrieved passages MUST reach the AI in a clearly separated, labeled data area that
  retrieved text cannot close, forge, imitate, or escape. System rules and retrieved text MUST never
  be joined into one undifferentiated stream of instructions.
- **FR-017**: Each passage MUST carry provenance (document identifier, title, version, source type) set
  by the system. Passage content MUST NOT be able to set or change these fields.
- **FR-018**: Passages MUST be bounded (maximum count, maximum length each, maximum total), cleaned of
  control, hidden, and text-direction characters, and cut deterministically when over a limit. Links
  and markup MUST be treated as plain text.
- **FR-019**: Detection of instruction-like text MAY be used to flag content. It MUST NOT be relied on
  as a control: FR-012 to FR-018 MUST hold when detection misses a payload.
- **FR-020**: Retrieved text MUST NOT be an input to any decision about tenant, user, permission, risk,
  or confirmation, and MUST NOT be used as a value later treated as an identity.

**Knowledge content and ingestion**

- **FR-021**: The knowledge base MUST contain only product knowledge required for guidance, drawn from
  an allowlist of content types: product documentation, how-to guides, tutorial text, FAQs, release
  notes, and descriptions of interface elements.
- **FR-022**: The following MUST NOT be stored: customer or end-user data, application records,
  conversations and AI outputs, credentials, secrets, keys, and tokens, personal or financial data,
  source code and configuration, internal tickets, logs, database exports, and anything else not
  required for guidance.
- **FR-023**: Knowledge MUST enter only through a trusted, authenticated, authorized route used by
  authorized knowledge staff, with the tenant taken from their trusted context. End users, the AI, and
  the interface layer MUST NOT be able to add, change, or remove knowledge.
- **FR-024**: Sources MUST be allowlisted: authenticated uploads and explicitly registered
  documentation sources. Arbitrary web addresses MUST NOT be fetched.
- **FR-025**: Each document MUST declare its content type, product area, owner, and source. A document
  missing any of them, or of a type outside the allowlist, MUST be rejected.
- **FR-026**: Ingestion MUST check content for credential-like strings and personal or sensitive data
  patterns, and MUST hold any match for review before it becomes searchable. This is defense in depth.
  The allowlist (FR-021 to FR-025) is the control.
- **FR-027**: Ingestion MUST flag instruction-like text aimed at AI models for review, subject to
  FR-019.
- **FR-028**: Authorized staff MUST be able to view their tenant's inventory (document, type, product
  area, owner, source, version, status).
- **FR-029**: Nothing from user conversations, page context, or application data MUST ever be written
  to the knowledge base automatically. Per-document size and per-tenant count limits (configurable)
  MUST apply.

**Audience-aware retrieval**

- **FR-030**: Each document MUST carry an audience label (by default all users of the tenant,
  optionally requiring a permission). Retrieval MUST restrict results, as part of the search, to
  audiences the requesting user qualifies for, determined by trusted permission checks and never by the
  AI, the question, or any passage.
- **FR-031**: A user MUST NOT be able to learn anything about a document whose audience they do not
  qualify for, including that it exists.

**Lifecycle**

- **FR-032**: Only the latest published version of a document MUST be retrievable. Superseded, draft,
  held-for-review, and deleted items MUST NOT be.
- **FR-033**: Deleting or superseding a document MUST make it unretrievable as soon as the change is
  confirmed, and MUST remove its text, searchable forms, indexes, and saved results within a defined
  window (default 24 hours). Backups follow their own retention and MUST reapply deletions on restore.
- **FR-034**: Offboarding a tenant MUST remove all of its knowledge the same way without affecting any
  other tenant. A tenant identifier MUST NEVER be reused.

**Failure handling and abuse limits**

- **FR-035**: Retrieval MUST fail closed. If the store, the question-processing step, the audience
  check, the tenant scope, or any filter is unavailable or fails, it MUST return no results and let
  guidance continue without retrieved knowledge, and MUST NOT fall back to any unrestricted, shared, or
  other-tenant search.
- **FR-036**: Retrieval requests MUST be subject to rate limits per user and per tenant, consistent with
  the abuse controls of the AI Security Foundation. Excess requests MUST be denied.
- **FR-037**: Question text MUST be bounded in size, treated as untrusted, and never have secrets or
  application data added to it automatically.

**Audit**

- **FR-038**: Each retrieval MUST be recorded with timestamp, tenant, user, AI session, filters
  applied, identifiers of returned documents, and counts. Question text and passage text MUST be
  excluded by default.
- **FR-039**: Each ingestion, update, release from review, and deletion MUST be recorded with actor,
  tenant, document, source, and outcome.
- **FR-040**: Records MUST be readable only within their own tenant, and the AI MUST be unable to read,
  alter, or delete them.

**Verification**

- **FR-041**: Security scenarios MUST be added to the shared security test catalogue covering:
  cross-tenant retrieval (including questions built to match another tenant's unique content);
  verification that the restriction is applied before results; poisoned documents (new tools,
  permissions, policy, rules, authorization claims); look-alike separator text; prohibited-material
  ingestion; audience bypass; stale and deleted content; cache isolation; independence from other
  tenants' data; and every failure mode of FR-035.
- **FR-042**: Fixtures MUST include two or more tenants with unique marker passages, poisoned
  documents, and prohibited-material samples. Tests MUST be deterministic and MUST NOT need a live AI
  model or external network.
- **FR-043**: Tests MUST be able to observe at the store that every query carried the tenant
  restriction and examined only that tenant's items, and that unscoped queries are refused.
- **FR-044**: The coverage report MUST show, for each protected property, a test that proves the
  protection and a test that proves legitimate retrieval within the tenant still works.

**Integration**

- **FR-045**: Tenant and user identity for retrieval MUST come only from the trusted authorization
  context of the AI Security Foundation. A retrieval session MUST be bound to that context so that the
  AI cannot supply or change it.
- **FR-046**: If retrieval is offered to the AI as a tool, it MUST be a registered read-only capability
  that passes through the Policy Gateway with a strict, bounded input (question text and filters from
  a closed set only).

### Key Entities *(include if feature involves data)*

- **Tenant Knowledge Partition**: One tenant's private body of knowledge. Holds that tenant's documents
  and their searchable forms, and is never searched on behalf of anyone else.
- **Knowledge Document**: One piece of product guidance material with content type, product area,
  owner, source, audience label, version, and status.
- **Passage**: A bounded excerpt of a document that can be returned to the AI as data.
- **Searchable Representation (Embedding)**: The numeric form of a passage used to find similar
  passages. Treated as tenant data.
- **Content Type**: One of the allowed kinds: product documentation, how-to guide, tutorial text, FAQ,
  release notes, interface element description.
- **Audience Label**: Who may retrieve a document: all users of the tenant, or users holding a stated
  permission.
- **Document Status**: Draft, held for review, published, superseded, or deleted. Only published,
  latest-version documents are retrievable.
- **Provenance Record**: System-set facts attached to a passage (document identifier, title, version,
  source type).
- **Retrieval Request**: A trusted tenant and user scope plus an untrusted question and a closed set of
  filters.
- **Retrieval Result**: A bounded list of passages with provenance, delivered as untrusted data.
- **Data Area**: The labeled region of what the AI receives that holds retrieved passages, kept apart
  from system rules.
- **Review Hold**: A document set aside because screening found credential-like, personal, or
  instruction-like content.
- **Knowledge Inventory**: The list of a tenant's documents with their descriptive fields.
- **Retrieval Record**: The audit entry for one retrieval.
- **Knowledge Change Record**: The audit entry for one ingestion, update, release, or deletion.
- **Marker Passage**: A unique test passage planted in a tenant to prove it never reaches anyone else.
- **Poisoned Document**: A test document that contains instructions or claims aimed at the AI.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across a fixture of at least two tenants, each holding unique marker passages, 0 of
  10,000 adversarial questions asked as one tenant (including questions copied from the other tenant's
  markers) return any passage belonging to another tenant.
- **SC-002**: In 100% of retrievals, a store-side check shows the tenant restriction was part of the
  search and only that tenant's items were examined. 100% of searches without a tenant scope are
  refused, and 0 other-tenant items are ever scored or ranked.
- **SC-003**: Across a corpus of poisoned documents covering new tools, permission grants, policy
  changes, overriding system rules, and authorization claims, 100% of attempts leave the AI's tools,
  permissions, policy, system rules, and action decisions unchanged.
- **SC-004**: In 1,000 generated variants of text imitating the separator between system rules and
  retrieved material, 100% stay inside their labeled data area, and 0 retrieved words appear in the
  rules area.
- **SC-005**: 100% of documents whose type is not allowlisted, or that lack type, product area, owner,
  or source, are rejected. At least 95% of credential-like and personal-data strings seeded into test
  documents are held for review, and 0 held items become searchable before approval.
- **SC-006**: In 100% of tests, a user lacking a document's required permission cannot retrieve it or
  learn that it exists, including right after a permission change.
- **SC-007**: In 100% of tests, a deleted or superseded document is not retrievable from the moment of
  confirmation, and is gone from all searchable forms and saved results within 24 hours.
- **SC-008**: When 1,000 documents are added to or removed from one tenant, another tenant's results
  for the same questions are identical in content, order, count, and response size in 100% of runs.
- **SC-009**: With each of the store, the question-processing step, the audience check, and the tenant
  scope made unavailable in turn, 100% of retrievals return no results, none falls back to a wider
  search, and guidance continues without retrieved knowledge.
- **SC-010**: Across 1,000 identical questions issued alternately by two tenants, 0 cross-tenant cache
  hits occur.
- **SC-011**: 100% of retrievals produce a record with tenant, user, session, filters, document
  identifiers, and counts, and 0 records contain question text or passage text. 100% of ingestions,
  updates, releases, and deletions record their actor.
- **SC-012**: A probing campaign above the configured rate is stopped within the first limit window, and
  100% of excess requests are denied and recorded.
- **SC-013**: Over 1,000 randomly generated tenant corpora and question sets, 0 marker passages cross a
  tenant boundary, and two consecutive runs of the full suite, with no live model and no external
  network, give identical results.
- **SC-014**: In a review exercise, a reviewer can use only the inventory and the records to state what
  a tenant's knowledge base contains and who retrieved or changed what, for 100% of sampled tenants.

## Assumptions

- **Governing rules**: The project constitution (v1.0.0) binds this feature, in particular Principles
  XI (tenant isolation, with the restriction applied during retrieval), XII (retrieved content is
  untrusted data), V (no secrets to the AI), X (users cannot learn through the AI what they could not
  access directly), and XVI (minimal data, fail closed).
- **Builds on the AI Security Foundation**: Tenant and user identity, the Policy Gateway, abuse limits,
  audit practice, and the shared security test catalogue come from that feature and are not modified
  here. The semantic layer (feature 002) is independent of this one.
- **Tenant meaning**: A tenant is one customer organization. Each authenticated session has exactly one
  active tenant, as assumed in the AI Security Foundation plan. This feature changes if that
  assumption changes.
- **No shared partition**: Knowledge belongs to exactly one tenant. A platform-wide shared collection,
  readable by every tenant, is not part of this feature. If one is wanted later it needs its own
  specification (read-only, curated by platform staff, free of tenant data). Until then,
  platform-supplied material is added separately to each tenant.
- **Embeddings are tenant data**: Searchable representations can reveal the text they came from, so
  they get the same protection as the text.
- **Staff are trusted only within their own tenant**: Knowledge staff are not trusted to write
  instructions to the AI. Whatever they add is treated as untrusted data (User Story 3), and the damage
  from a careless or malicious author is limited to their own tenant.
- **Provider and store choices are deferred**: The choice of storage, question-processing model, and
  provider is made in planning. Any external provider receives only screened, allowlisted material, and
  tenants approve that processing as part of onboarding.
- **How retrieval is triggered**: Retrieval may be run by the system before the AI answers or requested
  by the AI as a read-only tool. Either way the same tenant-bound, pre-restricted retrieval applies,
  and the AI can never pick the tenant or widen the filters.
- **Timing differences**: Preventing all timing differences between tenants is not guaranteed. FR-008
  asks that they be minimized and the limit documented. It is a known residual risk.
- **Deletion window**: The default 24-hour removal window is a planning default. Backups are excluded
  and follow their own retention.
- **Configurable limits**: Maximum results, passage length, total size, question size, document size,
  per-tenant document count, and retrieval rates are configurable. Defaults are chosen in planning.
- **Out of scope (separate features)**: the AI planner and its system prompts; conversation memory (also
  tenant-separated, but not part of the knowledge base); screens for staff to manage knowledge (this
  feature defines the trusted route, not the interface); safe display of answers to the user; tutorial
  authoring tools; quality tuning of search ranking; and any shared cross-tenant collection.
