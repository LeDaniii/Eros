import { defineConfig } from 'vite';
// @ts-ignore - Das ignoriert den Typ-Fehler beim SSL Plugin
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
    plugins: [
        basicSsl() // Wir bleiben bei HTTPS, das ist sicherer für SharedArrayBuffer
    ],
    server: {
        // Jetzt wo die Config im Root liegt, werden diese Header endlich gesendet!
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'cross-origin'
        }
    },
    worker: {
        format: 'es'
    }
});