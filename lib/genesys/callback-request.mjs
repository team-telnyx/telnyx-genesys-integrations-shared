const E164 = /^\+[1-9]\d{7,14}$/;

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function minutesOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

function parseClock(value, label) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`${label} must use HH:mm`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 0 || minutes >= 1440) throw new Error(`${label} is invalid`);
  return minutes;
}

export function callbackAvailabilityWindow(config) {
  const start = config.availabilityWindowStart ?? config.immediateWindowStart;
  const end = config.availabilityWindowEnd ?? config.immediateWindowEnd;
  return {
    start,
    end,
    startMinutes: parseClock(start, "Availability window start"),
    endMinutes: parseClock(end, "Availability window end"),
  };
}

function zonedLocalToUtc(parts, timeZone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let instant = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(instant), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const next = instant + desired - represented;
    if (next === instant) return new Date(instant);
    instant = next;
  }
  return new Date(instant);
}

function addLocalMinutes(parts, minutes) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute + minutes));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

export function genesysCallbackTimestamp(date) {
  return new Date(date).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z");
}

export function callbackSlotsForDate({ date, timeZone, config, now = new Date() }) {
  if (!validTimeZone(timeZone)) throw new Error("A valid IANA callback timezone is required");
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Callback date must use YYYY-MM-DD");
  const dateParts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const probe = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
  if (
    probe.getUTCFullYear() !== dateParts.year ||
    probe.getUTCMonth() + 1 !== dateParts.month ||
    probe.getUTCDate() !== dateParts.day
  ) throw new Error("Callback date is invalid");

  const { startMinutes, endMinutes } = callbackAvailabilityWindow(config);
  if (endMinutes <= startMinutes) throw new Error("Availability window must end after it starts");
  const step = Number(config.scheduleStepMinutes || 15);
  const earliest = new Date(now.getTime() + Number(config.minimumLeadMinutes || 0) * 60_000);
  const latest = new Date(now.getTime() + Number(config.maximumScheduleDays || 30) * 86_400_000);
  const slots = [];
  for (let minute = startMinutes; minute < endMinutes; minute += step) {
    const parts = {
      ...dateParts,
      hour: Math.floor(minute / 60),
      minute: minute % 60,
    };
    const instant = zonedLocalToUtc(parts, timeZone);
    const represented = localParts(instant, timeZone);
    const validLocalTime = represented.year === parts.year && represented.month === parts.month &&
      represented.day === parts.day && represented.hour === parts.hour && represented.minute === parts.minute;
    const selectable = validLocalTime && instant >= earliest && instant <= latest;
    slots.push({
      callbackAtUtc: genesysCallbackTimestamp(instant),
      startsAt: instant.toISOString(),
      label: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
      selectable,
      unavailableReason: validLocalTime ? (instant < earliest ? "lead-time" : instant > latest ? "horizon" : null) : "invalid-local-time",
    });
  }
  return slots;
}

export function immediateCallbackSlots({ timeZone, config, now = new Date(), notBeforeUtc } = {}) {
  if (!validTimeZone(timeZone)) throw new Error("A valid IANA callback timezone is required");
  const first = new Date(notBeforeUtc);
  if (!Number.isFinite(first.getTime())) throw new Error("Immediate callback start time is invalid");
  const startDate = localParts(first, timeZone);
  const horizonDays = Number(config.maximumScheduleDays || 30);
  const slots = [];
  for (let dayOffset = 0; dayOffset <= Math.ceil(horizonDays) + 1; dayOffset += 1) {
    const day = addLocalMinutes(
      { ...startDate, hour: 0, minute: 0 },
      dayOffset * 1440
    );
    const date = [day.year, day.month, day.day]
      .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
      .join("-");
    for (const slot of callbackSlotsForDate({ date, timeZone, config, now })) {
      if (slot.selectable && new Date(slot.startsAt) >= first) slots.push(slot);
    }
  }
  return slots;
}

// Genesys caps how many predicates a contact-list filter may carry, and a single
// day of slots already exceeds it. Every timestamp on one day shares its date
// prefix, so one BEGINS_WITH predicate per day replaces one EQUALS per slot and
// the per-slot tally is done here.
const CALLBACK_FILTER_PREDICATE_LIMIT = 10;

export function callbackSlotDatePrefixes(callbackAtValues) {
  return [...new Set(
    (callbackAtValues || [])
      .map((value) => String(value || "").trim().slice(0, 10))
      .filter((prefix) => /^\d{4}-\d{2}-\d{2}$/.test(prefix))
  )];
}

export async function callbackSlotCounts(outboundApi, contactListId, callbackAtValues) {
  const values = [...new Set((callbackAtValues || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const counts = Object.fromEntries(values.map((value) => [value, 0]));
  if (!values.length) return counts;
  const prefixes = callbackSlotDatePrefixes(values);
  for (let offset = 0; offset < prefixes.length; offset += CALLBACK_FILTER_PREDICATE_LIMIT) {
    const batch = prefixes.slice(offset, offset + CALLBACK_FILTER_PREDICATE_LIMIT);
    const criteria = {
      filterType: "OR",
      clauses: [{
        filterType: "OR",
        predicates: batch.map((prefix) => ({
          column: "callback_at_utc",
          columnType: "alphabetic",
          operator: "BEGINS_WITH",
          value: prefix,
        })),
      }],
    };
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const page = await outboundApi.postOutboundContactlistContactsSearch(contactListId, {
        pageNumber,
        pageSize: 100,
        criteria,
      });
      for (const contact of page.entities || []) {
        const value = String(contact?.data?.callback_at_utc || "").trim();
        if (Object.hasOwn(counts, value)) counts[value] += 1;
      }
      if (!page.nextUri && pageNumber >= Number(page.pageCount || 1)) break;
    }
  }
  return counts;
}

export function resolveCallbackAt({ mode, scheduledAtUtc, timeZone, config, now = new Date() }) {
  if (!validTimeZone(timeZone)) throw new Error("A valid IANA callback timezone is required");
  const step = Number(config.scheduleStepMinutes || 15);
  const lead = Number(config.minimumLeadMinutes || 5);
  const horizonDays = Number(config.maximumScheduleDays || 30);
  const earliest = new Date(now.getTime() + lead * 60_000);
  const latest = new Date(now.getTime() + horizonDays * 86_400_000);
  let callbackAt;
  const { startMinutes: windowStart, endMinutes: windowEnd } = callbackAvailabilityWindow(config);
  if (windowEnd <= windowStart) throw new Error("Availability window must end after it starts");
  if (mode === "scheduled") {
    callbackAt = new Date(scheduledAtUtc);
    if (!Number.isFinite(callbackAt.getTime())) throw new Error("Scheduled callback time is invalid");
    const parts = localParts(callbackAt, timeZone);
    const minute = minutesOfDay(parts);
    if ((minute - windowStart) % step !== 0) throw new Error(`Scheduled callback time must use a ${step}-minute step`);
    if (minute < windowStart || minute >= windowEnd) {
      throw new Error(`Scheduled callback time must be between ${config.availabilityWindowStart ?? config.immediateWindowStart} and ${config.availabilityWindowEnd ?? config.immediateWindowEnd}`);
    }
  } else if (mode === "immediate") {
    const earliestParts = localParts(earliest, timeZone);
    const minute = minutesOfDay(earliestParts);
    let targetParts = earliestParts;
    if (minute >= windowEnd) {
      targetParts = addLocalMinutes({ ...earliestParts, hour: 0, minute: 0 }, 1440 + windowStart);
    } else if (minute < windowStart) {
      targetParts = { ...earliestParts, hour: Math.floor(windowStart / 60), minute: windowStart % 60 };
    } else {
      const rounded = windowStart + Math.ceil((minute - windowStart) / step) * step;
      targetParts = rounded >= windowEnd
        ? addLocalMinutes({ ...earliestParts, hour: 0, minute: 0 }, 1440 + windowStart)
        : { ...earliestParts, hour: Math.floor(rounded / 60), minute: rounded % 60 };
    }
    callbackAt = zonedLocalToUtc(targetParts, timeZone);
  } else {
    throw new Error("Callback mode must be immediate or scheduled");
  }
  if (callbackAt < earliest) throw new Error("Callback time is earlier than the configured minimum lead time");
  if (callbackAt > latest) throw new Error("Callback time exceeds the configured scheduling horizon");
  return genesysCallbackTimestamp(callbackAt);
}

function text(value, label, max) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} cannot exceed ${max} characters`);
  return normalized;
}

export function callbackContactData(input, config, { widgetId, now = new Date() } = {}) {
  const phone = text(input.phoneNumber, "Phone number", 40);
  if (!E164.test(phone)) throw new Error("Phone number must use E.164 format");
  const email = text(input.email, "Email", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email is invalid");
  const topic = (config.topics || []).find(({ key }) => key === input.topicKey);
  if (!topic) throw new Error("Selected callback topic is unavailable");
  if (input.consentPhone !== true) throw new Error("Phone contact consent is required");
  if (input.mode === "immediate" && config.allowImmediate === false) {
    throw new Error("Immediate callbacks are unavailable");
  }
  if (input.mode === "scheduled" && config.allowScheduled === false) {
    throw new Error("Scheduled callbacks are unavailable");
  }
  const callbackAtUtc = resolveCallbackAt({
    mode: input.mode,
    scheduledAtUtc: input.scheduledAtUtc,
    timeZone: input.timeZone,
    config,
    now,
  });
  const requestId = text(input.requestId, "Callback request ID", 100);
  return {
    phone_number: phone,
    phone_timezone: input.timeZone,
    first_name: text(input.firstName, "First name", 100),
    last_name: text(input.lastName, "Last name", 100),
    email,
    topic_key: topic.key,
    topic_label: topic.label,
    description: text(input.description, "Description", 512),
    callback_mode: input.mode,
    callback_at_utc: callbackAtUtc,
    callback_timezone: input.timeZone,
    customer_locale: String(input.locale || "en-US").slice(0, 35),
    callback_request_id: requestId,
    widget_id: String(widgetId || "").slice(0, 100),
    consent_phone: "true",
    consent_sms: String(input.consentSms === true),
    consent_email: String(input.consentEmail === true),
    consent_text: config.consentText,
    consent_timestamp_utc: now.toISOString(),
    consent_policy_version: config.consentPolicyVersion,
    created_at_utc: now.toISOString(),
  };
}
