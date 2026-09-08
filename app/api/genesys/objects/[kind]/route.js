import { NextResponse } from 'next/server';

import {
  getArchitectApi,
  getGroupsApi,
  getOutboundApi,
  getRoutingApi,
  getUsersApi,
} from '@/lib/genesys/client';

function toErrorResponse(error) {
  const status = error?.status || error?.statusCode || 500;
  const message = error?.body?.message || error?.message || 'Genesys object lookup failed';
  return NextResponse.json({ error: message }, { status });
}

function normalizeEntity(entity) {
  return {
    id: entity.id,
    name: entity.name || entity.displayName || entity.username || entity.id,
    description: entity.description || entity.email || entity.state || '',
  };
}

async function lookupObjects(kind, query) {
  const pageSize = Math.min(Number(query.get('pageSize') || 100), 250);
  const name = query.get('q') || query.get('name') || undefined;

  switch (kind) {
    case 'queues': {
      const api = await getRoutingApi();
      return api.getRoutingQueues({ pageSize, pageNumber: 1, name, sortOrder: 'ascending' });
    }
    case 'users': {
      const api = await getUsersApi();
      return api.getUsers({ pageSize, pageNumber: 1, state: 'active', sortOrder: 'ASC' });
    }
    case 'flows': {
      const api = await getArchitectApi();
      return api.getFlows({ pageSize, pageNumber: 1, name, deleted: false, sortBy: 'name', sortOrder: 'ascending' });
    }
    case 'architectPrompts': {
      const api = await getArchitectApi();
      return api.getArchitectPrompts({ pageSize, pageNumber: 1, nameOrDescription: name, sortBy: 'name', sortOrder: 'ascending' });
    }
    case 'outboundContactLists': {
      const api = await getOutboundApi();
      return api.getOutboundContactlists({ pageSize, pageNumber: 1, name, includeSize: true, sortBy: 'name', sortOrder: 'ascending' });
    }
    case 'outboundCampaigns': {
      const api = await getOutboundApi();
      return api.getOutboundCampaigns({ pageSize, pageNumber: 1, name, sortBy: 'name', sortOrder: 'ascending' });
    }
    case 'outboundMessagingCampaigns': {
      const api = await getOutboundApi();
      return api.getOutboundMessagingcampaigns({ pageSize, pageNumber: 1, name, sortBy: 'name', sortOrder: 'ascending' });
    }
    case 'groups': {
      const api = await getGroupsApi();
      return api.getGroups({ pageSize, pageNumber: 1, sortOrder: 'ASC' });
    }
    default:
      return { entities: [], unsupported: true };
  }
}

export async function GET(request, { params }) {
  try {
    const { kind } = await params;
    const query = new URL(request.url).searchParams;
    const response = await lookupObjects(kind, query);
    const entities = (response.entities || []).map(normalizeEntity).filter((entity) => entity.id);
    return NextResponse.json({
      kind,
      unsupported: Boolean(response.unsupported),
      entities,
      count: entities.length,
      total: response.total || response.totalHits || response.pageSize || entities.length,
    });
  } catch (error) {
    console.error('Error fetching Genesys objects:', error);
    return toErrorResponse(error);
  }
}
