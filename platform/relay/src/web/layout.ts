// No build step, no framework — a handful of vanilla HTML+JS pages, proportionate to
// what this service needs today. Not the React app in platform/frontend: different
// deploy target, different audience (customers, not focusKube's own cluster-explorer UI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentNonce } from '../security/csp.js';

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

/** Reads a page's body content from web/templates/<name>.html. Read fresh on every call
 * (not cached) — these are small files and this is a low-traffic account/marketing site,
 * so the cost is negligible, and it means editing a template takes effect immediately
 * without restarting the dev server. The build script copies this templates/ directory
 * into dist/ alongside the compiled JS (tsc only compiles .ts files on its own). */
export function renderTemplate(name: string, substitutions?: Record<string, string>): string {
  let html = fs.readFileSync(path.join(templatesDir, `${name}.html`), 'utf8');
  for (const [key, value] of Object.entries(substitutions ?? {})) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  // Stamp inline behavior and layout with the request's CSP nonce, while leaving external
  // scripts such as Razorpay's SDK tag untouched.
  html = html.replace(/<(script|style)>/g, `<$1 nonce="${currentNonce()}">`);
  return html;
}

// Color/spacing tokens mirror platform/frontend/src/index.css's design tokens (dark theme
// as the default — the app's own default — with a light override below) so this vanilla
// account/marketing site reads as the same product as the React app, not a different one
// that merely links to it.
export const styles = `
  :root {
    color-scheme: dark light;
    --bg: #0c1117;
    --bg-elev: #151b22;
    --bg-elev2: #1b232d;
    --surface-hover: #1a212b;
    --surface-overlay: rgba(20, 28, 39, 0.92);
    --surface-auth-mid: #0d1520;
    --surface-deepest: #070c13;
    --auth-gradient-start: #1f2f45;
    --border: #2a323e;
    --border-auth: #2a394b;
    --text: #d4dae3;
    --text-heading: #f4f7fb;
    --text-muted: #8fa0b3;
    --auth-brand: #9fbad8;
    --auth-copy: #aab8c9;
    --auth-label: #c8d3e1;
    --accent: #3d9df6;
    --accent-dim: #2b6cb0;
    --accent-bright: #8fc8ff;
    --text-on-accent: #fff;
    --danger: #f06c6c;
    --danger-text: #ffc5c5;
    --error-border: rgba(240, 108, 108, 0.55);
    --error-bg: rgba(126, 35, 35, 0.35);
    --notice-bg: rgba(61, 157, 246, 0.12);
    --notice-border: rgba(61, 157, 246, 0.4);
    --notice-text: #9bd7ff;
    --radius-md: 6px;
    --radius-lg: 8px;
    --radius-2xl: 14px;
    --shadow-strong: rgba(0, 0, 0, 0.35);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f9fb;
      --bg-elev: #ffffff;
      --bg-elev2: #f1f4f6;
      --surface-hover: #e2e9ee;
      --surface-overlay: rgba(255, 255, 255, 0.94);
      --surface-auth-mid: #edf2f6;
      --surface-deepest: #eef2f5;
      --auth-gradient-start: #cbdce8;
      --border: #c5d0d9;
      --border-auth: #b9c8d4;
      --text: #1a1f26;
      --text-heading: #101418;
      --text-muted: #55606d;
      --auth-brand: #275875;
      --auth-copy: #405b6d;
      --auth-label: #304c60;
      --accent: #1479c9;
      --accent-dim: #176aa5;
      --accent-bright: #075d9e;
      --danger: #c73535;
      --danger-text: #a8071a;
      --error-border: rgba(199, 53, 53, 0.55);
      --error-bg: rgba(199, 53, 53, 0.1);
      --notice-bg: rgba(20, 121, 201, 0.08);
      --notice-border: rgba(20, 121, 201, 0.35);
      --notice-text: #0b4f7a;
      --shadow-strong: rgba(15, 35, 55, 0.12);
    }
  }
  * { box-sizing: border-box; }
  /* Always reserve the scrollbar's track width, whether or not a given page's content is
     tall enough to actually need one — otherwise .site-nav/.layout-shell/.landing-container
     (all centered via width:min(...); margin:0 auto) center against a viewport that's a
     scrollbar-width narrower on a short page than a tall one, visibly shifting the nav bar
     and sidebar sideways when navigating between routes of different content length. */
  html { overflow-y: scroll; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; color: var(--text); background: var(--bg); animation: page-fade-in 0.25s ease-out; }
  @media (prefers-reduced-motion: reduce) { body { animation: none; } }
  @keyframes page-fade-in { from { opacity: 0; } to { opacity: 1; } }
  a { color: var(--accent); }

  /* Keep the nav and page content on one responsive column, with a readable max width. */
  .site-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: min(94%, 1320px); margin: 0 auto; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; position: sticky; top: 0; z-index: 20; background: var(--bg); }
  @media (max-width: 700px) { .site-nav { width: 100%; } }
  .site-nav-brand { font-weight: 700; text-decoration: none; color: var(--text-heading); font-size: 16px; }
  .site-nav-links { display: flex; align-items: center; gap: 18px; font-size: 14px; flex-wrap: wrap; }
  .site-nav-links a, .site-nav-links button.link-button { color: var(--text); text-decoration: none; }
  .site-nav-links button.link-button { background: none; border: none; font: inherit; cursor: pointer; padding: 0; }
  .site-nav-cta { padding: 6px 14px; border-radius: var(--radius-md); background: var(--accent-dim); border: 1px solid var(--accent); color: var(--text-on-accent) !important; }

  /* Sidebar + page content share the same centered column width the navbar uses above
     (see the min() comment there), so the sidebar's left edge lines up with the navbar's. */
  .layout-shell { display: flex; align-items: flex-start; width: min(94%, 1320px); margin: 0 auto; gap: 32px; }
  .sidebar { width: 180px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; padding-top: 24px; position: sticky; top: 76px; }
  .sidebar-link { padding: 8px 12px; border-radius: var(--radius-md); color: var(--text); text-decoration: none; font-size: 14px; }
  .sidebar-link:hover { background: var(--surface-hover); }
  .sidebar-link.active { background: var(--bg-elev2); color: var(--accent-bright); font-weight: 600; }
  @media (max-width: 700px) {
    .layout-shell { flex-direction: column; width: 100%; }
    .sidebar { flex-direction: row; overflow-x: auto; width: 100%; padding: 12px 16px; gap: 8px; position: static; }
    .page-container { padding: 24px 20px 80px; }
  }

  .page-container { flex: 1; min-width: 0; padding: 24px 0 80px; }
  .page-container > h1:first-child { margin: 0 0 8px; line-height: 1.25; }
  .page-container > h1 + .sub { max-width: 72ch; line-height: 1.55; margin-bottom: 22px; }
  .page-container > h2 { margin: 32px 0 12px; font-size: 18px; color: var(--text-heading); }

  /* Standalone landing page (see landingPage() below) — no sidebar, so it centers itself
     the same way .site-nav does rather than relying on .layout-shell for that. */
  .landing-container { width: min(94%, 1320px); margin: 0 auto; padding: 32px 0 80px; }
  @media (max-width: 700px) { .landing-container { width: 100%; padding: 24px 20px 80px; } }

  /* Login/signup (see authPage() below) — a single card centered in the remaining
     viewport height below the nav, on the same radial-gradient backdrop and card styling
     as the desktop app's own sign-in screen (SignInGate.tsx's .auth-shell/.auth-card). */
  .auth-shell { min-height: 100vh; display: flex; flex-direction: column; background: radial-gradient(circle at 15% 20%, var(--auth-gradient-start) 0%, var(--surface-auth-mid) 38%, var(--surface-deepest) 100%); }
  .auth-shell .site-nav { background: transparent; border-bottom-color: var(--border-auth); }
  .auth-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  /* clamp(min, preferred, max): a straight vw value (e.g. 30vw) shrinks the card along
     with the viewport with no floor, so it becomes unusably narrow on a phone — this
     stays readable at both ends and only actually flexes in between. */
  .auth-card { width: 100%; max-width: clamp(320px, 90vw, 460px); background: var(--surface-overlay); border: 1px solid var(--border-auth); border-radius: var(--radius-2xl); box-shadow: 0 24px 48px var(--shadow-strong); padding: 24px; }
  .auth-card form { max-width: none; }
  .auth-brand { letter-spacing: 0.08em; font-size: 12px; text-transform: uppercase; color: var(--auth-brand); margin-bottom: 8px; }
  .auth-divider { display: flex; align-items: center; gap: 10px; margin: 18px 0; color: var(--auth-copy); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .auth-divider::before, .auth-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-auth); }

  h1 { font-size: 22px; margin-bottom: 4px; color: var(--text-heading); }
  p.sub { color: var(--auth-copy); margin-top: 0; font-size: 14px; }
  form { display: grid; gap: 12px; margin-top: 20px; max-width: 420px; }
  label { display: grid; gap: 6px; font-size: 13px; color: var(--auth-label); }
  input, select { padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); font-size: 14px; }
  input::placeholder { color: var(--text-muted); }
  button { min-height: 38px; padding: 9px 14px; border-radius: var(--radius-md); border: 1px solid var(--accent); background: var(--accent-dim); color: var(--text-on-accent); font-size: 14px; font-family: inherit; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent-bright); }
  button.secondary { background: transparent; border: 1px solid var(--border-auth); color: var(--text-heading); }
  button.secondary:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--border-auth); }
  button.danger { border-color: var(--danger); color: var(--danger); }
  button.danger:hover:not(:disabled) { background: var(--error-bg); border-color: var(--danger); }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { background: var(--error-bg); border: 1px solid var(--error-border); color: var(--danger-text); padding: 10px; border-radius: var(--radius-lg); font-size: 13px; }
  .notice { background: var(--notice-bg); border: 1px solid var(--notice-border); color: var(--notice-text); padding: 10px; border-radius: var(--radius-lg); font-size: 13px; }
  .links { margin-top: 16px; font-size: 13px; color: var(--auth-copy); }
  .link-button { background: none; border: none; color: var(--accent-bright); cursor: pointer; font-size: inherit; padding: 0; text-decoration: underline; }
  .button-link { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 8px 14px; border: 1px solid var(--accent); border-radius: var(--radius-md); background: var(--accent-dim); color: var(--text-on-accent); font-size: 14px; line-height: 1.25; text-align: center; text-decoration: none; }
  .button-link:hover { border-color: var(--accent-bright); color: var(--text-on-accent); }
  .button-link:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 2px; }
  .button-link.secondary { border-color: var(--border-auth); background: transparent; color: var(--text-heading); }
  .button-link.secondary:hover { background: var(--surface-hover); border-color: var(--border-auth); color: var(--text-heading); }
  .license-box { font-family: ui-monospace, monospace; background: var(--bg-elev2); color: var(--text); border-radius: var(--radius-md); padding: 10px; word-break: break-all; font-size: 13px; }

  .card { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; margin-top: 16px; background: var(--bg-elev); }
  .card h2 { margin-top: 0; font-size: 16px; color: var(--text-heading); }
  .plan-grid > .card { display: flex; flex-direction: column; min-width: 0; margin-top: 0; }
  .plan-grid > .card > a { align-self: flex-start; margin-top: auto; padding-top: 16px; }
  .card-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  /* A row of several action buttons (not a "label ... single action" pair like .card-row
     above) — plain flex-start so buttons sit next to each other instead of spread apart,
     and forms inside it stay inline instead of picking up the global form's block
     display/margin-top/max-width (meant for actual multi-field forms, not a single button). */
  .button-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .button-row form { display: block; width: auto; max-width: none; margin: 0; }
  .button-row button { justify-self: start; }
  .page-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 20px 0 28px; }
  .license-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .license-field { position: relative; flex: 1 1 240px; min-width: 0; }
  .license-input { display: block; width: 100%; font-family: ui-monospace, monospace; font-size: 13px; padding: 10px 44px 10px 10px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); }
  .license-toggle { position: absolute; z-index: 1; right: 6px; top: 50%; transform: translateY(-50%); width: 32px; height: 32px; padding: 0; display: grid; place-items: center; background: transparent; border: 0; color: var(--text-muted); }
  .license-toggle:hover:not(:disabled) { background: transparent; border-color: transparent; color: var(--text-heading); }
  .license-toggle:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 1px; }
  .license-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .license-row form { display: block; width: auto; max-width: none; margin: 0; }
  .plan-grid { display: grid; align-items: stretch; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); margin-top: 24px; }
  .card-row { flex-wrap: wrap; }
  .card > h2 { margin-bottom: 10px; }
  .card > p:last-child { margin-bottom: 0; }
  .card form { max-width: 520px; }
  .profile-avatar-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .profile-avatar-row > label { flex: 1 1 220px; min-width: 0; }
  .profile-opt-in { display: flex; align-items: flex-start; gap: 8px; flex-direction: row; line-height: 1.5; }
  .profile-opt-in input { flex: 0 0 16px; margin-top: 2px; }
  .profile-avatar { flex: 0 0 64px; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background: rgba(127,127,127,0.15); }
  input[type="checkbox"] { width: 16px; height: 16px; padding: 0; accent-color: var(--accent); }
  @media (max-width: 700px) {
    .page-container { padding-top: 20px; }
    .plan-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; margin-top: 18px; }
    .card { padding: 16px; }
    .button-row { align-items: stretch; }
    .button-row form, .button-row form button { width: 100%; }
    table.members { display: block; max-width: 100%; overflow-x: auto; white-space: nowrap; }
  }
  .pw-field { position: relative; min-width: 0; }
  .pw-field input { display: block; width: 100%; min-width: 0; padding-right: 44px; }
  .pw-toggle { position: absolute; z-index: 1; right: 6px; top: 50%; transform: translateY(-50%); width: 32px; height: 32px; padding: 0; display: grid; place-items: center; background: transparent; border: 0; color: var(--text-muted); }
  .pw-toggle:hover:not(:disabled) { background: transparent; border-color: transparent; color: var(--text-heading); }
  .pw-toggle:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 1px; }
  .pw-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
`;

/** Fetches /v1/auth/me once and toggles the two nav-link groups every page ships with —
 * same auth check the old single-file dashboard already did before this file existed. */
const navScript = `
  (async () => {
    const guest = document.querySelectorAll('.nav-guest');
    const user = document.querySelectorAll('.nav-user');
    const admin = document.querySelectorAll('.nav-admin');
    try {
      const res = await fetch('/v1/auth/me');
      const signedIn = res.ok;
      guest.forEach((el) => { el.style.display = signedIn ? 'none' : ''; });
      user.forEach((el) => { el.style.display = signedIn ? '' : 'none'; });
      if (signedIn) {
        const access = await fetch('/v1/admin/access');
        const isAdmin = access.ok && (await access.json()).isAdmin;
        admin.forEach((el) => { el.style.display = isAdmin ? '' : 'none'; });
      }
    } catch {
      guest.forEach((el) => { el.style.display = ''; });
      user.forEach((el) => { el.style.display = 'none'; });
      admin.forEach((el) => { el.style.display = 'none'; });
    }
    document.getElementById('nav-logout')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/v1/auth/logout', { method: 'POST' });
      location.href = '/focusKube';
    });
  })();
`;

const adminPreferencesScript = `
  try {
    const preferences = JSON.parse(localStorage.getItem('focuskube-admin-preferences') || '{}');
    if (preferences.tableDensity === 'compact' || preferences.tableDensity === 'comfortable') {
      document.documentElement.dataset.adminDensity = preferences.tableDensity;
    }
    const startPage = ['/admin', '/admin/users', '/admin/telemetry', '/admin/preferences', '/admin/team-onboarding'].includes(preferences.startPage)
      ? preferences.startPage
      : '/admin';
    if (location.pathname === '/admin' && startPage !== '/admin' && !new URLSearchParams(location.search).has('stay')) {
      location.replace(startPage);
    }
  } catch {}
`;

function nav(): string {
  return `
    <nav class="site-nav">
      <a class="site-nav-brand" href="/home">FocusKube</a>
      <div class="site-nav-links">
        <a href="/download">Download</a>
        <a class="nav-admin" style="display:none" href="/admin">Admin</a>
        <span class="nav-guest"><a href="/login">Log in</a></span>
        <span class="nav-guest"><a class="site-nav-cta" href="/signup">Sign up</a></span>
        <span class="nav-user" style="display:none"><a href="#" id="nav-logout">Log out</a></span>
      </div>
    </nav>
  `;
}

function adminNav(): string {
  return `
    <nav class="site-nav">
      <a class="site-nav-brand" href="/admin">FocusKube Admin</a>
      <div class="site-nav-links">
        <span class="nav-user"><a href="#" id="nav-logout">Log out</a></span>
      </div>
    </nav>
  `;
}

const SIDEBAR_LINKS: Array<{ href: string; label: string; admin?: boolean }> = [
  { href: '/home', label: 'Home' },
  { href: '/download', label: 'Download' },
  { href: '/profile', label: 'Profile' },
  { href: '/account', label: 'Account' },
  { href: '/team', label: 'Team' },
  { href: '/support', label: 'Support' },
  { href: '/admin', label: 'Admin', admin: true },
];

function sidebar(currentPath: string): string {
  const links = SIDEBAR_LINKS.map(
    ({ href, label, admin }) => `<a class="sidebar-link${href === currentPath ? ' active' : ''}${admin ? ' nav-admin' : ''}"${admin ? ' style="display:none"' : ''} href="${href}">${label}</a>`,
  ).join('');
  return `<aside class="sidebar">${links}</aside>`;
}

/** currentPath drives the sidebar's active-link highlight — pass the route's own path
 * (e.g. '/account'), not req.path, since query strings shouldn't affect the match. */
export function page(title: string, body: string, currentPath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — FocusKube</title><style nonce="${currentNonce()}">${styles}</style><script nonce="${currentNonce()}" src="/static/security.js"></script></head><body>${nav()}<div class="layout-shell">${sidebar(currentPath)}<div class="page-container">${body}</div></div><script nonce="${currentNonce()}">${navScript}</script></body></html>`;
}

const adminShellStyles = `
  .admin-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 30px; align-items: start; width: min(94%, 1320px); min-height: calc(100vh - 58px); margin: 0 auto; }
  .admin-sidebar { position: sticky; top: 58px; display: flex; flex-direction: column; gap: 16px; min-height: calc(100vh - 58px); padding: 28px 16px 24px 0; border-right: 1px solid var(--border); }
  .admin-sidebar-label { color: var(--text-muted); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .admin-sidebar nav { display: grid; gap: 4px; }
  .admin-sidebar nav a { padding: 9px 11px; border-radius: var(--radius-md); color: var(--text); font-size: 14px; text-decoration: none; }
  .admin-sidebar nav a:hover, .admin-sidebar nav a:focus-visible { background: var(--surface-hover); color: var(--text-heading); }
  .admin-sidebar nav a[aria-current="page"] { background: var(--bg-elev2); color: var(--accent-bright); font-weight: 600; }
  .admin-back-link { margin-top: auto; padding: 10px 0; border-top: 1px solid var(--border); color: var(--accent-bright); font-size: 13px; text-decoration: none; }
  .admin-back-link:hover { color: var(--text-heading); }
  .admin-main { min-width: 0; padding: 28px 0 60px; }
  .admin-view { display: grid; gap: 24px; }
  .admin-view-header { padding: 20px 24px; border-left: 3px solid var(--accent); background: linear-gradient(100deg, var(--notice-bg), transparent 72%); }
  .admin-view-header h1 { margin: 10px 0 6px; color: var(--text-heading); font-size: 27px; line-height: 1.2; }
  .admin-view-header p { max-width: 72ch; margin: 0; line-height: 1.5; }
  .admin-eyebrow, .admin-index { color: var(--accent-bright); font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .admin-panel { min-width: 0; padding: 18px 0; border-top: 1px solid var(--border); }
  .admin-panel h2 { margin: 0 0 6px; color: var(--text-heading); font-size: 18px; }
  .admin-panel > .sub { margin: 0 0 16px; }
  .admin-error { color: var(--danger); }
  @media (max-width: 700px) {
    .admin-layout { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .admin-sidebar { position: static; flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; min-height: 0; padding: 10px 0; border-right: 0; border-bottom: 1px solid var(--border); }
    .admin-sidebar-label { display: none; }
    .admin-sidebar nav { display: flex; flex-wrap: wrap; gap: 2px; }
    .admin-sidebar nav a { padding: 8px; font-size: 12px; }
    .admin-back-link { margin: 0; padding: 8px 0 8px 8px; border-top: 0; border-left: 1px solid var(--border); white-space: nowrap; }
    .admin-main { padding: 20px 0 44px; }
    .admin-view-header { padding: 18px; }
    .admin-view-header h1 { font-size: 24px; }
  }
`;

export function adminPage(title: string, body: string, currentPath: string): string {
  const links = [
    ['/admin', 'Overview'],
    ['/admin/users', 'Users'],
    ['/admin/telemetry', 'Telemetry'],
    ['/admin/preferences', 'Preferences'],
    ['/admin/team-onboarding', 'Team onboarding'],
  ] as const;
  const adminSidebar = `
    <aside class="admin-sidebar">
      <span class="admin-sidebar-label">Administration</span>
      <nav aria-label="Admin sections">
        ${links.map(([href, label]) => `<a href="${href === '/admin' ? '/admin?stay=1' : href}"${href === currentPath ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
      <a class="admin-back-link" href="/home">&larr; Back to FocusKube</a>
    </aside>
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — FocusKube Admin</title><style nonce="${currentNonce()}">${styles}${adminShellStyles}</style><script nonce="${currentNonce()}" src="/static/security.js"></script></head><body>${adminNav()}<div class="admin-layout">${adminSidebar}<div class="admin-main">${body}</div></div><script nonce="${currentNonce()}">${navScript}</script><script nonce="${currentNonce()}">${adminPreferencesScript}</script></body></html>`;
}

/** Bare-bones nav for landingPage() below — brand plus Log in/Sign up only, no Download
 * link and no signed-in-state links, since this page is never shown inside the app shell. */
function landingNav(): string {
  return `
    <nav class="site-nav">
      <a class="site-nav-brand" href="/focusKube">FocusKube</a>
      <div class="site-nav-links">
        <a href="/login">Log in</a>
        <a class="site-nav-cta" href="/signup">Sign up</a>
      </div>
    </nav>
  `;
}

/** Standalone marketing/landing page: no sidebar, no app-shell chrome, and a nav bar
 * carrying only Log in/Sign up — distinct from page(), which every signed-in-app page
 * (account, profile, download, support, /home) uses and always renders the full sidebar. */
export function landingPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — FocusKube</title><style nonce="${currentNonce()}">${styles}</style><script nonce="${currentNonce()}" src="/static/security.js"></script></head><body>${landingNav()}<div class="landing-container">${body}</div></body></html>`;
}

/** Login/signup: same bare nav as landingPage(), but the body renders as a single card
 * centered in the remaining viewport space instead of left-aligned in a wide column —
 * the "FOCUSKUBE" eyebrow above the card matches the desktop app's own SignInGate. */
export function authPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — FocusKube</title><style nonce="${currentNonce()}">${styles}</style><script nonce="${currentNonce()}" src="/static/security.js"></script></head><body><div class="auth-shell">${landingNav()}<div class="auth-center"><div class="auth-card"><div class="auth-brand">FocusKube</div>${body}</div></div></div></body></html>`;
}
