import admin from 'firebase-admin';
import type { AgentState, TelegramSubscriber } from './types.js';

// Initialize firebase-admin from a service account JSON provided via the
// FIREBASE_SERVICE_ACCOUNT environment variable (paste the whole key JSON as a
// single-line value). When it is absent the backend keeps using its local JSON
// file, so deployments without the key continue to work.
let db: admin.firestore.Firestore | null = null;

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
if (rawServiceAccount) {
  try {
    const credentials = JSON.parse(rawServiceAccount);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(credentials) });
    }
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    console.log('Firestore persistence enabled for the agent system.');
  } catch (error) {
    console.error('FIREBASE_SERVICE_ACCOUNT is set but could not be parsed; falling back to local file store.', error);
    db = null;
  }
}

export const firestoreEnabled = db !== null;

const STATE_COLLECTION = 'agent_system';
const STATE_DOC = 'state';

// The full agent state is stored as a single JSON string field. This avoids
// Firestore's restrictions on nested arrays / undefined values and keeps the
// document well under the 1 MB limit once history is capped in the store.
export async function loadAgentStateFromFirestore(): Promise<AgentState | null> {
  if (!db) return null;
  try {
    const snapshot = await db.collection(STATE_COLLECTION).doc(STATE_DOC).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (!data || typeof data.json !== 'string') return null;
    return JSON.parse(data.json) as AgentState;
  } catch (error) {
    console.error('Failed to load agent state from Firestore:', error);
    return null;
  }
}

export async function saveAgentStateToFirestore(state: AgentState): Promise<void> {
  if (!db) return;
  await db.collection(STATE_COLLECTION).doc(STATE_DOC).set({
    json: JSON.stringify(state),
    version: state.version,
    updatedAt: new Date().toISOString(),
  });
}

// Load Telegram subscribers from the storefront's `telegramChats` collection
// (users/groups/channels that messaged the bot) and map them to the subscriber
// shape campaigns use, so approved campaigns send to the real captured audience.
export async function fetchTelegramSubscribers(): Promise<TelegramSubscriber[]> {
  if (!db) return [];
  try {
    const snapshot = await db.collection('telegramChats').get();
    return snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, any>;
      const chatId = String(data.chatId ?? doc.id);
      const language: 'km' | 'en' | 'both' =
        data.languageCode === 'km' ? 'km'
        : typeof data.languageCode === 'string' && data.languageCode.startsWith('en') ? 'en'
        : 'both';
      const subscribed = data.isSubscribed !== false && data.unsubscribed !== true && !data.unsubscribedAt;
      return {
        id: `telegramchat_${chatId}`,
        chatId,
        displayName: data.customerName ?? data.firstName ?? 'Telegram subscriber',
        isActive: data.isActive !== false,
        isSubscribed: subscribed,
        // Users who started the bot are treated as consented unless a field opts them out.
        marketingConsent: data.marketingConsent !== false,
        segmentIds: Array.isArray(data.segmentIds) ? data.segmentIds.map(String) : ['all-consented'],
        language,
        unsubscribedAt: data.unsubscribedAt,
        lastMarketingMessageAt: data.lastMarketingMessageAt,
        createdAt: typeof data.connectedAt === 'number' ? new Date(data.connectedAt).toISOString() : new Date().toISOString(),
      } satisfies TelegramSubscriber;
    });
  } catch (error) {
    console.error('Failed to load telegramChats from Firestore:', error);
    return [];
  }
}

// Read a whole collection (products, categories, orders) written by the
// storefront/admin so the backend agent operates on the real inventory.
export async function fetchFirestoreCollection<T>(name: string): Promise<T[] | null> {
  if (!db) return null;
  try {
    const snapshot = await db.collection(name).get();
    return snapshot.docs.map((doc) => doc.data() as T);
  } catch (error) {
    console.error(`Failed to load '${name}' from Firestore:`, error);
    return null;
  }
}
