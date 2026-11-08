/**
 * "Handle with Claude" — open a new Claude chat with the item's context already typed in.
 * The Darios connector (in the person's Claude) does the reading and acting from there.
 * Backend task notifications build the same link (app/api/push.py claude_link).
 */
import { WorklistItem } from './api';

export function claudeLink(prompt: string): string {
  return 'https://claude.ai/new?q=' + encodeURIComponent(prompt.slice(0, 1500));
}

const ACT = 'Confirm with me before changing anything.';

/** The pre-typed message for a My Action Items row (null = not something Claude can act on yet). */
export function worklistPrompt(it: WorklistItem): string | null {
  const cust = it.customer_key ? ` · customer ${it.customer_key}` : '';
  const due  = it.due_date ? ` · due ${it.due_date}` : '';
  switch (it.source) {
    case 'sales_task':
      return `Darios task #${it.id}: ${it.title}${cust}${due}${it.who ? ` · assigned to ${it.who}` : ''}. ` +
        `Open it with get_task (details + thread) and check the customer's history, then help me act on it — ` +
        `e.g. reply on the thread, update or finish the task, or create an Aspire issue. ${ACT}`;
    case 'sales_followup':
      return `Darios follow-up (activity #${it.id}): ${it.title}${cust}${due}. Check the customer's history ` +
        `and recent activity, then help me follow up — draft an email, log what happened, or create a task. ${ACT}`;
    case 'cx_comms':
      return `Client email due: "${it.title}" for ${it.job || `job ${it.opportunity_id}`} (opportunity ${it.opportunity_id}` +
        `${it.template_key ? `, template ${it.template_key}` : ''}). Draft it with draft_email and show me before sending.`;
    default:
      return null;
  }
}
