import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getAdminFirestore } from './firestore.js';

export interface TelegramWebUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  photoUrl?: string;
  isPremium?: boolean;
}

interface TelegramRequest extends Request {
  telegramUser?: TelegramWebUser;
  telegramInitData?: string;
}

interface TelegramChatProfile {
  ref: FirebaseFirestore.DocumentReference;
  data: Record<string, any>;
  chatId: string;
}

function parseTelegramUser(value: string | null): TelegramWebUser {
  if (!value) throw Object.assign(new Error('Telegram user data is missing.'), { code: 'TELEGRAM_USER_MISSING' });
  const raw = JSON.parse(value) as Record<string, unknown>;
  if (raw.id === undefined || raw.id === null) {
    throw Object.assign(new Error('Telegram user ID is missing.'), { code: 'TELEGRAM_USER_ID_MISSING' });
  }
  return {
    id: String(raw.id),
    firstName: String(raw.first_name ?? 'Telegram user'),
    lastName: typeof raw.last_name === 'string' ? raw.last_name : undefined,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    languageCode: typeof raw.language_code === 'string' ? raw.language_code : undefined,
    photoUrl: typeof raw.photo_url === 'string' ? raw.photo_url : undefined,
    isPremium: raw.is_premium === true,
  };
}

export function validateTelegramInitData(initData: string): TelegramWebUser {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is not configured.'), { code: 'TELEGRAM_BOT_TOKEN_REQUIRED' });
  }
  if (!initData) {
    throw Object.assign(new Error('Telegram initData is required. Open this page inside Telegram.'), { code: 'TELEGRAM_INIT_DATA_REQUIRED' });
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw Object.assign(new Error('Telegram initData hash is missing or invalid.'), { code: 'TELEGRAM_INIT_DATA_INVALID' });
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const left = Buffer.from(calculatedHash, 'hex');
  const right = Buffer.from(receivedHash, 'hex');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw Object.assign(new Error('Telegram initData validation failed.'), { code: 'TELEGRAM_INIT_DATA_INVALID' });
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  const maxAgeSeconds = Math.max(60, Number(process.env.TELEGRAM_WEBAPP_MAX_AUTH_AGE_SECONDS ?? 86400));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || nowSeconds - authDate > maxAgeSeconds || authDate > nowSeconds + 60) {
    throw Object.assign(new Error('Telegram session is too old. Reopen the Mini App from Telegram.'), { code: 'TELEGRAM_INIT_DATA_EXPIRED' });
  }

  return parseTelegramUser(params.get('user'));
}

function telegramAuth(req: TelegramRequest, res: Response, next: NextFunction) {
  try {
    const initData = String(req.header('x-telegram-init-data') ?? req.body?.initData ?? '');
    req.telegramInitData = initData;
    req.telegramUser = validateTelegramInitData(initData);
    next();
  } catch (error: any) {
    const code = error?.code ?? 'TELEGRAM_AUTH_FAILED';
    const status = code === 'TELEGRAM_BOT_TOKEN_REQUIRED' ? 503 : 401;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), code });
  }
}

function displayName(user: TelegramWebUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Telegram user';
}

async function findTelegramChatProfile(user: TelegramWebUser): Promise<TelegramChatProfile> {
  const db = getAdminFirestore();
  if (!db) throw Object.assign(new Error('Firestore Admin is not configured on the backend.'), { code: 'FIRESTORE_ADMIN_REQUIRED' });

  const chats = db.collection('telegramChats');

  // Common bot storage pattern: document ID is the private Telegram chat ID.
  const direct = await chats.doc(user.id).get();
  if (direct.exists) {
    const data = direct.data() ?? {};
    return { ref: direct.ref, data, chatId: String((data as any).chatId ?? direct.id) };
  }

  // Support existing stores where the document uses an auto-ID and keeps the
  // Telegram identifier in a field. In a private bot chat, chatId normally
  // equals the Telegram user ID, so all of these resolve the same person.
  for (const field of ['chatId', 'telegramUserId', 'userId'] as const) {
    const query = await chats.where(field, '==', user.id).limit(1).get();
    if (!query.empty) {
      const doc = query.docs[0];
      const data = doc.data() ?? {};
      return { ref: doc.ref, data, chatId: String((data as any).chatId ?? user.id) };
    }
  }

  // A valid Telegram Mini App signature is already sufficient identity proof.
  // If the bot has not persisted the chat yet, create the canonical record so
  // future bot messages, orders, and Mini App sessions share one identity.
  return { ref: chats.doc(user.id), data: {}, chatId: user.id };
}

async function upsertTelegramUser(user: TelegramWebUser) {
  const match = await findTelegramChatProfile(user);
  const previous = match.data;
  const now = new Date().toISOString();
  const profile = {
    chatId: match.chatId,
    telegramUserId: user.id,
    userId: user.id,
    customerId: `tg:${user.id}`,
    customerName: String(previous.customerName ?? previous.displayName ?? displayName(user)),
    displayName: String(previous.displayName ?? previous.customerName ?? displayName(user)),
    firstName: user.firstName,
    lastName: user.lastName ?? '',
    username: user.username ?? '',
    languageCode: user.languageCode ?? String(previous.languageCode ?? ''),
    photoUrl: user.photoUrl ?? String(previous.photoUrl ?? ''),
    isPremium: user.isPremium === true,
    phone: String(previous.phone ?? previous.customerPhone ?? ''),
    address: String(previous.address ?? previous.customerAddress ?? ''),
    source: String(previous.source ?? 'telegram_bot'),
    miniAppEnabled: true,
    // Telegram identity is the account. There is deliberately no Firebase UID link.
    linkedAccount: false,
    isActive: previous.isActive !== false,
    createdAt: previous.createdAt ?? previous.connectedAt ?? now,
    lastSeenAt: now,
    lastMiniAppSeenAt: now,
  };
  await match.ref.set(profile, { merge: true });
  return { ...profile, firestoreDocumentId: match.ref.id };
}

export const telegramWebAppRouter = Router();

telegramWebAppRouter.post('/session', telegramAuth, async (req: TelegramRequest, res) => {
  try {
    const user = req.telegramUser!;
    const profile = await upsertTelegramUser(user);
    res.json({
      ok: true,
      authenticated: true,
      identityProvider: 'telegram',
      user: {
        id: user.id,
        userId: `tg:${user.id}`,
        chatId: profile.chatId,
        displayName: profile.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl || profile.photoUrl,
        phone: profile.phone,
        address: profile.address,
        linkedAccount: false,
      },
    });
  } catch (error: any) {
    res.status(error?.code === 'FIRESTORE_ADMIN_REQUIRED' ? 503 : 500).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
  }
});

telegramWebAppRouter.post('/orders', telegramAuth, async (req: TelegramRequest, res) => {
  try {
    const user = req.telegramUser!;
    const db = getAdminFirestore();
    if (!db) throw Object.assign(new Error('Firestore Admin is not configured on the backend.'), { code: 'FIRESTORE_ADMIN_REQUIRED' });

    const chatProfile = await findTelegramChatProfile(user);
    const customerName = String(req.body?.customerName ?? chatProfile.data.customerName ?? displayName(user)).trim();
    const customerPhone = String(req.body?.customerPhone ?? chatProfile.data.phone ?? chatProfile.data.customerPhone ?? '').trim();
    const customerAddress = String(req.body?.customerAddress ?? chatProfile.data.address ?? chatProfile.data.customerAddress ?? '').trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!customerName || !customerPhone || !customerAddress || items.length === 0) {
      return res.status(400).json({ error: 'Name, phone, delivery address, and at least one item are required.' });
    }

    const normalizedItems = items.map((item: any) => ({
      productId: String(item?.productId ?? ''),
      quantity: Math.max(1, Math.trunc(Number(item?.quantity ?? 0))),
    })).filter((item: { productId: string; quantity: number }) => item.productId && Number.isFinite(item.quantity));
    if (!normalizedItems.length || normalizedItems.length !== items.length) {
      return res.status(400).json({ error: 'One or more checkout items are invalid.' });
    }

    const orderId = `tgord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const order = await db.runTransaction(async (transaction) => {
      const productRows: Array<{ ref: any; id: string; name: string; price: number; quantity: number; stock: number }> = [];
      for (const item of normalizedItems) {
        const ref = db.collection('products').doc(item.productId);
        const snap = await transaction.get(ref);
        if (!snap.exists) throw new Error(`Product ${item.productId} was not found.`);
        const product = snap.data() as Record<string, any>;
        const stock = Number(product.stock ?? 0);
        if (stock < item.quantity) throw new Error(`Insufficient stock for ${String(product.name ?? item.productId)}. Available: ${stock}.`);
        productRows.push({ ref, id: item.productId, name: String(product.name ?? item.productId), price: Number(product.price ?? 0), quantity: item.quantity, stock });
      }

      let subtotal = 0;
      const orderItems = productRows.map((row) => {
        subtotal += row.price * row.quantity;
        transaction.update(row.ref, { stock: row.stock - row.quantity });
        return { productId: row.id, productName: row.name, quantity: row.quantity, price: row.price };
      });
      const tax = subtotal * 0.08;
      const totalAmount = Number((subtotal + tax).toFixed(2));
      const createdAt = new Date().toISOString();
      const newOrder = {
        id: orderId,
        customerName,
        customerEmail: '',
        customerPhone,
        customerAddress,
        items: orderItems,
        subtotal: Number(subtotal.toFixed(2)),
        tax: Number(tax.toFixed(2)),
        totalAmount,
        status: 'pending',
        buyerUid: `tg:${user.id}`,
        telegramUserId: user.id,
        telegramChatId: chatProfile.chatId,
        telegramUsername: user.username ?? '',
        orderSource: 'telegram_webapp',
      };
      transaction.set(db.collection('orders').doc(orderId), newOrder);
      transaction.set(chatProfile.ref, {
        chatId: chatProfile.chatId,
        telegramUserId: user.id,
        userId: user.id,
        customerId: `tg:${user.id}`,
        customerName,
        displayName: customerName,
        firstName: user.firstName,
        lastName: user.lastName ?? '',
        username: user.username ?? '',
        languageCode: user.languageCode ?? '',
        photoUrl: user.photoUrl ?? '',
        phone: customerPhone,
        address: customerAddress,
        miniAppEnabled: true,
        linkedAccount: false,
        lastSeenAt: createdAt,
        lastMiniAppSeenAt: createdAt,
        lastOrderAt: createdAt,
      }, { merge: true });
      return newOrder;
    });

    res.status(201).json({ ok: true, order });
  } catch (error: any) {
    const status = error?.code === 'FIRESTORE_ADMIN_REQUIRED' ? 503 : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
  }
});
