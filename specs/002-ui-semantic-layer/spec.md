# Feature Specification: Secure UI Semantic Layer

**Feature Branch**: `002-ui-semantic-layer`

**Created**: 2026-11-13

**Status**: Draft. **SUPERSEDED (2026-11-16)** by [`specs/002-semantic-walkthrough-runtime`](../002-semantic-walkthrough-runtime/spec.md), a concise, delivery-scoped specification. This document is kept for history only. Its P1 intent (explicit registry, privacy annotations, sanitized context, unknown IDs fail closed) is carried into the new feature; its P2 preview and hidden-data catalogue items are OPTIONAL or FUTURE there.

**Input**: User description:

> Build the secure UI Semantic Layer used by the AI guidance system. The AI must never receive
> unrestricted raw DOM access. Application developers must explicitly register AI-visible UI
> elements. Each registered element must have: stable semantic ID; role; safe display label;
> sensitivity classification; allowed AI operations; current availability/state. Support developer
> privacy annotations such as data-ai-ignore, data-ai-private, data-ai-redact. Automatically exclude
> sensitive inputs including: password fields; authentication tokens; session values; API keys;
> hidden security fields; secrets. The generated AI context must expose only sanitized semantic
> metadata. The raw DOM, arbitrary selectors and sensitive element values must never be exposed to
> the LLM. All UI actions must reference registered semantic IDs. Unknown IDs fail closed.

## User Scenarios & Testing *(mandatory)*

**Who is involved.** The *application developer* builds the host product and decides what the AI may
know about its screens. The *end user* is the person whose screen is being described and guided, and
whose private data must stay on their device. The *security reviewer* verifies that nothing sensitive
can leave. The *AI planner* is an **untrusted consumer**: it receives a description of the page and
can only ask for on-screen guidance by naming elements the developer exposed.

**What this layer is.** A layer inside the user's browser that sits between the application's screens
and the AI. It does two jobs. Going out, it turns a page into a small, sanitized description built
only from elements developers explicitly registered. Coming in, it carries out approved on-screen
guidance (for example highlighting a button) but only on registered elements, and refuses everything
else. It never reads a page on the AI's behalf and never hands the AI a way to do so.

Every scenario below is exercised with a stand-in for the AI. No real LLM is involved.

### User Story 1 - Developers explicitly register AI-visible elements (Priority: P1)

An application developer decides which parts of a screen the AI may know about and registers each one
with six required properties: a stable semantic ID, a role, a safe display label, a sensitivity
classification, the operations the AI may request, and its current availability and state. Anything
not registered does not exist as far as the AI is concerned.

**Why this priority**: Registration is the allowlist for the whole feature. If the AI can learn about
an element nobody registered, every later protection is moot.

**Independent Test**: Render a page with registered and unregistered elements, generate the AI context,
and confirm only registered elements appear, each with exactly the six properties.

**Acceptance Scenarios**:

1. **Given** a developer registers an element with all six properties, **When** the page is shown,
   **Then** the element appears in the AI context with those properties and nothing else about it.
2. **Given** elements on the page that were never registered, **When** the context is generated,
   **Then** none appears in any form: no ID, no label, no role, and no count that would reveal them.
3. **Given** a registration that is missing a property or has an invalid one (unknown role, unknown
   operation, empty or over-long label, label containing control characters), **When** it is
   submitted, **Then** it is refused, nothing about the element is exposed, and the developer sees a
   diagnostic naming the problem.
4. **Given** two registrations using the same semantic ID, **When** the second is submitted, **Then**
   the second is refused and the first is unaffected.
5. **Given** a registered element is re-rendered, reordered, or the page is reloaded, **When** the
   context is generated again, **Then** it carries the same semantic ID as before.
6. **Given** user-generated or third-party content on the page that carries attributes resembling a
   registration, **When** the page is scanned, **Then** nothing is registered, because only application
   code can register an element.
7. **Given** a registered element is removed from the page, **When** the context is generated or an
   instruction targets it, **Then** it no longer appears and cannot be targeted.
8. **Given** any request from the AI side for information about a registered element, **When** it is
   answered, **Then** only the six properties are returned, and the page element itself, or any
   reference to it, is never reachable from outside the layer.

---

### User Story 2 - Sensitive inputs are excluded automatically (Priority: P1)

Password fields, authentication tokens, session values, API keys, hidden security fields, and secrets
never reach the AI, whether or not a developer remembered to protect them. Even if a developer
registers one by mistake, the layer refuses.

**Why this priority**: Leaking a credential to a model is the most damaging failure this feature
exists to prevent, and developers will sometimes make mistakes. Protection cannot depend on every
developer getting every annotation right.

**Independent Test**: Build pages containing one canary value in each sensitive category, run context
generation, and search every output for the canaries. Then try to register each sensitive element.

**Acceptance Scenarios**:

1. **Given** a page with a password field, an authentication-token holder, a session-value holder, an
   API-key field, a hidden security field (such as an anti-forgery value), and a secret field,
   **When** the context is generated, **Then** none of them appears: no ID, label, role, value, or any
   hint that it exists.
2. **Given** a developer registers one of those elements, **When** the registration is submitted,
   **Then** it is refused, the element stays excluded, and the developer sees a diagnostic.
3. **Given** a password field whose "show password" control turns it into a plain text box, **When** the
   context is generated, **Then** the element is still excluded, because an element's classification
   can only become stricter during its lifetime.
4. **Given** a label or other string headed for the context that looks like a credential (token-shaped
   or key-shaped), **When** the context is generated, **Then** the string is replaced or the
   registration is refused, and the credential-like text is never emitted.
5. **Given** any form control, including a non-sensitive one, **When** the context is generated,
   **Then** its current value never appears; only a small fixed set of state flags does.
6. **Given** cookies, browser storage, or authorization headers, **When** the context is generated,
   **Then** they are never read and never appear.
7. **Given** a developer adds a stricter exclusion rule for their own sensitive category, **When** the
   context is generated, **Then** matching elements are excluded, while an attempt to remove or weaken
   a built-in rule is refused.

---

### User Story 3 - Developers control privacy with annotations (Priority: P1)

Developers can mark any part of a screen with `data-ai-ignore`, `data-ai-private`, or
`data-ai-redact` to restrict what the AI learns, including content the developer did not register
(for example a third-party widget). Annotations only ever restrict, never grant.

**Why this priority**: Registration says what is visible, but real screens mix sensitive and ordinary
content. Developers need a simple, local way to carve out the parts that must stay private.

**Independent Test**: Apply each annotation, nested and conflicting combinations, and runtime changes
to a page of registered elements, and check the context and instruction results each time.

**Acceptance Scenarios**:

1. **Given** `data-ai-ignore` on an element, **When** the context is generated, **Then** that element
   and everything inside it are absent, including registered descendants.
2. **Given** `data-ai-private` on an element, **When** the context is generated, **Then** the element
   appears only as a placeholder (its semantic ID, role, developer-supplied label, and availability),
   and its contents and descendants do not appear.
3. **Given** `data-ai-redact` on an element, **When** the context is generated, **Then** the display
   labels of the element and of its registered descendants are replaced by one fixed marker, with no
   partial masking and no length or format hint, while their IDs, roles, and state remain.
4. **Given** annotations on both a parent and a child that conflict, **When** the context is
   generated, **Then** the most restrictive one among the element and its ancestors applies, and a
   child can never loosen what an ancestor restricts.
5. **Given** an annotation is added or removed while the page is open, **When** the next context is
   generated or the next instruction arrives, **Then** the change is already in effect.
6. **Given** a region with no annotation and no registration, **When** the context is generated,
   **Then** it is still invisible, because annotations never grant visibility.

---

### User Story 4 - The AI context exposes only sanitized semantic metadata (Priority: P1)

What the AI receives is a small, structured description: which page this is, its logical route, and
the list of registered elements with their six properties. It never contains raw markup, selectors,
element paths, text content, form values, or page addresses carrying secrets.

**Why this priority**: This is the output contract. Everything the AI will ever know about a screen is
decided here, so it must be narrow, predictable, and checkable.

**Independent Test**: Generate contexts for varied pages and validate each against the closed context
shape. Search them for markup, selector syntax, canary values, and query strings.

**Acceptance Scenarios**:

1. **Given** a page with registered elements, **When** the context is generated, **Then** it contains
   only the context version, page identity, route template, and the element list.
2. **Given** an address with a query string or fragment that carries a token, **When** the context is
   generated, **Then** the route appears only as a template, dynamic segments are replaced by
   placeholders, and the query string and fragment are never included.
3. **Given** a page's markup, element text, attribute values, form values, and screenshots, **When**
   the context is generated, **Then** none of them is included.
4. **Given** a page with more elements than the configured limits allow, **When** the context is
   generated, **Then** it is cut down in a documented, deterministic order, an explicit marker says it
   was shortened, and no unsanitized overflow is emitted.
5. **Given** the same page state, **When** the context is generated twice, **Then** the two results are
   identical.
6. **Given** an error while generating, or the registry is not ready yet, **When** a context is
   requested, **Then** nothing is sent or only an empty minimal context is, and the layer never falls
   back to raw page data.
7. **Given** a label containing control characters, text-direction overrides, zero-width characters,
   markup, or characters meant to break the context's structure, **When** the context is generated,
   **Then** the label is sanitized or its registration refused, and the context's structure is intact.

---

### User Story 5 - UI actions reference only registered semantic IDs; unknown IDs fail closed (Priority: P1)

When the AI side asks the page to do something on screen (highlight a button, scroll to a section,
show a tooltip, move focus), the request names a semantic ID. The layer carries it out only if the ID
is registered, the element is present and currently available, and that operation is allowed for it.
Anything else changes nothing and gives the same bland answer.

**Why this priority**: This is the other half of the boundary. A perfect context is worthless if the AI
can then act on elements it was never told about, or by selector.

**Independent Test**: Send a mix of valid and hostile instructions (unknown IDs, selectors, excluded
elements, disallowed operations, stale elements, markup in tooltips) and verify that only the valid
ones have any effect.

**Acceptance Scenarios**:

1. **Given** an approved instruction for a registered, present, available element and an allowed
   operation, **When** it arrives, **Then** it is performed.
2. **Given** an instruction naming an ID that is not registered, **When** it arrives, **Then** nothing
   happens and the caller gets a generic "not performed" answer.
3. **Given** an instruction naming an element that is excluded, hidden inside a `data-ai-private`
   placeholder, or hidden by `data-ai-ignore`, **When** it arrives, **Then** the answer is identical to
   the one for an unknown ID, so the AI cannot tell that such an element exists.
4. **Given** a registered element and an operation that is not in its allowed list, **When** the
   instruction arrives, **Then** it is rejected.
5. **Given** a registered element that is currently missing, hidden, or unavailable, **When** an
   instruction arrives, **Then** it is rejected, and the layer does not look for a similar element or
   fall back to a selector or text match.
6. **Given** an instruction whose target is a selector, element path, coordinate, index, or text to
   match instead of a semantic ID, **When** it arrives, **Then** it is rejected.
7. **Given** a tooltip whose text includes markup, scripts, or links, **When** it is shown, **Then** it
   appears as inert plain text of bounded length with no active content.
8. **Given** highlights and tooltips on screen, **When** the user interacts with the page, **Then** the
   AI-drawn visuals never capture clicks or keystrokes and never cover the application's trusted
   dialogs, including confirmation dialogs.
9. **Given** an instruction that would change application data, **When** it arrives, **Then** this
   layer does not perform it: the only path is a request handed to the existing authorization
   boundary, and no simulated click, typing, value-setting, or submission exists.
10. **Given** a malformed or oversized instruction, or instructions arriving faster than the bounded
    rate, **When** they arrive, **Then** they are rejected instead of being queued without limit.
11. **Given** a tooltip or highlight on screen, **When** a user relies on a screen reader, keyboard-only
    navigation, or a reduced-motion preference, **Then** the guidance is announced to assistive
    technology, can be dismissed from the keyboard, does not trap focus, and does not animate.

---

### User Story 6 - Developers can preview exactly what the AI sees (Priority: P2)

A developer can look at the exact sanitized context that would be sent, together with diagnostics that
explain what was refused or excluded and why, so they can check privacy before shipping.

**Why this priority**: Developers cannot protect what they cannot inspect. Previews make mistakes
visible early, but the protections themselves work without this tool.

**Independent Test**: Open the preview on a page with registrations, refusals, annotations, and
sensitive fields, and compare it with the context the layer actually produces.

**Acceptance Scenarios**:

1. **Given** a developer opens the preview, **When** it displays, **Then** it shows the exact context
   that would be sent and nothing the context would not contain.
2. **Given** refused registrations, conflicts, automatic exclusions, and annotation effects, **When** the
   developer views diagnostics, **Then** each is listed with a reason and no sensitive value.
3. **Given** diagnostics and the preview, **When** the context is sent anywhere, **Then** neither is
   part of it, and neither is reachable from the AI side.

---

### User Story 7 - Hidden-data tests join the shared security catalogue (Priority: P2)

The security test catalogue from the AI Security Foundation reserved a "hidden-data exposure" category
for this feature. This feature fills it: ready-made fixture pages with canary values, plus scenarios
that prove nothing sensitive reaches the AI.

**Why this priority**: Privacy claims must be provable, repeatably, in CI. Without shared scenarios,
each team would invent its own and some would skip it.

**Independent Test**: Run the scenarios against the fixture pages, deliberately weaken one protection,
and confirm a scenario fails and names the gap.

**Acceptance Scenarios**:

1. **Given** fixture pages containing a canary value in every sensitive category, **When** every
   scenario runs, **Then** no canary appears in any context, instruction result, or developer-facing
   output that leaves the page.
2. **Given** the shared security catalogue, **When** this feature is added, **Then** its hidden-data
   scenarios run alongside the others and are reported in the same coverage report.
3. **Given** randomly generated page structures with random annotations and registrations, **When**
   contexts are generated repeatedly, **Then** no canary ever appears.
4. **Given** each automatic exclusion category and each annotation, **When** the coverage report runs,
   **Then** each has at least one test that proves exclusion and one that proves normal content is not
   wrongly hidden.
5. **Given** the privacy-filtering logic, **When** its own test suite runs on its own, **Then** it
   passes without the rest of the layer being present.

---

### Edge Cases

- **"Show password" toggle**: an excluded field that changes its type to plain text stays excluded for
  the rest of its lifetime. Classification only ratchets stricter.
- **Registered element inside an ignored area**: the element is excluded, its registration is inert, and
  the developer gets a diagnostic.
- **Duplicate IDs from two components**: the second registration is refused and the first keeps working.
- **Annotation changes after registration**: effective for the next context and re-checked when each
  instruction arrives, so an element that becomes restricted stops being targetable immediately.
- **Page changes between context and instruction**: the instruction is validated against the page as it
  is now, not as it was when the context was made. A vanished element means "not performed".
- **Excluded versus unknown**: the layer gives the same answer for an excluded element and a nonexistent
  one, so failures cannot be used to discover hidden elements.
- **Look-alike or unusual IDs**: IDs are limited to a plain character set and exact matching. Look-alike
  characters, different letter case, and extra whitespace do not match.
- **Secret-shaped text in a label**: replaced or refused, never emitted.
- **Very large pages**: limits apply and the result is shortened deterministically with a visible marker.
- **Not-yet-ready or failing layer**: sends nothing or an empty context, never a raw fallback.
- **Content in other frames or closed component boundaries**: not reachable, so it cannot be registered
  or described.
- **Addresses with secrets in the query or fragment**: reported only as a route template.
- **Instructions arriving faster than they can be shown**: excess instructions are rejected rather than
  queued without bound.
- **User-generated content that contains `data-ai-*` attributes**: such attributes can only restrict, so
  they cannot expose anything.
- **A tooltip anchored near a private placeholder**: allowed, and shows only the AI's plain text, never
  the element's contents.

## Requirements *(mandatory)*

### Functional Requirements

**Registration**

- **FR-001**: The AI MUST learn about a page element only if application code has explicitly
  registered it. Unregistered elements MUST NOT appear in any form, including counts or indirect hints.
- **FR-002**: Registration MUST be possible only from application code. Page markup, attributes, and
  user-generated or third-party content MUST NOT be able to register, alter, or remove a registration.
- **FR-003**: Every registered element MUST have all six properties: a semantic ID, a role, a safe
  display label, a sensitivity classification, a set of allowed AI operations, and a current
  availability and state. A registration missing any property, or holding an invalid value, MUST be
  refused with a developer diagnostic and MUST expose nothing.
- **FR-004**: A semantic ID MUST be chosen by the developer, stay the same across re-renders, reordering,
  reloads, and releases, be unique within a page, use a plain restricted character set within a bounded
  length, and MUST NOT be derived from element position, style classes, text content, or generated
  counters. Duplicate IDs MUST be refused.
- **FR-005**: A role MUST come from a closed vocabulary of common interface roles (for example button,
  link, text input, checkbox, tab, dialog, region). An unknown role MUST be refused.
- **FR-006**: The allowed operations MUST come from a closed vocabulary: highlight, focus, scroll-to,
  tooltip, and request-action. The vocabulary MUST NOT include click, type, set-value, submit, or any
  operation that accepts arbitrary targets or content.
- **FR-007**: The display label MUST be supplied by the developer, MUST be non-empty, MUST NOT exceed a
  configurable maximum length (default 80 characters), and MUST NOT contain control characters,
  text-direction overrides, zero-width characters, or markup. The layer MUST NOT silently take a label
  from the page's visible text.
- **FR-008**: Every registered element MUST carry one sensitivity classification declared by the
  developer at registration: PUBLIC, REDACTED, or PRIVATE. Annotations and automatic rules can only
  make the effective classification stricter, up to EXCLUDED. EXCLUDED MUST NOT be a registrable
  classification.
- **FR-009**: Availability and state MUST be computed live from the page, not claimed by the developer,
  and MUST be limited to a closed set of flags (for example visible, enabled, required, checked,
  expanded, selected, invalid). State MUST NOT include any content or value.
- **FR-010**: A registration MUST last no longer than its element. A removed element MUST disappear from
  the context and MUST NOT remain targetable.
- **FR-011**: There MUST be exactly one registry per page, and no element handle or reference held by it
  MUST ever be exposed to the AI or to any code that sends data out.

**Privacy annotations**

- **FR-012**: `data-ai-ignore` MUST remove the element and its entire subtree from the context and from
  targeting, including registered descendants.
- **FR-013**: `data-ai-private` MUST reduce the element to a placeholder (semantic ID, role,
  developer-supplied label, availability) and MUST exclude its contents and descendants.
- **FR-014**: `data-ai-redact` MUST replace the display labels of the element and of its registered
  descendants with one fixed marker, with no partial masking and no length or format hint, while
  keeping their IDs, roles, and state visible. Content is never included in any case; this protects
  labels a developer builds from live data.
- **FR-015**: When annotations conflict, the most restrictive annotation among the element and its
  ancestors MUST apply. A descendant MUST NOT be able to loosen what an ancestor restricts.
- **FR-016**: Annotations MUST only restrict. A region without a registration MUST stay invisible
  whatever its annotations say.
- **FR-017**: Annotation changes at runtime MUST take effect for the next generated context and for the
  next arriving instruction.

**Automatic exclusion**

- **FR-018**: The layer MUST automatically exclude, whether or not the element is registered or
  annotated: password fields, authentication tokens, session values, API keys, hidden security fields
  (including anti-forgery values), and secrets.
- **FR-019**: Detection MUST combine independent signals (for example control type, declared input
  purpose, hidden status, naming hints, and the shape of any value that must be examined) so that no
  single signal is a single point of failure.
- **FR-020**: Registering an automatically excluded element MUST be refused (fail closed) with a
  developer diagnostic.
- **FR-021**: An element's classification MUST only become stricter during its lifetime until it is
  unregistered, so that a changing control cannot slip back into view.
- **FR-022**: No form-control value, in any classification, MUST appear in the context. Cookies, browser
  storage, and authorization headers MUST never be read.
- **FR-023**: Every string headed for the context MUST be checked for credential-like shapes
  (token-shaped, key-shaped). A match MUST cause the string to be replaced or the registration refused,
  and the matching text MUST NOT be emitted.
- **FR-024**: Developers MUST be able to add stricter exclusion rules. Built-in rules MUST NOT be
  removable or weakened.

**Context generation**

- **FR-025**: The generated context MUST contain only: a context version, the page identity, the route
  template, and the list of registered elements with their six properties. It MUST follow a closed
  shape that rejects any other field.
- **FR-026**: The page identity MUST be a developer-registered logical name. The route MUST be reported
  as a template with dynamic segments replaced by placeholders, and the query string and fragment MUST
  NEVER be included.
- **FR-027**: The context MUST NOT contain raw markup, CSS selectors, element paths, attribute values,
  text content, form values, element positions, or screenshots.
- **FR-028**: Strings in the context MUST be plain text, sanitized of control, text-direction, and
  zero-width characters and markup, and MUST be unable to break the context's structure. The context
  MUST be structured data, not free-form prose.
- **FR-029**: The context size MUST be bounded by configurable limits on the number of elements and total
  size. When exceeded, the context MUST be shortened in a documented deterministic order with an
  explicit marker and MUST NOT emit anything unsanitized.
- **FR-030**: The same page state MUST always produce the same context.
- **FR-031**: Any internal error, or a registry that is not yet ready, MUST result in no context or an
  empty minimal context. The layer MUST NOT fall back to raw page data.
- **FR-032**: All sanitization MUST happen in the user's browser, before anything is transmitted.
  Removal by a server or by the AI after receipt does not satisfy this requirement.

**UI instruction handling**

- **FR-033**: Every UI instruction MUST identify its target only by semantic ID. Selectors, element paths,
  coordinates, indices, and text to match MUST be rejected.
- **FR-034**: An instruction MUST be performed only if all of these hold at the moment it arrives: its
  shape is valid; the ID is registered; the element is present and not hidden by an annotation or
  automatic exclusion; the operation is in the element's allowed list; and the element is currently
  available. Otherwise it MUST be rejected with no effect. The layer MUST NOT search for similar
  elements or fall back to any other targeting.
- **FR-035**: A rejection for an unknown ID, an excluded element, an annotation-hidden element, or a
  vanished element MUST be indistinguishable to the caller, and MUST cause no visible change.
- **FR-036**: The result returned to the caller MUST be limited to whether the instruction was performed
  and a coarse generic category. It MUST NOT reveal any element detail.
- **FR-037**: Tooltip and message text MUST be shown as inert plain text of bounded length, with markup,
  links, scripts, and control characters neutralized.
- **FR-038**: AI-drawn visuals MUST NOT capture pointer or keyboard input, MUST appear beneath the
  application's trusted dialogs, and MUST NOT obscure confirmation dialogs.
- **FR-039**: This layer MUST NOT perform any operation that changes application data. The
  request-action operation MUST only pass a request to the existing authorization boundary. The layer
  MUST NOT provide simulated clicks, typing, value-setting, form submission, arbitrary script
  execution, arbitrary network requests, or selector-based control.
- **FR-040**: AI-rendered guidance MUST be perceivable by assistive technology, dismissible from the
  keyboard, MUST NOT trap focus, and MUST respect the user's reduced-motion preference.
- **FR-041**: Instructions larger than a bounded size, or arriving faster than a bounded rate, MUST be
  rejected rather than queued without limit.

**Developer tooling and verification**

- **FR-042**: A development-time preview MUST show exactly the context that would be sent, and
  diagnostics MUST list refused registrations, conflicts, automatic exclusions, and annotation effects
  with reasons. Neither the preview nor the diagnostics MUST ever be part of the context, reachable by
  the AI side, or contain a sensitive value.
- **FR-043**: Hidden-data exposure scenarios MUST be added to the shared security test catalogue,
  together with fixture pages that hold a canary value in every automatic-exclusion category, and MUST
  run in continuous integration.
- **FR-044**: Randomized page structures with randomized annotations and registrations MUST be tested
  repeatedly, with the invariant that no canary value ever appears in any output.
- **FR-045**: A coverage report MUST show that each automatic-exclusion category and each annotation has a
  test proving exclusion and a test proving ordinary content is not hidden by mistake.
- **FR-046**: The privacy-filtering logic MUST be its own self-contained unit with its own tests.
- **FR-047**: Semantic IDs defined here MUST be the same identifiers that on-screen instructions from the
  AI Security Foundation use. This layer receives instructions only after that boundary has approved
  them and MUST NOT itself make authorization decisions.

### Key Entities *(include if feature involves data)*

- **AI-Visible Element**: One thing on a page that a developer has chosen to expose. Has a semantic ID,
  role, safe label, sensitivity classification, allowed operations, and live availability and state.
- **Semantic ID**: A developer-chosen, stable, page-unique name for an element. The only way an
  instruction may refer to an element.
- **Role**: The element's kind, from a closed vocabulary of common interface roles.
- **Safe Display Label**: A short, developer-supplied, sanitized plain-text name that the AI uses to
  talk about the element.
- **Sensitivity Classification**: PUBLIC, REDACTED, PRIVATE, or EXCLUDED. Controls how much of an element
  can be described.
- **Allowed Operation**: One of highlight, focus, scroll-to, tooltip, request-action. Per element, a
  subset the developer permits.
- **Element State**: A closed set of non-content flags (visible, enabled, required, checked, expanded,
  selected, invalid) computed live.
- **Privacy Annotation**: `data-ai-ignore`, `data-ai-private`, or `data-ai-redact` placed on page
  content to restrict what the AI learns. Never grants visibility.
- **Automatic Exclusion Rule**: A built-in rule that removes a category of sensitive content
  (passwords, tokens, session values, API keys, hidden security fields, secrets) regardless of
  registration.
- **Registry**: The page's single set of current registrations. Never exposed to the AI.
- **Semantic Context**: The sanitized, closed-shape description of a page sent to the AI side: version,
  page identity, route template, and element list.
- **Route Template**: A page address with dynamic segments replaced by placeholders and no query string
  or fragment.
- **UI Instruction**: An already-approved request to do something on screen to a named semantic ID.
- **Instruction Result**: A generic "performed or not performed" answer with a coarse category.
- **Diagnostic**: A developer-only note explaining a refusal, conflict, or exclusion. Never sent anywhere
  outside development tooling.
- **Canary Value**: A unique fake sensitive value planted in test pages to prove it never leaks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across a fixture set that holds a canary value in each of the six sensitive categories
  (password, authentication token, session value, API key, hidden security field, secret), 0 canary
  values appear in any generated context, instruction result, or any output that leaves the page, and
  0 of those elements' IDs, labels, or roles appear.
- **SC-002**: 100% of generated contexts validate against the closed context shape, and 0 contain raw
  markup, selector syntax, element paths, text content, form values, query strings, or fragments.
- **SC-003**: 100% of instructions naming an unknown, unregistered, excluded, annotation-hidden, or
  vanished ID are rejected with identical responses and 0 visible changes to the page.
- **SC-004**: 100% of registration attempts for automatically excluded elements are refused, including
  after a control changes type at runtime.
- **SC-005**: Over all combinations of the three annotations nested up to depth 4, the most restrictive
  outcome applies in 100% of cases and no descendant ever loosens an ancestor.
- **SC-006**: Semantic IDs are identical in 100% of runs across 100 re-renders, reorderings, and
  reloads of the same page.
- **SC-007**: Every generated context stays within the configured size limits, and when shortened, 100%
  carry the explicit marker and an identical deterministic result for the same page state.
- **SC-008**: 100% of registrations missing any of the six properties, or holding an invalid value, are
  refused with a diagnostic that names the problem.
- **SC-009**: Generating a context for a page with 200 registered elements takes under 100 milliseconds
  at the 95th percentile and never blocks the page's interface for more than 50 milliseconds, measured
  on one fixed reference laptop named in the plan (a four-core machine from the last five years).
- **SC-010**: 100% of labels and tooltips containing control characters, text-direction overrides,
  zero-width characters, markup, or credential-like shapes are sanitized, replaced, or refused, and
  0 scripts, links, or markup become active in any test.
- **SC-011**: In 100% of interaction tests, AI-drawn visuals capture no input and never cover a trusted
  dialog.
- **SC-012**: Over 1,000 randomized page structures with randomized annotations and registrations, 0
  canary values appear in any output, and two runs of the full hidden-data suite produce identical
  results.
- **SC-013**: In a developer review exercise, a developer can use only the preview and diagnostics to
  state exactly what the AI would learn about a page, and what was withheld and why, for 100% of
  sampled pages.

## Assumptions

- **Governing rules**: The project constitution (v1.0.0) binds this feature, in particular Principles VI
  (sensitive data removed client-side before transmission), VII (no unrestricted page control), XII
  (retrieved or page text is untrusted data), and XVI (minimal context, fail closed).
- **Relationship to the AI Security Foundation**: That feature listed this layer as out of scope and
  reserved a hidden-data test category for it. This layer supplies the element IDs that feature's
  on-screen instructions refer to, and receives only instructions that boundary has approved.
- **Runs in the user's browser, same page only**: Content in separate frames or behind closed component
  boundaries cannot be reached, so it cannot be registered or described.
- **The browser is untrusted from the server's point of view**: Client-side sanitization protects the
  user's data from leaving their device. It is not a defence against the user themselves. The receiving
  side treats the context as untrusted data that informs guidance only and never authorizes anything.
- **Developer-supplied labels only**: Labels come from developers, never implicitly from visible page
  text. A label a developer builds from live data is still sanitized and subject to redaction, and is
  treated downstream as untrusted text, never as an instruction.
- **No form values, ever**: No classification exposes a field's value. This is stricter than strictly
  necessary, and it keeps the rule simple and checkable. State is limited to a closed set of flags.
- **Guiding users to sensitive fields**: Because sensitive inputs are excluded, a developer who wants
  the AI to point at a login form registers a non-sensitive neighbour such as the field group or its
  caption. A placeholder mode for sensitive fields is a possible future extension, not part of this
  feature.
- **Annotation meanings**: `data-ai-ignore` hides an element and its subtree entirely. `data-ai-private`
  collapses an element to a placeholder. `data-ai-redact` keeps the element and its registered
  descendants but masks their labels with one fixed marker (protecting labels built from live data).
  Defaults chosen because the description names the three annotations without defining them.
- **Navigation**: This layer targets elements only. Moving the user to another page is expressed by
  pointing at a registered link or button. Automatic route changes are a separate, allowlisted
  capability handled by the authorization boundary and are outside this feature, which keeps every
  action here tied to a registered semantic ID.
- **Routes**: Reported as templates (dynamic segments replaced by placeholders) because page addresses
  often carry identifiers or tokens.
- **On demand only**: A context is generated only when AI guidance is active for the user, never
  continuously in the background.
- **Configurable limits**: Maximum label length, maximum number of elements, maximum context size,
  maximum instruction size and rate, and maximum tooltip length are configurable. Specific default
  numbers beyond those stated are chosen during planning.
- **Performance targets**: SC-009 states a target for a fixed reference laptop. It is a design target
  confirmed during planning, not a measured result.
- **Out of scope (separate later features)**: reporting user interface events back to the AI (for
  example waiting for a click); the AI planner, its prompts, and retrieval over documents; tutorial or
  walkthrough authoring tools; screenshots or visual capture of any kind; native mobile or desktop
  interfaces; server-side changes to the Policy Gateway; and no-code tools for tagging elements.
