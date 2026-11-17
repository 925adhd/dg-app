// Vercel Routing Middleware: puts the whole site behind a shared tester
// password (HTTP Basic Auth). The password lives in the SITE_PASSWORD
// environment variable in Vercel, never in this public repo. If it isn't
// set, everyone is locked out rather than let in.
// The site icons skip the password: phones fetch icons without the login,
// so behind it they'd get an error page instead. The .ico and precomposed
// files are the default addresses tried when the page itself can't be read.
const OPEN_PATHS = new Set([
  '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png',
  '/favicon.svg', '/favicon-32.png', '/favicon.ico',
]);

export default function middleware(request) {
  if (OPEN_PATHS.has(new URL(request.url).pathname)) {
    return new Response(null, { headers: { 'x-middleware-next': '1' } });
  }
  const password = process.env.SITE_PASSWORD;
  const header = request.headers.get('authorization') || '';

  if (password && header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch (e) { /* malformed header */ }
    // Any username works — only the password is checked.
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (supplied === password) {
      return new Response(null, { headers: { 'x-middleware-next': '1' } });
    }
  }

  return new Response('Testers only.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="The Real Total (testers)", charset="UTF-8"',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
