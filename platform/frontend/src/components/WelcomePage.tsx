import { useState } from 'react';
import { Box, GitBranch, Radio } from 'lucide-react';

interface WelcomePageProps {
  version: string;
  onClose: (dontShowAgain: boolean) => void;
  onDontShowAgainChange: (dontShowAgain: boolean) => void;
  onOpenMinikube: () => void;
  onOpenAzure: () => void;
  onOpenAws: () => void;
}

const capabilities = [
  { icon: Box, title: 'Explore resources', detail: 'Browse and manage live workloads across namespaces.' },
  { icon: GitBranch, title: 'See relationships', detail: 'Map how services, workloads, and Helm releases connect.' },
  { icon: Radio, title: 'Follow changes', detail: 'Stream logs and review recorded cluster events.' },
] as const;

export function WelcomePage({ version, onClose, onDontShowAgainChange, onOpenMinikube, onOpenAzure, onOpenAws }: WelcomePageProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const updateDontShowAgain = (checked: boolean) => {
    setDontShowAgain(checked);
    onDontShowAgainChange(checked);
  };

  return (
    <main className="welcome-page" aria-labelledby="welcome-title">
      <header className="welcome-heading">
        <p className="welcome-version">FOCUSKUBE · {version}</p>
        <h1 id="welcome-title">Welcome to FocusKube</h1>
        <p className="welcome-intro">
          Explore Kubernetes resources, understand workload relationships, and investigate cluster changes in one workspace.
        </p>
      </header>

      <section className="welcome-capabilities" aria-label="FocusKube features">
        {capabilities.map(({ icon: Icon, title, detail }) => (
          <article className="welcome-feature" key={title}>
            <Icon size={18} aria-hidden="true" />
            <div>
              <h2>{title}</h2>
              <p>{detail}</p>
            </div>
          </article>
        ))}
      </section>

      <section className="welcome-connections" aria-labelledby="welcome-connect-title">
        <h2 id="welcome-connect-title">Connect a cluster</h2>
        <div className="welcome-connect-actions">
          <button type="button" onClick={onOpenMinikube}>Local / Minikube</button>
          <button type="button" onClick={onOpenAzure}>Azure AKS</button>
          <button type="button" onClick={onOpenAws}>AWS EKS</button>
        </div>
      </section>

      <footer className="welcome-footer">
        <label className="welcome-optout">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(event) => updateDontShowAgain(event.target.checked)}
          />
          <span>Don’t show me again until the next update</span>
        </label>
        <button className="welcome-done" type="button" onClick={() => onClose(dontShowAgain)}>
          Close welcome
        </button>
      </footer>
    </main>
  );
}
