# Diário JJ

Diário de treino de jiu jitsu pra usar no celular. Registra aula, rolas e finalizações, mostra estatísticas, sincroniza pela conta Google e tem grupo com placar entre amigos.

**No ar:** https://hipablocosta.github.io/jj-diario/

## Como funciona

HTML, CSS e JavaScript puros. Sem framework, sem build, sem servidor próprio. Os arquivos estáticos ficam no GitHub Pages; os dados, no Firebase (Firestore) quando a pessoa está logada.

| Arquivo | O que faz |
|---|---|
| `index.html` | As quatro abas (Novo, Histórico, Stats, Grupo) e o painel de técnicas |
| `style.css` | Visual dark, mobile-first |
| `app.js` | Toda a lógica do diário: formulário, histórico, stats, grupo. Persiste em `localStorage` |
| `sync.js` | Login Google, Firestore, grupos. Módulo ES que carrega depois do `app.js` |
| `catalogo.js` | Lista de técnicas por categoria. É só um objeto de strings — edite à vontade |
| `firestore.rules` | Regras de segurança do Firestore (referência; o Firestore não lê daqui) |
| `manifest.json`, `icon.svg` | Pra "Adicionar à tela de início" virar ícone de app |

`app.js` e `sync.js` conversam por dois objetos globais:
- `window.jjApp` — o app expõe: ler/substituir treinos, marcar como sincronizado, receber usuário e grupo
- `window.jjSync` / `window.jjGroup` — o sync expõe: gravar/apagar no Firestore, criar/entrar/sair de grupo, recusar rola

Sem login, `window.jjSync` é `null` e tudo funciona só com `localStorage`.

## Modelo de dados

```
Treino (sessão)
  id, date, type ('gi' | 'nogi'), duration (min)
  techniques: ["Raspagem tesoura", ...]        técnicas da aula
  rolls: [Rola]
  worked, stuck, study                          notas: funcionou / travei em / pra estudar
  studyDone                                     pendência de estudo resolvida?
  synced                                        controle local: já confirmado pelo servidor?

Rola
  rid                                           id da rola
  partner                                       nome (texto livre)
  partnerUid                                    uid, se o parceiro é membro do grupo
  wins:   ["Armlock", "Armlock"]                finalizações que eu apliquei (repete = 2×)
  losses: ["Mata-leão"]                         finalizações que sofri
  mirrorOf                                      chave da rola do parceiro que esta confirma
```

Sem finalização nas duas listas = empate.

### Firestore

```
users/{uid}/sessions/{id}      treino completo — privado
users/{uid}/meta/tecnicas      técnicas personalizadas
users/{uid}/meta/perfil        { groupId }
groups/{gid}                   { name, code, createdBy, members: { uid: { name, photo, refused: [] } } }
groups/{gid}/sessions/{id}     cópia PÚBLICA do treino, sem as notas
codes/{code}                   { groupId } — código de convite
```

Notas (`worked`, `stuck`, `study`) **nunca** vão pra cópia pública. As regras em `firestore.rules` garantem que cada pessoa só lê o próprio diário, e que membros de um grupo só leem as cópias públicas daquele grupo.

### Confirmar rola

Quando A registra uma rola com B (membro do grupo), B vê "A registrou uma rola com você" na aba Grupo:
- **Confirmar** cria a rola no diário de B, invertida (o que A aplicou, B sofreu), com `mirrorOf` apontando pra rola de A. No placar, a cópia não conta — só a original.
- **Não foi assim** grava a chave da rola em `members[B].refused`. A rola sai do placar dos dois lados e aparece como "✗ não confirmada" no histórico de A.
- Rola não confirmada ainda conta no placar, marcada como "aguardando".

Se B for registrar por conta própria uma rola com A no mesmo dia, o app pergunta se é a mesma.

## Rodar local

```
cd ~/Documents/jj-claude
python3 -m http.server 8080
```

Abre http://localhost:8080. Login Google funciona no `localhost` (domínio já autorizado no Firebase).

## Publicar

```
git add -A
git commit -m "o que mudou"
git push
```

O GitHub Pages republica em ~1 minuto. O `index.html` fica em cache por 10 minutos — Cmd+Shift+R no Mac, ou fechar e reabrir a aba no celular.

**Toda vez que mudar `app.js`, `sync.js`, `style.css` ou `catalogo.js`, suba o número de versão no `index.html`** (`?v=11` → `?v=12`, nos quatro lugares). Sem isso o navegador pode ficar com o arquivo antigo.

Se mudar `firestore.rules`, cole o conteúdo no console do Firebase (Firestore Database → Regras → Publicar). Isso não acontece pelo git.

## Firebase

Projeto `jj-diario` no console do Firebase (conta Google do Pablo).

- **Authentication** → Google ativado. Domínios autorizados: `localhost`, `hipablocosta.github.io`
- **Firestore** → banco `(default)` em `southamerica-east1`, regras de `firestore.rules`
- A config (`apiKey` etc.) está em `sync.js`. Não é segredo — vai no HTML público de qualquer site com Firebase. O que protege os dados são as regras.
- **Authentication → Usuários** mostra quem já entrou. **Firestore → Dados** mostra os treinos (o dono do projeto vê tudo — vale ser transparente com quem usa).

Plano gratuito: 50 mil leituras e 20 mil gravações por dia. Um treino = uma gravação.

## Decisões

- **Sem framework.** O objetivo era entender o código. Três arquivos JS legíveis valem mais que um build.
- **Técnicas da aula e finalizações das rolas são coisas diferentes.** A aula pode ser uma passagem; a rola só tem finalização. Cruzar os dois é a graça.
- **Notas são privadas, treinos e rolas são do grupo.** "Travei em" e "Pra estudar" são pessoais.
- **Placar é dos dois lados.** O outro vê o que você registrou contra ele. É o que faz registrar valer a pena.
- **Recusar é contestar**, não "não quero no meu diário". Por isso tira do placar.
- **Rola não confirmada conta.** Senão o placar fica vazio enquanto o amigo não abre o app.
- **Mudar "pra estudar" reabre a pendência.** Virou outra coisa pra estudar.

## Backlog

- Timer de rounds
- Autocompletar nome de parceiro que não tem app
- Reabrir pendência de estudo marcada sem querer
- Renomear grupo, expulsar membro, mais de um grupo por pessoa
- Feed do grupo ("Pablo treinou hoje")
