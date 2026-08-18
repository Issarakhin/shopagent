export interface TelegramMiniAppUser {
  id: string;
  userId?: string;
  chatId?: string;
  displayName?: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  photoUrl?: string;
  phone?: string;
  address?: string;
  linkedAccount?: false;
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
  };
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

export function unsafeTelegramUserId(): string | undefined {
  const id = getTelegramWebApp()?.initDataUnsafe?.user?.id;
  return id === undefined || id === null ? undefined : String(id);
}
