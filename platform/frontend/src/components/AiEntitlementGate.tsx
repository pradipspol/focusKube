import { useState } from 'react';
import { useAiEntitlement, useClearLicenseKey, useSubmitLicenseKey } from '../api/aiAssistantApi';
import { uiText } from '../text';

interface Props {
  /** Rendered once the license key is confirmed active. */
  children: React.ReactNode;
}

/**
 * Gates the AI assistant panel behind a pasted-in license key, mirroring AuthGate's
 * desktop-email form. Also carries the data-handling disclosure required before a user
 * opts into the one feature that sends cluster data off this machine.
 */
export function AiEntitlementGate({ children }: Props) {
  const { data: entitlement, isLoading } = useAiEntitlement();
  const submitLicenseKey = useSubmitLicenseKey();
  const clearLicenseKey = useClearLicenseKey();
  const [key, setKey] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (isLoading) {
    return <div className="ai-gate ai-gate-loading">{uiText.aiAssistant.checkingEntitlement}</div>;
  }

  if (entitlement?.enabled) {
    return (
      <div className="ai-gate-enabled">
        <div className="ai-gate-enabled-bar">
          <span className="ai-gate-plan">
            {uiText.aiAssistant.planLabel}: {entitlement.plan ?? '—'}
          </span>
          {typeof entitlement.quotaRemaining === 'number' && (
            <span className="ai-gate-quota">
              {uiText.aiAssistant.quotaRemainingLabel}: {entitlement.quotaRemaining}
            </span>
          )}
          <button
            type="button"
            className="ai-gate-disable-button"
            onClick={() => clearLicenseKey.mutate()}
            disabled={clearLicenseKey.isPending}
          >
            {uiText.aiAssistant.disableButton}
          </button>
        </div>
        {children}
      </div>
    );
  }

  const submitKey = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const normalized = key.trim();
    if (!normalized) {
      setFormError(uiText.aiAssistant.licenseKeyRequired);
      return;
    }
    submitLicenseKey.mutate(normalized, {
      onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
    });
  };

  return (
    <div className="ai-gate-shell">
      <div className="ai-gate-card">
        <h2>{uiText.aiAssistant.lockedTitle}</h2>
        <p className="ai-gate-copy">{uiText.aiAssistant.lockedCopy}</p>

        <div className="ai-gate-disclosure">
          <strong>{uiText.aiAssistant.disclosureTitle}</strong>
          <p>{uiText.aiAssistant.disclosureCopy}</p>
        </div>

        {(entitlement?.error || formError) && (
          <div className="ai-gate-error">{formError ?? entitlement?.error}</div>
        )}

        <form onSubmit={submitKey} className="ai-gate-form">
          <label>
            {uiText.aiAssistant.licenseKeyLabel}
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={uiText.aiAssistant.licenseKeyPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="primary" disabled={submitLicenseKey.isPending}>
            {submitLicenseKey.isPending ? uiText.aiAssistant.enabling : uiText.aiAssistant.enableButton}
          </button>
        </form>
      </div>
    </div>
  );
}
