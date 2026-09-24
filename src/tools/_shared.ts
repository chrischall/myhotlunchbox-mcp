import { confirmationFromEnv, minifiedResult, requireConfirmationWithFallback } from '@chrischall/mcp-utils';
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';

/** The request a write will send — shown in the preview and hashed into the token. */
export interface WriteRequest {
  method: 'POST';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Sentence every write tool's description ends with, so the confirmation flow
 * is stated identically everywhere.
 */
export const CONFIRMS =
  ' Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first ' +
  'call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).';

/**
 * Confirmation gate for a write.
 *
 * A client that can show a prompt gets one. Elsewhere the first call makes
 * **no** network call and returns a preview — the exact request it would send,
 * plus notes — with a `confirmToken`; only a repeat call carrying that token,
 * with arguments that still produce the same request, proceeds. `undefined`
 * means proceed; anything else is the result to return unchanged.
 */
export function confirmWrite(
  ctx: ServerContext,
  opts: {
    tool: string;
    /** `<service>.<verb>`, e.g. `order.delete`. */
    action: string;
    /** Human label for the preview, e.g. "Delete order". */
    label: string;
    /** The primary id acted on, or '' if none. */
    target: string;
    request: WriteRequest;
    confirmToken: string | undefined;
    notes?: string[];
    /** Extra preview fields that are bound into the token alongside the request. */
    extra?: Record<string, unknown>;
  },
): Promise<CallToolResult | InputRequiredResult | undefined> {
  const preview = {
    action: opts.label,
    wouldSend: opts.request,
    ...opts.extra,
    notes: ['Nothing has been sent yet.', ...(opts.notes ?? [])],
  };
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: opts.action,
      message: `Review and confirm: ${opts.label}`,
      details: preview,
      tool: opts.tool,
      confirmToken: opts.confirmToken,
      subject: () => ({
        target: opts.target,
        payload: { request: opts.request, ...opts.extra },
        preview,
      }),
    }),
  );
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
