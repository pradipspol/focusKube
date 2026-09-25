// Shared HTML-escaping helper for every server-rendered page in web/templates/*.html.
// Loaded once via a <script nonce="..."> tag in web/layout.ts's page shells, BEFORE each
// template's own inline <script> runs — classic (non-module) <script> tags share one global
// scope, so `esc` declared here is already in scope by the time a template needs it. This is
// the one place this function is defined; no template should redeclare it inline.
//
// Use it on every server-provided or user-controlled string (error messages, names, emails,
// org names, etc.) before inserting it via `.innerHTML` or into an HTML attribute — anything
// set via `.textContent` or a DOM property (e.g. `img.src = value`) doesn't need it.
const esc = (value) =>
  (value == null ? '' : String(value)).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
