"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  IconAlertTriangle,
  IconBrain,
  IconRefresh,
  IconRobot,
} from "@tabler/icons-react";
import { Badge } from "@/components/genesys-ai/ui/badge";
import { Button } from "@/components/genesys-ai/ui/button";
import { Card, CardContent } from "@/components/genesys-ai/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ConversationMessagesTab from "@/components/assistants/ConversationMessagesTab";
import ConversationInsightsTab from "@/components/assistants/ConversationInsightsTab";
import ConversationMetadataTab from "@/components/assistants/ConversationMetadataTab";
import ConversationDynamicVariablesTab from "@/components/assistants/ConversationDynamicVariablesTab";
import ConversationCostsTab from "@/components/assistants/ConversationCostsTab";
import { genesysAuthenticatedFetch } from "@/lib/genesys/admin-client-auth";

function sentimentClasses(sentiment) {
  switch (String(sentiment || "").toLowerCase()) {
    case "positive":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "negative":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-blue-200 bg-blue-50 text-blue-700";
  }
}

function LoadingWidget() {
  return (
    <div className="flex h-screen flex-col gap-3 bg-white p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-3 w-72" />
        </div>
      </div>
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="min-h-0 flex-1 w-full rounded-xl" />
    </div>
  );
}

export default function GenesysAiConversationWidget() {
  const searchParams = useSearchParams();
  const conversationId =
    searchParams.get("conversationId") ||
    searchParams.get("gcConversationId") ||
    searchParams.get("pcConversationId");
  const [activeTab, setActiveTab] = useState("conversation");
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const requestSequenceRef = useRef(0);
  const insightsFallbackAttemptedRef = useRef(false);
  const handledInsightEventRef = useRef(null);

  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
    document.documentElement.style.colorScheme = "light";
  }, []);

  const load = useCallback(
    async ({ background = false } = {}) => {
      if (!conversationId) {
        setError("Genesys Cloud did not provide an active conversation ID.");
        setLoading(false);
        return;
      }
      const requestSequence = ++requestSequenceRef.current;
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const response = await genesysAuthenticatedFetch(
          `/api/genesys/ai-conversation-widget?conversationId=${encodeURIComponent(
            conversationId
          )}`,
          { cache: "no-store", credentials: "include" }
        );
        if (response.status === 401) {
          const returnTo = `/genesys/ai-conversation-widget?conversationId=${encodeURIComponent(
            conversationId
          )}`;
          window.location.assign(
            `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
          );
          return;
        }
        const result = await response.json();
        if (!response.ok || !result?.ok) {
          throw new Error(result?.error || "Could not load Telnyx AI context");
        }
        if (requestSequence === requestSequenceRef.current) {
          setPayload(result.data);
          setError(null);
        }
      } catch (loadError) {
        if (requestSequence === requestSequenceRef.current) {
          setError(loadError?.message || "Could not load Telnyx AI context");
        }
      } finally {
        if (requestSequence === requestSequenceRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [conversationId]
  );

  useEffect(() => {
    insightsFallbackAttemptedRef.current = false;
    handledInsightEventRef.current = null;
    load();
  }, [load]);

  useEffect(() => {
    if (!conversationId || !payload?.telnyxConversationId || !payload?.sync?.insightsPending) {
      return;
    }
    const source = new EventSource(
      `/api/genesys/ai-conversation-widget/insights-events?conversationId=${encodeURIComponent(
        conversationId
      )}`
    );
    const refreshInsights = (message) => {
      let eventKey = message?.data || "insights-ready";
      try {
        const event = JSON.parse(message?.data || "{}");
        eventKey = `${event.insightGroupId || "group"}:${event.receivedAt || "ready"}`;
      } catch {
        // The event is still authenticated server-side; use its raw data as the key.
      }
      if (handledInsightEventRef.current === eventKey) return;
      handledInsightEventRef.current = eventKey;
      source.close();
      void load({ background: true });
    };
    source.addEventListener("insights-ready", refreshInsights);
    const fallback = insightsFallbackAttemptedRef.current
      ? null
      : setTimeout(() => {
          insightsFallbackAttemptedRef.current = true;
          void load({ background: true });
        }, 35_000);
    return () => {
      if (fallback) clearTimeout(fallback);
      source.removeEventListener("insights-ready", refreshInsights);
      source.close();
    };
  }, [conversationId, load, payload?.sync?.insightsPending, payload?.telnyxConversationId]);

  const context = payload?.context || {};
  const conversation = payload?.conversation || null;
  const messages = payload?.messages || [];
  const title = conversation?.name || "Telnyx AI conversation";
  const subtitle = useMemo(
    () =>
      [
        context.channel === "voice" ? "Voice" : context.channel === "chat" ? "Chat" : null,
        context.queueName ? `Queue: ${context.queueName}` : null,
        context.assistantId,
      ]
        .filter(Boolean)
        .join(" · "),
    [context]
  );

  if (loading && !payload) return <LoadingWidget />;

  if (error && !payload) {
    return (
      <main className="flex h-screen items-center justify-center bg-white p-6 text-slate-950">
        <Card className="w-full max-w-lg border-red-200 bg-white">
          <CardContent className="space-y-4 pt-6 text-center">
            <IconAlertTriangle className="mx-auto size-10 text-red-500" />
            <div>
              <h1 className="font-semibold">Telnyx AI context unavailable</h1>
              <p className="mt-1 text-sm text-slate-600">{error}</p>
            </div>
            <Button variant="outline" onClick={() => load()}>
              <IconRefresh className="size-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-white text-slate-950">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#00e3aa] text-black">
              <IconRobot className="size-6" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{title}</h1>
              <p className="truncate text-xs text-slate-500" title={subtitle}>
                {subtitle || payload?.genesysConversationId}
              </p>
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            onClick={() => load({ background: true })}
            disabled={refreshing}
            aria-label="Refresh Telnyx AI context"
          >
            <IconRefresh className={refreshing ? "size-4 animate-spin" : "size-4"} />
          </Button>
        </div>

        <Card className="mt-3 border-slate-200 bg-slate-50 shadow-none">
          <CardContent className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-slate-200 bg-white">
                {context.intent || "No intent"}
              </Badge>
              <Badge variant="outline" className={sentimentClasses(context.sentiment)}>
                {context.sentiment || "neutral"}
              </Badge>
            </div>
            <div className="flex items-start gap-2">
              <IconBrain className="mt-0.5 size-4 shrink-0 text-slate-500" />
              <p className="text-sm leading-5 text-slate-700">
                {context.summary || "No AI summary was provided for this handoff."}
              </p>
            </div>
          </CardContent>
        </Card>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col gap-0 px-4"
      >
        <div className="w-full">
          <TabsList className="mt-3 grid h-auto w-full grid-cols-5 bg-slate-100">
            <TabsTrigger
              className="min-w-0 whitespace-normal px-1 text-xs leading-tight"
              value="conversation"
            >
              Conversation
            </TabsTrigger>
            <TabsTrigger
              className="min-w-0 whitespace-normal px-1 text-xs leading-tight"
              value="insights"
            >
              Insights
            </TabsTrigger>
            <TabsTrigger
              className="min-w-0 whitespace-normal px-1 text-xs leading-tight"
              value="metadata"
            >
              Metadata
            </TabsTrigger>
            <TabsTrigger
              className="min-w-0 whitespace-normal px-1 text-xs leading-tight"
              value="dynamic"
            >
              Dynamic Variables
            </TabsTrigger>
            <TabsTrigger
              className="min-w-0 whitespace-normal px-1 text-xs leading-tight"
              value="costs"
            >
              Costs
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="conversation"
          className="mt-0 flex min-h-0 flex-1 overflow-hidden py-3 data-[state=inactive]:hidden"
        >
          <ConversationMessagesTab
            conversation={conversation}
            enabled={activeTab === "conversation"}
            initialMessages={messages}
            fallbackTranscript={payload?.context?.transcript}
            appearance="genesys"
          />
        </TabsContent>
        <TabsContent
          value="insights"
          className="mt-0 min-h-0 flex-1 overflow-auto py-3"
        >
          <ConversationInsightsTab
            conversation={conversation}
            enabled={activeTab === "insights"}
            initialInsights={payload?.insights || []}
            initialInsightNames={payload?.insightNames || {}}
            insightsPending={payload?.sync?.insightsPending}
          />
        </TabsContent>
        <TabsContent
          value="metadata"
          className="mt-0 min-h-0 flex-1 overflow-auto py-3"
        >
          <ConversationMetadataTab conversation={conversation} loading={false} />
        </TabsContent>
        <TabsContent
          value="dynamic"
          className="mt-0 min-h-0 flex-1 overflow-auto py-3"
        >
          <ConversationDynamicVariablesTab
            conversation={conversation}
            enabled={activeTab === "dynamic"}
            initialWebhookLogs={payload?.dynamicVariables}
          />
        </TabsContent>
        <TabsContent
          value="costs"
          className="mt-0 min-h-0 flex-1 overflow-auto py-3"
        >
          <ConversationCostsTab
            conversation={conversation}
            forceRecordType="ai-voice-assistant"
            initialSessionData={payload?.costs}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
