#!/usr/bin/env node
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';
import { MhlbClient } from './client.js';
import { VERSION } from './version.js';
import { registerAccountTools } from './tools/account.js';
import { registerStudentTools } from './tools/students.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerOrderTools } from './tools/orders.js';
import { registerBillingTools } from './tools/billing.js';
import { registerCheckoutTools } from './tools/checkout.js';
import { registerReportTools } from './tools/reports.js';
import { registerHealthcheckTools } from './tools/health.js';
import { loadStudentDirectory } from './tools/student-directory.js';

await loadDotenvSafely();

// Built here, in the caller, so the deferred-config-error pattern holds: the
// server still boots (and answers the host's install-time tools/list probe)
// with no credentials set — the error surfaces on the first tool call.
const client = new MhlbClient();

// The calendar's `student` argument publishes the students' first names as an
// enum (context groups, mcp-host spec 2026-11-03 D5), so list them ONCE here —
// registrars run per served instance — bounded by STUDENT_LIST_TIMEOUT_MS.
// Null (no credentials, a failed listing, a timeout, no students) publishes
// the argument with no enum. A rejected sign-in is latched by the client, so
// this is the one attempt the later tool calls would otherwise have made.
const students = await loadStudentDirectory(client);

await runMcp({
  name: 'myhotlunchbox-mcp',
  version: VERSION,
  banner: '[myhotlunchbox-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [
    registerAccountTools,
    registerStudentTools,
    (server, c) => registerCalendarTools(server, c, students),
    registerOrderTools,
    registerBillingTools,
    registerCheckoutTools,
    registerReportTools,
    registerHealthcheckTools,
  ],
});
