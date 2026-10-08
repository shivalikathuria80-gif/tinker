// Firebase: Google sign-in + saving chats to Firestore (the cloud database).
// Chats live at users/{uid}/chats/{chatId}. Firestore security rules (firestore.rules)
// make sure each person can only read and write their own chats.
//
// This web config is public on purpose (every Firebase web app ships it); the security rules protect the data.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile,
  deleteUser, reauthenticateWithPopup, reauthenticateWithCredential, EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyAK2ooD81mvhgGXrEyvRn5tT7GDpBbhs4A",
  authDomain: "tinkeraidev.firebaseapp.com",
  projectId: "tinkeraidev",
  storageBucket: "tinkeraidev.firebasestorage.app",
  messagingSenderId: "623400104358",
  appId: "1:623400104358:web:ef8a108adfdaed314f5f67",
});
const auth = getAuth(app);
const db = getFirestore(app);
const chatsOf = (uid) => collection(db, "users", uid, "chats");

// A small API for app.js (a normal script) to use.
window.tinkerCloud = {
  signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signInWithEmail: (email, password) => signInWithEmailAndPassword(auth, email, password),
  async signUpWithEmail(name, email, password) {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(user, { displayName: name });
    return user;
  },
  resetPassword: (email) => sendPasswordResetEmail(auth, email),
  currentUser: () => auth.currentUser,
  signOut: () => signOut(auth),
  onUserChange: (callback) => onAuthStateChanged(auth, callback),
  idToken: () => auth.currentUser?.getIdToken() ?? null,

  async listChats() {
    const snapshot = await getDocs(chatsOf(auth.currentUser.uid));
    return snapshot.docs.map((d) => d.data());
  },
  saveChat: (chat) => setDoc(doc(chatsOf(auth.currentUser.uid), chat.id), JSON.parse(JSON.stringify(chat))),
  deleteChat: (id) => deleteDoc(doc(chatsOf(auth.currentUser.uid), id)),

  // ---------- Settings ----------
  updateName: (name) => updateProfile(auth.currentUser, { displayName: name }),
  usesPassword: () => auth.currentUser?.providerData.some((p) => p.providerId === "password") ?? false,

  // Firebase asks for a fresh sign-in before deleting an account (a safety rule).
  async confirmIdentity(password) {
    const user = auth.currentUser;
    if (user.providerData.some((p) => p.providerId === "google.com")) return reauthenticateWithPopup(user, new GoogleAuthProvider());
    return reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  },

  // Deletes every saved chat, then the account itself.
  async deleteAccount() {
    const user = auth.currentUser;
    const snapshot = await getDocs(chatsOf(user.uid));
    await Promise.all(snapshot.docs.map((d) => deleteDoc(d.ref)));
    await deleteUser(user);
  },
};
window.dispatchEvent(new Event("tinker-cloud-ready"));
