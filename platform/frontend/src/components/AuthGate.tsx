import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clearDesktopEmail, getDesktopEmail, setDesktopEmail } from '../api/client';
import { uiText } from '../text';

interface Props {
  onSignedIn?: () => void;
}

export function AuthGate({ onSignedIn }: Props) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(() => getDesktopEmail());
  const [formError, setFormError] = useState<string | null>(null);

  const submitDesktopLogin = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const normalized = email.trim();
    if (!normalized) {
      setFormError(uiText.auth.emailRequired);
      return;
    }
    clearDesktopEmail();
    setDesktopEmail(normalized);
    void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    onSignedIn?.();
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">{uiText.brand.appName}</div>
        <h1>{uiText.auth.signInTitle}</h1>
        <p className="auth-copy">{uiText.auth.copy}</p>

        {formError && <div className="auth-error">{formError}</div>}

        <form onSubmit={submitDesktopLogin} className="auth-form">
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
          <button type="submit" className="primary">
            {uiText.auth.continueButton}
          </button>
        </form>
      </div>
    </div>
  );
}
