import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.galgame.savedatasync',
  appName: '存档同步',
  webDir: 'dist',
  server: { androidScheme: 'http', cleartext: true },
};

export default config;
