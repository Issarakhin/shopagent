import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getAdminAuth, getAdminFirestore } from './firestore.js';

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
  const direct = await chats.doc(user.id).get();
  if (direct.exists) {
    const data = direct.data() ?? {};
    return { ref: direct.ref, data, chatId: String((data as any).chatId ?? direct.id) };
  }

  // Support number-typed and string-typed chat IDs from older bot records.
  const numericId = Number(user.id);
  for (const field of ['chatId', 'telegramUserId', 'userId'] as const) {
    for (const candidate of [user.id, ...(Number.isSafeInteger(numericId) ? [numericId] : [])]) {
      const query = await chats.where(field, '==', candidate).limit(1).get();
      if (!query.empty) {
        const doc = query.docs[0];
        const data = doc.data() ?? {};
        return { ref: doc.ref, data, chatId: String((data as any).chatId ?? user.id) };
      }
    }
  }

  return { ref: chats.doc(user.id), data: {}, chatId: user.id };
}

async function resolveExistingFirebaseUid(user: TelegramWebUser, match: TelegramChatProfile): Promise<string> {
  const db = getAdminFirestore();
  const auth = getAdminAuth();
  if (!db || !auth) throw Object.assign(new Error('Firebase Admin is not configured on the backend.'), { code: 'FIREBASE_ADMIN_REQUIRED' });

  // 1) Prefer an explicit account link already stored on telegramChats.
  const linkedCandidates = [
    match.data.firebaseUid,
    match.data.linkedFirebaseUid,
    match.data.accountUid,
    match.data.buyerUid,
    match.data.uid,
  ];

  for (const candidate of linkedCandidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const uid = candidate.trim();
    try {
      await auth.getUser(uid);
      return uid;
    } catch (error: any) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
  }

  // 2) Find the EXISTING website account by Telegram identifiers stored on users/<uid>.
  const lookups: Array<[string, string | number]> = [
    ['telegramUserId', user.id],
    ['telegramChatId', match.chatId],
    ['chatId', match.chatId],
  ];
  const numericTelegramId = Number(user.id);
  const numericChatId = Number(match.chatId);
  if (Number.isSafeInteger(numericTelegramId)) lookups.push(['telegramUserId', numericTelegramId]);
  if (Number.isSafeInteger(numericChatId)) {
    lookups.push(['telegramChatId', numericChatId]);
    lookups.push(['chatId', numericChatId]);
  }

  for (const [field, value] of lookups) {
    const snap = await db.collection('users').where(field, '==', value).limit(1).get();
    if (snap.empty) continue;
    const uid = snap.docs[0].id;
    try {
      await auth.getUser(uid);
      return uid;
    } catch (error: any) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
  }

  // Never silently create a second Firebase account for a Telegram user.
  throw Object.assign(
    new Error('This Telegram account is not linked to an existing Shopping Cambodia web account.'),
    { code: 'ACCOUNT_NOT_LINKED' },
  );
}

async function ensureExistingFirebaseIdentity(user: TelegramWebUser, match: TelegramChatProfile) {
  const db = getAdminFirestore();
  const auth = getAdminAuth();
  if (!db || !auth) throw Object.assign(new Error('Firebase Admin is not configured on the backend.'), { code: 'FIREBASE_ADMIN_REQUIRED' });

  const firebaseUid = await resolveExistingFirebaseUid(user, match);
  const firebaseUser = await auth.getUser(firebaseUid);
  const userRef = db.collection('users').doc(firebaseUid);
  const userSnap = await userRef.get();
  const existingUser = userSnap.data() ?? {};
  const now = new Date().toISOString();

  // Keep the website account as the source of truth. Only add Telegram linkage fields.
  await userRef.set({
    uid: firebaseUid,
    telegramUserId: user.id,
    telegramChatId: match.chatId,
    telegramUsername: user.username ?? '',
    telegramLinked: true,
    updatedAt: now,
  }, { merge: true });

  // Persist the reverse link so future Mini App opens resolve immediately.
  await match.ref.set({
    chatId: match.chatId,
    telegramUserId: user.id,
    firebaseUid,
    linkedFirebaseUid: firebaseUid,
    linkedAccount: true,
    lastSeenAt: now,
    lastMiniAppSeenAt: now,
  }, { merge: true });

  const customToken = await auth.createCustomToken(firebaseUid, {
    provider: 'telegram',
    telegramUserId: user.id,
  });

  return {
    firebaseUid,
    customToken,
    firebaseUser,
    profile: existingUser,
  };
}

async function upsertTelegramUser(user: TelegramWebUser) {
  const match = await findTelegramChatProfile(user);
  const previous = match.data;
  const now = new Date().toISOString();
  const identity = await ensureExistingFirebaseIdentity(user, match);
  const profile = {
    chatId: match.chatId,
    telegramUserId: user.id,
    userId: user.id,
    customerId: identity.firebaseUid,
    firebaseUid: identity.firebaseUid,
    linkedFirebaseUid: identity.firebaseUid,
    customerName: String(identity.profile.displayName ?? previous.customerName ?? previous.displayName ?? displayName(user)),
    displayName: String(identity.profile.displayName ?? previous.displayName ?? previous.customerName ?? displayName(user)),
    firstName: user.firstName,
    lastName: user.lastName ?? '',
    username: user.username ?? '',
    languageCode: user.languageCode ?? String(previous.languageCode ?? ''),
    photoUrl: user.photoUrl ?? String(previous.photoUrl ?? ''),
    isPremium: user.isPremium === true,
    phone: String(identity.profile.phone ?? previous.phone ?? previous.customerPhone ?? ''),
    address: String(identity.profile.address ?? previous.address ?? previous.customerAddress ?? ''),
    source: String(previous.source ?? 'telegram_bot'),
    miniAppEnabled: true,
    linkedAccount: true,
    isActive: previous.isActive !== false,
    createdAt: previous.createdAt ?? previous.connectedAt ?? now,
    lastSeenAt: now,
    lastMiniAppSeenAt: now,
  };
  await match.ref.set(profile, { merge: true });
  return { ...profile, firestoreDocumentId: match.ref.id, firebaseCustomToken: identity.customToken };
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
      firebaseCustomToken: profile.firebaseCustomToken,
      user: {
        id: user.id,
        userId: profile.firebaseUid,
        firebaseUid: profile.firebaseUid,
        chatId: profile.chatId,
        displayName: profile.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl || profile.photoUrl,
        phone: profile.phone,
        address: profile.address,
        linkedAccount: true,
      },
    });
  } catch (error: any) {
    const code = error?.code ?? 'TELEGRAM_SESSION_FAILED';
    const status = code === 'ACCOUNT_NOT_LINKED' ? 403 : ['FIRESTORE_ADMIN_REQUIRED', 'FIREBASE_ADMIN_REQUIRED'].includes(code) ? 503 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), code });
  }
});

telegramWebAppRouter.post('/orders', telegramAuth, async (req: TelegramRequest, res) => {
  try {
    const user = req.telegramUser!;
    const db = getAdminFirestore();
    if (!db) throw Object.assign(new Error('Firestore Admin is not configured on the backend.'), { code: 'FIRESTORE_ADMIN_REQUIRED' });

    const chatProfile = await findTelegramChatProfile(user);
    const identity = await ensureExistingFirebaseIdentity(user, chatProfile);
    const userProfile = await db.collection('users').doc(identity.firebaseUid).get();
    const userData = userProfile.data() ?? {};
    const customerName = String(req.body?.customerName ?? userData.displayName ?? chatProfile.data.customerName ?? displayName(user)).trim();
    const customerPhone = String(req.body?.customerPhone ?? userData.phone ?? chatProfile.data.phone ?? chatProfile.data.customerPhone ?? '').trim();
    const customerAddress = String(req.body?.customerAddress ?? userData.address ?? chatProfile.data.address ?? chatProfile.data.customerAddress ?? '').trim();
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
        customerEmail: String(userData.email ?? ''),
        customerPhone,
        customerAddress,
        items: orderItems,
        subtotal: Number(subtotal.toFixed(2)),
        tax: Number(tax.toFixed(2)),
        totalAmount,
        status: 'pending',
        buyerUid: identity.firebaseUid,
        firebaseUid: identity.firebaseUid,
        telegramUserId: user.id,
        telegramChatId: chatProfile.chatId,
        telegramUsername: user.username ?? '',
        orderSource: 'telegram_webapp',
        createdAt,
      };
      transaction.set(db.collection('orders').doc(orderId), newOrder);
      transaction.set(chatProfile.ref, {
        chatId: chatProfile.chatId,
        telegramUserId: user.id,
        userId: user.id,
        customerId: identity.firebaseUid,
        firebaseUid: identity.firebaseUid,
        linkedFirebaseUid: identity.firebaseUid,
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
        linkedAccount: true,
        lastSeenAt: createdAt,
        lastMiniAppSeenAt: createdAt,
        lastOrderAt: createdAt,
      }, { merge: true });
      transaction.set(db.collection('users').doc(identity.firebaseUid), {
        uid: identity.firebaseUid,
        displayName: customerName,
        phone: customerPhone,
        address: customerAddress,
        telegramUserId: user.id,
        telegramChatId: chatProfile.chatId,
        telegramLinked: true,
        updatedAt: createdAt,
      }, { merge: true });
      return newOrder;
    });

    res.status(201).json({ ok: true, order });
  } catch (error: any) {
    const status = error?.code === 'ACCOUNT_NOT_LINKED' ? 403 : ['FIRESTORE_ADMIN_REQUIRED', 'FIREBASE_ADMIN_REQUIRED'].includes(error?.code) ? 503 : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: error?.code });
  }
});
