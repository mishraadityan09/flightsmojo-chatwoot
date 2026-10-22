// Everything the service writes on a ticket, through the agent-bot token:
// custom attributes (merge), the label (union — the labels endpoint REPLACES
// the list), priority (only ever raised), the team (only when the ticket has
// none; the assignee is never touched), and a private note. Each step is best-effort and reported; none blocks the others.

import { isHigher } from "./verdict.js";

export function createStamper({ api, teamId = null, log = console }) {
  return {
    /** The live ticket: status, priority, team and assignee (the webhook snapshot may be stale). */
    async conversation(conversationId) {
      const c = await api.get(`/conversations/${encodeURIComponent(conversationId)}`);
      return {
        id: c?.id,
        status: c?.status || null,
        priority: c?.priority || null,
        teamId: c?.meta?.team?.id ?? null,
        assigneeId: c?.meta?.assignee?.id ?? null,
        customAttributes: c?.custom_attributes || {},
      };
    },

    async stamp(conversationId, decision, { live = null } = {}) {
      const id = encodeURIComponent(conversationId);
      const failures = [];
      const step = async (name, fn) => {
        try {
          await fn();
        } catch (e) {
          failures.push(`${name}: ${e.message}`);
          log.warn?.(`[conv ${conversationId}] ${name} failed: ${e.message}`);
        }
      };
      if (decision.attributes && Object.keys(decision.attributes).length) {
        await step("attributes", () => api.post(`/conversations/${id}/custom_attributes`, { custom_attributes: decision.attributes, merge: true }));
      }
      if (decision.label) {
        await step("label", async () => {
          const current = (await api.get(`/conversations/${id}/labels`))?.payload || [];
          if (!current.includes(decision.label)) await api.post(`/conversations/${id}/labels`, { labels: [...current, decision.label] });
        });
      }
      if (decision.priority && isHigher(decision.priority, live?.priority)) {
        await step("priority", () => api.post(`/conversations/${id}/toggle_priority`, { priority: decision.priority }));
      }
      // The team is the desk's unit: set it whenever the ticket has none. An
      // existing assignee is left alone (Chatwoot keeps the agent when a team
      // is set; a reopened chain therefore keeps its agent).
      if (teamId && !live?.teamId) {
        await step("team", () => api.post(`/conversations/${id}/assignments`, { team_id: Number(teamId) }));
      }
      if (decision.note) {
        await step("note", () => api.post(`/conversations/${id}/messages`, { content: decision.note, message_type: "outgoing", private: true }));
      }
      return { ok: failures.length === 0, failures };
    },

    setPriority(conversationId, priority) {
      return api.post(`/conversations/${encodeURIComponent(conversationId)}/toggle_priority`, { priority });
    },
  };
}
