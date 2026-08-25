import { Modal } from './Modal';

interface DetailsModalProps {
  title: string;
  rows: Array<[string, string | number | undefined]>;
  onClose: () => void;
}

/** Simple key/value details popup used by list views' "Show details" action. */
export function DetailsModal({ title, rows, onClose }: DetailsModalProps) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="app-props-table">
        {rows.map(([label, value]) => (
          <div className="app-props-row" key={label}>
            <span>{label}</span>
            <span className="mono">{value === undefined || value === '' ? '-' : value}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
