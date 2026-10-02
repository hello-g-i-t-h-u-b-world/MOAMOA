import { defineConfig } from 'vite';

// GitHub Pages는 https://<user>.github.io/MOAMOA/ 경로로 서비스되므로 빌드 시 base를 맞춘다.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/MOAMOA/' : '/',
  worker: { format: 'es' },
}));
