// No build step, no framework — a handful of vanilla HTML+JS pages, proportionate to
// what this service needs today. Not the React app in platform/frontend: different
// deploy target, different audience (customers, not focusKube's own cluster-explorer UI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  /* min(65%, 1100px): fluid on ordinary screens, capped so it doesn't stretch into an
     unreadably wide line on ultra-wide/4K monitors — a flat 65% has no such ceiling. */
  .site-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: min(65%, 1100px); margin: 0 auto; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; position: sticky; top: 0; z-index: 20; background: var(--bg); }
  @media (max-width: 700px) { .site-nav { width: 100%; } }
  .site-nav-brand { font-weight: 700; text-decoration: none; color: var(--text-heading); font-size: 16px; }
  .site-nav-links { display: flex; align-items: center; gap: 18px; font-size: 14px; flex-wrap: wrap; }
  .site-nav-links a, .site-nav-links button.link-button { color: var(--text); text-decoration: none; }
  .site-nav-links button.link-button { background: none; border: none; font: inherit; cursor: pointer; padding: 0; }
  .site-nav-cta { padding: 6px 14px; border-radius: var(--radius-md); background: var(--accent-dim); border: 1px solid var(--accent); color: var(--text-on-accent) !important; }

  /* Sidebar + page content share the same centered column width the navbar uses above
     (see the min() comment there), so the sidebar's left edge lines up with the navbar's. */
  .layout-shell { display: flex; align-items: flex-start; width: min(65%, 1100px); margin: 0 auto; gap: 32px; }
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

  /* Standalone landing page (see landingPage() below) — no sidebar, so it centers itself
     the same way .site-nav does rather than relying on .layout-shell for that. */
  .landing-container { width: min(65%, 1100px); margin: 0 auto; padding: 24px 0 80px; }
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
  button { padding: 9px 14px; border-radius: var(--radius-md); border: 1px solid var(--accent); background: var(--accent-dim); color: var(--text-on-accent); font-size: 14px; font-family: inherit; cursor: pointer; }
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
  .license-box { font-family: ui-monospace, monospace; background: var(--bg-elev2); color: var(--text); border-radius: var(--radius-md); padding: 10px; word-break: break-all; font-size: 13px; }

  .card { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; margin-top: 16px; background: var(--bg-elev); }
  .card h2 { margin-top: 0; font-size: 16px; color: var(--text-heading); }
  .card-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  /* A row of several action buttons (not a "label ... single action" pair like .card-row
     above) — plain flex-start so buttons sit next to each other instead of spread apart,
     and forms inside it stay inline instead of picking up the global form's block
     display/margin-top/max-width (meant for actual multi-field forms, not a single button). */
  .button-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .button-row form { display: block; margin: 0; }
  .plan-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-top: 24px; }
`;

/** Fetches /v1/auth/me once and toggles the two nav-link groups every page ships with —
 * same auth check the old single-file dashboard already did before this file existed. */
const navScript = `
  (async () => {
    const guest = document.querySelectorAll('.nav-guest');
    const user = document.querySelectorAll('.nav-user');
    try {
      const res = await fetch('/v1/auth/me');
      const signedIn = res.ok;
      guest.forEach((el) => { el.style.display = signedIn ? 'none' : ''; });
      user.forEach((el) => { el.style.display = signedIn ? '' : 'none'; });
    } catch {
      guest.forEach((el) => { el.style.display = ''; });
      user.forEach((el) => { el.style.display = 'none'; });
    }
    document.getElementById('nav-logout')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/v1/auth/logout', { method: 'POST' });
      location.href = '/focusKube';
    });
  })();
`;

function nav(): string {
  return `
    <nav class="site-nav">
      <a class="site-nav-brand" href="/home">FocusKube</a>
      <div class="site-nav-links">
        <a href="/download">Download</a>
        <span class="nav-guest"><a href="/login">Log in</a></span>
        <span class="nav-guest"><a class="site-nav-cta" href="/signup">Sign up</a></span>
        <span class="nav-user" style="display:none"><a href="#" id="nav-logout">Log out</a></span>
      </div>
    </nav>
  `;
}

const SIDEBAR_LINKS: Array<{ href: string; label: string }> = [
  { href: '/home', label: 'Home' },
  { href: '/download', label: 'Download' },
  { href: '/profile', label: 'Profile' },
  { href: '/account', label: 'Account' },
  { href: '/team', label: 'Team' },
  { href: '/support', label: 'Support' },
];

function sidebar(currentPath: string): string {
  const links = SIDEBAR_LINKS.map(
    ({ href, label }) => `<a class="sidebar-link${href === currentPath ? ' active' : ''}" href="${href}">${label}</a>`,
  ).join('');
  return `<aside class="sidebar">${links}</aside>`;
}

/** currentPath drives the sidebar's active-link highlight — pass the route's own path
 * (e.g. '/account'), not req.path, since query strings shouldn't affect the match. */
export function page(title: string, body: string, currentPath: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — FocusKube</title><style>${styles}</style></head><body>${nav()}<div class="layout-shell">${sidebar(currentPath)}<div class="page-container">${body}</div></div><script>${navScript}</script></body></html>`;
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
<title>${title} — FocusKube</title><style>${styles}</style></head><body>${landingNav()}<div class="landing-container">${body}</div></body></html>`;
}

/** Login/signup: same bare nav as landingPage(), but the body renders as a single card
 * centered in the remaining viewport space instead of left-aligned in a wide column —
 * the "FOCUSKUBE" eyebrow above the card matches the desktop app's own SignInGate. */
export function authPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — FocusKube</title><style>${styles}</style></head><body><div class="auth-shell">${landingNav()}<div class="auth-center"><div class="auth-card"><div class="auth-brand">FocusKube</div>${body}</div></div></div></body></html>`;
}
