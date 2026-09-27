"use client";
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { genesysAuthenticatedFetch } from '@/lib/genesys/admin-client-auth';

import VideoWaitingPlaylist from './VideoWaitingPlaylist';
import VideoPanelSettings from './VideoPanelSettings';

const scenes = { remote: 'Remote only', split: 'Side by side', pip: 'Picture in picture', spotlight: 'Spotlight' };
function Choice({ label, value, onChange, options }) {
  return <div className="grid gap-1.5"><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(options).map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent></Select></div>;
}
function Toggle({ label, checked, onChange }) { return <div className="flex items-center justify-between gap-3"><Label>{label}</Label><Switch checked={checked} onCheckedChange={onChange} aria-label={label} /></div>; }
export default function VideoSettings({ config, set }) {
  const video = config.channels.video;
  const update = (path, value) => set(['channels', 'video', ...path], value);
  const [queues, setQueues] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    genesysAuthenticatedFetch('/api/admin/widgets/video-queues', { cache: 'no-store' }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load Genesys queues');
      if (active) { setQueues(body.entities || body.queues || (Array.isArray(body) ? body : [])); setError(''); }
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [attempt]);
  return <div className="space-y-6">
    <section className="grid gap-4"><h3 className="font-semibold">Genesys Cloud video</h3><p className="text-xs text-muted-foreground">Visitors join a video call with an agent in the selected Genesys Cloud queue.</p>
      <Toggle label="Enable video" checked={video.enabled} onChange={(value) => update(['enabled'], value)} />
      {error ? <div role="alert" className="grid gap-2 text-sm text-destructive">{error}<Button variant="outline" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>Retry</Button></div>
        : queues === null ? <Skeleton className="h-16 w-full" />
        : queues.length === 0 ? <p className="text-sm text-muted-foreground">No Genesys Cloud queues are available.</p>
        : <Choice label="Genesys Cloud video queue" value={video.genesys.queueId} options={Object.fromEntries(queues.map((queue) => [queue.id, queue.name]))} onChange={(id) => { update(['genesys'], { ...video.genesys, queueId: id, queueName: queues.find((queue) => queue.id === id)?.name || '', autoOpen: null }); }} />}
      <VideoPanelSettings key={video.genesys.queueId} genesys={video.genesys} videoEnabled={video.enabled} onChange={value => update(['genesys', 'autoOpen'], value)} />
      <p className="text-xs text-muted-foreground">Publishing configures routing and an interaction panel for this widget. Agents accept the interaction in Genesys before joining the video room.</p>
      <Choice label="Initial camera" value={video.camera} options={{ on: 'Camera on', off: 'Audio only' }} onChange={(value) => update(['camera'], value)} />
      <Toggle label="Allow screen sharing" checked={video.allowScreenShare} onChange={(value) => update(['allowScreenShare'], value)} />
    </section>
    <section className="grid gap-4 border-t pt-5"><h3 className="font-semibold">Video scenes</h3>
      {Object.entries(scenes).map(([id, name]) => <Toggle key={id} label={name} checked={video.scenes.available.includes(id)} onChange={(on) => { const next = on ? [...video.scenes.available, id] : video.scenes.available.filter((scene) => scene !== id); if (!next.length) return; update(['scenes', 'available'], next); if (!next.includes(video.scenes.default)) update(['scenes', 'default'], next[0]); }} />)}
      <Choice label="Default scene" value={video.scenes.default} options={Object.fromEntries(video.scenes.available.map((id) => [id, scenes[id]]))} onChange={(value) => update(['scenes', 'default'], value)} />
      <Label>Picture in picture thumbnail (%)<Input type="number" min={10} max={50} value={video.scenes.pipThumbnail} onChange={(e) => update(['scenes', 'pipThumbnail'], Number(e.target.value))} /></Label>
      <Toggle label="Allow enlarged video" checked={video.modal.enabled} onChange={(value) => update(['modal', 'enabled'], value)} />
      <Choice label="Enlarged view" value={video.modal.size} options={{ small: 'Small', medium: 'Medium', large: 'Large', fullscreen: 'Full screen' }} onChange={(value) => update(['modal', 'size'], value)} />
      <Choice label="Panel size" value={video.sizing.mode} options={{ widget: 'Use widget dimensions', video: 'Video dimensions' }} onChange={(value) => update(['sizing', 'mode'], value)} />
      {video.sizing.mode === 'video' && <div className="grid grid-cols-2 gap-3">{['width', 'height'].map((key) => <Label key={key} className="grid gap-2 capitalize">{key}<Input type="number" min={key === 'width' ? 320 : 420} max={key === 'width' ? 960 : 900} value={video.sizing[key]} onChange={(e) => update(['sizing', key], Number(e.target.value))} /></Label>)}</div>}
    </section>
    <section className="grid gap-4 border-t pt-5"><h3 className="font-semibold">Controls and notices</h3>
      <Choice label="Controls position" value={video.controls.position} options={{ bottom: 'Bottom', top: 'Top', overlay: 'Over the video' }} onChange={(value) => update(['controls', 'position'], value)} />
      {video.controls.position === 'overlay' && <><Choice label="Controls size" value={video.controls.overlay.size} options={{ compact: 'Compact', regular: 'Regular', large: 'Large' }} onChange={(value) => update(['controls', 'overlay', 'size'], value)} /><Label>Background opacity (%)<Input type="number" min={0} max={100} value={video.controls.overlay.opacity} onChange={(e) => update(['controls', 'overlay', 'opacity'], Number(e.target.value))} /></Label></>}
      <Toggle label="Show queue and agent notices" checked={video.notices.enabled} onChange={(value) => update(['notices', 'enabled'], value)} />
      <Label>Notice duration (seconds)<Input type="number" min={1} max={30} value={video.notices.seconds} onChange={(e) => update(['notices', 'seconds'], Number(e.target.value))} /></Label>
      <Toggle label="Record video calls" checked={video.recording.enabled} onChange={(value) => update(['recording', 'enabled'], value)} />
      <Choice label="Recording layout" value={video.recording.layout} options={{ pip: scenes.pip, split: scenes.split }} onChange={(value) => update(['recording', 'layout'], value)} />
    </section>
    <section className="grid gap-4 border-t pt-5"><h3 className="font-semibold">Waiting playlist</h3>
      <Choice label="Playback" value={video.waiting.mode} options={{ rotate: 'Play in order', loop: 'Loop first video' }} onChange={(value) => update(['waiting', 'mode'], value)} />
      <Toggle label="Play waiting audio" checked={video.waiting.sound} onChange={(value) => update(['waiting', 'sound'], value)} />
      <VideoWaitingPlaylist items={video.waiting.items} onChange={(items) => update(['waiting', 'items'], items)} />
    </section>
    <section className="grid gap-4 border-t pt-5"><h3 className="font-semibold">Video copy</h3>{['videoLabel', 'videoSubtitle', 'videoWaitingMessage', 'videoConnectingMessage', 'videoActiveMessage', 'videoEndedMessage', 'videoErrorMessage', 'joinVideoLabel', 'cameraOnLabel', 'cameraOffLabel'].map((key) => <Label key={key} className="grid gap-2">{key.replace(/([A-Z])/g, ' $1')}<Input value={config.content[key]} onChange={(e) => set(['content', key], e.target.value)} /></Label>)}</section>
  </div>;
}
