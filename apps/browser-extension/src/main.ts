import { createSimplism } from "../../reference-web/dist/sdk/index.js";
import type { ErrorCode, Simplism } from "../../reference-web/dist/sdk/index.js";
import { readBinding } from "./site.js";
import type { PageReply } from "./site.js";

type Command = "verify" | "attach" | "open" | "refresh" | "detach";
type Bridge = (command: Command, site: string, raw?: unknown) => Promise<PageReply>;

// Runtime V1's cross-bundle owner slot is shared by the published package. Preserve a
// direct SDK owner, even when createSimplism would return that instance for identical options.
const sdkOwner = Symbol.for("simplism.runtime.v1");
const bridgeKey = Symbol.for("simplism.browser-extension.v1");
const page = window as Window & { [bridgeKey]?: Bridge; [sdkOwner]?: unknown };
if (window === window.top && !Object.hasOwn(page, bridgeKey)) {
  let instance: Simplism | undefined;
  let ownership: unknown;
  let configuration: string | undefined;
  const release = () => {
    if (instance && Object.hasOwn(page, sdkOwner) && page[sdkOwner] === ownership) instance.destroy();
    instance = undefined;
    ownership = undefined;
    configuration = undefined;
  };
  const failure = (code: ErrorCode): PageReply => {
    release();
    return { status: code === "APPLICATION_UNAVAILABLE" || code === "NETWORK_UNAVAILABLE" || code === "INVALID_RESPONSE"
      ? code : "UNAVAILABLE" };
  };

  const bridge: Bridge = async (command, site, raw) => {
    if (location.origin !== site || window !== window.top) return { status: "SITE_CHANGED" };
    if (command === "detach") { release(); return { status: "DETACHED" }; }
    const binding = readBinding(raw, site);
    if (!binding || !binding.enabled) return { status: "INVALID_CONFIGURATION" };
    if (command === "verify") {
      // Use the same public delivery endpoint from the actual application origin.
      // A 200 also validates a site with zero published guides.
      const url = `${binding.apiOrigin}/api/runtime/${encodeURIComponent(binding.runtimeKey)}/guides?applicationId=${binding.applicationId}`;
      try {
        const response = await fetch(url, {
          mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 404) return { status: "APPLICATION_UNAVAILABLE" };
        if (response.status !== 200) return { status: "NETWORK_UNAVAILABLE" };
        const json = response.headers.get("content-type")?.toLowerCase().includes("application/json");
        void response.body?.cancel().catch(() => undefined);
        return { status: json ? "VERIFIED" : "INVALID_RESPONSE" };
      } catch { return { status: "NETWORK_UNAVAILABLE" }; }
    }
    if (command !== "attach" && command !== "open" && command !== "refresh") return { status: "UNAVAILABLE" };

    const key = JSON.stringify([binding.applicationId, binding.runtimeKey, binding.apiOrigin]);
    if (instance && (configuration !== key || !Object.hasOwn(page, sdkOwner) || page[sdkOwner] !== ownership)) release();
    if (!instance) {
      if (Object.hasOwn(page, sdkOwner)) return { status: "DIRECT_RUNTIME" };
      const prepared = createSimplism(binding);
      if (!prepared.ok) return { status: prepared.code === "ALREADY_INITIALIZED" ? "DIRECT_RUNTIME" : "INVALID_CONFIGURATION" };
      instance = prepared.value;
      ownership = page[sdkOwner];
      configuration = key;
    }

    const current = instance;
    if (command === "open") {
      const opened = await current.openLauncher();
      if (!opened.ok) return failure(opened.code);
    }
    const catalog = command === "refresh" ? await current.listGuides() : await current.start();
    if (!catalog.ok) return failure(catalog.code);
    return { status: catalog.value.length ? "READY" : "EMPTY", css: true };
  };
  Object.defineProperty(page, bridgeKey, { value: bridge });
}
