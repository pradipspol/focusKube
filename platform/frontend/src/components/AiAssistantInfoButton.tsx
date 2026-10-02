import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useAiEntitlement } from '../api/aiAssistantApi';
import { uiText } from '../text';

export function AiAssistantInfoButton() {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const { data: entitlement } = useAiEntitlement();
  const details = [
    { label: uiText.aiAssistant.planLabel, value: entitlement?.plan ?? '—' },
    ...(entitlement?.team ? [{ label: uiText.aiAssistant.teamLabel, value: `${entitlement.team.name} (${entitlement.team.role})` }] : []),
    {
      label: uiText.aiAssistant.aiCreditLabel,
      value: typeof entitlement?.quotaRemaining === 'number' ? String(entitlement.quotaRemaining) : '—',
    },
    { label: uiText.aiAssistant.aiStatusLabel, value: entitlement?.status ?? '—' },
  ];

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  return (
    <div className="ai-info-control" ref={controlRef}>
      <button
        type="button"
        className={`ai-info-button${open ? ' active' : ''}`}
        title={uiText.aiAssistant.aiInfoButton}
        aria-label={uiText.aiAssistant.aiInfoTitle}
        aria-expanded={open}
        aria-controls="ai-assistant-info"
        onClick={() => setOpen((current) => !current)}
      >
        <Info size={16} aria-hidden="true" />
      </button>
      {open && (
        <div id="ai-assistant-info" className="ai-info-popover" role="dialog" aria-label={uiText.aiAssistant.aiInfoTitle}>
          <div className="ai-info-popover-title">{uiText.aiAssistant.aiInfoTitle}</div>
          <dl>
            {details.map(({ label, value }) => (
              <div className="ai-info-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {entitlement?.error && <div className="ai-info-error">{entitlement.error}</div>}
        </div>
      )}
    </div>
  );
}
