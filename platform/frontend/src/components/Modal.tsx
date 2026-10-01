import { type ReactNode } from 'react';
import { uiText } from '../text';
import { CloseButton } from './CloseButton';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  cardClassName?: string;
  bodyClassName?: string;
  closeLabel?: string;
  role?: 'dialog' | 'alertdialog';
}

export function Modal({ title, onClose, children, footer, cardClassName, bodyClassName, closeLabel, role }: ModalProps) {
  return (
    <div className="overlay center" onClick={onClose}>
      <div
        className={['modal-card', cardClassName].filter(Boolean).join(' ')}
        role={role}
        aria-modal={role ? true : undefined}
        aria-label={role ? title : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <CloseButton label={closeLabel ?? uiText.common.close} onClick={onClose} />
        </div>
        <div className={['modal-body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
