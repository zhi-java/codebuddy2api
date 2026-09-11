import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 管理控制台构建配置。
 *
 * base 设为 /admin/：产物由网关进程在 /admin 下托管，
 * 资源引用统一带前缀，避免与网关 API 路由冲突。
 */
export default defineConfig({
  plugins: [vue()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // 组件库与框架单独成块:升级业务代码不会让浏览器重新下载这 200KB+
        manualChunks: {
          'vendor-vue': ['vue'],
          'vendor-naive': ['naive-ui'],
        },
      },
    },
  },
});
