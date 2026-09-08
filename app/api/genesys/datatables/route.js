import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import {
  buildGenesysReauthResponse,
  isInvalidGenesysTokenError,
  readGenesysAuthCookie,
} from '../../../../lib/genesys/auth-cookies.mjs';

export async function GET(request) {
  const cookieStore = await cookies();
  const accessToken = readGenesysAuthCookie(cookieStore, 'genesys_access_token');
  
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const tableName = searchParams.get('name');
  
  if (!tableName) {
    return NextResponse.json({ error: 'Table name required' }, { status: 400 });
  }

  const environment = process.env.GC_ENVIRONMENT || 'usw2.pure.cloud';

  try {
    // First, find the table by name
    const tablesResponse = await fetch(
      `https://api.${environment}/api/v2/flows/datatables?name=${encodeURIComponent(tableName)}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!tablesResponse.ok) {
      const error = await tablesResponse.text();
      if (tablesResponse.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, tablesResponse.status);
      }
      return NextResponse.json({ error }, { status: tablesResponse.status });
    }

    const tables = await tablesResponse.json();
    
    if (!tables.entities || tables.entities.length === 0) {
      return NextResponse.json({ entities: [], message: `Table '${tableName}' not found` });
    }

    const tableId = tables.entities[0].id;

    // Now get the rows
    const rowsResponse = await fetch(
      `https://api.${environment}/api/v2/flows/datatables/${tableId}/rows?pageSize=100`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!rowsResponse.ok) {
      const error = await rowsResponse.text();
      if (rowsResponse.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, rowsResponse.status);
      }
      return NextResponse.json({ error }, { status: rowsResponse.status });
    }

    const rows = await rowsResponse.json();
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Error fetching datatable rows:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
