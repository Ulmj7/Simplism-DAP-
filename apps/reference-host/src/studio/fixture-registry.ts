/**
 * A SECOND registry for tests (Studio V1A, D9): a different small application with its own routes, one public and one private element, one postcondition and its own
 * approved labels/pages. It is injected through `createRegistryCatalog([FIXTURE_ENTRY])`; it is never part of the production catalog and the host never imports it.
 * It exists to prove that validation, publication and the inspector use the APPLICATION's registry (a target valid for one registry is refused for the other).
 */
import type { RegistryEntry } from "./registries.js";

export const FIXTURE_ENTRY: RegistryEntry = {
  id: "fixture",
  label: "Second application",
  registry: {
    routes: ["home", "orders"],
    elements: [
      { id: "orders.exportButton", route: "orders", role: "button", label: "Export", description: "Exports the orders", operations: ["highlight", "click"], privacy: "public" },
      { id: "orders.customerEmail", route: "orders", role: "textbox", label: "Customer email", description: "Private customer address", operations: ["highlight", "input"], privacy: "private" },
    ],
    postconditionNames: ["orders.exported"],
  },
  browser: { labels: [{ role: "button", name: "Export" }], pages: { "/": "home", "/#/orders": "orders" } },
  previewable: false,
};
