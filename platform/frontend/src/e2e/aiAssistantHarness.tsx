import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiAssistantPanel } from '../components/AiAssistantPanel';
import '../index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AiAssistantPanel scope={{ context: 'focus-e2e', namespace: 'default', source: 'local' }} onClose={() => undefined} />
  </QueryClientProvider>,
);
