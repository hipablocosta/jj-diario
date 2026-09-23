// Sincronização com Firebase (login Google + Firestore).
//
// Sem login, o app funciona só com localStorage, como sempre.
// Com login, cada treino vira um documento em users/{uid}/sessions/{id} e as
// técnicas personalizadas ficam em users/{uid}/meta/tecnicas. O Firestore guarda
// uma cópia local (funciona offline) e avisa em tempo real quando outro
// dispositivo muda algo.
//
// Este arquivo é um módulo ES (carrega depois do app.js) e conversa com ele por
// window.jjApp (o app expõe) e window.jjSync (este arquivo expõe quando logado).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js';

// Não é segredo: é o "endereço" do projeto. O que protege os dados são as regras do Firestore.
const firebaseConfig = {
  apiKey: 'AIzaSyBYDvkF2meiiCP82z-JMwrXcBUJ4niFI5s',
  authDomain: 'jj-diario.firebaseapp.com',
  projectId: 'jj-diario',
  storageBucket: 'jj-diario.firebasestorage.app',
  messagingSenderId: '910721803468',
  appId: '1:910721803468:web:7dee8a7714bd13eff18e69',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const authEl = document.querySelector('#auth');
let unsubscribeSessions = null;
let unsubscribeMeta = null;

// ===== UI de login =====
function renderAuth(user) {
  if (!user) {
    authEl.innerHTML = `<button type="button" id="btn-login" class="btn-login">Entrar com Google</button>`;
    authEl.querySelector('#btn-login').addEventListener('click', login);
    return;
  }
  authEl.innerHTML = `
    <img class="avatar" src="${user.photoURL || ''}" alt="" referrerpolicy="no-referrer">
    <span class="auth-name">${user.displayName || user.email}</span>
    <span id="sync-status" class="sync-status" title="Sincronizado"></span>
    <button type="button" id="btn-logout" class="btn-logout">Sair</button>
  `;
  authEl.querySelector('#btn-logout').addEventListener('click', () => signOut(auth));
}

async function login() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Alguns navegadores (principalmente no celular) bloqueiam popup: cai pro redirect
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
      await signInWithRedirect(auth, provider);
    } else {
      alert('Não consegui entrar: ' + err.message);
    }
  }
}

// estado: 'ok' | 'pending' | 'error'
function setStatus(state, detail = '') {
  const el = document.querySelector('#sync-status');
  if (!el) return;
  el.className = `sync-status ${state}`;
  el.title = { ok: 'Sincronizado', pending: 'Aguardando conexão pra sincronizar', error: `Erro ao sincronizar: ${detail}` }[state];
}

function onWriteError(err) {
  console.error('[sync] gravar:', err);
  setStatus('error', err.message);
  if (err.code === 'permission-denied') {
    alert('O Firestore recusou a gravação (permission-denied). Confere se as regras foram publicadas.');
  }
}

// ===== Firestore =====
// Documento = sessão sem o campo `synced` (que é controle local) e sem undefined
function toDoc(session) {
  const { synced, ...rest } = session;
  return JSON.parse(JSON.stringify(rest));
}

function startSync(user) {
  const sessionsRef = collection(db, 'users', user.uid, 'sessions');
  const metaRef = doc(db, 'users', user.uid, 'meta', 'tecnicas');

  // O que o app chama quando algo muda localmente.
  // A promessa do setDoc só resolve quando o servidor confirma — aí sim marcamos
  // como sincronizado. Até lá o treino continua "só local" e nunca é descartado.
  window.jjSync = {
    upsert: (session) => setDoc(doc(sessionsRef, String(session.id)), toDoc(session))
      .then(() => window.jjApp.markSynced(session.id))
      .catch(onWriteError),
    remove: (id) => deleteDoc(doc(sessionsRef, String(id))).catch(onWriteError),
    setCustom: (list) => setDoc(metaRef, { list }).catch(onWriteError),
  };

  let first = true;
  unsubscribeSessions = onSnapshot(sessionsRef, { includeMetadataChanges: true }, (snap) => {
    const remote = snap.docs.map((d) => ({ ...d.data(), synced: true }));

    if (first) {
      first = false;
      // Primeira sincronização neste dispositivo: sobe o que só existe aqui
      const remoteIds = new Set(remote.map((s) => s.id));
      const locais = window.jjApp.getSessions().filter((s) => !s.synced && !remoteIds.has(s.id));
      console.log(`[sync] ${remote.length} no servidor, ${locais.length} só neste aparelho`);
      for (const s of locais) window.jjSync.upsert(s);
    }
    // replaceSessions preserva o que ainda não foi confirmado pelo servidor
    window.jjApp.replaceSessions(remote);
    setStatus(snap.metadata.hasPendingWrites ? 'pending' : 'ok');
  }, (err) => {
    console.error('[sync] sessões:', err);
    setStatus('error', err.message);
  });

  unsubscribeMeta = onSnapshot(metaRef, (snap) => {
    const remote = snap.exists() ? snap.data().list || [] : [];
    const local = window.jjApp.getCustom();
    const union = [...new Set([...remote, ...local])];
    window.jjApp.replaceCustom(union);
    if (union.length !== remote.length) window.jjSync.setCustom(union);
  }, (err) => console.error('[sync] técnicas:', err));
}

function stopSync() {
  unsubscribeSessions?.();
  unsubscribeMeta?.();
  unsubscribeSessions = unsubscribeMeta = null;
  window.jjSync = null;
}

onAuthStateChanged(auth, (user) => {
  renderAuth(user);
  stopSync();
  if (user) startSync(user);
});
