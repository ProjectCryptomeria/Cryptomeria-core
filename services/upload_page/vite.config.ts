import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
    base: './',
    plugins: [
        react(),
        // CosmJSなどのライブラリが依存するNode.jsのGlobal変数(Buffer, process等)をブラウザで使えるようにする
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
            protocolImports: true,
        }),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        host: '0.0.0.0',
        port: 5173,
    },
    build: {
        outDir: 'dist', // 出力先ディレクトリ
        emptyOutDir: true,
        sourcemap: true,
    },
});
