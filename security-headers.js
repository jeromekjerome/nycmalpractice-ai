// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// Standard browser protections on every response: a content security policy (scripts, styles and fonts only
// from this site and the services the privacy policy names, no plugins, no framing by other sites), no MIME
// sniffing, a strict referrer policy, no camera, microphone or location, and HTTPS only. The site sent none.
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    // 'unsafe-inline': the pages carry small inline scripts (the analytics loader, page logic, onclick handlers).
    "script-src 'self' 'unsafe-inline' https://cdn.mxpnl.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api-js.mixpanel.com https://api.mixpanel.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
});

export function securityHeaders(_req, res, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}
