"use client";

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Film, Loader2, Trash2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { genesysAuthenticatedFetch } from '@/lib/genesys/admin-client-auth';

const MAX_ITEMS = 10;
const MAX_BYTES = 64 * 1048576;
const formatBytes = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function VideoWaitingPlaylist({ items, onChange }) {
  const [library, setLibrary] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState('');
  const fileRef = useRef(null);
  const mounted = useRef(false);
  const latest = useRef({ items, onChange });
  useEffect(() => { latest.current = { items, onChange }; }, [items, onChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    genesysAuthenticatedFetch('/api/admin/widgets/video-media', { cache: 'no-store' }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load the media library');
      if (active) setLibrary(body.media);
    }).catch((failure) => { if (active) setLoadError(failure.message); });
    return () => { active = false; };
  }, [attempt]);

  const update = (next) => onChange(next.slice(0, MAX_ITEMS));
  const addFromLibrary = (media) => {
    const current = latest.current;
    if (current.items.length < MAX_ITEMS) current.onChange([...current.items, { source: 'library', url: '', mediaId: media.id, label: media.name.slice(0, 120) }]);
  };
  let linkValid = false;
  try { const url = new URL(link.trim()); linkValid = url.protocol === 'https:' && Boolean(url.hostname); } catch { /* Wait for a complete URL. */ }
  const addLink = () => {
    if (!linkValid || items.length >= MAX_ITEMS) return;
    update([...items, { source: 'url', url: link.trim(), mediaId: '', label: '' }]); setLink('');
  };
  const move = (index, delta) => {
    const next = [...items]; const [item] = next.splice(index, 1); next.splice(index + delta, 0, item); update(next);
  };
  const upload = async (file) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { setError('Video exceeds the 64 MB limit'); if (fileRef.current) fileRef.current.value = ''; return; }
    setUploading(true); setError('');
    try {
      const form = new FormData(); form.append('file', file);
      const response = await genesysAuthenticatedFetch('/api/admin/widgets/video-media', { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Video upload failed');
      if (!mounted.current) return;
      setLibrary((current) => [body.media, ...(current || [])]);
      addFromLibrary(body.media);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) { setUploading(false); if (fileRef.current) fileRef.current.value = ''; } }
  };
  const remove = async (media) => {
    if (!window.confirm(`Delete "${media.name}" from the media library?`)) return;
    setDeleting(media.id); setError('');
    try {
      const response = await genesysAuthenticatedFetch(`/api/admin/widgets/video-media/${media.id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to delete the video');
      if (mounted.current) setLibrary((current) => current.filter((entry) => entry.id !== media.id));
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setDeleting(''); }
  };

  return <div className="grid min-w-0 gap-4">
    <div className="grid min-w-0 gap-2">
      <Label>Playlist ({items.length}/{MAX_ITEMS})</Label>
      {items.length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">Add videos to play while the visitor waits for an agent.</p>}
      <ol className="grid min-w-0 gap-2">
        {items.map((item, index) => <li key={index} className="grid min-w-0 gap-2 rounded-lg border p-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">{index + 1}</span>
            <Input aria-label={`Video ${index + 1} label`} maxLength={120} placeholder="Video label" value={item.label} onChange={(event) => update(items.map((old, i) => i === index ? { ...old, label: event.target.value } : old))} />
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={index === 0} aria-label={`Move video ${index + 1} up`} onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={index === items.length - 1} aria-label={`Move video ${index + 1} down`} onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Remove video ${index + 1} from playlist`} onClick={() => update(items.filter((_, i) => i !== index))}><Trash2 className="size-3.5" /></Button>
          </div>
          {item.source === 'url'
            ? <Input aria-label={`Video ${index + 1} URL`} value={item.url} onChange={(event) => update(items.map((old, i) => i === index ? { ...old, url: event.target.value } : old))} />
            : <a className="truncate text-xs underline" href={`/api/video/media/${item.mediaId}`} target="_blank" rel="noreferrer">Preview uploaded video</a>}
        </li>)}
      </ol>
    </div>
    <div className="grid gap-1.5">
      <Label htmlFor="waiting-video-url">Add a link</Label>
      <div className="flex gap-2">
        <Input id="waiting-video-url" value={link} placeholder="https://example.com/waiting.mp4" onChange={(event) => setLink(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addLink(); } }} />
        <Button type="button" variant="outline" disabled={!linkValid || items.length >= MAX_ITEMS} onClick={addLink}>Add link</Button>
      </div>
    </div>
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Media library</Label>
        <input ref={fileRef} type="file" accept="video/mp4,video/webm,.mp4,.webm" className="hidden" aria-label="Upload waiting video" onChange={(event) => void upload(event.target.files?.[0])} />
        <Button type="button" variant="outline" size="sm" disabled={uploading || library === null} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />}{uploading ? 'Uploading…' : 'Upload video'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">MP4 or WebM, up to 64 MB per file. Uploads are added to this playlist when space is available and can be reused across your widgets. Save and publish to update the visitor experience.</p>
      {loadError ? <div role="alert" className="grid gap-2 text-xs text-destructive">{loadError}<Button type="button" variant="outline" onClick={() => { setLoadError(''); setAttempt((value) => value + 1); }}>Retry library</Button></div>
        : library === null ? <div aria-label="Loading video library" className="grid gap-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        : library.length === 0 ? <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No uploaded videos yet.</p>
        : <ul className="grid min-w-0 gap-2">{library.map((media) => <li key={media.id} className="flex min-w-0 items-center gap-2 rounded-lg border p-2 text-xs">
          <Film className="size-4 shrink-0 text-muted-foreground" />
          <a className="min-w-0 flex-1 truncate underline" href={media.url} title={media.name} target="_blank" rel="noreferrer">{media.name}</a>
          <span className="shrink-0 text-muted-foreground">{formatBytes(media.byteSize)}</span>
          <Button type="button" variant="outline" size="sm" disabled={items.length >= MAX_ITEMS || deleting === media.id} aria-label={`Add ${media.name} to playlist`} onClick={() => addFromLibrary(media)}>Add</Button>
          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={Boolean(deleting) || items.some((item) => item.mediaId === media.id)} aria-label={`Delete ${media.name} from library`} onClick={() => void remove(media)}>{deleting === media.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}</Button>
        </li>)}</ul>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
