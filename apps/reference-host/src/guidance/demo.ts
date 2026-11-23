import { composeReferenceHost } from "../compose.js";
import { createGuidanceHost } from "./compose-guidance.js";
import { GuidanceConfigError } from "./anthropic-model.js";
import { renderDemo } from "./demo-render.js";
const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.error('Usage: npm run guidance:demo -- "your question"'); process.exitCode = 2; }
else {
  let host: Awaited<ReturnType<typeof composeReferenceHost>>["host"] | undefined;
  try {
    const env = process.env;
    const starts: string[] = [];
    const guidance = createGuidanceHost({ env, starter: { start: id => { starts.push(id); return { ok: true }; } } });
    if (!env.DAP_DEMO_SESSION_TOKEN) throw new GuidanceConfigError("DAP_DEMO_SESSION_TOKEN is required");
    ({ host } = await composeReferenceHost(env, { extensions: [guidance.extension] }));
    const session = await host.openSession(env.DAP_DEMO_SESSION_TOKEN);
    if (!session) throw new GuidanceConfigError("DAP_DEMO_SESSION_TOKEN session was refused");
    console.log(renderDemo(await guidance.askAndStart(session, { query, semanticContext: { route: "profile", elements: [] } })));
  } catch (error) { console.error(error instanceof GuidanceConfigError ? error.message : "Guidance startup failed: check DAP_DATABASE_URL, dev session configuration, DAP_GUIDANCE_MODEL and ANTHROPIC_API_KEY."); process.exitCode = 1; }
  finally { if (host) await host.close().catch(() => {}); }
}
