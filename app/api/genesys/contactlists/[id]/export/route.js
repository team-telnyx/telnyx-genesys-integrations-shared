import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import {
  buildGenesysReauthResponse,
  isInvalidGenesysTokenError,
  readGenesysAuthCookie,
} from '../../../../../../lib/genesys/auth-cookies.mjs';

// POST - Create export
export async function POST(request, { params }) {
  const cookieStore = await cookies();
  const accessToken = readGenesysAuthCookie(cookieStore, 'genesys_access_token');
  
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const environment = process.env.GC_ENVIRONMENT || 'usw2.pure.cloud';

  try {
    const response = await fetch(
      `https://api.${environment}/api/v2/outbound/contactlists/${id}/export`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, response.status);
      }
      return NextResponse.json({ error }, { status: response.status });
    }

    // Export started successfully (usually returns 202 with no body or empty body)
    let data = {};
    try {
      const text = await response.text();
      if (text) {
        data = JSON.parse(text);
      }
    } catch (e) {
      // No JSON body is fine
    }
    
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error('Error creating contact list export:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// GET - Get export URI or download file
export async function GET(request, { params }) {
  const cookieStore = await cookies();
  const accessToken = readGenesysAuthCookie(cookieStore, 'genesys_access_token');
  
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const download = searchParams.get('download') || 'false';
  
  const environment = process.env.GC_ENVIRONMENT || 'usw2.pure.cloud';

  try {
    const response = await fetch(
      `https://api.${environment}/api/v2/outbound/contactlists/${id}/export?download=${download}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, response.status);
      }
      return NextResponse.json({ error }, { status: response.status });
    }

    // If download=true, Genesys redirects to the file
    // If download=false, returns JSON with uri
    const contentType = response.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return NextResponse.json(data);
    } else {
      // It's the CSV file
      const text = await response.text();
      return new NextResponse(text, {
        headers: {
          'Content-Type': 'text/csv'
        }
      });
    }
  } catch (error) {
    console.error('Error getting contact list export:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
