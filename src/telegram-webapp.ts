export interface TelegramMiniAppUser {
  id: string;
  userId?: string;
  firebaseUid?: string;
  chatId?: string;
  displayName?: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  photoUrl?: string;
  phone?: string;
  address?: string;
  linkedAccount?: boolean;
}

type TelegramWebAppApi = {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number | string;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      photo_url?: string;
    };
    start_param?: string;
  };
  platform?: string;
  version?: string;
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebAppApi };
  }
}

export function getTelegramWebApp(): TelegramWebAppApi | undefined {
  return window.Telegram?.WebApp;
}

export function initializeTelegramWebApp() {
  const webApp = getTelegramWebApp();
  webApp?.ready?.();
  webApp?.expand?.();
  return webApp;
}

export function telegramInitData(): string {
  return getTelegramWebApp()?.initData ?? '';
}

/**
 * Detect Telegram without requiring initData to be populated at the exact
 * moment the JS bundle first evaluates. Telegram Desktop can initialize the
 * WebApp bridge after our ES module starts, and Telegram also places launch
 * parameters such as tgWebAppData/tgWebAppVersion in the URL fragment.
 */
export function hasTelegramLaunchContext(): boolean {
  if (window.location.pathname.startsWith('/telegram')) return true;

  const webApp = getTelegramWebApp();
  if (webApp?.initData) return true;

  const platform = webApp?.platform?.toLowerCase();
  if (platform && platform !== 'unknown') return true;

  const locationText = `${window.location.search}${window.location.hash}`;
  return /(?:^|[?#&])tgWebApp(?:Data|Version|Platform|ThemeParams)=/i.test(locationText);
}

export function isTelegramMiniApp(): boolean {
  return hasTelegramLaunchContext();
}

export async function waitForTelegramWebApp(timeoutMs = 2500): Promise<TelegramWebAppApi | undefined> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const webApp = getTelegramWebApp();
    if (webApp?.initData || hasTelegramLaunchContext()) return webApp;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }

  return getTelegramWebApp();
}

export function unsafeTelegramUserId(): string | undefined {
  const id = getTelegramWebApp()?.initDataUnsafe?.user?.id;
  return id === undefined || id === null ? undefined : String(id);
}
