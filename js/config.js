/** GitHub Pages base path (repo name). Local file:// / custom domain: set to ''. */
export const BASE = '/hatangvinhlinh';
/** Bump when shipping UI so Android PWA cache can be verified. */
export const APP_VERSION = '23';

/** Root duy nhất — được xóa cảnh báo và cấp quyền admin. */
export const ROOT_EMAIL = 'ebacson@gmail.com';

export const firebaseConfig = {
  apiKey: 'AIzaSyB-4uSMb-r5Bww3Te664x2VswGx82Ewnf8',
  authDomain: 'ghunter-4b0a8.firebaseapp.com',
  databaseURL: 'https://ghunter-4b0a8-default-rtdb.firebaseio.com',
  projectId: 'ghunter-4b0a8',
  storageBucket: 'ghunter-4b0a8.firebasestorage.app',
  messagingSenderId: '14888557209',
};

export const ALERT_TABS = [
  { id: 'MAY_NO_EAS', title: 'Máy nổ', showFuel: true },
  { id: 'POWER_AC_EAS', title: 'Mất AC', showFuel: false },
  { id: 'POWER_DC_EAS', title: 'DC thấp', showFuel: false },
  { id: 'SITE_OOS', title: 'Mất LL', showFuel: false },
];

export const LONG_RUN_MS = 8 * 60 * 60 * 1000;
export const LOW_FUEL_PERCENT = 10;
