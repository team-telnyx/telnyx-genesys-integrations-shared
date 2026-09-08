import { GENESYS_REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS } from './oauth-settings.mjs';

export function isInvalidGenesysTokenError(errorPayload) {
  if (!errorPayload) {
    return false;
  }

  if (typeof errorPayload === 'object') {
    return (
      errorPayload.code === 'bad.credentials' ||
      errorPayload.message === 'Invalid login credentials.' ||
      errorPayload.message === 'Invalid login credentials'
    );
  }

  const text = String(errorPayload);

  if (text.includes('bad.credentials') || text.includes('Invalid login credentials')) {
    return true;
  }

  try {
    return isInvalidGenesysTokenError(JSON.parse(text));
  } catch {
    return false;
  }
}

const PARTITIONED_COOKIE_SUFFIX = '_partitioned';

function partitionedCookieName(name) {
  return `${name}${PARTITIONED_COOKIE_SUFFIX}`;
}

export function genesysAuthCookieOptions({
  secure = true,
  maxAge,
  partitioned = secure,
} = {}) {
  const options = {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
  };

  if (secure && partitioned) options.partitioned = true;
  if (maxAge !== undefined) options.maxAge = maxAge;

  return options;
}

export function readGenesysAuthCookie(cookieStore, name) {
  return (
    cookieStore.get(partitionedCookieName(name))?.value ||
    cookieStore.get(name)?.value
  );
}

export function setGenesysAuthCookie(response, name, value, { secure = true, maxAge } = {}) {
  response.cookies.set(
    name,
    value,
    genesysAuthCookieOptions({ secure, maxAge, partitioned: false })
  );
  if (secure) {
    response.cookies.set(
      partitionedCookieName(name),
      value,
      genesysAuthCookieOptions({ secure, maxAge, partitioned: true })
    );
  }
  return response;
}

export function clearGenesysAuthCookie(response, name, { secure = true } = {}) {
  return setGenesysAuthCookie(response, name, '', { secure, maxAge: 0 });
}

export function clearGenesysAccessTokenCookie(response, { secure = true } = {}) {
  return clearGenesysAuthCookie(response, 'genesys_access_token', { secure });
}

export function setGenesysTokenCookies(response, tokenData, { secure = true } = {}) {
  setGenesysAuthCookie(response, 'genesys_access_token', tokenData.accessToken, {
    secure,
    maxAge: tokenData.accessTokenMaxAge,
  });
  if (tokenData.refreshToken) {
    setGenesysAuthCookie(response, 'genesys_refresh_token', tokenData.refreshToken, {
      secure,
      maxAge: GENESYS_REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return response;
}

export function clearGenesysAuthCookies(response, { secure = true } = {}) {
  clearGenesysAuthCookie(response, 'genesys_access_token', { secure });
  clearGenesysAuthCookie(response, 'genesys_refresh_token', { secure });

  return response;
}

export function buildGenesysReauthResponse(NextResponse, errorPayload, status = 401) {
  const response = NextResponse.json(
    {
      error: typeof errorPayload === 'string' ? errorPayload : JSON.stringify(errorPayload),
      reauthRequired: true,
    },
    { status }
  );

  // Keep the refresh token so the browser can silently recover and retry once.
  // The refresh endpoint clears both cookies if Genesys rejects that token.
  return clearGenesysAccessTokenCookie(response);
}
