import { expect, it } from "vitest";
import { readBinding, readPage, settingKey, sitePattern, webOrigin } from "./site.js";

const origin = "http://127.0.0.1:5187";
const api = "http://127.0.0.1:8795";
const binding = { origin, apiOrigin: api, applicationId: "app-000000000001", runtimeKey: "rk-portal-runtime", enabled: true };

it("stores independent bindings and requests one exact scheme, host and port", () => {
  expect(webOrigin(origin + "/profile?q=1#details")).toBe(origin);
  expect(sitePattern(origin)).toBe("http://127.0.0.1:5187/*");
  expect(sitePattern("https://example.test")).toBe("https://example.test:443/*");
  expect(sitePattern("http://[::1]:3000")).toBe("http://[::1]:3000/*");
  expect(settingKey(origin)).not.toBe(settingKey("http://127.0.0.1:5188"));
  expect(readBinding(binding, origin)).toEqual(binding);
  expect(readBinding({ ...binding, enabled: false }, origin)?.enabled).toBe(false);
  expect(readBinding(binding, "http://127.0.0.1:5188")).toBeNull();
  expect(readBinding(binding, "https://127.0.0.1:5187")).toBeNull();
});

it("rejects unsupported documents and ambiguous settings before passing options to the SDK", () => {
  for (const url of ["file:///app", "chrome://newtab", "about:blank", "https://*.example.test", "https://user@example.test"]) {
    expect(webOrigin(url)).toBeNull();
  }
  for (const apiOrigin of [origin, api + "/", api + "?x=1", "file:///api", "https://user@example.test"]) {
    expect(readBinding({ ...binding, apiOrigin }, origin)).toBeNull();
  }
  expect(readBinding({ ...binding, applicationId: "app-ABC000000001" }, origin)).toBeNull();
  expect(readBinding({ ...binding, runtimeKey: "rk-bad/path" }, origin)).toBeNull();
});

it("requires a canonical origin and an identified document for a tab operation", () => {
  const page = { tabId: 7, documentId: "document-42", origin };
  expect(readPage(page)).toEqual(page);
  expect(readPage({ ...page, tabId: -1 })).toBeNull();
  expect(readPage({ ...page, documentId: "" })).toBeNull();
  expect(readPage({ ...page, origin: origin + "/path" })).toBeNull();
});
