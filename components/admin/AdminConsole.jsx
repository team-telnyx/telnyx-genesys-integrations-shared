"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Activity, AudioLines, Bot, CalendarClock, Check, ChevronLeft, ChevronRight, CircleAlert,
  ExternalLink, Eye, Globe2, LayoutDashboard, Loader2, LogIn, MessageSquareText, Pencil, Play, Plus,
  RefreshCw, Rocket, Settings2, ShieldCheck, Trash2, Wrench, WandSparkles, X,
} from "lucide-react";
import { toast } from "sonner";

import WidgetAdmin from "@/components/widget-admin/WidgetAdmin";
import { webCallDeploymentDrift } from "@/lib/genesys/web-calls-drift.mjs";
import GenesysThemeToggle from "@/components/genesys/GenesysThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { SearchableMultiCombobox } from "@/components/ui/searchable-multi-combobox";
import { SectionRail, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  clearGenesysReauthRequired,
  createGenesysAdminApiError,
  GENESYS_REAUTH_REQUIRED_EVENT,
  genesysAuthenticatedFetch,
  shouldShowGenesysApiError,
} from "@/lib/genesys/admin-client-auth";

const CATALOG = [
  { id: "dashboard", name: "Dashboard", description: "Read-only overview of the integration and its managed resources.", icon: LayoutDashboard },
  { id: "ai", name: "AI & Channels", description: "Configure assistants, routing and Genesys/Telnyx channel infrastructure.", icon: AudioLines },
  { id: "tts", name: "Text-to-Speech", description: "Publish verified Telnyx voice providers to Genesys Cloud.", icon: Bot },
  { id: "widget", name: "Web Chat & Voice", description: "Design and publish customer-facing widget configurations.", icon: MessageSquareText },
  { id: "settings", name: "Settings", description: "Manage safe, installation-wide settings and inspect protected configuration.", icon: Settings2 },
];

const AI_NAV_GROUPS = [
  { label: "Foundation", items: [
    { id: "audio", label: "Audio Connector", icon: AudioLines, component: "audio" },
    { id: "assistants", label: "AI Assistants", icon: Bot },
    { id: "queues", label: "Queue Policies", icon: Activity },
  ] },
  { label: "Channel infrastructure", items: [
    { id: "inbound", label: "Inbound Calls", icon: Globe2, component: "audio" },
    { id: "web-voice", label: "Web Calls", icon: AudioLines },
    { id: "callbacks", label: "Callback Campaigns", icon: CalendarClock, component: "callbacks" },
    { id: "messaging", label: "Web Chat", icon: MessageSquareText, component: "widget" },
  ] },
];

const RAIL_ITEMS = CATALOG.map(({ id, name, description, icon }) => ({
  id,
  label: name,
  description,
  icon,
}));

const DEFAULT_CONFIG = {
  tts: { profiles: [], testFlowProfiles: [] },
  audio: {
    applicationName: "Telnyx Integrations", deploymentId: "CECA32", queueIds: [],
    defaultQueueId: "", widgetGroupIds: [], routes: [], createDefaultAssistant: true,
    assistantName: "",
    assistantUseCase: "", assistantInstructions: "", assistantGreeting: "",
    assistantContentGenerated: false,
  },
  callbacks: {
    applicationName: "Telnyx Integrations", deploymentId: "CALLBACKS", queueIds: [], defaultQueueId: "",
    assistantId: "", createAssistant: false, assistantName: "", assistantUseCase: "",
    assistantInstructions: "", assistantGreeting: "", assistantContentGenerated: false,
    callerAddress: "", callerName: "Telnyx Integrations", siteId: "", wrapupCodeId: "",
  },
  widget: {
    applicationName: "Telnyx Integrations", deploymentId: "WEBCHAT", queueIds: [], defaultQueueId: "",
  },
};

function handoffPoliciesByContext(policies = [], configs = {}) {
  const byContext = new Map(policies.map((policy) => [policy.context, policy]));
  return Object.fromEntries(QUEUE_POLICY_SCOPES.map((scope) => {
    const legacy = scope.component ? configs[scope.component] || {} : {};
    return [scope.context, byContext.get(scope.context) || {
      id: null,
      context: scope.context,
      queueIds: legacy.queueIds || [],
      defaultQueueId: legacy.defaultQueueId || "",
      source: scope.component ? "legacy" : "empty",
      desiredRevision: 0,
    }];
  }));
}

function configsWithHandoffPolicies(configs, policies) {
  const next = { ...configs };
  for (const scope of QUEUE_POLICY_SCOPES) {
    if (!scope.component) continue;
    const policy = policies[scope.context];
    if (!policy) continue;
    next[scope.component] = {
      ...next[scope.component],
      queueIds: policy.queueIds || [],
      defaultQueueId: policy.defaultQueueId || "",
    };
  }
  return next;
}

async function api(path, options = {}) {
  const response = await genesysAuthenticatedFetch(path, { cache: "no-store", headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw createGenesysAdminApiError(response, body);
  return body;
}

function mergeConfig(component, value) {
  return { ...structuredClone(DEFAULT_CONFIG[component]), ...(value || {}) };
}

function callbackConfigFromProfile(profile, fallback) {
  const config = mergeConfig("callbacks", fallback);
  if (!profile?.id || profile.source !== "desired") return config;
  return {
    ...config,
    queueIds: profile.queueIds || [],
    defaultQueueId: profile.defaultQueueId || "",
    assistantId: profile.assistantId || "",
    createAssistant: false,
    assistantName: "",
    assistantUseCase: "",
    assistantInstructions: "",
    assistantGreeting: "",
    assistantContentGenerated: false,
    callerAddress: profile.callerAddress || "",
    callerName: profile.callerName || "Telnyx Integrations",
    siteId: profile.siteId || "",
    wrapupCodeId: profile.wrapupCodeId || "",
  };
}

function ttsConfigFromInventory(inventory) {
  return {
    profiles: [...new Set((inventory.ttsDeployments || []).map((entry) => entry.profileId))].sort(),
    testFlowProfiles: [...new Set((inventory.ttsFlows || []).map((entry) => entry.profileId))].sort(),
  };
}

function ttsConfigFromLiveInventory(inventory) {
  // Genesys limits TTS connectors at the organization level. Live Genesys
  // inventory is therefore the canonical desired-state starting point for
  // every installation, rather than a DEV- or PROD-local saved draft.
  return ttsConfigFromInventory(inventory);
}

function audioConfigFromInventory(inventory, storedConfig) {
  const deployment = (inventory.audioDeployments || [])[0];
  const stored = mergeConfig("audio", storedConfig);
  const desiredRoutes = inventory.audioRoutingProfile?.source === "desired"
    ? inventory.audioRoutingProfile.routes || []
    : deployment?.config?.routes?.length
      ? deployment.config.routes
      : stored.routes || [];
  if (!deployment) return {
    ...stored,
    widgetGroupIds: stored.widgetGroupIds || [],
    routes: desiredRoutes,
    createDefaultAssistant: false,
    assistantName: "",
    assistantUseCase: "",
    assistantInstructions: "",
    assistantGreeting: "",
    assistantContentGenerated: false,
  };
  return {
    ...stored,
    ...deployment.config,
    queueIds: deployment.config.queueIds?.length ? deployment.config.queueIds : stored.queueIds || [],
    defaultQueueId: deployment.config.defaultQueueId || stored.defaultQueueId || "",
    widgetGroupIds: deployment.config.widgetGroupIds?.length
      ? deployment.config.widgetGroupIds
      : stored.widgetGroupIds || [],
    routes: desiredRoutes,
    deploymentId: deployment.id,
    applicationName: deployment.config.applicationName,
    // Assistant creation is a fresh draft for every new DNIS assignment.
    createDefaultAssistant: false,
    assistantName: "",
    assistantUseCase: "",
    assistantInstructions: "",
    assistantGreeting: "",
    assistantContentGenerated: false,
  };
}

function sameIds(left = [], right = []) {
  return [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n");
}

function ttsConfigChanged(config, inventory) {
  const live = ttsConfigFromInventory(inventory);
  return !sameIds(config.profiles, live.profiles) ||
    !sameIds(config.testFlowProfiles, live.testFlowProfiles);
}

function audioWebSocketEndpoint(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ""));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/genesys/audio-connector/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "Not configured";
  }
}

function Field({ label, hint, children, className = "" }) {
  return <div className={`grid gap-1.5 ${className}`}><Label>{label}</Label>{children}{hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>;
}

function QueuePicker({ entries, value, onChange, defaultQueueId, onDefaultChange }) {
  const [query, setQuery] = useState("");
  const selected = new Set(value || []);
  const visible = entries.filter((entry) =>
    !query || entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  );
  const change = (entry, checked) => {
    const next = checked ? [...selected, entry.id] : [...selected].filter((id) => id !== entry.id);
    onChange(next);
    if (!checked && defaultQueueId === entry.id) onDefaultChange("");
  };
  const changeDefault = (entry, checked) => {
    if (!checked) {
      if (defaultQueueId === entry.id) onDefaultChange("");
      return;
    }
    if (!selected.has(entry.id)) onChange([...selected, entry.id]);
    onDefaultChange(entry.id);
  };
  return <div className="space-y-3 rounded-xl border p-3">
    <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter Genesys queues…" />
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-[minmax(0,1fr)_100px] items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground"><span>Allowed queue</span><span className="text-right">Default</span></div>
      <div className="max-h-72 overflow-y-auto">
      {visible.map((entry) => <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_100px] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted">
        <label className="flex min-w-0 cursor-pointer items-center gap-3"><Checkbox checked={selected.has(entry.id)} onCheckedChange={(checked) => change(entry, checked === true)} /><span className="truncate">{entry.name}</span></label>
        <div className="flex justify-end"><Switch checked={defaultQueueId === entry.id} onCheckedChange={(checked) => changeDefault(entry, checked)} aria-label={`Use ${entry.name} as default queue`} /></div>
      </div>)}
      {!visible.length && <p className="px-3 py-5 text-center text-sm text-muted-foreground">No matching Genesys queues.</p>}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">Exactly one selected queue can be the default. It is used when the assistant omits a queue or returns a value outside the allowlist.</p>
  </div>;
}

function didSecondary(entry) {
  if (entry.routes?.length) {
    return `Assigned to inbound route: ${entry.routes.map((route) => route.name).join(", ")}`;
  }
  if (entry.assignee) return `Assigned to ${entry.assignee.name}`;
  return "Not currently used";
}

function TtsProviderPicker({
  entries,
  deployments,
  flows,
  profiles,
  testFlowProfiles,
  onChange,
  inventoryRefreshing = false,
  previews,
  setPreviews,
}) {
  const selected = new Set(profiles || []);
  const withTestFlow = new Set(testFlowProfiles || []);
  const [selectedProfileId, setSelectedProfileId] = useState(entries[0]?.id || "");
  const [playingProfileId, setPlayingProfileId] = useState(null);
  const audioRef = useRef(null);

  const patchPreview = useCallback((id, update) => {
    setPreviews((current) => ({
      ...current,
      [id]: { ...(current[id] || {}), ...(typeof update === "function" ? update(current[id] || {}) : update) },
    }));
  }, [setPreviews]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.audio.pause();
      URL.revokeObjectURL(audioRef.current.url);
      audioRef.current = null;
    }
    setPlayingProfileId(null);
  }, []);

  useEffect(() => () => stopAudio(), [stopAudio]);

  const defaultLanguage = (languages) =>
    languages.find((language) => language.toLowerCase() === "en-us") ||
    languages.find((language) => language.toLowerCase() === "en") ||
    languages.find((language) => language.toLowerCase().startsWith("en-")) ||
    languages[0] || "";

  const languageLabel = (language) => {
    try {
      const name = new Intl.DisplayNames(["en"], { type: "language" }).of(language);
      return name && name.toLowerCase() !== language.toLowerCase()
        ? `${name} · ${language}`
        : language;
    } catch {
      return language;
    }
  };

  const languageFlag = (language) => {
    try {
      const region = new Intl.Locale(language).maximize().region;
      if (!region || !/^[A-Z]{2}$/.test(region)) return "🌐";
      return String.fromCodePoint(...[...region].map((letter) => 127397 + letter.charCodeAt(0)));
    } catch {
      return "🌐";
    }
  };

  const generateSample = useCallback(async (id, language, useExpressiveMode) => {
    patchPreview(id, { generating: true, error: null });
    try {
      const body = await api(`/api/admin/tts/providers/${encodeURIComponent(id)}/sample-text`, {
        method: "POST",
        body: JSON.stringify({ language, useExpressiveMode }),
      });
      patchPreview(id, { text: body.sample.text, model: body.sample.model, generating: false });
    } catch (error) {
      patchPreview(id, { generating: false, error: error.message });
    }
  }, [patchPreview]);

  const loadPreview = useCallback(async (id, force = false) => {
    if (previews[id]?.catalog || previews[id]?.loading || (!force && previews[id]?.error)) return;
    patchPreview(id, { loading: true, error: null });
    try {
      const body = await api(`/api/admin/tts/providers/${encodeURIComponent(id)}/voices`);
      const language = defaultLanguage(body.catalog.languages || []);
      const voices = (body.catalog.voices || []).filter((voice) =>
        (voice.languages || []).includes(language)
      );
      const next = {
        catalog: body.catalog,
        voiceModel: "all",
        language,
        voiceId: voices[0]?.id || "",
        useExpressiveMode: false,
        text: "",
        model: null,
        loading: false,
        generating: true,
        error: null,
      };
      patchPreview(id, next);
      await generateSample(id, language, false);
    } catch (error) {
      patchPreview(id, { loading: false, generating: false, error: error.message });
    }
  }, [generateSample, patchPreview, previews]);

  useEffect(() => {
    if (!entries.some((entry) => entry.id === selectedProfileId)) {
      setSelectedProfileId(entries[0]?.id || "");
    }
  }, [entries, selectedProfileId]);

  useEffect(() => {
    if (selectedProfileId) void loadPreview(selectedProfileId);
  }, [loadPreview, selectedProfileId]);

  const selectModel = (id, voiceModel) => {
    const preview = previews[id];
    const voices = (preview.catalog?.voices || []).filter((voice) =>
      (voice.languages || []).includes(preview.language) &&
      (voiceModel === "all" || voice.model === voiceModel)
    );
    patchPreview(id, {
      voiceModel,
      voiceId: voices[0]?.id || "",
    });
  };

  const selectLanguage = (id, language) => {
    const preview = previews[id];
    const languageVoices = (preview.catalog?.voices || []).filter((voice) =>
      (voice.languages || []).includes(language)
    );
    const availableModels = new Set(languageVoices.map((voice) => voice.model).filter(Boolean));
    const voiceModel = preview.voiceModel === "all" || availableModels.has(preview.voiceModel)
      ? preview.voiceModel
      : "all";
    const voices = languageVoices.filter((voice) => voiceModel === "all" || voice.model === voiceModel);
    patchPreview(id, { language, voiceModel, voiceId: voices[0]?.id || "", text: "", error: null });
    void generateSample(id, language, Boolean(preview.useExpressiveMode));
  };

  const toggleExpressiveMode = (id, checked) => {
    const preview = previews[id];
    patchPreview(id, { useExpressiveMode: checked, text: "", error: null });
    void generateSample(id, preview.language, checked);
  };

  const playPreview = async (id) => {
    const preview = previews[id];
    if (!preview?.voiceId || !preview?.text?.trim()) return;
    stopAudio();
    setPlayingProfileId(id);
    patchPreview(id, { error: null });
    try {
      const response = await genesysAuthenticatedFetch(`/api/admin/tts/providers/${encodeURIComponent(id)}/preview`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: preview.voiceId,
          language: preview.language,
          text: preview.text,
          useExpressiveMode: Boolean(preview.useExpressiveMode),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Audio preview returned ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audioRef.current = { audio, url };
      audio.onended = stopAudio;
      audio.onerror = () => {
        patchPreview(id, { error: "The browser could not play the generated audio" });
        stopAudio();
      };
      await audio.play();
    } catch (error) {
      patchPreview(id, { error: error.message });
      stopAudio();
    }
  };

  const updateProvider = (id, checked) => {
    const nextProfiles = checked ? [...selected, id] : [...selected].filter((entry) => entry !== id);
    onChange(nextProfiles, [...withTestFlow]);
  };
  const updateTestFlow = (id, checked) => {
    onChange(
      [...selected],
      checked ? [...withTestFlow, id] : [...withTestFlow].filter((entry) => entry !== id)
    );
  };

  const entry = entries.find((candidate) => candidate.id === selectedProfileId) || entries[0];
  const deployment = deployments.find((candidate) => candidate.profileId === entry?.id);
  const flow = flows.find((candidate) => candidate.profileId === entry?.id);
  const connectorDesired = entry ? selected.has(entry.id) : false;
  const flowDesired = entry ? withTestFlow.has(entry.id) : false;
  const preview = entry ? previews[entry.id] || {} : {};
  const languageItems = (preview.catalog?.languages || []).map((language) => ({
    value: language,
    label: languageLabel(language),
    icon: languageFlag(language),
    keywords: [language],
  }));
  const languageVoices = (preview.catalog?.voices || []).filter((voice) =>
    (voice.languages || []).includes(preview.language)
  );
  const modelValues = [...new Set(languageVoices.map((voice) => voice.model).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const modelItems = [
    { value: "all", label: "All models" },
    ...modelValues.map((model) => ({ value: model, label: model })),
  ];
  const filteredVoices = languageVoices.filter((voice) =>
    (preview.voiceModel || "all") === "all" || voice.model === preview.voiceModel
  );
  const voiceItems = filteredVoices.map((voice) => ({
    value: voice.id,
    label: voice.name,
    secondary: [voice.id !== voice.name ? voice.id : null, voice.gender, voice.model].filter(Boolean).join(" · "),
    keywords: [voice.id, voice.gender, voice.model].filter(Boolean),
  }));
  return (
    <div className="grid h-full min-h-0 overflow-hidden bg-background lg:grid-cols-[360px_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <div className="border-b bg-muted/10 px-5 py-4 lg:col-start-1 lg:row-start-1 lg:border-r"><p className="font-semibold">TTS providers</p><p className="mt-1 text-sm text-muted-foreground">{entries.length} available</p></div>
      <aside className="min-h-0 overflow-y-auto border-b bg-muted/10 p-2 lg:col-start-1 lg:row-start-2 lg:border-b-0 lg:border-r">
          {entries.map((candidate) => {
            const candidateDeployment = deployments.find((item) => item.profileId === candidate.id);
            const connectorChanged = selected.has(candidate.id) !== Boolean(candidateDeployment);
            const flowChanged = withTestFlow.has(candidate.id) !== flows.some((item) => item.profileId === candidate.id);
            return <button key={candidate.id} type="button" onClick={() => setSelectedProfileId(candidate.id)} className={`mb-1 w-full rounded-lg border px-4 py-3 text-left transition-colors ${candidate.id === entry?.id ? "border-foreground bg-muted" : "border-transparent hover:bg-muted/60"}`} aria-pressed={candidate.id === entry?.id}>
              <div className="flex items-start justify-between gap-3"><span className="min-w-0"><span className="block truncate text-sm font-medium">{candidate.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{candidate.provider}</span></span>{inventoryRefreshing ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" /> : <Badge variant={candidateDeployment?.active ? "default" : "secondary"} className="shrink-0">{candidateDeployment?.active ? "Shared active" : candidateDeployment ? "Shared inactive" : "Not installed"}</Badge>}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">{selected.has(candidate.id) && <Badge variant="outline">Connector</Badge>}{withTestFlow.has(candidate.id) && <Badge variant="outline">Test flow</Badge>}{(connectorChanged || flowChanged) && <Badge variant="secondary" className="text-amber-700 dark:text-amber-300">Unsaved change</Badge>}</div>
            </button>;
          })}
      </aside>
      {entry && <>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 sm:px-6 lg:col-start-2 lg:row-start-1"><div><h3 className="text-lg font-semibold">{entry.name}</h3><p className="mt-1 text-sm text-muted-foreground">{entry.provider}</p></div>{inventoryRefreshing ? <Badge variant="secondary" className="gap-1.5"><Loader2 className="size-3 animate-spin" /> Verifying…</Badge> : <Badge variant={deployment?.active ? "default" : "secondary"}>{deployment?.active ? "Shared active" : deployment ? "Shared inactive" : "Not installed"}</Badge>}</div>
        <section className="min-h-0 min-w-0 overflow-y-auto lg:col-start-2 lg:row-start-2">
          <div className="space-y-6 p-5 sm:p-6">
            <div><h4 className="text-sm font-semibold">Shared organization settings</h4><p className="mt-1 text-sm text-muted-foreground">Choose which organization-wide Genesys resources should exist for this provider. The plan is built from live inventory and affects every connected installation.</p><div className="mt-3 grid gap-3 xl:grid-cols-2">
              <div className="flex items-start justify-between gap-4 rounded-lg border p-4"><div className="min-w-0"><p className="text-sm font-medium">TTS connector</p><p className="mt-1 truncate text-xs text-muted-foreground">{deployment?.name || entry.connectorName}</p>{!deployment && connectorDesired && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Will be created</p>}{deployment && !connectorDesired && <p className="mt-1 text-xs text-destructive">Will be deleted</p>}</div><Switch checked={connectorDesired} disabled={Boolean(deployment && !deployment.managed)} onCheckedChange={(checked) => updateProvider(entry.id, checked)} aria-label={`Desired connector for ${entry.name}`} /></div>
              <div className="flex items-start justify-between gap-4 rounded-lg border p-4"><div className="min-w-0"><p className="text-sm font-medium">Architect test flow</p><p className="mt-1 truncate text-xs text-muted-foreground">{flow?.name || entry.testFlowName}</p>{!flow && flowDesired && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Will be created</p>}{flow && !flowDesired && <p className="mt-1 text-xs text-destructive">Will be deleted</p>}{flow && flowDesired && !connectorDesired && <p className="mt-1 text-xs text-muted-foreground">Will be retained</p>}</div><Switch checked={flowDesired} disabled={!connectorDesired && !flow} onCheckedChange={(checked) => updateTestFlow(entry.id, checked)} aria-label={`Desired Architect test flow for ${entry.name}`} /></div>
            </div></div>
            <div className="border-t pt-6"><h4 className="text-sm font-semibold">Voice testing</h4><p className="mt-1 text-sm text-muted-foreground">Filter the provider catalog, select a voice and synthesize a browser preview.</p>
              {preview.loading && <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading available models, languages and voices…</div>}
              {!preview.loading && preview.catalog && <div className="mt-4 space-y-5"><div className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-[minmax(150px,0.7fr)_minmax(180px,0.8fr)_minmax(260px,1.4fr)_auto]">
                <Field label="Language"><SearchableCombobox items={languageItems} value={preview.language || ""} onValueChange={(language) => selectLanguage(entry.id, language)} searchPlaceholder="Filter languages…" emptyMessage="No matching languages." placeholder="Select language" ariaLabel={`Language for ${entry.name}`} /></Field>
                <Field label="Model"><SearchableCombobox items={modelItems} value={preview.voiceModel || "all"} onValueChange={(voiceModel) => selectModel(entry.id, voiceModel)} searchPlaceholder="Filter models…" emptyMessage="No matching models." placeholder="Select model" ariaLabel={`Model for ${entry.name}`} /></Field>
                <Field label="Voice"><SearchableCombobox items={voiceItems} value={preview.voiceId || ""} onValueChange={(voiceId) => patchPreview(entry.id, { voiceId })} searchPlaceholder="Filter voices…" emptyMessage="No voices match this filter." placeholder="Select voice" ariaLabel={`Voice for ${entry.name}`} /></Field>
                <Button type="button" className="min-w-28" disabled={!preview.voiceId || !preview.text?.trim() || preview.generating || Boolean(playingProfileId)} onClick={() => void playPreview(entry.id)} aria-label={`Play ${entry.name} voice sample`}>{playingProfileId === entry.id ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {playingProfileId === entry.id ? "Playing…" : "Play"}</Button>
              </div><div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-3"><div><Label>Test phrase</Label>{preview.model && <p className="mt-1 text-xs text-muted-foreground">Generated with {preview.model}</p>}</div><div className="flex items-center gap-4">{preview.catalog.expressiveMode?.supported && <label className="flex items-center gap-2 text-sm"><span>Use expressive mode</span><Switch checked={Boolean(preview.useExpressiveMode)} onCheckedChange={(checked) => toggleExpressiveMode(entry.id, checked)} aria-label={`Use expressive mode for ${entry.name}`} /></label>}<Button type="button" size="sm" variant="ghost" disabled={preview.generating} onClick={() => void generateSample(entry.id, preview.language, Boolean(preview.useExpressiveMode))}><RefreshCw className={`size-3.5 ${preview.generating ? "animate-spin" : ""}`} /> Regenerate</Button></div></div><Textarea rows={3} value={preview.text || ""} disabled={preview.generating} onChange={(event) => patchPreview(entry.id, { text: event.target.value })} placeholder={preview.generating ? "Generating a phrase in the selected language…" : "Enter a phrase to synthesize"} className="min-h-[5.5rem] resize-y" /></div></div>}
              {preview.error && <div className="mt-4 flex items-start justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><span>{preview.error}</span>{!preview.catalog && <Button type="button" size="sm" variant="outline" onClick={() => { patchPreview(entry.id, { error: null }); void loadPreview(entry.id, true); }}>Retry</Button>}</div>}
            </div>
          </div>
        </section>
      </>}
    </div>
  );
}

function TtsProviderListSkeleton() {
  return (
    <div role="status" aria-label="Loading TTS providers" className="grid h-full min-h-0 overflow-hidden bg-background lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="border-b bg-muted/10 lg:border-b-0 lg:border-r"><div className="border-b px-5 py-4"><Skeleton className="h-5 w-32" /><Skeleton className="mt-2 h-4 w-20" /></div><div className="p-2">{Array.from({ length: 11 }, (_, index) => <div key={index} className="mb-1 rounded-lg px-4 py-3"><div className="flex justify-between gap-3"><div className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-24" /></div><Skeleton className="h-6 w-20 rounded-full" /></div></div>)}</div></div>
      <div><div className="border-b px-6 py-4"><Skeleton className="h-6 w-44" /><Skeleton className="mt-2 h-4 w-24" /></div><div className="space-y-6 p-6"><div><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /><div className="mt-4 grid gap-3 xl:grid-cols-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div></div><div className="border-t pt-6"><Skeleton className="h-4 w-28" /><Skeleton className="mt-2 h-4 w-96 max-w-full" /><div className="mt-4 grid gap-4 xl:grid-cols-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-10 w-28" /></div></div></div></div>
      <span className="sr-only">Loading TTS provider inventory…</span>
    </div>
  );
}

function AudioRouteMappings({ routes = [], onChange, genesysDids = [], assistants = [], managedCallRouteId, managedCallRouteName = "Telnyx Integrations", onPendingEditChange }) {
  const [dnisValues, setDnisValues] = useState([]);
  const [assistantId, setAssistantId] = useState("");
  const [editingAssistantId, setEditingAssistantId] = useState("");
  const [editedDnisValues, setEditedDnisValues] = useState([]);
  const [takeoverPrompt, setTakeoverPrompt] = useState(null);
  const used = new Set(routes.map((route) => route.dnis));
  const groupedRoutes = [];
  const groupedByAssistantId = new Map();
  for (const route of routes) {
    let group = groupedByAssistantId.get(route.assistantId);
    if (!group) {
      group = {
        assistantId: route.assistantId,
        assistantName: route.assistantName,
        dnisValues: [],
      };
      groupedByAssistantId.set(route.assistantId, group);
      groupedRoutes.push(group);
    }
    group.dnisValues.push(route.dnis);
  }
  const mappedAssistantIds = new Set(groupedRoutes.map((group) => group.assistantId));
  const assistantById = new Map(assistants.map((assistant) => [assistant.id, assistant]));
  const targetAssistantId = assistantId;
  const targetAssistantName = assistantById.get(assistantId)?.name;
  const dnisItems = genesysDids
    .filter((entry) => !used.has(entry.dnis))
    .map((entry) => ({
      value: entry.dnis,
      label: entry.dnis,
      secondary: didSecondary(entry),
    }));
  const assistantItems = assistants
    .filter((assistant) => !mappedAssistantIds.has(assistant.id))
    .map((assistant) => ({
      value: assistant.id,
      label: assistant.name,
      secondary: assistant.id,
    }));
  useEffect(() => () => onPendingEditChange?.(false), [onPendingEditChange]);
  const takeoverConflicts = (values, currentValues = []) => {
    const current = new Set(currentValues);
    return values.flatMap((dnis) => {
      if (current.has(dnis)) return [];
      const did = genesysDids.find((entry) => entry.dnis === dnis);
      const occupiedRoutes = (did?.routes || []).filter((route) => route.id !== managedCallRouteId);
      const owner = did?.assignee?.id && did.assignee.id !== managedCallRouteId &&
        !occupiedRoutes.some((route) => route.id === did.assignee.id)
        ? did.assignee
        : null;
      const assignments = [
        ...occupiedRoutes.map((route) => ({
          id: route.id,
          name: route.name || route.id,
          type: "INBOUND_CALL_ROUTE",
        })),
        ...(owner ? [{ id: owner.id, name: owner.name || owner.id, type: owner.type || "UNKNOWN" }] : []),
      ];
      return assignments.length ? [{ dnis, routes: occupiedRoutes, owner, assignments }] : [];
    });
  };
  const routesWithTakeover = (values, targetAssistantId, assistantName, conflicts = []) => {
    const approved = new Map(conflicts.map((conflict) => [conflict.dnis, conflict]));
    return values.map((dnis) => ({
      dnis,
      assistantId: targetAssistantId,
      ...(assistantName ? { assistantName } : {}),
      ...(approved.has(dnis) ? {
        takeover: true,
        ...(approved.get(dnis)?.owner ? { takeoverOwner: approved.get(dnis).owner } : {}),
      } : {}),
    }));
  };
  const commitAdd = (conflicts = []) => {
    const duplicate = dnisValues.find((dnis) => used.has(dnis));
    if (duplicate) {
      toast.error(`${duplicate} is already assigned to an assistant`);
      return;
    }
    const assistant = assistantById.get(targetAssistantId);
    onChange([
      ...routes,
      ...routesWithTakeover(dnisValues, targetAssistantId, targetAssistantName || assistant?.name, conflicts),
    ]);
    setDnisValues([]);
    setAssistantId("");
    onPendingEditChange?.(false);
  };
  const add = () => {
    if (!dnisValues.length || !targetAssistantId || mappedAssistantIds.has(targetAssistantId)) return;
    const duplicate = dnisValues.find((dnis) => used.has(dnis));
    if (duplicate) {
      toast.error(`${duplicate} is already assigned to an assistant`);
      return;
    }
    const conflicts = takeoverConflicts(dnisValues);
    if (conflicts.length) {
      setTakeoverPrompt({ mode: "add", conflicts, assistantId: targetAssistantId, assistantName: targetAssistantName || assistantById.get(targetAssistantId)?.name || targetAssistantId });
      onPendingEditChange?.(true);
      return;
    }
    commitAdd();
  };
  const editItems = (group) => {
    const current = new Set(group.dnisValues);
    const items = genesysDids
      .filter((entry) => !used.has(entry.dnis) || current.has(entry.dnis))
      .map((entry) => ({
        value: entry.dnis,
        label: entry.dnis,
        secondary: didSecondary(entry),
      }));
    for (const dnis of group.dnisValues) {
      if (!items.some((entry) => entry.value === dnis)) {
        items.unshift({ value: dnis, label: dnis, secondary: "Current assignment" });
      }
    }
    return items;
  };
  const beginEdit = (group) => {
    setEditingAssistantId(group.assistantId);
    setEditedDnisValues([...group.dnisValues]);
    onPendingEditChange?.(true);
  };
  const cancelEdit = () => {
    setEditingAssistantId("");
    setEditedDnisValues([]);
    onPendingEditChange?.(false);
  };
  const commitEdit = (conflicts = []) => {
    if (!editingAssistantId || !editedDnisValues.length) return;
    const currentGroup = groupedByAssistantId.get(editingAssistantId);
    if (!currentGroup) return;
    const current = new Set(currentGroup.dnisValues);
    const duplicate = editedDnisValues.find((dnis) => used.has(dnis) && !current.has(dnis));
    if (duplicate) {
      toast.error(`${duplicate} is already assigned to another assistant`);
      return;
    }
    const original = routes.find((route) => route.assistantId === editingAssistantId);
    onChange([
      ...routes.filter((route) => route.assistantId !== editingAssistantId),
      ...routesWithTakeover(editedDnisValues, editingAssistantId, original?.assistantName, conflicts),
    ]);
    cancelEdit();
  };
  const saveEdit = () => {
    if (!editingAssistantId || !editedDnisValues.length) return;
    const currentGroup = groupedByAssistantId.get(editingAssistantId);
    if (!currentGroup) return;
    const current = new Set(currentGroup.dnisValues);
    const duplicate = editedDnisValues.find((dnis) => used.has(dnis) && !current.has(dnis));
    if (duplicate) {
      toast.error(`${duplicate} is already assigned to another assistant`);
      return;
    }
    const conflicts = takeoverConflicts(editedDnisValues, currentGroup.dnisValues);
    if (conflicts.length) {
      setTakeoverPrompt({
        mode: "edit",
        conflicts,
        assistantId: editingAssistantId,
        assistantName: assistantById.get(editingAssistantId)?.name || currentGroup.assistantName || editingAssistantId,
      });
      return;
    }
    commitEdit();
  };
  const dismissTakeoverPrompt = () => {
    const mode = takeoverPrompt?.mode;
    setTakeoverPrompt(null);
    if (mode === "add") onPendingEditChange?.(false);
  };
  const confirmTakeover = () => {
    if (!takeoverPrompt) return;
    if (takeoverPrompt.mode === "edit") commitEdit(takeoverPrompt.conflicts);
    else commitAdd(takeoverPrompt.conflicts);
    setTakeoverPrompt(null);
  };
  const removeGroup = (group) => {
    onChange(routes.filter((entry) => entry.assistantId !== group.assistantId));
  };
  return (
    <>
    <div className="space-y-4 rounded-xl border p-5 lg:col-span-2">
      <div>
        <p className="font-medium">DNIS → Telnyx AI assistant assignments</p>
        <p className="mt-1 text-xs text-muted-foreground">Select one or more Genesys DID numbers for each assistant. Each DNIS can appear once; all numbers assigned to the same assistant are combined in one Architect case.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] lg:items-start">
        <Field label={`Genesys DIDs (${dnisItems.length})`}>
          <SearchableMultiCombobox strictFilter items={dnisItems} value={dnisValues} onValueChange={setDnisValues} searchPlaceholder="Filter DID or assignee…" emptyMessage="No available Genesys DID." placeholder="Select Genesys DIDs" selectedSuffix="DIDs selected" ariaLabel="Select Genesys DIDs" />
        </Field>
        <Field label={`Telnyx AI assistant (${assistantItems.length})`} hint="Create new assistants in AI Assistants before assigning their DNIS numbers here.">
          <SearchableCombobox items={assistantItems} value={assistantId} onValueChange={setAssistantId} searchPlaceholder="Filter assistants…" emptyMessage="No Telnyx assistants found." placeholder="Select assistant" ariaLabel="Select Telnyx AI assistant" />
        </Field>
        <Button type="button" className="bg-foreground text-background hover:bg-foreground/90 lg:mt-5" disabled={!dnisValues.length || !targetAssistantId || mappedAssistantIds.has(targetAssistantId)} onClick={add}><Plus className="size-4" /> Add</Button>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="grid grid-cols-[minmax(260px,1fr)_minmax(260px,1.2fr)_96px] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground"><span>Genesys DIDs</span><span>Telnyx AI assistant</span><span className="sr-only">Actions</span></div>
        {groupedRoutes.map((group) => {
          const assistant = assistantById.get(group.assistantId);
          const editing = editingAssistantId === group.assistantId;
          const current = new Set(group.dnisValues);
          const duplicate = editedDnisValues.some((dnis) => used.has(dnis) && !current.has(dnis));
          const assistantLabel = assistant?.name || group.assistantName || "Assistant unavailable";
          return <div key={group.assistantId} className="grid grid-cols-[minmax(260px,1fr)_minmax(260px,1.2fr)_96px] items-center gap-3 border-b px-4 py-3 last:border-b-0">
            {editing
              ? <SearchableMultiCombobox strictFilter items={editItems(group)} value={editedDnisValues} onValueChange={setEditedDnisValues} searchPlaceholder="Filter Genesys DID numbers…" emptyMessage="No available Genesys DID." placeholder="Select Genesys DIDs" selectedSuffix="DIDs selected" ariaLabel={`Edit DNIS assignments for ${assistantLabel}`} />
              : <div className="flex flex-wrap gap-1.5">{group.dnisValues.map((dnis) => <Badge key={dnis} variant="outline" className="font-mono font-normal">{dnis}</Badge>)}</div>}
            <div className="min-w-0"><p className="truncate text-sm font-medium">{assistantLabel}</p><p className="truncate text-xs text-muted-foreground">{group.assistantId}</p></div>
            <div className="flex justify-end">
              {editing ? <>
                <Button type="button" variant="ghost" size="icon" disabled={!editedDnisValues.length || duplicate} aria-label={`Save DNIS assignments for ${assistantLabel}`} onClick={saveEdit}><Check className="size-4" /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Cancel editing ${assistantLabel}`} onClick={cancelEdit}><X className="size-4" /></Button>
              </> : <>
                <Button type="button" variant="ghost" size="icon" aria-label={`Edit DNIS assignments for ${assistantLabel}`} onClick={() => beginEdit(group)}><Pencil className="size-4" /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove mapping for ${assistantLabel}`} onClick={() => removeGroup(group)}><Trash2 className="size-4" /></Button>
              </>}
            </div>
          </div>;
        })}
        {!groupedRoutes.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Add at least one assignment.</p>}
      </div>
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /><p>The application appends a clearly separated handoff section to each selected assistant and preserves its existing instructions. Review the result in Telnyx—manual instruction tuning may still be required for the assistant to invoke handoff reliably.</p></div>
    </div>
    <Dialog open={Boolean(takeoverPrompt)} onOpenChange={(open) => { if (!open) dismissTakeoverPrompt(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign Genesys DID?</DialogTitle>
          <DialogDescription>
            Confirming adds the reassignment to the deployment plan. During deployment, each DID is removed from its current Genesys assignee or inbound call route and then attached to {managedCallRouteName} and the selected Telnyx AI assistant.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(takeoverPrompt?.conflicts || []).map((conflict) => <div key={conflict.dnis} className="rounded-lg border p-3">
            <p className="font-mono text-sm font-medium">{conflict.dnis}</p>
            <p className="mt-1 text-sm text-muted-foreground">Currently assigned to {conflict.assignments.map((assignment) => `${assignment.name} (${assignment.type})`).join(", ")}.</p>
          </div>)}
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p>Target: Audio Connector flow <span className="font-medium">{managedCallRouteName}</span> → assistant <span className="font-medium">{takeoverPrompt?.assistantName}</span>. The current assignee will stop receiving calls for the selected DID.</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={dismissTakeoverPrompt}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={confirmTakeover}><Check className="size-4" /> Confirm reassignment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function ConfigFields({ component, section = null, config, setConfig, inventory, inventoryLoading = false, ttsUiStore, onNavigate }) {
  const set = (name, value) => setConfig((current) => ({ ...current, [name]: value }));
  if (component === "tts") return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {!(inventory.ttsProfiles || []).length ? <TtsProviderListSkeleton /> : <TtsProviderPicker
          entries={inventory.ttsProfiles || []}
          deployments={inventory.ttsDeployments || []}
          flows={inventory.ttsFlows || []}
          profiles={config.profiles}
          testFlowProfiles={config.testFlowProfiles}
          inventoryRefreshing={inventoryLoading}
          previews={ttsUiStore.previews}
          setPreviews={ttsUiStore.setPreviews}
          onChange={(profiles, testFlowProfiles) => setConfig((current) => ({ ...current, profiles, testFlowProfiles }))}
        />}
      </div>
    </div>
  );
  if (component === "audio") {
    const deployments = inventory.audioDeployments || [];
    const selectedDeployment = deployments.find((entry) => entry.id === config.deploymentId) || deployments[0];
    if (section === "audio") {
      const connector = selectedDeployment?.connector;
      const endpoint = audioWebSocketEndpoint(selectedDeployment?.publicBaseUrl || inventory.publicBaseUrl);
      const routes = selectedDeployment?.config?.routes || [];
      const assistants = new Set(routes.map((route) => route.assistantId).filter(Boolean));
      const agentExperience = selectedDeployment?.agentExperience;
      const agentWidget = agentExperience?.widget;
      const handoffScript = agentExperience?.script;
      const widgetGroupItems = (inventory.groups || []).map((group) => ({ value: group.id, label: group.name, secondary: group.type || group.id }));
      const callRoute = selectedDeployment?.architectFlow?.references?.callRoutes?.find((entry) => entry.id === selectedDeployment.resources?.callRouteId)
        || selectedDeployment?.architectFlow?.references?.callRoutes?.[0];
      if (selectedDeployment) return <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Managed Audio Connector</h2><p className="mt-1 text-sm text-muted-foreground">Observed Genesys configuration for the connector owned by this integration.</p></div><div className="flex flex-wrap gap-2"><Badge variant={connector?.active ? "default" : "destructive"}>{connector?.state || "Unknown"}</Badge><Badge variant="outline">{inventory.audioCapacity?.used ?? 0} of {inventory.audioCapacity?.total ?? 10} connector slots used</Badge></div></div>
        <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Connector runtime</CardTitle><CardDescription>{selectedDeployment.name} · deployment {selectedDeployment.id} · last synchronized {selectedDeployment.updatedAt ? new Date(selectedDeployment.updatedAt).toLocaleString() : "from current Genesys inventory"}</CardDescription></div><Badge variant="default">Deployed</Badge></div></CardHeader><CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Genesys integration ID</p><p className="mt-2 break-all font-mono text-xs">{connector?.id || selectedDeployment.resources?.audioConnectorIntegrationId || "Unavailable"}</p></div>
          <div className="rounded-lg border bg-muted/20 p-4 md:col-span-2"><p className="text-xs font-medium text-muted-foreground">AudioHook WebSocket endpoint</p><p className="mt-2 break-all font-mono text-xs">{endpoint}</p></div>
          <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Media contract</p><p className="mt-2 text-sm font-medium">Mono PCMU or L16 · 8 kHz</p><p className="mt-1 text-xs text-muted-foreground">Authenticated Genesys AudioHook WebSocket</p></div>
        </CardContent></Card>
        <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Agent Experience</CardTitle><CardDescription>Genesys interaction widget opened for an assigned agent during an AI handoff.</CardDescription></div><Badge variant={agentExperience?.status === "healthy" ? "default" : agentExperience?.status ? "destructive" : "secondary"}>{agentExperience?.status || "Inventory unavailable"}</Badge></div></CardHeader><CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Interaction widget</p><p className="mt-2 text-sm font-medium">{agentWidget?.name || selectedDeployment.name}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{agentWidget?.id || selectedDeployment.resources?.widgetId || "Unavailable"}</p><div className="mt-2 flex flex-wrap gap-1"><Badge variant={agentWidget?.status === "healthy" ? "default" : "outline"}>{agentWidget?.status || "unknown"}</Badge><Badge variant="outline">{agentWidget?.reportedState || "UNKNOWN"}</Badge></div></div>
            <div className="rounded-lg border bg-muted/20 p-4 md:col-span-2"><p className="text-xs font-medium text-muted-foreground">Widget URL</p><p className="mt-2 break-all font-mono text-xs">{agentWidget?.url || "Unavailable"}</p><p className="mt-1 text-xs text-muted-foreground">Conversation binding: gcConversationId · communication type: {agentWidget?.communicationType || "call"}</p></div>
            <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Managed handoff script</p><p className="mt-2 text-sm font-medium">{handoffScript?.name || selectedDeployment.name}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{handoffScript?.id || selectedDeployment.resources?.scriptId || "Unavailable"}</p><div className="mt-2 flex flex-wrap gap-1"><Badge variant={handoffScript?.status === "healthy" ? "default" : "outline"}>{handoffScript?.status || "unknown"}</Badge>{handoffScript?.published && <Badge variant="outline">Published</Badge>}</div></div>
            <div className="rounded-lg border bg-muted/20 p-4 md:col-span-2"><p className="text-xs font-medium text-muted-foreground">Agent context</p><div className="mt-2 flex flex-wrap gap-1">{["Transcript", "Summary", "Intent & sentiment", "Insights", "Dynamic variables", "Costs"].map((feature) => <Badge key={feature} variant="outline">{feature}</Badge>)}</div><p className="mt-2 text-xs text-muted-foreground">The API verifies that the signed-in Genesys user is assigned to the active interaction before returning Telnyx conversation data.</p></div>
          </div>
          <div className="grid items-start gap-4 rounded-xl border p-4 lg:grid-cols-2">
            <Field className="self-start" label="Agent access groups" hint="Only agents in the selected Genesys groups can open the widget. Changes are applied through the Audio Connector deployment plan."><SearchableMultiCombobox strictFilter items={widgetGroupItems} value={config.widgetGroupIds || []} onValueChange={(value) => set("widgetGroupIds", value)} searchPlaceholder="Filter Genesys groups…" emptyMessage="No Genesys groups found." placeholder="Select agent access groups" selectedSuffix="groups selected" ariaLabel="Select Agent Experience access groups" /></Field>
            <div className="grid self-start gap-1.5"><Label>Queue visibility</Label><div className="rounded-lg border bg-muted/20 p-3 text-sm"><p>{agentWidget?.queues?.length || selectedDeployment.queues?.length || 0} Audio handoff queues</p><p className="mt-1 text-xs text-muted-foreground">Inherited from Queue Policies → Audio and not edited separately for the widget.</p></div></div>
          </div>
          {agentExperience && agentExperience.status !== "healthy" && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><p className="font-medium">Agent Experience requires reconciliation.</p><p className="mt-1 text-muted-foreground">{agentWidget?.drift?.length ? `Detected drift: ${agentWidget.drift.join(", ")}. ` : ""}Build and apply the Audio Connector plan to restore the managed widget and handoff script.</p></div>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Routing dependencies</CardTitle><CardDescription>Architect resources and desired routing that deliver the caller to Telnyx AI and back to a Genesys agent.</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Inbound Architect flow</p><p className="mt-2 text-sm font-medium">{selectedDeployment.architectFlow?.name || "Unavailable"}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{selectedDeployment.resources?.flowId || "—"}</p></div>
          <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Inbound call route</p><p className="mt-2 text-sm font-medium">{callRoute?.name || "Unavailable"}</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{selectedDeployment.resources?.callRouteId || "—"}</p></div>
          <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium text-muted-foreground">Routing coverage</p><p className="mt-2 text-sm font-medium">{routes.length} DNIS · {assistants.size} assistant{assistants.size === 1 ? "" : "s"}</p><p className="mt-1 text-xs text-muted-foreground">{selectedDeployment.queues?.length || 0} handoff queues · default {selectedDeployment.defaultQueue?.name || "not recorded"}</p></div>
        </CardContent></Card>
        <div className="rounded-xl border bg-muted/20 p-4 text-sm"><p className="font-medium">Configuration ownership</p><p className="mt-1 text-muted-foreground">DNIS assignments are edited in Inbound Calls and handoff queues in Queue Policies. Assistant tools, insights, privacy settings and instruction inserts are owned by their channel deployments and shown read-only in AI Assistants.</p></div>
      </div>;
      const prerequisites = [
        { label: "Public application URL", ready: Boolean(inventory.publicBaseUrl), detail: inventory.publicBaseUrl || "Required for the AudioHook WebSocket endpoint", target: "settings" },
        { label: "AI assistant", ready: Boolean((inventory.telnyxAssistants || []).length), detail: (inventory.telnyxAssistants || []).length ? `${inventory.telnyxAssistants.length} available` : "Create or discover at least one Telnyx assistant", target: "ai", section: "assistants" },
        { label: "Audio handoff queue policy", ready: Boolean(config.queueIds?.length && config.defaultQueueId), detail: config.queueIds?.length ? `${config.queueIds.length} allowed queues · default selected` : "Select allowed and default Genesys queues", target: "ai", section: "queues" },
        { label: "Inbound DNIS routing", ready: inventory.audioRoutingProfile?.source === "desired" && Boolean(config.routes?.length), detail: config.routes?.length ? `${config.routes.length} DNIS assignments saved` : "Assign at least one Genesys DNIS to an assistant", target: "ai", section: "inbound" },
        { label: "Agent Experience access", ready: Boolean(config.widgetGroupIds?.length), detail: config.widgetGroupIds?.length ? `${config.widgetGroupIds.length} Genesys groups selected` : "Select the groups whose agents can open the conversation widget" },
      ];
      return <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">New Audio Connector</h2><p className="mt-1 text-sm text-muted-foreground">No managed connector is deployed yet. Complete the prerequisites, then use Deploy Audio Connector below to build a reviewable creation plan.</p></div><Badge variant="secondary">Not deployed</Badge></div>
        <Card><CardHeader><CardTitle>Creation readiness</CardTitle><CardDescription>The connector is created only after you review and accept the generated plan.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">{prerequisites.map((item) => <div key={item.label} className="flex items-start gap-3 rounded-lg border p-4"><div className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ${item.ready ? "bg-emerald-500 text-black" : "bg-muted"}`}>{item.ready ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5 text-muted-foreground" />}</div><div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.label}</p><p className="mt-1 text-xs text-muted-foreground">{item.detail}</p></div>{!item.ready && item.target && <Button size="sm" variant="outline" onClick={() => onNavigate?.(item.target, item.section)}>Configure</Button>}</div>)}</CardContent></Card>
        <Card><CardHeader><CardTitle>Agent Experience Widget</CardTitle><CardDescription>Created and activated together with the Audio Connector for agents receiving AI handoffs.</CardDescription></CardHeader><CardContent className="space-y-4"><Field label="Agent access groups" hint="Select every Genesys group whose agents should see the widget on an eligible call."><SearchableMultiCombobox strictFilter items={widgetGroupItems} value={config.widgetGroupIds || []} onValueChange={(value) => set("widgetGroupIds", value)} searchPlaceholder="Filter Genesys groups…" emptyMessage="No Genesys groups found." placeholder="Select agent access groups" selectedSuffix="groups selected" ariaLabel="Select Agent Experience access groups" /></Field><div className="flex flex-wrap gap-1">{["Transcript", "Summary", "Intent & sentiment", "Insights", "Dynamic variables", "Costs"].map((feature) => <Badge key={feature} variant="outline">{feature}</Badge>)}</div><p className="text-xs text-muted-foreground">Queue visibility is inherited automatically from Queue Policies → Audio. The widget URL, OAuth callback and conversation binding remain system-managed.</p></CardContent></Card>
        <div className="rounded-xl border bg-muted/20 p-4 text-sm"><p className="font-medium">What the Audio Connector deployment creates</p><p className="mt-1 text-muted-foreground">A dedicated Genesys Audio Connector integration, authenticated AudioHook endpoint, inbound Architect flow and call route, Agent Experience interaction widget, published handoff script, and the required Telnyx assistant tools.</p></div>
      </div>;
    }
    return <div className="grid gap-5 lg:grid-cols-2">
      <Field label="Deployment name" className="lg:col-span-2"><Input className="bg-background" readOnly value={inventory.installation?.installationName || "Telnyx Integrations"} aria-label="Audio Connector deployment name" /></Field>
      <Field label="Global allowed Genesys queues" hint="This legacy deployment view is retained for plan compatibility while policies move to the central Queue Policies editor." className="lg:col-span-2"><QueuePicker entries={inventory.queues || []} value={config.queueIds} onChange={(value) => set("queueIds", value)} defaultQueueId={config.defaultQueueId || ""} onDefaultChange={(value) => set("defaultQueueId", value)} /></Field>
    </div>;
  }
  return null;
}

function OverviewMetric({ label, value, detail, icon: Icon }) {
  return <div className="rounded-xl border bg-background p-4">
    <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium text-muted-foreground">{label}</p>{Icon && <Icon className="size-4 text-telnyx-green" />}</div>
    <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
    {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
  </div>;
}

const DASHBOARD_STATE_LABELS = Object.freeze({
  shared: "Shared · Healthy",
  deployed: "Deployed",
  configured: "Configured",
  configuration_required: "Configuration required",
  deployment_required: "Deployment required",
  not_configured: "Not configured",
  reconciling: "Reconciling",
  healthy: "Healthy",
  missing: "Missing",
  drifted: "Drift detected",
  error: "Error",
  unknown: "Unknown",
});

function dashboardStatusVariant(status) {
  if (["deployed", "configured", "healthy", "shared"].includes(status)) return "default";
  if (["missing", "drifted", "error"].includes(status)) return "destructive";
  return "secondary";
}

function DashboardHeaderActions({ inventory, overview, refreshing, onRefresh }) {
  const latestSync = overview?.latestSync;
  const warningCount = inventory.warnings?.length || 0;
  const status = latestSync?.status || "not_recorded";
  const statusLabel = status === "succeeded" ? "Succeeded" : status === "partial" ? "Partial" : status === "failed" ? "Failed" : status === "running" ? "Running" : "Not recorded";
  const statusVariant = status === "failed" || warningCount ? "destructive" : status === "succeeded" ? "default" : "secondary";
  const synchronizedAt = latestSync?.completedAt || latestSync?.startedAt || inventory.refreshedAt;
  return <div className="flex flex-wrap items-center justify-end gap-3">
    <div className="text-right">
      <div className="flex items-center justify-end gap-2"><p className="text-xs font-medium">Latest inventory synchronization</p><Badge variant={statusVariant}>{statusLabel}</Badge></div>
      <p className="mt-1 text-xs text-muted-foreground">{synchronizedAt ? new Date(synchronizedAt).toLocaleString() : "Not synchronized yet"}{warningCount ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}</p>
    </div>
    <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>{refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {refreshing ? "Refreshing…" : "Refresh"}</Button>
  </div>;
}

function DashboardHeaderActionsSkeleton() {
  return <div role="status" aria-label="Loading dashboard synchronization status" className="flex items-center justify-end gap-3">
    <div className="space-y-2 text-right"><Skeleton className="ml-auto h-4 w-48" /><Skeleton className="ml-auto h-3 w-36" /></div>
    <Skeleton className="h-8 w-24 rounded-md" />
    <span className="sr-only">Loading dashboard synchronization status…</span>
  </div>;
}

function DashboardPanelSkeleton() {
  return <div role="status" aria-label="Loading dashboard data" className="mx-auto w-full max-w-[1600px] space-y-6" aria-busy="true">
    <section className="space-y-3">
      <div className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-[34rem] max-w-full" /></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="rounded-xl border bg-background p-4">
          <div className="flex items-center justify-between gap-3"><Skeleton className="h-4 w-28" /><Skeleton className="size-4 rounded-full" /></div>
          <Skeleton className="mt-3 h-9 w-16" />
          <Skeleton className="mt-2 h-3 w-36 max-w-full" />
        </div>)}
      </div>
    </section>
    <section className="space-y-3">
      <div className="space-y-2"><Skeleton className="h-5 w-44" /><Skeleton className="h-4 w-[38rem] max-w-full" /></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="rounded-xl border bg-background p-4">
          <div className="flex items-start justify-between gap-3"><Skeleton className="h-4 w-32" /><Skeleton className="size-4" /></div>
          <Skeleton className="mt-3 h-6 w-28 rounded-full" />
          <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3"><div className="space-y-2"><Skeleton className="h-7 w-10" /><Skeleton className="h-3 w-16" /></div><div className="space-y-2"><Skeleton className="h-7 w-10" /><Skeleton className="h-3 w-16" /></div></div>
          <Skeleton className="mt-3 h-3 w-36 max-w-full" />
        </div>)}
      </div>
    </section>
    <span className="sr-only">Loading integration overview and configuration coverage…</span>
  </div>;
}

function AdminConsoleLoadingSkeleton() {
  return <main role="status" aria-label="Loading administration application" className="fixed inset-0 min-h-0 overflow-hidden bg-background" aria-busy="true">
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20">
      <header className="flex h-14 shrink-0 items-center border-b bg-background"><div className="flex w-full items-center gap-3 px-4 lg:px-6"><Skeleton className="h-7 w-28" /><div className="h-5 w-px bg-border" /><div className="space-y-1.5"><Skeleton className="h-4 w-64 max-w-[45vw]" /><Skeleton className="h-3 w-44 max-w-[35vw]" /></div><div className="ml-auto flex gap-2"><Skeleton className="size-8 rounded-md" /><Skeleton className="size-8 rounded-md" /></div></div></header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 md:grid md:grid-cols-[var(--section-rail-width)_minmax(0,1fr)]" style={{ "--section-rail-width": SECTION_RAIL_WIDTH }}>
        <nav className="flex max-h-[86px] gap-2 overflow-hidden rounded-xl border bg-background p-2 md:max-h-none md:flex-col">{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex min-w-36 items-center gap-3 rounded-lg p-3 md:min-w-0"><Skeleton className="size-8 shrink-0 rounded-lg" /><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-24 max-w-full" /><Skeleton className="h-3 w-full" /></div></div>)}</nav>
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.25rem] border bg-card shadow-sm">
          <CardHeader className="shrink-0 border-b p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex min-w-0 flex-1 items-center gap-3"><Skeleton className="size-10 rounded-lg" /><div className="space-y-2"><Skeleton className="h-7 w-36" /><Skeleton className="h-4 w-72 max-w-[55vw]" /></div></div><DashboardHeaderActionsSkeleton /></div></CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8"><DashboardPanelSkeleton /></CardContent>
        </Card>
      </div>
    </div>
    <span className="sr-only">Loading administration data…</span>
  </main>;
}

function DashboardPanel({ overview, loading = false, onNavigate }) {
  if (loading) return <DashboardPanelSkeleton />;
  const summary = overview?.summary || { desiredObjects: 0, managedResources: 0, sharedResources: 0, healthyResources: 0, attentionResources: 0, dependencies: 0, sharedDependencies: 0 };
  const modules = overview?.modules || [];
  return <div className="mx-auto w-full max-w-[1600px] space-y-6">
    <section className="space-y-3">
      <div><h2 className="text-base font-semibold">Integration overview</h2><p className="mt-1 text-sm text-muted-foreground">Installation-managed resources are separated from Genesys organization-wide shared infrastructure.</p></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <OverviewMetric label="Desired objects" value={summary.desiredObjects} detail="Enabled integration configuration" icon={LayoutDashboard} />
        <OverviewMetric label="Installation managed" value={summary.managedResources} detail={`${summary.dependencies} local dependencies`} icon={Activity} />
        <OverviewMetric label="Shared resources" value={summary.sharedResources} detail={`${summary.sharedDependencies} organization dependencies`} icon={Globe2} />
        <OverviewMetric label="Healthy" value={summary.healthyResources} detail="Local and shared resources matching live state" icon={ShieldCheck} />
        <OverviewMetric label="Require attention" value={summary.attentionResources} detail="Local or shared resources missing, drifted or failed" icon={CircleAlert} />
      </div>
    </section>
    <section className="space-y-3">
      <div><h2 className="text-base font-semibold">Configuration coverage</h2><p className="mt-1 text-sm text-muted-foreground">Coverage of desired configuration and the managed Genesys and Telnyx resources behind it.</p></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {modules.map((module) => <button key={module.id} type="button" className="group rounded-xl border bg-background p-4 text-left transition-colors hover:bg-muted/40" onClick={() => onNavigate(module.target, module.section)}>
          <span className="flex items-start justify-between gap-3"><span className="min-w-0 truncate text-sm font-medium">{module.label}</span><ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></span>
          <Badge className="mt-3" variant={dashboardStatusVariant(module.state)}>{DASHBOARD_STATE_LABELS[module.state] || module.state}</Badge>
          {module.sharedCounts ? <span className="mt-4 grid grid-cols-2 gap-3 border-t pt-3"><span><span className="block text-2xl font-semibold tracking-tight">{module.sharedCounts.connectors}</span><span className="text-xs text-muted-foreground">Shared connectors</span></span><span><span className="block text-2xl font-semibold tracking-tight">{module.sharedCounts.testFlows}</span><span className="text-xs text-muted-foreground">Shared test flows</span></span></span> : module.assistantCounts ? <span className="mt-4 grid grid-cols-2 gap-3 border-t pt-3"><span><span className="block text-2xl font-semibold tracking-tight">{module.assistantCounts.all}</span><span className="text-xs text-muted-foreground">All assistants</span></span><span><span className="block text-2xl font-semibold tracking-tight">{module.assistantCounts.managed}</span><span className="text-xs text-muted-foreground">Managed</span></span></span> : <span className="mt-4 grid grid-cols-2 gap-3 border-t pt-3"><span><span className="block text-2xl font-semibold tracking-tight">{module.desiredObjects}</span><span className="text-xs text-muted-foreground">Desired</span></span><span><span className="block text-2xl font-semibold tracking-tight">{module.observedResources}</span><span className="text-xs text-muted-foreground">Managed</span></span></span>}
          <span className="mt-3 block text-xs text-muted-foreground">{module.scopeType === "organization" ? "Shared across the Genesys organization" : module.desiredRevision ? `Desired revision ${module.desiredRevision}` : "No desired configuration"}</span>
        </button>)}
        {!modules.length && <p className="rounded-xl border bg-background p-6 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-4">No desired-state overview is available yet.</p>}
      </div>
    </section>
  </div>;
}

function DangerZonePanel() {
  const [deleteResult, setDeleteResult] = useState(null);
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const loadPlan = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api("/api/admin/danger-zone");
      setPlan(body);
      setSelected(new Set());
      setConfirmation("");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadPlan(); }, [loadPlan]);
  const resources = plan?.resources || [];
  const selectionBlocked = (resource, selection = selected) =>
    (resource.requiredAssistantResourceIds || []).some((id) => !selection.has(id));
  const selectable = resources.filter((resource) => resource.selectable && !selectionBlocked(resource));
  const grouped = ["genesys", "telnyx"].map((provider) => ({
    provider,
    resources: resources.filter((resource) => resource.provider === provider),
  }));
  const toggle = (id, checked) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else {
      next.delete(id);
      for (const resource of resources) {
        if ((resource.requiredAssistantResourceIds || []).includes(id)) next.delete(resource.id);
      }
    }
    return next;
  });
  const allSelected = selectable.length > 0 && selectable.every((resource) => selected.has(resource.id));
  const destroy = async () => {
    setDeleting(true);
    try {
      const result = await api("/api/admin/danger-zone", {
        method: "POST",
        body: JSON.stringify({ resourceIds: [...selected], confirmation }),
      });
      setDeleteResult(result);
      if (result.failed || result.skipped) toast.error(`${result.deleted} deleted; ${result.failed} failed; ${result.skipped || 0} retained.`);
      else toast.success(`${result.deleted} managed resources deleted.`);
      if (!result.administrationAccessDeleted) await loadPlan();
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  };
  return <section className="rounded-xl border border-destructive/40 bg-destructive/[0.025]">
    {deleteResult && <div role="status" className="space-y-2 border-b p-5 text-sm">
      <p>{deleteResult.deleted} deleted; {deleteResult.failed} failed; {deleteResult.skipped || 0} retained.</p>
      {deleteResult.results.filter(entry => entry.status !== "deleted").map(entry => <p key={entry.id}><strong>{entry.name || entry.id}:</strong> {entry.error}{entry.trackingError ? ` Status could not be saved: ${entry.trackingError}` : ""}</p>)}
      {deleteResult.administrationAccessDeleted && <p>Administration access has been removed. Close this application. Any remaining access objects must be removed from Genesys Cloud administration.</p>}
    </div>}
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-destructive/25 p-5">
      <div><div className="flex items-center gap-2"><CircleAlert className="size-5 text-destructive" /><p className="font-semibold text-destructive">Danger Zone · Delete integration</p></div><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Delete only resources created and registered by this deployment. Telnyx lists only Admin App-managed assistants and tracked tools. Select an assigned assistant before its tools; tools used by assistants outside this delete plan stay locked.</p></div>
      <Button variant="outline" disabled={loading || deleting} onClick={() => void loadPlan()}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh inventory</Button>
    </div>
    <div className="space-y-5 p-5">
      {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading registered resources…</div> : <>
        <label className="flex items-center gap-3 rounded-lg border bg-background p-3 text-sm font-medium"><Checkbox checked={allSelected} onCheckedChange={(checked) => setSelected(new Set(checked ? resources.filter((resource) => resource.selectable).map((resource) => resource.id) : []))} /> Select all deletable resources ({resources.filter((resource) => resource.selectable).length})</label>
        <div className="grid gap-4 xl:grid-cols-2">{grouped.map((group) => <div key={group.provider} className="overflow-hidden rounded-lg border bg-background"><div className="border-b bg-muted/30 px-4 py-3"><p className="font-medium capitalize">{group.provider}</p><p className="text-xs text-muted-foreground">{group.resources.length} registered resources</p></div><div className="max-h-[420px] divide-y overflow-y-auto">{group.resources.map((resource) => { const blockedBySelection = selectionBlocked(resource); const disabled = !resource.selectable || blockedBySelection; return <label key={resource.id} className={`flex items-start gap-3 p-3 ${disabled ? "opacity-60" : "cursor-pointer"}`}><Checkbox className="mt-0.5" disabled={disabled || deleting} checked={selected.has(resource.id)} onCheckedChange={(checked) => toggle(resource.id, checked === true)} /><span className="min-w-0"><span className="block break-words text-sm font-medium">{resource.displayName}</span><span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">{resource.resourceType} · {resource.remoteId}</span><span className="mt-1 block text-xs text-muted-foreground">{resource.scopeType}{resource.scopeId ? ` · ${resource.scopeId}` : ""}{resource.deletionReason ? ` · ${resource.deletionReason}` : blockedBySelection && resource.selectionReason ? ` · ${resource.selectionReason}` : ""}</span></span></label>; })}{!group.resources.length && <p className="p-4 text-sm text-muted-foreground">No registered resources.</p>}</div></div>)}</div>
        <div className="rounded-lg border border-destructive/30 bg-background p-4"><Field label={`Type “${plan?.installationName || "installation name"}” to confirm`} hint="Administration access is removed last, only when all other registered resources have been removed. Deleting access ends your ability to use this console."><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></Field><Button className="mt-4" variant="destructive" disabled={!selected.size || deleting || deleteResult?.administrationAccessDeleted || confirmation !== plan?.installationName} onClick={() => void destroy()}>{deleting ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete {selected.size || "selected"} resource{selected.size === 1 ? "" : "s"}</Button></div>
      </>}
    </div>
  </section>;
}

function SettingsPanel({ inventory, onEditPublicUrl }) {
  const names = inventory.installation || {};
  const adminGroupName = names.adminGroup || names.installationName || "Telnyx Integrations";
  const adminGroup = (inventory.groups || []).find((entry) => entry.name === adminGroupName);
  return <div className="w-full space-y-6">
    <div><h2 className="text-xl font-semibold">Installation settings</h2><p className="mt-1 text-sm text-muted-foreground">Only settings that can be safely validated and reconciled are editable. Protected environment and access values remain read-only.</p></div>
    <div className="rounded-xl border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
        <div><p className="font-medium">Public application URL</p><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Changing this URL builds a reviewable plan for OAuth callbacks, webhook tools, Audio Connector endpoints and managed widget resources.</p></div>
        <Button onClick={onEditPublicUrl}><Globe2 /> Change public URL</Button>
      </div>
      <div className="p-5"><Field label="Current public URL" hint="Editable only through the validated change plan above."><div className="flex gap-2"><Input readOnly className="bg-muted/30 font-mono text-xs" value={inventory.publicBaseUrl || "Not configured"} /><Button asChild variant="outline" size="icon" disabled={!inventory.publicBaseUrl}><a href={inventory.publicBaseUrl || "#"} target="_blank" rel="noreferrer" aria-label="Open public URL"><ExternalLink className="size-4" /></a></Button></div></Field></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4 rounded-xl border bg-background p-5"><div><p className="font-medium">Genesys Cloud</p><p className="mt-1 text-xs text-muted-foreground">Protected installer configuration.</p></div><Field label="Organization"><Input readOnly className="bg-muted/30" value={inventory.organization?.name || "Unavailable"} /></Field><Field label="Organization ID"><Input readOnly className="bg-muted/30 font-mono text-xs" value={inventory.organization?.id || "Unavailable"} /></Field><Field label="Environment"><Input readOnly className="bg-muted/30 font-mono text-xs" value={inventory.environment || "Unavailable"} /></Field></div>
      <div className="space-y-4 rounded-xl border bg-background p-5"><div><p className="font-medium">Administration access</p><p className="mt-1 text-xs text-muted-foreground">Role and group membership are managed by the installer and shown here for reference.</p></div><Field label="Installation"><Input readOnly className="bg-muted/30" value={`${names.installationName || "Telnyx Integrations"} (${names.installationKey || "default"})`} /></Field><Field label="Administrator group"><Input readOnly className="bg-muted/30" value={adminGroup?.name || adminGroupName} /></Field><Field label="Group ID"><Input readOnly className="bg-muted/30 font-mono text-xs" value={adminGroup?.id || "Unavailable"} /></Field><Field label="Administrator role"><Input readOnly className="bg-muted/30" value={names.adminRole || names.installationName || "Telnyx Integrations"} /></Field></div>
    </div>
    <DangerZonePanel />
  </div>;
}

function AiSectionNavigation({ activeId, onSelect }) {
  return <aside className="min-h-0 overflow-y-auto border-r bg-muted/15 p-3">
    {AI_NAV_GROUPS.map((group) => <div key={group.label} className="mb-5"><p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p><div className="grid gap-1">{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" onClick={() => onSelect(item.id)} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${activeId === item.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}><Icon className="size-4" />{item.label}</button>; })}</div></div>)}
  </aside>;
}

function AssistantPreviewValue({ label, value, mono = false }) {
  return <div className="rounded-lg border bg-muted/20 p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 break-words text-sm ${mono ? "font-mono text-xs" : ""}`}>{value || "Not configured"}</p></div>;
}

function assistantPreviewLabel(value) {
  const normalized = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim();
  const aliases = {
    api: "API",
    id: "ID",
    llm: "LLM",
    mcp: "MCP",
    sms: "SMS",
    stt: "STT",
    texml: "TeXML",
    tts: "TTS",
    url: "URL",
  };
  return normalized.split(/\s+/).map((part) => aliases[part.toLowerCase()] || `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function assistantPreviewEntries(value, path = []) {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) {
    if (!value.length) return [];
    if (value.every((entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry))) {
      return [{ label: path.join(" · ") || "Values", values: value.filter((entry) => entry !== null) }];
    }
    return value.flatMap((entry, index) => assistantPreviewEntries(entry, [...path, `Item ${index + 1}`]));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => assistantPreviewEntries(entry, [...path, assistantPreviewLabel(key)]));
  }
  return [{ label: path.join(" · ") || "Value", value }];
}

function AssistantPreviewBadges({ values, emptyLabel = "None" }) {
  const entries = (values || []).filter((value) => value !== null && value !== undefined && value !== "");
  if (!entries.length) return <span className="text-sm text-muted-foreground">{emptyLabel}</span>;
  return <span className="flex flex-wrap gap-1.5">{entries.map((value, index) => <Badge key={`${String(value)}-${index}`} variant="outline" className="max-w-full break-all font-normal">{typeof value === "boolean" ? value ? "Enabled" : "Disabled" : String(value)}</Badge>)}</span>;
}

function AssistantPreviewBadgeTile({ label, values, emptyLabel }) {
  return <div className="rounded-lg border bg-muted/20 p-3"><p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><AssistantPreviewBadges values={values} emptyLabel={emptyLabel} /></div>;
}

function AssistantPreviewSettingTile({ entry }) {
  const values = entry.values || (typeof entry.value === "boolean" ? [entry.value] : null);
  return <div className="min-w-0 rounded-lg border bg-background p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{entry.label}</p>{values ? <div className="mt-2"><AssistantPreviewBadges values={values} /></div> : <p className="mt-1 break-all text-sm">{String(entry.value)}</p>}</div>;
}

function AssistantPreviewSettingsSection({ title, description, value, emptyLabel = "Not configured" }) {
  const entries = assistantPreviewEntries(value);
  return <section className="rounded-xl border bg-muted/10 p-4"><div><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}</div>{entries.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{entries.map((entry, index) => <AssistantPreviewSettingTile key={`${entry.label}-${index}`} entry={entry} />)}</div> : <div className="mt-3 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">{emptyLabel}</div>}</section>;
}

function AssistantPreviewDialog({ open, onOpenChange, preview }) {
  if (!preview) return null;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto"><DialogHeader><DialogTitle>Agent config preview</DialogTitle><DialogDescription>Live, read-only Telnyx configuration combined with the integration assignments stored by this admin.</DialogDescription></DialogHeader><div className="space-y-5">
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><AssistantPreviewValue label="Assistant" value={preview.name} /><AssistantPreviewValue label="LLM model" value={preview.model || (preview.externalLlm ? "External LLM" : "Telnyx default")} mono /><AssistantPreviewBadgeTile label="Enabled channels" values={preview.enabledFeatures} emptyLabel="None enabled" /><AssistantPreviewBadgeTile label="Assigned numbers" values={preview.assignedNumbers} emptyLabel="No DNIS or Telnyx numbers found" /></section>
    <section><AssistantPreviewValue label="Greeting" value={preview.greeting} /></section>
    <section className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/10 p-4"><h3 className="text-sm font-semibold">Instructions</h3><div className="mt-3 text-xs leading-relaxed">{preview.instructions || "No instructions configured."}</div></section>
    <AssistantPreviewSettingsSection title="STT · Transcription" description="Speech recognition model, language and endpointing." value={preview.transcription} />
    <AssistantPreviewSettingsSection title="TTS · Voice" description="Voice identity and synthesis behavior." value={preview.voiceSettings} />
    <AssistantPreviewSettingsSection title="Telephony" description="Calling, recording, noise suppression and timeout settings." value={preview.telephonySettings} />
  </div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter></DialogContent></Dialog>;
}

function AssistantsPanel({ inventory, configs, assistantCatalog, onCreate, onCatalogChange, onOpenRouting, onOpenCallbacks }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ description: "", name: "", instructions: "", greeting: "" });
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const audioAssignments = new Map((configs.audio?.routes || []).map((route) => [route.assistantId, (configs.audio.routes || []).filter((item) => item.assistantId === route.assistantId).length]));
  const callbackAssistantId = configs.callbacks?.assistantId;
  const entries = (assistantCatalog || []).filter((assistant) => assistant.managed === true && assistant.status !== "missing");
  const applyDetail = (body) => setDetail(body);
  useEffect(() => {
    if (selectedId && entries.some((assistant) => assistant.telnyxAssistantId === selectedId)) return;
    setSelectedId(entries[0]?.telnyxAssistantId || "");
  }, [assistantCatalog, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selectedId) { setDetail(null); return undefined; }
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    void api(`/api/admin/ai/assistants/${encodeURIComponent(selectedId)}`).then((body) => {
      if (active) applyDetail(body);
    }).catch((error) => {
      if (!active) return;
      if (error.status === 410) {
        setDetail(null);
        setSelectedId("");
        void api("/api/admin/ai/assistants").then((body) => {
          if (active) onCatalogChange?.(body.assistants || []);
        }).catch(() => undefined);
        toast.info("The assistant was deleted in Telnyx and has been removed from this catalog");
        return;
      }
      setDetailError(error.message);
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, onCatalogChange]);
  const generate = async () => {
    setGenerating(true);
    try {
      const body = await api("/api/admin/audio/assistant/generate", { method: "POST", body: JSON.stringify({ description: draft.description }) });
      setDraft((current) => ({ ...current, name: body.assistant.name, instructions: body.assistant.instructions, greeting: body.assistant.greeting }));
      toast.success("Assistant content generated");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setGenerating(false);
    }
  };
  const create = async () => {
    setCreating(true);
    try {
      const assistant = await onCreate(draft);
      setSelectedId(assistant.telnyxAssistantId);
      setCreateOpen(false);
      setDraft({ description: "", name: "", instructions: "", greeting: "" });
    } catch {
      // The parent reports the API error and the dialog remains open for correction.
    } finally {
      setCreating(false);
    }
  };
  const reconcile = async () => {
    if (reconciling) return;
    setReconciling(true);
    try {
      const body = await api("/api/admin/ai/assistants/reconcile", { method: "POST", body: "{}" });
      onCatalogChange?.(body.assistants || []);
      if (selectedId) applyDetail(await api(`/api/admin/ai/assistants/${encodeURIComponent(selectedId)}`));
      const changed = (body.reconciliation || []).filter((assistant) => assistant.changed).length;
      toast.success(changed ? `${changed} assistant bundle(s) reconciled` : "Managed assistant bundles are already healthy");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setReconciling(false);
    }
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">AI Assistants</h2><p className="mt-1 text-sm text-muted-foreground">Deployment-managed assistant bundles. Tools, insights and instruction inserts are read-only.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={onOpenCallbacks}><CalendarClock /> Callback assignment</Button><Button variant="outline" onClick={onOpenRouting}><Globe2 /> Inbound assignment</Button><Button variant="outline" disabled={reconciling || !entries.length} onClick={() => void reconcile()}>{reconciling ? <Loader2 className="animate-spin" /> : <RefreshCw />} Reconcile managed configuration</Button><Button onClick={() => setCreateOpen(true)}><Plus /> New assistant</Button></div></div>
    <div className="grid min-h-[640px] overflow-hidden rounded-xl border bg-background lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="border-b bg-muted/10 lg:border-b-0 lg:border-r"><div className="border-b px-4 py-3"><p className="text-sm font-medium">Managed assistants</p><p className="mt-0.5 text-xs text-muted-foreground">{entries.length} visible</p></div><div className="max-h-[640px] overflow-y-auto p-2">{entries.map((assistant) => { const remoteId = assistant.telnyxAssistantId; const uses = [audioAssignments.has(remoteId) && `${audioAssignments.get(remoteId)} DNIS`, callbackAssistantId === remoteId && "Callback", (inventory.widgetDeployments || []).some((entry) => entry.config?.messagingAssistantId === remoteId || entry.config?.voiceAssistantId === remoteId) && "Web"].filter(Boolean); const active = selectedId === remoteId; return <button key={assistant.id} type="button" onClick={() => setSelectedId(remoteId)} className={`mb-1 w-full rounded-lg border px-3 py-3 text-left transition-colors ${active ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/60"}`}><span className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-sm font-medium">{assistant.name}</span><span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{remoteId}</span></span><Badge variant={assistant.status === "healthy" ? "secondary" : "destructive"}>{assistant.status}</Badge></span><span className="mt-2 flex flex-wrap gap-1">{uses.length ? uses.map((use) => <Badge key={use} variant="outline">{use}</Badge>) : <Badge variant="outline">Admin managed</Badge>}</span></button>; })}{!entries.length && <div className="p-6 text-center text-sm text-muted-foreground"><Bot className="mx-auto mb-3 size-7" /><p>No managed assistants yet.</p><p className="mt-1 text-xs">Create one or assign an existing Telnyx assistant through a deployment workflow.</p></div>}</div></div>
      <div className="min-w-0">{detailLoading ? <div className="grid h-full min-h-96 place-items-center"><div className="text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-3 animate-spin" />Loading live Telnyx configuration…</div></div> : detailError ? <div className="grid h-full min-h-96 place-items-center p-6"><div className="max-w-md text-center"><CircleAlert className="mx-auto mb-3 text-destructive" /><p className="font-medium">Assistant configuration could not be loaded</p><p className="mt-1 text-sm text-muted-foreground">{detailError}</p><Button className="mt-4" variant="outline" onClick={() => { const current = selectedId; setSelectedId(""); window.setTimeout(() => setSelectedId(current), 0); }}>Try again</Button></div></div> : detail ? <div className="flex h-full min-h-0 flex-col"><div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4"><div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-lg font-semibold">{detail.assistant.name}</h3><Badge>Managed</Badge><Badge variant={detail.bundleStatus === "healthy" ? "secondary" : "destructive"}>{detail.bundleStatus}</Badge></div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{detail.assistant.telnyxAssistantId}</p></div><Button size="icon" variant="outline" aria-label="Preview complete assistant configuration" title="Preview complete assistant configuration" onClick={() => setPreviewOpen(true)}><Eye className="size-4" /></Button></div><div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        <section><div><h4 className="text-sm font-semibold">Managed privacy</h4><p className="mt-1 text-xs text-muted-foreground">Enforced for every assistant managed by this deployment.</p></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">Data retention</p><Badge className="mt-2" variant={detail.privacy.dataRetention ? "secondary" : "destructive"}>{detail.privacy.dataRetention ? "Enabled" : "Drifted"}</Badge></div><div className="rounded-lg border p-4"><p className="text-xs text-muted-foreground">PII data redaction</p><Badge className="mt-2" variant={detail.privacy.piiRedaction === "disabled" ? "secondary" : "destructive"}>{detail.privacy.piiRedaction}</Badge></div></div></section>
        <section><div><h4 className="text-sm font-semibold">Managed assistant tools</h4><p className="mt-1 text-xs text-muted-foreground">Attachments are derived from channel deployments and cannot be changed manually.</p></div><div className="mt-3 space-y-3">{detail.managedTools.map((tool) => <div key={tool.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{tool.displayName}</p><Badge variant="outline">{tool.toolType}</Badge>{tool.requiredBy?.map((owner) => <Badge key={owner} variant="secondary">{owner}</Badge>)}</div><p className="mt-1 font-mono text-[10px] text-muted-foreground">{tool.logicalKey} · {tool.remoteToolId}</p></div><div className="flex gap-2"><Badge variant={tool.attached ? "secondary" : "destructive"}>{tool.attached ? "Attached" : "Missing"}</Badge><Badge variant="outline">Shared by {tool.sharedByAssistantCount}</Badge></div></div>{tool.description && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{tool.description}</p>}</div>)}{!detail.managedTools.length && <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No deployment-managed tools are required by this assistant.</div>}</div></section>
        <section><div><h4 className="text-sm font-semibold">Managed insights</h4><p className="mt-1 text-xs text-muted-foreground">One installation-level group is shared by all managed assistants and delivers completion events to this backend.</p></div><div className="mt-3 rounded-lg border"><div className="border-b p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">{detail.managedInsights.group.name}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.managedInsights.group.id || "Not deployed"}</p></div><Badge variant={detail.managedInsights.attached ? "secondary" : "destructive"}>{detail.managedInsights.attached ? "Attached" : detail.managedInsights.group.id ? "Drifted" : "Missing"}</Badge></div><p className="mt-3 break-all text-xs text-muted-foreground">Webhook: {detail.managedInsights.group.webhookUrl}</p></div><div className="divide-y">{detail.managedInsights.insights.map((insight) => <div key={insight.key} className="p-4"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{insight.name}</p><Badge variant="outline">Unstructured</Badge><Badge variant={insight.status === "healthy" ? "secondary" : "destructive"}>{insight.status}</Badge></div><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{insight.instructions}</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">{insight.id || "Not deployed"}</p></div>)}</div></div></section>
        <section><div><h4 className="text-sm font-semibold">Managed instruction inserts</h4><p className="mt-1 text-xs text-muted-foreground">Protected instruction blocks are generated by deployment rules and displayed read-only.</p></div><div className="mt-3 space-y-4">{detail.instructionSections.map((section) => <div key={section.id} className="rounded-lg border"><div className="border-b bg-muted/20 px-4 py-3"><p className="text-sm font-medium">{section.label}</p><code className="mt-1 block truncate text-[10px] text-muted-foreground">{section.startMarker}</code></div><pre className="max-h-72 overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed">{section.content}</pre><div className="border-t bg-muted/20 px-4 py-2"><code className="block truncate text-[10px] text-muted-foreground">{section.endMarker}</code></div></div>)}{!detail.instructionSections.length && <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">This assistant has no instruction inserts managed by the current deployment rules.</div>}</div></section>
      </div><div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3"><p className="text-xs text-muted-foreground">Read-only desired and observed Telnyx configuration.</p><Badge variant={detail.bundleStatus === "healthy" ? "secondary" : "destructive"}>{detail.bundleStatus === "healthy" ? "Configuration is healthy" : "Reconciliation required"}</Badge></div></div> : <div className="grid h-full min-h-96 place-items-center text-sm text-muted-foreground">Select a managed assistant.</div>}</div>
    </div>
    <AssistantPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} preview={detail?.preview} />
    <Dialog open={createOpen} onOpenChange={(open) => { if (!creating && !generating) setCreateOpen(open); }}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Create Telnyx AI assistant</DialogTitle><DialogDescription>The assistant is created immediately as a deployment-managed bundle with enforced privacy, the installation Insights Group and deployment-owned tools and instruction inserts.</DialogDescription></DialogHeader>
        <div className="grid gap-4"><Field label="Short description of the use case"><Textarea rows={3} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></Field><div className="flex justify-end"><Button type="button" variant="outline" disabled={generating || draft.description.trim().length < 10} onClick={() => void generate()}>{generating ? <Loader2 className="animate-spin" /> : <WandSparkles />} Generate content</Button></div><Field label="Assistant name"><Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field><Field label="Instructions"><Textarea rows={10} value={draft.instructions} onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} /></Field><Field label="Greeting message"><Input value={draft.greeting} onChange={(event) => setDraft((current) => ({ ...current, greeting: event.target.value }))} /></Field></div>
        <DialogFooter><Button variant="outline" disabled={creating || generating} onClick={() => setCreateOpen(false)}>Cancel</Button><Button disabled={creating || generating || draft.name.trim().length < 3 || draft.description.trim().length < 10 || draft.instructions.trim().length < 80 || !draft.greeting.trim()} onClick={() => void create()}>{creating ? <Loader2 className="animate-spin" /> : <Plus />} Create assistant</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

const GENESYS_TOOL_CATALOG = [
  {
    logicalKey: "genesys_human_handoff",
    name: "Genesys Handoff",
    type: "webhook",
    description: "Requests a Genesys human handoff and sends the selected queue plus concise conversation context to the integration webhook.",
  },
  {
    logicalKey: "genesys_sip_transfer",
    name: "Transfer",
    type: "transfer",
    description: "Transfers a voice call to the Genesys Cloud SIP endpoint created for the active Web Calls deployment.",
    scopeType: "deployment",
  },
  {
    logicalKey: "hangup",
    name: "Hangup",
    type: "hangup",
    description: "Ends a voice call after the caller asks to disconnect or the conversation has clearly concluded.",
  },
  {
    logicalKey: "genesys_voice_queue_selector",
    name: "Dynamic Variables Update",
    type: "update_dynamic_variables",
    description: "Prepares the Genesys queue and the structured handoff context immediately before a SIP transfer.",
    scopeType: "deployment",
  },
  {
    logicalKey: "genesys_sip_invite",
    name: "Invite",
    type: "invite",
    description: "Invites a Genesys Cloud agent onto the live web call so the assistant can stay on the line instead of transferring away.",
    scopeType: "deployment",
  },
  {
    logicalKey: "skip_turn",
    name: "Skip Turn",
    type: "skip_turn",
    description: "Lets the assistant stay on the call without speaking while the invited Genesys agent handles the customer.",
  },
];

const DYNAMIC_VARIABLE_TEMPLATE = [
  ["genesys_queue_name", "Selected Genesys Cloud queue name."],
  ["genesys_handoff_reason", "Short factual reason for the human handoff."],
  ["genesys_handoff_summary", "Concise conversation summary for the Genesys agent."],
  ["genesys_handoff_intent", "Short customer intent label."],
  ["genesys_handoff_sentiment", "Customer sentiment: positive, neutral, negative or mixed."],
  ["genesys_handoff_sip_uri", "Genesys SIP destination used by the Transfer tool."],
];

function unprovisionedTool(spec, publicBaseUrl) {
  const definitions = {
    webhook: {
      type: "webhook",
      webhook: {
        description: spec.description,
        url: publicBaseUrl ? `${String(publicBaseUrl).replace(/\/$/, "")}/api/genesys/handoff` : "",
        method: "POST",
        async: false,
        body_parameters: {
          type: "object",
          properties: {
            telnyx_conversation_channel: { type: "string", description: "Resolved Telnyx conversation channel." },
            widget_session_id: { type: "string", description: "Private widget session identifier for Web Chat handoff." },
            queue_name: { type: "string", description: "Exact Genesys queue name selected from the deployment allowlist." },
            reason: { type: "string", description: "Why the customer needs a human agent." },
            summary: { type: "string", description: "Concise factual conversation summary." },
            intent: { type: "string", description: "Short customer intent label." },
            sentiment: { type: "string", description: "Current customer sentiment.", enum: ["positive", "neutral", "negative", "mixed", "unknown"] },
          },
          required: ["telnyx_conversation_channel", "reason", "summary", "intent", "sentiment"],
        },
      },
    },
    transfer: {
      type: "transfer",
      transfer: { from: "{{telnyx_end_user_target}}", targets: [], custom_headers: [] },
    },
    hangup: {
      type: "hangup",
      hangup: { description: spec.description, intent_message: "" },
    },
    update_dynamic_variables: {
      type: "update_dynamic_variables",
      update_dynamic_variables: {
        description: spec.description,
        updatable_variables: DYNAMIC_VARIABLE_TEMPLATE.map(([name, description]) => ({ name, type: "string", description })),
      },
    },
    invite: {
      type: "invite",
      invite: { from: "{{telnyx_end_user_target}}", targets: [], custom_headers: [] },
    },
    skip_turn: {
      type: "skip_turn",
      skip_turn: { description: spec.description },
    },
  };
  return {
    id: `not-provisioned:${spec.logicalKey}`,
    logicalKey: spec.logicalKey,
    catalogName: spec.name,
    displayName: spec.name,
    toolType: spec.type,
    scopeType: spec.scopeType || "shared",
    scopeId: null,
    remoteToolId: null,
    desiredDefinition: definitions[spec.type],
    status: "not_provisioned",
    provisioned: false,
    catalogDescription: spec.description,
  };
}

function genesysToolCatalog(inventory) {
  const managed = inventory.managedTools || [];
  return GENESYS_TOOL_CATALOG.flatMap((spec) => {
    const matches = managed.filter((tool) => tool.logicalKey === spec.logicalKey && !["retired", "missing"].includes(tool.status));
    if (!matches.length) return [unprovisionedTool(spec, inventory.publicBaseUrl)];
    return matches.map((tool) => ({
      ...tool,
      catalogName: spec.name,
      catalogDescription: spec.description,
      provisioned: true,
    }));
  });
}

function toolTypeLabel(type) {
  return {
    webhook: "Webhook",
    transfer: "Transfer",
    hangup: "Hangup",
    update_dynamic_variables: "Update Dynamic Variables",
    invite: "Invite",
    skip_turn: "Skip Turn",
  }[type] || type || "Unknown";
}

function toolConfiguration(tool) {
  const definition = tool.desiredDefinition || {};
  const type = definition.type || tool.toolType;
  const config = definition[type] || {};
  return { definition, type, config };
}

function toolDescription(tool) {
  const { type, config } = toolConfiguration(tool);
  return config.description || (type === "transfer" || type === "invite" ? tool.catalogDescription : "") || tool.catalogDescription || "No description provided.";
}

function toolParameters(tool) {
  const { type, config } = toolConfiguration(tool);
  if (type === "webhook") {
    const schema = config.body_parameters || {};
    const required = new Set(schema.required || []);
    return Object.entries(schema.properties || {}).map(([name, parameter]) => ({
      name,
      type: parameter.type || "value",
      required: required.has(name),
      description: parameter.description || "",
      values: parameter.enum || [],
    }));
  }
  if (type === "update_dynamic_variables") {
    return (config.updatable_variables || []).map((parameter) => ({
      name: parameter.name,
      type: parameter.type || "value",
      required: true,
      description: parameter.description || "",
      values: parameter.enum || [],
    }));
  }
  if (type === "transfer" || type === "invite") {
    return [
      ...(config.from ? [{ name: "from", type: "caller identity", required: true, value: config.from }] : []),
      ...(config.targets || []).map((target) => ({ name: target.name || "target", type: "SIP destination", required: true, value: target.to })),
      ...(config.custom_headers || []).map((header) => ({ name: header.name, type: "SIP header", required: false, value: header.value })),
    ];
  }
  return [];
}

function ToolReadOnlyValue({ label, value, mono = false, className = "" }) {
  return <div className={`min-w-0 rounded-lg border bg-muted/10 p-3 ${className}`}><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 break-all text-sm ${mono ? "font-mono text-xs" : "font-medium"}`}>{value || "—"}</p></div>;
}

function ToolAssistantRow({ assistant, action, busy, disabled, onClick }) {
  const add = action === "Add";
  return <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{assistant.name}</p><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{assistant.telnyxAssistantId}</p></div><Button size="sm" variant="outline" disabled={disabled || busy} onClick={onClick}>{busy ? <Loader2 className="animate-spin" /> : add ? <Plus /> : <Trash2 />} {action}</Button></div>;
}

function ToolsPanel({ inventory, assistantCatalog, onSaveAssignments, onMissingTool }) {
  const tools = genesysToolCatalog(inventory);
  const assistants = (assistantCatalog || []).filter((assistant) => assistant.managed && assistant.status !== "missing" && assistant.telnyxAssistantId);
  const [selectedToolId, setSelectedToolId] = useState("");
  const [assignmentIdsByTool, setAssignmentIdsByTool] = useState({});
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const [savingAssistantId, setSavingAssistantId] = useState("");
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) || tools[0] || null;
  const selectedAssignmentIds = new Set(selectedTool ? assignmentIdsByTool[selectedTool.id] || [] : []);

  useEffect(() => {
    if (selectedToolId && tools.some((tool) => tool.id === selectedToolId)) return;
    setSelectedToolId(tools[0]?.id || "");
  }, [selectedToolId, tools]);

  useEffect(() => {
    if (!selectedTool) return undefined;
    if (!selectedTool.provisioned) {
      setAssignmentIdsByTool((current) => ({ ...current, [selectedTool.id]: [] }));
      setAssignmentError("");
      setAssignmentsLoading(false);
      return undefined;
    }
    let active = true;
    setAssignmentsLoading(true);
    setAssignmentError("");
    void api(`/api/admin/ai/tools/${encodeURIComponent(selectedTool.id)}/assignments`).then((body) => {
      if (active) setAssignmentIdsByTool((current) => ({ ...current, [selectedTool.id]: body.assistantIds || [] }));
    }).catch((error) => {
      if (!active) return;
      if (error.status === 410) {
        setAssignmentError("");
        toast.info("The tool was deleted in Telnyx and has been removed from this catalog");
        void onMissingTool?.();
        return;
      }
      setAssignmentError(error.message);
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    }).finally(() => { if (active) setAssignmentsLoading(false); });
    return () => { active = false; };
  }, [selectedTool?.id, selectedTool?.provisioned]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeAssignment = async (assistantId, attach) => {
    if (!selectedTool?.provisioned || savingAssistantId) return;
    const next = new Set(selectedAssignmentIds);
    if (attach) next.add(assistantId); else next.delete(assistantId);
    setSavingAssistantId(assistantId);
    try {
      const body = await onSaveAssignments(selectedTool.id, [...next]);
      setAssignmentIdsByTool((current) => ({ ...current, [selectedTool.id]: body.assistantIds || [...next] }));
    } finally {
      setSavingAssistantId("");
    }
  };

  const attached = assistants.filter((assistant) => selectedAssignmentIds.has(assistant.telnyxAssistantId));
  const available = assistants.filter((assistant) => !selectedAssignmentIds.has(assistant.telnyxAssistantId));
  const { type, config } = selectedTool ? toolConfiguration(selectedTool) : { type: "", config: {} };
  const parameters = selectedTool ? toolParameters(selectedTool) : [];
  const estimatedCount = (tool) => assignmentIdsByTool[tool.id]?.length ?? assistants.filter((assistant) => (assistant.tools || []).some((assignment) => assignment.id === tool.id && assignment.status !== "detached")).length;

  return <div className="space-y-5"><div><h2 className="text-xl font-semibold">Assistant Tools</h2><p className="mt-1 text-sm text-muted-foreground">Genesys integration tools are configured by their owning deployment. Their Telnyx definitions are read-only here; assistant attachments can be changed directly.</p></div><div className="grid min-h-[680px] overflow-hidden rounded-xl border bg-background lg:grid-cols-[360px_minmax(0,1fr)]">
    <aside className="border-b bg-muted/10 lg:border-b-0 lg:border-r"><div className="border-b px-4 py-3"><p className="text-sm font-medium">Managed tools</p><p className="mt-0.5 text-xs text-muted-foreground">{tools.length} visible</p></div><div className="max-h-[680px] overflow-y-auto p-2">{tools.map((tool) => { const active = selectedTool?.id === tool.id; return <button key={tool.id} type="button" onClick={() => setSelectedToolId(tool.id)} className={`mb-1 w-full rounded-lg border px-3 py-3 text-left transition-colors ${active ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/60"}`}><span className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-sm font-medium">{tool.catalogName}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{tool.provisioned ? tool.displayName : toolTypeLabel(tool.toolType)}</span></span><Badge variant={tool.provisioned && tool.status === "active" ? "secondary" : "outline"}>{tool.provisioned ? tool.status : "Not provisioned"}</Badge></span><span className="mt-2 flex items-center gap-1"><Badge variant="outline">{toolTypeLabel(tool.toolType)}</Badge><span className="ml-auto text-[11px] text-muted-foreground">{estimatedCount(tool)} assistants</span></span></button>; })}</div></aside>
    <section className="min-w-0">{selectedTool ? <div className="flex h-full min-h-[680px] flex-col"><div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-lg font-semibold">{selectedTool.catalogName}</h3><Badge variant="outline">Read only</Badge><Badge variant={selectedTool.provisioned ? "secondary" : "outline"}>{selectedTool.provisioned ? "Provisioned" : "Not provisioned"}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Tool settings are owned and reconciled by the Genesys integration deployment.</p></div></div><div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
      {!selectedTool.provisioned && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><p className="font-medium">This tool has not been provisioned yet.</p><p className="mt-1 text-muted-foreground">{["transfer", "invite", "skip_turn", "update_dynamic_variables"].includes(type) ? "It is created when a Web Calls widget is published." : "It is created by the channel deployment that first needs it."} The template below shows the configuration managed by this admin.</p></div>}
      <section><div><h4 className="text-sm font-semibold">Settings</h4><p className="mt-1 text-xs text-muted-foreground">Current Telnyx definition. These values cannot be edited from this panel.</p></div><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><ToolReadOnlyValue label="Name" value={selectedTool.displayName} /><ToolReadOnlyValue label="Type" value={toolTypeLabel(type)} /><ToolReadOnlyValue label="Status" value={selectedTool.provisioned ? selectedTool.status : "Not provisioned"} />{config.name && <ToolReadOnlyValue label="Function name" value={config.name} mono />}{type === "webhook" && <ToolReadOnlyValue label="Mode" value={config.async === true ? "Async" : "Sync"} />}{type === "webhook" && <ToolReadOnlyValue label="Method" value={config.method || "POST"} />}{selectedTool.remoteToolId && <ToolReadOnlyValue label="Telnyx tool ID" value={selectedTool.remoteToolId} mono />}{type === "webhook" && <ToolReadOnlyValue label="URL" value={config.url} mono className="sm:col-span-2 lg:col-span-3" />}<ToolReadOnlyValue label="Description" value={toolDescription(selectedTool)} className="sm:col-span-2 lg:col-span-3" /></div></section>
      <section><div><h4 className="text-sm font-semibold">Parameters</h4><p className="mt-1 text-xs text-muted-foreground">Values and structured inputs exposed to the assistant.</p></div><div className="mt-3 overflow-hidden rounded-lg border">{parameters.map((parameter, index) => <div key={`${parameter.name}-${index}`} className="border-b p-4 last:border-b-0"><div className="flex flex-wrap items-center gap-2"><code className="text-xs font-semibold">{parameter.name}</code><Badge variant="outline">{parameter.type}</Badge>{parameter.required && <Badge variant="secondary">Required</Badge>}</div>{parameter.value && <p className="mt-2 break-all font-mono text-xs">{parameter.value}</p>}{parameter.description && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{parameter.description}</p>}{parameter.values?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{parameter.values.map((value) => <Badge key={value} variant="outline">{value}</Badge>)}</div>}</div>)}{!parameters.length && <p className="p-5 text-sm text-muted-foreground">This tool does not expose configurable parameters.</p>}</div></section>
      <section><div><h4 className="text-sm font-semibold">Assistants using this tool</h4><p className="mt-1 text-xs text-muted-foreground">Remove detaches the tool in Telnyx and stores the choice so a later deployment does not re-enable it.</p></div><div className="mt-3 overflow-hidden rounded-lg border">{assignmentsLoading ? <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="animate-spin" /> Loading assignments…</div> : assignmentError ? <div className="p-5 text-sm text-destructive">{assignmentError}</div> : attached.map((assistant) => <ToolAssistantRow key={assistant.id} assistant={assistant} action="Remove" busy={savingAssistantId === assistant.telnyxAssistantId} disabled={!selectedTool.provisioned || Boolean(savingAssistantId)} onClick={() => void changeAssignment(assistant.telnyxAssistantId, false)} />)}{!assignmentsLoading && !assignmentError && !attached.length && <p className="p-5 text-sm text-muted-foreground">No managed assistants are currently using this tool.</p>}</div></section>
      <section><div><h4 className="text-sm font-semibold">Available assistants</h4><p className="mt-1 text-xs text-muted-foreground">Only assistants managed by this Genesys integration are listed.</p></div><div className="mt-3 overflow-hidden rounded-lg border">{available.map((assistant) => <ToolAssistantRow key={assistant.id} assistant={assistant} action="Add" busy={savingAssistantId === assistant.telnyxAssistantId} disabled={!selectedTool.provisioned || assignmentsLoading || Boolean(savingAssistantId)} onClick={() => void changeAssignment(assistant.telnyxAssistantId, true)} />)}{!available.length && <p className="p-5 text-sm text-muted-foreground">All managed assistants are already attached.</p>}</div></section>
    </div></div> : <div className="grid h-full min-h-96 place-items-center text-sm text-muted-foreground">Select a managed tool.</div>}</section>
  </div></div>;
}

const QUEUE_POLICY_SCOPES = [
  { context: "audio_inbound", component: "audio", label: "Inbound calls" },
  { context: "callback_outbound", component: "callbacks", label: "Callback campaigns" },
  { context: "web_messaging", component: "widget", label: "Web chat" },
  { context: "web_voice", component: null, label: "Web calls" },
];

function QueuePoliciesPanel({ inventory, policies, setPolicies, saving, onSave }) {
  const patchPolicy = (context, queueId, checked) => setPolicies((current) => {
    const source = current[context];
    const selected = new Set(source.queueIds || []);
    if (checked) selected.add(queueId); else selected.delete(queueId);
    return { ...current, [context]: { ...source, queueIds: [...selected], defaultQueueId: !checked && source.defaultQueueId === queueId ? "" : source.defaultQueueId } };
  });
  const setDefault = (context, queueId, checked) => setPolicies((current) => {
    const source = current[context];
    const selected = new Set(source.queueIds || []);
    if (checked) selected.add(queueId);
    return { ...current, [context]: { ...source, queueIds: [...selected], defaultQueueId: checked ? queueId : source.defaultQueueId === queueId ? "" : source.defaultQueueId } };
  });
  return <div className="space-y-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Queue Policies</h2><p className="mt-1 text-sm text-muted-foreground">One desired-state policy per conversation context, including separate Web Chat and Web Calls routing.</p></div><Button disabled={saving} onClick={onSave}>{saving ? <Loader2 className="animate-spin" /> : <Check />} Save desired policies</Button></div><div className="overflow-x-auto rounded-xl border bg-background"><div className="min-w-[1120px]"><div className="grid grid-cols-[minmax(220px,1fr)_repeat(4,minmax(190px,0.7fr))] border-b bg-muted/30 text-xs font-medium text-muted-foreground"><span className="px-4 py-3">Genesys queue</span>{QUEUE_POLICY_SCOPES.map((scope) => <span key={scope.context} className="border-l px-4 py-3">{scope.label}<span className="mt-0.5 block text-[10px] font-normal">Allowed · Default</span></span>)}</div>{(inventory.queues || []).map((queue) => <div key={queue.id} className="grid grid-cols-[minmax(220px,1fr)_repeat(4,minmax(190px,0.7fr))] items-center border-b last:border-b-0"><div className="min-w-0 px-4 py-3"><p className="truncate text-sm font-medium">{queue.name}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{queue.id}</p></div>{QUEUE_POLICY_SCOPES.map((scope) => { const policy = policies[scope.context] || { queueIds: [], defaultQueueId: "" }; const allowed = policy.queueIds?.includes(queue.id); return <div key={scope.context} className="flex items-center justify-between gap-4 border-l px-4 py-3"><label className="flex cursor-pointer items-center gap-2 text-xs"><Checkbox checked={allowed} onCheckedChange={(value) => patchPolicy(scope.context, queue.id, value === true)} />Allowed</label><Switch checked={policy.defaultQueueId === queue.id} onCheckedChange={(value) => setDefault(scope.context, queue.id, value)} aria-label={`Use ${queue.name} as default for ${scope.label}`} /></div>; })}</div>)}{!inventory.queues?.length && <p className="p-6 text-center text-sm text-muted-foreground">No Genesys queues were returned.</p>}</div></div><div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><p className="font-medium">Saving updates desired state only.</p><p className="mt-1 text-muted-foreground">The corresponding deployment planner reads this policy on the server. Runtime continues using the last successfully deployed snapshot until you review and apply a new plan.</p></div></div>;
}

function AudioRoutingPanel({ inventory, saving, onSave, onOpenAssistants, onPendingEditChange }) {
  const profile = inventory.audioRoutingProfile;
  const [routes, setRoutes] = useState(() => structuredClone(profile?.routes || []));
  const deployment = (inventory.audioDeployments || [])[0];
  const managedCallRoute = deployment?.architectFlow?.references?.callRoutes?.find((entry) => entry.name === deployment.name)
    || deployment?.architectFlow?.references?.callRoutes?.[0]
    || null;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Inbound Calls</h2><p className="mt-1 text-sm text-muted-foreground">Central desired state for Genesys DID assignments to Telnyx AI assistants.</p></div><Button variant="outline" onClick={onOpenAssistants}><Bot /> Open AI Assistants</Button></div>
    <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>Inbound routing profile</CardTitle><CardDescription>Each Genesys DNIS is assigned once. Existing ownership requires explicit, reviewable takeover approval.</CardDescription></div><Badge variant={profile?.source === "desired" ? "default" : "secondary"}>{profile?.source === "desired" ? `Revision ${profile.desiredRevision}` : "Not configured"}</Badge></div></CardHeader><CardContent>
      <AudioRouteMappings routes={routes} onChange={setRoutes} genesysDids={inventory.genesysDids || []} assistants={inventory.telnyxAssistants || []} managedCallRouteId={managedCallRoute?.id} managedCallRouteName={deployment?.name || "Telnyx Integrations"} onPendingEditChange={onPendingEditChange} />
    </CardContent><CardFooter className="justify-between gap-3"><p className="text-xs text-muted-foreground">Saving does not modify Genesys or Telnyx. Build and accept a deployment plan to apply the profile.</p><Button disabled={saving || !routes.length} onClick={() => void onSave({ routes })}>{saving ? <Loader2 className="animate-spin" /> : <Check />} Save desired routing</Button></CardFooter></Card>
    <div className="rounded-xl border bg-background p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Observed Audio routing</p><p className="mt-1 text-xs text-muted-foreground">Last successfully deployed Architect flow and inbound call route.</p></div><Badge variant={deployment ? "default" : "secondary"}>{deployment ? `${deployment.config?.routes?.length || 0} deployed DNIS` : "Not deployed"}</Badge></div>{deployment?.architectFlow && <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><span>Flow: <strong>{deployment.architectFlow.name}</strong></span><span>Call route: <strong>{managedCallRoute?.name || "Unavailable"}</strong></span></div>}</div>
  </div>;
}

function callbackCampaignStatusPresentation(status) {
  const normalized = String(status || "unknown").trim().toLowerCase();
  if (normalized === "on") return { label: "Running", variant: "default" };
  if (normalized === "off") return { label: "Stopped", variant: "secondary" };
  if (normalized === "complete") return { label: "Completed", variant: "secondary" };
  if (normalized === "stopping") return { label: "Stopping", variant: "outline" };
  if (normalized === "starting") return { label: "Starting", variant: "outline" };
  if (["invalid", "error", "forced_off"].includes(normalized)) {
    return { label: normalized === "forced_off" ? "Forced off" : normalized[0].toUpperCase() + normalized.slice(1), variant: "destructive" };
  }
  return { label: "Unknown", variant: "outline" };
}

function CallbackCampaignPanel({ inventory, saving, campaignStatusSaving, onSave, onSetCampaignEnabled, onOpenWidget }) {
  const profile = inventory.callbackProfile;
  const campaign = inventory.callbackResources?.campaigns?.[0] || null;
  const contactList = inventory.callbackResources?.contactLists?.[0] || null;
  const campaignStatusValue = String(campaign?.campaignStatus || campaign?.status || "").toLowerCase();
  const campaignStatus = callbackCampaignStatusPresentation(campaignStatusValue);
  const campaignRunning = campaign?.enabled === true || campaignStatusValue === "on";
  const campaignStatusControllable = ["on", "off", "complete"].includes(campaignStatusValue);
  const [campaignConfirmation, setCampaignConfirmation] = useState(null);
  const [draft, setDraft] = useState(() => ({
    assistantId: profile?.assistantId || "",
    callerAddress: profile?.callerAddress || "",
    callerName: profile?.callerName || inventory.installation?.installationName || "Telnyx Integrations",
    siteId: profile?.siteId || "",
    wrapupCodeId: profile?.wrapupCodeId || "",
  }));
  const assistantItems = (inventory.telnyxAssistants || []).map((assistant) => ({ value: assistant.id, label: assistant.name, secondary: assistant.id }));
  const callerItems = (inventory.genesysDids || []).map((entry) => ({ value: entry.dnis, label: entry.dnis, secondary: didSecondary(entry) }));
  const siteItems = (inventory.genesysSites || []).map((site) => ({ value: site.id, label: site.name, secondary: site.id }));
  const wrapupItems = (inventory.wrapupCodes || []).map((code) => ({ value: code.id, label: code.name, secondary: code.id }));
  const defaultQueue = (profile?.queues || []).find((queue) => queue.id === profile?.defaultQueueId);
  const canSave = draft.assistantId && draft.callerAddress && draft.callerName.trim() && draft.siteId && draft.wrapupCodeId;
  const resources = [
    { label: "Campaign", resource: campaign, detail: campaign ? `Runtime status: ${campaignStatus.label}` : null, icon: CalendarClock },
    {
      label: "Contact List",
      resource: contactList,
      detail: contactList?.recordCountsAvailable
        ? `${contactList.callableRecords ?? 0} callable / ${contactList.totalRecords ?? 0} all records`
        : contactList ? "Record counts unavailable" : null,
      icon: LayoutDashboard,
    },
    { label: "Outbound Architect flow", resource: inventory.callbackResources?.flows?.[0], detail: "Used by the Call Analysis Response Set", icon: Activity },
  ];
  const callbackResourcesStatus = resources.every(({ resource }) => Boolean(resource)) ? "healthy" : "missing";
  const confirmCampaignStatusChange = async () => {
    if (campaignConfirmation === null || campaignStatusSaving) return;
    try {
      await onSetCampaignEnabled(campaignConfirmation);
      setCampaignConfirmation(null);
    } catch {
      // The parent already renders the API error. Keep the confirmation open so
      // the operator can retry or cancel without losing context.
    }
  };
  return <><div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Callback Campaigns</h2><p className="mt-1 text-sm text-muted-foreground">Central desired state for the Genesys outbound campaign. Customer-facing form and scheduling remain versioned with each widget.</p></div><Button variant="outline" onClick={onOpenWidget}><MessageSquareText /> Open callback experience</Button></div>
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Default callback campaign</CardTitle><CardDescription>One managed assistant and one Genesys Dialer profile shared by callback-enabled widgets.</CardDescription></div><div className="flex flex-wrap items-center justify-end gap-2"><Badge variant={profile?.source === "desired" ? "default" : "secondary"}>{profile?.source === "desired" ? `Revision ${profile.desiredRevision}` : "Not configured"}</Badge>{campaign && <Badge variant={campaignStatus.variant}>{campaignStatus.label}</Badge>}<div className="ml-1 flex items-center gap-2"><Label htmlFor="callback-campaign-enabled" className="text-xs font-medium">Enable campaign</Label>{campaignStatusSaving ? <Loader2 className="size-4 animate-spin" /> : <Switch id="callback-campaign-enabled" checked={campaignRunning} disabled={!campaign || !campaignStatusControllable} onCheckedChange={(enabled) => setCampaignConfirmation(Boolean(enabled))} aria-label="Enable callback campaign" />}</div></div></div></CardHeader><CardContent className="grid items-start gap-5 md:grid-cols-2">
      <Field label="Telnyx AI assistant" hint="Create assistants centrally in AI Assistants, then assign one here."><SearchableCombobox items={assistantItems} value={draft.assistantId} onValueChange={(assistantId) => setDraft((current) => ({ ...current, assistantId }))} searchPlaceholder="Filter assistants…" emptyMessage="No Telnyx assistants found." placeholder="Select callback assistant" ariaLabel="Select default callback assistant" showSelectedSecondary /></Field>
      <Field label="Caller name"><Input value={draft.callerName} maxLength={100} onChange={(event) => setDraft((current) => ({ ...current, callerName: event.target.value }))} /></Field>
      <Field label="Outbound caller ID" hint="The E.164 number presented to the customer."><SearchableCombobox strictFilter items={callerItems} value={draft.callerAddress} onValueChange={(callerAddress) => setDraft((current) => ({ ...current, callerAddress }))} searchPlaceholder="Filter Genesys numbers…" emptyMessage="No Genesys numbers found." placeholder="Select caller ID" ariaLabel="Select callback caller ID" showSelectedSecondary /></Field>
      <Field label="Genesys Site"><SearchableCombobox items={siteItems} value={draft.siteId} onValueChange={(siteId) => setDraft((current) => ({ ...current, siteId }))} searchPlaceholder="Filter Genesys sites…" emptyMessage="No Genesys Sites found." placeholder="Select Site" ariaLabel="Select callback Genesys Site" showSelectedSecondary /></Field>
      <Field label="Default wrap-up code" className="md:col-span-2"><SearchableCombobox items={wrapupItems} value={draft.wrapupCodeId} onValueChange={(wrapupCodeId) => setDraft((current) => ({ ...current, wrapupCodeId }))} searchPlaceholder="Filter wrap-up codes…" emptyMessage="No Genesys wrap-up codes found." placeholder="Select wrap-up code" ariaLabel="Select callback wrap-up code" showSelectedSecondary /></Field>
      <div className="rounded-lg border bg-muted/20 p-4 text-sm md:col-span-2"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Callback campaign policy</Badge><span>{profile?.queueIds?.length || 0} allowed queues</span><span className="text-muted-foreground">· Default: {defaultQueue?.name || "not selected"}</span></div><p className="mt-2 text-xs text-muted-foreground">Queue membership is edited only in Queue Policies. Saving this profile updates desired state; runtime changes after a reviewed deployment succeeds.</p></div>
    </CardContent><CardFooter className="justify-end"><Button disabled={saving || !canSave} onClick={() => void onSave(draft)}>{saving ? <Loader2 className="animate-spin" /> : <Check />} Save desired profile</Button></CardFooter></Card>
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Last deployed resources</CardTitle><CardDescription>Live Genesys state for the resources created by the latest successful Callback Campaign deployment.</CardDescription></div><Badge variant={dashboardStatusVariant(callbackResourcesStatus)}>{DASHBOARD_STATE_LABELS[callbackResourcesStatus]}</Badge></div></CardHeader><CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{resources.map(({ label, resource, detail, icon }) => <InfrastructureTile key={label} label={label} status={resource ? "healthy" : "missing"} title={resource?.name || "Not deployed"} detail={resource ? detail : "Deploy Callback Campaigns to create this resource"} id={resource?.id} icon={icon} />)}</CardContent></Card>
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /><p>Genesys stores callback records directly in the campaign Contact List. This application stores configuration only and does not retain customer callback payloads.</p></div>
  </div><Dialog open={campaignConfirmation !== null} onOpenChange={(open) => { if (!open && !campaignStatusSaving) setCampaignConfirmation(null); }}><DialogContent><DialogHeader><DialogTitle>{campaignConfirmation ? "Start callback campaign?" : "Stop callback campaign?"}</DialogTitle><DialogDescription>{campaignConfirmation ? "Genesys will begin dialing callable records from the managed Contact List." : "Genesys will stop creating new callback dialing attempts. Existing active interactions are not force-disconnected."}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={campaignStatusSaving} onClick={() => setCampaignConfirmation(null)}>Cancel</Button><Button disabled={campaignStatusSaving} onClick={() => void confirmCampaignStatusChange()}>{campaignStatusSaving ? <Loader2 className="animate-spin" /> : campaignConfirmation ? <Play /> : <X />}{campaignConfirmation ? "Enable campaign" : "Stop campaign"}</Button></DialogFooter></DialogContent></Dialog></>;
}

function InfrastructureTile({ label, status, title, detail, id, icon: Icon }) {
  return <div className="rounded-xl border bg-background p-4">
    <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-2">{Icon && <Icon className="size-4 shrink-0 text-telnyx-green" />}<p className="truncate text-xs font-medium text-muted-foreground">{label}</p></div><Badge variant={dashboardStatusVariant(status)}>{DASHBOARD_STATE_LABELS[status] || status || "Unknown"}</Badge></div>
    <p className="mt-3 truncate text-sm font-medium">{title || "Not configured"}</p>
    {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    {id && <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">{id}</p>}
  </div>;
}

function WebChatPanel({ inventory, onOpenWidget, onOpenQueues }) {
  const names = inventory.installation || {};
  const profile = (inventory.handoffPolicies || []).find((entry) => entry.context === "web_messaging");
  const infrastructure = inventory.webChatInfrastructure || { status: "not_configured" };
  const queueCount = profile?.queueIds?.length || infrastructure.queues?.desiredCount || 0;
  const defaultQueue = (profile?.queues || []).find((queue) => queue.id === profile.defaultQueueId)
    || infrastructure.queues?.defaultQueue;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Web Chat</h2><p className="mt-1 text-sm text-muted-foreground">Monitor the shared Genesys Open Messaging infrastructure. Assistant assignment is configured per widget.</p></div><Button variant="outline" onClick={onOpenWidget}><MessageSquareText /> Open widget design</Button></div>
    <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>Web Chat routing</CardTitle><CardDescription>One installation-wide queue policy is shared by all Web Chat widgets. Each widget selects its own Telnyx AI assistant.</CardDescription></div><Badge variant={profile?.source === "desired" ? "default" : "secondary"}>{profile?.source === "desired" ? `Revision ${profile.desiredRevision}` : "Not configured"}</Badge></div></CardHeader><CardContent>
      <div className="grid self-start gap-1.5"><Label>Queue policy</Label><div className="rounded-lg border bg-muted/20 p-3 text-sm"><p>{queueCount} allowed queues{defaultQueue?.name ? ` · Default: ${defaultQueue.name}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">Routing is inherited from Queue Policies → Web Chat.</p></div><Button className="mt-2 w-fit" size="sm" variant="outline" onClick={onOpenQueues}>Open Queue Policies</Button></div>
    </CardContent></Card>

    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Managed infrastructure</CardTitle><CardDescription>Live Genesys and Telnyx state compared with the last successfully deployed Web Chat manifest.</CardDescription></div><Badge variant={dashboardStatusVariant(infrastructure.status)}>{DASHBOARD_STATE_LABELS[infrastructure.status] || "Unknown"}</Badge></div></CardHeader><CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <InfrastructureTile label="Open Messaging" status={infrastructure.openMessaging?.status} title={infrastructure.openMessaging?.name || names.widgetOpenMessaging || names.installationName || "Telnyx Integrations"} detail={infrastructure.openMessaging?.providerStatus ? `Genesys: ${infrastructure.openMessaging.providerStatus}` : "Inbound and outbound messaging integration"} id={infrastructure.openMessaging?.id} icon={MessageSquareText} />
      <InfrastructureTile label="Inbound message flow" status={infrastructure.flow?.status} title={infrastructure.flow?.name || names.widgetMessageFlow || names.installationName || "Telnyx Integrations"} detail={infrastructure.flow?.published ? `Published${infrastructure.flow.version ? ` · version ${infrastructure.flow.version}` : ""}` : "A published flow is required"} id={infrastructure.flow?.id} icon={Activity} />
      <InfrastructureTile label="Recipient routing" status={infrastructure.recipient?.status} title={infrastructure.recipient?.flowName || infrastructure.flow?.name || "Not assigned"} detail="Open Messaging recipient → inbound message flow" id={infrastructure.recipient?.id} icon={Globe2} />
      <InfrastructureTile label="Shared handoff tool" status={infrastructure.handoffTool?.status} title={infrastructure.handoffTool?.name || names.widgetHandoffTool || names.installationName || "Telnyx Integrations"} detail="Telnyx webhook tool used for human handoff" id={infrastructure.handoffTool?.id} icon={Wrench} />
      <InfrastructureTile label="Queue deployment" status={infrastructure.queues?.status} title={`${infrastructure.queues?.entries?.length || 0} deployed queues`} detail={infrastructure.queues?.defaultQueue?.name ? `Default: ${infrastructure.queues.defaultQueue.name}` : "No deployed default queue"} icon={Activity} />
      <InfrastructureTile label="Public endpoint" status={infrastructure.publicBaseUrl ? "healthy" : "missing"} title={infrastructure.publicBaseUrl || "Not configured"} detail={infrastructure.openMessaging?.webhookUrl || "Managed in Settings → Public URL"} icon={Globe2} />
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Access</CardTitle><CardDescription>Fixed administrator access used to manage this integration.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
      <InfrastructureTile label="Genesys access group" status={infrastructure.access?.group ? "healthy" : "missing"} title={infrastructure.access?.group?.name || names.adminGroup || names.installationName || "Telnyx Integrations"} id={infrastructure.access?.group?.id} icon={ShieldCheck} />
      <InfrastructureTile label="Genesys administrator role" status={infrastructure.access?.role ? "healthy" : "missing"} title={infrastructure.access?.role?.name || names.adminRole || names.installationName || "Telnyx Integrations"} id={infrastructure.access?.role?.id} icon={ShieldCheck} />
    </CardContent></Card>
    {infrastructure.status !== "healthy" && <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /><div><p className="font-medium">Web Chat infrastructure requires deployment or reconciliation.</p><p className="mt-1 text-muted-foreground">Review the statuses above, then build a deployment plan. Only missing, drifted or changed resources should be included.</p></div></div>}
  </div>;
}

function WebVoicePanel({ inventory, saving, republishing, onRepublish, onSave, onOpenWidget }) {
  const voiceProfile = (inventory.channelProfiles || []).find((profile) => profile.channel === "voice");
  const [draft, setDraft] = useState(() => ({
    genesysTrunkId: voiceProfile?.config?.genesysTrunkId || "",
    region: voiceProfile?.config?.region || "auto",
    callerNumber: voiceProfile?.config?.callerNumber || "",
    keepAssistantOnCall: voiceProfile?.config?.keepAssistantOnCall === true,
  }));
  const trunkOptions = (inventory.genesysSipTrunks || []).map((trunk) => ({
    value: trunk.id,
    label: trunk.name,
    // A TLS trunk terminates media as SRTP, which the published SIP URI has to ask
    // for with ;secure=srtp, so the transport is worth seeing before selecting.
    badge: trunk.transport ? trunk.transport.toUpperCase() : null,
    secondary: `${trunk.fqdn || trunk.byocDomain || trunk.id}${trunk.compatible ? "" : " · not compatible"}`,
    disabled: trunk.enabled === false || trunk.compatible === false,
  }));
  const regionOptions = [
    { value: "auto", label: "Auto (recommended)" },
    { value: "eu", label: "Europe" },
    { value: "us-east", label: "United States — East" },
    { value: "us-central", label: "United States — Central" },
    { value: "us-west", label: "United States — West" },
    { value: "ca-central", label: "Canada — Central" },
    { value: "apac", label: "Asia Pacific" },
    { value: "south-asia", label: "South Asia" },
  ];
  const callerItems = (inventory.genesysDids || []).map((entry) => ({ value: entry.dnis, label: entry.dnis, secondary: didSecondary(entry) }));
  const canSave = draft.genesysTrunkId && draft.region && draft.callerNumber;
  // A saved profile does not reach a published widget until that widget is
  // republished, so the list says which ones are still on the old routing.
  const publishedVoiceWidgets = (inventory.widgetDeployments || []).filter(
    (deployment) => deployment.config?.voiceEnabled === true
  );
  const driftedDeployments = publishedVoiceWidgets.filter(
    (deployment) => webCallDeploymentDrift(deployment, { voiceProfile, trunks: inventory.genesysSipTrunks || [] }).needsRepublish
  );
  const republishAll = async () => {
    for (const deployment of driftedDeployments) {
      if (!(await onRepublish(deployment.id))) break;
    }
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Web Calls</h2><p className="mt-1 text-sm text-muted-foreground">Manage the shared browser voice transport and routing profile. Each widget owns the AI assistant used by both Web Chat and Web Calls.</p></div><Button variant="outline" onClick={onOpenWidget}><MessageSquareText /> Open widget design</Button></div>
    <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>Web Calls profile</CardTitle><CardDescription>Shared trunk, caller identity and media settings applied to Web Calls-enabled widgets.</CardDescription></div><Badge variant={voiceProfile?.source === "desired" ? "default" : "secondary"}>{voiceProfile?.source === "desired" ? `Revision ${voiceProfile.desiredRevision}` : "Not configured"}</Badge></div></CardHeader><CardContent className="grid items-start gap-5 md:grid-cols-2">
      <Field label="Genesys BYOC trunk" hint="Publishing a widget reserves a unique synthetic DID and builds its SIP URI from this trunk."><SearchableCombobox value={draft.genesysTrunkId} onValueChange={(genesysTrunkId) => setDraft((current) => ({ ...current, genesysTrunkId }))} items={trunkOptions} showSelectedSecondary searchPlaceholder="Filter Genesys BYOC trunks…" emptyMessage="No compatible BYOC trunks found." placeholder="Select the shared voice trunk" ariaLabel="Select Web Calls Genesys trunk" /></Field>
      <Field label="Voice media region"><SearchableCombobox value={draft.region} onValueChange={(region) => setDraft((current) => ({ ...current, region }))} items={regionOptions} placeholder="Select media region" ariaLabel="Select Web Calls media region" /></Field>
      <Field
        label="Keep AI assistant on the call during handoff"
        className="md:col-span-2"
        hint="Publishing then attaches the Telnyx Invite and Skip Turn tools instead of SIP Transfer, so the assistant stays connected while the Genesys agent joins the same call. Web calls only — messaging and Audio Connector handoffs are unaffected."
      >
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Switch
            checked={draft.keepAssistantOnCall}
            onCheckedChange={(value) => setDraft((current) => ({ ...current, keepAssistantOnCall: value === true }))}
            aria-label="Keep AI assistant on the call after inviting a Genesys agent"
          />
          <span className="text-sm">{draft.keepAssistantOnCall ? "Invite the agent and stay on the call" : "Transfer the call and leave"}</span>
        </div>
      </Field>
      <Field label="WebRTC caller ID" hint="Presented as the caller identity of every browser voice session and reused as transfer.from on the SIP handoff to Genesys. Browser calls stay unavailable until a number is selected."><SearchableCombobox strictFilter items={callerItems} value={draft.callerNumber} onValueChange={(callerNumber) => setDraft((current) => ({ ...current, callerNumber }))} searchPlaceholder="Filter Genesys numbers…" emptyMessage="No Genesys numbers found. Refresh inventory first." placeholder="Select WebRTC caller ID" ariaLabel="Select Web Calls WebRTC caller ID" showSelectedSecondary /></Field>
      <div className="rounded-lg border bg-muted/20 p-4 text-sm md:col-span-2"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Web Chat</Badge><span>{((inventory.channelProfiles || []).find((profile) => profile.channel === "messaging")?.queueIds || []).length} allowed queues</span><Badge variant="outline" className="ml-2">Web Calls</Badge><span>{voiceProfile?.queueIds?.length || 0} allowed queues</span></div><p className="mt-2 text-xs text-muted-foreground">Queue membership and defaults remain managed centrally in Queue Policies. Saving this profile links both policies and records desired state; published widgets keep their current routing until each one is republished below.</p></div>
    </CardContent><CardFooter className="justify-end"><Button disabled={saving || !canSave} onClick={() => void onSave(draft)}>{saving ? <Loader2 className="animate-spin" /> : <Check />} Save desired profile</Button></CardFooter></Card>
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Published Web Calls widgets</h3>
        {Boolean(driftedDeployments.length) && (
          <Button size="sm" disabled={Boolean(republishing)} onClick={() => void republishAll()}>
            {republishing ? <Loader2 className="animate-spin" /> : <Check />} Republish all ({driftedDeployments.length})
          </Button>
        )}
      </div>
      {Boolean(driftedDeployments.length) && (
        <div className="mb-3 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p>Saving this profile records desired state only. {driftedDeployments.length === 1 ? "One published widget still uses" : `${driftedDeployments.length} published widgets still use`} the previous routing — republishing rebuilds each SIP URI and updates the Telnyx Transfer and dynamic-variable tools.</p>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border bg-background">
        {publishedVoiceWidgets.map((deployment) => {
          const drift = webCallDeploymentDrift(deployment, { voiceProfile, trunks: inventory.genesysSipTrunks || [] });
          return (
            <div key={deployment.id} className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0">
              <div className="min-w-0">
                <p className="text-sm font-medium">{deployment.name}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">{deployment.config?.genesysSipUri || "No SIP route"}</p>
                {drift.needsRepublish && drift.reasons.map((reason) => (
                  <p key={reason.label} className="mt-1 font-mono text-[10px] text-amber-700 dark:text-amber-400">
                    → {reason.label}: {reason.from} ⟶ {reason.to}
                    {reason.label === "SIP URI" && drift.trunkTransport
                      ? ` (trunk ${drift.trunkName} · ${drift.trunkTransport.toUpperCase()})`
                      : ""}
                  </p>
                ))}
                {deployment.publishedVersion && <p className="mt-1 text-xs text-muted-foreground">Published revision {deployment.publishedVersion}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {drift.needsRepublish && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">Needs republish</Badge>}
                <Badge variant="default">Web Calls enabled</Badge>
                {!deployment.enabled && <Badge variant="outline">Disabled</Badge>}
                {drift.needsRepublish && (
                  <Button size="sm" variant="outline" disabled={Boolean(republishing)} onClick={() => void onRepublish(deployment.id)}>
                    {republishing === deployment.id ? <Loader2 className="animate-spin" /> : <Check />} Republish
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {!publishedVoiceWidgets.length && <div className="grid justify-items-center gap-2 p-6 text-center"><MessageSquareText className="size-7 text-muted-foreground" /><p className="text-sm font-medium">No published Web Calls widgets yet.</p><p className="max-w-md text-xs text-muted-foreground">Enable Web Calls in a widget and publish it to make its voice route available here.</p><Button className="mt-2" size="sm" onClick={onOpenWidget}><Plus /> Open widget design</Button></div>}
      </div>
    </div>
  </div>;
}

function DeploymentBody({ stage, run }) {
  if (stage === 1 && run) return <div className="space-y-6"><div className="rounded-xl border bg-muted/20 p-5"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Target organization</p><p className="mt-1 text-lg font-medium">{run.plan.summary.target?.name}</p><code className="text-xs text-muted-foreground">{run.plan.summary.target?.id}</code><p className="mt-3 text-xs text-muted-foreground">This plan is an immutable snapshot. Refresh it after any external Genesys or Telnyx change.</p></div>{run.plan.summary.warnings?.map((warning) => <div key={warning} className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /><p>{warning}</p></div>)}{run.plan.summary.resources.length ? <div className="space-y-2">{run.plan.summary.resources.map((resource, index) => <div key={`${resource.type}-${index}`} className="flex items-center gap-3 rounded-xl border p-4"><Badge variant="outline">{resource.action}</Badge><div className="min-w-0"><p className="text-sm font-medium">{resource.type}</p><p className="truncate text-xs text-muted-foreground">{resource.name || "Managed resource"}</p></div></div>)}</div> : <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5"><Check className="mt-0.5 size-5 shrink-0 text-emerald-500" /><div><p className="font-medium">No configuration changes</p><p className="mt-1 text-sm text-muted-foreground">The managed resources already match the current desired state. No deployment is required.</p></div></div>}</div>;
  if (stage === 2 && run) return <div className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deployment run</p><code className="text-xs">{run.id}</code></div><Badge variant={run.status === "failed" ? "destructive" : run.status === "succeeded" ? "default" : "secondary"}>{run.status}</Badge></div><div className="space-y-2">{run.steps.map((step) => <div key={step.ordinal} className="flex items-start gap-3 rounded-xl border p-4"><div className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ${step.status === "succeeded" ? "bg-emerald-500 text-black" : step.status === "failed" ? "bg-destructive text-white" : "bg-muted"}`}>{step.status === "succeeded" ? <Check className="size-3.5" /> : step.status === "failed" ? <X className="size-3.5" /> : step.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : step.ordinal + 1}</div><div className="min-w-0 flex-1"><p className="text-sm font-medium">{step.label}</p>{step.detail && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{step.detail}</p>}</div></div>)}</div>{run.error && <div className="whitespace-pre-wrap break-words rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{run.error}</div>}</div>;
  return null;
}

function PublicOriginDialog({ open, onOpenChange, currentBaseUrl, onCompleted }) {
  const [baseUrl, setBaseUrl] = useState(currentBaseUrl || "");
  const [stage, setStage] = useState(0);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && stage === 0 && !run) setBaseUrl(currentBaseUrl || "");
  }, [currentBaseUrl, open, run, stage]);

  useEffect(() => {
    if (!open || !run?.id || run.status !== "running") return undefined;
    const timer = setInterval(() => {
      void api(`/api/admin/deployments/${run.id}`).then(({ run: next }) => {
        setRun(next);
        if (["succeeded", "failed", "cancelled"].includes(next.status)) {
          clearInterval(timer);
          if (next.status === "succeeded") {
            toast.success("Public application URL updated");
            void onCompleted();
          }
        }
      }).catch(() => undefined);
    }, 1200);
    return () => clearInterval(timer);
  }, [onCompleted, open, run?.id, run?.status]);

  const resetAndClose = () => {
    setStage(0);
    setRun(null);
    setBusy(false);
    onOpenChange(false);
  };
  const handleOpenChange = (next) => {
    if (!next && run?.status === "running") return;
    if (!next) {
      resetAndClose();
      return;
    }
    onOpenChange(true);
  };
  const createPlan = async () => {
    setBusy(true);
    try {
      const body = await api("/api/admin/public-origin/plan", {
        method: "POST",
        body: JSON.stringify({ baseUrl }),
      });
      setRun(body.run);
      setStage(1);
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  const applyPlan = async () => {
    setBusy(true);
    try {
      const body = await api(`/api/admin/deployments/${run.id}/apply`, { method: "POST", body: "{}" });
      setRun(body.run);
      setStage(2);
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Public application URL</DialogTitle>
          <DialogDescription>Update the shared HTTPS origin and synchronize every managed Audio, Widget and Telnyx Insights resource.</DialogDescription>
        </DialogHeader>
        {stage === 0 && <div className="space-y-5">
          <div className="rounded-lg border bg-muted/20 p-4"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Currently configured</p><p className="mt-1 break-all text-sm font-medium">{currentBaseUrl || "Not configured"}</p></div>
          <Field label="New public application URL" hint="Enter only an HTTPS origin, without a path, query string, or fragment."><Input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://tunnel.example.com" autoComplete="url" /></Field>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><p className="font-medium">This is a global change.</p><p className="mt-1 text-muted-foreground">The plan updates Telnyx webhook tools and the managed Insights Group webhook, Genesys widgets, OAuth callbacks, Audio Connector WebSocket URLs, Widget deployments, local manifests, and finally the encrypted runtime configuration.</p></div>
          <DialogFooter><Button variant="outline" onClick={resetAndClose}>Cancel</Button><Button disabled={busy || !baseUrl.trim() || baseUrl.trim().replace(/\/$/, "") === String(currentBaseUrl || "").replace(/\/$/, "")} onClick={() => void createPlan()}>{busy ? <Loader2 className="animate-spin" /> : <Globe2 />} Validate & build plan</Button></DialogFooter>
        </div>}
        {stage === 1 && run && <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg border p-4"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Current URL</p><p className="mt-1 break-all text-sm">{run.plan.summary.previousBaseUrl}</p></div><div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">New URL</p><p className="mt-1 break-all text-sm font-medium">{run.plan.summary.publicBaseUrl}</p></div></div>
          <div className="space-y-2">{run.plan.summary.resources.map((resource, index) => <div key={`${resource.type}-${resource.name}-${index}`} className="flex items-center gap-3 rounded-lg border p-3"><Badge variant="outline">{resource.action}</Badge><div className="min-w-0"><p className="text-sm font-medium">{resource.type}</p><p className="truncate text-xs text-muted-foreground">{resource.name}</p></div></div>)}</div>
          {run.plan.summary.warnings?.map((warning) => <div key={warning} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{warning}</div>)}
          <DialogFooter><Button variant="outline" onClick={() => { setStage(0); setRun(null); }}><ChevronLeft /> Edit URL</Button><Button disabled={busy} onClick={() => void applyPlan()}>{busy ? <Loader2 className="animate-spin" /> : <Rocket />} Accept & update all</Button></DialogFooter>
        </div>}
        {stage === 2 && run && <div className="space-y-5">
          <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">Synchronizing managed resources</p><Badge variant={run.status === "failed" ? "destructive" : run.status === "succeeded" ? "default" : "secondary"}>{run.status}</Badge></div>
          <div className="space-y-2">{run.steps.map((step) => <div key={step.ordinal} className="flex items-start gap-3 rounded-lg border p-3"><div className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ${step.status === "succeeded" ? "bg-emerald-500 text-black" : step.status === "failed" ? "bg-destructive text-white" : "bg-muted"}`}>{step.status === "succeeded" ? <Check className="size-3.5" /> : step.status === "failed" ? <X className="size-3.5" /> : step.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : step.ordinal + 1}</div><div><p className="text-sm font-medium">{step.label}</p>{step.detail && <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>}</div></div>)}</div>
          {run.error && <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">{run.error}</div>}
          {["succeeded", "failed", "cancelled"].includes(run.status) && <DialogFooter><Button variant="outline" onClick={resetAndClose}>Close</Button></DialogFooter>}
        </div>}
      </DialogContent>
    </Dialog>
  );
}

export default function AdminConsole() {
  const [auth, setAuth] = useState({ loading: true, authenticated: false });
  const [dashboardOverview, setDashboardOverview] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [inventory, setInventory] = useState({
    queues: [], groups: [], ttsProfiles: [], ttsDeployments: [], ttsFlows: [], audioDeployments: [], widgetDeployments: [],
    configuredDnis: [], genesysDids: [], genesysSites: [], wrapupCodes: [], genesysSipTrunks: [], messageFlows: [], telnyxAssistants: [], ttsCapacity: { used: 0, total: 10 }, audioCapacity: { used: 0, total: 10 },
    channelProfiles: [], handoffPolicies: [], audioRoutingProfile: null, callbackProfile: null, managedTools: [], publicBaseUrl: null, webChatInfrastructure: null,
  });
  const [selected, setSelected] = useState("dashboard");
  const [aiSection, setAiSection] = useState("audio");
  const [configs, setConfigs] = useState(() => ({
    tts: mergeConfig("tts"),
    audio: mergeConfig("audio"),
    callbacks: mergeConfig("callbacks"),
    widget: mergeConfig("widget"),
  }));
  const [queuePolicies, setQueuePolicies] = useState(() => handoffPoliciesByContext([], {
    audio: mergeConfig("audio"),
    callbacks: mergeConfig("callbacks"),
    widget: mergeConfig("widget"),
  }));
  const [assistantCatalog, setAssistantCatalog] = useState([]);
  const aiItem = AI_NAV_GROUPS.flatMap((group) => group.items).find((item) => item.id === aiSection);
  const deploymentComponent = selected === "tts" ? "tts" : selected === "ai" ? aiItem?.component || null : null;
  const config = deploymentComponent ? configs[deploymentComponent] : null;
  const setConfig = useCallback((next) => {
    if (!deploymentComponent) return;
    setConfigs((current) => ({
      ...current,
      [deploymentComponent]: typeof next === "function" ? next(current[deploymentComponent]) : next,
    }));
  }, [deploymentComponent]);
  const [ttsPreviews, setTtsPreviews] = useState({});
  const [stage, setStage] = useState(0);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const inventoryRequestsRef = useRef(0);
  const componentConfigsRef = useRef([]);
  const [refreshingInventory, setRefreshingInventory] = useState(false);
  const [publicOriginOpen, setPublicOriginOpen] = useState(false);
  const [savingQueuePolicies, setSavingQueuePolicies] = useState(false);
  const [savingChannelProfile, setSavingChannelProfile] = useState(false);
  const [savingAudioRouting, setSavingAudioRouting] = useState(false);
  const [savingCallbackProfile, setSavingCallbackProfile] = useState(false);
  const [savingCallbackCampaignStatus, setSavingCallbackCampaignStatus] = useState(false);
  const [hasPendingConfigurationEdit, setHasPendingConfigurationEdit] = useState(false);
  const [reauthDialog, setReauthDialog] = useState({ open: false, message: "" });

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyOverscrollBehavior = body.style.overscrollBehavior;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    window.scrollTo(0, 0);

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehavior = previousBodyOverscrollBehavior;
    };
  }, []);

  const selectedMeta = CATALOG.find((entry) => entry.id === selected);
  const SelectedIcon = selectedMeta.icon;
  const audioRoutingPanelKey = `${inventory.audioRoutingProfile?.source || "none"}:${inventory.audioRoutingProfile?.desiredRevision || 0}`;
  const callbackCampaignPanelKey = `${inventory.callbackProfile?.source || "none"}:${inventory.callbackProfile?.desiredRevision || 0}`;
  const webVoiceProfile = (inventory.channelProfiles || []).find((profile) => profile.channel === "voice");
  const webVoicePanelKey = `${webVoiceProfile?.source || "none"}:${webVoiceProfile?.desiredRevision || 0}`;
  const webChatProfile = (inventory.handoffPolicies || []).find((profile) => profile.context === "web_messaging");
  const webChatPanelKey = `${webChatProfile?.source || "none"}:${webChatProfile?.desiredRevision || 0}:${inventory.webChatInfrastructure?.updatedAt || "none"}`;
  const selectedCapacity = deploymentComponent === "tts"
    ? inventory.ttsCapacity
    : deploymentComponent === "audio" && aiSection === "audio"
      ? inventory.audioCapacity
      : null;
  const creatingNewAudioConnector = deploymentComponent === "audio" && aiSection === "audio" && !(inventory.audioDeployments || []).length;
  const deploymentPolicyScope = QUEUE_POLICY_SCOPES.find((scope) => scope.component === deploymentComponent);
  const deploymentQueuePolicy = deploymentPolicyScope ? queuePolicies[deploymentPolicyScope.context] : null;
  const deploymentQueuePolicyIncomplete = Boolean(deploymentPolicyScope) && (
    !deploymentQueuePolicy?.queueIds?.length || !deploymentQueuePolicy.defaultQueueId
  );
  const hasConfigurationChanges = deploymentComponent !== "tts" || ttsConfigChanged(config, inventory);
  const configurationValidationLoading = Boolean(deploymentComponent) && inventoryLoading;
  const configurationPlanDisabled = !deploymentComponent || busy || inventoryLoading || hasPendingConfigurationEdit || !hasConfigurationChanges || deploymentQueuePolicyIncomplete || (creatingNewAudioConnector && !inventory.publicBaseUrl) || (
    deploymentComponent === "audio" && (
      inventory.audioRoutingProfile?.source !== "desired" || !config.routes?.length || !config.widgetGroupIds?.length
    )
  ) || (
    deploymentComponent === "callbacks" && (
      inventory.callbackProfile?.source !== "desired" ||
      !config.callerAddress || !config.siteId || !config.wrapupCodeId ||
      !config.assistantId
    )
  );
  const deploymentFinished = ["succeeded", "failed", "cancelled"].includes(run?.status);

  const selectComponent = useCallback((id) => {
    setSelected(id); setStage(0); setRun(null); setHasPendingConfigurationEdit(false);
  }, []);

  const selectAiSection = useCallback((id) => {
    setAiSection(id); setStage(0); setRun(null); setHasPendingConfigurationEdit(false);
  }, []);

  const refreshInventory = useCallback(async ({ hydrateConfigs = false } = {}) => {
    inventoryRequestsRef.current += 1;
    setInventoryLoading(true);
    try {
      const inventoryBody = await api(`/api/admin/inventory?refresh=${Date.now()}`);
      setInventory(inventoryBody);
      const [assistantBody, dashboardBody] = await Promise.all([
        api("/api/admin/ai/assistants"),
        api("/api/admin/dashboard"),
      ]);
      setAssistantCatalog(assistantBody.assistants || []);
      setDashboardOverview(dashboardBody.overview || null);
      setDashboardLoading(false);
      if (hydrateConfigs) {
        const stored = new Map(componentConfigsRef.current.map((entry) => [entry.component, entry]));
        setConfigs((current) => ({
          ...current,
          tts: ttsConfigFromLiveInventory(inventoryBody),
          audio: audioConfigFromInventory(inventoryBody, stored.get("audio")?.config),
          callbacks: callbackConfigFromProfile(inventoryBody.callbackProfile, stored.get("callbacks")?.config),
        }));
      }
      return inventoryBody;
    } finally {
      inventoryRequestsRef.current -= 1;
      if (inventoryRequestsRef.current === 0) setInventoryLoading(false);
    }
  }, []);

  const refreshVisibleInventory = useCallback(async () => {
    if (refreshingInventory) return;
    setRefreshingInventory(true);
    try {
      await refreshInventory();
      toast.success("Inventory refreshed");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(`Inventory refresh failed: ${error.message}`);
    } finally {
      setRefreshingInventory(false);
    }
  }, [refreshInventory, refreshingInventory]);

  const refreshAfterPublicOriginChange = useCallback(async () => {
    await refreshInventory();
  }, [refreshInventory]);

  const load = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const session = await api("/api/admin/session");
      const [componentsBody, policiesBody, assistantsBody, profilesBody, audioRoutingBody, callbackProfileBody, dashboardBody] = await Promise.all([
        api("/api/admin/components"),
        api("/api/admin/ai/queue-policies"),
        api("/api/admin/ai/assistants"),
        api("/api/admin/ai/channel-profiles"),
        api("/api/admin/ai/audio-routing"),
        api("/api/admin/ai/callback-profile"),
        api("/api/admin/dashboard"),
      ]);
      const bootstrapInventory = componentsBody.inventory || {};
      const desiredInventory = { ...bootstrapInventory, audioRoutingProfile: audioRoutingBody.profile || null };
      const stored = new Map(componentsBody.components.map((entry) => [entry.component, entry]));
      componentConfigsRef.current = componentsBody.components;
      setInventory((current) => ({ ...current, ...desiredInventory, channelProfiles: profilesBody.profiles || [], handoffPolicies: policiesBody.policies || [], callbackProfile: callbackProfileBody.profile || null }));
      const nextConfigs = {
        tts: ttsConfigFromLiveInventory(bootstrapInventory),
        audio: audioConfigFromInventory(desiredInventory, stored.get("audio")?.config),
        callbacks: callbackConfigFromProfile(callbackProfileBody.profile, stored.get("callbacks")?.config),
        widget: mergeConfig("widget", stored.get("widget")?.config),
      };
      const nextPolicies = handoffPoliciesByContext(policiesBody.policies || [], nextConfigs);
      setConfigs(configsWithHandoffPolicies(nextConfigs, nextPolicies));
      setQueuePolicies(nextPolicies);
      setAssistantCatalog(assistantsBody.assistants || []);
      setDashboardOverview(dashboardBody.overview || null);
      setDashboardLoading(false);
      setAuth({ loading: false, authenticated: true, user: session.user });
      clearGenesysReauthRequired();
      void refreshInventory({ hydrateConfigs: true }).catch((error) => {
        if (shouldShowGenesysApiError(error)) toast.error(`Background inventory refresh failed: ${error.message}`);
      });
    } catch (error) {
      setDashboardLoading(false);
      setAuth({ loading: false, authenticated: false, error: error.message });
    }
  }, [refreshInventory]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onMessage = async (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "genesys-auth-complete") return;
      try {
        setAuth((current) => ({ ...current, loading: true }));
        await api("/api/auth/finalize", {
          method: "POST",
          body: JSON.stringify({ handoff: event.data.handoff }),
        });
        clearGenesysReauthRequired();
        setReauthDialog({ open: false, message: "" });
        await load();
      } catch (error) {
        setAuth({ loading: false, authenticated: false, error: error.message });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);
  useEffect(() => {
    const onReauthRequired = (event) => {
      if (!auth.authenticated) return;
      setReauthDialog((current) => current.open ? current : {
        open: true,
        message: event.detail?.message || "Your Genesys Cloud session has expired.",
      });
    };
    window.addEventListener(GENESYS_REAUTH_REQUIRED_EVENT, onReauthRequired);
    return () => window.removeEventListener(GENESYS_REAUTH_REQUIRED_EVENT, onReauthRequired);
  }, [auth.authenticated]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && auth.authenticated && !reauthDialog.open) void refreshInventory();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [auth.authenticated, reauthDialog.open, refreshInventory]);
  useEffect(() => {
    if (!run?.id || run.status !== "running" || stage !== 2 || reauthDialog.open) return undefined;
    const timer = setInterval(() => { void api(`/api/admin/deployments/${run.id}`).then(({ run: next }) => { setRun(next); if (["succeeded", "failed", "cancelled"].includes(next.status)) { clearInterval(timer); void refreshInventory().catch((error) => { if (shouldShowGenesysApiError(error)) toast.error(`Inventory refresh failed: ${error.message}`); }); } }).catch(() => undefined); }, 1200);
    return () => clearInterval(timer);
  }, [run?.id, run?.status, stage, reauthDialog.open, refreshInventory]);

  const createPlan = async () => {
    if (!deploymentComponent) return;
    if (hasPendingConfigurationEdit) return toast.error("Confirm or cancel the edited DNIS row before building the plan");
    setBusy(true);
    try {
      const body = await api(`/api/admin/components/${deploymentComponent}/plan`, { method: "POST", body: JSON.stringify({ config }) });
      setRun(body.run); setStage(1); setConfig(body.run.config); toast.success("Live deployment plan created");
    } catch (error) { if (shouldShowGenesysApiError(error)) toast.error(error.message); } finally { setBusy(false); }
  };

  const saveQueuePolicies = async () => {
    if (savingQueuePolicies) return;
    setSavingQueuePolicies(true);
    try {
      const body = await api("/api/admin/ai/queue-policies", {
        method: "PATCH",
        body: JSON.stringify({ policies: QUEUE_POLICY_SCOPES.map((scope) => ({
          context: scope.context,
          queueIds: queuePolicies[scope.context]?.queueIds || [],
          defaultQueueId: queuePolicies[scope.context]?.defaultQueueId || "",
        })) }),
      });
      setQueuePolicies(handoffPoliciesByContext(body.policies || [], configs));
      setConfigs((current) => {
        const next = { ...current };
        for (const scope of QUEUE_POLICY_SCOPES) {
          if (!scope.component) continue;
          const policy = (body.policies || []).find((entry) => entry.context === scope.context);
          if (policy) next[scope.component] = { ...next[scope.component], queueIds: policy.queueIds, defaultQueueId: policy.defaultQueueId };
        }
        return next;
      });
      setInventory((current) => {
        const policies = new Map((body.policies || []).map((policy) => [policy.context, policy]));
        const callbackPolicy = policies.get("callback_outbound");
        return {
          ...current,
          handoffPolicies: body.policies || [],
          callbackProfile: current.callbackProfile && callbackPolicy ? {
            ...current.callbackProfile,
            queueIds: callbackPolicy.queueIds,
            queues: callbackPolicy.queues || [],
            defaultQueueId: callbackPolicy.defaultQueueId,
          } : current.callbackProfile,
          channelProfiles: (current.channelProfiles || []).map((profile) => {
            const policy = policies.get(profile.queuePolicyContext);
            return policy ? { ...profile, queueIds: policy.queueIds, queues: policy.queues || [], defaultQueueId: policy.defaultQueueId } : profile;
          }),
        };
      });
      toast.success("Queue policies saved. Review and apply each affected channel deployment.");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setSavingQueuePolicies(false);
    }
  };

  const [republishing, setRepublishing] = useState("");
  const republishWidget = async (widgetId) => {
    if (republishing) return false;
    setRepublishing(widgetId);
    try {
      await api(`/api/admin/widgets/${encodeURIComponent(widgetId)}/publish`, {
        method: "POST",
        body: JSON.stringify({ forceInfrastructure: true }),
      });
      await refreshInventory();
      return true;
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
      return false;
    } finally {
      setRepublishing("");
    }
  };

  const saveChannelProfile = async (draft) => {
    if (savingChannelProfile) return;
    setSavingChannelProfile(true);
    try {
      const body = await api("/api/admin/ai/channel-profiles", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setInventory((current) => ({ ...current, channelProfiles: body.profiles || [] }));
      toast.success("Web Calls profile saved as desired state");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setSavingChannelProfile(false);
    }
  };

  const saveAudioRouting = async (draft) => {
    if (savingAudioRouting) return;
    setSavingAudioRouting(true);
    try {
      const body = await api("/api/admin/ai/audio-routing", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setInventory((current) => ({ ...current, audioRoutingProfile: body.profile }));
      setConfigs((current) => ({
        ...current,
        audio: audioConfigFromInventory({ ...inventory, audioRoutingProfile: body.profile }, current.audio),
      }));
      toast.success("Default Audio DNIS routing saved as desired state");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setSavingAudioRouting(false);
    }
  };

  const saveCallbackProfile = async (draft) => {
    if (savingCallbackProfile) return;
    setSavingCallbackProfile(true);
    try {
      const body = await api("/api/admin/ai/callback-profile", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setInventory((current) => ({ ...current, callbackProfile: body.profile }));
      setConfigs((current) => ({ ...current, callbacks: callbackConfigFromProfile(body.profile, current.callbacks) }));
      toast.success("Default callback campaign profile saved as desired state");
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
    } finally {
      setSavingCallbackProfile(false);
    }
  };

  const setCallbackCampaignEnabled = async (enabled) => {
    if (savingCallbackCampaignStatus) return;
    setSavingCallbackCampaignStatus(true);
    try {
      const body = await api("/api/admin/ai/callback-campaign/status", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setInventory((current) => ({
        ...current,
        callbackResources: {
          ...(current.callbackResources || {}),
          campaigns: [
            {
              ...(current.callbackResources?.campaigns?.[0] || {}),
              ...body.campaign,
            },
          ],
        },
      }));
      toast.success(enabled ? "Callback campaign is running" : "Callback campaign is stopped");
      return body.campaign;
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
      throw error;
    } finally {
      setSavingCallbackCampaignStatus(false);
    }
  };

  const createAssistant = async (draft) => {
    try {
      const body = await api("/api/admin/ai/assistants", { method: "POST", body: JSON.stringify(draft) });
      setAssistantCatalog((current) => [...current.filter((entry) => entry.telnyxAssistantId !== body.assistant.telnyxAssistantId), body.assistant].sort((left, right) => left.name.localeCompare(right.name)));
      const inventoryAssistant = body.inventoryAssistant || {
        id: body.assistant.telnyxAssistantId,
        name: body.assistant.name,
        audioConnector: false,
        versions: [{ id: "main", name: "Main / current", createdAt: null }],
      };
      setInventory((current) => ({
        ...current,
        telnyxAssistants: [...(current.telnyxAssistants || []).filter((entry) => entry.id !== inventoryAssistant.id), inventoryAssistant]
          .sort((left, right) => left.name.localeCompare(right.name)),
      }));
      toast.success(`${body.assistant.name} created in Telnyx`);
      return body.assistant;
    } catch (error) {
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
      throw error;
    }
  };

  const apply = async () => {
    setBusy(true);
    try { const body = await api(`/api/admin/deployments/${run.id}/apply`, { method: "POST", body: "{}" }); setRun(body.run); setStage(2); }
    catch (error) { if (shouldShowGenesysApiError(error)) toast.error(error.message); } finally { setBusy(false); }
  };

  if (auth.loading) return <AdminConsoleLoadingSkeleton />;
  if (!auth.authenticated) return <div className="fixed inset-0 grid place-items-center overflow-hidden p-6"><Card className="max-w-md border-emerald-500/20 shadow-2xl"><CardHeader><CardTitle>Telnyx Integration Administration</CardTitle><CardDescription>Authenticate with Genesys Cloud. Access is verified against the administrator role configured by genesys:deploy.</CardDescription></CardHeader><CardContent>{auth.error && <p className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{auth.error}</p>}<Button className="w-full" onClick={() => window.open(`/api/auth/login?popup=1&returnTo=${encodeURIComponent("/genesys/widget-admin")}`, "genesys-login", "popup,width=520,height=720")}><LogIn /> Sign in with Genesys</Button></CardContent></Card></div>;

  return (
    <main className="fixed inset-0 min-h-0 overflow-hidden bg-background">
      <Dialog open={reauthDialog.open}>
        <DialogContent
          className="sm:max-w-md [&>button]:hidden"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><CircleAlert className="size-5 text-amber-500" /> Genesys authentication required</DialogTitle>
            <DialogDescription>{reauthDialog.message} Sign in again to continue managing the integration.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => {
              setReauthDialog({ open: false, message: "" });
              setRefreshingInventory(false);
              setInventoryLoading(false);
              setBusy(false);
              setAuth({ loading: false, authenticated: false, error: "Your Genesys Cloud session has expired. Sign in again to continue." });
            }}><LogIn /> Continue to authentication</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PublicOriginDialog
        open={publicOriginOpen}
        onOpenChange={setPublicOriginOpen}
        currentBaseUrl={inventory.publicBaseUrl}
        onCompleted={refreshAfterPublicOriginChange}
      />
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20">
        <header className="flex h-14 shrink-0 items-center border-b bg-background">
          <div className="flex w-full items-center gap-3 px-4 lg:px-6">
            <Image src="/telnyx_green_transparent.png" alt="Telnyx" width={1230} height={329} priority className="h-auto w-28 shrink-0" />
            <div className="h-5 w-px bg-border" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Telnyx integrations for Genesys Cloud</p>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">{inventory.organization?.name} · signed in as {auth.user.userName}</p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <GenesysThemeToggle defaultTheme="light" variant="toolbar" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 bg-background p-0 [&_svg]:size-3.5"
                onClick={() => window.location.reload()}
                aria-label="Reload embedded admin app"
                title="Reload embedded admin app"
              >
                <RefreshCw aria-hidden="true" />
                <span className="sr-only">Reload embedded admin app</span>
              </Button>
            </div>
          </div>
        </header>
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 md:grid md:grid-cols-[var(--section-rail-width)_minmax(0,1fr)]"
          style={{ "--section-rail-width": SECTION_RAIL_WIDTH }}
        >
          <SectionRail
            items={RAIL_ITEMS}
            activeId={selected}
            onSelect={selectComponent}
            ariaLabel="Genesys integration sections"
            className="max-h-[86px] shrink-0 md:max-h-none"
          />
          <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.25rem] border bg-card shadow-sm">
            <CardHeader className="shrink-0 border-b p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2"><SelectedIcon className="size-6 text-telnyx-green" /></div>
                  <div className="min-w-0">
                    <CardTitle className="text-2xl font-bold">{selectedMeta.name}</CardTitle>
                    <CardDescription className="mt-0.5 text-sm">{selectedMeta.description}</CardDescription>
                  </div>
                </div>
                {selected === "dashboard" ? dashboardLoading ? <DashboardHeaderActionsSkeleton /> : <DashboardHeaderActions inventory={inventory} overview={dashboardOverview} refreshing={refreshingInventory} onRefresh={() => void refreshVisibleInventory()} /> : selectedCapacity ? <p className="shrink-0 text-xs font-medium text-muted-foreground">{selectedCapacity.used ?? 0} of {selectedCapacity.total ?? 10} connectors used</p> : null}
              </div>
            </CardHeader>
            <CardContent className={selected === "widget" || selected === "ai" || selected === "tts" ? "min-h-0 flex-1 overflow-hidden p-0" : "min-h-0 flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8"}>
              {selected === "dashboard" && <DashboardPanel overview={dashboardOverview} loading={dashboardLoading} onNavigate={(target, section) => { setSelected(target); if (section) setAiSection(section); }} />}
              {selected === "settings" && <SettingsPanel inventory={inventory} onEditPublicUrl={() => setPublicOriginOpen(true)} />}
              {selected === "widget" && <WidgetAdmin embedded inventory={inventory} onPublished={() => refreshInventory()} />}
              {selected === "tts" && <>{stage === 0 ? <ConfigFields component="tts" config={config} setConfig={setConfig} inventory={inventory} inventoryLoading={inventoryLoading} ttsUiStore={{ previews: ttsPreviews, setPreviews: setTtsPreviews }} /> : <DeploymentBody stage={stage} run={run} />}</>}
              {selected === "ai" && <div className="grid h-full min-h-0 grid-cols-[250px_minmax(0,1fr)]"><AiSectionNavigation activeId={aiSection} onSelect={selectAiSection} /><div className="min-h-0 overflow-y-auto p-5 sm:p-6 lg:p-8">
                {stage > 0 ? <DeploymentBody stage={stage} run={run} /> : aiSection === "assistants" ? <AssistantsPanel inventory={inventory} configs={configs} assistantCatalog={assistantCatalog} onCreate={createAssistant} onCatalogChange={setAssistantCatalog} onOpenRouting={() => setAiSection("inbound")} onOpenCallbacks={() => setAiSection("callbacks")} /> : aiSection === "queues" ? <QueuePoliciesPanel inventory={inventory} policies={queuePolicies} setPolicies={setQueuePolicies} saving={savingQueuePolicies} onSave={() => void saveQueuePolicies()} /> : aiSection === "web-voice" ? <WebVoicePanel key={webVoicePanelKey} inventory={inventory} saving={savingChannelProfile} republishing={republishing} onRepublish={republishWidget} onSave={saveChannelProfile} onOpenWidget={() => setSelected("widget")} /> : aiSection === "messaging" ? <WebChatPanel key={webChatPanelKey} inventory={inventory} onOpenWidget={() => setSelected("widget")} onOpenQueues={() => setAiSection("queues")} /> : aiSection === "inbound" ? <AudioRoutingPanel key={audioRoutingPanelKey} inventory={inventory} saving={savingAudioRouting} onSave={saveAudioRouting} onOpenAssistants={() => setAiSection("assistants")} onPendingEditChange={setHasPendingConfigurationEdit} /> : aiSection === "callbacks" ? <CallbackCampaignPanel key={callbackCampaignPanelKey} inventory={inventory} saving={savingCallbackProfile} campaignStatusSaving={savingCallbackCampaignStatus} onSave={saveCallbackProfile} onSetCampaignEnabled={setCallbackCampaignEnabled} onOpenWidget={() => setSelected("widget")} /> : <ConfigFields component={deploymentComponent} section={aiSection} config={config} setConfig={setConfig} inventory={inventory} inventoryLoading={inventoryLoading} ttsUiStore={{ previews: ttsPreviews, setPreviews: setTtsPreviews }} onNavigate={(target, section) => { setSelected(target); if (section) setAiSection(section); }} />}
              </div></div>}
            </CardContent>
            {deploymentComponent && <CardFooter className="min-h-[76px] shrink-0 border-t bg-card px-5 py-5 sm:px-6 lg:px-8">
              {stage === 0 && <div className="flex w-full flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  {hasPendingConfigurationEdit && <p className="text-sm text-amber-600 dark:text-amber-400">Confirm or cancel the edited DNIS row to continue.</p>}
                  {creatingNewAudioConnector && <p className="text-sm text-muted-foreground">Complete the creation prerequisites above. The connector will be created only after you review and accept the plan.</p>}
                </div>
                <Button className="bg-foreground text-background hover:bg-foreground/90" disabled={configurationPlanDisabled} onClick={createPlan}>
                  {busy || configurationValidationLoading ? <Loader2 className="animate-spin" /> : <Rocket />}
                  {busy ? "Building plan…" : configurationValidationLoading ? "Validating configuration…" : creatingNewAudioConnector ? "Deploy Audio Connector" : "Validate & build plan"}
                  {!busy && !configurationValidationLoading && <ChevronRight />}
                </Button>
              </div>}
              {stage === 1 && run && <div className="flex w-full flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2"><Button className="bg-foreground text-background hover:bg-foreground/90" onClick={() => setStage(0)}><ChevronLeft /> Edit configuration</Button><Button className="bg-foreground text-background hover:bg-foreground/90" disabled={busy} onClick={createPlan}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh plan</Button></div>
                <Button className="bg-foreground text-background hover:bg-foreground/90" disabled={busy || run.plan.summary?.hasChanges === false} onClick={apply}>{busy ? <Loader2 className="animate-spin" /> : run.plan.operation === "destroy" ? <X /> : <Rocket />} {run.plan.operation === "destroy" ? deploymentComponent === "tts" ? "Remove shared organization resources" : "Accept and destroy" : run.plan.operation === "reconcile" ? "Accept and apply changes" : "Accept and deploy"}</Button>
              </div>}
              {stage === 2 && run && <div className="flex w-full items-center justify-between gap-3">
                {!deploymentFinished ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Deployment in progress…</p> : <span />}
                {deploymentFinished && <Button className="bg-foreground text-background hover:bg-foreground/90" onClick={() => { setStage(0); setRun(null); void refreshInventory(); }}>Close</Button>}
              </div>}
            </CardFooter>}
          </Card>
        </div>
      </div>
    </main>
  );
}
