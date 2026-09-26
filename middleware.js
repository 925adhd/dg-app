// Vercel Routing Middleware: puts the whole site behind a shared tester
// password (HTTP Basic Auth). The password lives in the SITE_PASSWORD
// environment variable in Vercel, never in this public repo. If it isn't
// set, everyone is locked out rather than let in.
export default function middleware(request) {
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
