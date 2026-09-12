import { Router } from 'express';
import { authPage, page, renderTemplate } from './layout.js';

const router = Router();
export const authPagesRouter = router;

// Login/signup use the sidebar-less, centered authPage() shell — a visitor arriving to
// sign in or sign up isn't inside the app yet, so the full app-shell sidebar
// (Home/Download/Profile/Account/Support) doesn't apply, and a single focused form reads
// better centered than left-aligned in a wide column.
router.get('/signup', (_req, res) => {
  res.type('html').send(authPage('Sign up', renderTemplate('signup')));
});

router.get('/login', (_req, res) => {
  res.type('html').send(authPage('Sign in', renderTemplate('login')));
});

router.get('/forgot-password', (_req, res) => {
  res.type('html').send(page('Forgot password', renderTemplate('forgot-password'), '/forgot-password'));
});

router.get('/reset-password', (_req, res) => {
  // The reset token lives in the query string and is read client-side (see
  // reset-password.html) — nothing here needs to embed it into the response.
  res.type('html').send(page('Reset password', renderTemplate('reset-password'), '/reset-password'));
});

router.get('/otp', (_req, res) => {
  res.type('html').send(authPage('Sign in with a code', renderTemplate('otp')));
});
