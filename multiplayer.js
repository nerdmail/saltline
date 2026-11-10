/* multiplayer.js — salas por convite para o Saltline: Policiais x Terroristas, resgate de reféns.
   Não altera o game.js: só usa o objeto window.__G que o jogo expõe. Sem ?sala= na URL e sem
   clicar em "Criar sala", nada aqui roda e o modo solo fica como sempre foi.

   Como funciona: quem cria a sala é o anfitrião. Os convidados abrem o link (?sala=CÓDIGO) e os
   navegadores se conectam direto (WebRTC, via PeerJS). O anfitrião decide rodadas, placar, reféns
   e simula as máquinas; cada jogador simula o próprio boneco e avisa quando acerta alguém.

   Regras: os Policiais vencem levando todos os reféns até o ponto de resgate da rodada (ou
   eliminando os Terroristas). Os Terroristas vencem se o tempo acabar ou se todos os Policiais caírem. Quem
   matar um refém entrega a rodada para o outro time.

   Seções: ajustes · estado · rede · perfil e lobby · rodadas · bonecos · tiros · máquinas ·
   reféns e passagens · explosivos · armas · laço da partida · início. */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ ajustes */
  const CFG = {
    rodadasParaVencer: 5,      // primeiro time a chegar aqui vence a partida
    tempoPreparo: 4,           // segundos parado antes de valer
    tempoEntreRodadas: 6,
    tempoPegar: 1.2,           // segundos segurando E para soltar um refém
    velRefem: 3.6,             // metros por segundo
    maxJogadores: 10,
    danoCabeca: 2,             // multiplicador de tiro na cabeça
    // explosivos: só os Terroristas pegam e usam; ficam espalhados em pontos sorteados a cada rodada
    itens: { granada: 6, bomba: 3, relogio: 2 },                   // quantos de cada por rodada
    granada: { dano: 110, raio: 7, pavio: 2.5, forca: 17 },        // tecla G
    bomba:   { dano: 330, raio: 11, pavio: 30 },                   // tecla B · 3x a granada · pode ser desarmada
    relogio: { dano: 330, raio: 11, tempos: [15, 30, 60, 90] },    // tecla V · T escolhe o tempo · pode ser desarmada
    tempoDesarmar: 4,          // segundos segurando E para desarmar
    peerjs: "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js",
    prefixo: "saltline-sala-",
  };
  // tempo da rodada (s), máquinas no começo, máquinas extras a cada refém solto ou salvo, teto de máquinas vivas.
  // refem: tiros na cabeça para matar, chance de acertar cada tiro, segundos entre tiros, dano por tiro, o quanto desvia (0 a 1)
  const DIFICULDADES = {
    facil:   { nome: "Fácil",       tempo: 210, patrulha: { gull: 1, hound: 0 }, onda: { gull: 1, hound: 0 }, max: 3,
               refem: { tirosCabeca: 1, precisao: 0.12, cadencia: 1.6, dano: 8,  esquiva: 0.3 } },
    medio:   { nome: "Médio",       tempo: 180, patrulha: { gull: 2, hound: 1 }, onda: { gull: 1, hound: 1 }, max: 5,
               refem: { tirosCabeca: 2, precisao: 0.2,  cadencia: 1.2, dano: 10, esquiva: 0.5 } },
    dificil: { nome: "Difícil",     tempo: 150, patrulha: { gull: 3, hound: 2 }, onda: { gull: 2, hound: 1 }, max: 8,
               refem: { tirosCabeca: 3, precisao: 0.32, cadencia: 0.9, dano: 12, esquiva: 0.75 } },
    treta:   { nome: "Muita treta", tempo: 120, patrulha: { gull: 4, hound: 3 }, onda: { gull: 3, hound: 2 }, max: 12,
               refem: { tirosCabeca: 4, precisao: 0.45, cadencia: 0.7, dano: 14, esquiva: 1 } },
  };
  const TIMES = {
    p: { nome: "Policiais", curto: "POL", cor: 0x4aa3ff, css: "#6fb6ff", yaw: -Math.PI / 2,
         objetivo: "Leve os reféns ao ponto de resgate", papel: "Tiram os reféns do galpão e levam ao ponto de resgate" },
    t: { nome: "Terroristas", curto: "TER", cor: 0xff5a40, css: "#ff5a40", yaw: Math.PI / 2,
         objetivo: "Não deixe levarem os reféns", papel: "Impedem o resgate até o tempo acabar" },
  };
  // onde cada time nasce [x, z]
  const BASE_POLICIA = [-32, 6];                       // lado oeste (portão)
  const POLICIAIS_NA_SALA = [[2, -22], [5, -22]];      // os dois primeiros Policiais já começam com os reféns
  const NASCER_TERRORISTAS = [[27.4, 11.6], [20.9, 14.7], [23.4, 23.2], [18, 24.4], [27.2, -12.6], [29, 14], [27, 8], [18, 22.2]];   // espalhados no lado leste (cais)
  // posições no mapa [x, z]. O galpão (sala dos reféns) vai de x -16 a 12 e de z -28 a -11.
  const REFENS = [[-10, -22], [-7, -22.6], [-4, -22]];
  // quem são os reféns, na ordem das posições acima: cor da roupa, cabelo, tamanho e ritmo de caminhada
  const CIVIS = [
    { quem: "mulher",  cor: 0xb04a6a, cabelo: 0x3a2418, cabeloLongo: true,  escala: 0.95, vel: 1 },
    { quem: "criança", cor: 0xf2c94c, cabelo: 0x2b1d14, cabeloLongo: false, escala: 0.7,  vel: 0.9 },
    { quem: "idoso",   cor: 0x7d8a96, cabelo: 0xd8d8d8, cabeloLongo: false, escala: 0.92, vel: 0.75 },
  ];
  // pontos de resgate: um é sorteado a cada rodada e só os Policiais ficam sabendo qual
  const RESGATES = [[-32, 6], [-32, 20], [-32, -8], [-26.6, -15], [-16, 22], [-7.8, 21.4], [6, 26], [14.2, 16.4], [-19, -1.4], [-10.3, 12.5]];
  const RAIO_RESGATE = 4;
  const PASSAGENS = [            // saídas secretas: entrou em "de", sai sempre em "para"
    { de: [-13.5, -22], para: [-16, 26] },
    { de: [-6, -26],    para: [14.2, 16.4] },
    { de: [6, -26],     para: [27.2, -12.6] },
    { de: [9.5, -22],   para: [-26.6, -15] },
  ];
  // armas: cada jogador nasce sem arma, com o conjunto do seu time no chão ao redor. Só dá para carregar uma.
  // Todas tiram o mesmo dano por tiro; muda o pente e o modo (auto, semi, rajada). rpm = tiros por minuto (máx. 720).
  const ARMAS = {
    p_fuzil:    { nome: "Fuzil M4",     time: "p", pente: 30, modo: "rajada", rajada: 3, rpm: 720 },
    p_metra:    { nome: "MP5",          time: "p", pente: 30, modo: "auto", rpm: 720 },
    p_12:       { nome: "Escopeta 12",  time: "p", pente: 6,  modo: "semi", rpm: 70, chumbo: 8, alcance: 20 },
    p_pistola:  { nome: "Pistola 9mm",  time: "p", pente: 12, modo: "semi", rpm: 360 },
    p_revolver: { nome: "Revólver .38", time: "p", pente: 6,  modo: "semi", rpm: 200 },
    p_faca:     { nome: "Faca",         time: "p", faca: true },
    t_fuzil:    { nome: "AK-47",        time: "t", pente: 30, modo: "auto", rpm: 560 },
    t_metra:    { nome: "Uzi",          time: "t", pente: 25, modo: "auto", rpm: 720 },
    t_12:       { nome: "12 serrada",   time: "t", pente: 2,  modo: "semi", rpm: 120, chumbo: 10, alcance: 15 },
    t_pistola:  { nome: "Pistola .45",  time: "t", pente: 8,  modo: "semi", rpm: 300 },
    t_pistola2: { nome: "Pistola auto", time: "t", pente: 17, modo: "auto", rpm: 600 },
    t_faca:     { nome: "Faca",         time: "t", faca: true },
  };
  // faca: silenciosa (ninguém ouve seus passos); pelas costas mata, pela frente só fere
  const FACA = { alcance: 1.9, danoFrente: 35, danoCostas: 500, espera: 0.6 };
  const DANO_CHUMBO = 13;      // cada bago da 12 (ela solta vários de uma vez, mas só alcança de perto)
  const CHAVE_PERFIL = "saltline.perfil.v1";
  const ESTADOS = ["preso", "seguindo", "salvo", "morto"];

  /* ------------------------------------------------------------------- estado */
  let G = null, V3 = null, solo = null, satOriginal = 1, cenario = null, rotuloHud = null, discoResgate = null;
  const mp = {
    ativo: false, anfitriao: false, codigo: null, meuId: null, peer: null, conAnfitriao: null,
    cons: new Map(),          // anfitrião: id -> conexão
    jogadores: new Map(),     // id -> { id, nome, time, vivo, pos, cur, yaw, pitch, agachado, boneco, alvo }
    refens: [],               // { i, pos, cur, vel, estado, lider, hp, jaSolto, caminho, caminhoT, boneco }
    dificuldade: "medio",
    resgate: null,            // anfitrião: ponto sorteado da rodada
    resgateVisto: null,       // Policiais: ponto revelado nesta rodada
    fase: "lobby",            // lobby | preparo | valendo | fim
    rodada: 0, placar: { p: 0, t: 0 }, tempo: 0, preparoT: 0, fimT: 0,
    pegando: -1, pegarT: 0, passagemT: 0, assinatura: "",
    itens: new Map(),         // explosivos no chão: id -> { id, tipo, pos, malha, pedido }
    bombas: new Map(),        // bombas armadas: id -> { id, tipo, pos, t, por, malha, bipe }
    granadas: [],             // granadas no ar: { pos, vel, t, por, malha }
    bolsa: { granada: 0, bomba: 0, relogio: 0 }, tempoIdx: 1, desarmarT: 0, proxId: 1,
    arma: null,               // chave em ARMAS da arma na mão, ou null
    armasChao: new Map(),     // id -> { id, arma, pos, malha, pedido }
    cadT: 0, rajada: 0, gatilhoAntes: false, semPegarT: 0, armaVisivel: null, passoT: 0,
    marionetes: new Map(),    // convidado: id da máquina no anfitrião -> máquina local
    aplicandoMorte: false, ultimoDano: null, envioT: 0, placarT: 0, ouvirT: 0,
  };
  const eu = () => mp.jogadores.get(mp.meuId);
  const dif = () => DIFICULDADES[mp.dificuldade] || DIFICULDADES.medio;
  const emRodada = () => mp.ativo && mp.fase !== "lobby";
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const arr = v => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
  const tocar = (nome, opt) => { try { G.audio.play(nome, opt); } catch {} };
  const posDe = j => j.id === mp.meuId ? G.player.pos : j.pos;

  /* --------------------------------------------------------------------- rede */
  function carregarPeer() {
    if (window.Peer) return Promise.resolve();
    return new Promise((ok, erro) => {
      const s = document.createElement("script");
      s.src = CFG.peerjs; s.onload = ok;
      s.onerror = () => erro(new Error("Não deu para carregar a biblioteca de rede. Verifique a internet."));
      document.head.appendChild(s);
    });
  }
  // convidado -> anfitrião (o anfitrião trata a própria mensagem na hora)
  function enviar(msg) {
    if (mp.anfitriao) doJogador(mp.meuId, msg);
    else if (mp.conAnfitriao && mp.conAnfitriao.open) mp.conAnfitriao.send(msg);
  }
  // anfitrião -> todos (inclusive ele mesmo, a não ser que "menos" seja ele)
  function paraTodos(msg, menos) {
    for (const [id, c] of mp.cons) if (id !== menos && c.open) c.send(msg);
    if (menos !== mp.meuId) doAnfitriao(msg);
  }
  function paraUm(id, msg) {
    if (id === mp.meuId) doAnfitriao(msg);
    else { const c = mp.cons.get(id); if (c && c.open) c.send(msg); }
  }

  async function criarSala() {
    const nome = await pedirPerfil();
    const codigo = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    try { sessionStorage.setItem("saltline.anfitriao", codigo); } catch {}
    history.replaceState(null, "", location.pathname + "?sala=" + codigo);
    await abrirComoAnfitriao(codigo, nome);
  }
  async function abrirComoAnfitriao(codigo, nome) {
    aviso("Abrindo a sala…");
    try { await carregarPeer(); } catch (e) { return aviso(e.message, true); }
    const peer = new window.Peer(CFG.prefixo + codigo);
    mp.peer = peer; mp.codigo = codigo;
    peer.on("open", () => {
      mp.ativo = true; mp.anfitriao = true; mp.meuId = "anfitriao";
      novoJogador(mp.meuId, nome);
      entrarNoLobby();
    });
    peer.on("connection", con => {
      con.on("open", () => {
        if (mp.jogadores.size >= CFG.maxJogadores) { con.send({ t: "recusa", motivo: "A sala está cheia." }); return setTimeout(() => con.close(), 500); }
        mp.cons.set(con.peer, con);
      });
      con.on("data", msg => { if (msg && typeof msg === "object") doJogador(con.peer, msg); });
      con.on("close", () => saiu(con.peer));
      con.on("error", () => saiu(con.peer));
    });
    peer.on("error", e => {
      if (e.type === "unavailable-id") aviso("Esta sala já está aberta em outra aba ou aparelho.", true);
      else if (!mp.ativo) aviso("Não deu para abrir a sala (" + e.type + ").", true);
    });
  }
  async function entrarNaSala(codigo) {
    const nome = await pedirPerfil();
    aviso("Entrando na sala…");
    try { await carregarPeer(); } catch (e) { return aviso(e.message, true); }
    const peer = new window.Peer();
    mp.peer = peer; mp.codigo = codigo;
    peer.on("open", id => {
      const con = peer.connect(CFG.prefixo + codigo, { reliable: true, serialization: "json" });
      mp.conAnfitriao = con;
      con.on("open", () => { mp.ativo = true; mp.meuId = id; con.send({ t: "oi", nome }); });
      con.on("data", msg => { if (msg && typeof msg === "object") doAnfitriao(msg); });
      con.on("close", () => { if (mp.ativo) fimDeConexao("O anfitrião saiu ou a conexão caiu."); });
    });
    peer.on("error", e => {
      if (e.type === "peer-unavailable") aviso("Sala não encontrada. Peça um link novo para quem criou.", true);
      else if (!mp.ativo) aviso("Não deu para conectar (" + e.type + ").", true);
    });
  }
  function fimDeConexao(texto) {
    mp.ativo = false; sairDaPartida();
    aviso(texto, true);
  }

  /* ----------------------------------------------- mensagens: jogador -> anfitrião */
  function doJogador(id, m) {
    const j = mp.jogadores.get(id);
    if (m.t === "oi") {
      if (j) return;
      novoJogador(id, String(m.nome || "Jogador").slice(0, 16));
      paraUm(id, { t: "bemvindo", id });
      return mandarLobby();
    }
    if (!j) return;
    switch (m.t) {
      case "time":
        if (m.time === "p" || m.time === "t") { j.time = m.time; mandarLobby(); }
        break;
      case "estado":
        if (id !== mp.meuId) { j.pos.fromArray(m.p); j.yaw = m.y; j.pitch = m.x; j.agachado = !!m.c; }
        j.vivo = !!m.v;
        break;
      case "tiro":
        paraTodos({ t: "tiro", id, o: m.o, e: m.e }, id);
        if (mp.ouvirT <= 0) { mp.ouvirT = 0.3; try { G.enemies.alert(new V3().fromArray(m.o), G.enemies.TUNE.hearRadius || 40); } catch {} }
        break;
      case "acerto": {
        const alvo = mp.jogadores.get(m.em);
        if (mp.fase === "valendo" && alvo && alvo.vivo && j.vivo && alvo.time !== j.time)
          paraUm(alvo.id, { t: "dano", q: Math.min(600, +m.q || 0), de: m.de, por: id });
        break;
      }
      case "acertoRefem":
        if (mp.refens[m.i]) ferirRefem(mp.refens[m.i], 1, id);       // o cliente só avisa tiro na cabeça
        break;
      case "armaPeguei":
        if (mp.armasChao.has(m.id) && j.vivo) paraTodos({ t: "armaPega", id: m.id, por: id });
        break;
      case "armaSolta":
        if (ARMAS[m.arma] && Array.isArray(m.p)) paraTodos({ t: "armaChao", d: [mp.proxId++, m.arma, +m.p[0], +m.p[1]], por: id });
        break;
      case "passo":
        paraTodos({ t: "passo", p: m.p, id }, id);
        break;
      case "pegueiItem": {
        const it = mp.itens.get(m.id);
        if (mp.fase === "valendo" && it && j.time === "t" && j.vivo) paraTodos({ t: "item", id: m.id, por: id });
        break;
      }
      case "granada":
        if (mp.fase === "valendo" && j.time === "t" && j.vivo) paraTodos({ t: "granada", o: m.o, v: m.v, por: id });
        break;
      case "plantar": {
        if (mp.fase !== "valendo" || j.time !== "t" || !j.vivo || (m.tipo !== "bomba" && m.tipo !== "relogio")) break;
        const tempo = m.tipo === "bomba" ? CFG.bomba.pavio : Math.max(5, Math.min(120, +m.tempo || 30));
        paraTodos({ t: "bomba", id: mp.proxId++, tipo: m.tipo, p: m.p, tempo, por: id });
        break;
      }
      case "desarmei": {
        const b = mp.bombas.get(m.id);
        if (mp.fase === "valendo" && b && j.time === "p" && j.vivo) paraTodos({ t: "bombaFora", id: m.id, ev: "desarmada", por: id });
        break;
      }
      case "pegar": {
        const r = mp.refens[m.i];
        if (mp.fase !== "valendo" || !r || r.estado !== 0 || j.time !== "p" || !j.vivo) break;
        r.estado = 1; r.lider = id;
        paraTodos({ t: "refem", i: m.i, ev: "solto", id });
        if (!r.jaSolto) { r.jaSolto = true; soltarOnda(); }
        break;
      }
      case "acertoMaquina": {
        const e = G.enemies.list.find(x => x.id === m.id);
        if (!e || !e.alive) break;
        const real = G.player;
        if (id !== mp.meuId && j.alvo) G.player = j.alvo;   // a máquina reage a quem atirou
        try { e.damage(Math.min(200, +m.q || 0), e.pos.clone(), m.d ? new V3().fromArray(m.d) : null, m.parte); } finally { G.player = real; }
        break;
      }
      case "morri":
        if (j.vivo || id === mp.meuId) { j.vivo = false; paraTodos({ t: "baixa", quem: id, por: m.por || null }); }
        break;
    }
  }
  function saiu(id) {
    mp.cons.delete(id);
    const j = mp.jogadores.get(id);
    if (!j) return;
    removerBoneco(j); mp.jogadores.delete(id);
    if (mp.ativo) { paraTodos({ t: "feed", html: `<b>${esc(j.nome)}</b> saiu da sala` }); mandarLobby(); }
  }
  function mandarLobby() {
    paraTodos({ t: "lobby", fase: mp.fase, placar: mp.placar, rodada: mp.rodada, dificuldade: mp.dificuldade,
      jogadores: [...mp.jogadores.values()].map(j => ({ id: j.id, nome: j.nome, time: j.time })) });
  }

  /* ----------------------------------------------- mensagens: anfitrião -> jogador */
  function doAnfitriao(m) {
    // quem ainda está na sala de espera ignora o que acontece dentro da rodada em andamento
    if (mp.fase === "lobby" && !["bemvindo", "recusa", "lobby", "rodada"].includes(m.t)) return;
    switch (m.t) {
      case "bemvindo": mp.meuId = m.id; break;
      case "recusa": fimDeConexao(m.motivo); break;
      case "lobby": {
        const vistos = new Set();
        for (const d of m.jogadores) {
          vistos.add(d.id);
          const j = mp.jogadores.get(d.id) || novoJogador(d.id, d.nome);
          j.nome = d.nome; j.time = d.time;
        }
        for (const [id, j] of mp.jogadores) if (!vistos.has(id)) { removerBoneco(j); mp.jogadores.delete(id); }
        mp.placar = m.placar; mp.rodada = m.rodada; mp.dificuldade = m.dificuldade;
        if (!mp.anfitriao && mp.fase === "lobby") mp.faseAnfitriao = m.fase;
        desenharLobby();
        break;
      }
      case "rodada": comecarRodadaLocal(m); break;
      case "estados":
        mp.tempo = m.tempo;
        for (const d of m.j) {
          const j = mp.jogadores.get(d[0]);
          if (!j || j.id === mp.meuId) continue;
          j.pos.set(d[1], d[2], d[3]); j.yaw = d[4]; j.pitch = d[5]; j.agachado = !!d[6]; j.vivo = !!d[7];
        }
        m.r.forEach((d, i) => { const r = mp.refens[i]; if (r) { r.pos.set(d[0], d[1], d[2]); r.estado = d[3]; r.lider = d[4]; } });
        sincronizarMarionetes(m.m);
        break;
      case "tiro": tiroRemoto(m); break;
      case "resgate":
        mp.resgateVisto = new V3(m.p[0], 0, m.p[1]); mp.assinatura = "";
        discoResgate.position.copy(mp.resgateVisto); discoResgate.visible = true;
        break;
      case "dano":
        if (emRodada() && G.player.alive) {
          mp.ultimoDano = { por: m.por, t: performance.now() };
          G.player.damage(m.q, m.de ? new V3().fromArray(m.de) : null);
        }
        break;
      case "baixa": {
        const v = mp.jogadores.get(m.quem), k = m.por && mp.jogadores.get(m.por);
        if (v && v.id !== mp.meuId) v.vivo = false;
        if (v) G.hud.feed(k ? `<b>${esc(k.nome)}</b> eliminou <b>${esc(v.nome)}</b>` : m.por === "refem" ? `<b>${esc(v.nome)}</b> foi abatido por um refém` : `<b>${esc(v.nome)}</b> caiu para as máquinas`);
        break;
      }
      case "feed": G.hud.feed(m.html); break;
      case "refem": {
        const r = mp.refens[m.i], quem = mp.jogadores.get(m.id), nome = quem ? esc(quem.nome) : "Alguém";
        if (!r) break;
        if (m.ev === "solto") { r.estado = 1; r.lider = m.id; G.hud.feed(`<b>${nome}</b> soltou um refém`); if (eu() && eu().time === "t") G.hud.warn("Estão levando um refém", 3); tocar("alert"); }
        else if (m.ev === "salvo") { r.estado = 2; r.lider = null; G.hud.feed(`<b>${nome}</b> salvou um refém`); G.hud.warn("Refém a salvo", 3); tocar("relay_cut"); }
        else if (m.ev === "largado") { r.estado = 0; r.lider = null; G.hud.feed("Um refém ficou para trás"); }
        else if (m.ev === "morto") { r.estado = 3; r.lider = null; G.hud.feed(`<b>${nome}</b> matou um refém`); }
        break;
      }
      case "armaPega": {
        const it = mp.armasChao.get(m.id);
        if (!it) break;
        tirarArmaDoChao(m.id);
        if (m.por === mp.meuId && !mp.arma) { mp.arma = it.arma; mp.rajada = 0; mp.cadT = 0.3; try { G.weapon.reset(); } catch {} tocar("reload_magin"); G.hud.message(ARMAS[it.arma].nome + " · G solta", 2.5); }
        break;
      }
      case "armaChao":
        porArmaNoChao(m.d);
        if (m.por === mp.meuId) mp.armasChao.get(m.d[0]).espera = true;   // quem soltou só pega de novo depois de se afastar
        break;
      case "passo":
        if (m.id !== mp.meuId) tocar("step_concrete", { pos: new V3().fromArray(m.p), gain: 0.8 });
        break;
      case "item": {
        const it = mp.itens.get(m.id);
        if (!it) break;
        explosivos.remove(it.malha); mp.itens.delete(m.id);
        if (m.por === mp.meuId) { mp.bolsa[it.tipo]++; tocar("reload_magin"); G.hud.message("Pegou: " + NOMES_ITEM[it.tipo], 2); }
        break;
      }
      case "granada":
        mp.granadas.push({ pos: new V3().fromArray(m.o), vel: new V3().fromArray(m.v), t: CFG.granada.pavio, por: m.por, malha: caixa(CORES_ITEM.granada, 0.14) });
        break;
      case "bomba": {
        const b = { id: m.id, tipo: m.tipo, pos: new V3().fromArray(m.p), t: m.tempo, por: m.por, malha: caixa(CORES_ITEM[m.tipo], 0.34), bipe: 0 };
        b.malha.position.copy(b.pos).setY(b.pos.y + 0.17);
        mp.bombas.set(m.id, b);
        G.hud.warn(eu() && eu().time === "t" ? "Bomba armada" : "Bomba armada no mapa", 2.5); tocar("alert");
        break;
      }
      case "bombaFora": {
        const b = mp.bombas.get(m.id), quem = mp.jogadores.get(m.por);
        if (!b) break;
        explosivos.remove(b.malha); mp.bombas.delete(m.id);
        if (m.ev === "desarmada") { G.hud.feed(`<b>${esc(quem ? quem.nome : "Alguém")}</b> desarmou uma bomba`); tocar("relay_cut", { pos: b.pos }); }
        break;
      }
      case "explosao": {
        const p = new V3().fromArray(m.p), pl = G.player;
        try { G.fx.explosion(p, m.raio / 5); } catch {}
        G.events.emit("explosion", { pos: p, size: m.raio / 5 });
        tocar("explosion", { pos: p });
        if (emRodada() && pl.alive && mp.fase === "valendo") {
          const d = pl.eye.distanceTo(p); let visto = true;
          try { visto = G.physics.lineOfSight(p.clone().setY(p.y + 0.4), pl.eye); } catch {}
          if (d < m.raio && visto) { mp.ultimoDano = { por: m.por === mp.meuId ? null : m.por, t: performance.now() }; pl.damage(m.dano * (1 - d / m.raio), p); }
        }
        break;
      }
      case "abateMaquina": {
        const e = mp.marionetes.get(m.id);
        if (e && e.alive) { mp.aplicandoMorte = true; try { e.damage(1e9, e.pos.clone(), null, "body"); } finally { mp.aplicandoMorte = false; } }
        break;
      }
      case "raio":
        try {
          const p = new V3().fromArray(m.p);
          G.enemies.debug.ctx.fireBolt(p, new V3().fromArray(m.d));
          tocar("gull_fire", { pos: p });
        } catch {}
        break;
      case "fimRodada":
        mp.fase = "fim"; mp.placar = m.placar;
        G.hud.setPrompt(null);
        G.hud.warn(TIMES[m.vencedor].nome + " vencem a rodada", 4.5);
        G.hud.radio(m.motivo + ".", 4);
        tocar(eu() && eu().time === m.vencedor ? "objective_all" : "death");
        break;
      case "fimPartida": {
        const perdedor = m.vencedor === "p" ? "t" : "p";
        mp.resultado = TIMES[m.vencedor].nome + " venceram a partida por " + m.placar[m.vencedor] + " a " + m.placar[perdedor];
        sairDaPartida(); mp.faseAnfitriao = "lobby"; mp.placar = { p: 0, t: 0 }; mp.rodada = 0;
        entrarNoLobby();
        break;
      }
    }
  }

  /* ---------------------------------------------------------- perfil e lobby */
  let tela = null;
  function overlay(html) {
    if (!tela) { tela = document.createElement("div"); tela.className = "mp-tela"; document.getElementById("app").appendChild(tela); }
    tela.innerHTML = `<div class="mp-cartao">${html}</div>`; tela.hidden = false;
    return tela;
  }
  function fecharOverlay() { if (tela) tela.hidden = true; }
  function aviso(texto, comSaida) {
    esconderMenuSolo();
    overlay(`<div class="mp-k">Multiplayer</div><p class="mp-linha">${esc(texto)}</p>` +
      (comSaida ? `<div class="mp-acoes"><button class="btn primary" data-mp="sair">Voltar ao início</button></div>` : ""));
  }
  function esconderMenuSolo() { try { solo.menus.show("none"); solo.menus.locationCard(false); } catch {} }
  function lerPerfil() { try { return JSON.parse(localStorage.getItem(CHAVE_PERFIL) || "null"); } catch { return null; } }
  function pedirPerfil(forcar) {
    const p = lerPerfil();
    if (p && p.nome && !forcar) return Promise.resolve(p.nome);
    esconderMenuSolo();
    return new Promise(ok => {
      const el = overlay(`<div class="mp-k">Seu perfil</div><h2 class="mp-h">Como você se chama?</h2>
        <form class="mp-form"><input class="mp-campo" name="nome" maxlength="16" placeholder="Apelido" autocomplete="off" value="${esc(p && p.nome || "")}" required>
        <button class="btn primary" type="submit">Salvar</button></form>
        <p class="mp-nota">O apelido fica guardado só neste navegador.</p>`);
      const campo = el.querySelector("input"); setTimeout(() => campo.focus(), 30);
      el.querySelector("form").addEventListener("submit", ev => {
        ev.preventDefault();
        const nome = campo.value.trim().slice(0, 16); if (!nome) return;
        try { localStorage.setItem(CHAVE_PERFIL, JSON.stringify({ nome })); } catch {}
        ok(nome);
      });
    });
  }
  function entrarNoLobby() {
    mp.fase = "lobby";
    esconderMenuSolo();
    if (mp.anfitriao) mandarLobby(); else desenharLobby();
  }
  function linkDaSala() { return location.origin + location.pathname + "?sala=" + mp.codigo; }
  function desenharLobby() {
    if (mp.fase !== "lobby" || !mp.ativo) return;
    const lista = t => [...mp.jogadores.values()].filter(j => j.time === t)
      .map(j => `<li>${esc(j.nome)}${j.id === mp.meuId ? " <em>você</em>" : ""}${j.id === "anfitriao" ? " <em>anfitrião</em>" : ""}</li>`).join("") || "<li class='mp-vazio'>ninguém ainda</li>";
    const meu = eu() && eu().time;
    const local = location.protocol === "file:" || /^(localhost|127\.|\[::1\])/.test(location.host);
    const emAndamento = !mp.anfitriao && mp.faseAnfitriao && mp.faseAnfitriao !== "lobby";
    const time = t => `<section style="--cor:${TIMES[t].css}"><h3>${TIMES[t].nome}</h3><p>${TIMES[t].papel}</p><ul>${lista(t)}</ul>
      <button class="btn small" data-mp="time-${t}" ${meu === t ? "disabled" : ""}>${meu === t ? "Você está aqui" : "Entrar"}</button></section>`;
    const d = dif();
    overlay(`<div class="mp-k">Sala privada · só entra quem tem o link</div>
      <h2 class="mp-h">Sala de espera</h2>
      ${mp.resultado ? `<p class="mp-resultado">${esc(mp.resultado)}</p>` : ""}
      <div class="mp-link"><input class="mp-campo" readonly value="${esc(linkDaSala())}"><button class="btn small" data-mp="copiar">Copiar link</button></div>
      ${local ? `<p class="mp-nota mp-alerta">Este endereço só abre neste computador. Para convidar pela internet, publique a pasta do jogo num site e crie a sala por lá.</p>` : ""}
      <div class="mp-times">${time("p")}${time("t")}</div>
      <div class="mp-dif"><span>Dificuldade</span>${mp.anfitriao
        ? `<div class="seg">${Object.entries(DIFICULDADES).map(([k, v]) => `<button data-mp="dif-${k}" aria-pressed="${k === mp.dificuldade}">${v.nome}</button>`).join("")}</div>`
        : `<b>${d.nome}</b>`}</div>
      <p class="mp-nota">${d.nome}: rodadas de ${Math.floor(d.tempo / 60)}:${String(d.tempo % 60).padStart(2, "0")}, até ${d.max} máquinas atacando os dois times. Vence quem fizer ${CFG.rodadasParaVencer} rodadas. Refém só morre com tiro na cabeça e, depois de solto, anda armado e atira nos Terroristas. O galpão tem 4 saídas secretas numeradas; cada uma leva sempre ao mesmo lugar. Só os Terroristas pegam os explosivos espalhados pelo mapa. Todos nascem sem arma: pegue uma do chão passando por cima (G solta, só uma por vez).</p>
      <div class="mp-acoes">
        ${mp.anfitriao ? `<button class="btn primary" data-mp="comecar">Começar partida</button>`
          : `<span class="mp-espera">${emAndamento ? "Partida em andamento — você entra na próxima rodada" : "Aguardando o anfitrião começar"}</span>`}
        <button class="btn" data-mp="nome">Trocar apelido</button>
        <button class="btn" data-mp="sair">Sair da sala</button>
      </div>`);
  }
  document.addEventListener("click", async ev => {
    const b = ev.target.closest && ev.target.closest("[data-mp]"); if (!b) return;
    const a = b.dataset.mp;
    if (a === "criar") criarSala();
    else if (a === "sair") location.href = location.pathname;
    else if (a === "copiar") {
      const campo = tela.querySelector(".mp-link input");
      try { await navigator.clipboard.writeText(campo.value); } catch { campo.select(); document.execCommand("copy"); }
      b.textContent = "Copiado";
    }
    else if (a.startsWith("time-")) enviar({ t: "time", time: a.slice(5) });
    else if (a.startsWith("dif-") && mp.anfitriao) { mp.dificuldade = a.slice(4); mandarLobby(); }
    else if (a === "comecar") { mp.resultado = null; mp.placar = { p: 0, t: 0 }; mp.rodada = 0; novaRodada(); }
    else if (a === "nome") { await pedirPerfil(true); location.reload(); }
  });
  // com uma tela do multiplayer aberta, as teclas não chegam ao jogo parado por trás
  // (senão o Enter do apelido começaria uma partida solo)
  for (const tipo of ["keydown", "keyup"])
    window.addEventListener(tipo, ev => { if (tela && !tela.hidden) ev.stopImmediatePropagation(); }, true);

  /* ------------------------------------------------------------------ rodadas */
  function novoJogador(id, nome) {
    const j = { id, nome, time: null, vivo: false, naRodada: false, pos: new V3(0, -50, 0), cur: new V3(0, -50, 0), yaw: 0, pitch: 0, agachado: false, boneco: null, alvo: null };
    const n = t => [...mp.jogadores.values()].filter(x => x.time === t).length;
    j.time = n("p") <= n("t") ? "p" : "t";          // entra no time com menos gente
    if (id !== mp.meuId) j.alvo = criarAlvo(j);
    mp.jogadores.set(id, j);
    return j;
  }
  // garante um ponto onde dá para ficar em pé, o mais perto possível do pedido
  function pisavel(x, z) {
    try { if (G.physics.nav.isWalkable(x, z)) return [x, z]; const p = G.physics.nav.randomPoint(new V3(x, 0, z), 3); return [p.x, p.z]; } catch { return [x, z]; }
  }
  const embaralhar = l => { const a = [...l]; for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; } return a; };
  function pontosDeNascimento(time, quantos) {
    const pts = [], yaw = TIMES[time].yaw;
    if (time === "t") {            // cada Terrorista num canto diferente do lado leste
      const cantos = embaralhar(NASCER_TERRORISTAS);
      for (let k = 0; k < quantos; k++) { const c = cantos[k % cantos.length], v = Math.floor(k / cantos.length) * 1.5, q = pisavel(c[0] + v, c[1] + v); pts.push([q[0], 0, q[1], yaw]); }
      return pts;
    }
    for (const c of POLICIAIS_NA_SALA) if (pts.length < quantos) { const q = pisavel(c[0], c[1]); pts.push([q[0], 0, q[1], Math.PI / 2]); }
    for (let anel = 0; anel < 4 && pts.length < quantos; anel++)      // o resto dos Policiais, na base
      for (let k = 0; k < Math.max(1, anel * 6) && pts.length < quantos; k++) {
        const ang = k / Math.max(1, anel * 6) * Math.PI * 2, x = BASE_POLICIA[0] + Math.cos(ang) * anel * 1.5, z = BASE_POLICIA[1] + Math.sin(ang) * anel * 1.5;
        let ok = true; try { ok = G.physics.nav.isWalkable(x, z); } catch {}
        if (ok) pts.push([x, 0, z, yaw]);
      }
    while (pts.length < quantos) pts.push([BASE_POLICIA[0], 0, BASE_POLICIA[1], yaw]);
    return pts;
  }
  function zerarRefens() {
    mp.refens.forEach((r, i) => {
      r.pos.set(REFENS[i][0], 0, REFENS[i][1]); r.cur.copy(r.pos); r.vel.set(0, 0, 0); r.casa.copy(r.pos);
      r.estado = 0; r.lider = null; r.hp = dif().refem.tirosCabeca; r.jaSolto = false; r.caminho = null; r.caminhoT = 0;
      r.passoT = Math.random(); r.passo = [0, 0]; r.ladoT = 0; r.lado = 1; r.tiroT = 1.5; r.noChao = true;
    });
  }
  // só o anfitrião
  function novaRodada() {
    mp.rodada++; mp.fase = "preparo"; mp.tempo = dif().tempo;
    const nasc = {};
    for (const t of ["p", "t"]) {
      const time = [...mp.jogadores.values()].filter(j => j.time === t), pts = pontosDeNascimento(t, time.length);
      time.forEach((j, k) => { nasc[j.id] = pts[k]; j.vivo = true; j.naRodada = true; j.pos.set(pts[k][0], 0, pts[k][2]); j.cur.copy(j.pos); });
    }
    try { G.enemies.clear(); } catch {}
    paraTodos({ t: "rodada", n: mp.rodada, placar: mp.placar, nasc, dificuldade: mp.dificuldade, itens: sortearItens(), armas: sortearArmas(nasc) });
    mandarLobby();
    const r = RESGATES[Math.floor(Math.random() * RESGATES.length)], q = pisavel(r[0], r[1]);
    mp.resgate = new V3(q[0], 0, q[1]);
    for (const j of mp.jogadores.values()) if (j.time === "p") paraUm(j.id, { t: "resgate", p: q });   // só os Policiais ficam sabendo
    for (const tipo of ["gull", "hound"]) for (let k = 0; k < dif().patrulha[tipo]; k++) soltarMaquina(tipo, false);
  }
  function fimDaRodada(vencedor, motivo) {
    if (mp.fase !== "valendo") return;
    mp.placar[vencedor]++; mp.fimT = CFG.tempoEntreRodadas;
    paraTodos({ t: "fimRodada", vencedor, motivo, placar: mp.placar });
  }
  function logicaDoAnfitriao(dt) {
    mp.ouvirT -= dt;
    if (mp.fase === "valendo") {
      mp.tempo -= dt;
      moverRefens(dt); explosivosDoAnfitriao(dt);
      const conta = t => { let total = 0, vivos = 0; for (const j of mp.jogadores.values()) if (j.time === t && j.naRodada) { total++; if (j.vivo) vivos++; } return { total, vivos }; };
      const pol = conta("p"), ter = conta("t");
      if (mp.fase !== "valendo") return;
      if (pol.total && !pol.vivos) fimDaRodada("t", "Todos os Policiais caíram");
      else if (ter.total && !ter.vivos && pol.total) fimDaRodada("p", "Todos os Terroristas caíram");
      else if (mp.tempo <= 0) fimDaRodada("t", "O tempo acabou");
    } else if (mp.fase === "fim") {
      mp.fimT -= dt;
      if (mp.fimT <= 0) {
        const v = mp.placar.p >= CFG.rodadasParaVencer ? "p" : mp.placar.t >= CFG.rodadasParaVencer ? "t" : null;
        if (v) { try { G.enemies.clear(); } catch {} paraTodos({ t: "fimPartida", vencedor: v, placar: mp.placar }); }
        else novaRodada();
      }
    }
  }
  // todos
  function comecarRodadaLocal(m) {
    mp.fase = "preparo"; mp.preparoT = CFG.tempoPreparo; mp.rodada = m.n; mp.placar = m.placar; mp.dificuldade = m.dificuldade; mp.tempo = dif().tempo;
    mp.pegando = -1; mp.pegarT = 0; mp.passagemT = 0; mp.ultimoDano = null; mp.resultado = null; mp.assinatura = "";
    mp.resgateVisto = null; discoResgate.visible = false;
    fecharOverlay(); esconderMenuSolo();
    if (!mp.anfitriao) { try { G.enemies.clear(); } catch {} mp.marionetes.clear(); }
    zerarRefens(); limparExplosivos(); limparArmas();
    for (const d of m.armas || []) porArmaNoChao(d);
    for (const d of m.itens || []) {
      const it = { id: d[0], tipo: d[1], pos: new V3(d[2], 0, d[3]), malha: caixa(CORES_ITEM[d[1]], 0.26), pedido: false };
      it.malha.position.set(d[2], 0.35, d[3]); mp.itens.set(it.id, it);
    }
    for (const j of mp.jogadores.values()) { j.vivo = !!m.nasc[j.id]; if (m.nasc[j.id] && j.id !== mp.meuId) { j.pos.set(m.nasc[j.id][0], 0, m.nasc[j.id][2]); j.cur.copy(j.pos); } }
    const meu = m.nasc[mp.meuId], p = G.player, post = G.render.post || {};
    G.game = partida; solo.state = "multiplayer";
    try { G.fx.clear(); G.combat.reset(); G.weapon.reset(); } catch {}
    p.reset(meu ? { pos: new V3(meu[0], meu[1], meu[2]), yaw: meu[3] } : G.level.playerStart);
    p.enabled = false; p.invulnerable = false;
    post.fade = 0; post.saturation = satOriginal; post.flash = 0;
    G.hud.reset(); G.hud.show(true); G.weapon.setVisible(false);
    G.input.setGameplay(true); try { G.input.requestLock(); } catch {}
    try { G.audio.resume(); G.audio.setPaused(false); G.audio.setIntensity(0.6); } catch {}
    G.events.emit("game:state", { state: "playing", prev: "title" });
    if (rotuloHud) rotuloHud.textContent = "Reféns";
    cenario.visible = true; explosivos.visible = true; armasGrupo.visible = true;
    G.hud.warn("Rodada " + m.n, CFG.tempoPreparo);
    const t = eu() && TIMES[eu().time];
    if (t && meu) G.hud.radio("Você está com os " + t.nome + ". " + t.objetivo + ".", CFG.tempoPreparo + 1);
    else G.hud.message("Você entra na próxima rodada", 6);
    if (meu) G.hud.message("Pegue uma arma no chão · G solta · R recarrega", CFG.tempoPreparo + 5);
    if (!meu) p.alive = false;
    placarEl.hidden = false;
  }
  function sairDaPartida() {
    if (G.game === partida) { G.game = solo; solo.state = "title"; }
    mp.fase = "lobby";
    try {
      G.enemies.clear(); mp.marionetes.clear();
      G.hud.setPrompt(null); G.hud.show(false); G.weapon.setVisible(false);
      G.player.enabled = false; G.input.setGameplay(false); G.input.exitLock();
      (G.render.post || {}).saturation = satOriginal;
      G.audio.setIntensity(0.15);
    } catch {}
    if (rotuloHud) rotuloHud.textContent = "Relés";
    cenario.visible = false; explosivos.visible = false; bolsaEl.hidden = true; limparExplosivos(); limparArmas();
    try { G.weapon.name = nomeArmaOriginal; } catch {}
    for (const j of mp.jogadores.values()) if (j.boneco) j.boneco.grupo.visible = false;
    for (const r of mp.refens) r.boneco.grupo.visible = false;
    placarEl.hidden = true;
  }
  // objetivo, contador e marcadores do HUD; refaz só quando a situação dos reféns muda
  function atualizarObjetivo() {
    const t = eu() && eu().time, sig = t + mp.refens.map(r => r.estado).join("");
    if (sig === mp.assinatura) return;
    mp.assinatura = sig;
    G.hud.setObjective(t ? TIMES[t].objetivo : "Aguarde a próxima rodada");
    G.hud.setRelays(mp.refens.filter(r => r.estado === 2).length, mp.refens.length);
    const marcas = mp.refens.filter(r => r.estado < 2).map(r => ({ id: "refem" + r.i, short: "R" + (r.i + 1), label: "Refém", pos: r.cur, kind: "relay" }));
    if (mp.resgateVisto) marcas.push({ id: "resgate", short: "EX", label: "Resgate", pos: mp.resgateVisto, kind: "extract" });
    G.hud.setMarkers(marcas);
  }

  /* ------------------------------------------------------------------ bonecos */
  function criarAlvo(j) {      // o que as máquinas do anfitrião enxergam no lugar de um jogador remoto
    return { pos: j.cur, eye: new V3(), vel: new V3(), forward: new V3(0, 0, -1), yaw: 0, pitch: 0, alive: false, crouching: false,
      speed: 0, health: 100, maxHealth: 100, onGround: true, enabled: true,
      damage(q, de) { if (mp.fase === "valendo" && j.vivo) paraUm(j.id, { t: "dano", q, de: de ? arr(de) : null, por: null }); },
      heal() {}, addShake() {}, addRecoil() {} };
  }
  function criarBoneco({ nome, cor, css, armado, civil }) {
    const T = G.THREE, grupo = new T.Group(), corpo = new T.Group();
    const escuro = new T.MeshStandardMaterial({ color: armado ? 0x23282c : 0x6b7075, roughness: 0.85, metalness: 0.1 });
    const mcor = new T.MeshStandardMaterial({ color: cor, roughness: 0.7, metalness: 0.05, emissive: cor, emissiveIntensity: 0.35 });
    const pele = new T.MeshStandardMaterial({ color: 0x8d7b6a, roughness: 0.9 });
    const peca = (pai, geo, mat, x, y, z) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; pai.add(m); return m; };
    peca(corpo, new T.BoxGeometry(0.17, 0.82, 0.2), escuro, -0.11, 0.41, 0);
    peca(corpo, new T.BoxGeometry(0.17, 0.82, 0.2), escuro, 0.11, 0.41, 0);
    peca(corpo, new T.BoxGeometry(0.46, 0.6, 0.26), escuro, 0, 1.12, 0);
    peca(corpo, new T.BoxGeometry(0.48, 0.3, 0.28), mcor, 0, 1.2, 0);          // colete na cor do time
    peca(corpo, new T.SphereGeometry(0.13, 12, 10), pele, 0, 1.58, 0);
    const bracos = new T.Group(); bracos.position.set(0, 1.32, 0); corpo.add(bracos);
    if (armado) {
      peca(corpo, new T.BoxGeometry(0.28, 0.1, 0.28), mcor, 0, 1.68, 0);       // capacete
      peca(bracos, new T.BoxGeometry(0.11, 0.11, 0.5), escuro, -0.2, -0.05, -0.25).rotation.y = -0.25;
      peca(bracos, new T.BoxGeometry(0.11, 0.11, 0.5), escuro, 0.2, -0.05, -0.25).rotation.y = 0.25;
      peca(bracos, new T.BoxGeometry(0.06, 0.12, 0.7), new T.MeshStandardMaterial({ color: 0x0e1012, roughness: 0.5, metalness: 0.6 }), 0.05, -0.02, -0.55);
    } else {                                                                    // refém: mãos amarradas à frente
      peca(bracos, new T.BoxGeometry(0.1, 0.5, 0.1), escuro, -0.24, -0.25, -0.06);
      peca(bracos, new T.BoxGeometry(0.1, 0.5, 0.1), escuro, 0.24, -0.25, -0.06);
      const cabelo = new T.MeshStandardMaterial({ color: civil.cabelo, roughness: 0.95 });
      peca(corpo, new T.BoxGeometry(0.3, 0.1, 0.3), cabelo, 0, 1.69, 0);
      if (civil.cabeloLongo) peca(corpo, new T.BoxGeometry(0.3, 0.42, 0.1), cabelo, 0, 1.5, 0.13);
      grupo.scale.setScalar(civil.escala);
      var arma = peca(bracos, new T.BoxGeometry(0.06, 0.1, 0.34), new T.MeshStandardMaterial({ color: 0x0e1012, roughness: 0.5, metalness: 0.6 }), 0, -0.45, -0.22);
      arma.visible = false;
    }
    grupo.add(corpo);
    const placa = criarPlaca(nome, css); placa.position.y = 2.05; grupo.add(placa);
    if (civil) placa.scale.multiplyScalar(1 / civil.escala);
    grupo.visible = false;
    G.scene.add(grupo);
    return { grupo, corpo, bracos, placa, arma };
  }
  function criarPlaca(texto, css, grande) {
    const T = G.THREE, cv = document.createElement("canvas"); cv.width = 256; cv.height = 64;
    const c = cv.getContext("2d"); c.font = `600 ${grande ? 52 : 34}px "Barlow Condensed", Arial, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
    c.lineWidth = 6; c.strokeStyle = "rgba(0,0,0,.8)"; c.strokeText(texto, 128, 34); c.fillStyle = css; c.fillText(texto, 128, 34);
    const s = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cv), transparent: true, depthWrite: false }));
    s.scale.set(1.3, 0.33, 1);
    return s;
  }
  function removerBoneco(j) {
    if (!j.boneco) return;
    G.scene.remove(j.boneco.grupo);
    j.boneco.grupo.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    j.boneco = null;
  }
  function posar(b, cur, yaw, k, vivo, agachado) {
    b.grupo.position.copy(cur);
    let d = yaw - b.grupo.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
    b.grupo.rotation.y += d * k;
    b.corpo.scale.y += ((agachado && vivo ? 0.68 : 1) - b.corpo.scale.y) * k;
    b.corpo.rotation.x += ((vivo ? 0 : -Math.PI / 2) - b.corpo.rotation.x) * k;   // caído
    b.corpo.position.y += ((vivo ? 0 : 0.18) - b.corpo.position.y) * k;
  }
  function atualizarBonecos(dt) {
    const meuTime = eu() && eu().time, k = 1 - Math.exp(-14 * dt);
    for (const j of mp.jogadores.values()) {
      if (j.id === mp.meuId) continue;
      if (j.boneco && (j.boneco.time !== j.time || j.boneco.nome !== j.nome)) removerBoneco(j);
      if (!j.boneco) { j.boneco = criarBoneco({ nome: j.nome, cor: TIMES[j.time].cor, css: TIMES[j.time].css, armado: true }); j.boneco.time = j.time; j.boneco.nome = j.nome; }
      if (j.cur.distanceToSquared(j.pos) > 64) j.cur.copy(j.pos); else j.cur.lerp(j.pos, k);   // passagem secreta: aparece direto
      j.boneco.grupo.visible = j.pos.y > -40;
      posar(j.boneco, j.cur, j.yaw, k, j.vivo, j.agachado);
      j.boneco.bracos.rotation.x = j.vivo ? j.pitch : 0;
      j.boneco.placa.visible = j.vivo && j.time === meuTime;
      const a = j.alvo;
      if (a) {
        a.alive = j.vivo && mp.fase === "valendo"; a.crouching = j.agachado; a.yaw = j.yaw; a.pitch = j.pitch;
        a.eye.set(j.cur.x, j.cur.y + (j.agachado ? 1.05 : 1.62), j.cur.z);
        a.forward.set(-Math.sin(j.yaw), 0, -Math.cos(j.yaw));
      }
    }
    for (const r of mp.refens) {
      const antes = r.cur.clone();
      if (r.cur.distanceToSquared(r.pos) > 64) r.cur.copy(r.pos); else r.cur.lerp(r.pos, k);
      const dx = r.cur.x - antes.x, dz = r.cur.z - antes.z;
      if (dx * dx + dz * dz > 1e-6) r.yaw = Math.atan2(-dx, -dz);
      r.boneco.grupo.visible = r.estado !== 2;
      posar(r.boneco, r.cur, r.yaw || 0, k, r.estado !== 3, false);
      r.boneco.placa.visible = r.estado < 2;
      r.boneco.arma.visible = r.estado === 1;                 // solto pelo policial, já armado
    }
  }

  /* -------------------------------------------------------------------- tiros */
  // raio contra um cilindro em pé (jogador ou refém); devolve a distância ou -1
  function raioEmCilindro(o, dir, alcance, base, altura) {
    const r = 0.34, wx = o.x - base.x, wz = o.z - base.z, dh = dir.x * dir.x + dir.z * dir.z;
    let t = dh > 1e-6 ? -(wx * dir.x + wz * dir.z) / dh : 0;
    if (t < 0 || t > alcance) return -1;
    const lado = Math.hypot(o.x + dir.x * t - base.x, o.z + dir.z * t - base.z);
    if (lado > r) return -1;
    t -= Math.sqrt(r * r - lado * lado) / Math.max(0.2, Math.sqrt(dh));
    const y = o.y + dir.y * t;
    return t >= 0 && y >= base.y + 0.1 && y <= base.y + altura ? t : -1;
  }
  function raioEmPessoas(o, dir, alcance) {
    const meuTime = eu() && eu().time; let melhor = null;
    const testar = (base, altura, extra) => {
      const t = raioEmCilindro(o, dir, alcance, base, altura);
      if (t >= 0 && (!melhor || t < melhor.dist)) {
        const y = o.y + dir.y * t;
        melhor = { dist: t, cabeca: y > base.y + altura - 0.32, ponto: new V3(o.x + dir.x * t, y, o.z + dir.z * t), ...extra };
      }
    };
    for (const j of mp.jogadores.values()) if (j.id !== mp.meuId && j.vivo && j.time !== meuTime) testar(j.cur, j.agachado ? 1.15 : 1.7, { j });
    for (const r of mp.refens) if (r.estado < 2) testar(r.cur, 1.7 * r.civil.escala, { r });
    return melhor;
  }
  function instalarTiros() {
    const original = G.combat.playerShot;
    const umTiro = (o, dir, opt) => {
      const alcance = opt.range || 300, h = raioEmPessoas(o, dir, alcance);
      if (h) {
        const parede = G.physics.raycast(o, dir, alcance), maq = G.enemies.raycast(o, dir, parede ? parede.dist : alcance);
        if ((!parede || h.dist < parede.dist) && (!maq || h.dist < maq.dist)) {
          const q = (opt.damage || 28) * (h.cabeca ? CFG.danoCabeca : 1);
          G.combat.stats.shots++; G.combat.stats.hits++;
          if (h.j) enviar({ t: "acerto", em: h.j.id, q, de: arr(o) });
          else if (h.cabeca) enviar({ t: "acertoRefem", i: h.r.i });      // refém só se fere com tiro na cabeça
          if (h.j || h.cabeca) G.hud.hitmarker(h.cabeca ? "weak" : "hit");
          try { G.fx.sparks(h.ponto, dir.clone().negate(), 5); } catch {}
          tocar("impact_enemy", { pos: h.ponto });
          return { point: h.ponto, normal: dir.clone().negate(), dist: h.dist, surface: "enemy", enemy: null, dir, from: "player" };
        }
      }
      return original(o, dir, opt);
    };
    G.combat.playerShot = (o, dir, opt = {}) => {
      if (!emRodada()) return original(o, dir, opt);
      const a = ARMAS[mp.arma];
      if (!G.player.alive || mp.fase === "preparo" || !a || a.faca) return null;
      if (!a.chumbo) return umTiro(o, dir, opt);
      let primeiro = null;
      for (let k = 0; k < a.chumbo; k++) {            // a 12: vários bagos espalhados, só de perto
        const d = dir.clone(); d.x += (Math.random() - 0.5) * 0.11; d.y += (Math.random() - 0.5) * 0.08; d.z += (Math.random() - 0.5) * 0.11; d.normalize();
        const r = umTiro(o, d, { ...opt, damage: DANO_CHUMBO, range: a.alcance });
        if (k) try { G.fx.tracer(o.clone().addScaledVector(d, 0.6), r && r.point ? r.point : o.clone().addScaledVector(d, a.alcance)); } catch {}
        primeiro = primeiro || r;
      }
      return primeiro;
    };
    G.events.on("player:step", ev => {               // os outros ouvem seus passos, menos se você estiver de faca
      const a = ARMAS[mp.arma];
      if (!emRodada() || (a && a.faca) || mp.passoT > 0) return;
      mp.passoT = 0.25; enviar({ t: "passo", p: arr(G.player.pos) });
    });
    G.events.on("weapon:fire", ev => {
      const a = ARMAS[mp.arma];
      if (emRodada() && a && a.rpm) { mp.cadT = 60 / a.rpm - 0.01; if (mp.rajada > 0) mp.rajada--; }
      if (!emRodada() || !ev || !ev.dir) return;
      const o = ev.origin || G.player.eye, hit = G.physics.raycast(o, ev.dir, 300);
      const fim = hit ? hit.point : o.clone().addScaledVector(ev.dir, 90);
      enviar({ t: "tiro", o: arr(ev.muzzle || o), e: arr(fim) });
    });
    G.events.on("player:dead", () => {
      if (!emRodada()) return;
      const u = mp.ultimoDano, por = u && performance.now() - u.t < 4000 ? u.por : null;
      const j = eu(); if (j) j.vivo = false;
      soltarArma();
      G.hud.setPrompt(null);
      enviar({ t: "morri", por });
      G.hud.message("Você caiu — aguarde a próxima rodada", 8);
    });
  }
  function tiroRemoto(m) {
    if (!emRodada() || m.id === mp.meuId) return;
    const o = new V3().fromArray(m.o), e = new V3().fromArray(m.e);
    try { G.fx.tracer(o, e); } catch {}
    try { G.render.lightPool.flash(o, 16756832, 30, 8, 0.05); } catch {}
    tocar("rifle_shot", { pos: o });
  }

  /* ----------------------------------------------------------------- máquinas */
  function jogadoresVivos() {
    const l = [];
    for (const j of mp.jogadores.values()) if (j.vivo) l.push(j);
    return l;
  }
  function instalarMaquinas() {
    const dbg = G.enemies.debug;
    for (const e of [...dbg.gulls, ...dbg.hounds]) {
      const atualizar = e._update, dano = e.damage;
      let alvoT = 0, alvo = null;
      // anfitrião: cada máquina persegue o jogador vivo mais próximo, seja ele local ou remoto
      e._update = dt => {
        if (!(emRodada() && mp.anfitriao)) return atualizar(dt);
        alvoT -= dt;
        if (alvoT <= 0 || (alvo && !alvo.alive)) {
          alvoT = 0.5; alvo = null; let melhor = 1e9;
          for (const j of jogadoresVivos()) {
            const d = posDe(j).distanceToSquared(e.pos);
            if (d < melhor) { melhor = d; alvo = j.id === mp.meuId ? null : j.alvo; }
          }
        }
        const real = G.player;
        if (alvo) G.player = alvo;
        try { atualizar(dt); } finally { G.player = real; }
      };
      // convidado: a máquina é uma marionete; quem decide o dano é o anfitrião
      e.damage = (q, ponto, dir, parte) => {
        if (emRodada() && !mp.anfitriao && !mp.aplicandoMorte) {
          enviar({ t: "acertoMaquina", id: e._idRede, q, parte: parte || "body", d: dir ? arr(dir) : null });
          G.events.emit("enemy:hit", { enemy: e, point: ponto, part: parte || "body" });
          return false;
        }
        return dano(q, ponto, dir, parte);
      };
    }
    const disparar = dbg.ctx.fireBolt;
    dbg.ctx.fireBolt = (p, d, x) => {
      disparar(p, d, x);
      if (emRodada() && mp.anfitriao) paraTodos({ t: "raio", p: arr(p), d: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)] }, mp.meuId);
    };
    G.events.on("enemy:killed", ev => {
      if (emRodada() && mp.anfitriao && ev && ev.enemy) paraTodos({ t: "abateMaquina", id: ev.enemy.id }, mp.meuId);
    });
  }
  function soltarMaquina(tipo, alerta) {
    if (G.enemies.aliveCount() >= dif().max) return;
    const quer = tipo === "gull" ? "air" : "ground", vivos = jogadoresVivos();
    let pts = G.level.enemySpawns.filter(s => s.type === quer && vivos.every(j => Math.hypot(s.pos.x - posDe(j).x, s.pos.z - posDe(j).z) > 18));
    if (!pts.length) pts = G.level.enemySpawns.filter(s => s.type === quer);
    if (!pts.length) return;
    const s = pts[Math.floor(Math.random() * pts.length)];
    const perto = vivos.sort((a, b) => posDe(a).distanceToSquared(s.pos) - posDe(b).distanceToSquared(s.pos))[0];
    try { G.enemies.spawn(tipo, s.pos.clone(), alerta && perto ? { state: "alert", target: posDe(perto) } : { state: "patrol" }); } catch (e) { console.error("[mp] spawn", e); }
  }
  function soltarOnda() {
    for (const tipo of ["gull", "hound"]) for (let k = 0; k < dif().onda[tipo]; k++) soltarMaquina(tipo, true);
  }
  // convidado: recria e move as máquinas conforme o anfitrião informa
  function sincronizarMarionetes(lista) {
    if (mp.anfitriao) return;
    const vistos = new Set();
    for (const d of lista || []) {
      vistos.add(d[0]);
      let e = mp.marionetes.get(d[0]);
      if (!e) {
        e = G.enemies.spawn(d[1] ? "hound" : "gull", new V3(d[2], d[3], d[4]), { passive: true, yaw: d[5], patrolRadius: 0, hover: d[1] ? undefined : d[3] });
        if (!e) continue;
        e._idRede = d[0]; e._meta = new V3(d[2], d[3], d[4]); e._yawMeta = d[5];
        mp.marionetes.set(d[0], e);
      }
      e._meta.set(d[2], d[3], d[4]); e._yawMeta = d[5];
    }
    for (const [id, e] of mp.marionetes) if (!vistos.has(id)) {
      if (e.alive) { try { G.enemies.debug.ctx.retire(e); } catch {} }
      mp.marionetes.delete(id);
    }
  }
  function moverMarionetes(dt) {
    const k = 1 - Math.exp(-10 * dt);
    for (const e of mp.marionetes.values()) {
      if (!e.alive) continue;
      e.pos.lerp(e._meta, k);
      if (e.home) e.home.copy(e._meta);
      if (e.vel) e.vel.set(0, 0, 0);
      if (typeof e.alt === "number") e.alt = e._meta.y;
      let d = e._yawMeta - e.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); e.yaw += d * k;
    }
  }

  /* ------------------------------------------------------ reféns e passagens */
  // anfitrião: terrorista vivo com a mira apontada para perto do refém (para ele desviar)
  function inimigoMirando(r) {
    for (const j of mp.jogadores.values()) {
      if (j.time !== "t" || !j.vivo) continue;
      const p = posDe(j), dx = r.pos.x - p.x, dz = r.pos.z - p.z, d = Math.hypot(dx, dz);
      if (d > 40 || d < 0.5) continue;
      const yaw = j.id === mp.meuId ? G.player.yaw : j.yaw;
      if ((dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / d > 0.985) return [-dz / d, dx / d];   // direção de lado
    }
    return null;
  }
  // anfitrião: refém solto atira no Terrorista mais próximo que estiver à vista; nunca em Policial
  function atirarRefem(r, dt, ia) {
    r.tiroT -= dt;
    if (r.tiroT > 0) return;
    r.tiroT = ia.cadencia * (0.7 + Math.random() * 0.6);
    const olho = new V3(r.pos.x, r.pos.y + 1.45 * r.civil.escala, r.pos.z); let alvo = null, dist = 30;
    for (const j of mp.jogadores.values()) {
      if (j.time !== "t" || !j.vivo) continue;
      const p = posDe(j), d = p.distanceTo(r.pos);
      if (d >= dist) continue;
      const peito = new V3(p.x, p.y + 1.3, p.z); let visto = false;
      try { visto = G.physics.lineOfSight(olho, peito); } catch {}
      if (visto) { dist = d; alvo = { j, peito }; }
    }
    if (!alvo) return;
    const acertou = Math.random() < ia.precisao * (dist < 10 ? 1.4 : dist > 20 ? 0.6 : 1), fim = alvo.peito.clone();
    if (!acertou) fim.add(new V3((Math.random() - 0.5) * 2.4, (Math.random() - 0.2) * 1.6, (Math.random() - 0.5) * 2.4));
    paraTodos({ t: "tiro", id: "refem", o: arr(olho), e: arr(fim) });
    if (acertou) paraUm(alvo.j.id, { t: "dano", q: ia.dano, de: arr(r.pos), por: "refem" });
  }
  // anfitrião: reféns não ficam parados; o solto segue quem o soltou, desvia de quem mira nele e atira
  function moverRefens(dt) {
    const nav = G.physics.nav, ia = dif().refem;
    for (const r of mp.refens) {
      if (r.estado > 1) continue;
      let wx = 0, wz = 0, ancora = r.casa, folga = 2;
      if (r.estado === 1) {
        const lider = mp.jogadores.get(r.lider);
        if (!lider || !lider.vivo) { r.estado = 0; r.lider = null; r.casa.copy(r.pos); paraTodos({ t: "refem", i: r.i, ev: "largado" }); continue; }
        const lp = posDe(lider), dx = lp.x - r.pos.x, dz = lp.z - r.pos.z, d = Math.hypot(dx, dz);
        ancora = lp; folga = 2.6;
        if (d > 9) { r.pos.set(lp.x - dx / d * 1.2, lp.y, lp.z - dz / d * 1.2); r.caminho = null; }   // o líder usou uma passagem
        else if (d > 1.7) {
          let alvo = lp, livre = true;
          r.caminhoT -= dt;
          try { livre = nav.clearLine(r.pos, lp); } catch {}
          if (!livre) {
            if (r.caminhoT <= 0 || !r.caminho) { r.caminhoT = 0.5; try { r.caminho = nav.findPath(r.pos, lp); } catch { r.caminho = null; } }
            while (r.caminho && r.caminho.length > 1 && Math.hypot(r.caminho[0].x - r.pos.x, r.caminho[0].z - r.pos.z) < 0.6) r.caminho.shift();
            if (r.caminho && r.caminho.length) alvo = r.caminho[0];
          }
          const ax = alvo.x - r.pos.x, az = alvo.z - r.pos.z, ad = Math.hypot(ax, az) || 1;
          wx = ax / ad; wz = az / ad;
        }
      }
      // passinhos e pulos ao acaso, sem se afastar do lugar (ou de quem está seguindo)
      r.passoT -= dt;
      if (r.passoT <= 0) {
        r.passoT = 0.6 + Math.random() * 1.2;
        const a = Math.random() * 6.283; r.passo = Math.random() < 0.7 ? [Math.cos(a), Math.sin(a)] : [0, 0];
        if (r.noChao && Math.random() < 0.25) r.vel.y = 5;
      }
      if (!wx && !wz) {
        const ox = ancora.x - r.pos.x, oz = ancora.z - r.pos.z, od = Math.hypot(ox, oz);
        if (od > folga) { wx = ox / od * 0.6; wz = oz / od * 0.6; } else { wx = r.passo[0] * 0.45; wz = r.passo[1] * 0.45; }
      }
      // desvia para o lado (e às vezes pula) quando um Terrorista mira nele
      const lado = inimigoMirando(r);
      if (lado) {
        r.ladoT -= dt;
        if (r.ladoT <= 0) { r.ladoT = 0.5 + Math.random() * 0.6; r.lado = Math.random() < 0.5 ? 1 : -1; if (r.noChao && Math.random() < ia.esquiva * 0.5) r.vel.y = 5; }
        wx += lado[0] * r.lado * ia.esquiva; wz += lado[1] * r.lado * ia.esquiva;
      }
      const wl = Math.hypot(wx, wz), vel = CFG.velRefem * r.civil.vel;
      if (wl > 1) { wx /= wl; wz /= wl; }
      r.vel.x = wx * vel; r.vel.z = wz * vel; r.vel.y -= 20 * dt;
      let res = null; try { res = G.physics.moveCapsule(r.pos, r.vel, dt, 0.3, 1.7 * r.civil.escala, r.noChao); } catch {}
      r.noChao = !res || !!res.onGround;
      if (r.noChao && r.vel.y < 0) r.vel.y = 0;
      if (r.pos.y < -1) { r.pos.y = 0; r.vel.y = 0; }
      if (r.estado === 1) atirarRefem(r, dt, ia);
      if (r.estado === 1 && mp.resgate && Math.hypot(r.pos.x - mp.resgate.x, r.pos.z - mp.resgate.z) < RAIO_RESGATE) {
        r.estado = 2;
        paraTodos({ t: "refem", i: r.i, ev: "salvo", id: r.lider });
        r.lider = null;
        if (mp.refens.every(x => x.estado === 2)) fimDaRodada("p", "Todos os reféns foram resgatados");
        else soltarOnda();
      }
    }
  }
  // policial: segurar E perto de um refém preso para soltá-lo
  function interagir(dt) {
    const j = eu(), p = G.player;
    if (j && j.time === "p" && p.alive && mp.fase === "valendo")
      for (const b of mp.bombas.values()) {
        if (Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) > 2.2 || Math.abs(b.pos.y - p.pos.y) > 2.5) continue;
        mp.desarmarT = G.input.down("interact") ? mp.desarmarT + dt / CFG.tempoDesarmar : Math.max(0, mp.desarmarT - dt * 2);
        if (mp.desarmarT >= 1) { mp.desarmarT = 0; enviar({ t: "desarmei", id: b.id }); }
        return G.hud.setPrompt("Desarmar bomba · " + Math.ceil(b.t) + "s", Math.min(1, mp.desarmarT));
      }
    mp.desarmarT = 0;
    let perto = -1, dist = 2.2;
    if (j && j.time === "p" && p.alive && mp.fase === "valendo")
      for (const r of mp.refens) {
        if (r.estado !== 0) continue;
        const d = Math.hypot(r.cur.x - p.pos.x, r.cur.z - p.pos.z);
        if (d < dist && Math.abs(r.cur.y - p.pos.y) < 2.5) { dist = d; perto = r.i; }
      }
    if (perto < 0) { mp.pegando = -1; mp.pegarT = 0; return G.hud.setPrompt(null); }
    if (mp.pegando !== perto) { mp.pegando = perto; mp.pegarT = 0; }
    mp.pegarT = G.input.down("interact") ? mp.pegarT + dt / CFG.tempoPegar : Math.max(0, mp.pegarT - dt * 2);
    if (mp.pegarT >= 1) { mp.pegarT = 0; enviar({ t: "pegar", i: perto }); }
    G.hud.setPrompt("Soltar refém", Math.min(1, mp.pegarT));
  }
  // saídas secretas do galpão: pisou no círculo, aparece sempre no mesmo destino
  function passagens(dt) {
    const p = G.player;
    mp.passagemT -= dt;
    if (mp.passagemT > 0 || !p.alive || mp.fase !== "valendo") return;
    PASSAGENS.forEach((s, n) => {
      if (Math.hypot(p.pos.x - s.de[0], p.pos.z - s.de[1]) > 0.9 || p.pos.y > 1.5) return;
      p.pos.set(s.para[0], 0.05, s.para[1]); p.vel.set(0, 0, 0);
      mp.passagemT = 2;
      (G.render.post || {}).flash = 0.6;
      tocar("objective"); G.hud.message("Saída " + (n + 1), 2);
    });
  }
  function montarCenario() {
    const T = G.THREE; cenario = new T.Group(); cenario.visible = false;
    const disco = (x, z, raio, cor, op, pai = cenario) => {
      const m = new T.Mesh(new T.CylinderGeometry(raio, raio, 0.04, 28, 1, true), new T.MeshBasicMaterial({ color: cor, transparent: true, opacity: op, side: T.DoubleSide, depthWrite: false }));
      m.scale.y = 12; m.position.set(x, 0.25, z); pai.add(m);
      const chao = new T.Mesh(new T.CylinderGeometry(raio, raio, 0.02, 28), new T.MeshBasicMaterial({ color: cor, transparent: true, opacity: op * 0.5, depthWrite: false }));
      chao.position.set(x, 0.03, z); pai.add(chao);
    };
    PASSAGENS.forEach((s, n) => {
      disco(s.de[0], s.de[1], 0.8, 0xffb347, 0.5);
      disco(s.para[0], s.para[1], 0.8, 0xffb347, 0.18);
      for (const [pt, op] of [[s.de, 1], [s.para, 0.6]]) {
        const pl = criarPlaca(String(n + 1), "#ffb347", true); pl.material.opacity = op;
        pl.position.set(pt[0], 1.5, pt[1]); pl.scale.set(1.6, 0.4, 1); cenario.add(pl);
      }
    });
    discoResgate = new T.Group(); discoResgate.visible = false; cenario.add(discoResgate);
    disco(0, 0, RAIO_RESGATE, 0x4aa3ff, 0.3, discoResgate);
    G.scene.add(cenario);
    explosivos = new T.Group(); explosivos.visible = false; G.scene.add(explosivos);
    armasGrupo = new T.Group(); armasGrupo.visible = false; G.scene.add(armasGrupo);
    nomeArmaOriginal = G.weapon.name;
    mp.refens = REFENS.map((_, i) => ({ i, pos: new V3(), cur: new V3(), vel: new V3(), estado: 0, lider: null, hp: 1, yaw: Math.PI / 2, casa: new V3(REFENS[i][0], 0, REFENS[i][1]),
      civil: CIVIS[i % CIVIS.length], boneco: criarBoneco({ nome: "Refém", cor: CIVIS[i % CIVIS.length].cor, css: "#e8e4da", armado: false, civil: CIVIS[i % CIVIS.length] }) }));
    zerarRefens();
  }

  /* --------------------------------------------------------------- explosivos */
  const NOMES_ITEM = { granada: "Granada", bomba: "Bomba", relogio: "Bomba-relógio" };
  const CORES_ITEM = { granada: 0x7bd88f, bomba: 0xff5a40, relogio: 0xffb347 };
  let explosivos = null, bolsaEl = null;
  function caixa(cor, tam) {
    const T = G.THREE, m = new T.Mesh(new T.BoxGeometry(tam, tam, tam), new T.MeshBasicMaterial({ color: cor }));
    explosivos.add(m); return m;
  }
  function limparExplosivos() {
    while (explosivos.children.length) { const m = explosivos.children[0]; explosivos.remove(m); m.geometry.dispose(); m.material.dispose(); }
    mp.itens.clear(); mp.bombas.clear(); mp.granadas.length = 0;
    mp.bolsa = { granada: 0, bomba: 0, relogio: 0 }; mp.desarmarT = 0;
  }
  function ferirRefem(r, golpes, porId) {       // anfitrião; cada golpe vale um tiro na cabeça
    if (mp.fase !== "valendo" || r.estado > 1 || golpes <= 0) return;
    r.hp -= golpes;
    if (r.hp > 0) return;
    const quem = mp.jogadores.get(porId);
    r.estado = 3; r.lider = null;
    paraTodos({ t: "refem", i: r.i, ev: "morto", id: porId });
    fimDaRodada(quem && quem.time === "p" ? "t" : "p", (quem ? quem.nome : "Alguém") + " matou um refém");
  }
  function sortearItens() {                     // anfitrião: pontos aleatórios, longe da base dos Policiais
    const itens = []; let id = 1;
    for (const [tipo, n] of Object.entries(CFG.itens)) for (let k = 0; k < n; k++) {
      let p = new V3();
      for (let tent = 0; tent < 20; tent++) {
        try { p = G.physics.nav.randomPoint(new V3(0, 0, 0), 34); } catch {}
        if (Math.hypot(p.x - BASE_POLICIA[0], p.z - BASE_POLICIA[1]) > 14) break;
      }
      itens.push([id++, tipo, +p.x.toFixed(1), +p.z.toFixed(1)]);
    }
    return itens;
  }
  function explodir(pos, cfg, por) {            // anfitrião: avisa todos e fere máquinas e reféns
    paraTodos({ t: "explosao", p: arr(pos), raio: cfg.raio, dano: cfg.dano, por });
    for (const e of G.enemies.list) {
      const d = e.pos.distanceTo(pos);
      if (e.alive && d < cfg.raio) try { e.damage(cfg.dano * (1 - d / cfg.raio), e.pos.clone(), e.pos.clone().sub(pos).normalize(), "body"); } catch {}
    }
    for (const r of mp.refens) {
      const d = r.pos.distanceTo(pos);
      if (d < cfg.raio) ferirRefem(r, Math.round(cfg.dano * (1 - d / cfg.raio) / 50), por);   // explosão perto também fere
    }
  }
  function explosivosDoAnfitriao(dt) {
    for (const b of [...mp.bombas.values()]) if (b.t <= 0) {
      paraTodos({ t: "bombaFora", id: b.id, ev: "explodiu" });
      explodir(b.pos, CFG[b.tipo], b.por);
    }
  }
  // todos: granadas voando, bombas piscando, terrorista pegando itens do chão
  function explosivosLocais(dt) {
    const p = G.player, j = eu(), tempo = G.time.t;
    for (let i = mp.granadas.length - 1; i >= 0; i--) {
      const g = mp.granadas[i];
      g.vel.y -= 18 * dt;
      const passo = g.vel.length() * dt, dir = g.vel.clone().normalize();
      let bateu = null; try { bateu = passo > 1e-4 ? G.physics.raycast(g.pos, dir, passo + 0.08) : null; } catch {}
      if (bateu && bateu.normal) { g.pos.copy(bateu.point).addScaledVector(bateu.normal, 0.08); g.vel.reflect(bateu.normal).multiplyScalar(0.42); }
      else g.pos.addScaledVector(dir, passo);
      g.malha.position.copy(g.pos); g.malha.rotation.x += dt * 9;
      g.t -= dt;
      if (g.t <= 0) { explosivos.remove(g.malha); mp.granadas.splice(i, 1); if (mp.anfitriao) explodir(g.pos, CFG.granada, g.por); }
    }
    for (const b of mp.bombas.values()) {
      b.t -= dt; b.bipe -= dt;
      b.malha.scale.setScalar(1 + 0.25 * Math.max(0, Math.sin(tempo * (b.t < 6 ? 16 : 6))));
      if (b.bipe <= 0) { b.bipe = b.t < 6 ? 0.25 : 1; tocar("telegraph", { pos: b.pos, gain: 0.6 }); }
    }
    for (const it of mp.itens.values()) {
      it.malha.rotation.y = tempo * 1.5; it.malha.position.y = 0.35 + Math.sin(tempo * 2 + it.id) * 0.06;
      if (j && j.time === "t" && p.alive && mp.fase === "valendo" && !it.pedido && Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z) < 1.3 && p.pos.y < 2) {
        it.pedido = true; enviar({ t: "pegueiItem", id: it.id });
      }
    }
    const b = mp.bolsa, mostra = !!(j && j.time === "t" && p.alive);
    bolsaEl.hidden = !mostra;
    if (mostra) {
      const txt = `<span><kbd>Q</kbd> Granada <b>${b.granada}</b></span><span><kbd>B</kbd> Bomba <b>${b.bomba}</b></span>` +
        `<span><kbd>V</kbd> Relógio <b>${b.relogio}</b> · <kbd>T</kbd> ${CFG.relogio.tempos[mp.tempoIdx]}s</span>`;
      if (txt !== bolsaEl._txt) { bolsaEl._txt = txt; bolsaEl.innerHTML = txt; }
    }
  }
  window.addEventListener("keydown", ev => {
    const p = G && G.player, j = eu();
    if (!emRodada() || mp.fase !== "valendo" || !j || j.time !== "t" || !p.alive || ev.repeat) return;
    if (ev.code === "KeyT") mp.tempoIdx = (mp.tempoIdx + 1) % CFG.relogio.tempos.length;
    else if (ev.code === "KeyQ" && mp.bolsa.granada > 0) {
      mp.bolsa.granada--;
      const v = p.forward.clone().multiplyScalar(CFG.granada.forca); v.y += 3;
      enviar({ t: "granada", o: arr(p.eye.clone().addScaledVector(p.forward, 0.5)), v: arr(v) });
    } else if ((ev.code === "KeyB" && mp.bolsa.bomba > 0) || (ev.code === "KeyV" && mp.bolsa.relogio > 0)) {
      const tipo = ev.code === "KeyB" ? "bomba" : "relogio";
      mp.bolsa[tipo]--;
      enviar({ t: "plantar", tipo, p: arr(p.pos), tempo: CFG.relogio.tempos[mp.tempoIdx] });
    }
  });

  /* -------------------------------------------------------------------- armas */
  let armasGrupo = null, nomeArmaOriginal = "";
  function sortearArmas(nasc) {                 // anfitrião: um conjunto completo em volta de onde cada jogador nasce
    const lista = [];
    for (const [id, pt] of Object.entries(nasc)) {
      const j = mp.jogadores.get(id); if (!j) continue;
      const chaves = Object.keys(ARMAS).filter(k => ARMAS[k].time === j.time);
      chaves.forEach((k, n) => {
        const ang = n / chaves.length * Math.PI * 2, q = pisavel(pt[0] + Math.cos(ang) * 2, pt[2] + Math.sin(ang) * 2);
        lista.push([mp.proxId++, k, +q[0].toFixed(2), +q[1].toFixed(2)]);
      });
    }
    return lista;
  }
  function porArmaNoChao(d) {
    const T = G.THREE, a = ARMAS[d[1]], g = new T.Group(); if (!a) return;
    g.add(new T.Mesh(new T.BoxGeometry(a.faca ? 0.05 : 0.09, a.faca ? 0.05 : 0.14, a.faca ? 0.34 : 0.75), new T.MeshBasicMaterial({ color: TIMES[a.time].cor })));
    const pl = criarPlaca(a.nome, TIMES[a.time].css); pl.position.y = 0.4; pl.scale.set(1.4, 0.35, 1); g.add(pl);
    g.position.set(d[2], 0.35, d[3]); armasGrupo.add(g);
    mp.armasChao.set(d[0], { id: d[0], arma: d[1], pos: new V3(d[2], 0, d[3]), malha: g, pedido: false });
  }
  function tirarArmaDoChao(id) {
    const it = mp.armasChao.get(id); if (!it) return;
    armasGrupo.remove(it.malha);
    it.malha.children[0].geometry.dispose(); it.malha.children[0].material.dispose();
    it.malha.children[1].material.map.dispose(); it.malha.children[1].material.dispose();
    mp.armasChao.delete(id);
  }
  function limparArmas() {
    for (const id of [...mp.armasChao.keys()]) tirarArmaDoChao(id);
    mp.arma = null; mp.rajada = 0; mp.cadT = 0; mp.armaVisivel = null; mp.gatilhoAntes = false;
  }
  function soltarArma() {
    if (!mp.arma || !emRodada()) return;
    const p = G.player;
    enviar({ t: "armaSolta", arma: mp.arma, p: [+(p.pos.x - Math.sin(p.yaw) * 0.9).toFixed(2), +(p.pos.z - Math.cos(p.yaw) * 0.9).toFixed(2)] });
    mp.arma = null; mp.rajada = 0; mp.semPegarT = 0.5; tocar("reload_magout");
  }
  function facada() {
    const p = G.player, meuTime = eu() && eu().time; let alvo = null, perto = FACA.alcance, costas = false;
    for (const j of mp.jogadores.values()) {
      if (j.id === mp.meuId || !j.vivo || j.time === meuTime) continue;
      const dx = j.cur.x - p.pos.x, dz = j.cur.z - p.pos.z, d = Math.hypot(dx, dz) || 0.01;
      if (d > perto || Math.abs(j.cur.y - p.pos.y) > 1.5 || (dx * p.forward.x + dz * p.forward.z) / d < 0.5) continue;
      perto = d; alvo = j;
      costas = (dx * -Math.sin(j.yaw) + dz * -Math.cos(j.yaw)) / d > 0.3;     // ele está olhando para longe de mim
    }
    if (alvo) {
      enviar({ t: "acerto", em: alvo.id, q: costas ? FACA.danoCostas : FACA.danoFrente, de: arr(p.pos) });
      G.hud.hitmarker(costas ? "kill" : "hit"); tocar("impact_enemy", { pos: alvo.cur, gain: 0.5 });
      return;
    }
    for (const e of G.enemies.list) if (e.alive && e.pos.distanceTo(p.eye) < 2.2) {
      try { e.damage(70, e.pos.clone(), p.forward.clone(), "body"); } catch {}
      G.hud.hitmarker("hit"); break;
    }
  }
  // todo quadro, antes da arma do jogo atualizar: decide se o gatilho passa, ajusta o pente e pega arma do chão
  function armasLocais(dt) {
    const w = G.weapon, p = G.player, a = ARMAS[mp.arma], vale = p.alive && mp.fase === "valendo", gatilho = !!G.input.fire;
    mp.cadT -= dt; mp.semPegarT -= dt; mp.passoT -= dt;
    let pode = false;
    if (a && !a.faca && vale && mp.cadT <= 0) {
      if (w.ammo === 0 || w.state === "reloading") mp.rajada = 0;
      if (a.modo === "auto") pode = gatilho;
      else if (a.modo === "semi") pode = gatilho && !mp.gatilhoAntes;                    // um tiro por clique
      else { if (gatilho && !mp.gatilhoAntes && mp.rajada <= 0) mp.rajada = a.rajada; pode = mp.rajada > 0; }
    }
    if (a && a.faca && vale && gatilho && !mp.gatilhoAntes && mp.cadT <= 0) { mp.cadT = FACA.espera; facada(); }
    mp.gatilhoAntes = gatilho; G.input.fire = pode;
    if (a && !a.faca) { if (w.ammo > a.pente) w.ammo = a.pente; w.reserve = 150; }       // munição infinita: R sempre recarrega
    w.name = a ? a.nome : "Sem arma";
    const visivel = !!a && !a.faca && p.alive;
    if (visivel !== mp.armaVisivel) { mp.armaVisivel = visivel; w.setVisible(visivel); }
    if (!a && p.alive && mp.semPegarT <= 0 && mp.fase !== "fim")
      for (const it of mp.armasChao.values()) {
        const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
        if (it.espera) { if (d > 1.8) it.espera = false; continue; }
        if (!it.pedido && d < 1.1 && p.pos.y < 2) { it.pedido = true; mp.semPegarT = 0.4; enviar({ t: "armaPeguei", id: it.id }); break; }
      }
    for (const it of mp.armasChao.values()) it.malha.children[0].rotation.y += dt * 1.2;
  }
  window.addEventListener("keydown", ev => {
    if (ev.code === "KeyG" && !ev.repeat && emRodada() && G.player.alive && !(tela && !tela.hidden)) soltarArma();
  });

  /* --------------------------------------------------------- laço da partida */
  let placarEl = null;
  function desenharPlacar() {
    const vivos = t => { let n = 0; for (const j of mp.jogadores.values()) if (j.time === t && j.vivo) n++; return n; };
    const s = Math.max(0, Math.ceil(mp.tempo)), relogio = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    placarEl.innerHTML = `<span style="color:${TIMES.p.css}">${TIMES.p.curto} <b>${mp.placar.p}</b> <i>${vivos("p")} vivos</i></span>` +
      `<span class="mp-relogio">${mp.fase === "preparo" ? "Preparar" : mp.fase === "fim" ? "Fim" : relogio}</span>` +
      `<span style="color:${TIMES.t.css}"><b>${mp.placar.t}</b> ${TIMES.t.curto} <i>${vivos("t")} vivos</i></span>`;
  }
  // substitui G.game durante a partida; o laço principal do jogo chama update() a cada quadro
  const partida = {
    state: "playing", menus: null, run: {}, flow: {},
    start() {}, pause() {}, resume() {},
    update(dt) {
      const p = G.player, j = eu(), post = G.render.post || {};
      post.fade = 0;
      if (post.flash > 0) post.flash = Math.max(0, post.flash - dt * 2);
      if (!p.alive) post.saturation = Math.max(0.15, (post.saturation ?? 1) - dt * 0.6);
      if (mp.fase === "preparo") {
        mp.preparoT -= dt;
        if (mp.preparoT <= 0) { mp.fase = "valendo"; p.enabled = p.alive; G.hud.warn("Valendo", 1.6); tocar("objective"); }
      }
      if (mp.fase === "valendo" && !mp.anfitriao) mp.tempo -= dt;
      if (j) { j.vivo = p.alive && j.vivo; j.pos.copy(p.pos); j.cur.copy(p.pos); j.yaw = p.yaw; j.pitch = p.pitch; j.agachado = p.crouching; }
      armasLocais(dt); interagir(dt); passagens(dt); explosivosLocais(dt);
      if (mp.anfitriao) logicaDoAnfitriao(dt); else moverMarionetes(dt);
      atualizarBonecos(dt); atualizarObjetivo();
      mp.envioT -= dt;
      if (mp.envioT <= 0) {
        mp.envioT = 1 / 15;
        if (j) enviar({ t: "estado", p: arr(p.pos), y: +p.yaw.toFixed(3), x: +p.pitch.toFixed(3), c: p.crouching ? 1 : 0, v: j.vivo ? 1 : 0 });
        if (mp.anfitriao) paraTodos({ t: "estados", tempo: +mp.tempo.toFixed(1),
          j: [...mp.jogadores.values()].map(x => [x.id, ...arr(x.pos), +x.yaw.toFixed(3), +x.pitch.toFixed(3), x.agachado ? 1 : 0, x.vivo ? 1 : 0]),
          r: mp.refens.map(r => [...arr(r.pos), r.estado, r.lider]),
          m: G.enemies.list.filter(e => e.alive).map(e => [e.id, e.type === "hound" ? 1 : 0, ...arr(e.pos), +(e.yaw || 0).toFixed(2)]) }, mp.meuId);
      }
      mp.placarT -= dt;
      if (mp.placarT <= 0) { mp.placarT = 0.25; desenharPlacar(); }
      return true;
    },
  };

  /* ---------------------------------------------------------------------- som */
  // Com SALTLINE_MUDO = true no index.html o jogo abre sempre no mudo. A tecla M liga e desliga o som, no solo e no multiplayer;
  // o volume também pode ser ajustado em Ajustes.
  window.addEventListener("keydown", ev => {
    if (ev.code !== "KeyM" || ev.repeat || !G || (ev.target && ev.target.tagName === "INPUT")) return;
    const cfg = solo.menus.settings; cfg.volume = cfg.volume > 0 ? 0 : 0.8;
    try { G.audio.resume(); G.audio.setVolume(cfg.volume); G.hud.message(cfg.volume ? "Som ligado" : "Som desligado", 1.5); } catch {}
  });

  /* ------------------------------------------------------------------- início */
  function iniciar() {
    G = window.__G; V3 = G.THREE.Vector3; solo = G.game; partida.menus = solo.menus;
    satOriginal = typeof (G.render.post || {}).saturation === "number" ? G.render.post.saturation : 1;
    rotuloHud = document.querySelector(".h-relays span");
    instalarTiros(); instalarMaquinas(); montarCenario();
    placarEl = document.createElement("div"); placarEl.className = "mp-placar"; placarEl.hidden = true;
    document.getElementById("app").appendChild(placarEl);
    bolsaEl = document.createElement("div"); bolsaEl.className = "mp-bolsa"; bolsaEl.hidden = true;
    document.getElementById("app").appendChild(bolsaEl);
    const acoes = document.querySelector(".m-title .m-actions");      // botão na tela de título
    if (acoes) { const b = document.createElement("button"); b.className = "btn"; b.dataset.mp = "criar"; b.textContent = "Criar sala"; acoes.appendChild(b); }
    const codigo = new URLSearchParams(location.search).get("sala");
    if (codigo && /^[a-z0-9]{6,20}$/.test(codigo)) {
      let era = null; try { era = sessionStorage.getItem("saltline.anfitriao"); } catch {}
      if (era === codigo) pedirPerfil().then(nome => abrirComoAnfitriao(codigo, nome));   // o anfitrião recarregou a página
      else entrarNaSala(codigo);
    }
    window.__mp = mp;
  }
  const espera = setInterval(() => {
    if (window.__fatal) return clearInterval(espera);
    if (window.__ready && window.__G && window.__G.game && window.__G.game.menus) { clearInterval(espera); try { iniciar(); } catch (e) { console.error("[mp] não iniciou", e); } }
  }, 200);
})();
