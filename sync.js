// Sincronização com Firebase (login Google + Firestore) e grupos.
//
// Sem login, o app funciona só com localStorage, como sempre.
// Com login:
//   users/{uid}/sessions/{id}   — treinos completos (privados)
//   users/{uid}/meta/tecnicas   — técnicas personalizadas
//   users/{uid}/meta/perfil     — { groupId } grupo atual (ignoredRolls é legado, migrado pra members.refused)
//   groups/{gid}                — { name, code, createdBy, members: { uid: {name, photo, refused: [chave]} } }
//                                 refused = rolas registradas por outros comigo que eu não confirmei
//   groups/{gid}/sessions/{id}  — cópia PÚBLICA do treino (sem as notas), visível pro grupo
//   codes/{code}                — { groupId } pra entrar pelo código
//
// Este arquivo é um módulo ES (carrega depois do app.js) e conversa com ele por
// window.jjApp (o app expõe) e window.jjSync / window.jjGroup (este arquivo expõe).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, arrayUnion, onSnapshot, writeBatch,
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
let currentUser = null;
const unsubs = { sessions: null, meta: null, perfil: null, group: null, groupSessions: null };
let groupId = null;

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

// ===== Documentos =====
// Treino completo, sem o campo `synced` (controle local) e sem undefined
function toDoc(session) {
  const { synced, ...rest } = session;
  return JSON.parse(JSON.stringify(rest));
}

// Versão pública do treino pro grupo: sem Funcionou / Travei em / Pra estudar
function toGroupDoc(session) {
  return JSON.parse(JSON.stringify({
    id: session.id,
    uid: currentUser.uid,
    date: session.date,
    type: session.type,
    duration: session.duration,
    techniques: session.techniques,
    rolls: session.rolls.map((r) => ({
      rid: r.rid || null,
      partner: r.partner,
      partnerUid: r.partnerUid || null,
      mirrorOf: r.mirrorOf || null,
      wins: r.wins,
      losses: r.losses,
    })),
  }));
}

function memberInfo(user) {
  return { name: user.displayName || user.email, photo: user.photoURL || '' };
}

// ===== Sincronização dos treinos =====
function startSync(user) {
  const sessionsRef = collection(db, 'users', user.uid, 'sessions');
  const metaRef = doc(db, 'users', user.uid, 'meta', 'tecnicas');
  const perfilRef = doc(db, 'users', user.uid, 'meta', 'perfil');

  // O que o app chama quando algo muda localmente.
  // A promessa do setDoc só resolve quando o servidor confirma — aí sim marcamos
  // como sincronizado. Até lá o treino continua "só local" e nunca é descartado.
  window.jjSync = {
    upsert: (session) => {
      publishToGroup(session);
      return setDoc(doc(sessionsRef, String(session.id)), toDoc(session))
        .then(() => window.jjApp.markSynced(session.id))
        .catch(onWriteError);
    },
    remove: (id) => {
      unpublishFromGroup(id);
      return deleteDoc(doc(sessionsRef, String(id))).catch(onWriteError);
    },
    setCustom: (list) => setDoc(metaRef, { list }).catch(onWriteError),
    // Recusa fica na minha entrada de membro do grupo (pública pro grupo, sem regra nova)
    refuseRoll: (key) => {
      // Só grava se eu sou membro (entrada com nome): nunca cria entrada nova por aqui
      if (!groupId || !groupData?.members?.[user.uid]?.name) return Promise.resolve();
      return updateDoc(doc(db, 'groups', groupId), { [`members.${user.uid}.refused`]: arrayUnion(key) }).catch(onWriteError);
    },
  };

  let first = true;
  unsubs.sessions = onSnapshot(sessionsRef, { includeMetadataChanges: true }, (snap) => {
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

  unsubs.meta = onSnapshot(metaRef, (snap) => {
    const remote = snap.exists() ? snap.data().list || [] : [];
    const local = window.jjApp.getCustom();
    const union = [...new Set([...remote, ...local])];
    window.jjApp.replaceCustom(union);
    if (union.length !== remote.length) window.jjSync.setCustom(union);
  }, (err) => console.error('[sync] técnicas:', err));

  // Perfil diz em qual grupo a pessoa está (sincroniza entre aparelhos)
  unsubs.perfil = onSnapshot(perfilRef, (snap) => {
    const data = snap.exists() ? snap.data() : {};
    window.jjApp.setIgnored(data.ignoredRolls || []);
    const gid = data.groupId || null;
    if (gid !== groupId) watchGroup(gid);
  }, (err) => console.error('[sync] perfil:', err));
}

// ===== Grupos =====
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I
function newCode() {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
}

let groupData = null; // { id, name, code, members }

function publishToGroup(session) {
  if (!groupId) return;
  setDoc(doc(db, 'groups', groupId, 'sessions', String(session.id)), toGroupDoc(session)).catch(onWriteError);
}

function unpublishFromGroup(id) {
  if (!groupId) return;
  deleteDoc(doc(db, 'groups', groupId, 'sessions', String(id))).catch(onWriteError);
}

// Ao entrar num grupo, publica todo o histórico (em lotes de até 400)
async function publishAll(gid) {
  const sessions = window.jjApp.getSessions();
  for (let i = 0; i < sessions.length; i += 400) {
    const batch = writeBatch(db);
    for (const s of sessions.slice(i, i + 400)) {
      batch.set(doc(db, 'groups', gid, 'sessions', String(s.id)), toGroupDoc(s));
    }
    await batch.commit();
  }
}

async function unpublishAll(gid) {
  const sessions = window.jjApp.getSessions();
  for (let i = 0; i < sessions.length; i += 400) {
    const batch = writeBatch(db);
    for (const s of sessions.slice(i, i + 400)) {
      batch.delete(doc(db, 'groups', gid, 'sessions', String(s.id)));
    }
    await batch.commit();
  }
}

function watchGroup(gid) {
  unsubs.group?.();
  unsubs.groupSessions?.();
  unsubs.group = unsubs.groupSessions = null;
  groupId = gid;
  groupData = null;

  if (!gid) {
    window.jjApp.setGroup(null);
    return;
  }

  let sessions = [];
  const emit = () => {
    if (groupData) window.jjApp.setGroup({ ...groupData, sessions });
  };

  unsubs.group = onSnapshot(doc(db, 'groups', gid), (snap) => {
    if (!snap.exists()) { groupData = null; window.jjApp.setGroup(null); return; }
    groupData = { id: gid, ...snap.data() };
    emit();
  }, (err) => console.error('[grupo] grupo:', err));

  unsubs.groupSessions = onSnapshot(collection(db, 'groups', gid, 'sessions'), (snap) => {
    sessions = snap.docs.map((d) => d.data());
    emit();
  }, (err) => console.error('[grupo] sessões:', err));
}

window.jjGroup = {
  async create(name) {
    const gid = doc(collection(db, 'groups')).id;
    const code = newCode();
    await setDoc(doc(db, 'groups', gid), {
      name,
      code,
      createdBy: currentUser.uid,
      createdAt: Date.now(),
      members: { [currentUser.uid]: memberInfo(currentUser) },
    });
    await setDoc(doc(db, 'codes', code), { groupId: gid });
    await publishAll(gid);
    await setDoc(doc(db, 'users', currentUser.uid, 'meta', 'perfil'), { groupId: gid }, { merge: true });
  },

  async join(code) {
    const snap = await getDoc(doc(db, 'codes', code.trim().toUpperCase()));
    if (!snap.exists()) throw new Error('Código não encontrado');
    const gid = snap.data().groupId;
    await updateDoc(doc(db, 'groups', gid), { [`members.${currentUser.uid}`]: memberInfo(currentUser) });
    await publishAll(gid);
    await setDoc(doc(db, 'users', currentUser.uid, 'meta', 'perfil'), { groupId: gid }, { merge: true });
  },

  async leave() {
    if (!groupId) return;
    const gid = groupId;
    // Primeiro desliga o app do grupo (perfil → null), depois limpa no servidor.
    // Assim nenhuma reação a "membros mudaram" roda enquanto eu estou saindo.
    await setDoc(doc(db, 'users', currentUser.uid, 'meta', 'perfil'), { groupId: null }, { merge: true });
    await unpublishAll(gid);
    await updateDoc(doc(db, 'groups', gid), { [`members.${currentUser.uid}`]: deleteField() });
  },
};

// ===== Ciclo de vida =====
function stopSync() {
  for (const k of Object.keys(unsubs)) { unsubs[k]?.(); unsubs[k] = null; }
  groupId = null;
  groupData = null;
  window.jjSync = null;
  window.jjApp.setGroup(null);
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  renderAuth(user);
  window.jjApp.setUser(user ? { uid: user.uid, ...memberInfo(user) } : null);
  stopSync();
  if (user) startSync(user);
});
