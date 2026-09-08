import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminCallbacksConfig } from "@/lib/genesys/admin-console-store.mjs";
import { loadAdminConsoleGenesysContext } from "@/lib/genesys/admin-console-installer.mjs";
import {
  callbackContactData,
  immediateCallbackSlots,
  callbackSlotCounts,
  callbackSlotsForDate,
} from "@/lib/genesys/callback-request.mjs";
import { callbackResourceName } from "@/lib/genesys/callbacks-manager.mjs";
import { getPublishedWidget, widgetOrganizationId } from "@/lib/widgets/store";
import { bearerToken, verifyWidgetBootstrapToken } from "@/lib/widgets/session-tokens";
import { getWidgetSessionByToken, touchWidgetSession } from "@/lib/widgets/sessions";

const schema = z.object({
  requestId: z.string().uuid(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phoneNumber: z.string().trim().min(8).max(40),
  email: z.string().trim().email().max(254),
  topicKey: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(512),
  mode: z.enum(["immediate", "scheduled"]),
  scheduledAtUtc: z.string().datetime().optional(),
  timeZone: z.string().trim().min(1).max(100),
  locale: z.string().trim().max(35).optional(),
  consentPhone: z.literal(true),
  consentSms: z.boolean().default(false),
  consentEmail: z.boolean().default(false),
}).strict().superRefine((input, context) => {
  if (input.mode === "scheduled" && !input.scheduledAtUtc) {
    context.addIssue({ code: "custom", path: ["scheduledAtUtc"], message: "Scheduled callback time is required" });
  }
});

function publicError(error) {
  if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid callback request" }, { status: 400 });
  const message = String(error?.message || "");
  if (/(?:bootstrap|session) token/i.test(message)) return NextResponse.json({ error: "Invalid or expired callback request" }, { status: 401 });
  if (/required|invalid|unavailable|must|exceed|earlier|horizon|consent/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  console.error("[widget-callback] request failed without persisting the callback payload", { error: message });
  return NextResponse.json({ error: "Unable to schedule the callback" }, { status: 502 });
}

async function callbackRequestContext(request, publicId) {
  const token = bearerToken(request);
  let revisionId;
  if (String(token || "").startsWith("wss_")) {
    const session = await getWidgetSessionByToken(token);
    if (!session || session.public_id !== publicId) throw new Error("Invalid widget session token");
    revisionId = session.revision_id;
    await touchWidgetSession(session);
  } else {
    revisionId = verifyWidgetBootstrapToken(token, { publicId }).rid;
  }
  const widget = await getPublishedWidget(publicId);
  if (!widget || widget.revision_id !== revisionId) {
    const error = new Error("Widget configuration has changed");
    error.status = 409;
    throw error;
  }
  const organizationId = widgetOrganizationId(widget);
  const infrastructure = await getAdminCallbacksConfig(organizationId);
  const config = widget.config.callbacks;
  if (!infrastructure || !config?.enabled) {
    const error = new Error("Callbacks are unavailable");
    error.status = 404;
    throw error;
  }
  const context = await loadAdminConsoleGenesysContext({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  });
  const resourceName = callbackResourceName();
  if (context.organization.id !== organizationId) {
    const error = new Error("Callbacks are unavailable");
    error.status = 404;
    throw error;
  }
  const lists = await context.outboundApi.getOutboundContactlists({
    pageSize: 100,
    pageNumber: 1,
    name: resourceName,
  });
  const matches = (lists.entities || []).filter(({ name }) => name === resourceName);
  if (matches.length !== 1) throw new Error("Managed callback Contact List is unavailable");
  return { widget, config, context, contactList: matches[0] };
}

export async function GET(request, { params }) {
  try {
    const { publicId } = await params;
    const { config, context, contactList } = await callbackRequestContext(request, publicId);
    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    const timeZone = url.searchParams.get("timeZone");
    const slots = callbackSlotsForDate({ date, timeZone, config });
    const counts = await callbackSlotCounts(
      context.outboundApi,
      contactList.id,
      slots.map(({ callbackAtUtc }) => callbackAtUtc)
    );
    const capacity = Number(config.maxCallbacksPerSlot || 1);
    return NextResponse.json({
      date,
      timeZone,
      intervalMinutes: config.scheduleStepMinutes,
      capacity,
      window: { start: config.availabilityWindowStart, end: config.availabilityWindowEnd },
      slots: slots.map((slot) => ({
        ...slot,
        booked: counts[slot.callbackAtUtc] || 0,
        available: slot.selectable && (counts[slot.callbackAtUtc] || 0) < capacity,
        unavailableReason: !slot.selectable
          ? slot.unavailableReason
          : (counts[slot.callbackAtUtc] || 0) >= capacity ? "full" : null,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error?.status === 409) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error?.status === 404) return NextResponse.json({ error: error.message }, { status: 404 });
    return publicError(error);
  }
}

async function firstAvailableCallbackSlot(outboundApi, contactListId, candidateSlots, capacity) {
  for (let offset = 0; offset < candidateSlots.length; offset += 50) {
    const batch = candidateSlots.slice(offset, offset + 50);
    const counts = await callbackSlotCounts(
      outboundApi,
      contactListId,
      batch.map(({ callbackAtUtc }) => callbackAtUtc)
    );
    const available = batch.find(
      ({ callbackAtUtc }) => (counts[callbackAtUtc] || 0) < capacity
    );
    if (available) return available;
  }
  return null;
}

export async function POST(request, { params }) {
  try {
    const { publicId } = await params;
    const input = schema.parse(await request.json());
    const { config, context, contactList } = await callbackRequestContext(request, publicId);
    const now = new Date();
    const data = callbackContactData(input, config, { widgetId: publicId, now });
    const existing = await context.outboundApi.postOutboundContactlistContactsSearch(contactList.id, {
      pageNumber: 1,
      pageSize: 1,
      criteria: {
        filterType: "AND",
        clauses: [{
          filterType: "AND",
          predicates: [{
            column: "callback_request_id",
            columnType: "alphabetic",
            operator: "EQUALS",
            value: data.callback_request_id,
          }],
        }],
      },
    });
    if ((existing.entities || []).length) {
      return NextResponse.json({
        callback: {
          requestId: data.callback_request_id,
          callbackAtUtc: existing.entities[0]?.data?.callback_at_utc || data.callback_at_utc,
          duplicate: true,
        },
      }, { headers: { "cache-control": "no-store" } });
    }
    const candidateSlots = input.mode === "immediate"
      ? immediateCallbackSlots({
          timeZone: input.timeZone,
          config,
          now,
          notBeforeUtc: data.callback_at_utc,
        })
      : [{ callbackAtUtc: data.callback_at_utc }];
    const availableSlot = await firstAvailableCallbackSlot(
      context.outboundApi,
      contactList.id,
      candidateSlots,
      Number(config.maxCallbacksPerSlot || 1)
    );
    if (!availableSlot) {
      return NextResponse.json(
        { error: input.mode === "immediate"
          ? "No callback time is currently available"
          : "The selected callback time is no longer available" },
        { status: 409, headers: { "cache-control": "no-store" } }
      );
    }
    data.callback_at_utc = availableSlot.callbackAtUtc;
    const [created] = await context.outboundApi.postOutboundContactlistContacts(contactList.id, [{
      contactListId: contactList.id,
      data,
      callable: true,
    }]);
    if (!created?.id) throw new Error("Genesys did not return the callback contact ID");
    return NextResponse.json({
      callback: { requestId: data.callback_request_id, callbackAtUtc: data.callback_at_utc },
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return publicError(error);
  }
}
