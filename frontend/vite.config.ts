import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期由 Vite 代理 /api 到后端，避免前端直接处理 CORS；
 * 生产构建产物由 nginx 托管，同样把 /api 反代到后端。
 *
 * 两个刻意的写法：
 *  1. 代理目标用 {@link loadEnv} 读，而不是 `process.env` ——
 *     这样 vite.config.ts 不需要引入 @types/node 就能通过类型检查；
 *  2. SSE 必须关掉代理层缓冲，否则事件会被攒着一起发（流式输出会变成「一次性蹦出来」）。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8080';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              }
            });
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 3000,
      rollupOptions: {
        output: {
          manualChunks: {
            monaco: ['monaco-editor'],
          },
        },
      },
    },
  };
});
