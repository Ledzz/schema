import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { useEditor } from './store/editor';
import { TOOLS, runTool } from './lib/webmcp';

if (import.meta.env.DEV) {
  const call = (name: string, input: Record<string, unknown> = {}) => runTool(TOOLS.find((t) => t.name === name)!, input);
  Object.assign(window, { __editor: useEditor, __tool: call });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
