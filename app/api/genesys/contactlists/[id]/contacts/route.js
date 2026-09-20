import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import {
  buildGenesysReauthResponse,
  isInvalidGenesysTokenError,
  readGenesysAuthCookie,
} from '../../../../../../lib/genesys/auth-cookies.mjs';
import { assertGenesysApiUrl } from '../../../../../../lib/genesys/api-origin.mjs';

// GET - Fetch contacts from export file URL
export async function GET(request, { params }) {
  const cookieStore = await cookies();
  const accessToken = readGenesysAuthCookie(cookieStore, 'genesys_access_token');
  
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  
  if (!url) {
    return NextResponse.json({ error: 'Export URL required' }, { status: 400 });
  }

  // The token below travels in the Authorization header, so the destination
  // cannot be whatever the caller asked for. Without this, a signed-in user
  // loading an attacker's page would have their Genesys token delivered to a
  // host of the attacker's choosing.
  let exportUrl;
  try {
    exportUrl = assertGenesysApiUrl(url);
  } catch (error) {
    return NextResponse.json({ error: `Export URL rejected: ${error.message}` }, { status: 400 });
  }

  try {
    const response = await fetch(exportUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, response.status);
      }
      return NextResponse.json({ error }, { status: response.status });
    }

    const csvText = await response.text();
    
    // Parse CSV to JSON
    const lines = csvText.trim().split('\n');
    if (lines.length === 0) {
      return NextResponse.json({ contacts: [] });
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const contacts = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const contact = {};
      headers.forEach((header, idx) => {
        contact[header] = values[idx] || '';
      });
      contacts.push(contact);
    }

    return NextResponse.json({ contacts });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Helper function to parse CSV line (handles quoted values)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

// PUT - Update a contact
export async function PUT(request, { params }) {
  const cookieStore = await cookies();
  const accessToken = readGenesysAuthCookie(cookieStore, 'genesys_access_token');
  
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const { contactId, contact } = body;

  if (!contactId || !contact) {
    return NextResponse.json({ error: 'contactId and contact required' }, { status: 400 });
  }

  const environment = process.env.GC_ENVIRONMENT || 'usw2.pure.cloud';

  try {
    const response = await fetch(
      `https://api.${environment}/api/v2/outbound/contactlists/${id}/contacts/${contactId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(contact)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 401 && isInvalidGenesysTokenError(error)) {
        return buildGenesysReauthResponse(NextResponse, error, response.status);
      }
      return NextResponse.json({ error }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating contact:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
