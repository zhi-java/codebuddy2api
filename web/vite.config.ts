import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { compression } from 'vite-plugin-compression2';

/**
 * 管理控制台构建配置。
 *
 * base 设为 /admin/：产物由网关进程在 /admin 下托管，
 * 资源引用统一带前缀，避免与网关 API 路由冲突。
 *
 * 构建期预压缩：网关进程本身不做运行时压缩（CPU 宝贵且易成瓶颈），
 * 而是在这里把 .br / .gz 作为**独立文件**产出，由 static.ts 按
 * Accept-Encoding 协商直接返回。不引入运行时依赖，也无额外内存开销。
 * 阈值 1KB 以下不压缩：小文件压缩后常反而变大，且省不下一个往返。
 */
export default defineConfig({
  plugins: [
    vue(),
    compression({
      algorithms: ['brotliCompress', 'gzip'],
      threshold: 1024,
      // 字体/图片本身已是压缩格式，再压收益极低（woff2 通常 <2%）
      exclude: [/\.(woff2?|png|jpe?g|webp|avif|ico)$/],
    }),
  ],
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
