// Same Firebase project as the planting tracker (../trees.js).
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {getFirestore} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {getAuth} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD7rRlgyK53VyzBK0JgJDW4QAGLW58VqfA',
  authDomain: 'tree-planting-tracker-b72c9.firebaseapp.com',
  projectId: 'tree-planting-tracker-b72c9',
  storageBucket: 'tree-planting-tracker-b72c9.firebasestorage.app',
  messagingSenderId: '513598794921',
  appId: '1:513598794921:web:0342df842c874c6318cdb8',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
