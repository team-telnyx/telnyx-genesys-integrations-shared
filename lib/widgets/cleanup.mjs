import { getPostgresPool } from "../postgres.mjs";
import { deleteOrphanedSessionAttachments } from "./session-attachments.js";

export async function cleanupExpiredWidgetRuntimeData() {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const handoffs = await client.query(
      "DELETE FROM genesys_widget_handoffs WHERE expires_at <= NOW()"
    );
    const sessions = await client.query(
      "DELETE FROM widget_sessions s WHERE expires_at <= NOW() AND NOT EXISTS (SELECT 1 FROM widget_video_sessions v WHERE v.session_id=s.id AND (v.state NOT IN ('ended','failed') OR v.cleanup_pending))"
    );
    const webhookEvents = await client.query(
      "DELETE FROM widget_webhook_events WHERE expires_at <= NOW()"
    );
    const insightEvents = await client.query(
      "DELETE FROM telnyx_conversation_insight_events WHERE expires_at <= NOW()"
    );
    const active = await client.query("SELECT id FROM widget_sessions");
    await client.query("COMMIT");
    // Uploads live on disk, so they are swept against the sessions that remain.
    const attachments = await deleteOrphanedSessionAttachments(
      active.rows.map((row) => row.id)
    ).catch((error) => {
      console.error("[widget-cleanup] Failed to delete orphaned attachments:", error);
      return 0;
    });
    return {
      handoffs: handoffs.rowCount,
      sessions: sessions.rowCount,
      webhookEvents: webhookEvents.rowCount,
      insightEvents: insightEvents.rowCount,
      attachments,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function startWidgetRuntimeCleanup({ intervalMs = 15 * 60 * 1000 } = {}) {
  let videoSweepRunning = false;
  const videoTimer = setInterval(async () => {
    if (videoSweepRunning) return;
    videoSweepRunning = true;
    try {
      const { createVideoService } = await import("../video/service.mjs");
      await createVideoService().sweep();
    } catch (error) { console.error("[video-cleanup]", error.message); }
    finally { videoSweepRunning = false; }
  }, 30_000);
  videoTimer.unref();
  const timer = setInterval(() => {
    void cleanupExpiredWidgetRuntimeData().catch((error) => {
      console.error("[widget-cleanup] Failed to delete expired runtime data:", error);
    });
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); clearInterval(videoTimer); };
}
