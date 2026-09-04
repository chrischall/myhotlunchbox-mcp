import { jsonResult, minifiedResult } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Standard dry-run envelope for a confirm-gated write.
 *
 * A mutating tool called without `confirm: true` makes **no** network call and
 * returns exactly what it would have sent, so the caller can inspect it first.
 */
export function preview(
  action: string,
  request: { method: 'POST'; path: string; query?: Record<string, unknown>; body?: unknown },
  notes?: string[],
): CallToolResult {
  return jsonResult({
    dryRun: true,
    action,
    wouldSend: request,
    notes: [
      'No request was made. Pass confirm: true to execute.',
      ...(notes ?? []),
    ],
  });
}

export { jsonResult, minifiedResult };

/**
 * Marker appended to the description of every tool whose request shape was
 * derived from the web app's compiled client but never exercised against a
 * live account. Keep the wording identical everywhere so a single grep finds
 * them all when one is verified.
 */
export const UNVERIFIED =
  ' NOTE: this write is UNVERIFIED — its request shape was derived from the web app’s compiled API client but has not been exercised against a live account. Inspect the dry-run preview before confirming.';
