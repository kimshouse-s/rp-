import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { claudeBridge } from './server/claudeBridge';

export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // GitHub Pages는 https://<계정>.github.io/<저장소>/ 하위 경로로 서비스한다.
      // 이 값을 안 맞추면 배포본이 자산 경로를 못 찾아 흰 화면만 뜬다.
      // 개발 서버는 루트로 두어야 localhost:3000 이 그대로 열린다.
      base: command === 'build' ? '/rp-/' : '/',
      server: {
        port: 3000,
        // 같은 네트워크의 폰에서 접속하려면 모든 인터페이스에 바인딩해야 한다.
        // true로 두면 Vite가 시작할 때 접속용 Network 주소도 함께 출력한다.
        host: true,
        // 포트가 이미 쓰이면 조용히 다른 포트로 넘어가지 않고 실패시킨다.
        // 폰에 저장해둔 주소가 어느 날 갑자기 안 열리는 상황을 막는다.
        strictPort: true,
      },
      plugins: [react(), claudeBridge()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
        'process.env': JSON.stringify({
          GEMINI_API_KEY: env.GEMINI_API_KEY || '',
          API_KEY: env.GEMINI_API_KEY || ''
        })
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
