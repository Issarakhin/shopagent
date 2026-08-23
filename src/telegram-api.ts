import { telegramInitData } from './telegram-webapp';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

async function telegramRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const initData = telegramInitData();
  const response = await fetch(apiUrl(`/api/telegram${path}`), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Telegram request failed (${response.status}).`);
  return payload as T;
}

export const telegramApi = {
  session: () => telegramRequest<any>('/session', { method: 'POST', body: JSON.stringify({}) }),
  createOrder: (payload: {
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    items: Array<{ productId: string; quantity: number }>;
  }) => telegramRequest<any>('/orders', { method: 'POST', body: JSON.stringify(payload) }),
};
