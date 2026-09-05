import './LoadingOverlay.css';

type LoadingOverlayProps = {
  message: string;
};

export function LoadingOverlay({ message }: LoadingOverlayProps) {
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <span className="loading-overlay-spinner" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
