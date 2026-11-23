import { expect, it } from "vitest";
import * as dom from "./index.js";

it("the DOM adapter entry exports the targets and overlay factories", () => {
  expect(typeof dom.createTargets).toBe("function");
  expect(typeof dom.createOverlay).toBe("function");
});
