import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// 字体换代（黑室批）：Chakra Petch = 展示字（品牌/标题/数字，棱角仪器感）；
// JetBrains Mono = 等宽字（代码相关 UI）。@fontsource 自托管，不依赖外网 CDN。
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';

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
