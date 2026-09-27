import { z } from "zod";

// Waiting videos come from an HTTPS URL or the organization media library.
const waitingMediaItem = z.object({
  source: z.enum(["url", "library"]).default("url"),
  url: z.string().trim().max(2000).default(""),
  mediaId: z.string().trim().max(64).default(""),
  label: z.string().trim().max(120).default(""),
}).superRefine((item, ctx) => {
  if (item.source === "library") {
    if (!z.string().uuid().safeParse(item.mediaId).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a video from the media library" });
    return;
  }
  let parsed = null;
  try { parsed = new URL(item.url); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Waiting media must be a valid HTTPS URL" });
});
export const VIDEO_LAYOUTS = Object.freeze(["remote", "split", "pip", "spotlight"]);
export const VIDEO_MODAL_SIZES = Object.freeze({ small: 50, medium: 75, large: 90, fullscreen: 100 });
export const DEFAULT_VIDEO_CHANNEL = Object.freeze({
  enabled: false,
  genesys: { queueId: "", queueName: "", integrationId: "", flowId: "", widgetIntegrationId: "" },
  camera: "on",
  scenes: { available: ["remote", "split", "pip", "spotlight"], default: "pip", pipThumbnail: 30 },
  modal: { enabled: true, size: "medium" },
  sizing: { mode: "widget", width: 480, height: 640 },
  controls: { position: "bottom", overlay: { opacity: 35, size: "regular" } },
  notices: { enabled: true, seconds: 3 },
  allowScreenShare: false,
  recording: { enabled: true, layout: "pip" },
  waiting: { mode: "rotate", sound: true, items: [] },
});
// Phase 1 revisions stored `defaultLayout` and a bare `waitingMedia` list.
function migrateVideoChannel(value) {
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  if (!next.scenes && typeof next.defaultLayout === "string") next.scenes = { available: [...DEFAULT_VIDEO_CHANNEL.scenes.available], default: next.defaultLayout };
  if (!next.waiting && Array.isArray(next.waitingMedia)) {
    next.waiting = { mode: next.waitingMedia.length > 1 ? "rotate" : "loop", items: next.waitingMedia.map((item) => ({ source: "url", url: item?.url || "", label: item?.label || "" })) };
  }
  delete next.defaultLayout; delete next.waitingMedia;
  return next;
}
export const videoChannelSchema = z.preprocess(migrateVideoChannel, z.object({
  enabled: z.boolean(),
  genesys: z.object({
    integrationId: z.string().trim().max(200).default(""),
    flowId: z.string().trim().max(200).default(""),
    widgetIntegrationId: z.string().trim().max(200).default(""),
    queueId: z.string().trim().max(200).default(""),
    queueName: z.string().trim().max(200).default(""),
    // A staged queue-wide operation. Cleared after successful publication so
    // Studio always reads the actual Genesys state, including external edits.
    autoOpen: z.boolean().nullable().default(null),
  }).default({ queueId: "", queueName: "" }),
  // Camera state proposed on the pre-join screen; the visitor can always change it.
  camera: z.enum(["on", "off"]).default("on"),
  // Scenes the visitor may switch between and the one applied when the other side connects.
  scenes: z.object({
    available: z.array(z.enum(VIDEO_LAYOUTS)).min(1).default([...DEFAULT_VIDEO_CHANNEL.scenes.available]),
    default: z.enum(VIDEO_LAYOUTS).default("pip"),
    // Width of the picture-in-picture thumbnails as a share of the main frame.
    pipThumbnail: z.number().int().min(10).max(50).default(30),
  }).default(DEFAULT_VIDEO_CHANNEL.scenes).transform((scenes) => ({ ...scenes, available: [...new Set(scenes.available)], default: scenes.available.includes(scenes.default) ? scenes.default : scenes.available[0] })),
  // The enlarge button and the modal width preset (share of the page width).
  modal: z.object({
    enabled: z.boolean().default(true),
    size: z.enum(["small", "medium", "large", "fullscreen"]).default("medium"),
  }).default(DEFAULT_VIDEO_CHANNEL.modal),
  // `widget` keeps the panel at `dimensions`; `video` resizes it while the video surface is open.
  sizing: z.object({
    mode: z.enum(["widget", "video"]).default("widget"),
    width: z.number().int().min(320).max(960).default(480),
    height: z.number().int().min(420).max(900).default(640),
  }).default(DEFAULT_VIDEO_CHANNEL.sizing),
  // Where the call controls are drawn: docked under a separator, above the scene, or over its bottom edge.
  controls: z.object({
    position: z.enum(["bottom", "top", "overlay"]).default("bottom"),
    // The floating panel: background opacity and button size.
    overlay: z.object({
      opacity: z.number().int().min(0).max(100).default(35),
      size: z.enum(["compact", "regular", "large"]).default("regular"),
    }).default(DEFAULT_VIDEO_CHANNEL.controls.overlay),
  }).default(DEFAULT_VIDEO_CHANNEL.controls),
  // Handoff notices (queued, assigned, connected) shown over the video frame.
  notices: z.object({
    enabled: z.boolean().default(true),
    // How long a notice stays on the frame before it hides.
    seconds: z.number().int().min(1).max(30).default(3),
  }).default(DEFAULT_VIDEO_CHANNEL.notices),
  allowScreenShare: z.boolean().default(false),
  recording: z.object({
    enabled: z.boolean().default(true),
    // Layout of the composed recording (Telnyx compositions allow two regions).
    layout: z.enum(["pip", "split"]).default("pip"),
  }).default({ enabled: true, layout: "pip" }),
  // Muted playlist while the visitor waits: one file in a loop or the list in rotation.
  waiting: z.object({
    mode: z.enum(["loop", "rotate"]).default("rotate"),
    // The visitor pressed Start call, so the playlist may play with sound.
    sound: z.boolean().default(true),
    items: z.array(waitingMediaItem).max(10).default([]),
  }).default(DEFAULT_VIDEO_CHANNEL.waiting),
}));
