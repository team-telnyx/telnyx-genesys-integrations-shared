import { NextResponse } from 'next/server'
import { readGenesysAuthCookie } from '@/lib/genesys/auth-cookies.mjs'

export function proxy(request) {
  // Check protected paths
  const protectedPaths = ['/sms', '/number-lookup', '/sms-campaign', '/number-lookup-campaign', '/genesys/ai-conversation-widget'];
  const isProtected = protectedPaths.some(path => 
    request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(path + '/')
  );
  
  if (isProtected) {
    // Check for access token cookie
    const token = readGenesysAuthCookie(request.cookies, 'genesys_access_token')

    if (!token) {
      const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`
      const refreshToken = readGenesysAuthCookie(request.cookies, 'genesys_refresh_token')
      if (refreshToken) {
        const refreshUrl = new URL('/api/auth/refresh', request.url)
        refreshUrl.searchParams.set('returnTo', returnTo)
        return NextResponse.redirect(refreshUrl)
      }
      // Redirect to login, passing the current path as returnTo
      const loginUrl = new URL('/api/auth/login', request.url)
      loginUrl.searchParams.set('returnTo', returnTo)
      return NextResponse.redirect(loginUrl)
    }
  }
  
  const response = NextResponse.next()
  if (request.nextUrl.pathname.startsWith('/genesys/ai-conversation-widget')) {
    response.headers.set(
      'Content-Security-Policy',
      "frame-ancestors https://*.pure.cloud https://*.mypurecloud.com https://*.mypurecloud.ie https://*.mypurecloud.de https://*.mypurecloud.jp https://*.mypurecloud.com.au https://*.mypurecloud.ca https://*.mypurecloud.com.br"
    )
    response.headers.set('Referrer-Policy', 'no-referrer')
  }
  return response
}

export const config = {
  matcher: ['/sms/:path*', '/number-lookup/:path*', '/sms-campaign/:path*', '/number-lookup-campaign/:path*', '/genesys/ai-conversation-widget/:path*'],
}
