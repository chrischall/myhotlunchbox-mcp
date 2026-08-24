import { toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult } from './_shared.js';

/** Claims the app stores as `userInfo` (OpenID Connect + app-specific extras). */
export interface UserInfo {
  sub: number;
  email: string;
  email_verified: boolean;
  role: string[];
  name: string;
  is_treat_allowed: boolean;
  pending_orders_count: number;
  students_count: number;
  parent_credit_value: number;
  parent_school_program_credit_value: number;
  is_subscription_allowed: boolean;
  is_subscribed: boolean;
  is_system_parent: boolean;
  mhl_phone_number: string;
}

export function registerAccountTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_whoami',
    {
      description:
        'Get the signed-in My Hot Lunchbox account: name, email, role, number of students, ' +
        'pending order count, account credit balances, and whether subscriptions are enabled. ' +
        'Start here to confirm the session works.',
      annotations: toolAnnotations({ title: 'Who am I', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get<UserInfo>('/auth/userinfo')),
  );

  server.registerTool(
    'mhlb_session_reset',
    {
      description:
        'Discard the cached My Hot Lunchbox access token so the next tool call signs in again. ' +
        'Use after changing credentials, or if calls start failing with stale-session errors.',
      annotations: toolAnnotations({ title: 'Reset session', readOnly: false, idempotent: true }),
      inputSchema: {},
    },
    async () => {
      const wasAuthenticated = client.isAuthenticated;
      client.resetSession();
      return jsonResult({ reset: true, hadActiveSession: wasAuthenticated });
    },
  );
}
