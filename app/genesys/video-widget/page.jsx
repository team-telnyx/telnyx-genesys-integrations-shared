import { Suspense } from 'react';
import GenesysVideoWidget, { VideoWidgetSkeleton } from '@/components/genesys-video/GenesysVideoWidget';
export const metadata = { title: 'Telnyx Video | Genesys Cloud' };
export default function GenesysVideoPage() {
  return <Suspense fallback={<VideoWidgetSkeleton />}><GenesysVideoWidget defaultTheme={process.env.NEXT_PUBLIC_GENESYS_APP_THEME || 'light'} /></Suspense>;
}
