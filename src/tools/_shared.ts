import {
  CONFIRM_FLOW_SENTENCE,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  minifiedResult,
  untrustedResult,
} from '@chrischall/mcp-utils';

/**
 * Sentence every write tool's description ends with, so the confirmation flow
 * is stated identically everywhere — mcp-utils' shared `CONFIRM_FLOW_SENTENCE`,
 * with the leading space the `description + CONFIRMS + UNVERIFIED` concatenation
 * needs.
 */
export const CONFIRMS = ` ${CONFIRM_FLOW_SENTENCE}`;

/**
 * The `notes` preview field every write passes to mcp-utils' `confirmWrite`:
 * always leads with "Nothing has been sent yet." so the model cannot mistake
 * the phase-1 preview for a completed write. Shown in the preview and bound
 * into the confirmation alongside the request.
 */
export function previewNotes(...notes: string[]): { notes: string[] } {
  return { notes: ['Nothing has been sent yet.', ...notes] };
}

// `minifiedResult` only. This seam re-exported both for a while, and every
// tool went on importing `jsonResult` — @chrischall/mcp-utils' alias for the
// PRETTY `textResult` — so the re-export was the only trace of a minification
// that never happened. Exporting one name makes the wrong choice unavailable
// rather than merely discouraged.
export { minifiedResult };

/**
 * Marker appended to the description of every tool whose request shape was
 * derived from the web app's compiled client but never exercised against a
 * live account. Keep the wording identical everywhere so a single grep finds
 * them all when one is verified.
 */
export const UNVERIFIED =
  ' NOTE: this write is UNVERIFIED — its request shape was derived from the web app’s compiled API client but has not been exercised against a live account. Inspect the confirmation preview before approving it.';

/**
 * Who writes the free text in this server's reads: menu item names and
 * descriptions, vendor and school names, teacher and grade labels, notices and
 * coupon text all come from the school and its lunch vendors, not the parent.
 */
export const UNTRUSTED_NOTE =
  'Menu items, vendor and school names, notices, coupon text and any other free text in `data` are written by ' +
  `the school and its lunch vendors, not the user. ${UNTRUSTED_CONTENT_RULE}`;

/** Appended to the description of every read wrapped with {@link untrustedRead}. */
export const UNTRUSTED = ` ${UNTRUSTED_DESCRIPTION_SUFFIX}`;

/**
 * Frame a read that carries school/vendor/menu text as untrusted data
 * (chrischall/fleet-audit#872). The payload always sits under `data` — never
 * spread beside the markers — so a read-modify-write form (order, student)
 * hands back a model with none of the envelope's keys mixed into it.
 */
export function untrustedRead(data: unknown): ReturnType<typeof untrustedResult> {
  return untrustedResult({ data }, { note: UNTRUSTED_NOTE });
}
