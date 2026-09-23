// ===== Persistência =====
// Cada sessão: { id, date, type, duration, techniques: [], rolls: [],
//                worked, stuck, study, studyDone }
//   worked/stuck/study = "funcionou" / "travei em" / "pra estudar" (texto livre)
//   studyDone = true quando a pendência de estudo foi marcada como resolvida
//   (sessões antigas podem ter só `notes`, que continua sendo exibido)
// Cada rola:   { partner, wins: ["Armlock", ...], losses: ["Mata-leão", ...] }
//   wins   = finalizações que eu apliquei (uma entrada por finalização, pode repetir)
//   losses = finalizações que eu sofri
const STORAGE_KEY = 'jj-diario';
const SEM_TECNICA = 'Não registrada'; // usado ao migrar rolas antigas que só tinham o resultado

function loadSessions() {
  let list;
  try {
    list = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
  // Migração: formato antigo tinha rolls[].result ('win' | 'loss' | 'draw')
  let migrated = false;
  for (const s of list) {
    for (const r of s.rolls) {
      if ('result' in r) {
        r.wins = r.result === 'win' ? [SEM_TECNICA] : [];
        r.losses = r.result === 'loss' ? [SEM_TECNICA] : [];
        delete r.result;
        migrated = true;
      }
    }
  }
  if (migrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return list;
}

function saveSessions(sessions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

let sessions = loadSessions();

// ===== Helpers =====
const $ = (sel) => document.querySelector(sel);

// Data local em "YYYY-MM-DD" (toISOString usaria UTC e podia virar o dia errado)
function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Agrupa ignorando maiúsculas ("João" e "joão" contam junto), mas exibe como foi escrito da 1ª vez.
// Retorna [[nome, contagem], ...] ordenado do maior pro menor.
function countBy(list) {
  const counts = {};
  for (const item of list) {
    const key = normalize(item);
    counts[key] ??= { label: item, n: 0 };
    counts[key].n++;
  }
  return Object.values(counts)
    .sort((a, b) => b.n - a.n)
    .map(({ label, n }) => [label, n]);
}

// "Armlock, Armlock, Triângulo" -> "Armlock ×2, Triângulo"
function summarize(list) {
  return countBy(list).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

// ===== Abas =====
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'historico') renderHistorico();
    if (btn.dataset.tab === 'stats') renderStats();
    if (btn.dataset.tab === 'grupo') renderGrupo();
  });
});

// ===== Usuário logado e grupo (alimentados pelo sync.js) =====
let currentUser = null; // { uid, name, photo } ou null
let group = null;       // { id, name, code, members: {uid: {name, photo}}, sessions: [] } ou null

// Membros do grupo, menos eu
function otherMembers() {
  if (!group) return [];
  return Object.entries(group.members)
    .filter(([uid]) => uid !== currentUser?.uid)
    .map(([uid, m]) => ({ uid, ...m }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ===== Catálogo de técnicas =====
const CUSTOM_KEY = 'jj-tecnicas-custom';
const MINHAS = 'Minhas';
const FINALIZACOES = 'Finalizações';

let customTechniques = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');

// Catálogo completo: o fixo (catalogo.js) + "Minhas" (customizadas + o que já foi
// registrado em texto livre e não está no catálogo)
function fullCatalog() {
  const known = new Set(Object.values(CATALOGO).flat().map(normalize));
  const minhas = [...customTechniques];
  const usadas = sessions.flatMap((s) => [
    ...s.techniques,
    ...s.rolls.flatMap((r) => [...r.wins, ...r.losses]),
  ]);
  for (const t of usadas) {
    if (t === SEM_TECNICA) continue;
    if (!known.has(normalize(t)) && !minhas.some((m) => normalize(m) === normalize(t))) {
      minhas.push(t);
    }
  }
  const cat = { ...CATALOGO };
  if (minhas.length) cat[MINHAS] = minhas.sort((a, b) => a.localeCompare(b));
  return cat;
}

function chipList(list, extraAttrs = '') {
  return list
    .map((t, i) => `<span class="chip">${t}<button type="button" class="chip-remove" data-index="${i}" ${extraAttrs} aria-label="Remover">×</button></span>`)
    .join('');
}

// ===== Painel de seleção (bottom sheet) =====
// O painel é genérico: quem abre passa um "alvo" dizendo quais categorias mostrar,
// como saber quantas vezes um item já foi escolhido e o que fazer ao tocar.
const picker = $('#picker');
const pickerBusca = $('#picker-busca');
const pickerCats = $('#picker-categorias');
const pickerLista = $('#picker-lista');
let pickerTarget = null;
let activeCategory = null;

function pickerCatalog() {
  const all = fullCatalog();
  if (!pickerTarget.categories) return all;
  const filtered = {};
  for (const c of pickerTarget.categories) if (all[c]) filtered[c] = all[c];
  return filtered;
}

function openPicker(target) {
  pickerTarget = target;
  const cats = Object.keys(pickerCatalog());
  if (!cats.includes(activeCategory)) activeCategory = cats[0];
  pickerBusca.value = '';
  renderPickerCategories();
  renderPickerList();
  picker.showModal();
}

function renderPickerCategories() {
  pickerCats.innerHTML = Object.keys(pickerCatalog())
    .map((c) => `<button type="button" class="cat-tab ${c === activeCategory ? 'active' : ''}" data-cat="${c}">${c}</button>`)
    .join('');
}

function renderPickerList() {
  const catalog = pickerCatalog();
  const q = normalize(pickerBusca.value.trim());
  const chip = (name) => {
    const n = pickerTarget.count(name);
    return `<button type="button" class="opcao ${n ? 'selected' : ''}" data-name="${name}">${name}${n > 1 ? ` ×${n}` : ''}</button>`;
  };

  let html = '';
  if (q) {
    // Busca em todas as categorias permitidas, agrupada
    let exact = false;
    for (const [cat, items] of Object.entries(catalog)) {
      const hits = items.filter((t) => normalize(t).includes(q));
      if (!hits.length) continue;
      if (hits.some((t) => normalize(t) === q)) exact = true;
      html += `<div class="opcao-grupo">${cat}</div>` + hits.map(chip).join('');
    }
    if (!exact) {
      html += `<button type="button" class="opcao nova" data-new="${pickerBusca.value.trim()}">+ Adicionar "${pickerBusca.value.trim()}"</button>`;
    }
  } else {
    html = (catalog[activeCategory] || []).map(chip).join('');
  }
  pickerLista.innerHTML = html;
}

pickerCats.addEventListener('click', (e) => {
  const tab = e.target.closest('.cat-tab');
  if (!tab) return;
  activeCategory = tab.dataset.cat;
  pickerBusca.value = '';
  renderPickerCategories();
  renderPickerList();
});

pickerLista.addEventListener('click', (e) => {
  const btn = e.target.closest('.opcao');
  if (!btn) return;
  if (btn.dataset.new) {
    const name = btn.dataset.new;
    customTechniques.push(name);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customTechniques));
    window.jjSync?.setCustom(customTechniques);
    pickerTarget.pick(name);
    pickerBusca.value = '';
    activeCategory = MINHAS;
    renderPickerCategories();
    renderPickerList();
    return;
  }
  pickerTarget.pick(btn.dataset.name);
  renderPickerList();
});

pickerBusca.addEventListener('input', renderPickerList);
$('#picker-fechar').addEventListener('click', () => picker.close());
$('#picker-pronto').addEventListener('click', () => picker.close());
// Toca fora do painel fecha
picker.addEventListener('click', (e) => { if (e.target === picker) picker.close(); });

// ===== Formulário: técnicas treinadas =====
let selectedTechniques = [];

function renderSelectedTechniques() {
  $('#tecnicas-selecionadas').innerHTML = chipList(selectedTechniques);
}

$('#tecnicas-selecionadas').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-remove');
  if (!btn) return;
  selectedTechniques.splice(Number(btn.dataset.index), 1);
  renderSelectedTechniques();
});

$('#btn-add-tecnica').addEventListener('click', () => {
  openPicker({
    categories: null, // todas
    count: (name) => (selectedTechniques.some((t) => normalize(t) === normalize(name)) ? 1 : 0),
    // Técnica treinada é liga/desliga: tocar de novo remove
    pick: (name) => {
      const i = selectedTechniques.findIndex((t) => normalize(t) === normalize(name));
      if (i >= 0) selectedTechniques.splice(i, 1);
      else selectedTechniques.push(name);
      renderSelectedTechniques();
    },
  });
});

// ===== Formulário: rolas =====
let rolls = [];
const rollsList = $('#rolls-list');

function renderMemberChips(r) {
  const membros = otherMembers();
  if (!membros.length) return '';
  return `<div class="member-chips">${membros.map((m) => `
    <button type="button" class="member-chip ${r.partnerUid === m.uid ? 'selected' : ''}" data-action="member" data-uid="${m.uid}" data-name="${m.name}">
      <img src="${m.photo}" alt="" referrerpolicy="no-referrer">${m.name.split(' ')[0]}
    </button>`).join('')}</div>`;
}

function renderRolls() {
  rollsList.innerHTML = rolls.map((r, i) => `
    <div class="roll" data-index="${i}">
      <div class="roll-head">
        <input type="text" class="roll-partner" placeholder="Parceiro" value="${r.partner}" autocomplete="off">
        <button type="button" class="btn-remove" data-action="remove" aria-label="Remover rola">×</button>
      </div>
      ${renderMemberChips(r)}
      <div class="roll-subs">
        <span class="roll-label win">Finalizei</span>
        <div class="chips">${chipList(r.wins, 'data-list="wins"')}</div>
        <button type="button" class="btn-mini" data-action="add" data-list="wins">+</button>
      </div>
      <div class="roll-subs">
        <span class="roll-label loss">Fui finalizado</span>
        <div class="chips">${chipList(r.losses, 'data-list="losses"')}</div>
        <button type="button" class="btn-mini" data-action="add" data-list="losses">+</button>
      </div>
    </div>
  `).join('');
}

$('#btn-add-roll').addEventListener('click', () => {
  rolls.push({ partner: '', partnerUid: null, wins: [], losses: [] });
  renderRolls();
  // Com membros no grupo, o mais comum é tocar num deles; sem grupo, já abre o teclado
  if (!otherMembers().length) rollsList.querySelector('.roll:last-child .roll-partner').focus();
});

// Parceiro: atualiza o estado sem re-renderizar (senão perde o foco enquanto digita).
// Digitar um nome diferente desfaz a ligação com o membro do grupo.
rollsList.addEventListener('input', (e) => {
  if (!e.target.classList.contains('roll-partner')) return;
  const i = Number(e.target.closest('.roll').dataset.index);
  rolls[i].partner = e.target.value;
  if (rolls[i].partnerUid && group?.members[rolls[i].partnerUid]?.name !== e.target.value) {
    rolls[i].partnerUid = null;
    e.target.closest('.roll').querySelector('.member-chip.selected')?.classList.remove('selected');
  }
});

rollsList.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const i = Number(btn.closest('.roll').dataset.index);
  const roll = rolls[i];

  if (btn.dataset.action === 'remove') {
    rolls.splice(i, 1);
    renderRolls();
  } else if (btn.dataset.action === 'member') {
    // Toca de novo no mesmo membro desfaz a ligação
    if (roll.partnerUid === btn.dataset.uid) {
      roll.partnerUid = null;
      roll.partner = '';
    } else {
      roll.partnerUid = btn.dataset.uid;
      roll.partner = btn.dataset.name;
    }
    renderRolls();
  } else if (btn.classList.contains('chip-remove')) {
    roll[btn.dataset.list].splice(Number(btn.dataset.index), 1);
    renderRolls();
  } else if (btn.dataset.action === 'add') {
    const list = roll[btn.dataset.list];
    openPicker({
      categories: [FINALIZACOES, MINHAS],
      count: (name) => list.filter((t) => normalize(t) === normalize(name)).length,
      // Cada toque adiciona uma finalização (pode repetir: "armlock ×2")
      pick: (name) => {
        list.push(name);
        renderRolls();
      },
    });
  }
});

// ===== Formulário: salvar / editar =====
const form = $('#form-sessao');
let editingId = null; // id do treino sendo editado, ou null se é treino novo

function resetForm() {
  form.reset();
  form.date.value = todayISO();
  rolls = [];
  renderRolls();
  selectedTechniques = [];
  renderSelectedTechniques();
  editingId = null;
  $('#btn-salvar').textContent = 'Salvar treino';
  $('#btn-cancelar').hidden = true;
}

// Carrega um treino existente no formulário (cópias, pra cancelar não afetar o original)
function loadIntoForm(s) {
  form.date.value = s.date;
  form.duration.value = s.duration;
  form.type.value = s.type;
  form.worked.value = s.worked || '';
  form.stuck.value = s.stuck || '';
  form.study.value = s.study || '';
  selectedTechniques = [...s.techniques];
  renderSelectedTechniques();
  rolls = s.rolls.map((r) => ({ partner: r.partner, partnerUid: r.partnerUid || null, wins: [...r.wins], losses: [...r.losses] }));
  renderRolls();
  editingId = s.id;
  $('#btn-salvar').textContent = 'Salvar alterações';
  $('#btn-cancelar').hidden = false;
  document.querySelector('[data-tab="novo"]').click();
  window.scrollTo(0, 0);
}

resetForm();

$('#btn-cancelar').addEventListener('click', () => {
  resetForm();
  document.querySelector('[data-tab="historico"]').click();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const campos = {
    date: data.get('date'),
    type: data.get('type'),
    duration: Number(data.get('duration')) || 0,
    techniques: [...selectedTechniques],
    rolls: rolls
      .map((r) => ({ ...r, partner: r.partner.trim() }))
      .filter((r) => r.partner || r.wins.length || r.losses.length),
    worked: data.get('worked').trim(),
    stuck: data.get('stuck').trim(),
    study: data.get('study').trim(),
  };

  let session;
  if (editingId) {
    session = sessions.find((s) => s.id === editingId);
    // Se o "pra estudar" mudou, a pendência volta a ficar em aberto
    const studyMudou = campos.study !== (session.study || '');
    Object.assign(session, campos);
    if (studyMudou) session.studyDone = false;
  } else {
    session = { id: Date.now(), ...campos, studyDone: false };
    sessions.push(session);
  }
  saveSessions(sessions);
  window.jjSync?.upsert(session);

  resetForm();
  // Vai pro histórico pra mostrar o que acabou de salvar
  document.querySelector('[data-tab="historico"]').click();
});

// ===== Histórico =====
const busca = $('#busca');
busca.addEventListener('input', renderHistorico);

function matchesSearch(s, q) {
  if (!q) return true;
  const haystack = [
    s.notes, s.worked, s.stuck, s.study,
    ...s.techniques,
    ...s.rolls.flatMap((r) => [r.partner, ...r.wins, ...r.losses]),
  ].join(' ');
  return normalize(haystack).includes(q);
}

function renderRoll(r) {
  const partes = [];
  if (r.wins.length) partes.push(`<span class="r-win">${summarize(r.wins)}</span>`);
  if (r.losses.length) partes.push(`<span class="r-loss">${summarize(r.losses)}</span>`);
  if (!partes.length) partes.push('<span class="r-draw">empate</span>');
  return `<li><strong>${r.partner || 'Sem nome'}</strong> · ${partes.join(' · ')}</li>`;
}

function renderNotas(s) {
  const linhas = [
    ['Funcionou', s.worked, 'win'],
    ['Travei em', s.stuck, 'loss'],
    ['Pra estudar', s.study, s.studyDone ? 'done' : 'study'],
    ['Obs', s.notes, ''], // formato antigo
  ].filter(([, texto]) => texto);
  if (!linhas.length) return '';
  return `<dl class="notas">${linhas
    .map(([rotulo, texto, cls]) => `<dt class="${cls}">${rotulo}</dt><dd>${texto}</dd>`)
    .join('')}</dl>`;
}

function renderHistorico() {
  const q = normalize(busca.value.trim());
  const lista = $('#lista-sessoes');
  const filtradas = [...sessions]
    .filter((s) => matchesSearch(s, q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  if (filtradas.length === 0) {
    lista.innerHTML = `<p class="vazio">${q ? 'Nada encontrado.' : 'Nenhum treino ainda. Bora pro tatame!'}</p>`;
    return;
  }

  lista.innerHTML = filtradas.map((s) => `
    <article class="sessao" data-id="${s.id}">
      <div class="sessao-head">
        <strong>${formatDate(s.date)}</strong>
        <span class="badge ${s.type}">${s.type === 'gi' ? 'Gi' : 'No-Gi'} · ${s.duration}min</span>
      </div>
      ${s.techniques.length ? `<div class="chips">${s.techniques.map((t) => `<span class="chip">${t}</span>`).join('')}</div>` : ''}
      ${s.rolls.length ? `<ul class="sessao-rolas">${s.rolls.map(renderRoll).join('')}</ul>` : ''}
      ${renderNotas(s)}
      <div class="sessao-actions">
        <button type="button" class="btn-edit">Editar</button>
        <button type="button" class="btn-delete">Excluir</button>
      </div>
    </article>
  `).join('');
}

$('#lista-sessoes').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = Number(btn.closest('.sessao').dataset.id);

  if (btn.classList.contains('btn-edit')) {
    const s = sessions.find((x) => x.id === id);
    if (s) loadIntoForm(s);
  } else if (btn.classList.contains('btn-delete')) {
    if (!confirm('Excluir este treino?')) return;
    sessions = sessions.filter((s) => s.id !== id);
    saveSessions(sessions);
    window.jjSync?.remove(id);
    renderHistorico();
  }
});

// ===== Stats: pendências de estudo =====
function renderEstudar() {
  const el = $('#lista-estudar');
  const pendentes = sessions
    .filter((s) => s.study && !s.studyDone)
    .sort((a, b) => b.date.localeCompare(a.date));

  el.innerHTML = pendentes.length
    ? pendentes.map((s) => `
        <li>
          <label>
            <input type="checkbox" data-id="${s.id}">
            <span>${s.study}</span>
            <small>${formatDate(s.date)}</small>
          </label>
        </li>`).join('')
    : '<li class="vazio-inline">Nada pendente. Bora estudar algo novo?</li>';
}

$('#lista-estudar').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  const s = sessions.find((x) => x.id === Number(e.target.dataset.id));
  if (!s) return;
  s.studyDone = true;
  saveSessions(sessions);
  window.jjSync?.upsert(s);
  // Pequeno atraso pra dar tempo de ver o check antes de sumir da lista
  setTimeout(renderEstudar, 250);
});

// ===== Stats =====
function renderStats() {
  renderEstudar();
  const mesAtual = todayISO().slice(0, 7); // "2026-09"

  const total = sessions.length;
  const esteMes = sessions.filter((s) => s.date.startsWith(mesAtual)).length;
  const horas = sessions.reduce((acc, s) => acc + s.duration, 0) / 60;
  const rolls = sessions.flatMap((s) => s.rolls);
  const wins = rolls.flatMap((r) => r.wins);
  const losses = rolls.flatMap((r) => r.losses);
  const empates = rolls.filter((r) => !r.wins.length && !r.losses.length).length;

  $('#st-total').textContent = total;
  $('#st-mes').textContent = esteMes;
  $('#st-horas').textContent = horas.toFixed(1);
  $('#st-rolas').textContent = rolls.length;

  const n = { win: wins.length, loss: losses.length, draw: empates };
  const max = Math.max(1, n.win, n.loss, n.draw);
  for (const k of ['win', 'loss', 'draw']) {
    $(`#n-${k}`).textContent = n[k];
    $(`#bar-${k}`).style.width = `${(n[k] / max) * 100}%`;
  }

  const renderRanking = (el, entries) => {
    el.innerHTML = entries.length
      ? entries.slice(0, 8).map(([name, c]) => `<li>${name} <span>· ${c}×</span></li>`).join('')
      : '<li><span>—</span></li>';
  };
  const semPlaceholder = (list) => list.filter((t) => t !== SEM_TECNICA);
  renderRanking($('#top-wins'), countBy(semPlaceholder(wins)));
  renderRanking($('#top-losses'), countBy(semPlaceholder(losses)));
  renderRanking($('#top-tecnicas'), countBy(sessions.flatMap((s) => s.techniques)));
  renderRanking($('#top-parceiros'), countBy(rolls.map((r) => r.partner).filter(Boolean)));
}

// ===== Ponte com o sync.js =====
// O sync.js chama isto quando chegam dados do Firestore (deste ou de outro dispositivo)
function rerender() {
  const ativa = document.querySelector('.tab.active').dataset.tab;
  if (ativa === 'historico') renderHistorico();
  if (ativa === 'stats') renderStats();
}

window.jjApp = {
  getSessions: () => sessions,
  // Recebe a lista do servidor. Treinos locais que o servidor ainda não confirmou
  // (sem `synced`) são mantidos — senão uma falha de gravação apagaria dados.
  replaceSessions(remote) {
    const remoteIds = new Set(remote.map((s) => s.id));
    const pendentes = sessions.filter((s) => !s.synced && !remoteIds.has(s.id));
    sessions = [...remote, ...pendentes];
    saveSessions(sessions);
    rerender();
  },
  markSynced(id) {
    const s = sessions.find((x) => x.id === id);
    if (s) { s.synced = true; saveSessions(sessions); }
  },
  getCustom: () => customTechniques,
  replaceCustom(list) {
    customTechniques = list;
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customTechniques));
  },
  setUser(user) {
    currentUser = user;
    if (document.querySelector('.tab.active').dataset.tab === 'grupo') renderGrupo();
  },
  setGroup(data) {
    group = data;
    renderRolls(); // chips de membros nas rolas
    if (document.querySelector('.tab.active').dataset.tab === 'grupo') renderGrupo();
  },
};

// ===== Grupo =====
const grupoEl = $('#grupo-conteudo');

function renderGrupo() {
  if (!currentUser) {
    grupoEl.innerHTML = `<p class="vazio">Entra com o Google (botão no topo) pra criar ou entrar num grupo.</p>`;
    return;
  }
  if (!group) {
    grupoEl.innerHTML = `
      <div class="grupo-card">
        <h3>Criar um grupo</h3>
        <small>Você recebe um código pra mandar pros amigos.</small>
        <form class="grupo-form" id="form-criar-grupo">
          <input type="text" name="name" placeholder="Nome (ex: Academia X)" required maxlength="40" autocomplete="off">
          <button type="submit" class="btn-primary">Criar</button>
        </form>
      </div>
      <p class="ou">ou</p>
      <div class="grupo-card">
        <h3>Entrar num grupo</h3>
        <small>Pede o código pra quem criou.</small>
        <form class="grupo-form" id="form-entrar-grupo">
          <input type="text" name="code" class="code" placeholder="CÓDIGO" required maxlength="6" autocomplete="off" autocapitalize="characters">
          <button type="submit" class="btn-primary">Entrar</button>
        </form>
      </div>`;
    $('#form-criar-grupo').addEventListener('submit', (e) => {
      e.preventDefault();
      acaoGrupo(e.target, () => window.jjGroup.create(e.target.name.value.trim()));
    });
    $('#form-entrar-grupo').addEventListener('submit', (e) => {
      e.preventDefault();
      acaoGrupo(e.target, () => window.jjGroup.join(e.target.code.value));
    });
    return;
  }

  const me = currentUser.uid;
  const mesAtual = todayISO().slice(0, 7);
  const membros = Object.entries(group.members).map(([uid, m]) => ({ uid, ...m }));

  // Ranking do mês: treinos e minutos por membro
  const ranking = membros.map((m) => {
    const doMes = group.sessions.filter((s) => s.uid === m.uid && s.date.startsWith(mesAtual));
    return { ...m, treinos: doMes.length, minutos: doMes.reduce((acc, s) => acc + (s.duration || 0), 0) };
  }).sort((a, b) => b.treinos - a.treinos || b.minutos - a.minutos || a.name.localeCompare(b.name));

  // Placar: eu × cada membro, usando os registros dos dois lados
  const placares = otherMembers().map((m) => {
    const minhas = [];  // finalizações que apliquei nele
    const dele = [];    // finalizações que ele aplicou em mim
    let rolas = 0;
    for (const s of group.sessions) {
      for (const r of s.rolls) {
        if (s.uid === me && r.partnerUid === m.uid) {
          rolas++; minhas.push(...r.wins); dele.push(...r.losses);
        } else if (s.uid === m.uid && r.partnerUid === me) {
          rolas++; minhas.push(...r.losses); dele.push(...r.wins);
        }
      }
    }
    return { ...m, rolas, minhas, dele };
  }).filter((p) => p.rolas > 0).sort((a, b) => b.rolas - a.rolas);

  grupoEl.innerHTML = `
    <div class="grupo-card">
      <h3>${group.name}</h3>
      <small>Código pra convidar:</small>
      <div class="grupo-code">${group.code}</div>
      <small>${membros.length} ${membros.length === 1 ? 'membro' : 'membros'}</small>
    </div>

    <h2>Ranking do mês</h2>
    <ul class="membros">${ranking.map((m, i) => `
      <li>
        <img src="${m.photo}" alt="" referrerpolicy="no-referrer">
        <span>${m.name}${m.uid === me ? '<span class="voce">você</span>' : ''}</span>
        <span class="num">${m.treinos} ${m.treinos === 1 ? 'treino' : 'treinos'}</span>
        <span class="num">${(m.minutos / 60).toFixed(1)}h</span>
      </li>`).join('')}
    </ul>

    <h2>Placar</h2>
    ${placares.length ? placares.map((p) => `
      <div class="placar">
        <div class="placar-head">
          <img src="${p.photo}" alt="" referrerpolicy="no-referrer">
          <strong>Você × ${p.name.split(' ')[0]}</strong>
          <span class="placar-num"><span class="w">${p.minhas.length}</span><span class="x">×</span><span class="l">${p.dele.length}</span></span>
        </div>
        <div class="placar-det">
          <div>${p.rolas} ${p.rolas === 1 ? 'rola' : 'rolas'}</div>
          ${p.minhas.length ? `<div><span class="r-win">Você pegou:</span> ${summarize(p.minhas)}</div>` : ''}
          ${p.dele.length ? `<div><span class="r-loss">Te pegou:</span> ${summarize(p.dele)}</div>` : ''}
        </div>
      </div>`).join('')
    : `<p class="vazio-inline">Nenhuma rola com membro do grupo ainda. Ao adicionar uma rola, toca no nome do parceiro pra ligar.</p>`}

    <button type="button" id="btn-sair-grupo" class="btn-secondary btn-sair-grupo">Sair do grupo</button>
  `;

  $('#btn-sair-grupo').addEventListener('click', () => {
    if (!confirm(`Sair de "${group.name}"? Seus treinos somem do grupo (continuam no seu diário).`)) return;
    acaoGrupo(null, () => window.jjGroup.leave());
  });
}

// Roda uma ação do grupo desabilitando o formulário enquanto espera
async function acaoGrupo(form, fn) {
  const btn = form?.querySelector('button');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    await fn();
  } catch (err) {
    alert(err.message);
    renderGrupo();
  }
}

// ===== Backup =====
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jj-diario-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#input-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error('formato inválido');
    // Mescla sem duplicar pelo id
    const ids = new Set(sessions.map((s) => s.id));
    const novas = imported.filter((s) => !ids.has(s.id));
    sessions = [...sessions, ...novas];
    saveSessions(sessions);
    // Reaproveita a migração do formato antigo, se o backup for de antes
    sessions = loadSessions();
    for (const s of novas) window.jjSync?.upsert(s);
    renderStats();
    alert(`${novas.length} treino(s) importado(s).`);
  } catch (err) {
    alert('Não consegui ler o arquivo: ' + err.message);
  }
  e.target.value = '';
});
