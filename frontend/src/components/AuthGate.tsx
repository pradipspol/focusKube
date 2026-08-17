import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clearDesktopEmail, getDesktopEmail, setDesktopEmail } from '../api/client';

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
      setFormError('Email is required.');
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
        <div className="auth-brand">K8s Explorer</div>
        <h1>Sign in</h1>
        <p className="auth-copy">Enter your email to continue.</p>

        {formError && <div className="auth-error">{formError}</div>}

        <form onSubmit={submitDesktopLogin} className="auth-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          <button type="submit" className="primary">
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
