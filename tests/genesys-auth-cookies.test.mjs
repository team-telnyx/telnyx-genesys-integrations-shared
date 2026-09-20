import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server.js';

import {
  clearGenesysAuthCookies,
  clearGenesysAccessTokenCookie,
  genesysAuthCookieOptions,
  isInvalidGenesysTokenError,
  readGenesysAuthCookie,
  setGenesysAuthCookie,
  setGenesysTokenCookies,
} from '../lib/genesys/auth-cookies.mjs';
import {
  genesysOauthBaseUrl,
  genesysOauthCallbackUrl,
} from '../lib/genesys/oauth-public-origin.mjs';
import {
  createGenesysOauthHandoff,
  verifyGenesysOauthHandoff,
} from '../lib/genesys/oauth-handoff.mjs';

function requestWithHeaders(values = {}) {
  return { headers: new Headers(values) };
}

test('Genesys OAuth uses the configured HTTPS origin behind an HTTP reverse proxy', () => {
  const request = requestWithHeaders({
    host: '127.0.0.1:3000',
    'x-forwarded-host': 'tunnel.example.com',
    'x-forwarded-proto': 'http',
  });

  assert.equal(
    genesysOauthBaseUrl(request, 'https://tunnel.example.com'),
    'https://tunnel.example.com'
  );
  assert.equal(
    genesysOauthCallbackUrl(request, 'https://tunnel.example.com'),
    'https://tunnel.example.com/api/auth/callback'
  );
});

test('Genesys OAuth rejects a non-HTTPS configured public origin', () => {
  const request = requestWithHeaders({ host: 'localhost:3000' });
  assert.throws(
    () => genesysOauthBaseUrl(request, 'http://tunnel.example.com'),
    /public HTTPS origin/
  );
});

function createCookieRecorder() {
  const cleared = [];
  return {
    cleared,
    cookies: {
      set(name, value, options) {
        cleared.push({ name, value, options });
      },
    },
  };
}

test('isInvalidGenesysTokenError recognizes Genesys bad.credentials payloads', () => {
  assert.equal(
    isInvalidGenesysTokenError('{"message":"Invalid login credentials.","code":"bad.credentials","status":401}'),
    true
  );
  assert.equal(isInvalidGenesysTokenError('Invalid login credentials.'), true);
  assert.equal(isInvalidGenesysTokenError('{"code":"not.found","status":404}'), false);
});

test('Genesys OAuth cookies are partitioned for secure embedded contexts', () => {
  assert.deepEqual(genesysAuthCookieOptions({ secure: true, maxAge: 600 }), {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    partitioned: true,
    maxAge: 600,
  });
});

test('Genesys OAuth cookies remain usable during local HTTP development', () => {
  assert.deepEqual(genesysAuthCookieOptions({ secure: false, maxAge: 600 }), {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
});

test('secure Genesys auth writes standard and top-level-site-partitioned cookies', () => {
  const response = createCookieRecorder();

  setGenesysAuthCookie(response, 'genesys_access_token', 'token', {
    secure: true,
    maxAge: 3600,
  });

  assert.deepEqual(
    response.cleared.map((cookie) => cookie.name),
    ['genesys_access_token', 'genesys_access_token_partitioned']
  );
  assert.equal(response.cleared[0].options.partitioned, undefined);
  assert.equal(response.cleared[1].options.partitioned, true);
  assert.equal(response.cleared[1].options.sameSite, 'none');
  assert.equal(response.cleared[1].options.secure, true);
});

test('Next.js serializes the embedded OAuth cookie with the Partitioned attribute', () => {
  const response = NextResponse.json({ ok: true });

  setGenesysAuthCookie(response, 'genesys_oauth_state', 'state', {
    secure: true,
    maxAge: 600,
  });

  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.match(setCookies[0], /^genesys_oauth_state=state;/);
  assert.match(setCookies[1], /^genesys_oauth_state_partitioned=state;/);
  assert.match(setCookies[1], /; Partitioned$/);
});

test('Genesys auth reads the cookie belonging to the current top-level partition first', () => {
  const values = new Map([
    ['genesys_access_token', { value: 'legacy-token' }],
    ['genesys_access_token_partitioned', { value: 'embedded-token' }],
  ]);
  const cookieStore = { get: (name) => values.get(name) };

  assert.equal(
    readGenesysAuthCookie(cookieStore, 'genesys_access_token'),
    'embedded-token'
  );

  values.delete('genesys_access_token_partitioned');
  assert.equal(
    readGenesysAuthCookie(cookieStore, 'genesys_access_token'),
    'legacy-token'
  );
});

test('clearGenesysAuthCookies expires access and refresh token cookies for the whole app', () => {
  const response = createCookieRecorder();

  clearGenesysAuthCookies(response);

  assert.deepEqual(
    response.cleared.map((cookie) => cookie.name),
    [
      'genesys_access_token',
      'genesys_access_token_partitioned',
      'genesys_refresh_token',
      'genesys_refresh_token_partitioned',
    ]
  );
  for (const cookie of response.cleared) {
    assert.equal(cookie.value, '');
    assert.equal(cookie.options.path, '/');
    assert.equal(cookie.options.maxAge, 0);
    assert.equal(cookie.options.secure, true);
    assert.equal(cookie.options.sameSite, 'none');
    assert.equal(
      cookie.options.partitioned,
      cookie.name.endsWith('_partitioned') ? true : undefined
    );
  }
});

test('an expired access token is cleared without discarding the refresh token', () => {
  const response = createCookieRecorder();

  clearGenesysAccessTokenCookie(response);

  assert.deepEqual(
    response.cleared.map((cookie) => cookie.name),
    ['genesys_access_token', 'genesys_access_token_partitioned']
  );
});

test('Genesys token responses rotate both partition-aware auth cookies', () => {
  const response = createCookieRecorder();

  setGenesysTokenCookies(response, {
    accessToken: 'access-next',
    refreshToken: 'refresh-next',
    accessTokenMaxAge: 86400,
  });

  assert.deepEqual(
    response.cleared.map((cookie) => cookie.name),
    [
      'genesys_access_token',
      'genesys_access_token_partitioned',
      'genesys_refresh_token',
      'genesys_refresh_token_partitioned',
    ]
  );
  assert.equal(response.cleared[0].options.maxAge, 86400);
  assert.equal(response.cleared[2].options.maxAge, 30 * 24 * 60 * 60);
});

test('OAuth routes use shared partition-aware cookie options', () => {
  const loginSource = readFileSync(
    join(process.cwd(), 'app/api/auth/login/route.js'),
    'utf8'
  );
  const callbackSource = readFileSync(
    join(process.cwd(), 'app/api/auth/callback/route.js'),
    'utf8'
  );

  assert.match(loginSource, /setGenesysAuthCookie/);
  assert.match(callbackSource, /readGenesysAuthCookie/);
  assert.match(callbackSource, /setGenesysTokenCookies/);
  assert.match(callbackSource, /clearGenesysAuthCookie/);
  assert.match(callbackSource, /createGenesysOauthHandoff/);
  assert.doesNotMatch(callbackSource, /postMessage\(\{type:"genesys-auth-complete"\}/);
});

test('popup OAuth transfers tokens through a short-lived authenticated encrypted handoff', () => {
  const previous = process.env.ADMIN_SECRETS_MASTER_KEY;
  process.env.ADMIN_SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const handoff = createGenesysOauthHandoff({
      accessToken: 'access-sensitive',
      refreshToken: 'refresh-sensitive',
      accessTokenMaxAge: 3600,
      now: 1_000_000,
    });
    assert.doesNotMatch(handoff, /access-sensitive|refresh-sensitive/);
    assert.deepEqual(
      verifyGenesysOauthHandoff(handoff, { now: 1_030_000 }),
      {
        typ: 'genesys-oauth-handoff',
        accessToken: 'access-sensitive',
        refreshToken: 'refresh-sensitive',
        accessTokenMaxAge: 3600,
        exp: 1060,
      }
    );
    assert.throws(
      () => verifyGenesysOauthHandoff(handoff, { now: 1_061_000 }),
      /Expired Genesys OAuth handoff/
    );
  } finally {
    if (previous === undefined) delete process.env.ADMIN_SECRETS_MASTER_KEY;
    else process.env.ADMIN_SECRETS_MASTER_KEY = previous;
  }
});

test('cookie-authenticated Genesys API routes clear stale access and preserve refresh recovery on bad credentials', () => {
  const routeFiles = [
    'app/api/genesys/contactlists/route.js',
    'app/api/genesys/queues/route.js',
    'app/api/genesys/conversations/route.js',
    'app/api/genesys/response-libraries/route.js',
    'app/api/genesys/responses/route.js',
    'app/api/genesys/datatables/route.js',
    'app/api/genesys/contactlists/[id]/export/route.js',
    'app/api/genesys/contactlists/[id]/contacts/route.js',
    'app/api/campaign/start/route.js',
  ];

  for (const routeFile of routeFiles) {
    const source = readFileSync(join(process.cwd(), routeFile), 'utf8');
    assert.match(source, /isInvalidGenesysTokenError/, routeFile);
    assert.match(source, /buildGenesysReauthResponse/, routeFile);
    assert.match(source, /readGenesysAuthCookie/, routeFile);
  }

  assert.match(
    readFileSync(join(process.cwd(), 'lib/genesys/auth-cookies.mjs'), 'utf8'),
    /reauthRequired\s*:\s*true/
  );
  assert.match(
    readFileSync(join(process.cwd(), 'lib/genesys/auth-cookies.mjs'), 'utf8'),
    /return clearGenesysAccessTokenCookie\(response\)/
  );
});

test('protected pages and browser API requests attempt one silent refresh before login', () => {
  const proxySource = readFileSync(join(process.cwd(), 'proxy.js'), 'utf8');
  const clientSource = readFileSync(
    join(process.cwd(), 'lib/genesys/admin-client-auth.js'),
    'utf8'
  );
  const refreshSource = readFileSync(
    join(process.cwd(), 'app/api/auth/refresh/route.js'),
    'utf8'
  );

  assert.match(proxySource, /readGenesysAuthCookie/);
  assert.match(proxySource, /genesys_refresh_token/);
  assert.match(proxySource, /\/api\/auth\/refresh/);
  assert.match(clientSource, /response\.status !== 401/);
  assert.match(clientSource, /refreshRequestPending/);
  assert.match(refreshSource, /grant|refreshGenesysTokens/);
  assert.match(refreshSource, /setGenesysTokenCookies/);
});

test('sms campaign UI redirects to Genesys login when an API reports reauthRequired', () => {
  const source = readFileSync(
    join(process.cwd(), 'components/sms-campaign/SmsCampaignForm.jsx'),
    'utf8'
  );

  assert.match(source, /handleGenesysReauthRequired/);
  assert.match(source, /reauthRequired/);
  assert.match(source, /\/api\/auth\/login\?returnTo=/);
});

test('campaign contact preview waits for async Genesys export URI and passes clicked row directly', () => {
  const campaignFiles = [
    'components/sms-campaign/SmsCampaignForm.jsx',
    'components/number-lookup-campaign/NlCampaignForm.jsx',
  ];

  for (const file of campaignFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');

    assert.match(source, /const\s+waitForContactListExportUri\s*=\s*async\s*\(listId\)/, file);
    assert.match(source, /no\.available\.list\.export\.uri/, file);
    assert.match(source, /for\s*\(let\s+attempt\s*=\s*1;\s*attempt\s*<=\s*10;\s*attempt\s*\+=\s*1\)/, file);
    assert.match(source, /const\s+handlePreviewContacts\s*=\s*async\s*\(list\s*=\s*selectedContactList\)/, file);
    assert.match(source, /handlePreviewContacts\(list\)/, file);
    assert.doesNotMatch(source, /handleRowClick\(list\)\.then\(\(\)\s*=>\s*handlePreviewContacts\(\)\)/, file);
  }
});
