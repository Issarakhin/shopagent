import admin from 'firebase-admin';
import type { AgentState, TelegramSubscriber } from './types.js';

// Initialize firebase-admin from a service account JSON provided via the
// FIREBASE_SERVICE_ACCOUNT environment variable (paste the whole key JSON as a
// single-line value). When it is absent the backend keeps using its local JSON
// file, so deployments without the key continue to work.
let db: admin.firestore.Firestore | null = null;

// Accept either name so an existing FIREBASE_SERVICE_ACCOUNT_JSON config var works too.
const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ?? process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
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

// Firestore rejects any document field larger than 1,048,487 bytes. The agent
// state grows unbounded (audit logs, executions, recipients, telemetry events),
// so we persist a trimmed copy: cap the high-volume history arrays, then, as a
// hard safety net, keep shrinking the largest arrays until the serialized JSON
// comfortably fits. Newest entries are kept (arrays are stored newest-first).
const FIRESTORE_MAX_JSON_BYTES = 1_000_000; // leave headroom under the 1 MiB limit

function trimStateForFirestore(state: AgentState): AgentState {
  const cap = <T>(arr: T[] | undefined, n: number): T[] => (Array.isArray(arr) ? arr.slice(0, n) : []);
  return {
    ...state,
    auditLogs: cap(state.auditLogs, 300),
    executions: cap(state.executions, 300),
    workflows: cap(state.workflows, 150),
    campaignRecipients: cap(state.campaignRecipients, 500),
    events: cap(state.events, 300),
    memories: cap(state.memories, 200),
    cache: cap(state.cache, 200),
    marketTrends: cap(state.marketTrends, 100),
    dailyBoostRecommendations: cap(state.dailyBoostRecommendations, 100),
    marketIntelligenceRuns: cap(state.marketIntelligenceRuns, 60),
    campaigns: cap(state.campaigns, 300),
  };
}

export async function saveAgentStateToFirestore(state: AgentState): Promise<void> {
  if (!db) return;
  let trimmed = trimStateForFirestore(state);
  let json = JSON.stringify(trimmed);
  // Hard safety net: if still too large, keep halving the biggest history arrays.
  const shrinkFields: Array<keyof AgentState> = ['auditLogs', 'executions', 'campaignRecipients', 'events', 'workflows', 'memories'];
  let guard = 0;
  while (Buffer.byteLength(json, 'utf8') > FIRESTORE_MAX_JSON_BYTES && guard < 20) {
    for (const field of shrinkFields) {
      const arr = trimmed[field] as unknown[];
      if (Array.isArray(arr) && arr.length > 10) (trimmed[field] as unknown[]) = arr.slice(0, Math.floor(arr.length / 2));
    }
    json = JSON.stringify(trimmed);
    guard += 1;
  }
  await db.collection(STATE_COLLECTION).doc(STATE_DOC).set({
    json,
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
