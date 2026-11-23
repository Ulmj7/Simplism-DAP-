// Plain data describing fixture application "B" for the host: its trusted registry (what a walkthrough may
// target) and its browser policy (which labelled controls may leave the adapter, and which pages exist).
// Structural literal on purpose: it imports no host code. The registry mirrors the shape of the host's
// TrustedRegistryData and the browser entry the host's registry catalog will carry.
const element = (id, route, role, label, description, operations) =>
  Object.freeze({ id, route, role, label, description, operations: Object.freeze(operations), privacy: "public" });

export const fixtureB = Object.freeze({
  id: "fixture-b",
  label: "Fixture application B",
  registry: Object.freeze({
    routes: Object.freeze(["home", "orders"]),
    elements: Object.freeze([
      element("nav.orders", "home", "link", "Orders link", "Opens the orders page", ["highlight", "click"]),
      element("orders.submit", "orders", "button", "Submit order", "Submits the order", ["highlight", "click"]),
      element("orders.note", "orders", "textbox", "Order note", "A note for the order", ["highlight", "input"]),
    ]),
    postconditionNames: Object.freeze(["order.submitted", "route.orders"]),
  }),
  browser: Object.freeze({
    labels: Object.freeze([
      Object.freeze({ role: "link", name: "Orders" }),
      Object.freeze({ role: "button", name: "Submit order" }),
      Object.freeze({ role: "textbox", name: "Order note" }),
    ]),
    // Keys are `pathname + hash` exactly as the adapter compares them. The two leave routes exist so the
    // domain-escape probe can start there: the route is approved, only the redirect target is not.
    pages: Object.freeze({
      "/": "home",
      "/#/home": "home",
      "/#/orders": "orders",
      "/#/dense": "home",
      "/#/leave-origin": "home",
      "/#/leave-host": "home",
    }),
  }),
});
