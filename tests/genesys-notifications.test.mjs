import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTopicCatalogue,
  resolveTopicPlaceholders,
  getResourceKindForTopic,
  replaceTopicPlaceholders,
} from '../lib/genesys/notification-topics.mjs';

test('buildTopicCatalogue keeps only v2 websocket topics and groups them by functional area', () => {
  const catalogue = buildTopicCatalogue([
    { id: 'v2.routing.queues.{id}.conversations.calls' },
    { id: 'v2.users.{id}.presence' },
    { id: 'not-a-topic' },
  ]);

  assert.equal(catalogue.topics.length, 2);
  assert.equal(catalogue.groups.some((group) => group.key === 'routing'), true);
  assert.equal(catalogue.groups.some((group) => group.key === 'users'), true);
  assert.equal(catalogue.topics[0].groupLabel, 'Routing & Conversation Handling');
});

test('queue conversation topics require queue objects for {id}', () => {
  const topic = 'v2.routing.queues.{id}.conversations.calls';
  assert.equal(getResourceKindForTopic(topic, 0), 'queues');
  assert.deepEqual(resolveTopicPlaceholders(topic), [
    {
      token: '{id}',
      index: 0,
      resourceKind: 'queues',
      label: 'Queue',
    },
  ]);
});

test('replaceTopicPlaceholders substitutes selected Genesys object IDs', () => {
  assert.equal(
    replaceTopicPlaceholders('v2.routing.queues.{id}.conversations.calls', ['queue-123']),
    'v2.routing.queues.queue-123.conversations.calls'
  );
});

test('topics with multiple placeholders expose indexed placeholder choices', () => {
  const placeholders = resolveTopicPlaceholders('v2.architect.prompts.{id}.resources.{id}');
  assert.deepEqual(placeholders.map((placeholder) => placeholder.index), [0, 1]);
  assert.equal(placeholders[0].resourceKind, 'architectPrompts');
  assert.equal(placeholders[1].resourceKind, 'manual');
});
