// Server-side input validation for values that later get rendered back into this service's
// own HTML (web/templates/*.html) — output there is HTML-escaped (see web/static/security.js),
// but rejecting anything that could carry markup here too, before it ever reaches storage,
// notification emails, or logs, is cheap defense in depth.

// Deliberately permissive (matches the HTML5 type="email" spirit) — a coarse sanity check,
// not full RFC validation. Excludes HTML-special characters specifically because addresses
// validated with this are rendered back into account/team/invite HTML elsewhere.
const EMAIL_RE = /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/;

export function isValidEmail(value: string | null | undefined): value is string {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

// eslint-disable-next-line no-control-regex
// U+200B–U+200D and U+FEFF are invisible zero-width characters. `String#trim` leaves
// them intact, which previously allowed an apparently blank organization name through.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f\u200b-\u200d\ufeff]/g;
const MAX_ORG_NAME_LENGTH = 140;

/** Trims, strips control/zero-width characters, and length-caps a team/org name (rendered
 * back into team.html/home.html/invite.html). Returns the cleaned name, or an error message
 * if it's empty or too long. */
export function validateOrgName(raw: string | null | undefined): string | { error: string } {
  const trimmed = (raw ?? '').replace(CONTROL_CHARS_RE, '').trim();
  if (!trimmed) return { error: 'A team name is required' };
  if (trimmed.length > MAX_ORG_NAME_LENGTH) return { error: `Team name must be ${MAX_ORG_NAME_LENGTH} characters or fewer` };
  return trimmed;
}

// Requires an actual image data URL — this value is rendered straight into an
// <img src="..."> attribute (profile.html), so a request crafted outside the browser (e.g.
// directly against this API) must not be able to smuggle in something like
// `x" onerror="...` that only happens to look like a data URL to the client-side upload code.
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

export function isValidAvatarDataUrl(value: string): boolean {
  return AVATAR_DATA_URL_RE.test(value);
}
