"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/genesys-ai/ui/card";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Response } from "@/components/ai-elements/response";
import { IconBulb } from "@tabler/icons-react";
import { orderConversationInsights } from "@/lib/ai/conversation-insight-order.mjs";
import { renderEmojiShortcodes } from "@/lib/ai/emoji-shortcodes.mjs";

function formatTimestamp(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    const yyyy = d.getFullYear();
    const MM = pad2(d.getMonth() + 1);
    const DD = pad2(d.getDate());
    const HH = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    const SSS = pad3(d.getMilliseconds());
    return `${yyyy}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}`;
  } catch {
    return String(value);
  }
}

export default function ConversationInsightsTab({
  conversation,
  enabled,
  initialInsights,
  initialInsightNames,
  insightsPending = false,
}) {
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insights, setInsights] = useState([]);
  const [insightNames, setInsightNames] = useState({});

  useEffect(() => {
    if (!enabled) return;
    if (!conversation?.id) return;
    if (Array.isArray(initialInsights)) {
      setInsights(initialInsights);
      setInsightNames(initialInsightNames || {});
      return;
    }
    let cancelled = false;
    async function loadInsights() {
      setInsightsLoading(true);
      try {
        const res = await fetch(
          `/api/ai/conversations/${encodeURIComponent(
            conversation.id
          )}/insights`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!cancelled && res.ok && data?.ok) {
          const next = Array.isArray(data?.insights)
            ? data.insights
            : data?.data || [];
          setInsights(next);
        }
        const groupsRes = await fetch(`/api/ai/conversations/insight-groups`, {
          cache: "no-store",
        });
        const groupsData = await groupsRes.json();
        if (
          !cancelled &&
          groupsRes.ok &&
          groupsData?.ok &&
          groupsData?.insightNameById
        ) {
          setInsightNames(groupsData.insightNameById || {});
        }
      } catch (_) {}
      if (!cancelled) setInsightsLoading(false);
    }
    loadInsights();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, enabled, initialInsights, initialInsightNames]);

  const configuredInsights = Array.isArray(insights)
    ? insights.flatMap((entry) => {
        const created = entry?.created_at;
        const list = Array.isArray(entry?.conversation_insights)
          ? entry.conversation_insights
          : [];
        return list.map((ins, idx) => {
          let parsed;
          let isJson = false;
          try {
            parsed = JSON.parse(ins?.result ?? "");
            isJson = typeof parsed === "object" && parsed !== null;
          } catch {
            parsed = ins?.result ?? "";
          }
          const title =
            (isJson && typeof parsed?.title === "string" && parsed.title) ||
            (ins?.insight_id && insightNames[ins.insight_id]) ||
            ins?.insight_id ||
            "Insight";
          return {
            key: `${entry?.id || "e"}-${idx}`,
            title,
            value: parsed,
            isJson,
            created,
          };
        });
      })
    : [];
  const displayedInsights = orderConversationInsights(configuredInsights);

  return (
    <div className="flex-1 min-h-0 overflow-auto py-2 space-y-2">
      {insightsLoading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}
      {!insightsLoading && displayedInsights.length === 0 && (
        <div className="text-sm text-muted-foreground">
          {insightsPending ? "Generating insights…" : "No insights"}
        </div>
      )}
      {!insightsLoading &&
        displayedInsights.map((insight) => (
          <Card key={insight.key}>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="truncate inline-flex items-center gap-2">
                <IconBulb className="size-4 text-amber-500" />
                <span className="truncate">{insight.title}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {insight.isJson ? (
                <CodeBlock
                  code={JSON.stringify(insight.value, null, 2)}
                  language="json"
                >
                  <CodeBlockCopyButton />
                </CodeBlock>
              ) : (
                <Response className="text-sm">
                  {renderEmojiShortcodes(insight.value)}
                </Response>
              )}
              {insight.created && (
                <div className="text-[10px] text-muted-foreground mt-2">
                  {formatTimestamp(insight.created)}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
    </div>
  );
}
