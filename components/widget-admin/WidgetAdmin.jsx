"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Accessibility, AudioWaveform, Bot, Braces, CalendarClock, Check, ChevronsUpDown, Copy, Languages,
  GitBranch, LayoutGrid, Loader2, LogIn, Maximize2, MessageCircleMore, MessagesSquare,
  MousePointerClick, Palette, PanelTop, Paperclip, Pencil, Plus, Send, Settings2, Target,
  UserRoundCheck, Zap,
} from "lucide-react";
import { toast } from "sonner";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import WidgetStudioControls from "@/components/widget-admin/WidgetStudioControls";
import WidgetStudioPreview, { WidgetStudioPreviewToolbar } from "@/components/widget-admin/WidgetStudioPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DEFAULT_WIDGET_CONFIG, isValidWidgetAllowedOrigin } from "@/lib/widgets/config";
import { evaluateWidgetDecisions, previewDecisionContext } from "@/lib/widgets/decisions";
import { getPreviewDevice, normalizePreviewOrientation } from "@/lib/widgets/preview-devices";
import {
  clearGenesysReauthRequired,
  createGenesysAdminApiError,
  GENESYS_REAUTH_REQUIRED_EVENT,
  genesysAuthenticatedFetch,
  shouldShowGenesysApiError,
} from "@/lib/genesys/admin-client-auth";

const NAV_GROUPS = [
  { label: "Setup", items: [
    { id: "general", label: "General", icon: Settings2 },
    { id: "channels", label: "Channels", icon: LayoutGrid },
    { id: "callbacks", label: "Callbacks", icon: CalendarClock },
    { id: "dimensions", label: "Dimensions", icon: Maximize2 },
  ] },
  { label: "Appearance", items: [
    { id: "theme", label: "Theme", icon: Palette },
    { id: "launcher", label: "Launcher / FAB", icon: MousePointerClick },
    { id: "header", label: "Header", icon: PanelTop },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "handoff", label: "Handoff", icon: UserRoundCheck },
    { id: "voice", label: "Voice", icon: AudioWaveform },
    { id: "attachments", label: "Attachments", icon: Paperclip },
  ] },
  { label: "Engagement", items: [
    { id: "targeting", label: "Targeting", icon: Target },
    { id: "triggers", label: "Triggers", icon: Zap },
    { id: "headsup", label: "Heads-up", icon: MessageCircleMore },
    { id: "rules", label: "Rules & decisions", icon: GitBranch },
  ] },
  { label: "Delivery", items: [
    { id: "content", label: "Copy & locale", icon: Languages },
    { id: "accessibility", label: "Accessibility", icon: Accessibility },
    { id: "embed", label: "Embed", icon: Braces },
  ] },
];

async function api(path, options = {}) {
  const response = await genesysAuthenticatedFetch(path, {
    cache: "no-store",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createGenesysAdminApiError(response, body);
  }
  return body;
}

async function streamPublish(path, payload, onProgress) {
  const response = await genesysAuthenticatedFetch(path, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw createGenesysAdminApiError(response, body);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  const processLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress") onProgress(event.progress);
    if (event.type === "result") result = event.result;
    if (event.type === "error") {
      const error = new Error(event.error || "Widget publication failed");
      Object.assign(error, event);
      throw error;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
    if (done) break;
  }
  processLine(buffer);
  if (!result) throw new Error("Widget publication finished without a result");
  return result;
}

function setAtPath(source, path, value) {
  const next = structuredClone(source);
  let target = next;
  for (let index = 0; index < path.length - 1; index += 1) {
    target[path[index]] ??= {};
    target = target[path[index]];
  }
  target[path.at(-1)] = value;
  return next;
}

function EmbedPanel({ snippet, config, handoffSetup }) {
  const contextSnippet = `<script>
  window.TelnyxWidgetContext = {
    "customer.name": "Anna Kowalska",
    "customer.segment": "vip",
    "customer.authenticated": true,
    "routing.queue": "Premium Support"
  };
</script>

${snippet}`;
  const spaContextExample = `window.TelnyxWidget?.setContext({
  "customer.segment": "vip",
  "routing.queue": "Premium Support"
});`;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="border-b px-4 py-4">
        <h2 className="font-semibold">Embed & integration</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Install the published widget, pass page context and inspect its server-managed endpoints.</p>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Embed snippet</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Add this once to the global layout of your website, immediately before the closing <code className="rounded bg-muted px-1 py-0.5">&lt;/body&gt;</code> tag.</p>
          </div>
          <CodeBlock code={snippet} language="html">
            <CodeBlockCopyButton aria-label="Copy embed snippet" title="Copy embed snippet" />
          </CodeBlock>
          <p className="text-xs leading-relaxed text-muted-foreground">The page origin must also be listed under <span className="font-medium text-foreground">Targeting → Allowed embedding origins</span>. Enter an exact origin such as <code className="rounded bg-muted px-1 py-0.5">https://portal.example.com</code>, without a path.</p>
        </section>

        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Where to install it</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Use the location that loads once on every page where the widget should be available.</p>
          </div>
          <div className="grid gap-2 text-xs">
            <div className="rounded-lg border p-3"><p className="font-medium">HTML or CMS</p><p className="mt-1 leading-relaxed text-muted-foreground">Paste it into the global footer, body-end or custom code section before <code>&lt;/body&gt;</code>.</p></div>
            <div className="rounded-lg border p-3"><p className="font-medium">Google Tag Manager</p><p className="mt-1 leading-relaxed text-muted-foreground">Use a Custom HTML tag and an All Pages trigger, or a narrower trigger matching the configured origins and paths.</p></div>
            <div className="rounded-lg border p-3"><p className="font-medium">React or Next.js</p><p className="mt-1 leading-relaxed text-muted-foreground">Load it once from the root layout after the page can access <code>window</code>. Do not add it inside a component rendered repeatedly.</p></div>
          </div>
          <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">Do not embed the loader more than once and do not place it inside an iframe.</p>
        </section>

        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Pass page context</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Set context before the loader to personalize widget copy, visibility, language, opening view and Genesys handoff routing through Rules & decisions.</p>
          </div>
          <CodeBlock code={contextSnippet} language="html">
            <CodeBlockCopyButton aria-label="Copy page context example" title="Copy page context example" />
          </CodeBlock>
          <p className="text-xs leading-relaxed text-muted-foreground">Register every custom key under <span className="font-medium text-foreground">Rules & decisions → Context catalog</span> and select <span className="font-medium text-foreground">Host context</span>. Values are evaluated when the widget starts.</p>
        </section>

        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Update stored context in an SPA</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The API merges new values into the existing host context. Call it before initializing the widget for a new view.</p>
          </div>
          <CodeBlock code={spaContextExample} language="javascript">
            <CodeBlockCopyButton aria-label="Copy SPA context example" title="Copy SPA context example" />
          </CodeBlock>
          <p className="text-xs leading-relaxed text-muted-foreground">Changing stored context does not reconfigure an already mounted widget or alter an active conversation.</p>
        </section>

        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Available context sources</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The widget always provides browser context and can read custom values from the configured source.</p>
          </div>
          <dl className="grid gap-2 text-xs">
            <div className="rounded-lg border p-3"><dt className="font-medium">Built in</dt><dd className="mt-1 break-words leading-relaxed text-muted-foreground"><code>page.path</code>, <code>page.host</code>, <code>page.url</code>, <code>device.type</code> and <code>visitor.locale</code>.</dd></div>
            <div className="rounded-lg border p-3"><dt className="font-medium">Custom sources</dt><dd className="mt-1 leading-relaxed text-muted-foreground">Host context, URL query parameters, cookies or the latest matching value in <code>window.dataLayer</code>.</dd></div>
          </dl>
          <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">Browser context can be modified by the visitor. Never include secrets or use it as proof of identity or authorization.</p>
          <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground"><span className="font-medium text-foreground">Current behavior:</span> context drives widget decisions and routing. It is not forwarded to the Telnyx AI assistant as dynamic variables.</p>
        </section>

        {handoffSetup && config.channels.messaging.enabled && <>
          <section className="space-y-3 border-t pt-5">
            <div><h3 className="text-sm font-semibold">Advanced integration endpoints</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">These server-managed URLs are configured by the integration. Do not call them from customer-side JavaScript.</p></div>
            <div className="space-y-2"><h4 className="text-xs font-medium">Telnyx handoff tool URL</h4><CodeBlock code={handoffSetup.telnyxToolUrl} language="text"><CodeBlockCopyButton aria-label="Copy Telnyx handoff tool URL" title="Copy Telnyx handoff tool URL" /></CodeBlock></div>
            <div className="space-y-2"><h4 className="text-xs font-medium">Genesys outbound webhook URL</h4><CodeBlock code={handoffSetup.genesysOutboundUrl} language="text"><CodeBlockCopyButton aria-label="Copy Genesys outbound webhook URL" title="Copy Genesys outbound webhook URL" /></CodeBlock></div>
          </section>
        </>}
      </div>
    </aside>
  );
}

function WidgetChannelBadges({ widget }) {
  const channels = widget?.draft?.config?.channels;
  const badges = [
    channels?.messaging?.enabled && "Chat",
    channels?.voice?.enabled && "Voice",
  ].filter(Boolean);

  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {badges.length ? badges.map((label) => <Badge key={label} variant="secondary" className="px-1.5 py-0 text-[10px] leading-4">{label}</Badge>) : <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">No channels</Badge>}
      {!widget?.enabled && <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4 text-muted-foreground">Disabled</Badge>}
    </span>
  );
}

function WidgetPicker({ widgets, selectedId, onSelect }) {
  const [open, setOpen] = useState(false);
  const selected = widgets.find((widget) => widget.id === selectedId) || null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label="Select widget configuration" className="h-auto min-h-16 w-full justify-between gap-2 px-3 py-2 text-left font-normal">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{selected?.name || "Select widget"}</span>
            {selected && <span className="mt-1 block"><WidgetChannelBadges widget={selected} /></span>}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="Filter widgets…" />
          <CommandList>
            <CommandEmpty>No widgets found.</CommandEmpty>
            {widgets.map((widget) => (
              <CommandItem key={widget.id} value={widget.id} keywords={[widget.name, widget.id]} onSelect={() => { onSelect(widget); setOpen(false); }} className="items-start py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{widget.name}</span>
                  <span className="mt-1 block"><WidgetChannelBadges widget={widget} /></span>
                </span>
                <Check className={`mt-1 size-4 shrink-0 ${widget.id === selectedId ? "opacity-100" : "opacity-0"}`} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function WidgetAdmin({ embedded = false, inventory = null, onPublished = null }) {
  const [auth, setAuth] = useState({ loading: true, authenticated: false });
  const [loadError, setLoadError] = useState("");
  const [widgets, setWidgets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [name, setNameState] = useState("");
  const [enabled, setEnabledState] = useState(true);
  const [config, setConfig] = useState(null);
  const [section, setSection] = useState("dimensions");
  const [surface, setSurface] = useState("chat");
  const [decisionSimulationRun, setDecisionSimulationRun] = useState(0);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState([]);
  const [assistantChangeReview, setAssistantChangeReview] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [newWidgetOpen, setNewWidgetOpen] = useState(false);
  const [newWidgetName, setNewWidgetName] = useState("Customer service widget");
  const [creating, setCreating] = useState(false);
  const [cloneWidgetOpen, setCloneWidgetOpen] = useState(false);
  const [cloneWidgetName, setCloneWidgetName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [editWidgetOpen, setEditWidgetOpen] = useState(false);
  const [editWidgetName, setEditWidgetName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [reauthPending, setReauthPending] = useState(false);
  const selected = widgets.find((widget) => widget.id === selectedId) || null;
  const infrastructureAllowedOrigins = useMemo(
    () => inventory?.webChatInfrastructure?.allowedOrigins || [],
    [inventory?.webChatInfrastructure?.allowedOrigins]
  );

  const applyWidget = useCallback((widget) => {
    const draftConfig = structuredClone(widget.draft.config);
    if (!draftConfig.allowedOrigins.length && infrastructureAllowedOrigins.length) {
      draftConfig.allowedOrigins = [...infrastructureAllowedOrigins];
    }
    setSelectedId(widget.id);
    setNameState(widget.name);
    setEnabledState(widget.enabled);
    setConfig(draftConfig);
    setSurface(draftConfig.channels.messaging.enabled ? "chat" : "voice");
    setDirty(false);
    setLastSavedAt(null);
    setPublishProgress([]);
    setAssistantChangeReview(null);
  }, [infrastructureAllowedOrigins]);

  const load = useCallback(async () => {
    let session;
    try {
      session = await api("/api/admin/session");
      clearGenesysReauthRequired();
      setReauthPending(false);
      setAuth({ loading: false, authenticated: true, user: session.user });
    } catch (error) {
      setAuth({ loading: false, authenticated: false, error: error.message });
      return;
    }
    try {
      const result = await api("/api/admin/widgets");
      setWidgets(result.widgets);
      setLoadError("");
      if (result.widgets.length) applyWidget(result.widgets.find((item) => item.id === selectedId) || result.widgets[0]);
    } catch (error) {
      setLoadError(error.message);
    }
  }, [applyWidget, selectedId]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onReauthRequired = () => setReauthPending(true);
    window.addEventListener(GENESYS_REAUTH_REQUIRED_EVENT, onReauthRequired);
    return () => window.removeEventListener(GENESYS_REAUTH_REQUIRED_EVENT, onReauthRequired);
  }, []);
  useEffect(() => {
    const onMessage = async (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "genesys-auth-complete") return;
      try {
        await api("/api/auth/finalize", {
          method: "POST",
          body: JSON.stringify({ handoff: event.data.handoff }),
        });
        clearGenesysReauthRequired();
        setReauthPending(false);
        await load();
      } catch (error) {
        setAuth({ loading: false, authenticated: false, error: error.message });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);

  const set = useCallback((path, value) => {
    setConfig((current) => setAtPath(current, path, value));
    setDirty(true);
  }, []);
  const setName = (value) => { setNameState(value); setDirty(true); };
  const setEnabled = (value) => { setEnabledState(value); setDirty(true); };
  const changePreviewDevice = (deviceId) => {
    const device = getPreviewDevice(deviceId);
    setConfig((current) => {
      const next = structuredClone(current);
      next.preview.activeDeviceId = device.id;
      next.preview.orientation = normalizePreviewOrientation(device, next.preview.orientation);
      return next;
    });
    setDirty(true);
  };

  const openCreateDialog = () => {
    setNewWidgetName("Customer service widget");
    setNewWidgetOpen(true);
  };

  const create = async () => {
    const widgetName = newWidgetName.trim();
    if (!widgetName || creating) return;
    setCreating(true);
    try {
      const result = await api("/api/admin/widgets", { method: "POST", body: JSON.stringify({ name: widgetName }) });
      setWidgets((current) => [result.widget, ...current]);
      applyWidget(result.widget);
      setNewWidgetOpen(false);
      toast.success("Widget created");
    } catch (error) { if (shouldShowGenesysApiError(error)) toast.error(error.message); }
    finally { setCreating(false); }
  };

  const openCloneDialog = () => {
    if (!selected) return;
    setCloneWidgetName(`${selected.name} copy`);
    setCloneWidgetOpen(true);
  };

  const clone = async () => {
    const widgetName = cloneWidgetName.trim();
    if (!widgetName || cloning || !selectedId) return;
    setCloning(true);
    try {
      const result = await api("/api/admin/widgets", { method: "POST", body: JSON.stringify({ name: widgetName, cloneFromId: selectedId }) });
      setWidgets((current) => [result.widget, ...current]);
      applyWidget(result.widget);
      setCloneWidgetOpen(false);
      toast.success("Widget cloned");
    } catch (error) { if (shouldShowGenesysApiError(error)) toast.error(error.message); }
    finally { setCloning(false); }
  };

  const openEditDialog = () => {
    if (!selected) return;
    setEditWidgetName(name);
    setEditWidgetOpen(true);
  };

  const renameWidget = async () => {
    const widgetName = editWidgetName.trim();
    if (!widgetName || renaming || !selectedId) return;
    setRenaming(true);
    try {
      const result = await api(`/api/admin/widgets/${selectedId}`, { method: "PATCH", body: JSON.stringify({ name: widgetName, enabled }) });
      setNameState(result.widget.name);
      setWidgets((current) => current.map((item) => item.id === selectedId ? { ...item, ...result.widget } : item));
      setEditWidgetOpen(false);
      toast.success("Widget renamed");
    } catch (error) { if (shouldShowGenesysApiError(error)) toast.error(error.message); }
    finally { setRenaming(false); }
  };

  const save = useCallback(async ({ quiet = false } = {}) => {
    if (!selectedId || !config) return null;
    setSaving(true);
    try {
      await api(`/api/admin/widgets/${selectedId}`, { method: "PATCH", body: JSON.stringify({ name, enabled }) });
      const result = await api(`/api/admin/widgets/${selectedId}/draft`, { method: "PUT", body: JSON.stringify({ config }) });
      const updated = { ...result.widget, name, enabled };
      setWidgets((current) => current.map((item) => item.id === selectedId ? updated : item));
      setDirty(false);
      setLastSavedAt(new Date());
      if (!quiet) toast.success("Draft saved");
      return updated;
    } catch (error) {
      const details = error.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      const validationError = Boolean(error.issues?.length);
      if ((!quiet || !validationError) && shouldShowGenesysApiError(error)) toast.error(details || error.message);
      return null;
    } finally { setSaving(false); }
  }, [config, enabled, name, selectedId]);

  useEffect(() => {
    if (!dirty || !config || saving || reauthPending) return undefined;
    if (config.allowedOrigins.some((origin) => !isValidWidgetAllowedOrigin(origin))) return undefined;
    const timer = window.setTimeout(() => { void save({ quiet: true }); }, 900);
    return () => window.clearTimeout(timer);
  }, [config, dirty, enabled, name, reauthPending, save, saving]);

  const recordPublishProgress = (event) => {
    setPublishProgress((current) => {
      const next = [...current];
      const runningIndex = next.findIndex((entry) => entry.label === event.label && entry.status === "running");
      if (runningIndex >= 0 && event.status !== "running") next[runningIndex] = event;
      else next.push(event);
      return next.slice(-12);
    });
  };

  const completePublish = async ({ approvedToolConflictKeys = [] } = {}) => {
    setPublishing(true);
    setAssistantChangeReview(null);
    try {
      const result = await streamPublish(
        `/api/admin/widgets/${selectedId}/publish`,
        { approvedToolConflictKeys },
        recordPublishProgress
      );
      setWidgets((current) => current.map((item) => item.id === selectedId ? result.widget : item));
      setConfig(structuredClone(result.widget.draft.config));
      if (onPublished) {
        await Promise.resolve(onPublished(result.widget)).catch(() => undefined);
      }
      toast.success(result.publication?.infrastructureSynchronized
        ? `Published revision ${result.widget.published.version}; channel infrastructure synchronized`
        : `Published revision ${result.widget.published.version}; UI configuration is now live`);
    } catch (error) {
      recordPublishProgress({ status: "failure", label: "Publish widget", detail: error.message });
      if (error.code === "assistant_tool_conflict") {
        setAssistantChangeReview({
          assistant: error.assistant,
          conflicts: error.conflicts || [],
        });
        return;
      }
      if (/embedding origin/i.test(error.message)) {
        setSection("targeting");
        toast.error("Add at least one customer website under Targeting → Allowed embedding origins before publishing.");
      } else if (shouldShowGenesysApiError(error)) toast.error(error.message);
    }
    finally { setPublishing(false); }
  };

  const publish = async () => {
    if (publishing) return;
    setPublishProgress([{ status: "running", label: "Save the current widget draft", detail: "" }]);
    const saved = await save({ quiet: true });
    if (!saved) {
      recordPublishProgress({ status: "failure", label: "Save the current widget draft", detail: "Draft could not be saved" });
      return;
    }
    recordPublishProgress({ status: "success", label: "Save the current widget draft", detail: "saved" });
    setPublishing(true);
    recordPublishProgress({ status: "running", label: "Check Telnyx assistant compatibility", detail: "" });
    try {
      const preflight = await api(`/api/admin/widgets/${selectedId}/publish/preflight`, {
        method: "POST",
        body: "{}",
      });
      recordPublishProgress({
        status: "success",
        label: "Check Telnyx assistant compatibility",
        detail: (preflight.conflicts?.length || preflight.changes?.length)
          ? `${(preflight.conflicts?.length || 0) + (preflight.changes?.length || 0)} change(s) require approval`
          : "ready",
      });
      if (preflight.conflicts?.length || preflight.changes?.length) {
        setAssistantChangeReview({
          assistant: preflight.assistant,
          conflicts: preflight.conflicts || [],
          changes: preflight.changes || [],
        });
        return;
      }
    } catch (error) {
      recordPublishProgress({ status: "failure", label: "Check Telnyx assistant compatibility", detail: error.message });
      if (shouldShowGenesysApiError(error)) toast.error(error.message);
      return;
    } finally {
      setPublishing(false);
    }
    await completePublish();
  };

  const resetSection = (targetSection) => {
    const defaults = structuredClone(DEFAULT_WIDGET_CONFIG);
    setConfig((current) => {
      const next = structuredClone(current);
      if (targetSection === "dimensions") {
        next.dimensions = defaults.dimensions;
        next.preview = defaults.preview;
      }
      if (targetSection === "callbacks") next.callbacks = defaults.callbacks;
      if (targetSection === "theme") next.theme = defaults.theme;
      if (targetSection === "launcher") next.components.launcher = defaults.components.launcher;
      if (targetSection === "header") next.components.header = defaults.components.header;
      if (targetSection === "chat") {
        next.components.messages = defaults.components.messages;
        next.components.footer = defaults.components.footer;
        next.avatars = defaults.avatars;
        next.content.assistantTypingMessage = defaults.content.assistantTypingMessage;
        next.content.agentTypingMessage = defaults.content.agentTypingMessage;
        for (const key of ["assistantBubble", "assistantText", "humanBubble", "humanText", "customerBubble", "customerText"]) next.theme.colors[key] = defaults.theme.colors[key];
      }
      if (targetSection === "handoff") {
        next.components.handoff = defaults.components.handoff;
        for (const key of ["handoffWaitingMessage", "handoffAssignedMessage", "handoffConnectedMessage", "handoffFailedMessage"]) {
          next.content[key] = defaults.content[key];
        }
      }
      if (targetSection === "voice") next.components.voice = defaults.components.voice;
      if (targetSection === "attachments") {
        next.components.attachments = defaults.components.attachments;
        next.features.attachmentPolicy = defaults.features.attachmentPolicy;
        next.features.attachmentsAfterHandoff = defaults.features.attachmentsAfterHandoff;
      }
      if (targetSection === "headsup") next.engagement.headsUp = defaults.engagement.headsUp;
      if (targetSection === "triggers") {
        next.engagement.triggers = defaults.engagement.triggers;
        next.engagement.animation = defaults.engagement.animation;
      }
      if (targetSection === "targeting") next.targeting = defaults.targeting;
      if (targetSection === "rules") next.decisions = defaults.decisions;
      if (targetSection === "accessibility") next.features = defaults.features;
      if (targetSection === "content") next.content = defaults.content;
      return next;
    });
    setDirty(true);
    toast.success("Section reset to defaults");
  };

  const decisionContext = useMemo(() => {
    if (!config) return {};
    const device = getPreviewDevice(config.preview.activeDeviceId);
    return previewDecisionContext(config, device.type === "phone" ? "mobile" : device.type);
  }, [config]);
  const decisionResult = useMemo(() => config
    ? evaluateWidgetDecisions(config, decisionContext)
    : null, [config, decisionContext]);
  const previewConfig = config?.preview?.simulateDecisions && decisionResult
    ? decisionResult.config
    : config;

  const runDecisionSimulation = useCallback(() => {
    if (!decisionResult) return;
    setDecisionSimulationRun((value) => value + 1);
    if (!decisionResult.visible) {
      setSurface("launcher");
      toast.info(decisionResult.matchedRule
        ? `“${decisionResult.matchedRule.name}” hides the widget`
        : "The widget is hidden for this context");
      return;
    }
    const requestedSurface = decisionResult.surface;
    const nextSurface = requestedSurface === "launcher"
      ? "launcher"
      : requestedSurface === "voice" && decisionResult.config.channels.voice.enabled
        ? "voice"
        : requestedSurface === "home" && (
            Number(decisionResult.config.channels.messaging.enabled) +
            Number(decisionResult.config.channels.voice.enabled) +
            Number(decisionResult.config.callbacks.enabled)
          ) > 1
          ? "home"
          : decisionResult.config.channels.messaging.enabled ? "chat" : decisionResult.config.channels.voice.enabled ? "voice" : "launcher";
    setSurface(nextSurface);
    toast.success(decisionResult.matchedRule
      ? `Simulating “${decisionResult.matchedRule.name}”`
      : "Simulating default widget behavior");
  }, [decisionResult]);

  useEffect(() => {
    if (!previewConfig) return;
    if (surface === "chat" && !previewConfig.channels.messaging.enabled) setSurface(previewConfig.channels.voice.enabled ? "voice" : "launcher");
    if (surface === "voice" && !previewConfig.channels.voice.enabled) setSurface(previewConfig.channels.messaging.enabled ? "chat" : "launcher");
    if (surface === "callbacks" && !previewConfig.callbacks.enabled) setSurface(previewConfig.channels.messaging.enabled ? "chat" : previewConfig.channels.voice.enabled ? "voice" : "launcher");
    if (surface === "home" && (
      Number(previewConfig.channels.messaging.enabled) +
      Number(previewConfig.channels.voice.enabled) +
      Number(previewConfig.callbacks.enabled)
    ) <= 1) setSurface(previewConfig.callbacks.enabled ? "callbacks" : previewConfig.channels.messaging.enabled ? "chat" : "voice");
  }, [previewConfig, surface]);

  const snippet = useMemo(() => !selected || typeof window === "undefined" ? "" : `<script src="${window.location.origin}/widget/v1/loader.js" data-widget-id="${selected.publicId}" defer></script>`, [selected]);
  const handoffSetup = useMemo(() => {
    if (!selected || !config || typeof window === "undefined") return null;
    const integrationId = config.channels.messaging.genesys.integrationId;
    return {
      telnyxToolUrl: `${window.location.origin}/api/widgets/handoff/messaging`,
      genesysOutboundUrl: integrationId ? `${window.location.origin}/api/webhooks/genesys/open-messaging/${encodeURIComponent(integrationId)}` : "Configured by Infrastructure",
    };
  }, [config, selected]);

  if (auth.loading) return <div className={`grid place-items-center ${embedded ? "h-full min-h-80" : "min-h-screen"}`}><Loader2 className="animate-spin" /></div>;
  if (!auth.authenticated) return <div className={`grid place-items-center p-6 ${embedded ? "min-h-80" : "min-h-screen"}`}><div className="max-w-md rounded-xl border bg-card p-8 text-center shadow-sm"><h1 className="text-xl font-semibold">Telnyx Widget Administration</h1><p className="mt-2 text-sm text-muted-foreground">Authenticate with Genesys Cloud to manage widget configurations.</p>{auth.error && <p className="mt-3 rounded bg-destructive/10 p-2 text-sm text-destructive">{auth.error}</p>}<Button className="mt-5" onClick={() => window.open(`/api/auth/login?popup=1&returnTo=${encodeURIComponent("/genesys/widget-admin")}`, "genesys-login", "popup,width=520,height=720")}><LogIn /> Sign in with Genesys</Button></div></div>;
  if (loadError) return <div className={`grid place-items-center p-6 ${embedded ? "min-h-80" : "min-h-screen"}`}><div className="max-w-md rounded-xl border bg-card p-8 text-center shadow-sm"><h1 className="text-xl font-semibold">Widget configurations could not be loaded</h1><p className="mt-2 text-sm text-muted-foreground">Your Genesys session is active. The widget configuration service returned an error.</p><p className="mt-3 rounded bg-destructive/10 p-2 text-sm text-destructive">{loadError}</p><Button className="mt-5" onClick={() => void load()}>Try again</Button></div></div>;

  return <>
    <main className={`flex min-h-0 w-full flex-col overflow-hidden bg-background ${embedded ? "h-full" : "h-screen"}`}>
      {selected && config ? (
        <>
        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[285px_minmax(480px,1fr)_380px]">
          <div className="flex min-h-0 flex-col border-r bg-muted/15">
            <div className="shrink-0 space-y-2 border-b p-3">
              <WidgetPicker widgets={widgets} selectedId={selectedId} onSelect={applyWidget} />
              <div className="grid grid-cols-3 gap-1.5">
                <Button className="min-w-0 px-2" size="sm" variant="outline" onClick={openCreateDialog}><Plus size={14} /> New</Button>
                <Button className="min-w-0 px-2" size="sm" variant="outline" onClick={openCloneDialog}><Copy size={14} /> Clone</Button>
                <Button className="min-w-0 px-2" size="sm" variant="outline" onClick={openEditDialog}><Pencil size={14} /> Edit</Button>
              </div>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Widget configuration sections">
              {NAV_GROUPS.map((group) => <div key={group.label} className="mb-5"><p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p><div className="grid gap-1">{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" onClick={() => { setSection(item.id); if (["chat", "handoff"].includes(item.id) && config.channels.messaging.enabled) setSurface("chat"); if (item.id === "callbacks" && config.callbacks.enabled) setSurface("callbacks"); }} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${section === item.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}><Icon size={17} /> {item.label}</button>; })}</div></div>)}
            </nav>
          </div>
          <WidgetStudioPreview widget={{ ...selected, name }} config={previewConfig} surface={surface} onSurfaceChange={setSurface} previewScenario={section === "chat" ? "typing" : section === "handoff" ? "handoff" : section === "callbacks" ? "callbacks" : null} previewUser={auth.user} decisionResult={decisionResult} showDecisionOverlay={section === "rules"} simulationRun={decisionSimulationRun} />
          <div className="flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden border-l bg-background">
            <WidgetStudioPreviewToolbar
              config={previewConfig}
              surface={surface}
              onSurfaceChange={setSurface}
              onDeviceChange={changePreviewDevice}
              onOrientationChange={(value) => set(["preview", "orientation"], value)}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              {section === "embed" ? <EmbedPanel snippet={snippet} config={config} handoffSetup={handoffSetup} /> : <WidgetStudioControls widgetId={selectedId} section={section} config={config} name={name} enabled={enabled} assistants={inventory?.telnyxAssistants || []} sipTrunks={inventory?.genesysSipTrunks || []} channelProfiles={inventory?.channelProfiles || []} callbackProfile={inventory?.callbackProfile || null} decisionResult={decisionResult} onRunDecisionSimulation={runDecisionSimulation} setName={setName} setEnabled={setEnabled} set={set} resetSection={resetSection} />}
            </div>
          </div>
        </div>
        <footer className="flex min-h-16 shrink-0 items-center gap-3 border-t bg-background px-4 py-2">
          <div className="min-w-0 flex-1" aria-live="polite" aria-label="Widget publication progress">
            {publishProgress.length ? <div className="grid max-h-16 gap-0.5 overflow-y-auto pr-2">
              {publishProgress.slice(-3).map((entry, index) => <div key={`${entry.label}-${entry.status}-${index}`} className="flex min-w-0 items-center gap-2 text-xs">
                {entry.status === "running" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> : entry.status === "success" ? <Check className="size-3.5 shrink-0 text-emerald-500" /> : <span className="size-2.5 shrink-0 rounded-full bg-destructive" />}
                <span className="truncate font-medium">{entry.label}</span>
                {entry.detail && <span className="truncate text-muted-foreground">— {entry.detail}</span>}
              </div>)}
            </div> : <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">{saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving…</> : dirty ? <>Unsaved changes</> : <><Check className="size-3.5 text-emerald-500" /> {lastSavedAt ? "Draft saved" : "Saved"}</>}</span>}
          </div>
          <Button size="sm" disabled={saving || publishing || !selected} onClick={() => void publish()} title="Make this revision live. Channel infrastructure is synchronized only when its settings changed.">{publishing ? <Loader2 className="animate-spin" /> : <Send size={16} />} {publishing ? "Publishing…" : "Publish"}</Button>
        </footer>
        </>
      ) : <div className="grid flex-1 place-items-center text-sm text-muted-foreground"><div className="text-center"><Bot className="mx-auto mb-3 size-8" /><p>Create a widget to begin.</p><Button className="mt-4" onClick={openCreateDialog}><Plus /> New widget</Button></div></div>}
    </main>
    <Dialog open={Boolean(assistantChangeReview)} onOpenChange={(open) => { if (!open && !publishing) setAssistantChangeReview(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace conflicting Telnyx assistant tools?</DialogTitle>
          <DialogDescription>
            Publishing this widget requires the deployment-managed singleton tools below on {assistantChangeReview?.assistant?.name || assistantChangeReview?.assistant?.id || "the selected assistant"}. Review and confirm the replacements before publishing.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-72 gap-2 overflow-y-auto py-2">
          {(assistantChangeReview?.conflicts || []).map((conflict) => <div key={conflict.key} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{conflict.typeLabel}</Badge><Badge variant="secondary">{conflict.source === "inline" ? "Inline tool" : "Shared tool"}</Badge></div>
            <p className="mt-2 text-sm font-medium">{conflict.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{conflict.source === "inline" ? "The inline definition will be removed from this assistant." : "The shared tool will be detached from this assistant; it will not be deleted from the Tools Library."}</p>
          </div>)}
        </div>
        <p className="text-xs text-muted-foreground">Other assistants and unrelated tools are not changed. These changes are applied only after you confirm.</p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={publishing} onClick={() => setAssistantChangeReview(null)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={publishing} onClick={() => void completePublish({
            approvedToolConflictKeys: (assistantChangeReview?.conflicts || []).map(({ key }) => key),
          })}>{publishing ? <Loader2 className="animate-spin" /> : <Check />} Apply changes and publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={newWidgetOpen} onOpenChange={(open) => { if (!creating) setNewWidgetOpen(open); }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <DialogHeader>
            <DialogTitle>Create new widget</DialogTitle>
            <DialogDescription>Create an independent visual configuration. Channels, appearance and behavior can be customized after creation.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <label className="text-sm font-medium" htmlFor="new-widget-name">Widget name</label>
            <Input id="new-widget-name" autoFocus maxLength={120} value={newWidgetName} onChange={(event) => setNewWidgetName(event.target.value)} placeholder="Customer service widget" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={creating} onClick={() => setNewWidgetOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={creating || !newWidgetName.trim()}>{creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create widget</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={cloneWidgetOpen} onOpenChange={(open) => { if (!cloning) setCloneWidgetOpen(open); }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void clone(); }}>
          <DialogHeader>
            <DialogTitle>Clone widget</DialogTitle>
            <DialogDescription>Copy the complete draft design, behavior, channels and device-specific preview screenshots into an independent widget.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <label className="text-sm font-medium" htmlFor="clone-widget-name">New widget name</label>
            <Input id="clone-widget-name" autoFocus maxLength={120} value={cloneWidgetName} onChange={(event) => setCloneWidgetName(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={cloning} onClick={() => setCloneWidgetOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={cloning || !cloneWidgetName.trim()}>{cloning ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />} Clone widget</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={editWidgetOpen} onOpenChange={(open) => { if (!renaming) setEditWidgetOpen(open); }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void renameWidget(); }}>
          <DialogHeader>
            <DialogTitle>Rename widget</DialogTitle>
            <DialogDescription>Change the administrative name shown in the widget list. The public widget ID stays unchanged.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <label className="text-sm font-medium" htmlFor="edit-widget-name">Widget name</label>
            <Input id="edit-widget-name" autoFocus maxLength={120} value={editWidgetName} onChange={(event) => setEditWidgetName(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={renaming} onClick={() => setEditWidgetOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={renaming || !editWidgetName.trim()}>{renaming ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />} Save name</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
