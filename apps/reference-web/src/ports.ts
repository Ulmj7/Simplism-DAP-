import type { RouterPort, SemanticRegistry, TargetPort } from "@dap/walkthrough";
import type { Targets } from "@dap/walkthrough/dom";
import type { Router, Route } from "./router.js";
export const createRouterPort = (router: Router, registry: SemanticRegistry): RouterPort => ({ current: () => router.current(), navigate(route) { if (registry.routes.includes(route)) router.navigate(route as Route); } });
export const createTargetPort = (targets: Targets): TargetPort => ({ resolve: id => targets.find(id) === null ? "unavailable" : "available" });
