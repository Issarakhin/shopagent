import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  getDocs, 
  doc, 
  setDoc, 
  writeBatch
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { INITIAL_CATEGORIES, INITIAL_PRODUCTS } from './data';

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firebase Auth
export const auth = getAuth(app);

// Initialize Cloud Firestore and specify custom database ID from config
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || undefined);

/**
 * Seed the Firestore database with initial products and categories if they are empty.
 */
export async function seedDatabaseIfEmpty() {
  try {
    const categoriesCol = collection(db, 'categories');
    const categoriesSnapshot = await getDocs(categoriesCol);
    
    if (categoriesSnapshot.empty) {
      console.log('Seeding initial categories to Firestore...');
      const batch = writeBatch(db);
      for (const cat of INITIAL_CATEGORIES) {
        const catRef = doc(db, 'categories', cat.id);
        batch.set(catRef, cat);
      }
      await batch.commit();
      console.log('Categories seeded successfully.');
    }

    const productsCol = collection(db, 'products');
    const productsSnapshot = await getDocs(productsCol);

    if (productsSnapshot.empty) {
      console.log('Seeding initial products to Firestore...');
      const batch = writeBatch(db);
      for (const prod of INITIAL_PRODUCTS) {
        const prodRef = doc(db, 'products', prod.id);
        batch.set(prodRef, prod);
      }
      await batch.commit();
      console.log('Products seeded successfully.');
    }
  } catch (error) {
    console.error('Error seeding Firestore database:', error);
  }
}

export { app };
