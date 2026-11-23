/**
 * The ONE builder of the guide bundle (Studio COMPLETION, S7). The maintainer route `GET /api/walkthroughs/published/:id/bundle` and the key-addressed runtime route
 * `GET /api/runtime/:key/guides/:id` both call it, so what a signed-in user's Studio and an independent application's embed receive cannot drift:
 *
 *   { definition, application: { id, name, origin },
 *     registry: { routes, elements: [{ id, marker, route, role, label, description, operations, privacy }], postconditionNames, checks, routing, pages },
 *     version }
 *
 * `marker` is the `data-ai-id` the embed resolves in the page (equal to the target id for now: a later order lets a repaired target keep its id and change its marker),
 * `checks` is the list of verification checks (empty for now), `routing` is the application's `hash` | `history`, and `pages` maps a page (a `/#/...` hash page or a pathname) to its route.
 * `version` is the live version of the guide (always 1 for now). Public elements only; nothing of the tenant or of another application is ever in it.
 */
import type { ValidationResult } from "../authoring/validate.js";
import type { ApplicationRecord } from "./applications.js";
import type { ResolvedRegistry } from "./registry-resolver.js";

/** The validated definition type (the host may import the walkthrough validator package only inside src/authoring: the type comes through its re-export). */
type ValidDefinition = Extract<ValidationResult, { readonly ok: true }>["definition"];

export interface GuideBundle {
  readonly definition: ValidDefinition;
  readonly application: { readonly id: string; readonly name: string; readonly origin: string };
  readonly registry: {
    readonly routes: readonly string[];
    readonly elements: readonly {
      readonly id: string; readonly marker: string; readonly route: string; readonly role: string; readonly label: string; readonly description: string;
      readonly operations: readonly string[]; readonly privacy: "public";
    }[];
    readonly postconditionNames: readonly string[];
    readonly checks: readonly never[];
    readonly routing: "hash" | "history";
    readonly pages: Readonly<Record<string, string>>;
  };
  readonly version: number;
}

export function buildGuideBundle(input: { readonly definition: ValidDefinition; readonly application: ApplicationRecord; readonly resolved: ResolvedRegistry; readonly version?: number }): GuideBundle {
  const { definition, application, resolved } = input;
  const { registry, pages } = resolved;
  return {
    definition,
    application: { id: application.id, name: application.name, origin: application.origin },
    registry: {
      routes: registry.routes,
      elements: registry.elements.filter((element) => element.privacy === "public").map((element) => ({
        id: element.id, marker: element.id, route: element.route, role: element.role, label: element.label, description: element.description, operations: [...element.operations], privacy: "public" as const,
      })),
      postconditionNames: registry.postconditionNames,
      checks: [],
      routing: application.routing,
      pages,
    },
    version: input.version ?? 1,
  };
}
