import { Router } from 'express';

// No build step, no framework — a handful of vanilla HTML+JS pages, proportionate to
// what this service needs today. Not the React app in platform/frontend: different
// deploy target, different audience (customers, not focusKube's own cluster-explorer UI).
const styles = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; color: #1a1f26; background: #fafbfc; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } input { background: #161b22; color: #e6edf3; border-color: #30363d; } }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.sub { color: #6b7785; margin-top: 0; font-size: 14px; }
  form { display: grid; gap: 12px; margin-top: 20px; }
  label { display: grid; gap: 6px; font-size: 13px; }
  input { padding: 8px 10px; border-radius: 6px; border: 1px solid #d0d7de; font-size: 14px; }
  button { padding: 9px 14px; border-radius: 6px; border: none; background: #1f6feb; color: white; font-size: 14px; cursor: pointer; }
  button.secondary { background: transparent; border: 1px solid #d0d7de; color: inherit; }
  .error { background: #fff1f0; border: 1px solid #ffccc7; color: #a8071a; padding: 10px; border-radius: 6px; font-size: 13px; }
  .links { margin-top: 16px; font-size: 13px; }
  a { color: #1f6feb; }
  .license-box { font-family: ui-monospace, monospace; background: #f0f2f4; border-radius: 6px; padding: 10px; word-break: break-all; font-size: 13px; }
  @media (prefers-color-scheme: dark) { .license-box { background: #161b22; } }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — focusKube</title><style>${styles}</style></head><body>${body}</body></html>`;
}

const router = Router();
export const webRouter = router;

router.get('/signup', (_req, res) => {
  res.type('html').send(
    page(
      'Sign up',
      `
    <h1>Create your focusKube account</h1>
    <p class="sub">Get a license key for the AI assistant.</p>
    <div id="err"></div>
    <form id="f">
      <label>Email <input type="email" name="email" required autocomplete="email"></label>
      <label>Password <input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
      <button type="submit">Sign up</button>
    </form>
    <form action="/v1/auth/google/start" method="get">
      <button type="submit" class="secondary">Continue with Google</button>
    </form>
    <div class="links"><a href="/login">Already have an account? Log in</a></div>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/v1/auth/signup', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) { document.getElementById('err').innerHTML = '<div class="error">' + data.error + '</div>'; return; }
        location.href = '/dashboard';
      });
    </script>
  `,
    ),
  );
});

router.get('/login', (_req, res) => {
  res.type('html').send(
    page(
      'Log in',
      `
    <h1>Log in to focusKube</h1>
    <div id="err"></div>
    <form id="f">
      <label>Email <input type="email" name="email" required autocomplete="email"></label>
      <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
      <button type="submit">Log in</button>
    </form>
    <form action="/v1/auth/google/start" method="get">
      <button type="submit" class="secondary">Continue with Google</button>
    </form>
    <div class="links"><a href="/signup">Need an account? Sign up</a> &middot; <a href="/forgot-password">Forgot password?</a> &middot; <a href="/otp">Sign in with a code</a></div>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/v1/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) { document.getElementById('err').innerHTML = '<div class="error">' + data.error + '</div>'; return; }
        location.href = '/dashboard';
      });
    </script>
  `,
    ),
  );
});

router.get('/forgot-password', (_req, res) => {
  res.type('html').send(
    page(
      'Forgot password',
      `
    <h1>Reset your password</h1>
    <p class="sub">We'll email you a reset link if the account exists.</p>
    <div id="msg"></div>
    <form id="f">
      <label>Email <input type="email" name="email" required autocomplete="email"></label>
      <button type="submit">Send reset link</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        await fetch('/v1/auth/password/reset-request', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        document.getElementById('msg').innerHTML = '<p>If that email is registered, a reset link is on its way.</p>';
      });
    </script>
  `,
    ),
  );
});

router.get('/reset-password', (req, res) => {
  const rawToken = typeof req.query.token === 'string' ? req.query.token : '';
  const escapedToken = rawToken.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.type('html').send(
    page(
      'Reset password',
      `
    <h1>Set a new password</h1>
    <div id="err"></div>
    <form id="f">
      <input type="hidden" name="token" value="${escapedToken}">
      <label>New password <input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
      <button type="submit">Reset password</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/v1/auth/password/reset-confirm', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) { document.getElementById('err').innerHTML = '<div class="error">' + data.error + '</div>'; return; }
        location.href = '/login';
      });
    </script>
  `,
    ),
  );
});

router.get('/otp', (_req, res) => {
  res.type('html').send(
    page(
      'Sign in with a code',
      `
    <h1>Sign in with a code</h1>
    <p class="sub">Enter an email or phone number and we'll send a one-time code.</p>
    <div id="err"></div>
    <form id="request-form">
      <label>Email or phone <input type="text" name="destination" required placeholder="you@example.com or +15551234567"></label>
      <button type="submit">Send code</button>
    </form>
    <form id="verify-form" style="display:none">
      <p class="sub" id="sent-to"></p>
      <label>Code <input type="text" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autocomplete="one-time-code"></label>
      <button type="submit">Verify</button>
    </form>
    <div class="links"><a href="/login">Use a password instead</a></div>
    <script>
      let destination = '', channel = 'email';
      const requestForm = document.getElementById('request-form');
      const verifyForm = document.getElementById('verify-form');
      requestForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        destination = data.destination.trim();
        channel = destination.includes('@') ? 'email' : 'sms';
        const res = await fetch('/v1/auth/otp/request', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ destination, channel }) });
        const body = await res.json();
        if (!res.ok) { document.getElementById('err').innerHTML = '<div class="error">' + body.error + '</div>'; return; }
        requestForm.style.display = 'none';
        verifyForm.style.display = 'grid';
        document.getElementById('sent-to').textContent = 'Code sent to ' + destination;
      });
      verifyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/v1/auth/otp/verify', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ destination, channel, code: data.code }) });
        const body = await res.json();
        if (!res.ok) { document.getElementById('err').innerHTML = '<div class="error">' + body.error + '</div>'; return; }
        location.href = '/dashboard';
      });
    </script>
  `,
    ),
  );
});

router.get('/dashboard', (_req, res) => {
  res.type('html').send(
    page(
      'Dashboard',
      `
    <h1>Your focusKube account</h1>
    <div id="content">Loading&hellip;</div>
    <script>
      (async () => {
        const meRes = await fetch('/v1/auth/me');
        if (!meRes.ok) { location.href = '/login'; return; }
        const acctRes = await fetch('/v1/account');
        const acct = await acctRes.json();
        const licenseHtml = acct.license
          ? '<p><strong>Plan:</strong> ' + acct.license.plan + ' (' + acct.license.status + ')</p>' +
            '<div class="license-box">' + acct.license.key + '</div>' +
            '<form id="portal"><button type="submit" class="secondary">Manage billing</button></form>' +
            '<form id="regen"><button type="submit" class="secondary">Regenerate key</button></form>'
          : '<p>No active plan yet.</p><form id="checkout"><button type="submit">Subscribe</button></form>';
        document.getElementById('content').innerHTML =
          '<p class="sub">Signed in as ' + (acct.user.email || acct.user.phone) + '</p>' + licenseHtml +
          '<form id="logout"><button type="submit" class="secondary">Log out</button></form>';

        document.getElementById('logout').addEventListener('submit', async (e) => {
          e.preventDefault();
          await fetch('/v1/auth/logout', { method: 'POST' });
          location.href = '/login';
        });

        const goTo = async (path) => {
          const res = await fetch(path, { method: 'POST' });
          const body = await res.json();
          if (!res.ok) { alert(body.error || 'Something went wrong'); return; }
          if (body.url) location.href = body.url;
          else location.reload();
        };
        document.getElementById('checkout')?.addEventListener('submit', (e) => { e.preventDefault(); goTo('/v1/billing/checkout'); });
        document.getElementById('portal')?.addEventListener('submit', (e) => { e.preventDefault(); goTo('/v1/billing/portal'); });
        document.getElementById('regen')?.addEventListener('submit', (e) => { e.preventDefault(); goTo('/v1/account/license/regenerate'); });
      })();
    </script>
  `,
    ),
  );
});

router.get('/', (_req, res) => res.redirect('/dashboard'));
