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

  const environment = process.env.GC_ENVIRONMENT || 'usw2.pure.cloud';

  try {
    const response = await fetch(`https://api.${environment}/api/v2/conversations`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

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
    console.error('Error fetching conversations:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
