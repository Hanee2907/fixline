import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { User } from '../../shared/types';
import { Console } from './agent/Console';
import { api } from './api';
import { AuthPage, ResetPage } from './Auth';
import { Portal } from './portal/Portal';
import { ToastHost } from './ui';
import './styles.css';

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => { api.me().then((r) => setUser(r.user)).catch(() => setUser(null)); }, []);
  const reset = location.hash.match(/^#\/reset\/([\w-]{20,})/)?.[1];
  if (reset) return <ResetPage token={reset} onUser={(u) => { location.hash = ''; setUser(u); }} />;
  if (user === undefined) return <div className="loading">Fixline</div>;
  if (!user) return <AuthPage onUser={setUser} />;
  // key: switching between agent and employee in the demo starts each view fresh.
  return user.role === 'requester'
    ? <Portal key={user.id} user={user} onUser={setUser} />
    : <Console key={user.id} user={user} onUser={setUser} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ToastHost><App /></ToastHost></StrictMode>);
