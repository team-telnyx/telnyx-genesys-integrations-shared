const GROUPS = [
  { key: 'analytics', prefixes: ['v2.analytics.', 'v2.detail.events.'], label: 'Analytics & Data Management' },
  { key: 'routing', prefixes: ['v2.routing.', 'v2.conversations.'], label: 'Routing & Conversation Handling' },
  { key: 'users', prefixes: ['v2.users.', 'v2.user.', 'v2.gamification.'], label: 'User & Agent Management' },
  { key: 'architect', prefixes: ['v2.architect.', 'v2.flows.'], label: 'Architect & Flows' },
  { key: 'outbound', prefixes: ['v2.outbound.'], label: 'Outbound' },
  { key: 'workforce', prefixes: ['v2.businessunits.', 'v2.managementunits.', 'v2.workforcemanagement.'], label: 'Workforce Management' },
  { key: 'externalcontacts', prefixes: ['v2.externalcontacts.', 'v2.journey.'], label: 'External Contacts & Journey' },
  { key: 'content', prefixes: ['v2.contentmanagement.'], label: 'Content Management' },
  { key: 'groups', prefixes: ['v2.groups.'], label: 'Groups' },
  { key: 'integrations', prefixes: ['v2.integrations.'], label: 'Integrations' },
  { key: 'operations', prefixes: ['v2.operations.', 'v2.audits.'], label: 'Operations & Audits' },
];

const RESOURCE_LABELS = {
  queues: 'Queue',
  users: 'User',
  flows: 'Flow',
  architectPrompts: 'Architect prompt',
  outboundContactLists: 'Contact list',
  outboundCampaigns: 'Campaign',
  outboundMessagingCampaigns: 'Messaging campaign',
  groups: 'Group',
  wrapupCodes: 'Wrap-up code',
  conversations: 'Conversation',
  businessUnits: 'Business unit',
  managementUnits: 'Management unit',
  manual: 'Object ID',
};

function groupForTopic(topic) {
  return GROUPS.find((group) => group.prefixes.some((prefix) => topic.startsWith(prefix))) || {
    key: 'other',
    label: 'Other',
  };
}

function topicDescription(topic, source = {}) {
  if (source.description) return source.description;
  if (source.name && source.name !== topic) return source.name;
  if (topic.includes('.conversations.calls')) return 'Queue call conversation notifications';
  if (topic.includes('.conversations.emails')) return 'Queue email conversation notifications';
  if (topic.includes('.conversations.messages')) return 'Queue message conversation notifications';
  if (topic.includes('.presence')) return 'User presence changes';
  if (topic.includes('.routingstatus')) return 'User routing status changes';
  if (topic.includes('.activity')) return 'Queue activity observations';
  if (topic.includes('.observations')) return 'Queue statistic observations';
  return topic.split('.').slice(1).join(' ');
}

export function getResourceKindForTopic(topic, placeholderIndex = 0) {
  const beforePlaceholder = topic.split('{id}')[0];
  const tokens = beforePlaceholder.split('.');
  const previousToken = tokens[tokens.length - 2] === '' ? tokens[tokens.length - 3] : tokens[tokens.length - 1];

  if (topic.startsWith('v2.routing.queues.{id}') || topic.startsWith('v2.analytics.queues.{id}')) return 'queues';
  if (topic.startsWith('v2.users.{id}') || topic.startsWith('v2.analytics.users.{id}') || topic.startsWith('v2.gamification.scorecards.users.{id}') || topic.startsWith('v2.detail.events.agent.{id}')) return 'users';
  if (topic.startsWith('v2.flows.{id}') || topic.startsWith('v2.flows.instances.flow.{id}') || topic.startsWith('v2.analytics.flow.{id}')) return 'flows';
  if (topic.startsWith('v2.architect.prompts.{id}') && placeholderIndex === 0) return 'architectPrompts';
  if (topic.startsWith('v2.outbound.contactlists.{id}')) return 'outboundContactLists';
  if (topic.startsWith('v2.outbound.campaigns.{id}') || topic.startsWith('v2.outbound.schedules.campaigns.{id}')) return 'outboundCampaigns';
  if (topic.startsWith('v2.outbound.messagingcampaigns.{id}') || topic.startsWith('v2.outbound.schedules.messagingcampaigns.{id}')) return 'outboundMessagingCampaigns';
  if (topic.startsWith('v2.groups.{id}')) return 'groups';
  if (topic.startsWith('v2.analytics.wrapup.{id}')) return 'wrapupCodes';
  if (topic.startsWith('v2.analytics.conversation.{id}') || topic.startsWith('v2.conversations.{id}') || topic.startsWith('v2.detail.events.conversation.{id}')) return 'conversations';
  if (topic.startsWith('v2.businessunits.{id}')) return 'businessUnits';
  if (topic.startsWith('v2.managementunits.{id}')) return 'managementUnits';

  if (['queues', 'queue'].includes(previousToken)) return 'queues';
  if (['users', 'user', 'agent'].includes(previousToken)) return 'users';
  if (['flows', 'flow'].includes(previousToken)) return 'flows';
  if (['groups'].includes(previousToken)) return 'groups';
  return 'manual';
}

export function resolveTopicPlaceholders(topic) {
  const matches = [...topic.matchAll(/\{id\}/g)];
  return matches.map((match, index) => {
    const resourceKind = getResourceKindForTopic(topic, index);
    return {
      token: match[0],
      index,
      resourceKind,
      label: RESOURCE_LABELS[resourceKind] || RESOURCE_LABELS.manual,
    };
  });
}

export function replaceTopicPlaceholders(topic, values) {
  let next = topic;
  values.forEach((value) => {
    next = next.replace('{id}', value);
  });
  return next;
}

export function buildTopicCatalogue(rawTopics = []) {
  const seen = new Set();
  const topics = rawTopics
    .map((item) => (typeof item === 'string' ? { id: item } : item))
    .filter((item) => item?.id?.startsWith('v2.'))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => {
      const group = groupForTopic(item.id);
      const placeholders = resolveTopicPlaceholders(item.id);
      return {
        id: item.id,
        topic: item.id,
        description: topicDescription(item.id, item),
        group: group.key,
        groupLabel: group.label,
        placeholders,
        requiresObject: placeholders.length > 0,
      };
    });

  const groups = [...new Map(topics.map((topic) => [topic.group, {
    key: topic.group,
    label: topic.groupLabel,
    count: topics.filter((candidate) => candidate.group === topic.group).length,
  }])).values()];

  return { topics, groups };
}

export const topicGroups = GROUPS;
export const resourceLabels = RESOURCE_LABELS;
