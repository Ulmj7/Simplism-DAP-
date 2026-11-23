/**
 * The stylesheet of the embed, composed at BUILD time (vite emits it as `dap-embed.css` next to `dap-embed.js`; see vite.config.ts) and loaded by the embed as an external `<link rel="stylesheet">`
 * from the script's own origin. The embed never injects a `<style>` element and never writes a `style` attribute (positioning goes through the CSSOM), so a strict Content-Security-Policy works:
 *
 *   Content-Security-Policy: default-src 'none'; script-src 'self' https://dap.example; style-src 'self' https://dap.example; connect-src https://dap.example; img-src 'self'; base-uri 'none'; form-action 'none'
 *
 * (`https://dap.example` is the origin that serves `dap-embed.js`, `dap-embed.css` and the runtime API; an application that is itself the delivery origin needs only `'self'`. `connect-src` is needed
 * only for standalone delivery, which fetches the guide list and guide bundles from that origin without credentials.)
 */
const scoped = ".dap-guide-card, .dap-guide-scrim, .dap-guide-ring, .dap-result, .dap-launcher, .dap-launcher-panel";

/** `tokens.css` re-scoped from `:root` to the embed's own elements, the overlay rules without the application chrome (everything from `.guides-card` on), and the embed's own rules. */
export function composeEmbedStylesheet(tokens: string, overlay: string, embed: string): string {
  return tokens.replace(":root", `:is(${scoped})`) + overlay.split(".guides-card", 1)[0]!.replace(".result-actions", ".dap-result .result-actions") + embed;
}
