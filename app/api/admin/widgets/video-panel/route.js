import { NextResponse } from 'next/server';
import { requireWidgetAdmin } from '@/lib/genesys/admin-auth';
import { getGenesysAccessToken, getIntegrationsApi } from '@/lib/genesys/client';
import { panelSettingsApi, readVideoPanelStatus } from '@/lib/genesys/video-panel-settings.mjs';

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  const queueId = new URL(request.url).searchParams.get('queueId');
  if (!/^[0-9a-f-]{36}$/i.test(queueId || '')) return NextResponse.json({ error: 'Select a Genesys queue' }, { status: 400 });
  try {
    const result = await readVideoPanelStatus({
      settingsApi: panelSettingsApi({ environment: process.env.GC_ENVIRONMENT, accessToken: await getGenesysAccessToken() }),
      integrationsApi: await getIntegrationsApi(), baseUrl: process.env.GC_PUBLIC_BASE_URL, queueId,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error.message || 'Unable to read Genesys panel settings' }, { status: [400, 403, 409, 502].includes(error.status) ? error.status : 502 });
  }
}
