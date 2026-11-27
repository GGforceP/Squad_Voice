import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './conversation.css';

const root = document.getElementById('root')!;
if (import.meta.env.MODE === 'qa') {
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('[data-testid="login-screen"]') || node.querySelector('[data-testid="login-screen"]'))) {
          root.dataset.loginSeen = 'true';
          observer.disconnect();
          return;
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  void import('./qa');
}
createRoot(root).render(<App />);
