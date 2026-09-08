"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Activity, Bell, ChevronDown, Home, Loader2, PlugZap, Trash2, Wifi, WifiOff } from "lucide-react";

import CodeBlock from "@/components/ui/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  } catch {
    return "--:--:--";
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function EventPayloadAccordion({ event, eventNumber }) {
  const [isOpen, setIsOpen] = useState(false);
  const topicName = event.payload?.topicName || event.payload?.metadata?.topicName || "channel.metadata";

  return (
    <div className="rounded-lg border bg-muted/30 overflow-hidden">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">#{eventNumber}</Badge>
            <span className="text-xs text-muted-foreground">{formatTime(event.receivedAt)}</span>
          </div>
          <div className="truncate font-mono text-xs text-foreground">{topicName}</div>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && (
        <div className="border-t p-3">
          <CodeBlock title="Event payload" code={safeJson(event.payload)} language="json" maxHeight={420} />
        </div>
      )}
    </div>
  );
}

export default function GenesysNotificationsMonitor() {
  const [topics, setTopics] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [placeholderValues, setPlaceholderValues] = useState({});
  const [objectOptions, setObjectOptions] = useState({});
  const [objectsLoading, setObjectsLoading] = useState({});
  const [channel, setChannel] = useState(null);
  const [socketState, setSocketState] = useState("disconnected");
  const [activeSubscriptions, setActiveSubscriptions] = useState([]);
  const [selectedActiveTopic, setSelectedActiveTopic] = useState("");
  const [eventsByTopic, setEventsByTopic] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    loadTopics();
    return () => {
      socketRef.current?.close();
    };
  }, []);

  const filteredTopics = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return topics.filter((topic) => {
      const groupMatch = selectedGroup === "all" || topic.group === selectedGroup;
      const searchMatch =
        !normalizedSearch ||
        topic.id.toLowerCase().includes(normalizedSearch) ||
        topic.description.toLowerCase().includes(normalizedSearch);
      return groupMatch && searchMatch;
    });
  }, [topics, selectedGroup, search]);

  const effectiveSelectedTopicId = useMemo(() => {
    if (filteredTopics.some((topic) => topic.id === selectedTopicId)) return selectedTopicId;
    return filteredTopics[0]?.id || selectedTopicId;
  }, [filteredTopics, selectedTopicId]);

  const selectedTopic = useMemo(
    () => topics.find((topic) => topic.id === effectiveSelectedTopicId),
    [effectiveSelectedTopicId, topics]
  );

  const selectedEvents = eventsByTopic[selectedActiveTopic] || [];

  useEffect(() => {
    if (effectiveSelectedTopicId && effectiveSelectedTopicId !== selectedTopicId) {
      setSelectedTopicId(effectiveSelectedTopicId);
    }
  }, [effectiveSelectedTopicId, selectedTopicId]);

  async function loadTopics() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/genesys/notifications/topics");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load notification topics");
      setTopics(data.topics || []);
      setGroups(data.groups || []);
      if (data.topics?.length) setSelectedTopicId(data.topics[0].id);
    } catch (error) {
      console.error(error);
      toast.error(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  const loadObjects = useCallback(async (kind) => {
    setObjectsLoading((prev) => ({ ...prev, [kind]: true }));
    try {
      const response = await fetch(`/api/genesys/objects/${kind}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not load ${kind}`);
      setObjectOptions((prev) => {
        if (prev[kind]?.length) return prev;
        return { ...prev, [kind]: data.entities || [] };
      });
    } catch (error) {
      console.error(error);
      toast.error(error.message);
    } finally {
      setObjectsLoading((prev) => ({ ...prev, [kind]: false }));
    }
  }, []);

  useEffect(() => {
    setPlaceholderValues({});
    if (!selectedTopic?.placeholders?.length) return;

    selectedTopic.placeholders.forEach((placeholder) => {
      if (placeholder.resourceKind === "manual") return;
      loadObjects(placeholder.resourceKind);
    });
  }, [effectiveSelectedTopicId, loadObjects, selectedTopic?.placeholders]);

  async function ensureChannel() {
    if (channel?.id && socketRef.current?.readyState === WebSocket.OPEN) return channel;

    const response = await fetch("/api/genesys/notifications/channels", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create notification channel");
    setChannel(data);
    connectSocket(data);
    return data;
  }

  function connectSocket(nextChannel) {
    socketRef.current?.close();
    setSocketState("connecting");
    const socket = new WebSocket(nextChannel.connectUri);
    socketRef.current = socket;

    socket.onopen = () => setSocketState("connected");
    socket.onclose = () => setSocketState("disconnected");
    socket.onerror = () => {
      setSocketState("error");
      toast.error("Genesys WebSocket connection error");
    };
    socket.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data);
        const topicName = payload.topicName || payload.metadata?.topicName || "channel.metadata";
        const event = { receivedAt: new Date().toISOString(), payload };
        setEventsByTopic((prev) => ({
          ...prev,
          [topicName]: [event, ...(prev[topicName] || [])].slice(0, 100),
        }));
        setSelectedActiveTopic((current) => current || topicName);
      } catch (error) {
        console.error("Unable to parse Genesys notification", error);
      }
    };
  }

  function buildConcreteTopic() {
    if (!selectedTopic) return "";
    let topic = selectedTopic.id;
    selectedTopic.placeholders.forEach((placeholder) => {
      topic = topic.replace("{id}", placeholderValues[placeholder.index] || "");
    });
    return topic;
  }

  async function subscribe() {
    if (!selectedTopic) return;
    const missingPlaceholder = selectedTopic.placeholders.find((placeholder) => !placeholderValues[placeholder.index]);
    if (missingPlaceholder) {
      toast.error(`Select ${missingPlaceholder.label} first`);
      return;
    }

    const concreteTopic = buildConcreteTopic();
    setIsSubscribing(true);
    try {
      const nextChannel = await ensureChannel();
      const response = await fetch(`/api/genesys/notifications/channels/${nextChannel.id}/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptions: [{ id: concreteTopic }], ignoreErrors: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not subscribe to topic");
      setActiveSubscriptions((prev) => {
        if (prev.some((subscription) => subscription.id === concreteTopic)) return prev;
        return [
          ...prev,
          {
            id: concreteTopic,
            template: selectedTopic.id,
            description: selectedTopic.description,
            groupLabel: selectedTopic.groupLabel,
            createdAt: new Date().toISOString(),
          },
        ];
      });
      setSelectedActiveTopic(concreteTopic);
      toast.success("Subscription created");
    } catch (error) {
      console.error(error);
      toast.error(error.message);
    } finally {
      setIsSubscribing(false);
    }
  }

  async function unsubscribe(topicId) {
    if (!channel?.id) {
      setActiveSubscriptions((prev) => prev.filter((subscription) => subscription.id !== topicId));
      return;
    }

    try {
      const response = await fetch(
        `/api/genesys/notifications/channels/${channel.id}/subscriptions?topicId=${encodeURIComponent(topicId)}`,
        { method: "DELETE" }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove subscription");
      setActiveSubscriptions((prev) => prev.filter((subscription) => subscription.id !== topicId));
      setSelectedActiveTopic((current) => (current === topicId ? "" : current));
      toast.success("Subscription removed");
    } catch (error) {
      console.error(error);
      toast.error(error.message);
    }
  }

  const socketBadge = socketState === "connected" ? "bg-emerald-600" : socketState === "connecting" ? "bg-amber-500" : "bg-slate-500";

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-telnyx-green flex items-center justify-center">
                <Bell className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Genesys WebSocket Notifications</h1>
                <p className="text-muted-foreground">Subscribe to Genesys Cloud topics and monitor live events.</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={`${socketBadge} text-white gap-1`}>
              {socketState === "connected" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {socketState}
            </Badge>
            <Button asChild variant="outline">
              <Link href="/">
                <Home className="w-4 h-4 mr-2" /> Home
              </Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Select topic</CardTitle>
              <CardDescription>
                Topics are loaded from your Genesys Cloud org via <code>/api/v2/notifications/availabletopics</code> and grouped locally by functional area.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                <div className="space-y-2">
                  <Label>Functional group</Label>
                  <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select functional group" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All groups</SelectItem>
                      {groups.map((group) => (
                        <SelectItem key={group.key} value={group.key}>
                          {group.label} ({group.count})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Search topics</Label>
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="routing queues conversations calls" />
                </div>
              </div>

              <div className="space-y-2">
                <Label>WebSocket topic</Label>
                <Select value={effectiveSelectedTopicId || undefined} onValueChange={setSelectedTopicId}>
                  <SelectTrigger className="w-full font-mono text-xs">
                    <SelectValue placeholder={isLoading ? "Loading topics..." : "Select a WebSocket topic"} />
                  </SelectTrigger>
                  <SelectContent className="max-h-80 max-w-[min(90vw,52rem)]">
                    {filteredTopics.map((topic) => (
                      <SelectItem key={topic.id} value={topic.id} className="font-mono text-xs">
                        [{topic.groupLabel}] {topic.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {isLoading ? "Loading topics..." : `${filteredTopics.length} visible / ${topics.length} available topics`}
                </p>
              </div>

              {selectedTopic && (
                <Card className="bg-muted/30">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{selectedTopic.groupLabel}</Badge>
                      {selectedTopic.requiresObject && <Badge>requires object ID</Badge>}
                    </div>
                    <div className="font-mono text-sm break-all">{selectedTopic.id}</div>
                    <p className="text-sm text-muted-foreground">{selectedTopic.description}</p>

                    {selectedTopic.placeholders.length > 0 && (
                      <div className="grid gap-3 md:grid-cols-2">
                        {selectedTopic.placeholders.map((placeholder) => {
                          const options = objectOptions[placeholder.resourceKind] || [];
                          const loading = objectsLoading[placeholder.resourceKind];
                          return (
                            <div key={`${placeholder.index}-${placeholder.resourceKind}`} className="space-y-2">
                              <Label>
                                {placeholder.label} for placeholder #{placeholder.index + 1}
                              </Label>
                              {placeholder.resourceKind === "manual" ? (
                                <Input
                                  value={placeholderValues[placeholder.index] || ""}
                                  onChange={(event) => setPlaceholderValues((prev) => ({ ...prev, [placeholder.index]: event.target.value }))}
                                  placeholder="Paste Genesys object ID"
                                />
                              ) : (
                                <Select
                                  value={placeholderValues[placeholder.index] || undefined}
                                  onValueChange={(value) => setPlaceholderValues((prev) => ({ ...prev, [placeholder.index]: value }))}
                                  disabled={loading}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder={loading ? "Loading..." : `Select ${placeholder.label}`} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {options.map((option) => (
                                      <SelectItem key={option.id} value={option.id}>
                                        {option.name} — {option.id}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label>Resolved topic</Label>
                      <div className="rounded-md bg-background border p-3 font-mono text-xs break-all">{buildConcreteTopic()}</div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Button onClick={subscribe} disabled={!selectedTopic || isSubscribing} className="bg-telnyx-green hover:bg-telnyx-green/90">
                {isSubscribing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlugZap className="w-4 h-4 mr-2" />}
                Subscribe and monitor
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" /> Active subscriptions
                </CardTitle>
                <CardDescription>Remove individual active subscriptions or select one to inspect its live event window.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeSubscriptions.length === 0 ? (
                  <div className="text-sm text-muted-foreground rounded-lg border border-dashed p-6 text-center">
                    No active subscriptions yet.
                  </div>
                ) : (
                  activeSubscriptions.map((subscription) => {
                    const eventCount = (eventsByTopic[subscription.id] || []).length;
                    return (
                      <div
                        key={subscription.id}
                        className={`rounded-lg border p-3 space-y-2 ${selectedActiveTopic === subscription.id ? "border-telnyx-green bg-telnyx-green/5" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedActiveTopic(subscription.id)}
                          className="w-full text-left font-mono text-xs break-all"
                        >
                          {subscription.id}
                        </button>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">{subscription.groupLabel}</Badge>
                            <Badge variant="secondary">{eventCount} events</Badge>
                          </div>
                          <Button variant="destructive" size="sm" onClick={() => unsubscribe(subscription.id)}>
                            <Trash2 className="w-4 h-4 mr-1" /> Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Live event window</CardTitle>
                <CardDescription>
                  {selectedActiveTopic || "Select an active subscription to view its events."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {selectedEvents.length === 0 ? (
                  <div className="text-sm text-muted-foreground rounded-lg border border-dashed p-6 text-center">
                    Waiting for live events. Genesys also sends channel metadata/heartbeat messages on the WebSocket.
                  </div>
                ) : (
                  <div className="space-y-3 max-h-[540px] overflow-auto pr-2">
                    {selectedEvents.map((event, index) => (
                      <EventPayloadAccordion
                        key={`${event.receivedAt}-${index}`}
                        event={event}
                        eventNumber={selectedEvents.length - index}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Separator />
        <p className="text-xs text-muted-foreground">
          WebSocket channel IDs and subscriptions are transient Genesys resources. If you refresh the page, create a new channel and subscribe again.
        </p>
      </div>
    </div>
  );
}
