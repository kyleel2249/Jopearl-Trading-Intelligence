import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.jopearl.jpti',
  appName: 'JPTI',
  webDir: 'dist',
  android: { allowMixedContent: false, backgroundColor: '#080d18' },
  plugins: {
    SplashScreen: { launchShowDuration: 1200, backgroundColor: '#080d18' }
  }
};

export default config;
