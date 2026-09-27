import { NextResponse } from 'next/server';
import { requireWidgetAdmin } from '@/lib/genesys/admin-auth';
import { getRoutingApi } from '@/lib/genesys/client';
export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const api = await getRoutingApi();
    const entities = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
      const page = await api.getRoutingQueues({ pageNumber, pageSize: 100 });
      entities.push(...(page.entities || []).map(({ id, name }) => ({ id, name })));
      if (!page.nextUri) return NextResponse.json({ entities }, { headers: { 'Cache-Control': 'no-store' } });
    }
    throw new Error('Too many Genesys queues');
  } catch (error) { return NextResponse.json({ error: 'Unable to load Genesys Cloud queues' }, { status: Number(error.status || 500) }); }
}
