import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const componentSource = readFileSync(
  new URL('../components/genesys-notifications/GenesysNotificationsMonitor.jsx', import.meta.url),
  'utf8'
);

test('live notification events render as collapsible code-viewer accordions', () => {
  assert.match(componentSource, /import CodeBlock from ["']@\/components\/ui\/code-block["']/);
  assert.match(componentSource, /function EventPayloadAccordion/);
  assert.match(componentSource, /<CodeBlock[\s\S]*language="json"/);
  assert.match(componentSource, /aria-expanded=\{isOpen\}/);
  assert.doesNotMatch(componentSource, /<pre className="text-xs/);
});
