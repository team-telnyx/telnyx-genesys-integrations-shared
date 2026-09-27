import { getConversationsApi } from './client.js';
import { genesysApiOrigin } from './api-origin.mjs';

export const videoError = (message, status = 400) => Object.assign(new Error(message), { status });
export function messageState(participant) {
  const messages = participant?.messages || [];
  return messages.find((message) => ['connected', 'alerting', 'contacting'].includes(message.state))?.state || messages.at(-1)?.state;
}
export function videoConversationState(conversation) {
  const participants = conversation?.participants || [];
  const agents = participants.filter((p) => p.purpose === 'agent');
  const agent = agents.find((p) => !p.endTime && messageState(p) === 'connected') || agents.find((p) => !p.endTime && messageState(p) === 'alerting');
  const queued = participants.some((p) => ['acd', 'workflow'].includes(p.purpose) && !p.endTime && ['connected', 'contacting', 'alerting'].includes(messageState(p)));
  const customer = participants.find((p) => p.purpose === 'customer');
  const ended = Boolean(conversation?.endTime || (customer && ['disconnected', 'terminated'].includes(messageState(customer))) || (agents.length && !agent && !queued));
  return { status: ended ? 'disconnected' : agent ? messageState(agent) === 'connected' ? 'connected' : 'assigned' : 'waiting', agent };
}

export function videoInboundMessage({ sessionId, queueId, queueName, customerName = 'Website visitor' }) {
  return {
    channel: {
      messageId: sessionId,
      from: { id: `telnyx-video:${sessionId}`, idType: 'Opaque', nickname: customerName.slice(0, 100) },
      time: new Date().toISOString(),
      metadata: { customAttributes: {
        telnyx_ai_channel: 'video', telnyx_video_session_id: sessionId,
        telnyx_ai_queue_id: queueId, telnyx_ai_queue_name: queueName,
      } },
    },
    type: 'Text', text: 'Incoming video call. Open the Telnyx Video interaction panel to join.',
  };
}

// End the messaging media without completing the agent's after-contact work.
// The conversation-wide /disconnect endpoint also assigns a system wrap-up,
// so it must never be used for the normal video lifecycle (including retries).
export async function disconnectVideoConversation(api, conversationId) {
  const active = (participant) => (participant.messages || []).some((message) =>
    ['connected', 'alerting', 'contacting', 'dialing'].includes(message.state));
  let conversation = await api.getConversation(conversationId);
  const customers = (conversation.participants || []).filter((participant) => participant.purpose === 'customer' && active(participant));
  for (const customer of customers) {
    await api.patchConversationsMessageParticipant(conversationId, customer.id, { body: { state: 'disconnected' } });
  }
  // Genesys may have disconnected the agent when the customer left. Read again
  // before patching so an agent already in ACW is left untouched.
  if (customers.length) conversation = await api.getConversation(conversationId);
  for (const agent of (conversation.participants || []).filter((participant) => participant.purpose === 'agent' && active(participant))) {
    await api.patchConversationsMessageParticipant(conversationId, agent.id, { body: { state: 'disconnected' } });
  }
  if (!conversation.endTime && !(conversation.participants || []).some((participant) => ['customer', 'agent'].includes(participant.purpose))) {
    throw videoError('Genesys conversation is still materializing', 503);
  }
}

export async function authorizeVideoAgent({ conversationId, accessToken, fetchImpl = fetch, conversationsApi, allowCompleted = false }) {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId || '')) throw videoError('Invalid conversation ID', 400);
  if (!accessToken) throw videoError('Genesys Cloud authentication required', 401);
  const response = await fetchImpl(`${genesysApiOrigin()}/api/v2/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw videoError('Genesys Cloud authentication required', response.status === 401 ? 401 : 403);
  const agent = await response.json();
  const api = conversationsApi || await getConversationsApi();
  const conversation = await api.getConversation(conversationId);
  const participant = (conversation.participants || []).find((p) => p.purpose === 'agent' && (p.userId || p.user?.id) === agent.id && (allowCompleted || (!p.endTime && ['connected', 'alerting'].includes(messageState(p)))));
  if (!participant) throw videoError('You are not currently assigned to this interaction', 403);
  return { agent, participant, conversation, accepted: !allowCompleted && !participant.endTime && messageState(participant) === 'connected' };
}
