import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const widgetAdminPath = new URL("../components/widget-admin/WidgetAdmin.jsx", import.meta.url);
const previewPath = new URL("../components/widget-admin/WidgetStudioPreview.jsx", import.meta.url);
const controlsPath = new URL("../components/widget-admin/WidgetStudioControls.jsx", import.meta.url);
const framePath = new URL("../components/widget/WidgetFrame.jsx", import.meta.url);
const handoffTimelinePath = new URL("../components/widget/HandoffTimeline.jsx", import.meta.url);
const loaderPath = new URL("../public/widget/v1/loader.js", import.meta.url);
const adminConsolePath = new URL("../components/admin/AdminConsole.jsx", import.meta.url);
const composePath = new URL("../compose.yaml", import.meta.url);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);
const previewAssetRoutePath = new URL("../app/api/admin/widgets/[id]/preview-background/route.js", import.meta.url);
const notificationsMonitorPath = new URL("../components/genesys-notifications/GenesysNotificationsMonitor.jsx", import.meta.url);
const publishRoutePath = new URL("../app/api/admin/widgets/[id]/publish/route.js", import.meta.url);
const publishPreflightRoutePath = new URL("../app/api/admin/widgets/[id]/publish/preflight/route.js", import.meta.url);
const voiceRoutingRoutePath = new URL("../app/api/admin/widgets/[id]/voice-routing/route.js", import.meta.url);
const widgetManagementScriptPath = new URL("../scripts/manage-genesys-widget.mjs", import.meta.url);
const widgetStorePath = new URL("../lib/widgets/store.js", import.meta.url);
const inventoryRoutePath = new URL("../app/api/admin/inventory/route.js", import.meta.url);
const adminAuthPath = new URL("../lib/genesys/admin-auth.js", import.meta.url);

test("application dropdowns consistently use the shared shadcn Select component", async () => {
  const roots = [new URL("../app/", import.meta.url), new URL("../components/", import.meta.url)];
  const nativeSelects = [];

  for (const root of roots) {
    const entries = await readdir(root, { recursive: true });
    for (const entry of entries.filter((name) => /\.[cm]?[jt]sx?$/.test(name))) {
      const file = new URL(entry, root);
      const source = await readFile(file, "utf8");
      if (/<select\b/.test(source)) nativeSelects.push(file.pathname);
    }
  }

  assert.deepEqual(nativeSelects, []);

  const [controls, notifications] = await Promise.all([
    readFile(controlsPath, "utf8"),
    readFile(notificationsMonitorPath, "utf8"),
  ]);
  assert.match(controls, /from "@\/components\/ui\/select"/);
  assert.match(notifications, /from "@\/components\/ui\/select"/);
});

test("Genesys admin locks document scrolling and sizes its workspace to the embedded viewport", async () => {
  const source = await readFile(adminConsolePath, "utf8");
  assert.match(source, /root\.style\.overflow = "hidden"/);
  assert.match(source, /body\.style\.overflow = "hidden"/);
  assert.match(source, /<main className="fixed inset-0 min-h-0 overflow-hidden bg-background">/);
  assert.match(source, /<div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted\/20">/);
  assert.doesNotMatch(source, /<main className="h-screen/);
});

test("Genesys admin uses shadcn skeletons while application and dashboard data load", async () => {
  const source = await readFile(adminConsolePath, "utf8");
  assert.match(source, /import \{ Skeleton \} from "@\/components\/ui\/skeleton"/);
  assert.match(source, /function AdminConsoleLoadingSkeleton\(\)/);
  assert.match(source, /function DashboardPanelSkeleton\(\)/);
  assert.match(source, /function DashboardHeaderActionsSkeleton\(\)/);
  assert.match(source, /if \(auth\.loading\) return <AdminConsoleLoadingSkeleton \/>/);
  assert.match(source, /aria-label="Loading administration application"/);
  assert.match(source, /aria-label="Loading dashboard data"/);
  assert.match(source, /<DashboardPanel overview=\{dashboardOverview\} loading=\{dashboardLoading\}/);
});

test("Callback form and scheduling policy belong to the versioned widget configuration", async () => {
  const [admin, studio, controls, preview, frame, loader, callbackRoute] = await Promise.all([
    readFile(adminConsolePath, "utf8"),
    readFile(widgetAdminPath, "utf8"),
    readFile(controlsPath, "utf8"),
    readFile(previewPath, "utf8"),
    readFile(framePath, "utf8"),
    readFile(loaderPath, "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/callbacks/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /function CallbackCampaignPanel/);
  assert.match(admin, /Customer-facing form and scheduling remain versioned with each widget/);
  assert.doesNotMatch(admin, /aria-label="Callback assistant type"/);
  assert.doesNotMatch(admin, /aria-label=\{`Callback topic \$\{index \+ 1\} key`\}/);
  assert.match(studio, /id: "callbacks", label: "Callbacks"/);
  assert.match(controls, /Section title="Callback form"/);
  assert.match(controls, /Section title="Scheduling policy"/);
  assert.match(controls, /aria-label=\{`Callback topic \$\{index \+ 1\} key`\}/);
  assert.match(controls, /aria-label=\{`Callback topic \$\{index \+ 1\} label`\}/);
  assert.match(controls, /Maximum callbacks per slot/);
  assert.match(controls, /Availability start/);
  assert.match(preview, /onSurfaceChange\("callbacks"\)/);
  assert.match(preview, /config\.callbacks\.copy\.buttonLabel/);
  assert.match(frame, /type="date"/);
  assert.match(frame, /Available \{callbackConfig\.scheduleStepMinutes\}-minute slots/);
  // Controls carry the widget theme; without it they rendered as bare text.
  assert.match(frame, /const fieldStyle = \{[\s\S]*?borderColor: config\.theme\.colors\.border/);
  assert.match(frame, /backgroundColor: config\.theme\.colors\.inputBackground/);
  assert.match(frame, /const Label = \(\{ children, required/);
  assert.doesNotMatch(frame, /type="datetime-local"/);
  assert.match(loader, /widget\.callbacks && widget\.callbacks\.enabled/);
  assert.doesNotMatch(loader, /config\.callbacks/);
  assert.match(loader, /var soleAction = callbacks \? "callbacks" : voice \? "voice" : "messaging"/);
  assert.match(loader, /triggers\.autoOpen\.surface === "home"[\s\S]*?openPanel\(soleAction\)/);
  assert.match(callbackRoute, /callbackSlotCounts/);
  assert.match(callbackRoute, /firstAvailableCallbackSlot/);
  assert.match(callbackRoute, /The selected callback time is no longer available/);
});

test("widget navigation keeps callbacks on Home and makes Home and Close work in preview and runtime", async () => {
  const [frame, voice, preview, loader] = await Promise.all([
    readFile(framePath, "utf8"),
    readFile(new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url), "utf8"),
    readFile(previewPath, "utf8"),
    readFile(loaderPath, "utf8"),
  ]);
  assert.doesNotMatch(frame, /setCallbackOpen\(\(current\) => !current\)/);
  assert.doesNotMatch(frame, /callbackConfig\.copy\.backToChatLabel/);
  assert.doesNotMatch(frame, /callbackConfig\.copy\.successBackLabel/);
  assert.match(frame, /disabled=\{status === "submitting" \|\| !form\.consentPhone\}/);
  assert.match(frame, /aria-label=\{ui\.aria\.home\}/);
  assert.match(frame, /onPreviewClose\?\.\(\)/);
  assert.match(frame, /onPreviewHome\?\.\(\)/);
  assert.match(voice, /aria-label=\{ui\.aria\.home\}/);
  assert.match(preview, /onPreviewClose=\{\(\) => onSurfaceChange\("launcher"\)\}/);
  assert.match(preview, /onPreviewHome=\{\(\) => onSurfaceChange\("home"\)\}/);
  assert.match(loader, /telnyx-widget-home/);
  assert.match(loader, /closeFrame\(\)/);
});

test("published widget navigates to its own home surface instead of closing the panel", async () => {
  const [frame, loader] = await Promise.all([
    readFile(framePath, "utf8"),
    readFile(loaderPath, "utf8"),
  ]);
  assert.match(frame, /function HomeSurface\(/);
  assert.match(frame, /payload\?\.widget\?\.callbacks\?\.enabled && "callbacks"/);
  assert.match(frame, /if \(surfaces\.length > 1\) \{\s*setRuntimeSurface\("home"\);/);
  assert.match(frame, /mode === "home"\s*\?\s*<HomeSurface/);
  assert.match(frame, /\{\(previewWidget \|\| \(surfaces\.length > 1 && mode !== "home"\)\) && \(/);
  // Voice can be reached from the home surface, so the panel always carries the grant.
  assert.match(loader, /frame\.allow = voice \? "microphone" : ""/);
});

test("the launcher opens the panel on its home surface instead of a launcher dropdown", async () => {
  const loader = await readFile(loaderPath, "utf8");
  assert.match(loader, /var defaultAction = availableActionCount > 1 \? "home" : soleAction;/);
  assert.match(loader, /else openPanel\(defaultAction\);/);
  assert.match(loader, /triggers\.autoOpen\.surface === "home"\)\s*\{\s*openPanel\(defaultAction\);/);
  // "home" is a panel surface rather than a channel, so it skips the channel check.
  assert.match(loader, /mode === "home"\s*\?\s*true/);
  assert.doesNotMatch(loader, /class="menu"|menu\.classList|role", "menuitem/);
  assert.doesNotMatch(loader, /aria-expanded/);
});

test("the embed snippet mounts a single launcher that hides while the panel is open", async () => {
  const loader = await readFile(loaderPath, "utf8");
  assert.match(loader, /if \(document\.getElementById\(rootId\)\) return;/);
  assert.match(loader, /wrap\.style\.display = "none"/);
  assert.match(loader, /wrap\.style\.display = "flex"/);
});

test("the chat transcript opens with the assistant greeting and keeps its original order", async () => {
  const [frame, messaging, sessionRoute] = await Promise.all([
    readFile(framePath, "utf8"),
    readFile(new URL("../lib/telnyx/widget-messaging.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/sessions/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(messaging, /export async function getTelnyxAssistantGreeting/);
  assert.match(
    messaging,
    /\.sort\(\(left, right\) => new Date\(left\.createdAt\)\.getTime\(\) - new Date\(right\.createdAt\)\.getTime\(\)\)/
  );
  assert.match(messaging, /function stableMessageId\(/);
  assert.doesNotMatch(messaging, /randomUUID/);
  assert.match(sessionRoute, /greeting: await messagingGreeting\(widget, /);
  assert.match(sessionRoute, /return widget\.config\.content\.welcomeMessage;/);
  assert.match(frame, /setGreeting\(String\(result\.greeting \|\| ""\)\)/);
  // The configured copy must never flash before the assistant greeting arrives.
  assert.match(frame, /const openingMessage = previewWidget \? config\.content\.welcomeMessage : greeting;/);
  assert.match(frame, /\{openingMessage && \(/);
});

test("voice shows only streamed agent messages and reports call status above the controls", async () => {
  const [voice, preview, controls] = await Promise.all([
    readFile(new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url), "utf8"),
    readFile(previewPath, "utf8"),
    readFile(controlsPath, "utf8"),
  ]);
  // startConversation needs a completed login, which connect() does not await.
  assert.match(voice, /function waitForAgentReady\(/);
  assert.match(voice, /await waitForAgentReady\(client\);/);
  assert.match(voice, /client\.on\("agent\.login\.success", onReady\)/);
  // Telnyx WebRTC rejects the "main" placeholder as a target_version_id.
  assert.match(voice, /assistantVersionId && assistantVersionId !== "main" \? \{ versionId: assistantVersionId \} : \{\}/);
  // The status badge moved out of the header, where it overlapped the title.
  assert.doesNotMatch(voice, /max-w-36 truncate/);
  // Session state sits on the left, the agent's conversation state on the right.
  assert.match(voice, /statusBadge\.enabled && \(\s*<div className="mb-3 flex items-center justify-between gap-2 px-1">/);
  assert.match(controls, /label="Show call status"/);
  // No configured welcome copy in voice, and none above the home options.
  assert.doesNotMatch(voice, /config\.content\.welcomeMessage/);
  assert.doesNotMatch(preview, /config\.content\.welcomeMessage/);
});

test("publishing a voice widget lets the assistant accept anonymous browser calls", async () => {
  const installer = await readFile(new URL("../scripts/manage-genesys-widget.mjs", import.meta.url), "utf8");
  assert.match(installer, /export async function ensureTelnyxAssistantUnauthenticatedWebCalls/);
  assert.match(installer, /supports_unauthenticated_web_calls: true/);
  // Already-granted assistants must not be updated, since each update adds a version.
  assert.match(installer, /if \(telephonySettings\.supports_unauthenticated_web_calls === true\)/);
  assert.match(
    installer,
    /config\.channels\.voice\.enabled\s*\?\s*await ensureTelnyxAssistantUnauthenticatedWebCalls\(\{ telnyx, assistantId, onProgress \}\)/
  );
});

test("Callback campaign exposes confirmed runtime control and live Contact List counts", async () => {
  const [admin, statusRoute, inventoryRoute] = await Promise.all([
    readFile(adminConsolePath, "utf8"),
    readFile(new URL("../app/api/admin/ai/callback-campaign/status/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/inventory/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /Enable campaign/);
  assert.match(admin, /Running/);
  assert.match(admin, /Stopped/);
  assert.match(admin, /callable.*all records/);
  assert.match(admin, /<CardTitle>Last deployed resources<\/CardTitle>/);
  assert.match(admin, /resources\.map\(\(\{ label, resource, detail, icon \}\) => <InfrastructureTile/);
  assert.match(admin, /Live Genesys state for the resources created by the latest successful Callback Campaign deployment/);
  assert.match(admin, /Start callback campaign\?/);
  assert.match(admin, /Stop callback campaign\?/);
  assert.match(statusRoute, /setCallbackCampaignEnabled/);
  assert.match(statusRoute, /requireSameOrigin\(request\)/);
  assert.match(inventoryRoute, /postOutboundContactlistfiltersPreview/);
  assert.match(inventoryRoute, /callbackContactListRecordCounts/);
});

test("Settings uses the full available content width", async () => {
  const admin = await readFile(adminConsolePath, "utf8");
  const settingsPanel = admin.slice(
    admin.indexOf("function SettingsPanel"),
    admin.indexOf("function AiSectionNavigation")
  );
  assert.match(settingsPanel, /return <div className="w-full space-y-6">/);
  assert.doesNotMatch(settingsPanel, /max-w-5xl|mx-auto/);
});

test("widget studio uses custom creation and selection controls", async () => {
  const source = await readFile(widgetAdminPath, "utf8");
  assert.doesNotMatch(source, /window\.prompt|<select/);
  assert.match(source, /<Dialog open=\{newWidgetOpen\}/);
  assert.match(source, /<DialogTitle>Create new widget<\/DialogTitle>/);
  assert.match(source, /<Dialog open=\{cloneWidgetOpen\}/);
  assert.match(source, /<DialogTitle>Clone widget<\/DialogTitle>/);
  assert.match(source, /<Dialog open=\{editWidgetOpen\}/);
  assert.match(source, /<DialogTitle>Rename widget<\/DialogTitle>/);
  assert.match(source, /function WidgetPicker/);
  assert.match(source, /<CommandInput placeholder="Filter widgets…"/);
  assert.match(source, /channels\?\.messaging\?\.enabled && "Chat"/);
  assert.match(source, /channels\?\.voice\?\.enabled && "Voice"/);
  assert.match(source, /<Plus size=\{14\} \/> New/);
  assert.match(source, /<Copy size=\{14\} \/> Clone/);
  assert.match(source, /<Pencil size=\{14\} \/> Edit/);
  assert.match(source, /cloneFromId: selectedId/);
});

test("widget channels share one widget-owned assistant while Web Calls transport stays shared", async () => {
  const [source, inventoryRoute, voiceRoutingRoute, managementScript] = await Promise.all([
    readFile(controlsPath, "utf8"),
    readFile(inventoryRoutePath, "utf8"),
    readFile(voiceRoutingRoutePath, "utf8"),
    readFile(widgetManagementScriptPath, "utf8"),
  ]);
  assert.match(source, /function AssistantPicker/);
  assert.match(source, /This widget revision owns one AI assistant for all enabled channels/);
  assert.match(source, /channelProfiles = \[\]/);
  assert.match(source, /label="Widget AI assistant"/);
  assert.match(source, /set\(\["channels", "messaging", "assistantId"\]/);
  assert.match(source, /set\(\["channels", "voice", "assistantId"\]/);
  assert.doesNotMatch(source, /label="Widget SIP route"/);
  assert.match(source, /label="Genesys BYOC trunk"/);
  assert.match(source, /profileTrunk/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ trunkId: config\.channels\.voice\.genesysTrunkId \}\)/);
  assert.doesNotMatch(source, /label="Voice AI assistant"/);
  assert.doesNotMatch(source, /label="Assistant version"/);
  assert.doesNotMatch(source, /voiceProfile\?\.config\?\.assistantVersionId/);
  assert.doesNotMatch(source, /voice-routing/);
  assert.match(source, /Every enabled channel uses the assistant selected above/);
  assert.match(inventoryRoute, /listAdminComponentConfigs/);
  assert.match(inventoryRoute, /storedAudioComponent\?\.enabled/);
  assert.match(inventoryRoute, /storedAudioComponent\.config\?\.routes/);
  assert.match(inventoryRoute, /assistants\.versions\.list/);
  assert.match(inventoryRoute, /version_created_at/);
  assert.match(inventoryRoute, /loadGenesysSipInventory/);
  assert.match(inventoryRoute, /resolveGenesysByocTrunk/);
  assert.match(inventoryRoute, /genesysSipTrunks/);
  assert.match(voiceRoutingRoute, /body\.trunkId/);
  assert.match(voiceRoutingRoute, /reservePublishedWidgetVoiceRouting/);
  assert.match(managementScript, /selectWidgetVoiceTrunk/);
  assert.match(managementScript, /WIDGET_VOICE_DID_NAMESPACE_START/);
  assert.match(managementScript, /WIDGET_VOICE_DID_NAMESPACE_END/);
  assert.match(managementScript, /buildGenesysSipUri/);
});

test("widget publish derives channel bindings from central profiles and dedicated messaging resources from shared Infrastructure", async () => {
  const [route, preflightRoute, store, managementScript] = await Promise.all([
    readFile(publishRoutePath, "utf8"),
    readFile(publishPreflightRoutePath, "utf8"),
    readFile(widgetStorePath, "utf8"),
    readFile(widgetManagementScriptPath, "utf8"),
  ]);
  assert.match(route, /readWidgetInfrastructureManifest/);
  assert.match(route, /baseIntegrationId/);
  assert.match(route, /applyWidgetInfrastructure/);
  assert.match(route, /listAdminWidgetChannelProfiles/);
  assert.match(route, /applyAdminWidgetChannelProfiles/);
  assert.match(route, /infrastructure\?\.messaging\?\.allowedOrigins/);
  assert.match(route, /assertPublishableWidgetConfig\(publishConfig\)/);
  assert.match(route, /queues: messagingQueues/);
  assert.match(route, /defaultQueue: messagingDefaultQueue/);
  assert.match(route, /queues: voiceQueues/);
  assert.match(route, /reservePublishedWidgetVoiceRouting/);
  assert.match(route, /ensurePublishedWidgetVoiceRouting/);
  assert.match(route, /reconcilePublishedWidgetAssistantToolConflicts/);
  assert.match(route, /approvedToolConflictKeys/);
  assert.doesNotMatch(route, /reconcilePublishedWidgetAssistantMessagingRequirements/);
  assert.doesNotMatch(route, /approvedAssistantChangeKeys/);
  assert.doesNotMatch(preflightRoute, /inspectPublishedWidgetAssistantMessagingRequirements/);
  assert.match(managementScript, /Ensure the installation Telnyx Insights Group and webhook/);
  assert.match(managementScript, /data_retention: true/);
  assert.match(managementScript, /pii_redaction: "disabled"/);
  assert.doesNotMatch(preflightRoute, /!infrastructureSyncReason \|\| !config\.channels\.voice\.enabled/);
  assert.match(route, /application\/x-ndjson/);
  assert.match(route, /widgetInfrastructureSyncReason/);
  assert.match(route, /synchronizeInfrastructure && messagingEnabled/);
  assert.match(route, /reservedRouting: reservedVoiceRouting/);
  assert.match(managementScript, /reserved = reservedRouting \|\| await reservePublishedWidgetVoiceRouting/);
  assert.match(route, /infrastructureSynchronized: synchronizeInfrastructure/);
  assert.match(route, /updateWidgetDraft/);
  assert.match(route, /voiceRouting/);
  assert.match(store, /applyWidgetInfrastructure\(draft\.config/);
  assert.match(store, /infrastructure_fingerprint=COALESCE/);
});

test("widget studio dedicates the center column to preview and the right column to preview controls", async () => {
  const [studio, preview] = await Promise.all([
    readFile(widgetAdminPath, "utf8"),
    readFile(previewPath, "utf8"),
  ]);
  assert.match(studio, /xl:grid-cols-\[285px_minmax\(480px,1fr\)_380px\]/);
  assert.match(studio, /<WidgetPicker[\s\S]{0,220}<div className="grid grid-cols-3 gap-1\.5">/);
  assert.match(studio, /<WidgetStudioPreviewToolbar[\s\S]{0,700}<WidgetStudioControls/);
  assert.match(studio, /<footer className="flex min-h-16 shrink-0 items-center gap-3/);
  assert.match(studio, /aria-label="Widget publication progress"/);
  assert.match(studio, /streamPublish/);
  assert.match(studio, /Replace conflicting Telnyx assistant tools\?/);
  assert.match(studio, /Apply changes and publish/);
  assert.doesNotMatch(studio, /approvedAssistantChangeKeys/);
  assert.doesNotMatch(studio, /setToolConflictReview|toolConflictReview/);
  assert.doesNotMatch(studio, /> Save<\/Button>/);
  assert.match(studio, /setSection\("targeting"\)/);
  assert.match(studio, /infrastructureAllowedOrigins/);
  assert.match(studio, /Allowed embedding origins before publishing/);
  assert.match(preview, /export function WidgetStudioPreviewToolbar/);
  assert.doesNotMatch(preview, /flex flex-wrap items-center justify-between gap-2 border-b bg-background/);
  assert.match(preview, /aria-label="Safari browser preview"/);
  assert.match(preview, /const activePosition = launcherSurface \? config\.dimensions\.launcherPosition : config\.dimensions\.panelPosition/);
  assert.match(preview, /paddingBottom: (?:fullscreenPhone \? 0 : )?activeOffsetY/);
  assert.match(preview, /height: "100%"/);
  assert.match(preview, /onClick=\{\(\) => onSurfaceChange\("launcher"\)\}/);
  assert.match(preview, /paddingRight: leftAligned \? 24 : activeOffsetX/);
  assert.match(preview, /paddingLeft: leftAligned \? activeOffsetX : 24/);
  assert.match(studio, /<aside className="flex h-full min-h-0 w-full flex-col bg-background">/);
});

test("widget embed panel documents installation and context APIs with copyable highlighted examples", async () => {
  const studio = await readFile(widgetAdminPath, "utf8");
  assert.match(studio, /import \{ CodeBlock, CodeBlockCopyButton \} from "@\/components\/ai-elements\/code-block"/);
  assert.match(studio, /immediately before the closing/);
  assert.match(studio, /<CodeBlock code=\{snippet\} language="html">/);
  assert.match(studio, /Where to install it/);
  assert.match(studio, /Google Tag Manager/);
  assert.match(studio, /<CodeBlock code=\{contextSnippet\} language="html">/);
  assert.match(studio, /Rules & decisions → Context catalog/);
  assert.match(studio, /<CodeBlock code=\{spaContextExample\} language="javascript">/);
  assert.match(studio, /Changing stored context does not reconfigure an already mounted widget/);
  assert.match(studio, /Browser context can be modified by the visitor/);
  assert.match(studio, /It is not forwarded to the Telnyx AI assistant as dynamic variables/);
  assert.match(studio, /Advanced integration endpoints/);
});

test("targeting list fields preserve new lines while storing normalized arrays", async () => {
  const controls = await readFile(controlsPath, "utf8");
  assert.match(controls, /function LineListField/);
  assert.match(controls, /const \[draft, setDraft\] = useState\(serializedValue\)/);
  assert.match(controls, /serializedValue !== lastSerializedValue/);
  assert.match(controls, /setDraft\(event\.target\.value\)/);
  assert.match(controls, /onChange\(parseLineList\(event\.target\.value\)\)/);
  assert.equal((controls.match(/<LineListField(?:\s|>)/g) || []).length, 3);
  assert.match(controls, /validate=\{isValidWidgetAllowedOrigin\}/);
  assert.match(controls, /Incorrect format\. Use an exact HTTP\(S\) origin/);
  assert.match(controls, /aria-invalid=\{invalid\}/);
});

test("invalid allowed origins pause autosave and show an inline warning instead of validation toasts", async () => {
  const studio = await readFile(widgetAdminPath, "utf8");
  assert.match(studio, /config\.allowedOrigins\.some\(\(origin\) => !isValidWidgetAllowedOrigin\(origin\)\)/);
  assert.match(studio, /\(!quiet \|\| !validationError\)/);
});

test("widget panel and launcher have independent placement controls shared by preview and embed runtime", async () => {
  const [controls, preview, loader] = await Promise.all([
    readFile(controlsPath, "utf8"),
    readFile(previewPath, "utf8"),
    readFile(loaderPath, "utf8"),
  ]);
  assert.match(controls, /title="Widget panel placement"/);
  assert.match(controls, /dimensions\.panelOffsetX/);
  assert.match(controls, /title="Launcher \/ FAB placement"/);
  assert.match(controls, /dimensions\.launcherOffsetX/);
  assert.match(preview, /launcherSurface \? config\.dimensions\.launcherOffsetX : config\.dimensions\.panelOffsetX/);
  assert.match(loader, /dimensions\.launcherOffsetY/);
  assert.match(loader, /dimensions\.panelOffsetY/);
  assert.match(loader, /launcherSide/);
  assert.match(loader, /panelSide/);
  assert.match(controls, /title="Preview page background"/);
  assert.match(controls, /activePreviewBackground\.backgroundImageUrl/);
  assert.match(controls, /previewVariantKey/);
  assert.match(controls, /set\(\["preview", "backgrounds"\], \{/);
  assert.match(controls, /function ScreenshotField/);
  assert.match(controls, /Screenshot uploaded for this preview/);
  assert.match(controls, /onDragEnter=/);
  assert.match(controls, /Choose from computer/);
  assert.match(controls, /onDrop=\{dropFile\}/);
  assert.match(preview, /Screenshot could not be loaded/);
  assert.match(preview, /No screenshot uploaded for this device and orientation/);
  assert.match(preview, /backgroundPosition: `center \$\{preview\.backgroundPosition\}`/);
});

test("uploaded preview screenshots use an authenticated widget-scoped persistent Docker volume", async () => {
  const [controls, studio, compose, dockerfile, route] = await Promise.all([
    readFile(controlsPath, "utf8"),
    readFile(widgetAdminPath, "utf8"),
    readFile(composePath, "utf8"),
    readFile(dockerfilePath, "utf8"),
    readFile(previewAssetRoutePath, "utf8"),
  ]);
  assert.match(studio, /<WidgetStudioControls widgetId=\{selectedId\}/);
  assert.match(controls, /preview-background\?variant=\$\{encodeURIComponent\(variantKey\)\}/);
  assert.match(compose, /widget_asset_data:\/app\/\.widget-assets/);
  assert.match(compose, /widget_asset_data:/);
  assert.match(dockerfile, /\/app\/\.widget-assets/);
  assert.match(route, /requireWidgetAdmin/);
  assert.match(route, /requireSameOrigin/);
  assert.match(route, /writeWidgetPreviewAsset/);
});

test("admin session explicitly expands the signed-in Genesys user profile images", async () => {
  const adminAuth = await readFile(adminAuthPath, "utf8");
  assert.match(adminAuth, /\/api\/v2\/users\/me\?expand=organization&expand=images/);
  assert.match(adminAuth, /\/api\/v2\/users\/\$\{encodeURIComponent\(user\.id\)\}\?expand=images/);
  assert.match(adminAuth, /\/api\/admin\/session\/profile-image\?user=/);
});

test("decision rules use one searchable dropdown while preserving the rule card presentation", async () => {
  const source = await readFile(new URL("../components/widget-admin/RulesDecisionBuilder.jsx", import.meta.url), "utf8");
  assert.match(source, /function DecisionRuleCard/);
  assert.match(source, /aria-label="Select decision rule"/);
  assert.match(source, /<CommandInput placeholder="Search rules…"/);
  assert.match(source, /w-\[var\(--radix-popover-trigger-width\)\]/);
});

test("preview offers polished device presets, orientation switching and phone-only fullscreen behavior", async () => {
  const [studio, preview, frame, voiceFrame] = await Promise.all([
    readFile(widgetAdminPath, "utf8"),
    readFile(previewPath, "utf8"),
    readFile(framePath, "utf8"),
    readFile(new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(preview, /PREVIEW_DEVICES\.map/);
  assert.match(preview, /<SelectTrigger[^>]*aria-label="Preview device"/);
  assert.match(preview, /function OrientationSwitchIcon/);
  assert.match(preview, /<OrientationSwitchIcon orientation=\{viewport\.orientation\}/);
  assert.doesNotMatch(preview, /<SelectValue/);
  assert.match(preview, /function SignalBars/);
  assert.match(preview, /function BatteryStatus/);
  assert.match(preview, /function readableForeground/);
  assert.doesNotMatch(preview, /mix-blend-difference/);
  assert.match(preview, /function previewSafeArea/);
  assert.match(preview, /CSS px · DPR/);
  assert.match(preview, /function DeviceFrame/);
  assert.match(preview, /Dynamic Island|iphone-island/);
  assert.match(preview, /const fullscreenPhone = device\.type === "phone" && config\.behavior\.mobileFullscreen/);
  assert.match(preview, /const panelWidth =[^\n]+fullscreenPhone \? viewport\.width/);
  assert.match(preview, /const panelHeight =[^\n]+fullscreenPhone \? viewport\.height/);
  assert.match(preview, /paddingBottom: fullscreenPhone \? 0 : Math\.max\(activeOffsetY, safeArea\.bottom\)/);
  assert.match(preview, /edgeInsets: safeArea/);
  assert.match(preview, /edgeToEdge: fullscreenPhone/);
  assert.doesNotMatch(preview, /fullscreenPhone && safeArea\.(?:top|bottom) > 0/);
  assert.match(frame, /minHeight: config\.dimensions\.headerHeight \+ edgeInsets\.top/);
  assert.match(frame, /minHeight: config\.dimensions\.footerHeight \+ edgeInsets\.bottom/);
  assert.match(frame, /borderRadius: previewWidget\?\.edgeToEdge \? 0 : config\.theme\.shape\.panelRadius/);
  assert.match(voiceFrame, /borderRadius: widget\.edgeToEdge \? 0 : config\.theme\.shape\.panelRadius/);
  assert.match(studio, /onDeviceChange=\{changePreviewDevice\}/);
  assert.match(studio, /onOrientationChange=\{\(value\) => set\(\["preview", "orientation"\], value\)\}/);
});

test("handoff phases and composer spacing are configurable and reflected in preview", async () => {
  const [studio, controls, preview, frame, timeline] = await Promise.all([
    readFile(widgetAdminPath, "utf8"),
    readFile(controlsPath, "utf8"),
    readFile(previewPath, "utf8"),
    readFile(framePath, "utf8"),
    readFile(handoffTimelinePath, "utf8"),
  ]);
  assert.match(studio, /id: "handoff", label: "Handoff"/);
  assert.match(studio, /section === "chat" \? "typing" : section === "handoff" \? "handoff"/);
  assert.match(controls, /Show transfer \/ waiting message/);
  assert.match(controls, /Show agent assigned message/);
  assert.match(controls, /Show agent connected message/);
  assert.match(controls, /<RangeField label="Corner radius" value=\{config\.components\.handoff\.radius\} min=\{0\} max=\{32\}/);
  assert.match(controls, /Tools to message input gap/);
  assert.match(preview, /previewScenario=\{surface === "callbacks" \? "callbacks" : previewScenario\}/);
  assert.match(frame, /import HandoffTimeline from "\.\/HandoffTimeline"/);
  assert.match(timeline, /export default function HandoffTimeline/);
  assert.match(frame, /previewAll=\{Boolean\(previewHandoff\)\}/);
  assert.match(frame, /footer\.utilityButtonGap/);
  assert.match(frame, /footer\.utilityInputGap/);
  assert.match(frame, /footer\.inputSendGap/);
});

test("assistant replies use a configurable thinking badge with localized rotating messages", async () => {
  const [studio, controls, frame, config, locales] = await Promise.all([
    readFile(widgetAdminPath, "utf8"),
    readFile(controlsPath, "utf8"),
    readFile(framePath, "utf8"),
    readFile(new URL("../lib/widgets/config.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/locales.js", import.meta.url), "utf8"),
  ]);
  assert.match(controls, /Enable rotating messages/);
  assert.match(controls, /Custom message/);
  assert.match(controls, /Spinner icon/);
  assert.match(controls, /Badge background/);
  assert.match(controls, /Text and spinner/);
  assert.match(controls, /Font size/);
  assert.match(
    controls,
    /\) : \(\s*<Field label="Custom message">[\s\S]*?<\/Field>\s*\)}\s*<IconPicker\s+label="Spinner icon"/
  );
  assert.match(controls, /function IndicatorAlignmentField/);
  assert.match(controls, /AlignLeft/);
  assert.match(controls, /AlignCenter/);
  assert.match(controls, /AlignRight/);
  assert.match(controls, /StretchHorizontal/);
  assert.match(controls, /typingIndicator", "alignment"/);
  assert.match(controls, /agentTypingIndicator", "alignment"/);
  assert.match(studio, /section === "chat" \? "typing"/);
  assert.match(frame, /function AssistantThinkingBadge/);
  assert.match(frame, /motion-safe:animate-spin/);
  assert.match(frame, /function indicatorAlignmentClasses/);
  assert.match(frame, /w-full justify-center text-center/);
  assert.match(frame, /1_800/);
  assert.match(frame, /chatStatus === "sending" && !handoff/);
  assert.match(config, /typingIndicator: z\.object/);
  assert.match(locales, /Brewing a helpful answer/);
});

test("human avatars can use the assigned Genesys agent profile picture with a configured fallback", async () => {
  const [studio, controls, preview, frame] = await Promise.all([
    readFile(widgetAdminPath, "utf8"),
    readFile(controlsPath, "utf8"),
    readFile(previewPath, "utf8"),
    readFile(framePath, "utf8"),
  ]);
  assert.match(controls, /Use Genesys agent profile picture/);
  assert.match(controls, /Human consultant fallback/);
  assert.match(studio, /previewUser=\{auth\.user\}/);
  assert.match(preview, /previewAgent: previewUser/);
  assert.match(frame, /function HumanAvatar/);
  assert.match(frame, /agent-avatar\/\$\{encodeURIComponent\(message\.agentAvatarId\)\}/);
  assert.match(frame, /previewAgent\?\.profileImageUrl/);
});

test("Web Chat opens the widget studio directly while deployment infrastructure lives under AI & Channels", async () => {
  const source = await readFile(adminConsolePath, "utf8");
  assert.match(source, /selected === "widget" && <WidgetAdmin embedded inventory=\{inventory\} onPublished=\{\(\) => refreshInventory\(\)\} \/>/);
  assert.match(source, /id: "messaging", label: "Web Chat"/);
  assert.match(source, /id: "web-voice", label: "Web Calls"/);
  assert.doesNotMatch(source, /widgetView/);
  assert.match(source, /\{deploymentComponent && <CardFooter/);
});

test("the messaging handoff resolves its Genesys queue the way the assistant tool selects one", async () => {
  const [handoffs, toolDefinition] = await Promise.all([
    readFile(new URL("../lib/widgets/handoffs.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/handoff-tool-definition.mjs", import.meta.url), "utf8"),
  ]);
  // The tool exposes queue_name from an allowlist and no queue_id at all, so the
  // reservation has to accept a name and fall back to the configured default.
  assert.match(toolDefinition, /queue_name: \{/);
  assert.doesNotMatch(toolDefinition, /properties: \{[\s\S]*?queue_id: \{[\s\S]*?\},\s*reason:/);
  assert.match(handoffs, /queue\.name\.toLowerCase\(\) === requestedName\.toLowerCase\(\)/);
  assert.match(handoffs, /const defaultQueue = allowedQueues\.find\(\(queue\) => queue\.id === genesys\.queueId\)/);
  assert.match(handoffs, /const selectedQueue = byId \|\| byName \|\| defaultQueue;/);
  // A queue outside the allowlist must be rejected rather than silently defaulted.
  assert.match(handoffs, /is not allowed for this widget/);
});

test("the handoff timeline sits at the point the conversation changed hands", async () => {
  const frame = await readFile(framePath, "utf8");
  // Rendering it above the whole thread hid it once the conversation grew.
  assert.match(frame, /const firstAgentMessageIndex = messages\.findIndex\(\(message\) => message\.role === "human"\)/);
  assert.match(frame, /firstAgentMessageIndex === -1 \? messages\.length : firstAgentMessageIndex/);
  assert.match(frame, /visibleHandoff && handoffTimelineIndex === index && \(/);
  assert.match(frame, /visibleHandoff && handoffTimelineIndex === messages\.length && \(/);
});

test("polling never scrolls a customer away from the history they scrolled up to read", async () => {
  const frame = await readFile(framePath, "utf8");
  assert.match(frame, /const stickToBottomRef = useRef\(true\)/);
  assert.match(frame, /if \(!stickToBottomRef\.current\) return;/);
  assert.match(frame, /stickToBottomRef\.current = scrollHeight - scrollTop - clientHeight <= 48/);
  assert.match(frame, /onScroll=\{onTranscriptScroll\}/);
});

test("the attachment preview size and placement are part of the widget configuration", async () => {
  const [frame, loader, controls, config] = await Promise.all([
    readFile(framePath, "utf8"),
    readFile(loaderPath, "utf8"),
    readFile(controlsPath, "utf8"),
    readFile(new URL("../lib/widgets/config.js", import.meta.url), "utf8"),
  ]);
  assert.match(config, /placement: z\.enum\(\["panel", "page"\]\)/);
  assert.match(config, /pageWidthPercent: z\.number\(\)\.int\(\)\.min\(30\)\.max\(100\)/);
  assert.match(controls, /"components", "attachments", "preview", "placement"/);
  assert.match(frame, /previewSettings\?\.placement === "page"/);
  assert.match(frame, /type: "telnyx-widget-expand"/);
  assert.match(frame, /type: "telnyx-widget-collapse"/);
  // The host page geometry must be restored, including when the panel is closed.
  assert.match(loader, /function expandFrame\(widthPercent, heightPercent\)/);
  assert.match(loader, /frame\.setAttribute\("style", collapsedStyle\)/);
  // Closing restores the host page geometry whether the panel is torn down or
  // kept alive to count unread replies.
  assert.match(loader, /function closeFrame\(\) \{\s*collapseFrame\(\);/);
});

test("Engagement is ordered from audience to rules and exposes appearance animation", async () => {
  const [admin, controls, config, loader] = await Promise.all([
    readFile(widgetAdminPath, "utf8"),
    readFile(controlsPath, "utf8"),
    readFile(new URL("../lib/widgets/config.js", import.meta.url), "utf8"),
    readFile(loaderPath, "utf8"),
  ]);
  assert.match(
    admin,
    /label: "Engagement", items: \[\s*\{ id: "targeting"[\s\S]*?\{ id: "triggers"[\s\S]*?\{ id: "headsup"[\s\S]*?\{ id: "rules"/
  );
  // The loader already opened the callback surface; only the schema and picker lagged.
  assert.match(config, /surface: z\.enum\(\["home", "chat", "voice", "callbacks"\]\)/);
  assert.match(controls, /\{ value: "callbacks", label: "Callback" \}/);
  assert.match(loader, /triggers\.autoOpen\.surface === "callbacks" && callbacks/);

  assert.match(config, /launcherEntrance: z\.enum\(\["none", "fade", "scale", "slide-up", "drop"\]\)/);
  assert.match(config, /panelEntrance: z\.enum\(\["none", "fade", "scale", "slide-up", "slide-right"\]\)/);
  assert.match(controls, /"engagement", "animation", "launcherEntrance"/);
  assert.match(controls, /"engagement", "animation", "panelEntrance"/);
  // The looping launcher animation is not an entrance and was mislabelled as one.
  assert.match(controls, /label="Attention loop"/);
  assert.doesNotMatch(controls, /label="Entrance animation"/);

  assert.match(loader, /function playEntrance\(element, name\)/);
  assert.match(loader, /playEntrance\(wrap, animation\.launcherEntrance\)/);
  assert.match(loader, /playEntrance\(frame, animation\.panelEntrance\)/);
  // A filled-in entrance transform would outrank the attention loop and the
  // expanded attachment preview, so the class is removed once it finishes.
  assert.match(loader, /element\.addEventListener\("animationend", clear, \{ once: true \}\)/);
  assert.match(loader, /prefers-reduced-motion:reduce\)\{\.pulse,\.bounce,\.fade,\.enter\{animation:none\}\}/);
});

test("the unread badge stays hidden until a reply lands on a closed panel", async () => {
  const [loader, frame] = await Promise.all([
    readFile(loaderPath, "utf8"),
    readFile(framePath, "utf8"),
  ]);
  // The author display rule outranked the UA [hidden] rule, so an empty badge
  // was painted the moment the launcher mounted.
  assert.match(loader, /\.badge\[hidden\]\{display:none\}/);
  assert.match(loader, /badge\.hidden = count === 0/);
  // Nothing produced a count before: the loader listened and no one posted.
  assert.match(frame, /type: "telnyx-widget-unread", count: unreadRef\.current/);
  assert.match(frame, /event\.data\?\.type === "telnyx-widget-visibility"/);
  assert.match(frame, /if \(panelHidden && merged\.length > current\.length\)/);
  // Only a panel that can still see messages is worth keeping alive, and only
  // when the badge is switched on.
  assert.match(loader, /if \(launcher\.showUnreadBadge && hasMessagingSession\)/);
  // The surface the panel opened with says nothing about a live conversation,
  // because the customer navigates between surfaces inside the panel.
  assert.match(frame, /type: "telnyx-widget-session", active: true/);
  assert.match(loader, /type: "telnyx-widget-visibility", visible: false/);
  assert.match(loader, /if \(retained\) \{\s*opening = true;/);
  assert.match(loader, /function discardRetainedFrame\(\)/);
  // Reopening clears the count rather than leaving a stale number on the launcher.
  assert.match(loader, /revealRetainedFrame[\s\S]*?setUnreadCount\(0\)/);
  assert.match(frame, /if \(event\.data\.visible\) unreadRef\.current = 0;/);
});
