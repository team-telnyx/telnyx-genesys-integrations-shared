"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoStage } from '@/components/video/VideoStage';
import GenesysVideoHeader from './GenesysVideoHeader';
import { useVideoRoom } from '@/hooks/use-video-room';
import { genesysAuthenticatedFetch } from '@/lib/genesys/admin-client-auth';

export function VideoWidgetSkeleton() {
  return <div className="flex h-dvh flex-col gap-4 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="min-h-0 flex-1 rounded-xl" /><Skeleton className="h-14 w-full" /></div>;
}
export default function GenesysVideoWidget({ defaultTheme = 'light' }) {
  const params = useSearchParams();
  const conversationId = params.get('conversationId') || params.get('gcConversationId') || params.get('pcConversationId');
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);
  const [joining, setJoining] = useState(false);
  const [recordings, setRecordings] = useState(null);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const activeRef = useRef(true);
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
  const startedRef = useRef(false);
  const tokenRef = useRef(null);
  const room = useVideoRoom({ role: 'agent', name: payload?.agent?.name || 'Agent', initialLayout: 'pip', initialCamera: true });
  const { join, leave, updateToken } = room;
  const api = useCallback(async (action, extra = {}) => {
    if (!conversationId) throw new Error('Genesys Cloud did not provide a conversation ID.');
    const response = await genesysAuthenticatedFetch(`/api/genesys/video-widget?conversationId=${encodeURIComponent(conversationId)}${extra.recordings ? "&recordings=1" : ""}`, {
      method: action ? 'POST' : 'GET', cache: 'no-store', credentials: 'include',
      ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) } : {}),
    });
    if (response.status === 401) {
      const returnTo = `/genesys/video-widget?conversationId=${encodeURIComponent(conversationId)}`;
      // OAuth must navigate the iframe document across origins.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Unable to load video call'), { status: response.status });
    return result;
  }, [conversationId]);
  const joinCall = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setJoining(true);
    setError('');
    try {
      const result = await api('join');
      if (!activeRef.current) return;
      tokenRef.current = result.join;
      await join({ roomId: result.join.roomId, token: result.join.token });
      if (activeRef.current) setPayload(result);
    } catch (failure) {
      startedRef.current = false;
      setError(failure.message);
      await leave();
    } finally { setJoining(false); }
  }, [api, join, leave]);
  useEffect(() => {
    let cancelled = false, timer;
    async function poll() {
      try {
        const result = await api();
        if (cancelled) return;
        setPayload(result);
        setLoading(false);
        if (result.handoff?.status === 'disconnected') { startedRef.current = false; setEnded(true); await leave(); return; }
      } catch (failure) {
        if (cancelled) return;
        setError(failure.message); setLoading(false);
        if ([403, 404, 409].includes(failure.status)) { startedRef.current = false; await leave(); setEnded(true); return; }
      }
      if (!cancelled) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, leave]);
  useEffect(() => {
    // Loading the panel never joins an interaction that is merely alerting.
    if (payload?.accepted && !ended && !error && !startedRef.current) void joinCall();
  }, [ended, error, joinCall, payload?.accepted]);
  useEffect(() => {
    if (room.status !== 'connected' || ended) return undefined;
    const timer = setInterval(async () => {
      try {
        const result = await api('token', { refreshToken: tokenRef.current?.refreshToken });
        tokenRef.current = result.join;
        await updateToken(result.join.token);
      } catch (failure) { startedRef.current = false; setError(failure.message); await leave(); }
    }, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [api, ended, leave, room.status, updateToken]);
  useEffect(() => {
    if (room.status !== 'disconnected' || ended || !startedRef.current) return;
    startedRef.current = false;
    setError('The video connection closed. Rejoin while the interaction is still assigned to you.');
    void leave();
  }, [ended, leave, room.status]);
  const endCall = async () => {
    setEnding(true);
    try { await api('end'); startedRef.current = false; await leave(); setEnded(true); }
    catch (failure) { setError(failure.message); }
    finally { setEnding(false); }
  };
  const loadRecordings = async () => {
    setRecordingLoading(true);
    try { const result = await api(null, { recordings: true }); setRecordings(result.recordings || []); }
    catch (failure) { setError(failure.message); }
    finally { setRecordingLoading(false); }
  };
  const tiles = useMemo(() => room.tiles.map((tile) => ({ ...tile, label: tile.self ? 'You' : tile.name || 'Customer', cameraOffLabel: tile.cameraOff ? 'Camera off' : 'Waiting for video' })), [room.tiles]);
  if (loading) return <VideoWidgetSkeleton />;
  return <main className="flex h-dvh min-h-0 flex-col gap-3 bg-background p-4 text-foreground">
    <GenesysVideoHeader queueName={payload?.handoff?.queueName} defaultTheme={defaultTheme}
      status={ended ? 'Call ended' : joining ? 'Joining…' : payload?.accepted ? 'Video interaction' : 'Accept the interaction in Genesys to join'}
      layout={room.layout} onLayoutChange={room.setLayout} />
    {error && <div role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</div>}
    {ended ? <div className="grid flex-1 place-items-center rounded-xl border text-sm text-muted-foreground">The video session is closed. Complete wrap-up in Genesys Cloud.</div>
      : <VideoStage scene={room.layout} tiles={tiles} viewerRole="agent" orientation="row" audioTracks={room.audioTracks} fill />}
    {room.error && !ended && <p role="status" className="text-sm text-destructive">{room.error}</p>}
    {!ended && <footer className="flex flex-wrap items-center justify-center gap-2 border-t pt-3">
      <Button variant="outline" aria-label={room.micOn ? 'Mute microphone' : 'Unmute microphone'} onClick={() => void room.toggleMic()} disabled={!payload?.accepted}>{room.micOn ? <Mic /> : <MicOff />}</Button>
      <Button variant="outline" aria-label={room.cameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => void room.toggleCamera()} disabled={!payload?.accepted}>{room.cameraOn ? <Video /> : <VideoOff />}</Button>
      <Button variant="outline" onClick={() => void room.toggleScreenShare()} disabled={room.status !== 'connected'}><MonitorUp />{room.screenSharing ? 'Stop sharing' : 'Share screen'}</Button>
      {room.status !== 'connected' && <Button onClick={() => void joinCall()} disabled={!payload?.accepted || joining}>Join video</Button>}
      <Button variant="destructive" onClick={() => void endCall()} disabled={!payload?.accepted || ending}><PhoneOff />{ending ? 'Ending…' : 'End call'}</Button>
    </footer>}
    {payload?.recording && ended && <section className="grid gap-2">
      <Button variant="outline" onClick={() => void loadRecordings()} disabled={recordingLoading}>{recordingLoading ? 'Loading recordings…' : 'Load recording'}</Button>
      {recordingLoading && <Skeleton className="h-24 w-full" />}
      {recordings?.length === 0 && !recordingLoading && <p className="text-sm text-muted-foreground">The recording is processing. Try again shortly.</p>}
      {recordings?.map((item) => item.type === 'audio' ? <audio key={item.id} controls src={item.url} /> : <video key={item.id} controls playsInline className="max-h-72 w-full" src={item.url} />)}
    </section>}
    {payload?.recording && !ended && <p className="text-center text-xs text-muted-foreground">This call is being recorded.</p>}
  </main>;
}
