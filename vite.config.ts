import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Version affichée dans Réglages (la PWA n'a pas accès à CapApp.getInfo).
const pkg = require('./package.json') as { version: string };

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? 'dev'),
  },
  plugins: [
    react(),
    // PWA installable (Chrome : "Installer l'application") servie en
    // sous-dossier /courses/ : chemins relatifs (base './') + hash routing.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // App shell en precache ; l'API et Gemini restent réseau pur
        // (pas de risque de liste obsolète servie du cache).
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        runtimeCaching: [
          {
            // Vignettes produits Open*Facts : cache 30 j.
            urlPattern: /^https:\/\/world\.open(food|products|beauty)facts\.org\/.*\.(jpg|jpeg|png|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'off-images',
              expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
      manifest: {
        name: 'Liste Courses Famille',
        short_name: 'Courses',
        description: 'Liste de courses partagée en famille : scan, frigo IA, temps réel.',
        lang: 'fr',
        start_url: '/courses/',
        scope: '/courses/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1120',
        theme_color: '#0f1120',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  base: './',
  server: { port: 8101 },
  preview: { port: 8101 },
});
