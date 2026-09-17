import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.famille.listecourses',
  appName: 'Liste Courses',
  webDir: 'dist',
  server: {
    cleartext: true,
    androidScheme: 'http',
  },
  plugins: {
    Camera: {
      // Pas de config spécifique requise ; permissions demandées au runtime.
    },
  },
};

export default config;
