import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WIDGET_CONFIG,
  DEFAULT_WIDGET_DECISION_RULES,
  parseWidgetConfig,
  publicWidgetConfig,
} from "../lib/widgets/config.js";
import {
  evaluateWidgetDecisions,
  interpolateDecisionValue,
  matchesDecisionCondition,
  previewDecisionContext,
} from "../lib/widgets/decisions.js";

function decisionConfig(rules) {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.voice.enabled = true;
  config.channels.messaging.genesys.queues = [
    { id: "queue-support", name: "Support" },
    { id: "queue-sales", name: "Sales" },
  ];
  config.decisions.enabled = true;
  config.decisions.rules = rules;
  return parseWidgetConfig(config);
}

function rule({ id, priority, match = "all", conditions, actions }) {
  return {
    id,
    name: id,
    description: "",
    enabled: true,
    priority,
    match,
    conditions: conditions.map((condition, index) => ({ id: `${id}-c${index}`, ...condition })),
    actions: actions.map((action, index) => ({ id: `${id}-a${index}`, valueLabel: "", ...action })),
  };
}

test("new widget configs include five usable decision examples with graduated complexity", () => {
  const config = parseWidgetConfig(DEFAULT_WIDGET_CONFIG);
  assert.equal(config.decisions.enabled, false);
  assert.equal(DEFAULT_WIDGET_DECISION_RULES.length, 5);
  assert.deepEqual(config.decisions.rules.map((item) => item.priority), [10, 20, 30, 40, 50]);
  assert.equal(config.decisions.rules.filter((item) => item.name.startsWith("Simple ·")).length, 2);
  assert.equal(config.decisions.rules.filter((item) => item.name.startsWith("Standard ·")).length, 1);
  assert.equal(config.decisions.rules.filter((item) => item.name.startsWith("Advanced ·")).length, 2);
  assert.equal(new Set(config.decisions.rules.map((item) => item.id)).size, 5);
  assert.ok(config.decisions.rules.every((item) => item.enabled));
});

test("seeded decision examples exercise targeting, localization, personalization and routing", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.voice.enabled = true;
  config.channels.messaging.genesys.queues = [{ id: "queue-sales", name: "Sales" }];
  config.decisions.enabled = true;

  const hidden = evaluateWidgetDecisions(parseWidgetConfig(config), { "page.path": "/admin/users" });
  assert.equal(hidden.matchedRule.id, "example-simple-hide-admin");
  assert.equal(hidden.visible, false);

  const routed = evaluateWidgetDecisions(parseWidgetConfig(config), {
    "page.path": "/account",
    "customer.authenticated": true,
    "customer.name": "Ada Lovelace",
    "routing.queue": "Sales",
  });
  assert.equal(routed.matchedRule.id, "example-advanced-context-routing");
  assert.equal(routed.routeQueue.id, "queue-sales");
  assert.equal(routed.customerLabel, "Ada Lovelace");
  assert.deepEqual(routed.channels, ["messaging"]);

  const localized = evaluateWidgetDecisions(parseWidgetConfig(config), { "visitor.locale": "de-AT" });
  assert.equal(localized.matchedRule.id, "example-simple-german-locale");
  assert.equal(localized.locale, "de-DE");
});

test("decision conditions support text, numeric, boolean and existence operators", () => {
  const context = { segment: "Premium", score: 81, authenticated: true, empty: "" };
  assert.equal(matchesDecisionCondition({ field: "segment", operator: "equals", value: "premium" }, context), true);
  assert.equal(matchesDecisionCondition({ field: "segment", operator: "in", value: "vip, premium" }, context), true);
  assert.equal(matchesDecisionCondition({ field: "score", operator: "greater-or-equal", value: 80 }, context), true);
  assert.equal(matchesDecisionCondition({ field: "authenticated", operator: "equals", value: true }, context), true);
  assert.equal(matchesDecisionCondition({ field: "missing", operator: "not-exists", value: "" }, context), true);
  assert.equal(matchesDecisionCondition({ field: "empty", operator: "exists", value: "" }, context), false);
});

test("the first matching enabled decision wins by priority and exposes a readable trace", () => {
  const config = decisionConfig([
    rule({
      id: "fallback",
      priority: 20,
      conditions: [{ field: "page.path", operator: "contains", value: "/" }],
      actions: [{ type: "channels", value: "messaging" }],
    }),
    rule({
      id: "sales",
      priority: 10,
      conditions: [{ field: "customer.segment", operator: "equals", value: "business" }],
      actions: [{ type: "channels", value: "both" }],
    }),
  ]);
  const result = evaluateWidgetDecisions(config, { "page.path": "/pricing", "customer.segment": "business" });
  assert.equal(result.matchedRule.id, "sales");
  assert.deepEqual(result.channels, ["messaging", "voice"]);
  assert.equal(result.traces.length, 1);
  assert.equal(result.traces[0].conditions[0].actual, "business");
});

test("a decision can localize UI, select a surface, delay the launcher and hide channels", () => {
  const config = decisionConfig([
    rule({
      id: "polish-support",
      priority: 1,
      conditions: [{ field: "visitor.locale", operator: "starts-with", value: "pl" }],
      actions: [
        { type: "locale", value: "pl-PL" },
        { type: "surface", value: "chat" },
        { type: "channels", value: "messaging" },
        { type: "launcher-delay", value: 12 },
      ],
    }),
  ]);
  const result = evaluateWidgetDecisions(config, { "visitor.locale": "pl" });
  assert.equal(result.locale, "pl-PL");
  assert.equal(result.config.content.title, "Jak możemy pomóc?");
  assert.equal(result.surface, "chat");
  assert.deepEqual(result.channels, ["messaging"]);
  assert.equal(result.launcherDelaySeconds, 12);
});

test("routing and customer labels can be selected from host-page context", () => {
  const config = decisionConfig([
    rule({
      id: "route-sales",
      priority: 1,
      conditions: [{ field: "routing.queue", operator: "equals", value: "Sales" }],
      actions: [
        { type: "route-queue", value: "queue-sales" },
        { type: "customer-label", value: "{{customer.firstName}} {{customer.lastName}}" },
      ],
    }),
  ]);
  const context = { "routing.queue": "Sales", "customer.firstName": "Ada", "customer.lastName": "Lovelace" };
  const result = evaluateWidgetDecisions(config, context);
  assert.equal(result.routeQueue.id, "queue-sales");
  assert.deepEqual(result.config.channels.messaging.genesys.queues, [{ id: "queue-sales", name: "Sales" }]);
  assert.equal(result.config.components.messages.customerLabel, "Ada Lovelace");
  assert.equal(interpolateDecisionValue("Hello {{customer.firstName}}", context), "Hello Ada");
});

test("preview context overrides the simulated device and decisions are safe to expose publicly", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.preview.decisionContext["device.type"] = "desktop";
  const context = previewDecisionContext(config, "mobile");
  assert.equal(context["device.type"], "mobile");
  assert.equal(context["visitor.locale"], config.preview.decisionContext["visitor.locale"]);
  const publicConfig = publicWidgetConfig(config);
  assert.equal(publicConfig.decisions.strategy, "first-match");
  assert.equal(publicConfig.decisionLocales[config.locale].content.title, config.content.title);
  assert.equal(publicConfig.preview, undefined);
});

test("public widget data includes localized UI snapshots required by locale decisions", () => {
  const config = decisionConfig([
    rule({
      id: "polish",
      priority: 1,
      conditions: [{ field: "visitor.locale", operator: "starts-with", value: "pl" }],
      actions: [{ type: "locale", value: "pl-PL" }],
    }),
  ]);
  config.locale = "en-US";
  const publicConfig = publicWidgetConfig(config);
  assert.equal(publicConfig.decisionLocales["pl-PL"].content.title, "Jak możemy pomóc?");
  assert.equal(publicConfig.decisionLocales["pl-PL"].messages.customerLabel, "Ty");
});
