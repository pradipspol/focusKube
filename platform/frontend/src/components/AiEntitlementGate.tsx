import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAiEntitlement, useRequestCheckout } from '../api/aiAssistantApi';
import { uiText } from '../text';

interface Props {
  /** Rendered once the signed-in account has an active license. */
  children: React.ReactNode;
}

function openCheckoutUrl(url: string): void {
  if (window.desktopMenu) {
    void window.desktopMenu.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Gates the AI assistant panel behind the signed-in account's license, looked up
 * automatically from the relay (no key to paste — see AiEntitlementGate's backend
 * counterpart, routes/ai.ts). Also carries the data-handling disclosure required before
 * a user opts into the one feature that sends cluster data off this machine.
 */
export function AiEntitlementGate({ children }: Props) {
  const queryClient = useQueryClient();
  const { data: entitlement, isLoading } = useAiEntitlement();
  const requestCheckout = useRequestCheckout();
  const [checkoutOpened, setCheckoutOpened] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [billingUnavailable, setBillingUnavailable] = useState(false);

  if (isLoading) {
    return <div className="ai-gate ai-gate-loading">{uiText.aiAssistant.checkingEntitlement}</div>;
  }

  const runCheckout = (onTrialGranted: () => void) => {
    setCheckoutError(null);
    requestCheckout.mutate(undefined, {
      onSuccess: (result) => {
        if (result.trialGranted) {
          onTrialGranted();
          return;
        }
        if (result.url) {
          openCheckoutUrl(result.url);
          setCheckoutOpened(true);
        }
      },
      onError: (err) => setCheckoutError(err instanceof Error ? err.message : String(err)),
    });
  };

  if (entitlement?.enabled) {
    const isTrial = entitlement.plan === 'trial';

    const handleUpgrade = () => {
      setBillingUnavailable(false);
      runCheckout(() => setBillingUnavailable(true));
    };

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
          {isTrial && !checkoutOpened && (
            <button
              type="button"
              className="primary ai-gate-upgrade-button"
              onClick={handleUpgrade}
              disabled={requestCheckout.isPending}
            >
              {requestCheckout.isPending ? uiText.aiAssistant.startingCheckout : uiText.aiAssistant.upgradeToProButton}
            </button>
          )}
        </div>
        {isTrial && checkoutOpened && <div className="ai-gate-upgrade-notice">{uiText.aiAssistant.checkoutOpenedNotice}</div>}
        {isTrial && billingUnavailable && <div className="ai-gate-upgrade-notice">{uiText.aiAssistant.billingNotConfiguredNotice}</div>}
        {isTrial && checkoutError && <div className="ai-gate-error">{checkoutError}</div>}
        {children}
      </div>
    );
  }

  const handleGetLicense = () => {
    // No billing configured yet — the relay granted a free trial license directly, so
    // there's no checkout URL to open. Refetch to flip straight to the enabled view.
    runCheckout(() => void queryClient.invalidateQueries({ queryKey: ['ai', 'entitlement'] }));
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

        {(entitlement?.error || checkoutError) && (
          <div className="ai-gate-error">{checkoutError ?? entitlement?.error}</div>
        )}

        {checkoutOpened ? (
          <p className="ai-gate-copy">{uiText.aiAssistant.checkoutOpenedNotice}</p>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={handleGetLicense}
            disabled={requestCheckout.isPending}
          >
            {requestCheckout.isPending ? uiText.aiAssistant.startingCheckout : uiText.aiAssistant.getLicenseButton}
          </button>
        )}
      </div>
    </div>
  );
}
