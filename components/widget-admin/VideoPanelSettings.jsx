"use client";

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { genesysAuthenticatedFetch } from '@/lib/genesys/admin-client-auth';

export default function VideoPanelSettings({ genesys, videoEnabled, onChange }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const queueId = genesys.queueId;
  const pending = genesys.autoOpen;
  useEffect(() => {
    if (!queueId) return;
    let active = true;
    genesysAuthenticatedFetch(`/api/admin/widgets/video-panel?queueId=${encodeURIComponent(queueId)}`, { cache: 'no-store' })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to read Genesys panel settings');
        if (active) { setStatus(data); setError(''); }
      }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [queueId, attempt, pending]);

  const desired = typeof pending === 'boolean' ? pending : status?.enabled;
  return <div className="grid gap-2 rounded-lg border p-3">
    {!queueId ? <p className="text-sm text-muted-foreground">Select a queue to check automatic panel opening.</p>
      : error ? <div role="alert" className="grid gap-2 text-sm text-destructive">{error}<Button variant="outline" size="sm" onClick={() => { setError(''); setStatus(null); setAttempt(value => value + 1); }}>Retry</Button></div>
        : !status ? <Skeleton className="h-14 w-full" />
          : <>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="video-auto-open">Automatically open the video panel</Label>
              <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{desired ? 'Enabled' : 'Disabled'}</span><Switch id="video-auto-open" aria-label="Automatically open the video panel" checked={Boolean(desired)} disabled={!videoEnabled && !desired} onCheckedChange={onChange} /></div>
            </div>
            <p className="text-xs text-muted-foreground">Current Genesys setting for {genesys.queueName || 'this queue'}: {status.enabled ? 'Enabled' : 'Disabled'}.{typeof pending === 'boolean' ? ' Your change will be applied when you publish.' : ''}</p>
            {desired && !status.enabled && status.replacesOtherPanel && <p className="text-xs text-muted-foreground">Publishing will replace the organization’s Open Messaging default ({status.defaultPanel}) with the video panel. Other queues will no longer automatically open that previous default.</p>}
          </>}
  </div>;
}
