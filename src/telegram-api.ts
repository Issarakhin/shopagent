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
  if (!response.ok) {
    const error = new Error(payload.error ?? `Telegram request failed (${response.status}).`) as Error & { code?: string; details?: unknown };
    error.code = payload.code;
    error.details = payload;
    throw error;
  }
  return payload as T;
}

async function createAccountLink(firebaseIdToken: string) {
  const response = await fetch(apiUrl('/api/telegram/link/start'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${firebaseIdToken}`,
    },
    body: JSON.stringify({}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Could not start Telegram account linking (${response.status}).`);
  return payload as { ok: true; telegramUrl: string; startParam: string; expiresAt: string };
}

export const telegramApi = {
  createAccountLink,
  session: (initData?: string) => telegramRequest<any>('/session', {
    method: 'POST',
    body: JSON.stringify({ initData: initData ?? telegramInitData() }),
  }),
  createOrder: (payload: {
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    items: Array<{ productId: string; quantity: number }>;
  }) => telegramRequest<any>('/orders', { method: 'POST', body: JSON.stringify(payload) }),
};
