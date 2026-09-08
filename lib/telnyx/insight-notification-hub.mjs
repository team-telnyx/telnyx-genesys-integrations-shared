import { getPostgresPool } from "../postgres.mjs";
import { TELNYX_INSIGHT_NOTIFICATION_CHANNEL } from "./insight-events.mjs";

const hub =
  globalThis.__telnyxInsightNotificationHub ||
  (globalThis.__telnyxInsightNotificationHub = {
    client: null,
    connectPromise: null,
    reconnectTimer: null,
    subscribers: new Set(),
    stopped: false,
  });

function broadcast(notification) {
  if (notification.channel !== TELNYX_INSIGHT_NOTIFICATION_CHANNEL) return;
  let event;
  try {
    event = JSON.parse(notification.payload || "{}");
  } catch {
    return;
  }
  for (const subscriber of hub.subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      console.error("[insight-notification-hub] subscriber failed", error);
    }
  }
}

function scheduleReconnect() {
  if (hub.stopped || hub.reconnectTimer || hub.subscribers.size === 0) return;
  hub.reconnectTimer = setTimeout(() => {
    hub.reconnectTimer = null;
    void ensureInsightNotificationHub().catch((error) => {
      console.error("[insight-notification-hub] reconnect failed", error);
      scheduleReconnect();
    });
  }, 1_000);
  hub.reconnectTimer.unref?.();
}

async function connectListener() {
  const client = await getPostgresPool().connect();
  const onError = (error) => {
    if (hub.client !== client) return;
    hub.client = null;
    console.error("[insight-notification-hub] PostgreSQL listener failed", error);
    try { client.release(error); } catch {}
    scheduleReconnect();
  };
  client.on("notification", broadcast);
  client.on("error", onError);
  try {
    await client.query(`LISTEN ${TELNYX_INSIGHT_NOTIFICATION_CHANNEL}`);
  } catch (error) {
    client.off("notification", broadcast);
    client.off("error", onError);
    client.release(error);
    throw error;
  }
  if (hub.stopped) {
    client.off("notification", broadcast);
    client.off("error", onError);
    client.release();
    throw new Error("Insight notification hub is stopped");
  }
  hub.client = client;
  return client;
}

export async function ensureInsightNotificationHub() {
  if (hub.stopped) throw new Error("Insight notification hub is stopped");
  if (hub.client) return hub.client;
  if (!hub.connectPromise) {
    hub.connectPromise = connectListener().finally(() => {
      hub.connectPromise = null;
    });
  }
  return hub.connectPromise;
}

export async function subscribeToInsightNotifications(subscriber) {
  if (typeof subscriber !== "function") throw new Error("Insight subscriber must be a function");
  hub.subscribers.add(subscriber);
  try {
    await ensureInsightNotificationHub();
  } catch (error) {
    hub.subscribers.delete(subscriber);
    throw error;
  }
  return () => {
    hub.subscribers.delete(subscriber);
  };
}

export async function stopInsightNotificationHub() {
  hub.stopped = true;
  hub.subscribers.clear();
  if (hub.reconnectTimer) clearTimeout(hub.reconnectTimer);
  hub.reconnectTimer = null;
  const client = hub.client;
  hub.client = null;
  if (!client) return;
  client.off("notification", broadcast);
  await client.query(`UNLISTEN ${TELNYX_INSIGHT_NOTIFICATION_CHANNEL}`).catch(() => undefined);
  client.release();
}

export function resetInsightNotificationHubForTests() {
  hub.subscribers.clear();
  hub.stopped = false;
}
