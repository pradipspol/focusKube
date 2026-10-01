import { uiText } from '../text';

interface Props {
  query: string;
  placeholder: string;
  ariaLabel: string;
  countLabel: string;
  canNavigate: boolean;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function TerminalSearchControls({
  query,
  placeholder,
  ariaLabel,
  countLabel,
  canNavigate,
  onQueryChange,
  onPrevious,
  onNext,
}: Props) {
  return (
    <>
      <input
        className="terminal-session-search-input"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <button className="terminal-search-nav-button" type="button" onClick={onPrevious} disabled={!canNavigate}>
        {uiText.terminalDock.previous}
      </button>
      <button className="terminal-search-nav-button" type="button" onClick={onNext} disabled={!canNavigate}>
        {uiText.terminalDock.next}
      </button>
      <span className="terminal-session-search-count">{countLabel}</span>
    </>
  );
}