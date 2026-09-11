import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { uiText } from '../text';

interface Props {
  onSignedIn?: () => void;
}

type Mode = 'password' | 'otp';
type PasswordSubMode = 'signIn' | 'signUp';

/** Replaces the old desktop email-only pseudo-auth: real sign-in (password, one-time code,
 * or Google) backed by the relay's account system via the /api/auth/* proxies. */
export function SignInGate({ onSignedIn }: Props) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('password');
  const [passwordSubMode, setPasswordSubMode] = useState<PasswordSubMode>('signIn');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finishSignIn = async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    onSignedIn?.();
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">{uiText.brand.appName}</div>
        <h1>{mode === 'otp' ? uiText.auth.otpTitle : passwordSubMode === 'signUp' ? uiText.auth.signUpTitle : uiText.auth.signInTitle}</h1>
        <p className="auth-copy">{mode === 'otp' ? uiText.auth.otpCopy : uiText.auth.copy}</p>

        {error && <div className="auth-error">{error}</div>}

        {mode === 'password' ? (
          <PasswordForm
            subMode={passwordSubMode}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onSuccess={finishSignIn}
          />
        ) : (
          <OtpForm busy={busy} setBusy={setBusy} setError={setError} onSuccess={finishSignIn} />
        )}

        <div className="auth-divider">{uiText.auth.orDivider}</div>

        <a className="auth-google-button" href="/api/auth/google/start">
          {uiText.auth.continueWithGoogle}
        </a>

        <div className="auth-links">
          {mode === 'password' ? (
            <>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setError(null);
                  setPasswordSubMode((m) => (m === 'signIn' ? 'signUp' : 'signIn'));
                }}
              >
                {passwordSubMode === 'signIn' ? uiText.auth.switchToSignUp : uiText.auth.switchToSignIn}
              </button>
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setError(null);
                  setMode('otp');
                }}
              >
                {uiText.auth.useCodeInstead}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setError(null);
                setMode('password');
              }}
            >
              {uiText.auth.usePasswordInstead}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PasswordForm({
  subMode,
  busy,
  setBusy,
  setError,
  onSuccess,
}: {
  subMode: PasswordSubMode;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  onSuccess: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError(uiText.auth.emailRequired);
      return;
    }
    if (password.length < 8) {
      setError(uiText.auth.passwordRequired);
      return;
    }
    setBusy(true);
    try {
      if (subMode === 'signUp') {
        await api.authSignup(normalizedEmail, password);
      } else {
        await api.authLogin(normalizedEmail, password);
      }
      await onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="auth-form">
      <label>
        {uiText.auth.emailLabel}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={uiText.auth.emailPlaceholder}
          autoComplete="email"
        />
      </label>
      <label>
        {uiText.auth.passwordLabel}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={uiText.auth.passwordPlaceholder}
          autoComplete={subMode === 'signUp' ? 'new-password' : 'current-password'}
        />
      </label>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? uiText.auth.signingIn : subMode === 'signUp' ? uiText.auth.signUpButton : uiText.auth.signInButton}
      </button>
    </form>
  );
}

function OtpForm({
  busy,
  setBusy,
  setError,
  onSuccess,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  onSuccess: () => Promise<void>;
}) {
  const [destination, setDestination] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);

  const requestCode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const normalized = destination.trim();
    if (!normalized) {
      setError(uiText.auth.emailRequired);
      return;
    }
    const detectedChannel = normalized.includes('@') ? 'email' : 'sms';
    setChannel(detectedChannel);
    setBusy(true);
    try {
      await api.authOtpRequest(normalized, detectedChannel);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.authOtpVerify(destination.trim(), channel, code.trim());
      await onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sent) {
    return (
      <form onSubmit={requestCode} className="auth-form">
        <label>
          {uiText.auth.otpDestinationLabel}
          <input
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder={uiText.auth.otpDestinationPlaceholder}
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {uiText.auth.otpSendButton}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verifyCode} className="auth-form">
      <p className="auth-copy">{uiText.auth.otpSentTo(destination.trim())}</p>
      <label>
        {uiText.auth.otpCodeLabel}
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
        />
      </label>
      <button type="submit" className="primary" disabled={busy}>
        {uiText.auth.otpVerifyButton}
      </button>
    </form>
  );
}
