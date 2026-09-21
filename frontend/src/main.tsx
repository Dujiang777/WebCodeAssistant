import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ToastProvider } from './lib/toast';
import { configureMonaco } from './lib/monaco';
import './styles/global.css';

// 在 React 挂载前注册主题：编辑器首帧就已经是 Web Code Assistant 配色，不会闪一下默认深色。
configureMonaco();

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
