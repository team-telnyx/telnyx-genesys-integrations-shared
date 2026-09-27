"use client";

import { Video } from 'lucide-react';
import GenesysThemeToggle from '@/components/genesys/GenesysThemeToggle';
import { VideoLayoutSwitch } from '@/components/video/VideoStage';

export default function GenesysVideoHeader({ queueName = 'Genesys Cloud', status, layout, onLayoutChange, defaultTheme = 'light' }) {
  return <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
    <div className="min-w-0 flex-1 basis-52">
      <h1 className="flex items-center gap-2 font-semibold"><Video className="size-5 shrink-0" />Telnyx Video</h1>
      <p className="break-words text-xs text-muted-foreground">{queueName} · {status}</p>
    </div>
    <div className="flex max-w-full flex-wrap items-center gap-3" aria-label="Video display controls">
      <VideoLayoutSwitch layout={layout} onChange={onLayoutChange} className="shrink-0" />
      <GenesysThemeToggle defaultTheme={defaultTheme} variant="toolbar" />
    </div>
  </header>;
}
