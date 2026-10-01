import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiAssistantPanel } from '../components/AiAssistantPanel';
import '../index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function AiAssistantHarness() {
  const [context, setContext] = useState('focus-e2e');
  return (
    <QueryClientProvider client={queryClient}>
      <label>
        Test Kubernetes context
        <select aria-label="Test Kubernetes context" value={context} onChange={(event) => setContext(event.target.value)}>
          <option value="focus-e2e">focus-e2e</option>
          <option value="minikube">minikube</option>
        </select>
      </label>
      <AiAssistantPanel scope={{ context, namespace: 'default', source: 'local' }} onClose={() => undefined} />
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<AiAssistantHarness />);
