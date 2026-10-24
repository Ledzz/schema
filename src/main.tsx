import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { useEditor } from './store/editor';

if (import.meta.env.DEV) Object.assign(window, { __editor: useEditor });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
