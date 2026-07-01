import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
