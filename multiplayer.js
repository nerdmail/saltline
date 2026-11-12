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
   reféns e passagens · explosivos · armas · modelos das armas · laço da partida · início. */
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
    danoCabeca: 2,             // multiplicador de tiro na cabeça (só para os bagos da 12)
    // tiro de arma em jogador: no tronco tira 35; em perna ou pé, de 25 a 30; na cabeça mata. O colete some segurando o primeiro
    // tiro no tronco e o capacete some segurando o primeiro na cabeça; depois disso o dano conta normalmente.
    danoTronco: 35, danoMembro: [25, 30],
    // explosivos: qualquer jogador pega e usa; ficam espalhados pelo mapa, longe uns dos outros, em pontos sorteados a cada rodada
    // coletes e capacetes: o dobro do número de jogadores de cada um. O colete segura metade de um tiro no corpo e o capacete
    // transforma um tiro na cabeça (que mataria) em metade da vida; os dois se perdem ao segurar o tiro.
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
    // maq: dano = quanto do dano de drone e cão chega ao jogador; fraqueza = por quanto se multiplica o dano que eles levam
    facil:   { nome: "Fácil",       maq: { dano: 0.3, fraqueza: 2.4 }, tempo: 210, patrulha: { gull: 1, hound: 0 }, onda: { gull: 1, hound: 0 }, max: 3,
               refem: { tirosCabeca: 1, precisao: 0.12, cadencia: 1.6, dano: 8,  esquiva: 0.3 } },
    medio:   { nome: "Médio",       maq: { dano: 0.45, fraqueza: 1.7 }, tempo: 180, patrulha: { gull: 2, hound: 1 }, onda: { gull: 1, hound: 1 }, max: 5,
               refem: { tirosCabeca: 2, precisao: 0.2,  cadencia: 1.2, dano: 10, esquiva: 0.5 } },
    dificil: { nome: "Difícil",     maq: { dano: 0.75, fraqueza: 1.1 }, tempo: 150, patrulha: { gull: 3, hound: 2 }, onda: { gull: 2, hound: 1 }, max: 8,
               refem: { tirosCabeca: 3, precisao: 0.32, cadencia: 0.9, dano: 12, esquiva: 0.75 } },
    treta:   { nome: "Muita treta", maq: { dano: 1, fraqueza: 0.9 }, tempo: 120, patrulha: { gull: 4, hound: 3 }, onda: { gull: 3, hound: 2 }, max: 12,
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
  // a casinha no alto da escada do galpão é a sala dos reféns (chão a 2,6 m de altura). No jogo original ela ia só até
  // x1Antigo; aqui a parede leste é empurrada até x1, o que dobra o tamanho da sala.
  const SALA = { x0: -15.7, x1: -4.9, x1Antigo: -10.3, z0: -27.7, z1: -23.8, chao: 2.6, teto: 5.1, porta: [-11.65, -10.75], altoPorta: 4.45 };
  const POLICIAIS_NA_SALA = [[-11.1, -25.2], [-11.1, -26.6]];      // os dois primeiros Policiais já começam com os reféns
  const NASCER_TERRORISTAS = [[27.4, 11.6], [20.9, 14.7], [23.4, 23.2], [18, 24.4], [27.2, -12.6], [29, 14], [27, 8], [18, 22.2]];   // espalhados no lado leste (cais)
  // posições no mapa [x, z]. O galpão (sala dos reféns) vai de x -16 a 12 e de z -28 a -11.
  const REFENS = [[-8.4, -26.6], [-7.3, -27.0], [-6.3, -26.5]];        // no fundo da parte nova da sala, longe da porta de entrada e das portas secretas
  // Duto de ar: sai do teto da sala dos reféns e dá a volta por dentro do galpão, lá no alto. Dentro dele só se anda deitado.
  // zn/zs = trechos norte e sul, xe/xw = trechos leste e oeste; a boca norte fica na beira leste do teto da sala (x0)
  // e a boca oeste na beira sul (zb). Chão do duto em y, com alt de altura por dentro.
  const DUTO = { y: 5.1, alt: 1.3, zn: -24.28, zs: -14.2, xe: 3, xw: -13, x0: SALA.x1, zb: -23.8 };
  const ALCAPAO = [SALA.x1 - 0.8, -24.68, SALA.x1, -23.88];        // abertura no teto da sala, em cima da escada de mão
  // escadas de mão: eixo onde a pessoa fica (x, z), de y0 a y1, e para que lado ela olha ao subir (nx, nz).
  // d = distância do eixo até a escada; curta = não passa do topo (termina dentro do duto)
  const ESCADAS = [
    { x: SALA.x1 - 0.45, z: -24.28, y0: 2.6,  y1: 5.16, nx: 1,  nz: 0, d: 0.33 },               // da sala para o teto dela e a boca do duto
    { x: 3,      z: -24.28, y0: 5.1,  y1: 8.85, nx: 1,  nz: 0, d: 0.42 },               // do duto para o telhado (lado norte)
    { x: 0.15,   z: -14.2,  y0: 5.1,  y1: 8.85, nx: 0,  nz: 1, d: 0.42 },               // do duto para o telhado (lado sul)
    { x: 3,      z: -19.2,  y0: 0.03, y1: 5.16, nx: 1,  nz: 0, d: 0.42, curta: true },  // do duto para o chão do galpão (leste)
    { x: -13,    z: -16.5,  y0: 0.03, y1: 5.16, nx: -1, nz: 0, d: 0.42, curta: true },  // do duto para o chão do galpão (oeste)
    { x: -16.75, z: -19.5,  y0: 0,    y1: 9.7,  nx: 1,  nz: 0, d: 0.4 },                // do telhado para o chão, por fora (oeste)
    { x: 6.13,   z: -16.3,  y0: 0.03, y1: 9.45, nx: 1,  nz: 0, d: 0.33, curta: true },  // por dentro do galpão: do chão ao telhado, por uma das aberturas dele
    { x: 2,      z: -28.8,  y0: 0,    y1: 7.83, nx: 0,  nz: 1, d: 0.4 },                // do telhado para o chão, por fora (lado norte, junto ao alambrado; o leste tem um portão)
  ];
  // onde se anda deitado: [x de, z de, x até, z até, y de, y até] (as bocas e os buracos das escadas entram com folga)
  const DEITAR = [
    [SALA.x1 - 0.6, DUTO.zn - 0.5, 3.5, DUTO.zn + 0.5, 4.85, 6.6],
    [2.5, DUTO.zn + 0.5, 3.5, DUTO.zs - 0.5, 4.85, 6.6], [2.5, -19.7, 3.5, -18.7, 3.4, 6.6],
    [-13.5, DUTO.zs - 0.5, 3.5, DUTO.zs + 0.5, 4.85, 6.6],
    [-13.5, -24.4, -12.5, DUTO.zs - 0.5, 4.85, 6.6], [-13.5, -17, -12.5, -16, 3.4, 6.6],
  ];
  // carro: um por rodada, perto do meio do mapa. Cinco lugares [x, y, z] no espaço do carro (frente = -z, direita = +x):
  // motorista, passageiro e três em cima da carroceria. Anda só no chão, na velocidade de uma pessoa (anda ou corre).
  // Quem entra primeiro fica com ele para o seu time; o outro time só entra quando o carro estiver vazio.
  // DESLIGADO a pedido (ligado: false): o carro não aparece nas rodadas. Para voltar, troque para ligado: true.
  const CARRO = { ligado: false, lugares: [[-0.5, 0.72, -1.25], [0.5, 0.72, -1.25], [-0.6, 2.08, 0.6], [0, 2.08, 1.25], [0.6, 2.08, 0.6]], alcance: 3.4, anda: 3.8, corre: 7.6, re: 3, giro: 1.8, comprimento: 4.4 };
  // bots: o anfitrião completa cada time até porTime com jogadores controlados pelo computador. Eles só combatem
  // (não soltam nem levam refém) e ficam mais duros e mais certeiros conforme a dificuldade da sala.
  const BOTS = { porTime: 5, visao: 45, ouvePasso: 13, ouveTiro: 38, memoria: 6, vel: 3.6, nomes: ["Brasa", "Tigre", "Zulu", "Corvo", "Farol", "Lince", "Rato", "Vespa", "Trovão", "Jacaré", "Onça", "Cobra"],
    niveis: {
      // movel = quanto da mira sobra quando o alvo está correndo (nos níveis baixos o bot erra mais alvo em movimento)
      facil:   { vida: 66,  precisao: 0.19, cadencia: 1.0,  dano: 11, vel: 3.4, reflexo: 0.5,  movel: 0.55, giro: 2.6 },
      medio:   { vida: 120, precisao: 0.34, cadencia: 0.7,  dano: 16, vel: 4.0, reflexo: 0.33, movel: 0.65, giro: 3.4 },
      dificil: { vida: 150, precisao: 0.42, cadencia: 0.6,  dano: 17, vel: 4.5, reflexo: 0.25, movel: 0.8,  giro: 4.6 },
      treta:   { vida: 200, precisao: 0.58, cadencia: 0.42, dano: 21, vel: 5.2, reflexo: 0.15, movel: 0.9,  giro: 6.5 },
    } };
  const QUEDA = { altura: 2.2, folga: 1.2, porMetro: 0.11, dano: 0.5 };     // cair de mais que isso tira metade da vida (só de jogador; refém não se machuca)
  const MESA = [-13.9, -12.1, -26.68];                                  // mesa encostada na parede norte: x de, x até, z da frente
  // quem são os reféns, na ordem das posições acima: cor da roupa, cabelo, tamanho e ritmo de caminhada
  const CIVIS = [
    { quem: "mulher",  camisa: 0x8c2f4f, calca: 0x232b3a, cabelo: 0x2e1a10, pele: 0xc08a68, cabeloLongo: true, modelo: true, tom: 0xffffff, sapato: 0x3a2a22, escala: 0.95, vel: 1 },
    { quem: "criança", camisa: 0xc79a1e, calca: 0x2f4f7a, cabelo: 0x23160e, pele: 0xc69472, bermuda: true, mangaCurta: true, franja: true, modelo: true, tom: 0x8fb0ff, listra: 0xf2efe8, sapato: 0xd8d4c8, cabecaEscala: 1.16, senta: true, escala: 0.9, vel: 0.9 },
    { quem: "idoso",   camisa: 0x4d5a66, calca: 0x38332d, cabelo: 0xc9c9c9, pele: 0xb88768, curvado: true, bigode: true, careca: true, oculos: true, senta: true, modelo: true, tom: 0xffc890, escala: 0.92, vel: 0.75 },
  ];
  // pontos de resgate: um é sorteado a cada rodada e só os Policiais ficam sabendo qual
  // [x, z, nome que aparece no painel da sala dos reféns]. No mapa, norte é -z e oeste é -x.
  const SUL = { z0: 28, z1: 58, x0: -38, x1: 30 };      // pátio novo, ao sul do antigo: o mapa fica uns 50% mais comprido
  const RESGATES = [[-22, 50, "Pátio novo oeste"], [8, 53, "Pátio novo sul"], [-32, 6, "Portão oeste"], [-32, 20, "Portão sudoeste"], [-32, -8, "Portão noroeste"], [-26.6, -15, "Guarita noroeste"],
    [-16, 22, "Pátio sudoeste"], [-7.8, 21.4, "Pátio sul"], [6, 26, "Cerca sul"], [14.2, 16.4, "Pátio sudeste"], [-19, -1.4, "Entrada do pátio"], [-10.3, 12.5, "Centro do pátio"]];
  const RAIO_RESGATE = 4;
  const SECRETA = [-14.6, -26.7];      // alçapão em cima da casinha dos reféns: cada vez que alguém entra, sai num lugar sorteado do mapa
  const ALTO = 3.2;                    // quem está acima disso (em cima de dois containers, do galpão, do guindaste) os drones não pegam
  const PASSAGENS = [            // portas secretas nas paredes da sala: "de" é onde se para em frente à porta, "para" é onde ela sai
    { de: [-15.0, -25.0], parede: "oeste", para: [-16, 26],      nome: "Pátio sudoeste" },
    { de: [-15.0, -26.7], parede: "oeste", para: [14.2, 16.4],   nome: "Pátio sudeste" },
    { de: [-14.6, -27.0], parede: "norte", para: [27.2, -12.6],  nome: "Cais norte" },
    { de: [-11.4, -27.0], parede: "norte", para: [-26.6, -15],   nome: "Guarita noroeste" },
  ];
  // armas: cada jogador nasce sem arma, com o conjunto do seu time no chão ao redor. Só dá para carregar uma.
  // Todas tiram o mesmo dano por tiro; muda o pente e o modo (auto, semi, rajada). rpm = tiros por minuto (máx. 720).
  const ARMAS = {
    p_fuzil:    { nome: "Fuzil M4",     time: "p", pente: 30, modo: "auto", rpm: 720 },
    p_metra:    { nome: "MP5",          time: "p", pente: 50, modo: "auto", rpm: 720 },
    p_12:       { nome: "Escopeta 12",  time: "p", pente: 15, modo: "auto", rpm: 150, chumbo: 8, alcance: 20 },
    p_sniper:   { nome: "Sniper",       time: "p", pente: 1,  modo: "semi", rpm: 20, mira: 5, mata: true },     // um tiro a cada 3 s, zoom de 5x no botão direito; mata com um tiro
    p_reserva:  { nome: "Pistola",      time: "p", pente: 9,  modo: "auto", rpm: 360, reserva: true },             // só para quem está de faca ou de sniper; não fica no chão
    p_pistola:  { nome: "Pistola 9mm",  time: "p", pente: 15, modo: "auto", rpm: 420 },
    p_revolver: { nome: "Revólver .38", time: "p", pente: 15, modo: "auto", rpm: 300 },
    p_faca:     { nome: "Faca",         time: "p", faca: true },
    t_fuzil:    { nome: "AK-47",        time: "t", pente: 30, modo: "auto", rpm: 560 },
    t_metra:    { nome: "Uzi",          time: "t", pente: 50, modo: "auto", rpm: 720 },
    t_12:       { nome: "12 serrada",   time: "t", pente: 15, modo: "auto", rpm: 150, chumbo: 10, alcance: 15 },
    t_sniper:   { nome: "Sniper",       time: "t", pente: 1,  modo: "semi", rpm: 20, mira: 5, mata: true },
    t_reserva:  { nome: "Pistola",      time: "t", pente: 9,  modo: "auto", rpm: 360, reserva: true },
    t_pistola:  { nome: "Pistola .45",  time: "t", pente: 15, modo: "auto", rpm: 360 },
    t_pistola2: { nome: "Pistola auto", time: "t", pente: 30, modo: "auto", rpm: 600 },
    t_faca:     { nome: "Faca",         time: "t", faca: true },
  };
  // faca: silenciosa (ninguém ouve seus passos); pelas costas mata, pela frente só fere
  const FACA = { alcance: 1.9, danoFrente: 35, danoCostas: 500, espera: 0.6 };
  const DANO_CHUMBO = 13;      // cada bago da 12 (ela solta vários de uma vez, mas só alcança de perto)
  // roupas dos jogadores: farda, colete, faixa na cor do time (para reconhecer de longe) e o que vai na cabeça
  const ROUPAS = {
    p: { camisa: 0x24365a, calca: 0x1a2236, colete: 0x10151d, faixa: 0x4aa3ff, pele: 0xb98a6b, cabeca: "bone" },
    t: { camisa: 0x5a5a3c, calca: 0x47442f, colete: 0x3a2c1e, faixa: 0xff5a40, pele: 0xb98a6b, cabeca: "balaclava", estampa: "camuflagem" },
  };
  const CHAVE_PERFIL = "saltline.perfil.v1";
  const ESTADOS = ["preso", "seguindo", "salvo", "morto"];

  /* ------------------------------------------------------------------- estado */
  let G = null, V3 = null, solo = null, satOriginal = 1, cenario = null, rotuloHud = null, discoResgate = null, painel = null;
  const mp = {
    ativo: false, anfitriao: false, codigo: null, meuId: null, peer: null, conAnfitriao: null,
    cons: new Map(),          // anfitrião: id -> conexão
    jogadores: new Map(),     // id -> { id, nome, time, vivo, pos, cur, yaw, pitch, agachado, boneco, alvo }
    refens: [],               // { i, pos, cur, vel, estado, lider, hp, jaSolto, caminho, caminhoT, boneco }
    dificuldade: "medio",
    rodadasTotal: 5,           // quantas rodadas tem a partida (o anfitrião escolhe na sala de espera)
    resgate: null,            // anfitrião: ponto sorteado da rodada
    resgateVisto: null,       // Policiais: ponto revelado nesta rodada
    fase: "lobby",            // lobby | preparo | valendo | fim
    rodada: 0, placar: { p: 0, t: 0 }, tempo: 0, preparoT: 0, fimT: 0,
    pegando: -1, pegarT: 0, passagemT: 0, assinatura: "",
    itens: new Map(),         // explosivos no chão: id -> { id, tipo, pos, malha, pedido }
    bombas: new Map(),        // bombas armadas: id -> { id, tipo, pos, t, por, malha, bipe }
    granadas: [],             // granadas no ar: { pos, vel, t, por, malha }
    bolsa: { granada: 0, bomba: 0, relogio: 0 }, tempoIdx: 1, desarmarT: 0, proxId: 1,
    colete: false, capacete: false,     // proteção que eu estou usando
    carro: { pos: null, yaw: 0, vel: 0, oc: [null, null, null, null, null], alvo: null, alvoYaw: 0, malha: null, mixer: null },
    correr: false, ctrl: false, deitado: false, naEscada: null, quedaTopo: 0, picharT: 0, grades: null,
    arma: null,               // chave em ARMAS da arma na mão, ou null
    principal: null,          // a arma pega no chão (a faca e a pistola reserva não contam)
    municao: {}, prontaEm: {}, armaAntes: null,
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
    // o link da sala é sempre o mesmo para quem a cria: o código fica guardado neste navegador e é reaproveitado
    let codigo = null; try { codigo = localStorage.getItem("pebacity.sala"); } catch {}
    if (!codigo || !/^[a-z0-9]{6,20}$/.test(codigo)) codigo = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    try { localStorage.setItem("pebacity.sala", codigo); } catch {}
    try { sessionStorage.setItem("saltline.anfitriao", codigo); } catch {}
    history.replaceState(null, "", location.pathname + "?sala=" + codigo);
    await abrirComoAnfitriao(codigo, nome);
  }
  async function abrirComoAnfitriao(codigo, nome, tentativa = 0) {
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
        if ([...mp.jogadores.values()].filter(x => !x.bot).length >= CFG.maxJogadores) { con.send({ t: "recusa", motivo: "A sala já está com 10 jogadores, que é o máximo da partida." }); return setTimeout(() => con.close(), 500); }
        mp.cons.set(con.peer, con);
      });
      con.on("data", msg => { if (msg && typeof msg === "object") doJogador(con.peer, msg); });
      con.on("close", () => saiu(con.peer));
      con.on("error", () => saiu(con.peer));
    });
    peer.on("error", e => {
      if (e.type === "unavailable-id") {                  // logo depois de fechar a aba, o endereço ainda fica ocupado por alguns segundos: tenta de novo
        try { peer.destroy(); } catch {}
        if (tentativa < 8 && !mp.ativo) { aviso("Abrindo a sala… (a anterior ainda está fechando)"); setTimeout(() => abrirComoAnfitriao(codigo, nome, tentativa + 1), 2500); }
        else aviso("Esta sala já está aberta em outra aba ou aparelho.", true);
      }
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
        if (id !== mp.meuId) { j.pos.fromArray(m.p); j.yaw = m.y; j.pitch = m.x; j.agachado = m.c === 1; }
        j.noChao = m.c === 2;                      // deitado por conta própria (tecla Z)
        if (m.k && mp.carro.oc[0] === id && mp.carro.pos) { mp.carro.pos.set(m.k[0], 0, m.k[1]); mp.carro.yaw = m.k[2]; }      // quem dirige diz onde o carro está
        j.vivo = !!m.v; j.armadura = m.a | 0; j.mirando = !!m.s; if (id !== mp.meuId) j.arma = ARMAS[m.w] ? m.w : null;
        break;
      case "tiro":
        j.tiroEm = performance.now() / 1000;      // os bots ouvem
        paraTodos({ t: "tiro", id, o: m.o, e: m.e }, id);
        if (mp.ouvirT <= 0) { mp.ouvirT = 0.3; try { G.enemies.alert(new V3().fromArray(m.o), G.enemies.TUNE.hearRadius || 40); } catch {} }
        break;
      case "acerto": {
        const alvo = mp.jogadores.get(m.em);
        if (mp.fase === "valendo" && alvo && alvo.vivo && j.vivo && alvo.time !== j.time)
          if (alvo.bot) ferirBot(alvo, Math.min(600, +m.q || 0), id);
          else paraUm(alvo.id, { t: "dano", q: Math.min(600, +m.q || 0), de: m.de, por: id, c: m.c === 1 ? 1 : m.c === 0 ? 0 : m.c === 2 ? 2 : undefined });
        break;
      }
      case "acertoRefem":
        if (mp.refens[m.i] && mp.fase === "valendo") {
          const r = mp.refens[m.i];              // capacete segura o primeiro tiro na cabeça e some; colete, o primeiro tiro no corpo
          if (m.s) ferirRefem(r, Math.max(0.5, dif().refem.tirosCabeca / 2), id);        // sniper: dois tiros matam um refém com a vida cheia, em qualquer parte do corpo
          else if (m.c === 0) r.prot &= ~1; else if (r.prot & 2) r.prot &= ~2; else ferirRefem(r, 1, id);
        }
        break;
      case "porta":
        if (mp.fase === "valendo" && j.vivo) paraTodos({ t: "porta", aberta: !!m.aberta });
        break;
      case "armaPeguei":
        if (mp.armasChao.has(m.id) && j.vivo) paraTodos({ t: "armaPega", id: m.id, por: id });
        break;
      case "armaSolta":
        if (ARMAS[m.arma] && Array.isArray(m.p)) paraTodos({ t: "armaChao", d: [mp.proxId++, m.arma, +m.p[0], +m.p[1], +m.p[2] || 0], por: id });
        break;
      case "super":
        if (mp.resgate) paraUm(id, { t: "resgateSuper", p: [+mp.resgate.x.toFixed(1), +mp.resgate.z.toFixed(1)] });
        break;
      case "pichar":
        if (j.vivo && Array.isArray(m.p) && Array.isArray(m.n)) paraTodos({ t: "pichacao", p: m.p, n: m.n, time: j.time, d: m.d | 0, g: +m.g || 0 });
        break;
      case "passo":
        paraTodos({ t: "passo", p: m.p, id }, id);
        break;
      case "pegueiItem": {
        const it = mp.itens.get(m.id);
        if (mp.fase === "valendo" && it && j.vivo) paraTodos({ t: "item", id: m.id, por: id });
        break;
      }
      case "granada":
        if (mp.fase === "valendo" && j.vivo) paraTodos({ t: "granada", o: m.o, v: m.v, por: id });
        break;
      case "plantar": {
        if (mp.fase !== "valendo" || !j.vivo || (m.tipo !== "bomba" && m.tipo !== "relogio")) break;
        const tempo = m.tipo === "bomba" ? CFG.bomba.pavio : Math.max(5, Math.min(120, +m.tempo || 30));
        paraTodos({ t: "bomba", id: mp.proxId++, tipo: m.tipo, p: m.p, tempo, por: id });
        break;
      }
      case "desarmei": {
        const b = mp.bombas.get(m.id);
        if (mp.fase === "valendo" && b && j.vivo) paraTodos({ t: "bombaFora", id: m.id, ev: "desarmada", por: id });
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
        tirarDoCarro(id);
        break;
      case "carroQuer": {
        const c = mp.carro, lugar = c.oc.indexOf(id);
        if (!m.entrar) { tirarDoCarro(id); break; }
        if (mp.fase !== "valendo" || !j.vivo || lugar >= 0 || !c.pos || Math.hypot(posDe(j).x - c.pos.x, posDe(j).z - c.pos.z) > CARRO.alcance + 0.6) break;
        const dono = c.oc.map(o => mp.jogadores.get(o)).find(o => o);            // time de quem já está dentro
        const livre = c.oc.indexOf(null);
        if ((dono && dono.time !== j.time) || livre < 0) { paraUm(id, { t: "feed", html: dono && dono.time !== j.time ? "O carro está com o outro time" : "O carro está cheio" }); break; }
        c.oc[livre] = id; arrumarCarro();
        break;
      }
    }
  }
  function saiu(id) {
    mp.cons.delete(id);
    const j = mp.jogadores.get(id);
    if (!j) return;
    removerBoneco(j); mp.jogadores.delete(id); if (mp.anfitriao) tirarDoCarro(id);
    if (mp.ativo) { paraTodos({ t: "feed", html: `<b>${esc(j.nome)}</b> saiu da sala` }); mandarLobby(); }
  }
  function mandarLobby() {
    paraTodos({ t: "lobby", fase: mp.fase, placar: mp.placar, rodada: mp.rodada, dificuldade: mp.dificuldade, rodadas: mp.rodadasTotal,
      jogadores: [...mp.jogadores.values()].map(j => ({ id: j.id, nome: j.nome, time: j.time, bot: j.bot ? 1 : 0 })) });
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
          j.nome = d.nome; j.time = d.time; if (!mp.anfitriao) j.bot = !!d.bot;
        }
        for (const [id, j] of mp.jogadores) if (!vistos.has(id)) { removerBoneco(j); mp.jogadores.delete(id); }
        mp.placar = m.placar; mp.rodada = m.rodada; mp.dificuldade = m.dificuldade; if (m.rodadas) mp.rodadasTotal = m.rodadas;
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
          j.pos.set(d[1], d[2], d[3]); j.yaw = d[4]; j.pitch = d[5]; j.agachado = d[6] === 1; j.noChao = d[6] === 2; j.vivo = !!d[7]; j.armadura = d[8] | 0; j.arma = ARMAS[d[9]] ? d[9] : null;
        }
        m.r.forEach((d, i) => { const r = mp.refens[i]; if (r) { r.pos.set(d[0], d[1], d[2]); r.estado = d[3]; r.lider = d[4]; r.prot = d[5] | 0; r.post = d[6] | 0; } });
        sincronizarMarionetes(m.m);
        if (m.k && mp.carro.oc[0] !== mp.meuId) { mp.carro.alvo = new V3(m.k[0], 0, m.k[1]); mp.carro.alvoYaw = m.k[2]; }
        break;
      case "resgateSuper":                       // super poder: o ponto de resgate aparece no jogo (seta no céu, facho, marcador) como para os Policiais
        mp.resgateSuper = new V3(m.p[0], 0, m.p[1]); mp.assinatura = "";
        discoResgate.position.copy(mp.resgateSuper); discoResgate.visible = true;
        break;
      case "carro": mp.carro.oc = m.oc; break;
      case "tiro": tiroRemoto(m); break;
      case "resgate":
        mp.resgateVisto = new V3(m.p[0], 0, m.p[1]); mp.resgateNome = m.nome; mp.assinatura = "";
        discoResgate.position.copy(mp.resgateVisto); discoResgate.visible = true;
        desenharPainel(m.p, m.nome);
        break;
      case "dano":
        if (emRodada() && G.player.alive) {
          mp.ultimoDano = { por: m.por, t: performance.now() };
          let q = m.q;
          if (m.c === 1) {                       // tiro na cabeça: mata, a não ser que o capacete segure (ele some e o tiro não tira vida)
            if (mp.capacete) { mp.capacete = false; q = 0; G.hud.message("O capacete segurou o tiro · você perdeu o capacete", 3); if (mp.reservaCapacete > 0) { mp.reservaCapacete--; mp.capacete = true; } }
            else q = 999;
          } else if (m.c === 0 && mp.colete) { mp.colete = false; q = 0; G.hud.message("O colete segurou o tiro · você perdeu o colete", 3); if (mp.reservaColete > 0) { mp.reservaColete--; mp.colete = true; } }      // tronco: o colete some segurando o tiro
          if (q > 0) { mp.danoMeu = true; try { G.player.damage(q, m.de ? new V3().fromArray(m.de) : null); } finally { mp.danoMeu = false; } }
        }
        break;
      case "baixa": {
        const v = mp.jogadores.get(m.quem), k = m.por && mp.jogadores.get(m.por);
        if (v && v.id !== mp.meuId) v.vivo = false;
        if (v) v.mortes = (v.mortes | 0) + 1;
        if (k && k !== v) { k.abates = (k.abates | 0) + 1; k.abatesRodada = (k.abatesRodada | 0) + 1; }
        if (v) {                                  // quem matou quem, grande, com a cor de cada time
          const nome = x => `<b style="color:${TIMES[x.time] ? TIMES[x.time].css : "#e8e4da"}">${esc(x.nome)}</b>`;
          if (k && k !== v && k.id === mp.meuId) {            // destaque para quem matou, no meio da tela
            const n = k.abatesRodada | 0;
            G.hud.warn("Você matou " + v.nome + (n > 1 ? " · " + n + " na rodada" : ""), 2.6); tocar("objective");
          } else if (v.id === mp.meuId && k && k !== v) G.hud.warn("Você foi morto por " + k.nome, 4);
          avisarBaixa(k && k !== v ? `${nome(k)} <i>matou</i> ${nome(v)}` : m.por === "refem" ? `${nome(v)} <i>foi abatido por um refém</i>` : m.por === "queda" ? `${nome(v)} <i>morreu na queda</i>` : `${nome(v)} <i>caiu para as máquinas</i>`,
            v.id === mp.meuId || (k && k.id === mp.meuId));
        }
        break;
      }
      case "feed": G.hud.feed(m.html); break;
      case "refem": {
        const r = mp.refens[m.i], quem = mp.jogadores.get(m.id), nome = quem ? esc(quem.nome) : "Alguém";
        if (!r) break;
        if (m.ev === "solto") { r.estado = 1; r.lider = m.id; G.hud.feed(`<b>${nome}</b> soltou um refém`); if (eu() && eu().time === "t") G.hud.warn("Estão levando um refém", 3); tocar("alert"); }
        else if (m.ev === "salvo") {
          r.estado = 2; r.lider = null; r.salvoEm = performance.now(); G.hud.feed(`<b>${nome}</b> salvou um refém`); tocar("relay_cut");
          const salvos = mp.refens.filter(x => x.estado === 2 || x === r).length;
          G.hud.warn(m.id === mp.meuId ? (salvos >= mp.refens.length ? "Parabéns! Você salvou todos os reféns" : "Parabéns! Você salvou um refém · " + salvos + " de " + mp.refens.length) : "Refém a salvo · " + salvos + " de " + mp.refens.length, 3.5);
        }
        else if (m.ev === "largado") { r.estado = 0; r.lider = null; G.hud.feed("Um refém ficou para trás"); }
        else if (m.ev === "morto") { r.estado = 3; r.lider = null; G.hud.feed(`<b>${nome}</b> matou um refém`); }
        break;
      }
      case "armaPega": {
        const it = mp.armasChao.get(m.id);
        if (!it) break;
        tirarArmaDoChao(m.id);
        { const q = mp.jogadores.get(m.por); if (q) q.arma = it.arma; }
        if (m.por === mp.meuId && !mp.principal) { mp.principal = it.arma; delete mp.municao[it.arma]; mp.arma = it.arma; mp.rajada = 0; mp.cadT = 0.3; try { G.weapon.reset(); } catch {} tocar("reload_magin"); G.hud.message(ARMAS[it.arma].nome + " · G solta", 2.5); }
        break;
      }
      case "porta": aplicarPorta(!!m.aberta); break;
      case "pichacao": porPichacao(m); break;
      case "armaChao":
        porArmaNoChao(m.d);
        { const q = mp.jogadores.get(m.por); if (q) q.arma = q.time ? q.time + "_faca" : null; }
        if (m.por === mp.meuId) mp.armasChao.get(m.d[0]).espera = true;   // quem soltou só pega de novo depois de se afastar
        break;
      case "passo":
        if (m.id !== mp.meuId) tocar("step_concrete", { pos: new V3().fromArray(m.p), gain: 0.8 });
        break;
      case "item": {
        const it = mp.itens.get(m.id);
        if (!it) break;
        explosivos.remove(it.malha); explosivos.remove(it.anel); mp.itens.delete(m.id);
        if (m.por === mp.meuId) {
          if (it.tipo === "colete" || it.tipo === "capacete") mp[it.tipo] = true; else mp.bolsa[it.tipo]++;
          tocar("reload_magin"); G.hud.message("Pegou: " + NOMES_ITEM[it.tipo] + ({ granada: " · aperte 4 para jogar", bomba: " · aperte B para armar no chão", relogio: " · aperte V para armar (T muda o tempo)" }[it.tipo] || ""), 4.5);
        }
        break;
      }
      case "granada":
        mp.granadas.push({ pos: new V3().fromArray(m.o), vel: new V3().fromArray(m.v), t: CFG.granada.pavio, por: m.por, malha: modeloExplosivo("granada", 1.3) });
        break;
      case "bomba": {
        const b = { id: m.id, tipo: m.tipo, pos: new V3().fromArray(m.p), t: m.tempo, por: m.por, malha: modeloExplosivo(m.tipo, 1.7), bipe: 0 };
        b.malha.position.copy(b.pos).setY(b.pos.y + 0.07);
        mp.bombas.set(m.id, b);
        G.hud.warn(m.por === mp.meuId ? "Bomba armada" : "Bomba armada no mapa", 2.5); tocar("alert");
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
          if (d < m.raio && visto) { mp.ultimoDano = { por: m.por === mp.meuId ? null : m.por, t: performance.now() }; mp.danoMeu = true; try { pl.damage(m.dano * (1 - d / m.raio), p); } finally { mp.danoMeu = false; } }
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
        mp.resultado = (m.encerrada ? "Partida encerrada pelo anfitrião · Policiais " + m.placar.p + " a " + m.placar.t + " Terroristas" : m.vencedor === "e" ? "Partida empatada em " + m.placar.p + " a " + m.placar.t
          : "Vencedor: " + TIMES[m.vencedor].nome + " · " + m.placar[m.vencedor] + " a " + m.placar[perdedor])
          + (m.craque ? " · Destaque: " + m.craque[0] + " (" + m.craque[1] + " abates)" : "");
        sairDaPartida(); mp.faseAnfitriao = "lobby"; mp.placar = { p: 0, t: 0 }; mp.rodada = 0;
        for (const j of mp.jogadores.values()) { j.abates = 0; j.abatesRodada = 0; j.mortes = 0; }
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
  // as dicas abrem numa janela por cima da sala de espera (clicar fora, no botão ou apertar Esc fecha)
  const DICAS = `<ul class="mp-regras">
        <li><b>Objetivo</b> Policiais soltam os reféns (segure E) e levam ao ponto de resgate mostrado no painel da sala. Terroristas impedem até o tempo acabar.</li>
        <li><b>Fim da rodada</b> Todos os reféns salvos, um refém morto, um time inteiro caído ou o tempo esgotado.</li>
        <li><b>Sniper</b> Um tiro a cada 3 segundos, zoom de 5x no botão direito. Mata jogador com um tiro, com ou sem colete; refém precisa de dois.</li>
        <li><b>Teclas das armas</b> <kbd>1</kbd> arma principal · <kbd>2</kbd> pistola · <kbd>3</kbd> faca · <kbd>4</kbd> granada · <kbd>Q</kbd> volta para a anterior. Pistola (9 tiros) e faca todo mundo tem sempre; do chão você só pode levar uma arma principal.</li>
        <li><b>Guindaste</b> A torre de escadas do lado sul sobe do chão até o alto: escada de gaiola, cinco lances e uma escada curta para o convés. A 13,5 m há passarelas em volta da torre.</li>
        <li><b>Lugares altos</b> Vários containers, o telhado do galpão e um mirante na torre do guindaste têm escada de mão; no alto do guindaste dá para andar pelo convés, por cima da viga até a ponta sobre a água, e subir no teto da casa de máquinas. Para descer: chegue perto da escada e aperte E. Lá no alto os drones não pegam você.</li>
        <li><b>Pulo</b> Pulando de frente para qualquer coisa até a altura de um container, você sobe nela. Mais alto que isso, só de escada.</li>
        <li><b>Pichar</b> <kbd>P</kbd> abre seis desenhos: clique em um (ou aperte 1 a 6) para pichar. O desenho vai para onde a mira estava quando você apertou P (parede, chão, teto ou container, até 7 m).</li>
        <li><b>Pátio novo</b> O mapa cresceu para o sul: mais espaço aberto, poucos containers e muretas para se proteger.</li>
        <li><b>Saída secreta</b> Em cima da casinha dos reféns há um alçapão: cada vez ele leva a um lugar diferente do mapa.</li>
        <li><b>Armas</b> Todos nascem com a faca e a pistola. Passe por cima de uma arma para pegar (na sala, ficam no cabide). G solta a arma e você volta para a faca. R recarrega.</li>
        <li><b>Explosivos</b> Pegue passando por cima. 4 joga a granada; B arma a bomba no chão onde você está; V arma a bomba-relógio (T muda o tempo). Qualquer um desarma segurando E perto dela.</li>
        <li><b>Modo furtivo</b> Com a faca na mão ninguém ouve seus passos, nem os bots. Eles só veem o que está à frente deles; de arma na mão, ouvem você andando por perto e viram. Drones e cães só pegam quem está de faca se derem de cara com ele. Mirando com a sniper, máquinas e bots não veem você.</li>
        <li><b>Bots</b> Quando a partida começa, cada time é completado com bots até ficar com 5 (no máximo 10 na partida). O nome deles começa com "Bot". Eles só combatem, não mexem nos reféns, e ficam mais difíceis conforme a dificuldade da sala.</li>
        <li><b>Quem cai</b> Fica assistindo um jogador vivo até a rodada acabar. A barra de espaço troca de jogador.</li>
        <li><b>Placar</b> Segure Tab para ver quem está vivo, os abates e as vitórias de cada time.</li>
        <li><b>Teclas</b> C corre (correndo não atira) · Shift ou X agacha (Shift+W anda agachado) · Z deita e rasteja · E abre porta e solta refém · P picha · Q troca de arma (1 arma, 2 pistola, 3 faca) · 4 granada · B bomba · V bomba-relógio (T muda o tempo) · M som.</li>
        <li><b>Reféns</b> Seguem você a um passo e meio: correm, pulam, abaixam e deitam junto. No ponto de resgate, comemoram.</li>
        <li><b>Colete e capacete</b> Espalhados pelo mapa. O colete segura um tiro no tronco e some; o capacete segura um tiro na cabeça e some.</li>
        <li><b>Mira</b> No fácil e no médio a mira ajuda: tiro que passa raspando o inimigo ou a máquina acerta.</li>
        <li><b>Dano de tiro</b> No tronco tira 35; em perna ou pé, de 25 a 30; na cabeça, sem capacete, mata.</li>
        <li><b>Sala dos reféns</b> Tem 4 portas secretas numeradas (cada uma leva sempre ao mesmo lugar) e uma escada de mão até o duto de ar.</li>
        <li><b>Duto e telhado</b> No duto só se rasteja; ele leva a escadas para o chão e para o telhado. Dentro dele não dá para virar: S anda de ré. Na escada: W sobe, S desce. No telhado, as entradas têm moldura listrada e uma luz; uma delas é uma escada que desce por dentro do galpão.</li>
        <li><b>Queda</b> Descer sem escada machuca: da altura de um container tira pouco; do telhado, quase tudo.</li>
        <li><b>Reféns</b> Só morrem com tiro na cabeça. Soltos, andam armados e atiram nos Terroristas.</li>
      </ul>`;
  let dicasEl = null;
  function abrirDicas(abre) {
    if (!dicasEl) {
      dicasEl = document.createElement("div"); dicasEl.className = "mp-luz";
      dicasEl.innerHTML = `<div class="mp-luz-caixa"><div class="mp-k">Como jogar</div><h2 class="mp-h">Dicas</h2>${DICAS}<div class="mp-acoes"><button class="btn primary" data-fechar>Fechar</button></div></div>`;
      dicasEl.addEventListener("click", ev => { if (ev.target === dicasEl || ev.target.closest("[data-fechar]")) abrirDicas(false); });
      document.getElementById("app").appendChild(dicasEl);
      window.addEventListener("keydown", ev => { if (ev.code === "Escape" && dicasEl.classList.contains("aberta")) { ev.stopPropagation(); abrirDicas(false); } }, true);
    }
    void dicasEl.offsetWidth; dicasEl.classList.toggle("aberta", abre);
  }
  function desenharLobby() {
    if (mp.fase !== "lobby" || !mp.ativo) return;
    const lista = t => [...mp.jogadores.values()].filter(j => j.time === t)
      .map(j => `<li>${esc(j.nome)}${j.id === mp.meuId ? " <em>você</em>" : ""}${j.id === "anfitriao" ? " <em>anfitrião</em>" : ""}${j.bot ? " <em>bot</em>" : ""}</li>`).join("") || "<li class='mp-vazio'>ninguém ainda</li>";
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
      <div class="mp-dif"><span>Rodadas</span>${mp.anfitriao
        ? `<div class="seg">${[3, 4, 5, 7, 10].map(n => `<button data-mp="rod-${n}" aria-pressed="${n === mp.rodadasTotal}">${n}</button>`).join("")}</div>`
        : `<b>${mp.rodadasTotal}</b>`}</div>
      ${linhaBrilho()}
      <p class="mp-nota">${d.nome}: rodadas de ${Math.floor(d.tempo / 60)}:${String(d.tempo % 60).padStart(2, "0")}, até ${d.max} máquinas atacando os dois times${d.maq.dano < 0.6 ? " (fracas: incomodam mais do que matam)" : ""}. Partida de ${mp.rodadasTotal} rodadas: ganha o time que vencer mais.</p>
      <div class="mp-acoes mp-acoes-dicas"><button class="btn small" data-mp="dicas">Ver dicas</button></div>
      <div class="mp-acoes">
        ${mp.anfitriao ? `<button class="btn primary" data-mp="comecar">Começar partida</button>`
          : `<span class="mp-espera">${emAndamento ? "Partida em andamento — você entra na próxima rodada" : "Aguardando o anfitrião começar"}</span>`}
        <button class="btn" data-mp="ajustes">Ajustes</button>
        <button class="btn" data-mp="controles">Controles</button>
        <button class="btn" data-mp="nome">Trocar apelido</button>
        <button class="btn" data-mp="sair">Sair da sala</button>
      </div>`);
  }
  // BRILHO: cada um escolhe o seu (fica guardado no navegador); vale nas rodadas do multiplayer
  function brilho() { let v = 1.55; try { v = parseFloat(localStorage.getItem("pebacity.brilho")) || 1.55; } catch {} return Math.max(0.8, Math.min(2.6, v)); }
  const linhaBrilho = () => `<div class="mp-dif"><span>Brilho</span><input class="mp-brilho" type="range" min="80" max="260" step="5" value="${Math.round(brilho() * 100)}"><b class="mp-brilho-n">${Math.round(brilho() * 100)}%</b></div>`;
  document.addEventListener("input", ev => {
    const el = ev.target; if (!el || !el.classList || !el.classList.contains("mp-brilho")) return;
    try { localStorage.setItem("pebacity.brilho", String(el.value / 100)); } catch {}
    const n = el.parentElement.querySelector(".mp-brilho-n"); if (n) n.textContent = el.value + "%";
    try { if (emRodada()) G.render.exposure = brilho(); } catch {}
  });
  // abre o painel de ajustes do próprio jogo (qualidade, sensibilidade, volume, campo de visão) por cima da sala ou do menu da partida
  function abrirAjustes(qual) {
    try {
      const m = solo.menus; m.show("title");
      const b = m.root.querySelector('[data-act="' + (qual || "settings") + '"]'); if (b) b.click();
      for (let el = m.root.querySelector('[data-act="close-panel"]'); el && el !== m.root; el = el.parentElement) if (getComputedStyle(el).position !== "static") el.style.zIndex = "90";
      const t = setInterval(() => { if (!m.panelOpen) { clearInterval(t); try { m.show("none"); m.locationCard(false); } catch {} } }, 250);
    } catch (e) { console.warn("[mp] ajustes", e); }
  }
  document.addEventListener("click", async ev => {
    const b = ev.target.closest && ev.target.closest("[data-mp]"); if (!b) return;
    if (b.dataset.mp === "dicas") return abrirDicas(true);
    const a = b.dataset.mp;
    if (a === "criar") criarSala();
    else if (a === "sair") { mp.saindo = true; location.href = location.pathname; }
    else if (a === "copiar") {
      const campo = tela.querySelector(".mp-link input");
      try { await navigator.clipboard.writeText(campo.value); } catch { campo.select(); document.execCommand("copy"); }
      b.textContent = "Copiado";
    }
    else if (a.startsWith("time-")) enviar({ t: "time", time: a.slice(5) });
    else if (a.startsWith("dif-") && mp.anfitriao) { mp.dificuldade = a.slice(4); mandarLobby(); }
    else if (a.startsWith("rod-") && mp.anfitriao) { mp.rodadasTotal = +a.slice(4) || 5; mandarLobby(); }
    else if (a === "comecar") { mp.resultado = null; mp.placar = { p: 0, t: 0 }; mp.rodada = 0; novaRodada(); }
    else if (a === "nome") { await pedirPerfil(true); location.reload(); }
    else if (a === "voltar") menuDaPartida(false);
    else if (a === "reiniciar" && mp.anfitriao && emRodada()) {      // anfitrião: zera a rodada atual para todos, mantendo o placar
      menuDaPartida(false);
      paraTodos({ t: "feed", html: "<b>O anfitrião reiniciou a rodada</b>" });
      mp.rodada = Math.max(0, mp.rodada - 1); novaRodada();
    }
    else if (a === "ajustes") abrirAjustes("settings");
    else if (a === "controles") abrirAjustes("controls");
    else if (a === "lobby") {
      mp.menuAberto = false;
      if (mp.anfitriao) {                                  // o anfitrião encerra a partida para todos, com o placar como está
        const pl = mp.placar, v = pl.p > pl.t ? "p" : pl.t > pl.p ? "t" : "e";
        try { G.enemies.clear(); } catch {}
        paraTodos({ t: "fimPartida", vencedor: v, placar: pl, encerrada: 1 });
      } else {                                             // convidado: sai desta rodada e espera a próxima na sala
        const j = eu(); if (j && j.vivo) { j.vivo = false; enviar({ t: "morri", por: null }); }
        sairDaPartida(); mp.faseAnfitriao = "valendo"; entrarNoLobby();
      }
    }
  });
  // com uma tela do multiplayer aberta, as teclas não chegam ao jogo parado por trás
  // (senão o Enter do apelido começaria uma partida solo)
  for (const tipo of ["keydown", "keyup"])
    window.addEventListener(tipo, ev => {
      if (!(tela && !tela.hidden)) return;
      ev.stopImmediatePropagation();
      if (tipo === "keydown") try { telaCheia(); } catch {}      // na sala de espera as teclas param aqui: a tela cheia é pedida daqui mesmo
      if (tipo === "keydown" && ev.code === "Escape" && mp.menuAberto) { ev.preventDefault(); menuDaPartida(false); }      // Esc de novo fecha o menu
    }, true);
  // MENU DA PARTIDA (Esc): voltar ao jogo, voltar à sala de espera ou sair da sala. A partida não para para os outros.
  function menuDaPartida(abre) {
    if (!abre) { mp.menuAberto = false; fecharOverlay(); if (emRodada()) try { G.input.requestLock(); } catch {} return; }
    mp.menuAberto = true; try { G.input.exitLock(); } catch {}
    overlay(`<div class="mp-k">Partida em andamento</div>
      <h2 class="mp-h">Menu</h2>
      <p class="mp-nota">A partida continua rodando para os outros jogadores enquanto este menu está aberto.</p>
      <div class="mp-acoes mp-acoes-menu">
        <button class="btn primary" data-mp="voltar">Voltar ao jogo</button>
        <button class="btn" data-mp="lobby">Voltar ao lobby</button>
        <button class="btn" data-mp="sair">Sair da sala</button>
      </div>
      <div class="mp-acoes mp-acoes-menu">
        <button class="btn" data-mp="ajustes">Ajustes</button>
        <button class="btn" data-mp="controles">Controles</button>
        ${mp.anfitriao ? `<button class="btn" data-mp="reiniciar">Reiniciar rodada</button>` : ""}
      </div>
      ${mp.anfitriao ? `<p class="mp-nota">Reiniciar rodada derruba todo mundo e começa a rodada de novo, sem mexer no placar.</p>` : ""}
      ${linhaBrilho()}
      <p class="mp-nota">${mp.anfitriao ? "Voltar ao lobby encerra a partida e leva todos para a sala de espera." : "No lobby você fica fora desta rodada e volta a jogar na próxima."} Sair da sala leva à tela inicial, de onde dá para criar outra sala.</p>`);
  }
  window.addEventListener("keydown", ev => {
    if (ev.code !== "Escape" || ev.repeat || !emRodada() || (tela && !tela.hidden) || (pichoEl && !pichoEl.hidden) || (dicasEl && dicasEl.classList.contains("aberta"))) return;
    ev.preventDefault(); menuDaPartida(true);
  }, true);
  // sem o Esc preso (Safari, Firefox, ou fora da tela cheia) o navegador engole a tecla e só solta o mouse: abre o menu do mesmo jeito
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement) { mp.travouEm = performance.now(); return; }
    if (!emRodada() || mp.menuAberto || (tela && !tela.hidden) || (pichoEl && !pichoEl.hidden)) return;
    // só vale como "Esc" se o mouse estava preso havia mais de 1 s e a tela não acabou de entrar ou sair da tela cheia
    // (entrar em tela cheia solta o mouse sozinho, e isso não é um pedido de menu)
    const agora = performance.now();
    if (agora - (mp.travouEm || 0) < 1000 || agora - (mp.telaMudouEm || 0) < 2000) return;
    setTimeout(() => { if (!document.pointerLockElement && emRodada() && !mp.menuAberto && !(tela && !tela.hidden) && !(pichoEl && !pichoEl.hidden) && performance.now() - (mp.telaMudouEm || 0) > 2000) menuDaPartida(true); }, 200);
  });

  /* ------------------------------------------------------------------ rodadas */
  function novoJogador(id, nome) {
    const j = { id, nome, time: null, vivo: false, naRodada: false, pos: new V3(0, -50, 0), cur: new V3(0, -50, 0), yaw: 0, pitch: 0, agachado: false, boneco: null, alvo: null };
    const n = t => [...mp.jogadores.values()].filter(x => x.time === t && !x.bot).length;      // os bots se ajustam depois
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
    for (const c of POLICIAIS_NA_SALA) if (pts.length < quantos) pts.push([c[0], SALA.chao, c[1], Math.PI / 2]);
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
      r.pos.set(REFENS[i][0], SALA.chao, REFENS[i][1]); r.cur.copy(r.pos); r.vel.set(0, 0, 0); r.casa.copy(r.pos); r.trilha = [];
      r.estado = 0; r.lider = null; r.hp = dif().refem.tirosCabeca; r.jaSolto = false; r.caminho = null; r.caminhoT = 0;
      r.passoT = Math.random(); r.passo = [0, 0]; r.ladoT = 0; r.lado = 1; r.tiroT = 1.5; r.noChao = true;
      r.yaw = Math.PI * 0.75; r.miraT = 0; r.prot = 3;        // começa de colete (1) e capacete (2)        // de frente para a porta e para os Policiais
    });
  }
  // só o anfitrião
  function novaRodada() {
    mp.rodada++; mp.fase = "preparo"; mp.tempo = dif().tempo;
    completarComBots();
    const nasc = {};
    for (const t of ["p", "t"]) {
      const time = [...mp.jogadores.values()].filter(j => j.time === t).sort((a, b) => (a.bot ? 1 : 0) - (b.bot ? 1 : 0)), pts = pontosDeNascimento(t, time.length);      // gente primeiro
      time.forEach((j, k) => {
        let pt = pts[k];
        if (j.bot && pt[1] > 1) { const q = pisavel(BASE_POLICIA[0] + (Math.random() - 0.5) * 6, BASE_POLICIA[1] + (Math.random() - 0.5) * 6); pt = [q[0], 0, q[1], pt[3]]; }      // bot não nasce na sala dos reféns
        nasc[j.id] = pt; j.vivo = true; j.naRodada = true; j.pos.set(pt[0], j.bot ? pt[1] : 0, pt[2]); j.cur.copy(j.pos);
        if (j.bot) { j.hp = (BOTS.niveis[mp.dificuldade] || BOTS.niveis.medio).vida; j.yaw = pt[3] || 0; j.vel.set(0, 0, 0); j.pisando = true; j.noChao = false; j.ia = { pensarT: Math.random() * 0.4, alvo: null, visto: false, dist: 99, sabe: {}, rondaT: 0, caminho: null, caminhoT: 0, tiroT: 1 + Math.random(), ladoT: 0, lado: 1 }; }
      });
    }
    try { G.enemies.clear(); } catch {}
    paraTodos({ t: "rodada", n: mp.rodada, placar: mp.placar, nasc, dificuldade: mp.dificuldade, itens: sortearItens(), armas: sortearArmas(nasc), carro: sortearCarro() });
    mandarLobby();
    for (const j of mp.jogadores.values()) if (j.bot) j.arma = j.time + "_fuzil";
    const r = RESGATES[Math.floor(Math.random() * RESGATES.length)], q = pisavel(r[0], r[1]);
    mp.resgate = new V3(q[0], 0, q[1]);
    for (const j of mp.jogadores.values()) if (j.time === "p") paraUm(j.id, { t: "resgate", p: q, nome: r[2] });   // só os Policiais ficam sabendo
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
      moverRefens(dt); moverBots(dt); explosivosDoAnfitriao(dt);
      const conta = t => { let total = 0, vivos = 0; for (const j of mp.jogadores.values()) if (j.time === t && j.naRodada) { total++; if (j.vivo) vivos++; } return { total, vivos }; };
      const pol = conta("p"), ter = conta("t");
      if (mp.fase !== "valendo") return;
      if (pol.total && !pol.vivos) fimDaRodada("t", "Todos os Policiais caíram");
      else if (ter.total && !ter.vivos && pol.total) fimDaRodada("p", "Todos os Terroristas caíram");
      else if (mp.tempo <= 0) fimDaRodada("t", "O tempo acabou");
    } else if (mp.fase === "fim") {
      mp.fimT -= dt;
      if (mp.fimT <= 0) {
        // a partida acaba na última rodada, ou antes, quando um time já não pode mais ser alcançado
        const pl = mp.placar, resto = mp.rodadasTotal - mp.rodada, acabou = resto <= 0 || Math.abs(pl.p - pl.t) > resto;
        const v = !acabou ? null : pl.p > pl.t ? "p" : pl.t > pl.p ? "t" : "e";
        if (v) {
          const melhor = [...mp.jogadores.values()].sort((a, b) => (b.abates || 0) - (a.abates || 0))[0];
          try { G.enemies.clear(); } catch {}
          paraTodos({ t: "fimPartida", vencedor: v, placar: mp.placar, craque: melhor && melhor.abates ? [melhor.nome, melhor.abates] : null });
        }
        else novaRodada();
      }
    }
  }
  // todos
  function comecarRodadaLocal(m) {
    mp.fase = "preparo"; mp.preparoT = CFG.tempoPreparo; mp.rodada = m.n; mp.placar = m.placar; mp.dificuldade = m.dificuldade; mp.tempo = dif().tempo;
    mp.pegando = -1; mp.pegarT = 0; mp.passagemT = 0; mp.ultimoDano = null; mp.resultado = null; mp.assinatura = "";
    mp.resgateSuper = null;
    mp.resgateVisto = null; discoResgate.visible = false; painel.visible = false;
    mp.menuAberto = false; fecharOverlay(); esconderMenuSolo(); if (dicasEl) abrirDicas(false);
    if (!mp.anfitriao) { try { G.enemies.clear(); } catch {} mp.marionetes.clear(); }
    prepararSala(); aplicarPorta(false);
    zerarRefens(); limparExplosivos(); limparArmas(); porCarro(m.carro);
    for (const j of mp.jogadores.values()) { j.arma = j.time ? j.time + "_faca" : null; j.armadura = 0; j.abatesRodada = 0; }      // todo mundo nasce com a faca
    mp.arma = eu() && eu().time && m.nasc[mp.meuId] ? eu().time + "_faca" : null; mp.principal = null; mp.municao = {}; mp.prontaEm = {}; mp.armaAntes = null;
    for (const d of m.armas || []) porArmaNoChao(d);
    for (const d of m.itens || []) {
      const it = { id: d[0], tipo: d[1], pos: new V3(d[2], 0, d[3]), malha: modeloExplosivo(d[1], d[1] === "colete" || d[1] === "capacete" ? 1.5 : 2.2), pedido: false };
      it.malha.position.set(d[2], 0.45, d[3]); mp.itens.set(it.id, it);
      it.anel = anelNeutro(); it.anel.position.set(d[2], 0.04, d[3]); explosivos.add(it.anel);
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
    if (meu) G.hud.message((meu[1] > 1 ? "Armas no cabide sob a janela" : "Pegue uma arma no chão") + " · 1 arma · 2 pistola · 3 faca · 4 granada · G solta · C corre · Esc abre o menu", CFG.tempoPreparo + 6);
    gradesVazadas(true); G.player.tuning.sprint = G.player.tuning.walk * 2;      // correr = o dobro de andar
    mp.quedaTopo = meu ? meu[1] : 0; mp.naEscada = null; mp.deitarManual = false;
    if (!meu) p.alive = false;
    placarEl.hidden = false; vidaEl.hidden = false;
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
    if (mp.carro.malha) mp.carro.malha.visible = false; mp.carro.pos = null; mp.carro.oc = [null, null, null, null, null];
    if (mp.linhaMunicao) mp.linhaMunicao.style.visibility = "";
    cenario.visible = false; explosivos.visible = false; bolsaEl.hidden = true; limparExplosivos(); limparArmas(); limparPichacoes();
    gradesVazadas(false);
    try { const t = G.player.tuning; t.sprint = 6.4; t.crouchHeight = 1.15; t.crouch = 1.9; } catch {}
    try { G.weapon.name = nomeArmaOriginal; aplicarModelo(null); animarFaca(0, false); } catch {}
    for (const j of mp.jogadores.values()) if (j.boneco) j.boneco.grupo.visible = false;
    for (const r of mp.refens) r.boneco.grupo.visible = false;
    placarEl.hidden = true; vidaEl.hidden = true; tabEl.hidden = true; if (mapaEl) mapaEl.hidden = true; if (tempoEl) tempoEl.hidden = true;
    { const ve = document.getElementById("versao"); if (ve) ve.hidden = false; }
  }
  // objetivo, contador e marcadores do HUD; refaz só quando a situação dos reféns muda
  function atualizarObjetivo() {
    const t = eu() && eu().time, sig = t + mp.refens.map(r => r.estado).join("") + (mp.resgateVisto ? mp.resgateNome : "") + (mp.resgateSuper ? "S" : "");
    if (sig === mp.assinatura) return;
    mp.assinatura = sig;
    G.hud.setObjective(!t ? "Aguarde a próxima rodada" : mp.resgateVisto ? "Leve os reféns: " + mp.resgateNome : TIMES[t].objetivo);
    G.hud.setRelays(mp.refens.filter(r => r.estado === 2).length, mp.refens.length);
    // Policiais veem os reféns o tempo todo. Terroristas só enquanto estão presos na casinha: depois de solto, o marcador
    // entregaria onde está o policial que o leva.
    const marcas = mp.refens.filter(r => t === "p" ? r.estado < 2 : r.estado === 0).map(r => ({ id: "refem" + r.i, short: "R" + (r.i + 1), label: "Refém", pos: r.cur, kind: "relay" }));
    if (mp.resgateVisto || mp.resgateSuper) marcas.push({ id: "resgate", short: "EX", label: "Resgate", pos: mp.resgateVisto || mp.resgateSuper, kind: "extract" });
    G.hud.setMarkers(marcas);
  }

  /* ------------------------------------------------------------------ bonecos */
  function criarAlvo(j) {      // o que as máquinas do anfitrião enxergam no lugar de um jogador remoto
    return { pos: j.cur, eye: new V3(), vel: new V3(), forward: new V3(0, 0, -1), yaw: 0, pitch: 0, alive: false, crouching: false,
      speed: 0, health: 100, maxHealth: 100, onGround: true, enabled: true,
      damage(q, de) { q *= (dif().maq || {}).dano || 1; if (mp.fase === "valendo" && j.vivo) { if (j.bot) ferirBot(j, q, null); else paraUm(j.id, { t: "dano", q, de: de ? arr(de) : null, por: null }); } },
      heal() {}, addShake() {}, addRecoil() {} };
  }
  // Monta uma pessoa: pernas com joelho, tronco com cintura, braços com cotovelo, cabeça com rosto, cabelo e roupa.
  // Medidas em metros, de frente para -z. Jogadores (armado) levam farda, faixa do time e a arma que pegaram; o colete e o
  // capacete só aparecem em quem está com eles. Reféns (civil) usam roupa comum e ficam de pulsos amarrados até serem soltos.
  /* ------------------------------------------------------- modelos baixados */
  // Policiais e Terroristas usam um soldado pronto (modelos/soldado.glb, do repositório do Three.js), com esqueleto e
  // animações de parado, andando e correndo. Se o arquivo não carregar, fica o boneco feito por código.
  // Os reféns e os Terroristas usam um homem de roupa comum do mesmo repositório (modelos/civil2.glb), que não traz
  // animação: a passada e os braços dele são movidos pelo código. A cor da roupa muda de um para outro.
  let soldado = null, civilModelo = null;
  const CORPO_CIVIL = { cabeca: 1.72, raio: 0.142, peito: 0.15, tronco: 1.29 };      // onde ficam a cabeça e o tronco do modelo civil (m)
  const MAO = { x: 0, y: -0.035, z: 0.075, eixo: [1, 0, 0], fecha: 1.1, espelho: 1 };      // onde o punho pega a arma e como os dedos fecham      // como a mão do modelo civil pega a arma
  const VIRAR_CIVIL = true;        // true se, com as animações adaptadas, o modelo civil sair virado para trás
  async function carregarModelos() {
    try {
      const [{ GLTFLoader }, SU] = await Promise.all([import("./lib/GLTFLoader.js"), import("./lib/SkeletonUtils.js")]);
      const carregador = new GLTFLoader(), malhaDe = cena => { let m = null; cena.traverse(o => { if (o.isSkinnedMesh && !m) m = o; }); return m; };
      const g = await carregador.loadAsync("./modelos/soldado.glb");
      // modelos/animacoes.json traz, além de parado/andar/correr, as posturas: rastejando, deitado, agachado (parado e andando),
      // no ar e caindo morto. Cada rotação lá é em relação a um repouso neutro (em T); aqui ela é somada ao repouso de cada osso
      // do modelo, e a altura do quadril é passada para a escala e a orientação dele.
      const T = G.THREE; let dados = null;
      try { dados = await (await fetch("./modelos/animacoes.json")).json(); } catch (e) { console.warn("[mp] modelos/animacoes.json não carregou; os bonecos ficam sem as posturas", e); }
      const clipesPara = (cena, prefixo, repousoDe, quais) => {
        const ossos = {}, q = new T.Quaternion(), lista = []; cena.updateMatrixWorld(true);
        cena.traverse(o => { if (o.isBone) ossos[o.name] = o; });
        const hips = ossos[prefixo + "Hips"], L = ossos[prefixo + "LeftArm"], R = ossos[prefixo + "RightArm"];
        if (!dados || !hips || !L || !R) return lista;
        const ex = L.getWorldPosition(new V3()).sub(R.getWorldPosition(new V3())).setY(0).normalize(), ez = new V3().crossVectors(ex, new V3(0, 1, 0));
        const k = hips.getWorldPosition(new V3()).y / 1.0427, pq = hips.parent.getWorldQuaternion(new T.Quaternion()).invert(), ps = hips.parent.getWorldScale(new V3()).y || 1, p0 = hips.position.clone();
        // O modelo civil tem o repouso diferente do das animações (braços, ombros e pés em outro ângulo). Para ele a conversão
        // é feita pelo espaço do mundo: descobre-se quanto cada osso girou em relação ao repouso da animação e aplica-se esse
        // giro ao repouso do modelo, já alinhado na mesma direção. Assim ombro, braço, joelho e pé ficam onde a animação manda.
        let E = null;
        if (dados.esq) {
          E = { ordem: [], pai: {}, q: {}, rw: {}, pw: {}, tgt: {}, A: {}, paiT: {} };
          for (const [n, pai, q4, t3] of dados.esq) {
            E.ordem.push(n); E.pai[n] = pai; E.q[n] = new T.Quaternion().fromArray(q4);
            E.rw[n] = pai ? E.rw[pai].clone().multiply(E.q[n]) : E.q[n].clone();
            E.pw[n] = new V3().fromArray(t3); if (pai) E.pw[n].applyQuaternion(E.rw[pai]).add(E.pw[pai]);
          }
          E.F = new T.Quaternion().setFromAxisAngle(new V3(0, 1, 0), Math.atan2(-ex.z, ex.x)); E.Fi = E.F.clone().invert();
          if (repousoDe) { for (const n in repousoDe) if (ossos[n]) ossos[n].quaternion.copy(repousoDe[n]); cena.updateMatrixWorld(true); }      // mede o modelo na pose em T
          for (const n of E.ordem) { const o = ossos[prefixo + n]; if (o) { E.tgt[n] = o.getWorldQuaternion(new T.Quaternion()); E.paiT[n] = o.parent.getWorldQuaternion(new T.Quaternion()); } }
          const cadeia = [["Spine", "Spine1"], ["Spine1", "Spine2"], ["Spine2", "Neck"], ["Neck", "Head"]];
          for (const L of ["Left", "Right"]) cadeia.push([L + "Shoulder", L + "Arm"], [L + "Arm", L + "ForeArm"], [L + "ForeArm", L + "Hand"], [L + "UpLeg", L + "Leg"], [L + "Leg", L + "Foot"], [L + "Foot", L + "ToeBase"]);
          for (const [n, f] of cadeia) if (ossos[prefixo + n] && ossos[prefixo + f] && E.pw[n] && E.pw[f]) {
            const dT = ossos[prefixo + f].getWorldPosition(new V3()).sub(ossos[prefixo + n].getWorldPosition(new V3())).normalize(), dS = E.pw[f].clone().sub(E.pw[n]).normalize().applyQuaternion(E.F);
            E.A[n] = new T.Quaternion().setFromUnitVectors(dT, dS);
          }
        }
        const peloMundo = c => {
          const n = Math.max(2, Math.ceil(c.dur * 30) + 1), faixaDe = {}, vals = {}, ant = {}, qa = new T.Quaternion(), qb = new T.Quaternion(), tempos = [];
          for (const f of c.faixas) { faixaDe[f.o] = f; if (ossos[prefixo + f.o] && E.rw[f.o]) vals[f.o] = []; }
          const amostra = (f, t) => {
            const ts = f.t; if (ts.length === 1 || t <= ts[0]) return qa.fromArray(f.v, 0);
            let i = 0; while (i < ts.length - 2 && ts[i + 1] < t) i++;
            return qa.fromArray(f.v, i * 4).slerp(qb.fromArray(f.v, (i + 1) * 4), Math.max(0, Math.min(1, (t - ts[i]) / Math.max(1e-6, ts[i + 1] - ts[i]))));
          };
          for (let k = 0; k < n; k++) {
            const t = c.dur * k / (n - 1), sw = {}, tw = {}; tempos.push(t);
            for (const nome of E.ordem) {
              const loc = E.q[nome].clone(); if (faixaDe[nome]) loc.multiply(amostra(faixaDe[nome], t));
              sw[nome] = E.pai[nome] ? sw[E.pai[nome]].clone().multiply(loc) : loc;
              if (!ossos[prefixo + nome]) continue;
              const w = E.F.clone().multiply(sw[nome]).multiply(E.rw[nome].clone().invert()).multiply(E.Fi);
              if (E.A[nome]) w.multiply(E.A[nome]);
              w.multiply(E.tgt[nome]); tw[nome] = w;
              if (!vals[nome]) continue;
              const l = (tw[ossos[prefixo + nome].parent.name.replace(prefixo, "")] || E.paiT[nome]).clone().invert().multiply(w), a = ant[nome];
              if (a && a.dot(l) < 0) l.set(-l.x, -l.y, -l.z, -l.w);
              ant[nome] = l; vals[nome].push(l.x, l.y, l.z, l.w);
            }
          }
          return Object.keys(vals).map(o => new T.QuaternionKeyframeTrack(prefixo + o + ".quaternion", tempos, vals[o]));
        };
        for (const c of dados.clips) {
          if (!quais(c)) continue;
          const faixas = E ? peloMundo(c) : c.faixas.filter(f => ossos[prefixo + f.o]).map(f => {
            const r = (repousoDe && repousoDe[prefixo + f.o]) || ossos[prefixo + f.o].quaternion, v = f.v.slice();
            for (let i = 0; i < v.length; i += 4) q.fromArray(v, i).premultiply(r).toArray(v, i);
            return new T.QuaternionKeyframeTrack(prefixo + f.o + ".quaternion", f.t, v);
          });
          if (c.h) {
            const v = [];
            for (let i = 0; i < c.h.v.length; i += 3) {
              const d = new V3().addScaledVector(ex, c.h.v[i] * k).addScaledVector(ez, c.h.v[i + 2] * k); d.y = c.h.v[i + 1] * k;
              d.applyQuaternion(pq).divideScalar(ps).add(p0); v.push(d.x, d.y, d.z);
            }
            faixas.push(new T.VectorKeyframeTrack(prefixo + "Hips.position", c.h.t, v));
          }
          const clip = new T.AnimationClip(c.nome, c.dur, faixas); clip.uma = !!c.uma; clip.vel = c.vel || 0; lista.push(clip);
        }
        return lista;
      };
      const repS = {}, tpose = g.animations.find(c => c.name === "TPose");
      if (tpose) for (const t of tpose.tracks) if (t.name.endsWith(".quaternion")) repS[t.name.slice(0, -11)] = new T.Quaternion().fromArray(t.values, 0);
      let posturasS = []; try { posturasS = clipesPara(g.scene, "mixamorig", repS, c => !!c.h); } catch (e) { console.warn("[mp] posturas do soldado", e); }
      soldado = { cena: g.scene, clips: g.animations.filter(c => c.name !== "TPose" && !posturasS.find(k => k.name === c.name)).concat(posturasS), clonar: SU.clone, mats: {} };
      for (const j of mp.jogadores.values()) removerBoneco(j);          // quem já tinha o boneco antigo troca pelo novo
      try {
        const c = await carregador.loadAsync("./modelos/civil2.glb");
        g.scene.updateMatrixWorld(true); c.scene.updateMatrixWorld(true);
        // o modelo civil não traz animação: usa as de parado, andar e correr guardadas em modelos/animacoes.json (tiradas de outro
        // modelo com os mesmos ossos). Lá cada rotação é em relação a um repouso neutro; aqui ela é somada ao repouso de cada osso.
        let clips = [];
        try {
          clips = clipesPara(c.scene, "", null, () => true);
          if (!clips.find(k => k.name === "Idle") || !clips.find(k => k.name === "Walk") || !clips.find(k => k.name === "Run")) clips = [];
        } catch (e) { console.warn("[mp] as animações do modelo civil não carregaram; pernas e braços ficam movidos pelo código", e); clips = []; }
        if (CARRO.ligado) try { const k = await carregador.loadAsync("./modelos/carro.glb"); montarCarro(k); } catch (e) { console.warn("[mp] o modelo do carro não carregou; fica o carro feito por código", e); }
        civilModelo = { cena: c.scene, clips, clonar: SU.clone, mats: {}, virado: VIRAR_CIVIL };
        for (const j of mp.jogadores.values()) if (j.time === "t") removerBoneco(j);
        for (const r of mp.refens) if (r.civil.modelo) { const visivel = r.boneco.grupo.visible; removerBoneco(r); r.boneco = criarBoneco({ armado: false, civil: r.civil }); r.boneco.grupo.visible = visivel; }
      } catch (e) { console.warn("[mp] o modelo civil não carregou; os reféns ficam com o boneco feito por código", e); }
    } catch (e) { console.warn("[mp] o modelo do soldado não carregou; fica o boneco feito por código", e); }
  }
  // monta um boneco a partir de um modelo baixado: cópia com esqueleto próprio, cor do time (ou do refém), animações,
  // faixa do time nos braços e o ponto onde a arma fica
  function criarDoModelo(fonte, { nome, css, time, civil }) {
    const T = G.THREE, grupo = new T.Group(), modelo = new T.Group(), cena = fonte.clonar(fonte.cena), ossos = {}, chave = time || civil.quem;
    const cor = time === "p" && fonte === soldado ? 0x4f6fe6 : 0xffffff, liso = {};
    if (fonte === civilModelo) {         // roupa de uma cor só: refém de macacão laranja; terrorista de camisa verde-escura e calça cáqui
      liso.Wolf3D_Outfit_Top = civil ? 0xf08a00 : 0x3d4a36; liso.Wolf3D_Outfit_Bottom = civil ? 0xf08a00 : 0xa8946a;
      if (time === "t") liso.Wolf3D_Skin = 0x15161a;      // balaclava: a própria cabeça do modelo, toda preta (os olhos ficam de fora)
    }
    let visor = null, malha = null;
    cena.traverse(o => {
      if (o.isBone) ossos[o.name.replace("mixamorig", "")] = o;
      if (!o.isMesh) return;
      o.userData.emprestado = true; o.frustumCulled = false; o.castShadow = true; malha = malha || o;
      if (/visor/i.test(o.name)) return void (visor = o);
      if (fonte === civilModelo && (/Headwear/i.test(o.material.name) || (time === "t" && /Beard|Teeth/i.test(o.material.name)))) return void (o.visible = false);      // sem o chapéu (e, de balaclava, sem barba)
      const lisa = liso[o.material.name], id = chave + o.material.uuid;
      if (lisa == null && cor === 0xffffff) return;
      if (!fonte.mats[id]) {
        const c = fonte.mats[id] = o.material.clone();
        if (lisa != null) { c.map = null; c.color.set(lisa); c.roughness = 0.85; c.metalness = 0; } else c.color.multiply(new T.Color(cor));
      }
      o.material = fonte.mats[id];
    });
    if (fonte.virado) cena.rotation.y = Math.PI;
    modelo.add(cena); grupo.add(modelo);
    const mixer = new T.AnimationMixer(fonte.naMalha ? malha : cena), acoes = {};
    for (const c of fonte.clips) { const a = acoes[c.name] = mixer.clipAction(c); if (c.uma) { a.setLoop(T.LoopOnce, 1); a.clampWhenFinished = true; } a.play(); a.setEffectiveWeight(c.name === "Idle" ? 1 : 0); }
    if (time) {
      const mFaixa = new T.MeshStandardMaterial({ color: ROUPAS[time].faixa, emissive: ROUPAS[time].faixa, emissiveIntensity: 0.7, roughness: 0.8 });
      const u = fonte === soldado ? 100 : 1, raio = fonte === soldado ? 0.072 : 0.058;      // os ossos do soldado medem em centímetros; os do civil, em metros
      for (const n of ["LeftArm", "RightArm"]) { const f = new T.Mesh(new T.CylinderGeometry(raio * u, raio * u, 0.06 * u, 14), mFaixa); f.position.y = 0.13 * u; ossos[n].add(f); }
    }
    let coleteM = null, capaceteM = null;
    if (fonte === civilModelo) {     // peças presas aos ossos: balaclava, lenço e bandoleira do terrorista; colete e capacete de quem tem
      grupo.updateMatrixWorld(true);
      const tx = texturasDeRoupa(), pano = hex => new T.MeshStandardMaterial({ color: hex, roughness: 0.9, map: tx.tecido, bumpMap: tx.tecido, bumpScale: 1.2 }), C = CORPO_CIVIL;
      const por = (osso, obj, x, y, z) => { obj.position.set(x, y, z); modelo.add(obj); obj.updateMatrixWorld(true); ossos[osso].attach(obj); return obj; };
      const malha = (geo, mat) => { const o = new T.Mesh(geo, mat); o.castShadow = true; return o; };
      if (time === "t") {
        const lenco = por("Spine2", malha(new T.TorusGeometry(0.085, 0.035, 8, 18), pano(0x8a2f25)), 0, 1.5, 0.005); lenco.rotateX(Math.PI / 2);
        const fita = por("Spine1", malha(new T.BoxGeometry(0.065, 0.56, 0.03), pano(0x3a2a1c)), 0, C.tronco, -C.peito); fita.rotateZ(0.62);                // bandoleira
        for (const k of [-0.15, -0.05, 0.05, 0.15]) { const b = por("Spine1", malha(new T.BoxGeometry(0.045, 0.07, 0.035), pano(0x5a4630)), k * 0.6, C.tronco - k * 0.85, -C.peito - 0.025); b.rotateZ(0.62); }
      }
      coleteM = new T.Group();
      const lona = pano(time ? 0x20242a : 0x2b3138), bolso = pano(0x3f4650);
      const corpo = malha(new T.CylinderGeometry(0.2, 0.185, 0.4, 18), lona); corpo.scale.z = 0.92; coleteM.add(corpo);
      for (const x of [-0.11, 0.11]) { const a = malha(new T.BoxGeometry(0.07, 0.07, 0.34), lona); a.position.set(x * 0.9, 0.215, 0); coleteM.add(a); }
      for (const x of [-0.11, 0, 0.11]) { const p = malha(new T.BoxGeometry(0.075, 0.09, 0.04), bolso); p.position.set(x * 0.85, -0.08, -0.19); coleteM.add(p); }
      por("Spine1", coleteM, 0, C.tronco, 0); coleteM.visible = false;
      capaceteM = new T.Group();
      const casco = malha(new T.SphereGeometry(0.128, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), new T.MeshStandardMaterial({ color: time ? 0x2b2d24 : 0x3f4a3a, roughness: 0.5, metalness: 0.25 })); casco.scale.set(0.98, 1.05, 1.1); capaceteM.add(casco);
      for (const x of [-0.118, 0.118]) { const j = malha(new T.BoxGeometry(0.012, 0.12, 0.03), pano(0x15171a)); j.position.set(x, -0.06, 0); capaceteM.add(j); }
      por("Head", capaceteM, 0, C.cabeca + 0.085, 0.01); capaceteM.visible = false;
    }
    // a arma gira num ponto na altura do ombro, preso ao tronco do esqueleto: assim ela (e os braços que a seguram)
    // acompanha o balanço da animação em vez de ficar dura no lugar
    const suporte = new T.Group(); suporte.position.set(0, 1.4, -0.02); modelo.add(suporte);
    const troncoOsso = ossos.Spine2 || ossos.Spine1 || ossos.Spine;
    if (troncoOsso) { grupo.updateMatrixWorld(true); troncoOsso.attach(suporte); }
    const pivo = new T.Group(); suporte.add(pivo);
    const lado = 1, arma = new T.Group(); arma.position.set(fonte === civilModelo ? 0.06 : 0.15, fonte === civilModelo ? -0.05 : -0.1, -0.38); pivo.add(arma);   // a arma fica à direita do corpo (no civil, mais ao centro, para as duas mãos)
    let placa = null;
    if (time) { placa = criarPlaca(nome, css); placa.position.y = 2.05; grupo.add(placa); }
    if (civil) grupo.scale.setScalar(civil.escala);
    grupo.visible = false; G.scene.add(grupo); grupo.updateMatrixWorld(true);
    const dist = (a, b) => ossos[a].getWorldPosition(new V3()).distanceTo(ossos[b].getWorldPosition(new V3()));
    // pose de repouso de pernas e braços (direção até o osso seguinte), medida no espaço do modelo
    const repouso = {}, qm = modelo.getWorldQuaternion(new T.Quaternion()).invert();
    for (const [n, f] of [["LeftUpLeg", "LeftLeg"], ["LeftLeg", "LeftFoot"], ["RightUpLeg", "RightLeg"], ["RightLeg", "RightFoot"], ["LeftArm", "LeftForeArm"], ["LeftForeArm", "LeftHand"], ["RightArm", "RightForeArm"], ["RightForeArm", "RightHand"]])
      if (ossos[n] && ossos[f]) repouso[n] = { q: qm.clone().multiply(ossos[n].getWorldQuaternion(new T.Quaternion())), dir: ossos[f].getWorldPosition(new V3()).sub(ossos[n].getWorldPosition(new V3())).applyQuaternion(qm).normalize() };
    const b = { grupo, modelo, mixer, acoes, repouso, semClipes: !fonte.clips.length, posturas: !!acoes.Prone && !!acoes.CrouchIdle, suporte, suporteQ: suporte.quaternion.clone(), rig: fonte === civilModelo, ossos, pivo, arma, placa, capacete: capaceteM || visor || new T.Group(), colete: coleteM || new T.Group(), bone: new T.Group(), cordas: [], armaChave: null, lado,
      dedos: Object.keys(ossos).filter(n => /Hand(Index|Middle|Ring|Pinky)[123]$/.test(n)).map(n => ({ o: ossos[n], q: ossos[n].quaternion.clone(), lado: n.startsWith("Right") ? "Right" : "Left" })),
      braco: dist("RightArm", "RightForeArm"), ante: dist("RightForeArm", "RightHand"), ult: new V3(), andar: 0, fase: 0 };
    if (civil) { armarBoneco(b, "p_pistola"); arma.visible = false; }
    return b;
  }
  // vira um osso para que ele aponte numa direção do mundo. No modelo sem animação pronta gira a partir da pose de
  // repouso (não torce o membro); no soldado, o eixo y do osso vai até o osso seguinte.
  function apontarOsso(osso, dir, b, nome) {
    const T = G.THREE, pai = osso.parent.getWorldQuaternion(new T.Quaternion()).invert(), r = b && b.rig && b.repouso[nome];
    if (!r) return void osso.quaternion.copy(pai.multiply(new T.Quaternion().setFromUnitVectors(new V3(0, 1, 0), dir.clone().normalize())));
    const qm = b.modelo.getWorldQuaternion(new T.Quaternion()), local = dir.clone().normalize().applyQuaternion(qm.clone().invert());
    osso.quaternion.copy(pai.multiply(qm).multiply(new T.Quaternion().setFromUnitVectors(r.dir, local)).multiply(r.q));
  }
  // modelo sem animação pronta: aponta um osso numa direção dada no espaço do modelo (frente = -z, direita = +x)
  function apontarLocal(b, nome, x, y, z) {
    const o = b.ossos[nome]; if (!o || !b.repouso[nome]) return;
    apontarOsso(o, new V3(x, y, z).applyQuaternion(b.modelo.getWorldQuaternion(new G.THREE.Quaternion())), b, nome);
    o.updateWorldMatrix(false, true);
  }
  // fecha (k = 1) ou solta (k = 0) os dedos de uma mão do modelo civil, a partir do repouso de cada osso
  function fecharDedos(b, lado, k) {
    const q = new G.THREE.Quaternion().setFromAxisAngle(new V3(MAO.eixo[0], MAO.eixo[1], MAO.eixo[2]), MAO.fecha * k * (lado === "Left" ? MAO.espelho : 1));
    for (const d of b.dedos) if (d.lado === lado) d.o.quaternion.copy(d.q).multiply(q);
  }
  // dobra ombro e cotovelo para a mão chegar num ponto do mundo (lado = "Right" ou "Left"; fora = para que lado o cotovelo abre)
  function alcancar(b, lado, alvo, fora) {
    const om = b.ossos[lado + "Arm"], S = om.getWorldPosition(new V3()), para = alvo.clone().sub(S), l1 = b.braco, l2 = b.ante;
    const d = Math.min(para.length(), (l1 + l2) * 0.98), dir = para.normalize(), a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const cot = new V3(fora, -0.9, 0).applyQuaternion(b.grupo.quaternion); cot.addScaledVector(dir, -cot.dot(dir)).normalize();
    const E = S.clone().addScaledVector(dir, a).addScaledVector(cot, h);
    apontarOsso(om, E.clone().sub(S), b, lado + "Arm"); om.updateWorldMatrix(false, true);
    apontarOsso(b.ossos[lado + "ForeArm"], S.clone().addScaledVector(dir, d).sub(E), b, lado + "ForeArm");
  }
  // o soldado no lugar: animação conforme a velocidade, arma apontada (com as mãos nela), agachado, rastejando e caído
  function posarModelo(b, cur, yaw, k, dt, o) {
    const vel = dt > 0 ? Math.hypot(cur.x - b.ult.x, cur.z - b.ult.z) / dt : 0, deitado = !!o.deitado && o.vivo, m = b.modelo, ajoelhado = !!o.ajoelhado && o.vivo && !deitado && b.rig;
    b.ult.copy(cur); b.grupo.position.copy(cur);
    let d = yaw - b.grupo.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); b.grupo.rotation.y += d * k;
    b.andar += (Math.min(vel, 9) - b.andar) * Math.min(1, 10 * dt);
    const v = b.andar, pst = !!b.posturas && !b.semClipes;
    let alvo = !o.vivo ? (pst ? "Death" : "Idle") : v > (pst ? 3 : 2.6) ? "Run" : v > 0.35 ? "Walk" : "Idle";
    if (pst && o.vivo && !ajoelhado) {            // posturas com animação própria: rastejando, deitado, no ar, agachado
      if (deitado) alvo = v > 0.3 ? "Prone" : "ProneIdle";
      else if (o.noAr) alvo = "Air";
      else if (o.agachado) alvo = v > 0.35 ? "CrouchWalk" : "CrouchIdle";
    }
    const postura = alvo !== "Idle" && alvo !== "Walk" && alvo !== "Run";
    if (b.semClipes) {                // passada e braços pelo código
      b.grupo.updateMatrixWorld(true);
      b.fase += Math.min(v, 6) * dt * 2.6;
      const amp = o.vivo ? Math.min(1, v / 3) * (deitado ? 0.4 : 1) : 0, s = Math.sin(b.fase) * amp;
      for (const [L, sinal, x] of [["Left", 1, -1], ["Right", -1, 1]]) {
        const a = s * sinal * 0.7, j = a - Math.max(0, -s * sinal) * 0.9;
        if (ajoelhado) { apontarLocal(b, L + "UpLeg", 0, -1, -0.1); apontarLocal(b, L + "Leg", 0, -0.12, 1); }      // de joelhos: coxa em pé, canela para trás
        else { apontarLocal(b, L + "UpLeg", 0, -Math.cos(a), -Math.sin(a)); apontarLocal(b, L + "Leg", 0, -Math.cos(j), -Math.sin(j)); }
        const br = -s * sinal * 0.45;         // o braço balança ao contrário da perna
        apontarLocal(b, L + "Arm", x * b.lado * 0.16, -Math.cos(br), -Math.sin(br)); apontarLocal(b, L + "ForeArm", x * b.lado * 0.06, -Math.cos(br + 0.25), -Math.sin(br + 0.25));
      }
    } else {
      for (const n in b.acoes) { const a = b.acoes[n], w = a.getEffectiveWeight(); a.setEffectiveWeight(w + ((n === alvo ? 1 : 0) - w) * Math.min(1, 8 * dt)); }
      // o passo acompanha a velocidade de verdade, para o pé não escorregar no chão
      b.acoes.Walk.timeScale = Math.max(0.6, Math.min(1.9, v / (b.acoes.Walk.getClip().vel || 1.5))); b.acoes.Run.timeScale = Math.max(0.7, Math.min(1.8, v / (b.acoes.Run.getClip().vel || 4.2)));
      if (pst) {
        b.acoes.Prone.timeScale = Math.max(0.7, Math.min(2.4, v / 0.8)); b.acoes.CrouchWalk.timeScale = Math.max(0.6, Math.min(1.8, v / 1.65));
        if (!o.vivo && !b.caiu) { b.caiu = true; b.acoes.Death.reset().play(); } else if (o.vivo) b.caiu = false;      // cai uma vez e fica no chão
      }
      if (o.vivo || pst) b.mixer.update(dt);
      if (ajoelhado) { b.grupo.updateMatrixWorld(true); for (const L of ["Left", "Right"]) { apontarLocal(b, L + "UpLeg", 0, -1, -0.1); apontarLocal(b, L + "Leg", 0, -0.12, 1); } }      // de joelhos por cima da animação
    }
    // sem as animações de postura, o modelo inteiro é deitado ou achatado; com elas, a própria animação faz isso
    m.rotation.x += ((!pst && (!o.vivo || deitado) ? -Math.PI / 2 : 0) - m.rotation.x) * k;          // caído ou rastejando: de bruços
    m.position.y += ((ajoelhado && o.vivo && !deitado ? -0.4 : pst ? 0 : !o.vivo ? 0.18 : deitado ? 0.22 : 0) - m.position.y) * k;
    m.position.z += ((!pst && deitado ? 0.8 : 0) - m.position.z) * k;
    m.scale.y += ((!pst && o.agachado && o.vivo && !deitado ? 0.7 : 1) - m.scale.y) * k;
    b.fixa = pst ? 1 : 0;                              // a arma aponta para onde a pessoa olha, mesmo com o tronco girando na animação
    b.rente = (b.rente || 0) + ((pst && deitado && o.vivo ? 1 : 0) - (b.rente || 0)) * Math.min(1, 8 * dt);
    const longa = o.pose === "arma", comArma = o.vivo && (longa || o.pose === "pistola");
    b.mira = (b.mira || 0) + (Math.max(-0.7, Math.min(0.7, o.pitch || 0)) - (b.mira || 0)) * k;      // a arma acompanha a mira aos poucos, sem apontar para o chão
    // correndo, a arma longa vai baixa, cruzada no corpo; ao atirar sobe na hora e dá um coice; andando, balança de leve
    const desde = o.desdeTiro == null ? 9 : o.desdeTiro, coice = Math.max(0, 1 - desde / 0.13);
    b.baixa = (b.baixa || 0) + ((comArma && longa && !deitado && desde > 0.8 && v > 5 ? 1 : 0) - (b.baixa || 0)) * Math.min(1, (desde < 0.8 ? 22 : 7) * dt);
    b.passo = (b.passo || 0) + Math.min(v, 7) * dt * 2.9;
    const bal = Math.min(1, v / 3.5) * (deitado ? 0.3 : 1);
    b.pivo.rotation.x = b.mira * 0.9 - m.rotation.x - b.baixa * 0.8 + coice * 0.06 + Math.sin(b.passo * 2) * 0.018 * bal;
    b.pivo.rotation.y = b.baixa * 0.5 * b.lado + Math.sin(b.passo) * 0.03 * bal;
    b.pivo.position.set(0, Math.abs(Math.sin(b.passo)) * 0.012 * bal - b.baixa * 0.05, coice * 0.045).applyQuaternion(b.pivo.quaternion);
    b.pivo.position.y += b.rente * 0.07; b.pivo.position.z -= b.rente * 0.3;        // deitado, a arma vai à frente da cabeça
    b.arma.visible = comArma;
    if (comArma) {
      b.grupo.updateMatrixWorld(true);
      if (b.suporte && (b.fixa > 0.001 || b.suporteTorto)) {     // agachado, deitado ou no ar o tronco se inclina: a arma continua apontando para onde a pessoa olha
        const T = G.THREE, certo = b.suporte.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(m.getWorldQuaternion(new T.Quaternion()));
        b.suporte.quaternion.copy(b.suporteQ).slerp(certo, b.fixa); b.suporteTorto = b.fixa > 0.001; b.suporte.updateMatrixWorld(true);
      }
      alcancar(b, "Right", b.arma.localToWorld(b.rig ? new V3(MAO.x * b.lado, MAO.y, MAO.z) : new V3(0, -0.09, 0.07)), b.lado);
      if (longa) alcancar(b, "Left", b.arma.localToWorld(new V3(0, -0.04, -0.24)), -b.lado);
      else if (b.rig && o.pose === "pistola" && !(ARMAS[b.armaChave] || {}).faca) alcancar(b, "Left", b.arma.localToWorld(new V3(-0.035, -0.075, 0.06)), -b.lado);      // pistola com as duas mãos
      else if (b.suporte && pst) alcancar(b, "Left", b.suporte.localToWorld(new V3(-0.16 * b.lado, -0.24, -0.2)), -b.lado);      // de faca: a outra mão fica em guarda, na frente do peito
      if (b.rig) fecharDedos(b, "Right", 1); if (b.rig) fecharDedos(b, "Left", 1);
    } else if (o.vivo && o.pose === "festa") {          // salvo: pula de braços para cima
      const t = performance.now() / 1000; b.grupo.position.y += Math.abs(Math.sin(t * 7)) * 0.22; b.grupo.updateMatrixWorld(true);
      alcancar(b, "Right", m.localToWorld(new V3(0.32 * b.lado, 2 + Math.sin(t * 9) * 0.08, -0.05)), b.lado); alcancar(b, "Left", m.localToWorld(new V3(-0.32 * b.lado, 2 + Math.cos(t * 9) * 0.08, -0.05)), -b.lado);
    } else if (o.vivo && o.pose === "preso") {          // pulsos amarrados (para trás no modelo civil, à frente nos outros)
      b.grupo.updateMatrixWorld(true);
      const z = b.rig ? 0.17 : -0.2;
      alcancar(b, "Right", m.localToWorld(new V3(0.05 * b.lado, 0.97, z)), b.lado); alcancar(b, "Left", m.localToWorld(new V3(-0.05 * b.lado, 0.97, z)), -b.lado);
    }
  }

  // texturas desenhadas na hora (trama de tecido, camuflagem, pele, cabelo), usadas como cor e como relevo
  let texturas = null;
  function texturasDeRoupa() {
    if (texturas) return texturas;
    const T = G.THREE;
    const faz = (desenho, vezes) => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 128; const c = cv.getContext("2d"); desenho(c);
      const d = c.getImageData(0, 0, 128, 128);                      // grão
      for (let i = 0; i < d.data.length; i += 4) { const n = (Math.random() - 0.5) * 34; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
      c.putImageData(d, 0, 0);
      const t = new T.CanvasTexture(cv); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(vezes, vezes); if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
      return t;
    };
    const fundo = (c, cor) => { c.fillStyle = cor; c.fillRect(0, 0, 128, 128); };
    texturas = {
      tecido: faz(c => { fundo(c, "#dcdcdc"); c.strokeStyle = "rgba(0,0,0,.2)"; c.lineWidth = 1; for (let i = 0; i < 128; i += 6) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 128); c.moveTo(0, i); c.lineTo(128, i); c.stroke(); } }, 5),
      camuflagem: faz(c => {
        fundo(c, "#d2d2d2");
        for (let k = 0; k < 30; k++) { c.fillStyle = ["rgba(0,0,0,.42)", "rgba(0,0,0,.22)", "rgba(255,255,255,.22)"][k % 3]; c.beginPath(); c.ellipse(Math.random() * 128, Math.random() * 128, 8 + Math.random() * 16, 5 + Math.random() * 9, Math.random() * 3, 0, 6.3); c.fill(); }
      }, 2),
      pele: faz(c => fundo(c, "#f2f2f2"), 2),
      cabelo: faz(c => { fundo(c, "#e0e0e0"); c.strokeStyle = "rgba(0,0,0,.3)"; for (let i = 0; i < 128; i += 3) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + (Math.random() - 0.5) * 6, 128); c.stroke(); } }, 2),
    };
    return texturas;
  }
  function criarBoneco({ nome, css, armado, civil, time }) {
    if (armado && time === "t" && civilModelo) return criarDoModelo(civilModelo, { nome, css, time });      // terrorista: gente comum de balaclava
    if (armado && soldado) return criarDoModelo(soldado, { nome, css, time });
    if (civil && civil.modelo && civilModelo) return criarDoModelo(civilModelo, { civil });
    const T = G.THREE, grupo = new T.Group(), corpo = new T.Group(), tronco = new T.Group(), r = civil || ROUPAS[time], tx = texturasDeRoupa();
    const mat = (hex, o) => new T.MeshStandardMaterial({ color: hex, roughness: 0.85, metalness: 0, ...o });
    const pano = (hex, estampa) => mat(hex, { map: tx[estampa || "tecido"], bumpMap: tx.tecido, bumpScale: 1.2 });
    const mCamisa = pano(r.camisa, r.estampa), mCalca = pano(r.calca, r.estampa), mPele = mat(r.pele, { roughness: 0.62, map: tx.pele }), mEscuro = pano(0x15171a),
      mCabelo = mat(r.cabelo || 0x1a1410, { roughness: 0.7, map: tx.cabelo, bumpMap: tx.cabelo, bumpScale: 1.5 }), mSapato = mat(r.sapato || 0x1b1b1d, { roughness: 0.5 });
    const add = (pai, geo, m, x, y, z) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; pai.add(o); return o; };
    const cil = (cima, baixo, alt) => new T.CylinderGeometry(cima, baixo, alt, 14), bola = raio => new T.SphereGeometry(raio, 18, 14),
      capsula = (raio, comp) => new T.CapsuleGeometry(raio, comp, 4, 12), fem = r.quem === "mulher";
    const perna = x => {
      const coxa = new T.Group(); coxa.position.set(x, 0.92, 0); corpo.add(coxa);
      add(coxa, cil(0.088, 0.066, 0.44), mCalca, 0, -0.22, 0);
      const canela = new T.Group(); canela.position.y = -0.45; coxa.add(canela);
      const mCanela = r.bermuda ? mPele : mCalca;
      add(canela, bola(0.067), armado ? mEscuro : mCanela, 0, 0, 0);                         // joelho (joelheira nos jogadores)
      add(canela, cil(0.062, 0.046, 0.4), mCanela, 0, -0.2, 0);
      if (r.bermuda) add(canela, cil(0.05, 0.048, 0.09), mat(0xe8e4da), 0, -0.35, 0);        // meia
      if (armado) add(canela, cil(0.058, 0.054, 0.17), mSapato, 0, -0.32, 0);                // cano da bota
      add(canela, bola(0.06), mSapato, 0, -0.425, -0.05).scale.set(0.85, 0.62, 2);           // pé
      return { coxa, canela };
    };
    const pernas = [perna(-0.095), perna(0.095)];
    tronco.position.y = 0.92; corpo.add(tronco);
    const fatia = (m, rBaixo, rCima, y0, y1, fundo) => { const o = add(tronco, cil(rCima, rBaixo, y1 - y0), m, 0, (y0 + y1) / 2, 0); o.scale.z = fundo || 0.64; return o; };
    fatia(mCalca, 0.15, 0.168, -0.07, 0.1, 0.68);                                            // quadril
    if (fem) { fatia(mCamisa, 0.172, 0.132, 0.05, 0.26); fatia(mCamisa, 0.132, 0.168, 0.26, 0.48); fatia(mCamisa, 0.168, 0.07, 0.48, 0.6); }
    else {
      fatia(mCamisa, 0.162, 0.158, 0.08, 0.28); fatia(mCamisa, 0.158, 0.19, 0.28, 0.49); fatia(mCamisa, 0.19, 0.075, 0.49, 0.6);
      if (!r.bermuda) fatia(mEscuro, 0.167, 0.167, 0.075, 0.11, 0.66);                       // cinto
    }
    if (r.listra) fatia(mat(r.listra), 0.172, 0.181, 0.36, 0.42, 0.65);                      // listra na camiseta
    add(tronco, cil(0.046, 0.052, 0.1), mPele, 0, 0.63, 0);                                  // pescoço
    const colete = new T.Group(); colete.visible = false; tronco.add(colete);
    if (armado) {
      const mColete = pano(r.colete), mBolso = pano(r.colete); mBolso.color.offsetHSL(0, 0, 0.09);
      // equipamento que todo jogador leva: cinto com bolsos, coldre na coxa e a marca do time
      for (const x of [-0.15, 0.15]) add(tronco, new T.BoxGeometry(0.06, 0.09, 0.1), mBolso, x, 0.06, 0);
      add(pernas[1].coxa, new T.BoxGeometry(0.05, 0.16, 0.09), mBolso, 0.07, -0.16, 0);
      if (time === "p") {
        const cv = document.createElement("canvas"); cv.width = 256; cv.height = 80; const c = cv.getContext("2d");
        c.fillStyle = "#10151d"; c.fillRect(0, 0, 256, 80); c.fillStyle = "#e8e4da"; c.textAlign = "center"; c.textBaseline = "middle";
        c.font = '700 54px "Barlow Condensed", Arial, sans-serif'; c.fillText("POLÍCIA", 128, 44);
        const mLetreiro = new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv) }), gLetreiro = new T.PlaneGeometry(0.24, 0.075);
        add(tronco, gLetreiro, mLetreiro, 0, 0.42, 0.124); add(colete, gLetreiro, mLetreiro, 0, 0.42, 0.151);     // nas costas, com e sem colete
      } else {
        const l = add(tronco, new T.TorusGeometry(0.075, 0.032, 8, 18), pano(0x8a7a52), 0, 0.6, 0.005); l.rotation.x = Math.PI / 2; l.scale.set(1.15, 1, 1);   // lenço no pescoço
        const b = add(tronco, new T.BoxGeometry(0.07, 0.62, 0.02), pano(0x2a2118), 0, 0.33, -0.128); b.rotation.z = 0.6;                                      // bandoleira
      }
      add(colete, cil(0.2, 0.182, 0.36), mColete, 0, 0.35, 0).scale.z = 0.74;
      for (const x of [-0.105, 0.105]) add(colete, new T.BoxGeometry(0.07, 0.05, 0.21), mColete, x, 0.555, 0);         // alças
      for (const x of [-0.1, 0, 0.1]) add(colete, new T.BoxGeometry(0.08, 0.1, 0.045), mBolso, x, 0.26, -0.15);        // bolsos
    }
    const cabeca = new T.Group(); cabeca.position.y = 0.75; cabeca.scale.setScalar(r.cabecaEscala || 1); tronco.add(cabeca);
    const balaclava = r.cabeca === "balaclava", mRosto = balaclava ? mEscuro : mPele, mBranco = mat(0xf2efe8, { roughness: 0.4 });
    add(cabeca, bola(0.105), mRosto, 0, 0, 0).scale.set(0.9, 1.12, 0.98);
    add(cabeca, bola(0.078), mRosto, 0, -0.058, -0.012).scale.set(0.95, 0.85, 1);            // queixo
    if (balaclava) add(cabeca, new T.BoxGeometry(0.135, 0.036, 0.03), mPele, 0, 0.018, -0.08);   // só os olhos de fora
    else {
      add(cabeca, bola(0.016), mPele, 0, -0.01, -0.103).scale.set(0.85, 1.3, 1);             // nariz
      for (const x of [-0.094, 0.094]) add(cabeca, bola(0.022), mPele, x, -0.002, 0.008).scale.set(0.45, 1, 0.7);     // orelhas
      add(cabeca, new T.BoxGeometry(0.036, 0.007, 0.01), mat(0x7a3b34), 0, -0.052, -0.093);  // boca
      for (const x of [-0.036, 0.036]) add(cabeca, new T.BoxGeometry(0.034, 0.007, 0.012), mCabelo, x, 0.044, -0.093);  // sobrancelhas
    }
    for (const x of [-0.036, 0.036]) { add(cabeca, bola(0.015), mBranco, x, 0.018, -0.088).scale.z = 0.6; add(cabeca, bola(0.008), mEscuro, x, 0.018, -0.095); }
    if (!balaclava) {
      if (r.careca) add(cabeca, new T.SphereGeometry(0.111, 18, 10, -0.15 * Math.PI, 1.3 * Math.PI, 0.22 * Math.PI, 0.36 * Math.PI), mCabelo, 0, 0, 0).scale.set(0.93, 1.12, 1);
      else { const c = add(cabeca, new T.SphereGeometry(0.113, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), mCabelo, 0, 0.012, 0.012); c.scale.set(0.93, 1.12, 1.02); c.rotation.x = 0.3; }
      if (r.franja) add(cabeca, new T.BoxGeometry(0.15, 0.03, 0.03), mCabelo, 0, 0.082, -0.08).rotation.x = -0.35;
      if (r.cabeloLongo) {
        add(cabeca, capsula(0.08, 0.22), mCabelo, 0, -0.11, 0.066).scale.set(1.3, 1, 0.6);
        for (const x of [-0.093, 0.093]) add(cabeca, capsula(0.028, 0.15), mCabelo, x, -0.085, 0.02);
      }
      if (r.bigode) add(cabeca, new T.BoxGeometry(0.07, 0.016, 0.02), mCabelo, 0, -0.034, -0.097);
      if (r.oculos) {
        const mAro = mat(0x1a1a1a, { roughness: 0.3, metalness: 0.6 });
        for (const x of [-0.036, 0.036]) add(cabeca, new T.TorusGeometry(0.021, 0.0035, 6, 18), mAro, x, 0.018, -0.1);
        add(cabeca, new T.BoxGeometry(0.03, 0.004, 0.004), mAro, 0, 0.02, -0.1);
      }
    }
    const capacete = new T.Group(), bone = new T.Group(); capacete.visible = false; cabeca.add(capacete, bone);
    if (r.cabeca === "bone") {                 // boné do policial (some quando ele põe o capacete)
      const mBone = pano(0x141b29);
      add(bone, new T.SphereGeometry(0.116, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), mBone, 0, 0.03, 0.004).scale.set(0.95, 1, 1.04);
      add(bone, new T.BoxGeometry(0.15, 0.012, 0.1), mBone, 0, 0.055, -0.13).rotation.x = 0.18;
    }
    if (armado) {
      const mCasco = mat(time === "p" ? 0x141b29 : 0x2b2d24, { roughness: 0.5, metalness: 0.2 });
      add(capacete, new T.SphereGeometry(0.127, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.56), mCasco, 0, 0.018, 0.004).scale.set(0.96, 1.08, 1.06);
      add(capacete, new T.BoxGeometry(0.17, 0.034, 0.02), mat(0x0a0d12, { roughness: 0.2, metalness: 0.5 }), 0, 0.07, -0.118).rotation.x = -0.25;   // óculos na testa
      for (const x of [-0.105, 0.105]) add(capacete, new T.BoxGeometry(0.012, 0.11, 0.03), mEscuro, x, -0.05, 0);       // jugular
    }
    const cordas = [];
    const braco = x => {
      const ombro = new T.Group(); ombro.position.set(x, 0.52, 0); tronco.add(ombro);
      add(ombro, bola(0.054), mCamisa, 0, -0.01, 0);
      add(ombro, cil(0.054, 0.045, 0.27), mCamisa, 0, -0.145, 0);
      if (armado) add(ombro, cil(0.058, 0.056, 0.05), mat(r.faixa, { emissive: r.faixa, emissiveIntensity: 0.6 }), 0, -0.13, 0);   // faixa do time
      const ante = new T.Group(); ante.position.y = -0.29; ombro.add(ante);
      const mManga = r.mangaCurta ? mPele : mCamisa;
      add(ante, bola(0.045), mManga, 0, 0, 0);
      add(ante, cil(0.043, 0.034, 0.23), mManga, 0, -0.125, 0);
      add(ante, bola(0.04), armado ? mEscuro : mPele, 0, -0.272, 0).scale.set(0.85, 1.25, 0.62);                        // mão (luva nos jogadores)
      if (civil) { const c = add(ante, new T.TorusGeometry(0.038, 0.011, 6, 14), mat(0xb9a070), 0, -0.225, 0); c.rotation.x = Math.PI / 2; cordas.push(c); }
      return { ombro, ante };
    };
    const largo = fem ? 0.195 : 0.215, bracos = [braco(-largo), braco(largo)];
    const arma = new T.Group(); bracos[1].ante.add(arma);          // o que vai na mão direita (ver armarBoneco)
    grupo.add(corpo);
    let placa = null;
    if (armado) { placa = criarPlaca(nome, css); placa.position.y = 2.05; grupo.add(placa); }
    if (civil) grupo.scale.setScalar(civil.escala);
    grupo.visible = false;
    G.scene.add(grupo);
    const b = { grupo, corpo, tronco, pernas, bracos, placa, arma, colete, capacete, bone, cordas, armaChave: null, curvado: !!r.curvado, ult: new V3(), andar: 0, fase: 0 };
    if (civil) { armarBoneco(b, "p_pistola"); arma.visible = false; }
    return b;
  }
  // põe na mão do boneco a mesma arma que o jogador carrega (cópia do modelo do jogo). Com o braço estendido,
  // o lado "-y" do antebraço aponta para a frente e o "-z" para cima.
  function armarBoneco(b, chave) {
    chave = chave && ARMAS[chave] ? chave : null;
    if (b.armaChave === chave) return;
    b.armaChave = chave;
    while (b.arma.children.length) b.arma.remove(b.arma.children[0]);
    if (!chave) return;
    const c = copiaDaArma(chave);
    if (b.modelo) { if (ARMAS[chave].faca) c.scale.setScalar(1.4); return b.arma.add(c); }      // no soldado a arma já fica de frente
    c.rotation.x = -Math.PI / 2;
    if (ARMAS[chave].faca) { c.scale.setScalar(1.4); c.position.set(0, -0.3, 0); } else c.position.set(-0.02, -0.35, -0.1);
    b.arma.add(c);
  }
  // placa com o nome em cima da cabeça: letra grande com contorno, do mesmo tamanho na tela de perto ou de longe
  function criarPlaca(texto, css, grande) {
    const T = G.THREE, cv = document.createElement("canvas"); cv.width = 512; cv.height = 128;
    const c = cv.getContext("2d"); c.font = `700 ${grande ? 92 : 78}px "Barlow Condensed", Arial, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.lineJoin = "round";
    const larg = c.measureText(texto).width, k = larg > 480 ? 480 / larg : 1;
    c.save(); c.translate(256, 66); c.scale(k, 1);
    c.lineWidth = 14; c.strokeStyle = "rgba(0,0,0,.9)"; c.strokeText(texto, 0, 0); c.fillStyle = "#ffffff"; c.fillText(texto, 0, 0); c.restore();
    c.fillStyle = css; c.fillRect(256 - Math.min(240, larg * k / 2), 112, Math.min(480, larg * k), 10);      // faixa da cor do time embaixo do nome
    const tex = new T.CanvasTexture(cv); if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    const s = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false }));
    s.scale.set(0.17, 0.0425, 1);
    return s;
  }
  // aviso de baixas (lado direito, embaixo do mapa): fica 7 s na tela
  let baixasEl = null;
  function avisarBaixa(html, minha) {
    if (!baixasEl) { baixasEl = document.createElement("div"); baixasEl.className = "mp-baixas"; document.getElementById("app").appendChild(baixasEl); }
    const li = document.createElement("div"); li.className = "mp-baixa" + (minha ? " minha" : ""); li.innerHTML = html; baixasEl.appendChild(li);
    while (baixasEl.children.length > 5) baixasEl.removeChild(baixasEl.firstChild);
    setTimeout(() => { li.classList.add("some"); setTimeout(() => li.remove(), 500); }, 7000);
  }
  function removerBoneco(j) {
    if (!j.boneco) return;
    if (j.boneco.mixer) j.boneco.mixer.stopAllAction();
    G.scene.remove(j.boneco.grupo);
    j.boneco.grupo.traverse(o => { if (o.userData.emprestado) return; if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    j.boneco = null;
  }
  // Coloca o boneco no lugar e anima: passada conforme o quanto andou, pose dos braços, agachado, sentado e caído.
  // pose: "arma" (arma longa nas duas mãos), "pistola" (braço direito estendido), "solto" (braços ao longo do corpo)
  // ou "preso" (pulsos amarrados à frente).
  function posar(b, cur, yaw, k, dt, o) {
    if (b.modelo) return posarModelo(b, cur, yaw, k, dt, o);
    const vel = dt > 0 ? Math.hypot(cur.x - b.ult.x, cur.z - b.ult.z) / dt : 0, sentado = !!o.sentado && o.vivo, deitado = !!o.deitado && o.vivo;
    b.ult.copy(cur);
    b.grupo.position.copy(cur);
    let d = yaw - b.grupo.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
    b.grupo.rotation.y += d * k;
    b.andar += ((o.vivo && !sentado && vel > 0.4 ? Math.min(1, vel / 3) : 0) - b.andar) * k;
    b.fase += Math.min(vel, 6) * dt * 2.6;
    const s = Math.sin(b.fase) * b.andar, ir = (obj, eixo, alvo) => { obj.rotation[eixo] += (alvo - obj.rotation[eixo]) * k; };
    b.pernas.forEach((p, i) => {
      const lado = i ? -s : s;
      ir(p.coxa, "x", !o.vivo ? 0 : sentado ? 2.2 : lado * (deitado ? 0.3 : 0.7)); ir(p.canela, "x", !o.vivo ? 0 : sentado ? -1.95 : -Math.max(0, -lado) * 0.9);
    });
    const [esq, dir] = b.bracos;
    let ex = 0, ez = 0, ea = 0, dx = 0, dz = 0, da = 0;                        // ombro x, ombro z, cotovelo
    if (!o.vivo) { /* braços soltos */ }
    else if (deitado) { ex = dx = o.pose === "preso" ? 2.6 : 2.85; ez = o.pose === "solto" ? 0.1 : 0.3; dz = -ez; ea = da = o.pose === "preso" ? 0.5 : 0.25; }   // rastejando, braços à frente
    else if (o.pose === "arma") { ex = dx = Math.PI / 2 + o.pitch * 0.9; ez = 0.42; dz = -0.1; }
    else if (o.pose === "preso") { ex = dx = sentado ? 0.75 : 0.35; ez = 0.3; dz = -0.3; ea = da = 0.9; }
    else if (o.pose === "solto") { ex = -s * 0.5; dx = s * 0.5; ea = da = 0.15; }
    else { dx = Math.PI / 2 - 0.08 + (o.pitch || 0) * 0.9; dz = -0.1; ex = -s * 0.5; ea = 0.2; }
    ir(esq.ombro, "x", ex); ir(esq.ombro, "z", ez); ir(esq.ante, "x", ea);
    ir(dir.ombro, "x", dx); ir(dir.ombro, "z", dz); ir(dir.ante, "x", da);
    ir(b.tronco, "x", !o.vivo ? 0 : sentado ? -0.12 : deitado ? 0.12 : (b.curvado ? -0.22 : -0.04) - b.andar * 0.06);
    b.corpo.scale.y += ((o.agachado && o.vivo ? 0.68 : 1) - b.corpo.scale.y) * k;
    b.corpo.rotation.x += ((o.vivo && !deitado ? 0 : -Math.PI / 2) - b.corpo.rotation.x) * k;   // caído ou rastejando: de bruços
    b.corpo.position.y += ((!o.vivo ? 0.16 : deitado ? 0.2 : sentado ? -0.72 : 0) - b.corpo.position.y) * k;
    b.corpo.position.z += ((deitado ? 0.8 : 0) - b.corpo.position.z) * k;              // deitado, o corpo fica centrado no lugar da pessoa
    for (const c of b.cordas) c.visible = o.vivo && o.pose === "preso";
  }
  function atualizarBonecos(dt) {
    const meuTime = eu() && eu().time, k = 1 - Math.exp(-18 * dt);
    const vejoDuto = noDuto(G.camera.position) || noDuto(G.player.pos);      // só quem também está no duto vê quem está lá dentro
    for (const j of mp.jogadores.values()) {
      if (j.id === mp.meuId) continue;
      if (j.boneco && (j.boneco.time !== j.time || j.boneco.nome !== j.nome)) removerBoneco(j);
      if (!j.boneco) { j.boneco = criarBoneco({ nome: j.nome, css: TIMES[j.time].css, armado: true, time: j.time }); j.boneco.time = j.time; j.boneco.nome = j.nome; }
      if (j.cur.distanceToSquared(j.pos) > 64) j.cur.copy(j.pos); else j.cur.lerp(j.pos, k);   // passagem secreta: aparece direto
      if (!j.vivo && j.pos.y > -40) {                 // morto: o corpo cai até o piso que houver embaixo
        if (j.quedaY == null) { j.quedaY = j.cur.y; j.quedaV = 0; }
        let piso = 0; try { piso = G.physics.groundHeight(j.cur.x, j.cur.z, j.quedaY + 0.3); } catch {}
        j.quedaV += 20 * dt; j.quedaY = Math.max(piso, j.quedaY - j.quedaV * dt); j.cur.y = j.quedaY;
      } else j.quedaY = null;
      const b = j.boneco, a = ARMAS[j.arma], v = VARIANTES[j.arma];
      b.grupo.visible = j.pos.y > -40 && !(noDuto(j.cur) && !vejoDuto);      // quem está dentro do duto não aparece para quem está fora
      armarBoneco(b, j.vivo ? j.arma : null);
      b.colete.visible = !!(j.armadura & 1); b.capacete.visible = !!(j.armadura & 2); b.bone.visible = !b.capacete.visible;
      j.deitado = noDuto(j.cur) || !!j.noChao;
      { const vy = dt > 0 && j.curY != null ? (j.cur.y - j.curY) / dt : 0; j.curY = j.cur.y;      // subindo ou caindo rápido, fora de escada: está no ar
        j.arT = Math.abs(vy) > 1.3 && Math.abs(vy) < 40 && !j.deitado && !escadaEm(j.cur, 0.8) ? 0.18 : (j.arT || 0) - dt; }
      posar(b, j.cur, j.yaw, k, dt, { vivo: j.vivo, agachado: j.agachado && !j.deitado, deitado: j.deitado, noAr: j.arT > 0, pitch: j.pitch, desdeTiro: (performance.now() - (j.tiroVisto || -1e6)) / 1000, pose: !a ? "solto" : a.faca || (v && v.curta) ? "pistola" : "arma" });
      b.placa.visible = j.vivo && j.time === meuTime;
      const al = j.alvo;
      if (al) {
        al.alive = j.vivo && mp.fase === "valendo"; al.crouching = j.agachado; al.yaw = j.yaw; al.pitch = j.pitch;
        al.eye.set(j.cur.x, j.cur.y + (j.agachado ? 1.05 : 1.62), j.cur.z);
        al.forward.set(-Math.sin(j.yaw), 0, -Math.cos(j.yaw));
      }
    }
    for (const r of mp.refens) {
      const antes = r.cur.clone();
      if (r.cur.distanceToSquared(r.pos) > 64) r.cur.copy(r.pos); else r.cur.lerp(r.pos, k);
      const dx = r.cur.x - antes.x, dz = r.cur.z - antes.z, lim = 0.6 * dt;
      r.miraT = (r.miraT || 0) - dt;
      if (r.estado === 1 && r.miraT <= 0 && dx * dx + dz * dz > lim * lim) r.yaw = Math.atan2(-dx, -dz);   // só vira quando anda de verdade
      const festa = r.estado === 2 && r.salvoEm && performance.now() - r.salvoEm < 4500;      // salvo: comemora uns segundos antes de sumir
      r.boneco.grupo.visible = (r.estado !== 2 || !!festa) && !(noDuto(r.cur) && !vejoDuto);
      posar(r.boneco, r.cur, r.yaw || 0, k, dt, { vivo: r.estado !== 3, agachado: r.estado === 1 && r.post === 1, noAr: r.estado === 1 && Math.abs(r.cur.y - antes.y) > 1.3 * dt && !escadaEm(r.cur, 0.9), pitch: 0, desdeTiro: (performance.now() - (r.tiroVisto || -1e6)) / 1000, pose: festa ? "festa" : r.estado === 1 ? "pistola" : "preso", sentado: r.estado === 0 && !!r.civil.senta && !r.boneco.modelo, ajoelhado: r.estado === 0, deitado: noDuto(r.cur) || (r.estado === 1 && r.post === 2) });
      r.boneco.arma.visible = r.estado === 1;                 // solto pelo policial, já armado
      r.boneco.colete.visible = !!(r.prot & 1) && r.estado !== 3; r.boneco.capacete.visible = !!(r.prot & 2) && r.estado !== 3;
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
        melhor = { dist: t, cabeca: y > base.y + altura - 0.32, perna: altura > 1 && y < base.y + altura * 0.42, ponto: new V3(o.x + dir.x * t, y, o.z + dir.z * t), ...extra };
      }
    };
    for (const j of mp.jogadores.values()) if (j.id !== mp.meuId && j.vivo && j.time !== meuTime) testar(j.cur, j.deitado ? 0.6 : j.agachado ? 1.15 : 1.7, { j });
    for (const r of mp.refens) if (r.estado < 2) testar(r.cur, noDuto(r.cur) ? 0.6 : (r.estado === 0 ? (r.boneco.modelo ? 1.32 : r.civil.senta ? 1.08 : 1.7) : 1.7) * r.civil.escala, { r });
    return melhor;
  }
  // MIRA AJUDADA (só no fácil e no médio): se o tiro ia passar raspando um inimigo ou uma máquina, ele é puxado para o alvo.
  // Quem já está mirando em cima do alvo não é mexido (o tiro na cabeça continua sendo de quem mirou na cabeça).
  const AJUDA_MIRA = { facil: 0.07, medio: 0.04 };      // ângulo, em radianos (4 e 2,3 graus)
  function miraAjudada(o, dir) {
    const ang = mp.superUsado ? 2 * (AJUDA_MIRA[mp.dificuldade] || 0.04) : AJUDA_MIRA[mp.dificuldade]; if (!ang) return dir;      // com o super poder, o dobro da ajuda dos outros
    try {
      if (raioEmPessoas(o, dir, 300) || G.enemies.raycast(o, dir, 300)) return dir;
      const meuTime = eu() && eu().time, cosMin = Math.cos(ang); let melhor = null, cMelhor = cosMin;
      const ver = p => {
        const v = p.clone().sub(o), d = v.length(); if (d < 0.5 || d > 150) return;
        const c = v.dot(dir) / d; if (c <= cMelhor) return;
        let livre = false; try { livre = G.physics.lineOfSight(o, p); } catch {}
        if (livre) { cMelhor = c; melhor = v.multiplyScalar(1 / d); }
      };
      for (const j of mp.jogadores.values()) if (j.id !== mp.meuId && j.vivo && j.time !== meuTime && !(noDuto(j.cur) && !noDuto(G.player.pos))) ver(new V3(j.cur.x, j.cur.y + meioDoCorpo(j), j.cur.z));
      for (const e of G.enemies.list) if (e.alive) ver(e.pos.clone());
      return melhor || dir;
    } catch { return dir; }
  }
  function instalarTiros() {
    const original = G.combat.playerShot;
    const umTiro = (o, dir, opt) => {
      const alcance = opt.range || 300, h = raioEmPessoas(o, dir, alcance);
      if (h) {
        const parede = G.physics.raycast(o, dir, alcance), maq = G.enemies.raycast(o, dir, parede ? parede.dist : alcance);
        if ((!parede || h.dist < parede.dist) && (!maq || h.dist < maq.dist)) {
          const sniper = !!(ARMAS[mp.arma] && ARMAS[mp.arma].mata), bago = !!opt.bago;
          const q = bago ? opt.damage * (h.cabeca ? CFG.danoCabeca : 1) : h.cabeca ? 999 : h.perna ? Math.round(CFG.danoMembro[0] + Math.random() * (CFG.danoMembro[1] - CFG.danoMembro[0])) : CFG.danoTronco;
          const qf = mp.superUsado && q < 900 ? Math.round(q * 1.5) : q;      // super poder: 50% a mais de dano
          G.combat.stats.shots++; G.combat.stats.hits++;
          if (h.j) enviar(sniper ? { t: "acerto", em: h.j.id, q: 999, de: arr(o) } : { t: "acerto", em: h.j.id, q: qf, de: arr(o), c: h.cabeca ? 1 : h.perna ? 2 : 0 });   // a sniper mata com um tiro, com ou sem colete
          else enviar({ t: "acertoRefem", i: h.r.i, c: h.cabeca ? 1 : 0, s: sniper ? 1 : 0 });      // refém só se fere com tiro na cabeça; no corpo, só perde o colete
          G.hud.hitmarker(h.cabeca ? "weak" : "hit");
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
      if (!a.chumbo) return umTiro(o, miraAjudada(o, dir), opt);
      let primeiro = null;
      for (let k = 0; k < a.chumbo; k++) {            // a 12: vários bagos espalhados, só de perto
        const d = dir.clone(); d.x += (Math.random() - 0.5) * 0.11; d.y += (Math.random() - 0.5) * 0.08; d.z += (Math.random() - 0.5) * 0.11; d.normalize();
        const r = umTiro(o, d, { ...opt, damage: DANO_CHUMBO, range: a.alcance, bago: true });
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
      if (emRodada() && a && a.rpm) { mp.cadT = 60 / a.rpm - 0.01; mp.pulso = 0; if (mp.rajada > 0) mp.rajada--; }
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
      G.hud.message("Você caiu — aguarde a próxima rodada", 3); mp.morriEm = performance.now(); mp.assistindo = null;
    });
  }
  function tiroRemoto(m) {
    if (!emRodada() || m.id === mp.meuId) return;
    const o = new V3().fromArray(m.o), e = new V3().fromArray(m.e), quem = mp.jogadores.get(m.id);
    if (quem) quem.tiroVisto = performance.now();          // o boneco dá o coice e levanta a arma
    if (m.id === "refem") for (const r of mp.refens)          // o refém vira para onde atirou
      if (r.estado === 1 && Math.hypot(r.pos.x - o.x, r.pos.z - o.z) < 1.5) { r.yaw = Math.atan2(-(e.x - o.x), -(e.z - o.z)); r.miraT = 0.9; r.tiroVisto = performance.now(); }
    try { G.fx.tracer(o, e); } catch {}
    try { G.render.lightPool.flash(o, 16756832, 30, 8, 0.05); } catch {}
    tocar("rifle_shot", { pos: o });
  }

  /* ----------------------------------------------------------------- máquinas */
  // mirando com a sniper, a pessoa some para máquinas e bots (só gente de verdade a vê)
  const mirandoSniper = j => !j.bot && (j.id === mp.meuId ? !!mp.mirando : !!j.mirando);
  const armaDe = j => ARMAS[j.id === mp.meuId ? mp.arma : j.arma];
  let ninguem = null;
  function jogadoresVivos() {
    const l = [];
    for (const j of mp.jogadores.values()) if (j.vivo) l.push(j);
    return l;
  }
  function instalarMaquinas() {
    const dbg = G.enemies.debug;
    for (const e of [...dbg.gulls, ...dbg.hounds]) {
      const atualizar = e._update, dano = e.damage, ehDrone = dbg.gulls.includes(e);
      let alvoT = 0, alvo = null;
      // anfitrião: cada máquina persegue o jogador vivo mais próximo, seja ele local ou remoto
      e._update = dt => {
        if (!(emRodada() && mp.anfitriao)) return atualizar(dt);
        alvoT -= dt;
        if (alvoT <= 0 || (alvo && !alvo.alive)) {
          alvoT = 0.5; alvo = null; let melhor = 1e9, achou = false;
          if (e._antes) { const mx = e.pos.x - e._antes.x, mz = e.pos.z - e._antes.z, m = Math.hypot(mx, mz); if (m > 0.05) e._dir = [mx / m, mz / m]; }      // para onde a máquina está indo (é para lá que ela olha)
          (e._antes || (e._antes = new V3())).copy(e.pos);
          for (const j of jogadoresVivos()) {
            const p = posDe(j), d = p.distanceToSquared(e.pos);
            if (d >= melhor || mirandoSniper(j)) continue;
            if (ehDrone && p.y > ALTO) continue;                       // drone não pega quem está no alto
            if (!j.bot && armaDe(j) && armaDe(j).faca) {               // de faca: só se a máquina der de cara com a pessoa
              const dx = p.x - e.pos.x, dz = p.z - e.pos.z, r = Math.hypot(dx, dz) || 1, f = e._dir;
              if (r > 15 || !f || (dx * f[0] + dz * f[1]) / r < 0.5) continue;
              let livre = false; try { livre = G.physics.lineOfSight(new V3(e.pos.x, e.pos.y + 0.5, e.pos.z), new V3(p.x, p.y + 1.1, p.z)); } catch {}
              if (!livre) continue;
            }
            melhor = d; achou = true; alvo = j.id === mp.meuId ? null : j.alvo;
          }
          if (!achou) alvo = ninguem || (ninguem = criarAlvo({ cur: new V3(0, -300, 0), vivo: false }));      // ninguém à vista: não persegue nem atira
        }
        const real = G.player;
        if (alvo) G.player = alvo;
        try { atualizar(dt); } finally { G.player = real; }
        if (ehDrone) {                         // drone dentro de um container ou parede: sobe até passar por cima
          const q = e.pos;
          for (const b of G.physics.boxes) if (!b.playerOnly && q.x > b.min.x - 0.7 && q.x < b.max.x + 0.7 && q.z > b.min.z - 0.7 && q.z < b.max.z + 0.7 && q.y > b.min.y - 0.4 && q.y < b.max.y + 0.8 && b.max.y - b.min.y > 1.2) {
            q.y = Math.min(q.y + 6 * dt, b.max.y + 0.8); if (typeof e.alt === "number") e.alt = Math.max(e.alt, q.y);
            break;
          }
        }
      };
      // convidado: a máquina é uma marionete; quem decide o dano é o anfitrião
      e.damage = (q, ponto, dir, parte) => {
        if (emRodada() && !mp.anfitriao && !mp.aplicandoMorte) {
          enviar({ t: "acertoMaquina", id: e._idRede, q, parte: parte || "body", d: dir ? arr(dir) : null });
          G.events.emit("enemy:hit", { enemy: e, point: ponto, part: parte || "body" });
          return false;
        }
        return dano(emRodada() && !mp.aplicandoMorte ? q * ((dif().maq || {}).fraqueza || 1) : q, ponto, dir, parte);
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

  // desenha o painel da sala dos reféns: mapa visto de cima (norte para cima), o galpão e um X no ponto de resgate
  function desenharPainel(p, nome) {
    const tex = painel.material.map, c = tex.image.getContext("2d"), L = 1024, A = 640;
    const mx = x => 60 + (x + 40) / 80 * 560, mz = z => 150 + (z + 30) / 60 * 420;      // mapa: x -40..40, z -30..30
    c.fillStyle = "#101820"; c.fillRect(0, 0, L, A);
    c.strokeStyle = "#ffb347"; c.lineWidth = 8; c.strokeRect(10, 10, L - 20, A - 20);
    c.fillStyle = "#ffb347"; c.font = '900 64px "Big Shoulders Display", Impact, sans-serif'; c.textBaseline = "top";
    c.fillText("PONTO DE RESGATE", 56, 36);
    c.fillStyle = "#1b2a36"; c.fillRect(mx(-40), mz(-30), 560, 420);                       // pátio
    c.fillStyle = "#16405c"; c.fillRect(mx(30), mz(-30), mx(40) - mx(30), 420);            // mar
    c.strokeStyle = "rgba(232,228,218,.35)"; c.lineWidth = 2; c.setLineDash([8, 8]);
    for (const x of [-24, 16]) { c.beginPath(); c.moveTo(mx(x), mz(-30)); c.lineTo(mx(x), mz(30)); c.stroke(); }
    c.setLineDash([]);
    c.fillStyle = "#3a4650"; c.fillRect(mx(-16), mz(-28), mx(12) - mx(-16), mz(-11) - mz(-28));   // galpão
    c.fillStyle = "#e8e4da"; c.font = '600 22px "Barlow Condensed", Arial, sans-serif';
    c.fillText("GALPÃO · VOCÊ ESTÁ AQUI", mx(-16) + 8, mz(-28) + 8);
    c.fillStyle = "rgba(232,228,218,.55)"; c.fillText("PORTÃO", mx(-39), mz(27) - 4); c.fillText("PÁTIO", mx(-6), mz(27) - 4); c.fillText("CAIS", mx(19), mz(27) - 4);
    c.fillText("N", mx(-38), mz(-29)); c.fillText("▲", mx(-38) - 2, mz(-29) + 22);
    const x = mx(p[0]), z = mz(p[1]);
    c.strokeStyle = "#6fb6ff"; c.lineWidth = 5; c.setLineDash([14, 10]);                    // caminho sugerido, em linha reta
    c.beginPath(); c.moveTo(mx(-2), mz(-19.5)); c.lineTo(x, z); c.stroke(); c.setLineDash([]);
    c.strokeStyle = "#ff5a40"; c.lineWidth = 9; c.beginPath(); c.arc(x, z, 26, 0, 6.283); c.stroke();
    c.beginPath(); c.moveTo(x - 15, z - 15); c.lineTo(x + 15, z + 15); c.moveTo(x + 15, z - 15); c.lineTo(x - 15, z + 15); c.stroke();
    c.fillStyle = "#e8e4da"; c.font = '600 30px "Barlow Condensed", Arial, sans-serif'; c.fillText("LEVE OS REFÉNS PARA", 650, 170);
    c.fillStyle = "#ff5a40"; c.font = '900 62px "Big Shoulders Display", Impact, sans-serif';
    const palavras = String(nome || "").toUpperCase().split(" "); let linha = "", y = 214;
    for (const w of palavras) { if (c.measureText(linha + w).width > 340 && linha) { c.fillText(linha, 650, y); y += 66; linha = ""; } linha += w + " "; }
    c.fillText(linha, 650, y);
    c.fillStyle = "rgba(232,228,218,.7)"; c.font = '400 22px "IBM Plex Mono", monospace';
    ["X vermelho = resgate", "Marcador EX na bússola", "Segure E para soltar", "cada refém"].forEach((t, i) => c.fillText(t, 650, 420 + i * 30));
    tex.needsUpdate = true; painel.visible = true;
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
    { const p = posDe(alvo.j), dx = p.x - r.pos.x, dz = p.z - r.pos.z, d = Math.hypot(dx, dz) || 1; r.combateT = 1.8; r.alvoLado = [-dz / d, dx / d]; }   // em combate: vai se mexer de lado
    const acertou = Math.random() < ia.precisao * (dist < 10 ? 1.4 : dist > 20 ? 0.6 : 1), fim = alvo.peito.clone();
    if (!acertou) fim.add(new V3((Math.random() - 0.5) * 2.4, (Math.random() - 0.2) * 1.6, (Math.random() - 0.5) * 2.4));
    paraTodos({ t: "tiro", id: "refem", o: arr(olho), e: arr(fim) });
    if (acertou) ferirJogador(alvo.j, ia.dano, r.pos, "refem");
  }
  // anfitrião: o refém preso fica parado no lugar; o solto segue quem o soltou, desvia de quem mira nele e atira
  function moverRefens(dt) {
    const ia = dif().refem;
    for (const r of mp.refens) {
      if (r.estado > 1) continue;
      if (refemNoCarro(r, dt, ia)) continue;
      let wx = 0, wz = 0, ancora = r.casa, folga = 1.2, subir = null;
      if (r.estado === 1) {
        const lider = mp.jogadores.get(r.lider);
        if (!lider || !lider.vivo) { r.estado = 0; r.lider = null; r.casa.copy(r.pos); paraTodos({ t: "refem", i: r.i, ev: "largado" }); continue; }
        const lp = posDe(lider), dx = lp.x - r.pos.x, dz = lp.z - r.pos.z, d = Math.hypot(dx, dz);
        ancora = lp; folga = 2.6;
        // imita o líder: pula quando ele pula, abaixa ou deita quando ele abaixa ou deita
        { const euLider = lider.id === mp.meuId, vy = r.lpY != null ? (lp.y - r.lpY) / Math.max(dt, 0.001) : 0; r.lpY = lp.y;
          if (vy > 3 && vy < 12 && r.noChao && d < 5 && !escadaEm(lp, 0.9) && !escadaEm(r.pos, 0.9) && !noDuto(r.pos)) { r.vel.y = 6.4; r.noChao = false; }
          r.post = (euLider ? mp.deitado : lider.noChao) ? 2 : (euLider ? G.player.crouching : lider.agachado) ? 1 : 0; }
        r.atrasoT = d > 4.5 ? (r.atrasoT || 0) + dt : 0;        // ficou para trás (preso em alguma coisa)? depois de uns segundos reaparece junto do líder
        r.velLider = lider.rapidez || 0;
        if (d > 14 || r.atrasoT > 3.5) { r.pos.set(lp.x - dx / d * 1.2, lp.y, lp.z - dz / d * 1.2); r.trilha.length = 0; r.atrasoT = 0; r.vel.set(0, 0, 0); }   // o líder usou uma saída secreta, ou o refém ficou preso
        else if (Math.hypot(d, lp.y - r.pos.y) <= 1.5) {   // chegou: fica parado a um passo de distância (também na escada e no duto), guardando os últimos passos do líder
          const ult = r.trilha[r.trilha.length - 1];
          if (!ult || ult.distanceTo(lp) > 0.5) r.trilha.push(lp.clone());
          while (r.trilha.length > 8) r.trilha.shift();
          // se o líder veio para cima dele (por exemplo, voltando para sair do duto), recua para não ficar na frente
          if (d > 0.05 && Math.hypot(d, lp.y - r.pos.y) < 1.1 && !noMeioDaEscada(r.pos)) { wx = -dx / d * 0.8; wz = -dz / d * 0.8; }
        }      // chegou (contando a altura: na escada o líder fica abaixo)
        else {                                         // segue a trilha por onde o líder passou (funciona na porta e na escada)
          const ult = r.trilha[r.trilha.length - 1];
          if (!ult || ult.distanceTo(lp) > 0.5) r.trilha.push(lp.clone());
          while (r.trilha.length > 1 && Math.hypot(r.trilha[0].x - r.pos.x, r.trilha[0].z - r.pos.z) < 0.55 && Math.abs(r.trilha[0].y - r.pos.y) < 0.7) r.trilha.shift();
          const al = r.trilha[0], ax = al.x - r.pos.x, az = al.z - r.pos.z, ad = Math.hypot(ax, az) || 1, esc = escadaEm(r.pos, 0.8);
          const yAlvo = esc ? Math.max(esc.y0, Math.min(esc.y1, al.y + 0.1)) : 0;
          if (esc && Math.abs(yAlvo - r.pos.y) > 0.08 && (noMeioDaEscada(r.pos) || (Math.abs(al.y - r.pos.y) > 0.45 && Math.hypot(al.x - esc.x, al.z - esc.z) < 0.9))) subir = { e: esc, y: yAlvo };   // o caminho continua escada acima (ou abaixo)
          else if (ad > 0.05) { wx = ax / ad; wz = az / ad; }
        }
      }
      if (r.estado === 1) {
        if (!wx && !wz) {                              // parado perto de quem segue; só anda se ficou para trás
          const ox = ancora.x - r.pos.x, oz = ancora.z - r.pos.z, od = Math.hypot(ox, oz);
          if (od > folga) { wx = ox / od * 0.6; wz = oz / od * 0.6; }
        }
        r.combateT = (r.combateT || 0) - dt;
        const lado = inimigoMirando(r) || (r.combateT > 0 ? r.alvoLado : null);   // desvia para o lado (e às vezes pula) quando miram nele ou quando está trocando tiro
        if (lado) {
          r.ladoT -= dt;
          if (r.ladoT <= 0) { r.ladoT = 0.5 + Math.random() * 0.6; r.lado = Math.random() < 0.5 ? 1 : -1; if (r.noChao && Math.random() < ia.esquiva * 0.5) r.vel.y = 5; }
          wx += lado[0] * r.lado * ia.esquiva; wz += lado[1] * r.lado * ia.esquiva;
        }
      }
      // anda no passo do líder: se ele corre, o refém corre; se ficou para trás, aperta o passo
      const wl = Math.hypot(wx, wz), vel = r.estado === 1 ? Math.max(CFG.velRefem * r.civil.vel, Math.min(10, (r.velLider || 0) * 1.08 + (r.atrasoT > 0 ? 1.5 : 0))) : CFG.velRefem * r.civil.vel;
      if (wl > 1) { wx /= wl; wz /= wl; }
      r.medeT = (r.medeT || 0) - dt;
      if (r.estado === 1 && r.medeT <= 0) {
        r.medeT = 0.45;
        const andou = r.medePos ? Math.hypot(r.pos.x - r.medePos.x, r.pos.z - r.medePos.z) + Math.abs(r.pos.y - r.medePos.y) : 9; (r.medePos || (r.medePos = new V3())).copy(r.pos);
        if (andou < 0.2 && wl > 0.1 && !subir && r.noChao) {
          r.preso = (r.preso || 0) + 1;
          const topo = degrauNaFrente(r.pos, wx / wl, wz / wl, r.pos.y), lider = mp.jogadores.get(r.lider);
          r.vel.y = topo != null ? Math.sqrt(40 * (topo - r.pos.y + 0.35)) : 6; r.noChao = false;
          if (r.preso >= 3 && lider) { const lp = posDe(lider); r.pos.set(lp.x - wx / wl * 1.1, lp.y, lp.z - wz / wl * 1.1); r.trilha.length = 0; r.vel.set(0, 0, 0); r.preso = 0; }
        } else r.preso = 0;
      }
      r.vel.x = wx * vel; r.vel.z = wz * vel; r.vel.y -= 20 * dt;
      const yAntes = r.pos.y, naEscada = escadaEm(r.pos, 0.8), pendurado = !!naEscada && r.pos.y > naEscada.y0 + 0.2;
      if (subir) {                                      // sobe ou desce a escada de mão atrás de quem segue
        const dy = subir.y - r.pos.y, q = Math.min(1, 6 * dt);
        r.pos.x += (subir.e.x - r.pos.x) * q; r.pos.z += (subir.e.z - r.pos.z) * q; r.pos.y += Math.sign(dy) * Math.min(Math.abs(dy), 3 * dt);
        r.vel.set(0, 0, 0); r.noChao = true;
      } else {
        if (pendurado) r.vel.y = 0;                     // em cima do buraco da escada ele não cai
        let res = null; try { res = G.physics.moveCapsule(r.pos, r.vel, dt, 0.3, noDuto(r.pos) ? 1.1 : 1.7 * r.civil.escala, r.noChao); } catch {}
        r.noChao = !res || !!res.onGround;
        if (pendurado && r.pos.y < yAntes) { r.pos.y = yAntes; r.noChao = true; }
      }
      if (!subir)
      try {                                           // não atravessa piso fino (plataforma, degraus) ao cair
        const piso = G.physics.groundHeight(r.pos.x, r.pos.z, yAntes + 0.35);
        if (r.pos.y < piso && yAntes >= piso - 0.35) { r.pos.y = piso; r.noChao = true; }
      } catch {}
      if (r.noChao && r.vel.y < 0) r.vel.y = 0;
      if (r.pos.y < -1) { r.pos.y = 0; r.vel.y = 0; }
      if (r.estado === 1) atirarRefem(r, dt, ia);
      tentarSalvar(r);
    }
  }
  function tentarSalvar(r) {
    if (r.estado !== 1 || !mp.resgate) return;
    // salvo quando entra no ponto de resgate, ou quando o líder já está lá dentro e o refém vem logo atrás
    const lider = mp.jogadores.get(r.lider), lp = lider && lider.vivo ? posDe(lider) : null;
    const dentro = Math.hypot(r.pos.x - mp.resgate.x, r.pos.z - mp.resgate.z) < RAIO_RESGATE;
    const comLider = lp && Math.hypot(lp.x - mp.resgate.x, lp.z - mp.resgate.z) < RAIO_RESGATE && Math.abs(lp.y - r.pos.y) < 2.5 && Math.hypot(lp.x - r.pos.x, lp.z - r.pos.z) < 7;
    if (!dentro && !comLider) return;
    r.estado = 2;
    paraTodos({ t: "refem", i: r.i, ev: "salvo", id: r.lider });
    r.lider = null;
    if (mp.refens.every(x => x.estado === 2)) fimDaRodada("p", "Todos os reféns foram resgatados");
    else soltarOnda();
  }
  // policial: segurar E perto de um refém preso para soltá-lo
  function interagir(dt) {
    const j = eu(), p = G.player;
    if (j && p.alive && mp.fase === "valendo")
      for (const b of mp.bombas.values()) {
        if (Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) > 2.2 || Math.abs(b.pos.y - p.pos.y) > 2.5) continue;
        mp.desarmarT = G.input.down("interact") ? mp.desarmarT + dt / CFG.tempoDesarmar : Math.max(0, mp.desarmarT - dt * 2);
        if (mp.desarmarT >= 1) { mp.desarmarT = 0; enviar({ t: "desarmei", id: b.id }); }
        G.hud.setPrompt("Desarmar bomba · " + Math.ceil(b.t) + "s", Math.min(1, mp.desarmarT)); return true;
      }
    mp.desarmarT = 0;
    let perto = -1, dist = 2.2;
    if (j && j.time === "p" && p.alive && mp.fase === "valendo")
      for (const r of mp.refens) {
        if (r.estado !== 0) continue;
        const d = Math.hypot(r.cur.x - p.pos.x, r.cur.z - p.pos.z);
        if (d < dist && Math.abs(r.cur.y - p.pos.y) < 2.5) { dist = d; perto = r.i; }
      }
    if (perto < 0) { mp.pegando = -1; mp.pegarT = 0; G.hud.setPrompt(null); return false; }
    if (mp.pegando !== perto) { mp.pegando = perto; mp.pegarT = 0; }
    mp.pegarT = G.input.down("interact") ? mp.pegarT + dt / CFG.tempoPegar : Math.max(0, mp.pegarT - dt * 2);
    if (mp.pegarT >= 1) { mp.pegarT = 0; enviar({ t: "pegar", i: perto }); }
    G.hud.setPrompt("Soltar refém", Math.min(1, mp.pegarT)); return true;
  }
  // saídas secretas do galpão: pisou no círculo, aparece sempre no mesmo destino
  // E perto da porta da sala abre ou fecha; E em frente a uma porta secreta leva sempre ao mesmo lugar do mapa
  function pertoDaPorta() {
    const p = G.player, S = SALA;
    return Math.abs(p.pos.y - S.chao) < 1.2 && Math.hypot(p.pos.x - (S.porta[0] + S.porta[1]) / 2, p.pos.z - S.z1) < 1.3;
  }
  function portas(dt) {
    const p = G.player, S = SALA;
    mp.passagemT -= dt;
    const apertou = G.input.pressed("interact") && mp.passagemT <= 0;
    if (p.alive && mp.fase === "valendo" && Math.abs(p.pos.y - S.teto) < 0.8 && Math.hypot(p.pos.x - SECRETA[0], p.pos.z - SECRETA[1]) < 1.4) {
      G.hud.setPrompt("Saída secreta · destino surpresa", 0);
      if (apertou) {
        let q = null;
        for (let k = 0; k < 30 && !q; k++) {            // um ponto qualquer do mapa, no chão e fora do galpão
          let c = null; try { c = G.physics.nav.randomPoint(new V3(0, 0, 0), 38); } catch {}
          if (c && !(c.x > -17 && c.x < 13 && c.z < -10) && G.physics.groundHeight(c.x, c.z, 0.6) < 0.5) q = c;
        }
        if (!q) q = { x: RESGATES[4][0], z: RESGATES[4][1] };
        p.pos.set(q.x, 0.05, q.z); p.vel.set(0, 0, 0); mp.quedaTopo = 0.05;
        mp.passagemT = 1.5; (G.render.post || {}).flash = 0.6;
        tocar("objective"); G.hud.message("Saída secreta: você saiu em outro ponto do mapa", 3);
      }
      return;
    }
    if (!p.alive || mp.fase !== "valendo" || Math.abs(p.pos.y - S.chao) > 1.2) return;
    if (pertoDaPorta()) {
      G.hud.setPrompt(portaAberta ? "Fechar a porta" : "Abrir a porta", 0);
      if (apertou) { mp.passagemT = 0.5; enviar({ t: "porta", aberta: !portaAberta }); }
      return;
    }
    if (p.pos.x < S.x0 || p.pos.x > S.x1 || p.pos.z < S.z0 || p.pos.z > S.z1) return;      // portas secretas: só de dentro
    for (const [n, s] of PASSAGENS.entries()) {
      if (Math.hypot(p.pos.x - s.de[0], p.pos.z - s.de[1]) > 1.1) continue;
      G.hud.setPrompt("Saída " + (n + 1) + " · " + s.nome, 0);
      if (apertou) {
        p.pos.set(s.para[0], 0.05, s.para[1]); p.vel.set(0, 0, 0);
        mp.passagemT = 1.5; (G.render.post || {}).flash = 0.6;
        tocar("objective"); G.hud.message("Saída " + (n + 1) + " · " + s.nome, 2.5);
      }
      return;
    }
  }
  /* ------------------------------------------------------- sala dos reféns */
  // A casinha já existe no mapa, mas era um bloco maciço com a porta só desenhada. Na primeira rodada ela vira
  // uma sala de verdade: paredes com colisão no lugar do bloco, vão da porta recortado na geometria do jogo e a
  // chapa da porta girando na dobradiça.
  let salaPronta = false, portaAberta = false, portaAnim = 0, portaRef = null, portaGeo = null, portaIni = 0, portaOrig = null;
  function prepararSala() {
    if (salaPronta) return; salaPronta = true;
    const T = G.THREE, fis = G.physics, S = SALA, perto = (a, b) => Math.abs(a - b) < 0.12;
    const macico = fis.boxes.find(b => perto(b.min.x, S.x0) && perto(b.max.x, S.x1Antigo) && perto(b.min.z, S.z0) && perto(b.max.z, S.z1) && b.max.y - b.min.y > 2);
    if (macico) fis.removeBox(macico);
    const dx = S.x1 - S.x1Antigo;                        // quanto a parede leste andou
    // A parte nova da sala fica onde havia estantes do galpão mais altas que o piso dela: o que estava dentro some
    // e o que atravessava o piso é cortado na altura dele (na colisão e no desenho).
    const V = { x0: S.x1Antigo + 0.05, x1: S.x1 - 0.1, z0: S.z0 + 0.05, z1: S.z1 - 0.1, y0: S.chao + 0.05, y1: S.teto - 0.15 }, corte = S.chao - 0.14;
    const dentro = (ax, ay, az, bx, by, bz) => bx > V.x0 && ax < V.x1 && bz > V.z0 && az < V.z1 && by > V.y0 && ay < V.y1 && by < S.teto + 0.3;
    for (const b of [...fis.boxes]) if (dentro(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z)) { if (b.min.y >= corte) fis.removeBox(b); else b.max.y = corte; }
    const m4 = new T.Matrix4(), p3 = new V3(), nada = new T.Matrix4().makeScale(0, 0, 0);
    G.scene.traverse(o => {
      if (!o.isMesh || !o.parent || o.parent === cenario) return;
      if (o.isInstancedMesh) {
        let mudou = false;
        for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m4); p3.setFromMatrixPosition(m4).applyMatrix4(o.matrixWorld); if (p3.x > V.x0 && p3.x < V.x1 && p3.z > V.z0 && p3.z < V.z1 && p3.y > corte && p3.y < V.y1) { o.setMatrixAt(i, nada); mudou = true; } }
        if (mudou) o.instanceMatrix.needsUpdate = true;
        return;
      }
      const pos = o.geometry.attributes.position;
      if (o.parent.name !== "level-merged" || !pos || pos.count % 24) return;
      let mudou = false;
      for (let c = 0; c < pos.count; c += 24) {
        let ax = 1e9, bx = -1e9, ay = 1e9, by = -1e9, az = 1e9, bz = -1e9;
        for (let i = c; i < c + 24; i++) { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i); ax = Math.min(ax, x); bx = Math.max(bx, x); ay = Math.min(ay, y); by = Math.max(by, y); az = Math.min(az, z); bz = Math.max(bz, z); }
        if (!dentro(ax, ay, az, bx, by, bz)) continue;
        for (let i = c; i < c + 24; i++) { if (ay >= corte) pos.setXYZ(i, ax, corte, az); else if (pos.getY(i) > corte) pos.setY(i, corte); }
        mudou = true;
      }
      if (mudou) pos.needsUpdate = true;
    });
    const parede = (x0, y0, z0, x1, y1, z1) => fis.addBox([x0, y0, z0], [x1, y1, z1], { surface: "metal" });
    parede(S.x1Antigo - 0.05, S.chao - 0.12, S.z0, S.x1 + 0.05, S.chao, S.z1 + 0.05);   // chão da parte nova
    parede(S.x0, S.chao, S.z0, S.x0 + 0.1, S.teto, S.z1);                    // oeste
    parede(S.x1 - 0.1, S.chao, S.z0, S.x1, S.teto, S.z1);                    // leste
    parede(S.x0, S.chao, S.z0, S.x1, S.teto, S.z0 + 0.1);                    // norte
    parede(S.x0, S.chao, S.z1 - 0.1, S.porta[0], S.teto, S.z1);              // frente, à esquerda da porta
    parede(S.porta[1], S.chao, S.z1 - 0.1, S.x1, S.teto, S.z1);              // frente, à direita
    parede(S.porta[0], S.altoPorta, S.z1 - 0.1, S.porta[1], S.teto, S.z1);   // acima da porta
    const A = ALCAPAO;                                                        // teto, com a abertura da escada de mão
    parede(S.x0, S.teto - 0.1, S.z0, S.x1, S.teto, A[1]); parede(S.x0, S.teto - 0.1, A[1], A[0], S.teto, S.z1); parede(A[0], S.teto - 0.1, A[3], S.x1, S.teto, S.z1);
    fecharVao(true);
    let mesaCortada = false;
    const identidade = new T.Matrix4();
    G.scene.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || !o.parent || o.parent.name !== "level-merged" || !o.matrixWorld.equals(identidade)) return;
      const nome = o.material.name, pos = o.geometry.attributes.position;
      if (!["paint_white", "glass_dirty", "paint_grey", "wood_dark", "diamond_plate"].includes(nome) || pos.count % 24) return;
      for (let c = 0; c < pos.count; c += 24) {             // a geometria é feita de caixas de 24 vértices
        let ax = 1e9, bx = -1e9, ay = 1e9, by = -1e9, az = 1e9, bz = -1e9;
        for (let i = c; i < c + 24; i++) { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i); ax = Math.min(ax, x); bx = Math.max(bx, x); ay = Math.min(ay, y); by = Math.max(by, y); az = Math.min(az, z); bz = Math.max(bz, z); }
        // peças da casinha que encostam na parede leste antiga (a própria parede, a janela dela, o piso, a laje, a
        // faixa de cima da frente): a ponta leste vai junto com a parede nova
        if (Math.abs(bx - S.x1Antigo) < 0.16 && ax > S.x0 - 0.2 && az > S.z0 - 0.2 && bz < S.z1 + 0.25 && ay > S.chao - 0.2 && by < S.teto + 0.1) {
          for (let i = c; i < c + 24; i++) if (pos.getX(i) > S.x1Antigo - 0.16) pos.setX(i, pos.getX(i) + dx);
          pos.needsUpdate = true; if (ax > S.x1Antigo - 0.16) ax += dx; bx += dx;
          o.geometry.boundingSphere = null; o.geometry.boundingBox = null;
        }
        if (nome === "diamond_plate") continue;
        if (nome === "paint_white" && Math.abs(ay - (S.teto - 0.1)) < 0.06 && bx - ax > 5 && bz - az > 3.5) {      // laje do teto: abre o alçapão
          for (let i = c; i < c + 24; i++) if (pos.getZ(i) > A[1]) pos.setZ(i, A[1]);
          pos.needsUpdate = true;
          const resto = new T.Mesh(new T.BoxGeometry(A[0] - ax, by - ay, bz - A[1]), o.material);
          resto.position.set((ax + A[0]) / 2, (ay + by) / 2, (A[1] + bz) / 2); resto.receiveShadow = true; G.scene.add(resto);
          continue;
        }
        if (nome === "wood_dark") {             // a mesa ia de parede a parede, na frente das portas secretas: fica só o meio
          if (ax < S.x0 + 0.6 && bx > S.x1Antigo - 0.6 && az > S.z0 && bz < S.z0 + 1.3 && ay > S.chao && by < S.chao + 1) {
            for (let i = c; i < c + 24; i++) { const x = pos.getX(i); if (x < MESA[0]) pos.setX(i, MESA[0]); else if (x > MESA[1]) pos.setX(i, MESA[1]); }
            pos.needsUpdate = true; mesaCortada = true;
          }
          continue;
        }
        if (az < S.z1 - 0.12 || bz > S.z1 + 0.08 || ay < S.chao - 0.05) continue;       // só o que está na parede da frente
        if (nome === "paint_grey" && perto(ax, S.porta[0]) && perto(bx, S.porta[1])) {      // a chapa da porta
          portaGeo = o.geometry; portaIni = c; portaOrig = Array.from({ length: 72 }, (_, k) => pos.array[c * 3 + k]);
        } else if (nome !== "paint_grey" && bx - ax > 4 && by < S.altoPorta + 0.05) {       // parede baixa e vidro: abre o vão
          for (let i = c; i < c + 24; i++) if (pos.getX(i) > S.porta[0]) pos.setX(i, S.porta[0]);
          pos.needsUpdate = true;
          const resto = new T.Mesh(new T.BoxGeometry(S.x1 - S.porta[1], by - ay, bz - az), o.material);
          resto.position.set((S.x1 + S.porta[1]) / 2, (ay + by) / 2, (az + bz) / 2); resto.receiveShadow = true; G.scene.add(resto);
        }
      }
    });
    // a mesa passa a ser sólida, para ninguém (nem os reféns) atravessar
    if (mesaCortada) parede(MESA[0], S.chao, S.z0, MESA[1], S.chao + 0.78, MESA[2]); else parede(S.x0, S.chao, S.z0, S.x1, S.chao + 0.78, MESA[2]);
    pesMesa.visible = mesaCortada;
    montarDuto();
    try { ampliarMapa(); } catch (e) { console.warn("[mp] a parte nova do mapa não foi montada", e); }
  }
  function fecharVao(fechar) {
    const fis = G.physics, S = SALA;
    if (fechar && !portaRef) { fis.addBox([S.porta[0], S.chao, S.z1 - 0.1], [S.porta[1], S.altoPorta, S.z1], { surface: "metal" }); portaRef = fis.boxes[fis.boxes.length - 1]; }
    else if (!fechar && portaRef) { fis.removeBox(portaRef); portaRef = null; }
  }
  function aplicarPorta(aberta) {
    if (aberta === portaAberta) return;
    portaAberta = aberta; fecharVao(!aberta);
    tocar("container_bang", { pos: new V3(-11.2, 3.5, SALA.z1), gain: 0.4 });
  }
  function animarPorta(dt) {
    const alvo = portaAberta ? 1 : 0;
    if (portaAnim === alvo || !portaGeo) return;
    portaAnim += Math.sign(alvo - portaAnim) * Math.min(Math.abs(alvo - portaAnim), dt * 2.5);
    const pos = portaGeo.attributes.position, a = portaAnim * 1.65, co = Math.cos(a), si = Math.sin(a), hx = SALA.porta[1], hz = SALA.z1 - 0.02;
    for (let i = 0; i < 24; i++) {                        // gira a chapa para dentro, em torno da dobradiça do lado leste
      const dx = portaOrig[i * 3] - hx, dz = portaOrig[i * 3 + 2] - hz;
      pos.setXYZ(portaIni + i, hx + dx * co - dz * si, portaOrig[i * 3 + 1], hz + dx * si + dz * co);
    }
    pos.needsUpdate = true;
  }
  let pesMesa = null;
  function montarCenario() {
    const T = G.THREE; cenario = new T.Group(); cenario.visible = false;
    // portas secretas: chapa de aço com batente e placa com o número e o destino, nos materiais do próprio jogo
    const aco = G.mats.get("steel_dark"), batente = G.mats.get("steel_galv"), faixa = G.mats.get("hazard_stripes"), S = SALA;
    const caixa = (pai, mat, w, h, d, x, y, z) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.receiveShadow = true; pai.add(m); return m; };
    PASSAGENS.forEach((s, n) => {
      const g = new T.Group(), oeste = s.parede === "oeste";
      caixa(g, aco, 0.95, 2.0, 0.05, 0, 1.0, 0); caixa(g, batente, 1.1, 0.08, 0.08, 0, 2.04, 0);
      caixa(g, batente, 0.08, 2.0, 0.08, -0.52, 1.0, 0); caixa(g, batente, 0.08, 2.0, 0.08, 0.52, 1.0, 0);
      caixa(g, faixa, 0.95, 0.12, 0.06, 0, 0.1, 0); caixa(g, batente, 0.04, 0.16, 0.06, 0.36, 1.0, 0.04);      // rodapé listrado e maçaneta
      const cv = document.createElement("canvas"); cv.width = 512; cv.height = 128; const c = cv.getContext("2d");
      c.fillStyle = "#14181b"; c.fillRect(0, 0, 512, 128); c.strokeStyle = "#ffb347"; c.lineWidth = 6; c.strokeRect(4, 4, 504, 120);
      c.fillStyle = "#ffb347"; c.textBaseline = "middle"; c.font = '900 84px "Big Shoulders Display", Impact, sans-serif'; c.fillText(String(n + 1), 26, 68);
      c.fillStyle = "#e8e4da"; c.font = '600 40px "Barlow Condensed", Arial, sans-serif'; c.fillText(s.nome.toUpperCase(), 96, 68);
      const placa = new T.Mesh(new T.PlaneGeometry(1.0, 0.25), new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), toneMapped: false }));
      placa.position.set(0, 2.24, 0.03); g.add(placa);
      if (oeste) { g.position.set(S.x0 + 0.13, S.chao, s.de[1]); g.rotation.y = Math.PI / 2; } else g.position.set(s.de[0], S.chao, S.z0 + 0.13);
      cenario.add(g);
    });
    // pilares e viga sob a parte nova da sala
    for (const z of [S.z0 + 0.2, S.z1 - 0.1]) for (const x of [(S.x1Antigo + S.x1) / 2, S.x1 - 0.1]) caixa(cenario, aco, 0.16, S.chao - 0.1, 0.16, x, (S.chao - 0.1) / 2, z);
    caixa(cenario, aco, S.x1 - S.x1Antigo, 0.14, 0.12, (S.x1 + S.x1Antigo) / 2, S.chao - 0.17, S.z1 - 0.1);
    // pés da mesa (ela ficou só com o meio do tampo)
    pesMesa = new T.Group(); pesMesa.visible = false; cenario.add(pesMesa);
    for (const x of [MESA[0] + 0.05, MESA[1] - 0.05]) caixa(pesMesa, aco, 0.05, 0.7, 0.6, x, S.chao + 0.35, -27.03);
    // cabide de armas sob a janela da frente: chapa de aço, travessas e uma etiqueta com o nome de cada arma
    const zc = S.z1 - 0.09, xc = -13.62;
    caixa(cenario, aco, 3.9, 0.86, 0.03, xc, S.chao + 0.45, zc);
    caixa(cenario, batente, 3.9, 0.04, 0.09, xc, S.chao + 0.03, zc - 0.03); caixa(cenario, batente, 3.9, 0.035, 0.06, xc, S.chao + 0.89, zc - 0.02);
    caixa(cenario, aco, 3.9, 0.13, 0.02, xc, S.chao + 0.975, zc);
    Object.keys(ARMAS).filter(k => ARMAS[k].time === "p" && !ARMAS[k].faca && !ARMAS[k].reserva).forEach((k, n) => {
      const cv = document.createElement("canvas"); cv.width = 320; cv.height = 64; const c = cv.getContext("2d");
      c.fillStyle = "#14181b"; c.fillRect(0, 0, 320, 64); c.strokeStyle = "#ffb347"; c.lineWidth = 4; c.strokeRect(2, 2, 316, 60);
      c.fillStyle = "#e8e4da"; c.textAlign = "center"; c.textBaseline = "middle"; c.font = '600 36px "Barlow Condensed", Arial, sans-serif'; c.fillText(ARMAS[k].nome.toUpperCase(), 160, 34);
      const et = new T.Mesh(new T.PlaneGeometry(0.52, 0.104), new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), toneMapped: false }));
      et.position.set(-15.2 + n * 0.56, S.chao + 0.975, zc - 0.012); et.rotation.y = Math.PI; cenario.add(et);
    });
    // ponto de resgate: moldura listrada pintada no chão
    discoResgate = new T.Group(); discoResgate.visible = false; cenario.add(discoResgate);
    const R = RAIO_RESGATE;
    for (const [w, d, x, z] of [[2 * R, 0.3, 0, -R], [2 * R, 0.3, 0, R], [0.3, 2 * R, -R, 0], [0.3, 2 * R, R, 0]]) caixa(discoResgate, faixa, w, 0.03, d, x, 0.03, z);
    // facho de luz no ponto de resgate, para os Policiais acharem de longe (os Terroristas não recebem o ponto, então não veem nada)
    const facho = new T.Mesh(new T.CylinderGeometry(R * 0.5, R, 60, 28, 1, true), new T.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.16, side: T.DoubleSide, depthWrite: false, toneMapped: false, blending: T.AdditiveBlending }));
    facho.position.y = 30; discoResgate.add(facho);
    // seta no céu em cima do ponto (aparece por cima de tudo, para todo Policial ver de qualquer lugar)
    const cvS = document.createElement("canvas"); cvS.width = cvS.height = 256; const cs = cvS.getContext("2d");
    cs.fillStyle = "#ffd27a"; cs.strokeStyle = "rgba(0,0,0,.7)"; cs.lineWidth = 10; cs.lineJoin = "round";
    cs.beginPath(); cs.moveTo(92, 20); cs.lineTo(164, 20); cs.lineTo(164, 130); cs.lineTo(220, 130); cs.lineTo(128, 240); cs.lineTo(36, 130); cs.lineTo(92, 130); cs.closePath(); cs.stroke(); cs.fill();
    const seta = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cvS), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    seta.scale.set(7, 7, 1); seta.position.y = 24; seta.renderOrder = 50; discoResgate.add(seta);
    const brilho = new T.Mesh(new T.CircleGeometry(R, 32), new T.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false, blending: T.AdditiveBlending }));
    brilho.rotation.x = -Math.PI / 2; brilho.position.y = 0.05; discoResgate.add(brilho);
    // painel na parede leste da sala dos reféns: mapa do porto e o nome do ponto de resgate da rodada
    const tela = document.createElement("canvas"); tela.width = 1024; tela.height = 640;
    painel = new T.Mesh(new T.PlaneGeometry(2.5, 1.5625), new T.MeshBasicMaterial({ map: new T.CanvasTexture(tela), toneMapped: false }));
    painel.rotation.y = -Math.PI / 2; painel.visible = false; cenario.add(painel);
    painel.position.set(S.x1 - 0.13, S.chao + 1.35, -25.9);
    G.scene.add(cenario);
    explosivos = new T.Group(); explosivos.visible = false; G.scene.add(explosivos);
    armasGrupo = new T.Group(); armasGrupo.visible = false; G.scene.add(armasGrupo);
    pichacoes = new T.Group(); G.scene.add(pichacoes);
    nomeArmaOriginal = G.weapon.name;
    montarModelos();
    mp.refens = REFENS.map((_, i) => ({ i, pos: new V3(), cur: new V3(), vel: new V3(), estado: 0, lider: null, hp: 1, yaw: Math.PI / 2, casa: new V3(REFENS[i][0], SALA.chao, REFENS[i][1]), trilha: [],
      civil: CIVIS[i % CIVIS.length], boneco: criarBoneco({ armado: false, civil: CIVIS[i % CIVIS.length] }) }));
    zerarRefens();
  }

  /* ------------------------------------------------ duto de ar e escadas de mão */
  function escadaEm(pos, raio) {
    for (const e of ESCADAS) if (Math.hypot(pos.x - e.x, pos.z - e.z) < (raio || 0.5) && pos.y > e.y0 - 0.1 && pos.y < e.y1 + 0.25) return e;
    return null;
  }
  function noMeioDaEscada(pos) { const e = escadaEm(pos, 0.8); return !!e && pos.y > e.y0 + 0.2 && pos.y < e.y1 - 0.05; }
  function noDuto(pos) {
    for (const d of DEITAR) if (pos.x > d[0] && pos.x < d[2] && pos.z > d[1] && pos.z < d[3] && pos.y > d[4] && pos.y < d[5]) return true;
    return false;
  }
  // Monta o duto (chapas com colisão: quem está fora não vê nem acerta quem está dentro), os poços que sobem ao telhado
  // e todas as escadas de mão, com os materiais do próprio jogo. Chamado uma vez, junto com a sala.
  // PÁTIO NOVO. A cerca sul do mapa original sai (colisão e tela) e o chão, que já existia para lá dela, vira área de jogo:
  // mais 30 m de pátio aberto, com poucos containers (alguns empilhados, com escada) e muretas para se proteger.
  function ampliarMapa() {
    const T = G.THREE, fis = G.physics, g = new T.Group(); cenario.add(g);
    const mat = n => G.mats.get(n), escuro = mat("steel_dark"), galv = mat("steel_galv"), amarelo = mat("paint_yellow"), concreto = mat("concrete"), chapa = mat("diamond_plate");
    const bloco = (m, xa, ya, za, xb, yb, zb, solido, op) => {
      const o = new T.Mesh(new T.BoxGeometry(Math.abs(xb - xa), Math.abs(yb - ya), Math.abs(zb - za)), m);
      o.position.set((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2); o.castShadow = o.receiveShadow = true; g.add(o);
      if (solido) fis.addBox([Math.min(xa, xb), Math.min(ya, yb), Math.min(za, zb)], [Math.max(xa, xb), Math.max(ya, yb), Math.max(za, zb)], op || { surface: "metal" });
      return o;
    };
    // 1. tira a cerca sul antiga
    for (const b of [...fis.boxes]) if (b.min.z > 27.5 && b.max.z < 28.5 && b.max.x - b.min.x > 30) fis.removeBox(b);
    try { if (fis.bounds && fis.bounds.max) fis.bounds.max.z = SUL.z1 + 0.6; } catch {}      // o jogo não deixava passar de z = 30
    G.scene.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.material || o.isInstancedMesh || o.isSkinnedMesh || o.userData.emprestado) return;
      const nome = o.material.name || "", tela = nome === "chainlink", fundo = /skyline|backdrop/.test(o.name + " " + (o.parent ? o.parent.name : ""));
      const geo = o.geometry, pos = geo.attributes.position; if (!pos || pos.count > 400000) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (geo.boundingBox.max.z < 27.6 || geo.boundingBox.max.x - geo.boundingBox.min.x < 40) return;      // só as malhas grandes do cenário, que chegam à cerca
      const idx = geo.index ? Array.from(geo.index.array) : Array.from({ length: pos.count }, (_, k) => k), fica = [];
      // sai: a tela e os postes da cerca sul, e o cenário de fundo (pilhas de containers de enfeite) que ficava onde agora é o pátio novo
      const fora = k => { const x = pos.getX(k), z = pos.getZ(k), y = pos.getY(k); return fundo ? z > 28.6 && z < SUL.z1 + 6 && x > SUL.x0 - 6 && x < SUL.x1 + 1.5 : tela ? z > 27.6 && z < 28.4 : z > 27.75 && z < 28.45 && y < 3.6 && y > 0.02; };
      for (let k = 0; k < idx.length; k += 3) if (!(fora(idx[k]) && fora(idx[k + 1]) && fora(idx[k + 2]))) fica.push(idx[k], idx[k + 1], idx[k + 2]);
      if (fica.length !== idx.length) geo.setIndex(fica);
    });
    // 2. cerca nova em volta do pátio novo (tela e postes; quem anda não passa, tiro passa) e mureta invisível na beira do cais
    const S = SUL, tela = G.mats.get("chainlink", { doubleSide: true });
    const cerca = (xa, za, xb, zb) => {
      const comp = Math.hypot(xb - xa, zb - za), n = Math.max(1, Math.round(comp / 3));
      for (let k = 0; k < n; k++) {
        const pl = new T.Mesh(new T.PlaneGeometry(comp / n, 2.4), tela); pl.position.set(xa + (xb - xa) * (k + 0.5) / n, 1.2, za + (zb - za) * (k + 0.5) / n);
        if (Math.abs(xb - xa) < 0.01) pl.rotation.y = Math.PI / 2; g.add(pl);
      }
      for (let k = 0; k <= n; k++) { const x = xa + (xb - xa) * k / n, z = za + (zb - za) * k / n; bloco(galv, x - 0.04, 0, z - 0.04, x + 0.04, 2.5, z + 0.04); }
      fis.addBox([Math.min(xa, xb) - 0.15, 0, Math.min(za, zb) - 0.15], [Math.max(xa, xb) + 0.15, 7, Math.max(za, zb) + 0.15], { surface: "metal", playerOnly: true });
    };
    cerca(S.x0, S.z1, S.x1, S.z1); cerca(S.x0, S.z0, S.x0, S.z1);
    fis.addBox([S.x1, -5, 29.5], [S.x1 + 0.7, 8, S.z1 + 0.5], { surface: "concrete", playerOnly: true });
    // 3. containers: [x, z, ao longo de "x" ou "z", quantos empilhados, cor]
    const cores = ["paint_red", "paint_blue", "paint_green", "paint_teal", "paint_orange", "paint_grey"];
    const C = [[-27, 35, "x", 1, 0], [-13, 44, "z", 2, 1], [1, 37, "x", 1, 2], [13, 50, "x", 2, 3], [21, 35, "z", 1, 4], [-27, 52, "x", 1, 5], [-5, 54, "z", 1, 0], [24, 47, "z", 3, 1]];
    for (const [cx, cz, eixo, pilha, cor] of C) {
      const lx = eixo === "x" ? 3.05 : 1.26, lz = eixo === "x" ? 1.26 : 3.05;
      for (let k = 0; k < pilha; k++) {
        const y0 = k * 2.59, y1 = y0 + 2.59, m = mat(cores[(cor + k * 2) % cores.length]);
        bloco(m, cx - lx, y0 + 0.02, cz - lz, cx + lx, y1 - 0.02, cz + lz, true);
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bloco(escuro, cx + sx * lx - 0.06 * sx - 0.06, y0, cz + sz * lz - 0.06 * sz - 0.06, cx + sx * lx - 0.06 * sx + 0.06, y1, cz + sz * lz - 0.06 * sz + 0.06);      // cantoneiras
        for (const y of [y0 + 0.06, y1 - 0.06]) {       // longarinas em cima e embaixo
          bloco(escuro, cx - lx - 0.01, y - 0.06, cz - lz - 0.01, cx + lx + 0.01, y + 0.06, cz - lz + 0.05); bloco(escuro, cx - lx - 0.01, y - 0.06, cz + lz - 0.05, cx + lx + 0.01, y + 0.06, cz + lz + 0.01);
          bloco(escuro, cx - lx - 0.01, y - 0.06, cz - lz, cx - lx + 0.05, y + 0.06, cz + lz); bloco(escuro, cx + lx - 0.05, y - 0.06, cz - lz, cx + lx + 0.01, y + 0.06, cz + lz);
        }
        const passo = 0.38;                             // nervuras da chapa nos lados compridos
        if (eixo === "x") for (let x = cx - lx + 0.3; x < cx + lx - 0.2; x += passo) for (const z of [cz - lz - 0.025, cz + lz + 0.025]) bloco(m, x - 0.07, y0 + 0.14, z - 0.025, x + 0.07, y1 - 0.14, z + 0.025);
        else for (let z = cz - lz + 0.3; z < cz + lz - 0.2; z += passo) for (const x of [cx - lx - 0.025, cx + lx + 0.025]) bloco(m, x - 0.025, y0 + 0.14, z - 0.07, x + 0.025, y1 - 0.14, z + 0.07);
      }
      if (pilha > 1) {                                  // pilha alta: só se sobe de escada (numa das pontas)
        const e = eixo === "x" ? { x: cx - lx - 0.45, z: cz, y0: 0, y1: pilha * 2.59 + 0.1, nx: 1, nz: 0, d: 0.4 } : { x: cx, z: cz - lz - 0.45, y0: 0, y1: pilha * 2.59 + 0.1, nx: 0, nz: 1, d: 0.4 };
        ESCADAS.push(e);
        const px = -e.nz, pz = e.nx, ex = e.x + e.nx * e.d, ez = e.z + e.nz * e.d;
        for (const k of [-0.24, 0.24]) bloco(amarelo, ex + px * k - 0.025, 0, ez + pz * k - 0.025, ex + px * k + 0.025, e.y1 + 0.9, ez + pz * k + 0.025);
        for (let y = 0.3; y < e.y1; y += 0.3) bloco(chapa, ex - Math.abs(px) * 0.24 - 0.015, y - 0.015, ez - Math.abs(pz) * 0.24 - 0.015, ex + Math.abs(px) * 0.24 + 0.015, y + 0.015, ez + Math.abs(pz) * 0.24 + 0.015);
      }
    }
    // 4. proteção baixa: muretas de concreto e caixotes (dá para pular em cima; tiro não atravessa)
    for (const [x, z, eixo] of [[-19, 37, "x"], [7, 45, "z"], [-3, 47, "x"], [16, 41, "x"], [-31, 44, "z"], [20, 55, "x"], [-20, 46, "z"], [9, 31, "x"]]) {
      const lx = eixo === "x" ? 1.3 : 0.28, lz = eixo === "x" ? 0.28 : 1.3;
      bloco(concreto, x - lx, 0, z - lz, x + lx, 1.05, z + lz, true, { surface: "concrete" }); bloco(mat("hazard_stripes"), x - lx, 1.05, z - lz, x + lx, 1.1, z + lz);
    }
    for (const [x, z, t] of [[-10, 33, 1.2], [11, 36, 1.2], [-21, 56, 1.2], [3, 56, 1.2], [3, 54.75, 0.9], [-33, 31, 1.2], [26, 31, 1.2]]) bloco(mat("wood_pallet"), x - t / 2, 0, z - t / 2, x + t / 2, t, z + t / 2, true, { surface: "wood" });
    // 5. postes com luz
    const luz = new T.MeshBasicMaterial({ color: 0xfff0c8, toneMapped: false });
    for (const [x, z] of [[-24, 42], [-4, 42], [16, 44], [-12, 56.8], [8, 29.4]]) { bloco(galv, x - 0.07, 0, z - 0.07, x + 0.07, 8, z + 0.07, true); bloco(escuro, x - 0.5, 7.9, z - 0.12, x + 0.5, 8.05, z + 0.12); bloco(luz, x - 0.45, 7.84, z - 0.1, x + 0.45, 7.9, z + 0.1); }
    // 6. alto do guindaste: as peças de verdade da torre passam a ser sólidas e o caminho segue por elas, sem atravessar nada.
    // A viga principal (topo a 22,8 m) atravessa a torre e vai até a ponta sobre a água; entre as pernas há um convés no mesmo
    // nível; as vigas de borda (1 m acima) servem de parapeito; a casa de máquinas é um bloco com escada para o teto dela.
    const Y = 22.8, solido = { surface: "metal" }, grade = mat("diamond_plate");
    fis.addBox([12, 21.2, -2.3], [39.1, Y, 2.3], solido);                                   // viga principal
    for (const x of [18.05, 28.05]) fis.addBox([x, Y, -5.4], [x + 0.9, 23.8, 5.4], solido);  // vigas de borda (oeste e leste)
    for (const z of [-5.8, 5.0]) fis.addBox([18.5, 23, z], [28.5, 23.8, z + 0.8], solido);   // vigas de borda (norte e sul)
    fis.addBox([12.6, Y, -2.9], [20.4, 26, 2.9], solido);                                    // casa de máquinas
    for (const k of [-1, 1]) bloco(grade, 18.95, Y - 0.1, k > 0 ? 2.3 : -5, 28.05, Y, k > 0 ? 5 : -2.3, true);      // convés dos dois lados da viga
    bloco(grade, 17.88, 23.7, 3.6, 18.06, 23.8, 4.75, true);                                  // do piso da escada para cima da viga de borda
    const degraus = (xa, xb, za, zb, alturas) => alturas.forEach((h, k) => { const x0 = xa + (xb - xa) * k / alturas.length, x1 = xa + (xb - xa) * (k + 1) / alturas.length; bloco(grade, Math.min(x0, x1), Y, za, Math.max(x0, x1), Y + h, zb, true); });
    degraus(18.95, 19.85, 3.5, 4.8, [0.67, 0.34]);                                           // desce da viga de borda para o convés
    degraus(27.15, 28.05, -1.2, 1.2, [0.34, 0.67]); degraus(28.95, 29.85, -1.2, 1.2, [0.67, 0.34]);      // passa por cima da viga leste, seguindo pela viga principal
    const guarda = (xa, za, xb, zb, base) => {
      fis.addBox([Math.min(xa, xb) - 0.03, base, Math.min(za, zb) - 0.03], [Math.max(xa, xb) + 0.03, base + 1.05, Math.max(za, zb) + 0.03], { surface: "metal", playerOnly: true });
      for (const y of [0.55, 1.02]) bloco(amarelo, Math.min(xa, xb) - 0.02, base + y - 0.02, Math.min(za, zb) - 0.02, Math.max(xa, xb) + 0.02, base + y + 0.02, Math.max(za, zb) + 0.02);
      const n = Math.max(1, Math.round(Math.hypot(xb - xa, zb - za) / 1.4));
      for (let k = 0; k <= n; k++) { const x = xa + (xb - xa) * k / n, z = za + (zb - za) * k / n; bloco(amarelo, x - 0.02, base, z - 0.02, x + 0.02, base + 1.04, z + 0.02); }
    };
    guarda(29.85, -2.3, 39.1, -2.3, Y); guarda(29.85, 2.3, 39.1, 2.3, Y); guarda(39.1, -2.3, 39.1, 2.3, Y);      // ponta da viga, sobre a água
    guarda(28.95, -2.3, 29.85, -2.3, Y); guarda(28.95, 2.3, 29.85, 2.3, Y);
    bloco(grade, 28.95, Y - 0.02, -2.3, 39.1, Y + 0.02, 2.3);
    // TORRE DE ESCADAS DO PRÓPRIO JOGO (lado sul do guindaste): escada de gaiola do chão ao primeiro patamar, cinco lances em
    // zigue-zague com patamares, e as passarelas a 13,5 m. Era só enfeite; aqui cada degrau e cada piso ganha colisão.
    {
      const T0 = 6.15, D0 = 6.97, C0 = 7.8, GA = [19.4, 20.6], JA = [26.4, 27.6], K = [3.6, 6.9, 10.2, 13.5, 16.8, 20.1], inv = { surface: "metal", playerOnly: true };
      for (const b of [...fis.boxes]) if (Math.abs(b.min.x - 18.63) < 0.05 && Math.abs(b.max.y - 4.7) < 0.05 && Math.abs(b.min.z - 6.95) < 0.05) fis.removeBox(b);      // a gaiola era um bloco maciço
      ESCADAS.push({ x: 18.93, z: 7.35, y0: 1.5, y1: K[0] + 0.45, nx: 1, nz: 0, d: 0.4 }); fis.addBox([19.34, 1.5, 6.95], [19.4, K[0] - 0.2, 7.75], inv);      // começa em cima do truque da perna (1,5 m: dá para subir pulando)
      const lance = (xa, ya, xb, yb, za, zb) => { const n = Math.max(2, Math.round((yb - ya) / 0.2)); for (let k = 0; k < n; k++) { const x0 = xa + (xb - xa) * k / n, x1 = xa + (xb - xa) * (k + 1) / n, topo = ya + (yb - ya) * (k + 1) / n; fis.addBox([Math.min(x0, x1), topo - 0.24, za], [Math.max(x0, x1), topo, zb], solido); } };
      for (let k = 0; k < 6; k++) { const L = k % 2 === 0 ? GA : JA; fis.addBox([L[0], K[k] - 0.2, T0], [L[1], K[k], C0], solido); }      // patamares
      for (let k = 0; k < 5; k++) k % 2 === 0 ? lance(GA[1], K[k], JA[0], K[k + 1], T0, D0) : lance(JA[0], K[k], GA[1], K[k + 1], D0, C0);
      lance(JA[0], K[5], 23.4, 21.9, D0, C0); fis.addBox([22.5, 21.7, 5.8], [23.4, 21.9, C0], solido);
      fis.addBox([22.45, 21.9, 5.8], [22.5, 23, C0], inv); fis.addBox([23.4, 21.9, 5.8], [23.45, 23, D0], inv);                 // último lance e a passarela do alto
      // guarda invisível nos lados de fora (onde o desenho já tem corrimão), para ninguém cair dos lances
      fis.addBox([GA[0], K[0], C0], [JA[1], 23, C0 + 0.05], inv); fis.addBox([JA[1], K[0], T0], [JA[1] + 0.05, 23, C0], inv); fis.addBox([GA[0] - 0.05, K[0] + 2.1, T0], [GA[0], 23, C0], inv);
      fis.addBox([GA[1], K[0], T0 - 0.05], [JA[0], 21.9, T0], inv); fis.addBox([23.4, 21.9, T0 - 0.05], [JA[0], 23, T0], inv); fis.addBox([GA[1], 21.9, T0 - 0.05], [22.5, 23, T0], inv);
      for (const k of [0, 2, 4]) fis.addBox([GA[0], K[k], T0 - 0.05], [GA[1], K[k] + 1.1, T0], inv);
      for (const k of [1, 5]) fis.addBox([JA[0], K[k], T0 - 0.05], [JA[1], K[k] + 1.1, T0], inv);
      // do alto da torre (21,9 m) uma escada de mão curta sobe na viga de borda sul; dali, dois degraus descem para o convés
      const ec = { x: 22.95, z: 6.25, y0: 21.9, y1: 23.92, nx: 0, nz: -1, d: 0.4 }; ESCADAS.push(ec);
      for (const k of [-0.24, 0.24]) bloco(amarelo, ec.x + k - 0.025, 21.9, 5.825, ec.x + k + 0.025, 24.7, 5.875);
      for (let y = 22.2; y < 23.9; y += 0.3) bloco(grade, ec.x - 0.255, y - 0.015, 5.835, ec.x + 0.255, y + 0.015, 5.865);
      bloco(grade, 22.4, Y, 4.7, 23.5, Y + 0.67, 5.0, true); bloco(grade, 22.4, Y, 4.4, 23.5, Y + 0.34, 4.7, true);
      // nível de 13,5 m: as vigas e as passarelas que o desenho já mostra
      for (const z of [-5.85, 4.95]) fis.addBox([18.5, 12.5, z], [28.5, 13.5, z + 0.9], solido);
      for (const x of [18.05, 28.05]) { fis.addBox([x, 12.5, -5.4], [x + 0.9, 13.5, 5.4], solido); fis.addBox([x, 3.6, -4.8], [x + 0.9, 4.6, 4.8], solido); }
      fis.addBox([18.95, 13.4, -4.6], [19.75, 13.5, 4.05], solido); fis.addBox([JA[0], 13.4, 4.95], [JA[1], 13.5, T0], solido);
    }
    // teto da casa de máquinas (26 m): escada de mão na parede leste e guarda-corpo em volta
    const eh = { x: 20.85, z: 0, y0: Y, y1: 26.1, nx: -1, nz: 0, d: 0.4 }; ESCADAS.push(eh);
    for (const k of [-0.24, 0.24]) bloco(amarelo, eh.x - 0.4 - 0.025, Y, k - 0.025, eh.x - 0.4 + 0.025, 26.9, k + 0.025);
    for (let y = Y + 0.3; y < 26.05; y += 0.3) bloco(grade, eh.x - 0.415, y - 0.015, -0.255, eh.x - 0.385, y + 0.015, 0.255);
    guarda(12.6, -2.9, 20.4, -2.9, 26); guarda(12.6, 2.9, 20.4, 2.9, 26); guarda(12.6, -2.9, 12.6, 2.9, 26); guarda(20.4, -2.9, 20.4, -0.5, 26); guarda(20.4, 0.5, 20.4, 2.9, 26);
    // 7. caminhos: o mapa de caminhos do jogo só cobre o pátio antigo; para a parte nova há uma grade própria
    const nav = fis.nav, fp = nav.findPath.bind(nav), iw = nav.isWalkable.bind(nav), rp = nav.randomPoint.bind(nav);
    nav.findPath = (a, b) => (a.z > 27.2 || b.z > 27.2) ? caminhoExtra(a, b) : fp(a, b);
    nav.isWalkable = (x, z) => z > 27.4 ? livreExtra(x, z) : iw(x, z);
    nav.randomPoint = (c, r) => {
      if (c.z > 27.4 || (r >= 20 && Math.random() < 0.36)) for (let k = 0; k < 40; k++) {
        const x = c.z > 27.4 ? c.x + (Math.random() - 0.5) * 2 * r : S.x0 + 2 + Math.random() * (S.x1 - S.x0 - 4), z = c.z > 27.4 ? c.z + (Math.random() - 0.5) * 2 * r : S.z0 + 1.5 + Math.random() * (S.z1 - S.z0 - 3);
        if (z > 27.4 && livreExtra(x, z)) return new V3(x, 0, z);
      }
      return rp(c, r);
    };
    fundir(g);
  }
  // DESEMPENHO: o cenário feito aqui é montado de centenas de caixinhas. Desenhar cada uma em separado pesa muito (eram mais de
  // 1.800 peças, contra 125 do mapa original). Esta função junta todas as peças de um grupo que usam o mesmo material numa
  // malha só; o desenho fica igual e o número de peças cai para o número de materiais.
  function fundir(g) {
    const T = G.THREE, porMat = new Map();
    for (const o of [...g.children]) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || !o.geometry.attributes.normal || !o.geometry.attributes.uv || Array.isArray(o.material)) continue;
      o.updateMatrix();
      let l = porMat.get(o.material); if (!l) porMat.set(o.material, l = []);
      l.push(o); g.remove(o);
    }
    for (const [mat, lista] of porMat) {
      let nv = 0, ni = 0;
      for (const o of lista) { nv += o.geometry.attributes.position.count; ni += o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count; }
      const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni), v = new V3(), nm = new T.Matrix3();
      let pv = 0, pi = 0;
      for (const o of lista) {
        const ge = o.geometry, P = ge.attributes.position, N = ge.attributes.normal, U = ge.attributes.uv; nm.getNormalMatrix(o.matrix);
        for (let k = 0; k < P.count; k++) {
          v.fromBufferAttribute(P, k).applyMatrix4(o.matrix); pos[(pv + k) * 3] = v.x; pos[(pv + k) * 3 + 1] = v.y; pos[(pv + k) * 3 + 2] = v.z;
          v.fromBufferAttribute(N, k).applyMatrix3(nm).normalize(); nor[(pv + k) * 3] = v.x; nor[(pv + k) * 3 + 1] = v.y; nor[(pv + k) * 3 + 2] = v.z;
          uv[(pv + k) * 2] = U.getX(k); uv[(pv + k) * 2 + 1] = U.getY(k);
        }
        if (ge.index) for (let k = 0; k < ge.index.count; k++) idx[pi++] = ge.index.getX(k) + pv; else for (let k = 0; k < P.count; k++) idx[pi++] = pv + k;
        pv += P.count; ge.dispose();
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("normal", new T.BufferAttribute(nor, 3)); geo.setAttribute("uv", new T.BufferAttribute(uv, 2)); geo.setIndex(new T.BufferAttribute(idx, 1));
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      const m = new T.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; g.add(m);
    }
  }
  // grade de caminhos do mapa inteiro (antigo + novo), feita das caixas de colisão na altura de uma pessoa
  let gradeNav = null;
  function gradeExtra() {
    if (gradeNav) return gradeNav;
    const x0 = -38, z0 = -30, c = 0.5, w = 136, h = 176, blo = new Uint8Array(w * h);
    for (const b of G.physics.boxes) {
      if (b.bulletOnly || b.max.y < 0.4 || b.min.y > 1.6) continue;
      const ia = Math.max(0, Math.floor((b.min.x - 0.38 - x0) / c)), ib = Math.min(w - 1, Math.floor((b.max.x + 0.38 - x0) / c)), ja = Math.max(0, Math.floor((b.min.z - 0.38 - z0) / c)), jb = Math.min(h - 1, Math.floor((b.max.z + 0.38 - z0) / c));
      for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) blo[j * w + i] = 1;
    }
    for (let j = 0; j < h; j++) for (let i = Math.floor((29.2 - x0) / c); i < w; i++) blo[j * w + i] = 1;      // água
    return gradeNav = { x0, z0, c, w, h, blo };
  }
  function celulaExtra(x, z) { const g = gradeExtra(), i = Math.floor((x - g.x0) / g.c), j = Math.floor((z - g.z0) / g.c); return i < 0 || j < 0 || i >= g.w || j >= g.h ? -1 : j * g.w + i; }
  function livreExtra(x, z) { const k = celulaExtra(x, z); return k >= 0 && !gradeExtra().blo[k]; }
  function caminhoExtra(a, b) {
    const g = gradeExtra(), w = g.w, h = g.h, blo = g.blo;
    const perto = k => {                               // célula livre mais próxima (quem pede pode estar encostado numa parede)
      if (k < 0) return -1; if (!blo[k]) return k;
      const ci = k % w, cj = (k / w) | 0;
      for (let r = 1; r <= 8; r++) for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) if (i >= 0 && j >= 0 && i < w && j < h && !blo[j * w + i]) return j * w + i;
      return -1;
    };
    const s = perto(celulaExtra(a.x, a.z)), e = perto(celulaExtra(b.x, b.z)); if (s < 0 || e < 0) return null;
    const custo = new Float32Array(w * h).fill(Infinity), veio = new Int32Array(w * h).fill(-1), fila = [s], prio = new Float32Array(w * h);
    const ei = e % w, ej = (e / w) | 0, heur = k => { const dx = Math.abs(k % w - ei), dz = Math.abs(((k / w) | 0) - ej); return Math.max(dx, dz) + 0.41 * Math.min(dx, dz); };
    custo[s] = 0; prio[s] = heur(s);
    const sobe = n => { while (n > 0) { const p = (n - 1) >> 1; if (prio[fila[p]] <= prio[fila[n]]) break; [fila[p], fila[n]] = [fila[n], fila[p]]; n = p; } };
    const desce = () => { let n = 0; for (;;) { let m = n; const l = 2 * n + 1, r = l + 1; if (l < fila.length && prio[fila[l]] < prio[fila[m]]) m = l; if (r < fila.length && prio[fila[r]] < prio[fila[m]]) m = r; if (m === n) break; [fila[m], fila[n]] = [fila[n], fila[m]]; n = m; } };
    let voltas = 0, achou = false;
    while (fila.length && voltas++ < 40000) {
      const k = fila[0], ult = fila.pop(); if (fila.length) { fila[0] = ult; desce(); }
      if (k === e) { achou = true; break; }
      const ci = k % w, cj = (k / w) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const n = j * w + i; if (blo[n] || (di && dj && (blo[cj * w + i] || blo[j * w + ci]))) continue;
        const c2 = custo[k] + (di && dj ? 1.41 : 1);
        if (c2 < custo[n]) { custo[n] = c2; veio[n] = k; prio[n] = c2 + heur(n); fila.push(n); sobe(fila.length - 1); }
      }
    }
    if (!achou) return null;
    const cel = []; for (let k = e; k >= 0 && k !== s; k = veio[k]) cel.push(k); cel.reverse();
    const pts = []; for (let k = 3; k < cel.length - 1; k += 4) pts.push(new V3(g.x0 + (cel[k] % w + 0.5) * g.c, 0, g.z0 + (((cel[k] / w) | 0) + 0.5) * g.c));
    pts.push(new V3(b.x, 0, b.z));
    return pts;
  }
  function montarDuto() {
    const T = G.THREE, fis = G.physics, D = DUTO, e = 0.05, y0 = D.y, y1 = D.y + D.alt, g = new T.Group(); cenario.add(g);
    const chapa = G.mats.get("steel_galv"), escuro = G.mats.get("steel_dark"), amarelo = G.mats.get("paint_yellow"), listra = G.mats.get("hazard_stripes");
    const luz = new T.MeshBasicMaterial({ color: 0xfff0c8, toneMapped: false });
    const bloco = (mat, xa, ya, za, xb, yb, zb, solido) => {
      const m = new T.Mesh(new T.BoxGeometry(Math.abs(xb - xa), Math.abs(yb - ya), Math.abs(zb - za)), mat);
      m.position.set((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2); m.receiveShadow = true; g.add(m);
      if (solido) fis.addBox([xa, ya, za], [xb, yb, zb], { surface: "metal" });
      return m;
    };
    const zn0 = D.zn - 0.5, zn1 = D.zn + 0.5, zs0 = D.zs - 0.5, zs1 = D.zs + 0.5, xe0 = D.xe - 0.5, xe1 = D.xe + 0.5, xw0 = D.xw - 0.5, xw1 = D.xw + 0.5;
    const piso = (xa, za, xb, zb) => bloco(chapa, xa, y0 - e, za, xb, y0, zb, true), forro = (xa, za, xb, zb) => bloco(chapa, xa, y1, za, xb, y1 + e, zb, true);
    const lado = (xa, za, xb, zb, yb) => bloco(chapa, xa, y0 - e, za, xb, yb || y1 + e, zb, true);
    // trecho norte: da boca (beira leste do teto da sala) até o canto nordeste, onde sobe o poço do telhado
    piso(D.x0, zn0, xe1, zn1); forro(D.x0, zn0, xe0, zn1);
    lado(D.x0, zn0 - e, xe1 + e, zn0); lado(D.x0, zn1, xe0, zn1 + e); lado(xe1, zn0, xe1 + e, zn1);
    // trecho leste, com o buraco da escada que desce ao chão
    piso(xe0, zn1, xe1, -19.7); piso(xe0, -18.7, xe1, zs0); forro(xe0, zn1, xe1, zs0);
    lado(xe0 - e, zn1, xe0, zs0); lado(xe1, zn1, xe1 + e, zs0);
    // trecho sul, com o poço do telhado no meio
    piso(xw0, zs0, xe1, zs1); forro(xw0, zs0, -0.35, zs1); forro(0.65, zs0, xe1, zs1);
    lado(xw0 - e, zs1, xe1 + e, zs1 + e); lado(xw1, zs0 - e, xe0, zs0); lado(xe1, zs0, xe1 + e, zs1); lado(xw0 - e, zs0, xw0, zs1);
    // trecho oeste: do canto sudoeste até a boca na beira sul do teto da sala, com a outra escada que desce
    piso(xw0, D.zb, xw1, -17); piso(xw0, -16, xw1, zs0); forro(xw0, D.zb, xw1, zs0);
    lado(xw0 - e, D.zb, xw0, zs0); lado(xw1, D.zb, xw1 + e, zs0);
    // poços até o telhado (as aberturas que o telhado já tem)
    for (const [cx, cz] of [[D.xe, D.zn], [0.15, D.zs]]) {
      bloco(chapa, cx - 0.5 - e, y1, cz - 0.5 - e, cx - 0.5, 8.3, cz + 0.5 + e, true); bloco(chapa, cx + 0.5, y1, cz - 0.5 - e, cx + 0.5 + e, 8.3, cz + 0.5 + e, true);
      bloco(chapa, cx - 0.5, y1, cz - 0.5 - e, cx + 0.5, 8.3, cz - 0.5, true); bloco(chapa, cx - 0.5, y1, cz + 0.5, cx + 0.5, 8.3, cz + 0.5 + e, true);
    }
    // tampa em volta de cada poço, na altura do telhado: a abertura do telhado é maior que o poço e dava para cair pelo vão
    const grade = G.mats.get("diamond_plate");
    for (const [cx, cz, ax, az, bx, bz, topo] of [[D.xe, D.zn, 2.29, -25.88, 3.72, -23.75, 8.33], [0.15, D.zs, -0.57, -15.25, 0.86, -13.13, 8.33]]) {
      const y = topo - 0.08;
      if (cz - 0.5 - az > 0.02) bloco(grade, ax, y, az, bx, topo, cz - 0.5 - e, true);
      if (bz - (cz + 0.5) > 0.02) bloco(grade, ax, y, cz + 0.5 + e, bx, topo, bz, true);
      if (cx - 0.5 - ax > 0.02) bloco(grade, ax, y, cz - 0.5 - e, cx - 0.5 - e, topo, cz + 0.5 + e, true);
      if (bx - (cx + 0.5) > 0.02) bloco(grade, cx + 0.5 + e, y, cz - 0.5 - e, bx, topo, cz + 0.5 + e, true);
    }
    // guarda-corpo no teto da casinha (menos nas bocas do duto), para ninguém cair pela beirada
    const S = SALA, trilho = (xa, za, xb, zb) => {
      fis.addBox([Math.min(xa, xb) - 0.03, S.teto, Math.min(za, zb) - 0.03], [Math.max(xa, xb) + 0.03, S.teto + 1.05, Math.max(za, zb) + 0.03], { surface: "metal", playerOnly: true });
      for (const y of [0.55, 1.02]) bloco(amarelo, Math.min(xa, xb) - 0.02, S.teto + y - 0.02, Math.min(za, zb) - 0.02, Math.max(xa, xb) + 0.02, S.teto + y + 0.02, Math.max(za, zb) + 0.02);
      const n = Math.max(1, Math.round(Math.hypot(xb - xa, zb - za) / 1.6));
      for (let k = 0; k <= n; k++) { const x = xa + (xb - xa) * k / n, z = za + (zb - za) * k / n; bloco(amarelo, x - 0.02, S.teto, z - 0.02, x + 0.02, S.teto + 1.04, z + 0.02); }
    };
    trilho(S.x0 + 0.3, S.z1, xw0 - e, S.z1); trilho(xw1 + e, S.z1, S.x1, S.z1);          // beira sul, dos dois lados da boca oeste
    trilho(S.x1, S.z1, S.x1, zn1 + e); trilho(S.x1, zn0 - e, S.x1, S.z0 + 0.3);            // beira leste, dos dois lados da boca norte
    // acabamento: flanges a cada dois metros, tirantes até o telhado, luzinhas por dentro e moldura listrada nas bocas
    const flange = (eixo, p, a, b) => {
      const f = 0.035, q = 0.03;
      if (eixo === "x") { bloco(escuro, p - q, y1 + e, a - e - f, p + q, y1 + e + f, b + e + f); bloco(escuro, p - q, y0 - e - f, a - e - f, p + q, y0 - e, b + e + f); bloco(escuro, p - q, y0 - e, a - e - f, p + q, y1 + e, a - e); bloco(escuro, p - q, y0 - e, b + e, p + q, y1 + e, b + e + f); bloco(escuro, p - 0.012, y1 + e, (a + b) / 2 - 0.012, p + 0.012, 7.6, (a + b) / 2 + 0.012); bloco(luz, p + 0.9, y1 - 0.02, (a + b) / 2 - 0.04, p + 1.15, y1, (a + b) / 2 + 0.04); }
      else { bloco(escuro, a - e - f, y1 + e, p - q, b + e + f, y1 + e + f, p + q); bloco(escuro, a - e - f, y0 - e - f, p - q, b + e + f, y0 - e, p + q); bloco(escuro, a - e - f, y0 - e, p - q, a - e, y1 + e, p + q); bloco(escuro, b + e, y0 - e, p - q, b + e + f, y1 + e, p + q); bloco(escuro, (a + b) / 2 - 0.012, y1 + e, p - 0.012, (a + b) / 2 + 0.012, 7.6, p + 0.012); bloco(luz, (a + b) / 2 - 0.04, y1 - 0.02, p + 0.9, (a + b) / 2 + 0.04, y1, p + 1.15); }
    };
    for (let x = D.x0 + 1; x < xe0 - 0.6; x += 2) flange("x", x, zn0, zn1);
    for (let x = xw1 + 0.7; x < xe0; x += 2) if (Math.abs(x - 0.15) > 0.8) flange("x", x, zs0, zs1);
    for (let z = zn1 + 1; z < zs0; z += 2) flange("z", z, xe0, xe1);
    for (let z = D.zb + 1; z < zs0; z += 2) flange("z", z, xw0, xw1);
    bloco(listra, D.x0 - 0.02, y0 - e, zn0 - e, D.x0 + 0.04, y1 + e + 0.06, zn0 - e + 0.07); bloco(listra, D.x0 - 0.02, y0 - e, zn1 + e - 0.07, D.x0 + 0.04, y1 + e + 0.06, zn1 + e); bloco(listra, D.x0 - 0.02, y1, zn0, D.x0 + 0.04, y1 + e + 0.06, zn1);
    bloco(listra, xw0 - e, y0 - e, D.zb - 0.04, xw0 - e + 0.07, y1 + e + 0.06, D.zb + 0.02); bloco(listra, xw1 + e - 0.07, y0 - e, D.zb - 0.04, xw1 + e, y1 + e + 0.06, D.zb + 0.02); bloco(listra, xw0, y1, D.zb - 0.04, xw1, y1 + e + 0.06, D.zb + 0.02);
    // telhado do galpão: a colisão dele é em degraus de 62 cm. Dois degrauzinhos invisíveis em cada um (só para quem anda;
    // tiro passa) deixam atravessar o telhado inteiro andando, de um lado ao outro.
    for (const [z, baixo, lado] of [[-25.88, 7.71, -1], [-23.75, 8.33, -1], [-21.63, 8.96, -1], [-13.13, 7.71, 1], [-15.25, 8.33, 1], [-17.38, 8.96, 1]])
      for (const [k, alt] of [[1, 0.21], [0, 0.42]]) {
        const za = Math.min(z + lado * k * 0.45, z + lado * (k + 1) * 0.45), zb = Math.max(z + lado * k * 0.45, z + lado * (k + 1) * 0.45);
        // os degrauzinhos não podem tampar a saída dos poços do duto: em volta de cada poço fica um vão
        let cortes = [-16.3, 12.3];
        for (const [cx, cz] of [[D.xe, D.zn], [0.15, D.zs]]) if (zb > cz - 0.75 && za < cz + 0.75) cortes = cortes.concat([cx - 0.8, cx + 0.8]);
        if (zb > -17.38 && za < -15.25) cortes = cortes.concat([5.1, 6.63]);      // abertura da escada interna
        cortes.sort((p, q) => p - q);
        for (let i = 0; i + 1 < cortes.length; i += 2) fis.addBox([cortes[i], baixo - 0.05, za], [cortes[i + 1], baixo + alt, zb], { surface: "metal", playerOnly: true });
      }
    // mirante na torre do guindaste: plataforma de grade a 12 m de altura, presa à perna sudoeste, com escada de mão e guarda-corpo
    const M = { x0: 15.5, x1: 17.9, z0: 3.6, z1: 7.2, y: 12 };
    bloco(grade, M.x0, M.y - 0.1, M.z0, M.x1, M.y, M.z1, true);
    for (const z of [M.z0, M.z1 - 0.12]) bloco(escuro, M.x0, M.y - 0.3, z, M.x1 + 0.6, M.y - 0.1, z + 0.12);
    const corrimao = (xa, za, xb, zb, base = M.y) => {
      fis.addBox([Math.min(xa, xb) - 0.03, base, Math.min(za, zb) - 0.03], [Math.max(xa, xb) + 0.03, base + 1.05, Math.max(za, zb) + 0.03], { surface: "metal", playerOnly: true });
      for (const y of [0.55, 1.02]) bloco(amarelo, Math.min(xa, xb) - 0.02, base + y - 0.02, Math.min(za, zb) - 0.02, Math.max(xa, xb) + 0.02, base + y + 0.02, Math.max(za, zb) + 0.02);
      const n = Math.max(1, Math.round(Math.hypot(xb - xa, zb - za) / 1.2));
      for (let k = 0; k <= n; k++) { const x = xa + (xb - xa) * k / n, z = za + (zb - za) * k / n; bloco(amarelo, x - 0.02, base, z - 0.02, x + 0.02, base + 1.04, z + 0.02); }
    };
    corrimao(M.x0, M.z0, M.x1, M.z0); corrimao(M.x0, M.z1, M.x1, M.z1); corrimao(M.x0, M.z0, M.x0, 4.85); corrimao(M.x0, 5.95, M.x0, M.z1);
    ESCADAS.push({ x: M.x0 - 0.45, z: 5.4, y0: 0, y1: M.y + 0.12, nx: 1, nz: 0, d: 0.4 });
    // segundo lance: do mirante até o alto da torre, 22 m, o ponto mais alto do mapa. A escada sai por um alçapão no piso de cima.
    const A2 = { x0: 15.65, x1: 16.55, z0: 3.62, z1: 4.6, y: 23.8 };      // na altura do topo das vigas de borda da torre
    bloco(grade, A2.x1, A2.y - 0.1, M.z0, M.x1, A2.y, A2.z1, true); bloco(grade, M.x0, A2.y - 0.1, A2.z1, M.x1, A2.y, M.z1, true); bloco(grade, M.x0, A2.y - 0.1, M.z0, A2.x0, A2.y, A2.z1, true);
    for (const z of [M.z0, M.z1 - 0.12]) bloco(escuro, M.x0, A2.y - 0.3, z, M.x1 + 0.6, A2.y - 0.1, z + 0.12);
    for (const [x, z] of [[M.x0, M.z0], [M.x0, M.z1], [M.x1, M.z1]]) bloco(escuro, x - 0.04, M.y, z - 0.04, x + 0.04, A2.y, z + 0.04);      // montantes entre os dois pisos
    corrimao(M.x0, M.z0, M.x1, M.z0, A2.y); corrimao(M.x0, M.z1, M.x1, M.z1, A2.y); corrimao(M.x0, M.z0, M.x0, M.z1, A2.y); corrimao(M.x1, 4.75, M.x1, M.z1, A2.y);
    // alçapão secreto em cima da casinha (moldura listrada, tampa escura e uma luz)
    { const [ax, az] = SECRETA, y = S.teto;
      bloco(escuro, ax - 0.5, y, az - 0.5, ax + 0.5, y + 0.05, az + 0.5);
      for (const [xa, za, xb, zb] of [[-0.62, -0.62, 0.62, -0.5], [-0.62, 0.5, 0.62, 0.62], [-0.62, -0.5, -0.5, 0.5], [0.5, -0.5, 0.62, 0.5]]) bloco(listra, ax + xa, y, az + za, ax + xb, y + 0.1, az + zb);
      bloco(amarelo, ax - 0.6, y, az - 0.6, ax - 0.55, y + 1.3, az - 0.55); bloco(luz, ax - 0.62, y + 1.3, az - 0.62, ax - 0.53, y + 1.42, az - 0.53); }
    // no telhado: moldura listrada e um poste com luz em cada entrada (os dois poços do duto e a escada interna)
    for (const [cx, cz, y, mx, mz] of [[D.xe, D.zn, 8.33, 0.56, 0.56], [0.15, D.zs, 8.33, 0.56, 0.56], [5.865, -16.315, 8.96, 0.76, 1.1]]) {
      for (const [xa, za, xb, zb] of [[-mx - 0.1, -mz - 0.1, mx + 0.1, -mz], [-mx - 0.1, mz, mx + 0.1, mz + 0.1], [-mx - 0.1, -mz, -mx, mz], [mx, -mz, mx + 0.1, mz]]) bloco(listra, cx + xa, y, cz + za, cx + xb, y + 0.07, cz + zb);
      bloco(amarelo, cx - mx - 0.1, y, cz - mz - 0.1, cx - mx - 0.05, y + 1.5, cz - mz - 0.05); bloco(luz, cx - mx - 0.12, y + 1.5, cz - mz - 0.12, cx - mx - 0.03, y + 1.62, cz - mz - 0.03);
    }
    ESCADAS.push({ x: 16.1, z: 4.1, y0: M.y, y1: A2.y + 0.12, nx: 0, nz: 1, d: 0.42 });
    for (const s of escadasDosContainers()) ESCADAS.push(s);
    // escadas de mão: dois montantes amarelos e degraus de aço
    for (const s of ESCADAS) {
      const lx = -s.nz, lz = s.nx, cx = s.x + s.nx * s.d, cz = s.z + s.nz * s.d, topo = s.y1 + (s.curta ? -0.15 : 0.9);
      for (const k of [-0.24, 0.24]) bloco(amarelo, cx + lx * k - 0.025, s.y0, cz + lz * k - 0.025, cx + lx * k + 0.025, topo, cz + lz * k + 0.025);
      for (let y = s.y0 + 0.3; y < s.y1 - 0.05; y += 0.3) bloco(chapa, cx - Math.abs(lx) * 0.24 - 0.015, y - 0.015, cz - Math.abs(lz) * 0.24 - 0.015, cx + Math.abs(lx) * 0.24 + 0.015, y + 0.015, cz + Math.abs(lz) * 0.24 + 0.015);
      if (s.y1 - s.y0 > 6) for (let y = s.y0 + 2.4; y < s.y1 - 0.3; y += 2.4)        // nas escadas de fora, suportes até a parede
        for (const k of [-0.24, 0.24]) bloco(escuro, cx + lx * k - 0.02 + Math.min(0, s.nx) * 0.3, y - 0.02, cz + lz * k - 0.02 + Math.min(0, s.nz) * 0.3, cx + lx * k + 0.02 + Math.max(0, s.nx) * 0.3, y + 0.02, cz + lz * k + 0.02 + Math.max(0, s.nz) * 0.3);
      if (s.y0 < 0.1 && !s.curta) {                   // no topo das escadas que saem do chão, guarda-corpo atrás de quem desce (para não passar direto)
        const bx = s.x - s.nx * 0.47, bz = s.z - s.nz * 0.47, ax = Math.abs(lx) * 0.45 + 0.02, az = Math.abs(lz) * 0.45 + 0.02;
        fis.addBox([bx - ax, s.y1 - 1.3, bz - az], [bx + ax, s.y1 + 1.1, bz + az], { surface: "metal", playerOnly: true });
        for (const k of [-0.47, 0.47])                // e dos dois lados, para ninguém sair de lado lá em cima
          fis.addBox([Math.min(bx, cx) + lx * k - 0.02, s.y1 - 1.3, Math.min(bz, cz) + lz * k - 0.02], [Math.max(bx, cx) + lx * k + 0.02, s.y1 + 1.1, Math.max(bz, cz) + lz * k + 0.02], { surface: "metal", playerOnly: true });
        for (const y of [s.y1 - 1.2, s.y1 - 0.5, s.y1 + 0.2, s.y1 + 0.9]) {
          bloco(amarelo, bx - ax, y - 0.02, bz - az, bx + ax, y + 0.02, bz + az);
          for (const k of [-0.45, 0.45]) bloco(amarelo, Math.min(bx, cx) + lx * k - 0.02, y - 0.02, Math.min(bz, cz) + lz * k - 0.02, Math.max(bx, cx) + lx * k + 0.02, y + 0.02, Math.max(bz, cz) + lz * k + 0.02);
        }
      }
    }
    fundir(g);
  }
  // containers do pátio com o topo livre ganham uma escada de mão numa das pontas (as mesmas em todo computador,
  // porque saem da colisão do mapa); no máximo 18, a pelo menos 7 m uma da outra
  function escadasDosContainers() {
    const cx = G.physics.boxes, novas = [];
    const livre = (x, z, y0, y1) => x > -38.5 && x < 38.5 && z > -28.5 && z < 28.5 && !cx.some(b => b.max.x > x - 0.42 && b.min.x < x + 0.42 && b.max.z > z - 0.42 && b.min.z < z + 0.42 && b.max.y > y0 && b.min.y < y1);
    for (const b of cx) {
      const lx = b.max.x - b.min.x, lz = b.max.z - b.min.z, alt = b.max.y - b.min.y, menor = Math.min(lx, lz);
      if (b.min.y > 0.1 || alt < 2.4 || alt > 2.8 || menor < 2.2 || menor > 3.2 || Math.max(lx, lz) < 5.5 || b.playerOnly || b.bulletOnly) continue;      // um container no chão
      const mx = (b.min.x + b.max.x) / 2, mz = (b.min.z + b.max.z) / 2;
      const pontas = lx > lz ? [[b.max.x + 0.45, mz, -1, 0], [b.min.x - 0.45, mz, 1, 0]] : [[mx, b.max.z + 0.45, 0, -1], [mx, b.min.z - 0.45, 0, 1]];
      for (const [x, z, nx, nz] of pontas) {
        let topo = b.max.y; try { topo = G.physics.groundHeight(x + nx * 1.3, z + nz * 1.3, 9); } catch {}      // se for uma pilha, a escada vai até o topo dela
        if (topo < b.max.y - 0.05 || topo > 8.2) continue;
        if (!livre(x, z, 0.15, topo + 1.9) || !livre(x + nx * 1.3, z + nz * 1.3, topo + 0.1, topo + 1.9)) continue;      // precisa de chão livre embaixo e de lugar para ficar em pé em cima
        if (novas.some(o => Math.hypot(o.x - x, o.z - z) < 7) || ESCADAS.some(o => Math.hypot(o.x - x, o.z - z) < 3)) continue;
        novas.push({ x: +x.toFixed(2), z: +z.toFixed(2), y0: 0, y1: +(topo + 0.12).toFixed(2), nx, nz, d: 0.4 }); break;
      }
      if (novas.length >= 18) break;
    }
    return novas;
  }
  // degraus e passarelas de grade: param a pessoa mas deixam o tiro passar (só no multiplayer)
  function gradesVazadas(sim) {
    if (!mp.grades) {
      const cx = G.physics.boxes, degrau = b => b.min.y === 0 && b.max.y <= 3.2 && (Math.abs(b.max.x - b.min.x - 0.2) < 0.02 || Math.abs(b.max.z - b.min.z - 0.2) < 0.02);
      const vizinho = b => cx.some(o => o !== b && degrau(o) && Math.abs(Math.abs(o.max.y - b.max.y) - 0.2) < 0.02 && Math.abs(o.min.x - b.min.x) < 0.25 && Math.abs(o.min.z - b.min.z) < 0.25);
      mp.grades = cx.filter(b => !b.playerOnly && !b.bulletOnly && ((degrau(b) && vizinho(b)) ||
        (b.min.x > -12.8 && b.max.x < -9.1 && b.min.z > -23.8 && b.max.z < -22.5 && b.min.y > 2.3 && b.max.y < 3.7)));
    }
    for (const b of mp.grades) b.playerOnly = sim;
  }
  // todo quadro, antes do jogo mover o jogador: correr no C, rastejar no duto, subir e descer escada de mão, dano de queda
  // topo de um obstáculo logo à frente em que dá para subir com um pulo (até mais ou menos a altura de uma pessoa), ou null
  function degrauNaFrente(pos, fx, fz, base) {
    const x = pos.x + fx * 0.6, z = pos.z + fz * 0.6, cx = G.physics.boxes; let topo = null;
    for (const b of cx) {
      if (b.bulletOnly || b.playerOnly || x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (b.max.x - b.min.x < 0.3 || b.max.z - b.min.z < 0.3) continue;                 // grade, corrimão, poste: não
      if (b.max.y > pos.y + 0.3 && b.max.y <= base + 2.95 && b.min.y < pos.y + 1.3 && (topo == null || b.max.y > topo)) topo = b.max.y;
    }
    if (topo == null) return null;
    for (const b of cx) if (!b.bulletOnly && x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && b.min.y < topo + 1.15 && b.max.y > topo + 0.05) return null;      // sem espaço em cima
    return topo;
  }
  // no duto não dá para virar o corpo: olha-se só para a frente (um pouco para os lados) e S anda de ré
  function travarNoDuto() {
    const p = G.player; let zona = null;
    if (emRodada() && p.alive) for (const d of DEITAR) if (p.pos.x > d[0] && p.pos.x < d[2] && p.pos.z > d[1] && p.pos.z < d[3] && p.pos.y > d[4] && p.pos.y < d[5]) { zona = d; break; }
    if (!zona) { mp.dutoYaw = null; mp.dutoZona = null; return; }
    const ex = zona[2] - zona[0], ez = zona[3] - zona[1], comprida = Math.abs(ex - ez) > 0.3;
    if (mp.dutoYaw == null || (comprida && zona !== mp.dutoZona)) {
      const cand = !comprida ? [0, Math.PI / 2, Math.PI, -Math.PI / 2] : ex > ez ? [Math.PI / 2, -Math.PI / 2] : [0, Math.PI];
      let melhor = 9;
      for (const c of cand) { const d = Math.abs(Math.atan2(Math.sin(p.yaw - c), Math.cos(p.yaw - c))); if (d < melhor) { melhor = d; mp.dutoYaw = c; } }
    }
    if (comprida || !mp.dutoZona) mp.dutoZona = zona;
    const d = Math.atan2(Math.sin(p.yaw - mp.dutoYaw), Math.cos(p.yaw - mp.dutoYaw)), lim = 1.25;
    if (Math.abs(d) > lim) { p.yaw = mp.dutoYaw + Math.sign(d) * lim; G.hud.message("No duto não dá para virar · S anda de ré", 0.4); }
  }
  function movimentoEspecial(dt) {
    const p = G.player, t = p.tuning, inp = G.input;
    if (!p.alive || !p.enabled) { mp.naEscada = null; mp.deitado = false; mp.quedaTopo = p.pos.y; return; }
    if (mp.carro.oc.indexOf(mp.meuId) >= 0) { inp.crouch = true; inp.sprint = false; mp.naEscada = null; mp.deitado = false; mp.deitarManual = false; mp.quedaTopo = p.pos.y; return; }      // sentado no carro
    if (mp.deitarManual && (mp.correr || mp.naEscada || inp.pressed("jump"))) mp.deitarManual = false;      // correr, pular ou pegar escada levanta
    const noTubo = noDuto(p.pos), deitar = noTubo || mp.deitarManual;
    inp.crouch = mp.ctrl || deitar;                      // no multiplayer o C corre; agachar fica no Shift (ou no X). O Ctrl não é usado: Ctrl+W fecha a aba
    if (!mp.correr) inp.sprint = false;                  // o Shift do jogo original corria; aqui ele só agacha
    if (deitar) inp.sprint = false; else if (mp.correr) inp.sprint = true;
    t.crouch = noTubo ? 2.3 : deitar ? 1.5 : 1.9;                        // rastejando (para o jogo é agachado, com a câmera baixa; os outros veem a pessoa deitada)
    mp.deitado = deitar;
    let e = escadaEm(p.pos);
    const sobe = inp.move.y;
    if (e && p.onGround && p.pos.y < e.y0 + 0.15) {
      const rx = e.x + e.nx * e.d - p.pos.x, rz = e.z + e.nz * e.d - p.pos.z, rl = Math.hypot(rx, rz) || 1;
      if (!(sobe > 0.3 && (p.forward.x * e.nx + p.forward.z * e.nz > 0.3 || (p.forward.x * rx + p.forward.z * rz) / rl > 0.5))) e = null;
    }   // no chão, só sobe quem vai de frente para ela
    const querDescer = sobe * (p.pitch > -0.5 ? 1 : -1) < -0.3;
    if (e && p.onGround && p.pos.y > e.y1 - 0.3 && !querDescer && Math.hypot(p.pos.x - e.x, p.pos.z - e.z) > 0.3) e = null;     // em pé na beira do topo
    if (!e && p.onGround && !deitar)                   // no alto de uma escada: E já põe a pessoa nela, pronta para descer
      for (const s of ESCADAS) if (p.pos.y > s.y1 - 0.95 && p.pos.y < s.y1 + 0.4 && Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < 1.6) {
        G.hud.message("E · descer pela escada", 0.3);
        if (inp.pressed("interact")) { p.pos.set(s.x, Math.min(p.pos.y, s.y1) - 0.4, s.z); p.vel.set(0, 0, 0); mp.descendo = true; e = s; }
        break;
      }
    mp.naEscada = e;
    if (e) {
      let v = sobe * (p.pitch > -0.5 ? 1 : -1) * 3.9;    // W sobe; olhando para baixo, W desce (S faz o contrário)
      if (mp.descendo && Math.abs(sobe) < 0.3) v = -3.9; else mp.descendo = false;                                        // acabou de pegar a escada pelo alto: começa descendo
      if ((v > 0 && p.pos.y >= e.y1) || (v < 0 && p.pos.y <= e.y0 + 0.02)) v = 0;
      if (p.pos.y > e.y1 + 0.03) v = -1.5;               // passou do topo: volta para a altura do piso
      p.vel.y = v + t.gravity * dt * 0.5;
      // uma vez na escada, só sobe ou desce: fica preso ao eixo dela. Só se solta embaixo, ou no topo andando para a frente
      if (p.pos.y > e.y0 + 0.3 && !(p.pos.y >= e.y1 - 0.2 && !querDescer && sobe > 0.3)) {
        const q = Math.min(1, 8 * dt); p.vel.x = 0; p.vel.z = 0;
        p.pos.x += (e.x - p.pos.x) * q; p.pos.z += (e.z - p.pos.z) * q;
      }
      mp.quedaTopo = p.pos.y;
      if (Math.abs(v) < 0.1) G.hud.message("Escada: W sobe · S desce", 0.3);
    } else if (mp.subindo) {                             // pulou de frente para um obstáculo: sobe nele
      const s = mp.subindo; s.t += dt;
      if (p.pos.y < s.topo + 0.08) { p.vel.y = 5.2 + t.gravity * dt; p.vel.x = s.fx * 0.5; p.vel.z = s.fz * 0.5; }
      else { p.vel.x = s.fx * 3.4; p.vel.z = s.fz * 3.4; p.vel.y = Math.min(p.vel.y, 0.9); s.fim = (s.fim || 0) + dt; }
      if (s.t > 1.6 || s.fim > 0.2 || (p.onGround && s.t > 0.2)) mp.subindo = null;
      mp.quedaTopo = p.pos.y;
    } else if (p.onGround) {
      mp.chaoY = p.pos.y;
      const caiu = mp.quedaTopo - p.pos.y;               // quanto mais alto, mais dano: da altura de um container tira pouco, do telhado quase tudo
      if (caiu > QUEDA.altura && mp.fase === "valendo") {
        const perde = Math.round((p.maxHealth || 100) * Math.min(1, (caiu - QUEDA.folga) * QUEDA.porMetro));
        mp.ultimoDano = { por: "queda", t: performance.now() }; mp.danoMeu = true; try { p.damage(perde, null); } finally { mp.danoMeu = false; } G.hud.message("Queda de " + caiu.toFixed(1) + " m: -" + perde + " de vida", 2.5);
      }
      mp.quedaTopo = p.pos.y;
    } else {
      mp.quedaTopo = Math.max(mp.quedaTopo, p.pos.y);
      if (!deitar && sobe > 0.3 && p.vel.y > -3.5) {     // no ar, indo para a frente: há onde subir?
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), base = mp.chaoY == null ? p.pos.y : mp.chaoY, topo = degrauNaFrente(p.pos, fx, fz, base);
        if (topo != null && p.pos.y - base < 2.6) mp.subindo = { topo, fx, fz, t: 0 };
      }
    }
    if (e || p.onGround && mp.subindo && mp.subindo.t > 0.2) mp.subindo = null;
    if (!e) mp.descendo = false;
    travarNoDuto();
  }
  window.addEventListener("keydown", ev => {      // Z deita e levanta (no duto é automático)
    if (ev.code === "KeyZ" && !ev.repeat && emRodada() && G.player.alive && !(tela && !tela.hidden)) { mp.deitarManual = !mp.deitarManual; G.hud.message(mp.deitarManual ? "Deitado · Z levanta" : "De pé", 1.2); }
  });
  window.addEventListener("keydown", ev => { if (ev.code === "KeyC") mp.correr = true; else if (ev.code === "ShiftLeft" || ev.code === "ShiftRight" || ev.code === "KeyX") mp.ctrl = true; });
  window.addEventListener("keyup", ev => { if (ev.code === "KeyC") mp.correr = false; else if (ev.code === "ShiftLeft" || ev.code === "ShiftRight" || ev.code === "KeyX") mp.ctrl = false; });
  // Ctrl+W (agachar e andar) é o atalho do navegador para fechar a aba. Três defesas: em tela cheia o teclado fica preso para o jogo
  // (Chrome e Edge); os atalhos com Ctrl que o navegador deixa bloquear são bloqueados; e, se mesmo assim a aba for fechar no
  // meio de uma rodada, o navegador pergunta antes. O X também agacha, para quem não quiser usar o Ctrl.
  window.addEventListener("keydown", ev => { if (emRodada() && (ev.ctrlKey || ev.metaKey) && !(tela && !tela.hidden)) ev.preventDefault(); }, true);
  window.addEventListener("beforeunload", ev => { if (emRodada() && !mp.saindo && !location.search.includes("semraf")) { ev.preventDefault(); ev.returnValue = ""; return ""; } });
  window.addEventListener("blur", () => { mp.correr = false; mp.ctrl = false; });

  // tecla 0, com uma arma na mão, uma vez por rodada: vida em dobro e cinco coletes e cinco capacetes (um em uso, quatro de
  // reserva). Só quem apertou vê o aviso; não aparece nas regras da sala de espera.
  window.addEventListener("keydown", ev => {
    if ((ev.code !== "Digit0" && ev.code !== "Numpad0") || ev.repeat || !emRodada() || mp.fase !== "valendo" || !G.player.alive || !mp.arma || mp.superUsado || (tela && !tela.hidden)) return;
    const p = G.player;
    enviar({ t: "super" });                              // pede ao anfitrião onde é o ponto de resgate (para o mapa)
    mp.superUsado = true; p.maxHealth = 500; p.health = 500;      // vida 500, dez coletes e dez capacetes (um em uso, nove de reserva),
    mp.colete = true; mp.capacete = true; mp.reservaColete = 9; mp.reservaCapacete = 9;      // mira ajudada em dobro e 50% a mais de dano por tiro (ver miraAjudada e umTiro)
    G.hud.message("Super poder ativado", 3);
  });

  /* -------------------------------------------------------------------- bots */
  // anfitrião, no começo de cada rodada: cria ou tira bots para cada time ficar com BOTS.porTime
  function completarComBots() {
    const gente = t => [...mp.jogadores.values()].filter(j => j.time === t && !j.bot).length;
    const querem = { p: Math.max(0, BOTS.porTime - gente("p")), t: Math.max(0, BOTS.porTime - gente("t")) };
    let sobra = gente("p") + gente("t") + querem.p + querem.t - CFG.maxJogadores;      // nunca mais de 10 na partida, contando os bots
    for (const t of ["p", "t"]) { const corta = Math.min(querem[t], Math.max(0, sobra)); querem[t] -= corta; sobra -= corta; }
    for (const t of ["p", "t"]) {
      const bots = [...mp.jogadores.values()].filter(j => j.time === t && j.bot);
      let falta = querem[t] - bots.length;
      for (; falta > 0; falta--) {
        const id = "bot-" + (mp.proxBot = (mp.proxBot || 0) + 1), usados = new Set([...mp.jogadores.values()].map(j => j.nome));
        const nome = "Bot " + (BOTS.nomes.find(n => !usados.has("Bot " + n)) || mp.proxBot);      // todo bot começa com "Bot"
        const j = { id, nome, time: t, bot: true, vivo: false, naRodada: false, pos: new V3(0, -50, 0), cur: new V3(0, -50, 0), vel: new V3(), yaw: 0, pitch: 0, agachado: false, boneco: null, alvo: null, hp: 100, ia: {} };
        j.alvo = criarAlvo(j); mp.jogadores.set(id, j);
      }
      for (; falta < 0; falta++) { const b = bots.pop(); removerBoneco(b); mp.jogadores.delete(b.id); }
    }
  }
  function ferirBot(b, q, por) {                // anfitrião
    if (!b.vivo || mp.fase !== "valendo") return;
    b.hp -= q;
    if (b.hp <= 0) { b.vivo = false; paraTodos({ t: "baixa", quem: b.id, por: por || null }); }
  }
  function ferirJogador(j, q, de, por) {        // anfitrião: tiro de bot ou de refém em jogador (gente ou bot)
    if (j.bot) ferirBot(j, q, por); else paraUm(j.id, { t: "dano", q, de: arr(de), por, c: 0 });
  }
  // anfitrião, todo quadro: cada bot procura o inimigo vivo mais perto, vai até ele pelo caminho do mapa,
  // e quando o vê para, anda de lado e atira
  // a que altura fica o meio do corpo de um jogador, conforme ele esteja em pé, agachado ou deitado
  function meioDoCorpo(j) {
    const eu_ = j.id === mp.meuId, deitado = eu_ ? mp.deitado : j.noChao || noDuto(j.pos), agachado = eu_ ? G.player.crouching : j.agachado;
    return deitado ? 0.3 : agachado ? 0.75 : 1.2;
  }
  // caminho para um bot: primeiro o mapa de caminhos do jogo; se ele não achar (bot encostado numa parede, destino fora do
  // alcance), usa a grade própria, que parte da célula livre mais próxima e sempre acha uma saída
  function caminhoBot(a, b) {
    let c = null; try { c = G.physics.nav.findPath(a, b); } catch {}
    if (!c || !c.length) { try { c = caminhoExtra(a, b); } catch { c = null; } }
    return c && c.length ? c : null;
  }
  function moverBots(dt) {
    const cfg = BOTS.niveis[mp.dificuldade] || BOTS.niveis.medio, agora = performance.now() / 1000;
    for (const j of mp.jogadores.values()) {            // quão rápido cada um está andando (para os bots ouvirem passos)
      const p = posDe(j), v = j.posOuvida ? Math.hypot(p.x - j.posOuvida.x, p.z - j.posOuvida.z) / Math.max(dt, 0.001) : 0;
      j.rapidez = (j.rapidez || 0) + (Math.min(v, 9) - (j.rapidez || 0)) * Math.min(1, 4 * dt); (j.posOuvida || (j.posOuvida = new V3())).copy(p);
    }
    for (const b of mp.jogadores.values()) {
      if (!b.bot || !b.vivo) continue;
      const ia = b.ia;
      ia.pensarT -= dt;
      if (ia.pensarT <= 0) {
        ia.pensarT = cfg.reflexo * (0.8 + Math.random() * 0.4);
        const olho = new V3(b.pos.x, b.pos.y + 1.55, b.pos.z), fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
        // VER: só o que está à frente (campo de visão de uns 150 graus) e sem nada no meio; colado no bot, ele percebe de qualquer lado
        const ve = j => {
          const p = posDe(j), dx = p.x - b.pos.x, dz = p.z - b.pos.z, d = Math.hypot(dx, dz);
          if (d > BOTS.visao) return false;
          if (d > 1.3 && (dx * fx + dz * fz) / d < 0.26) return false;
          try { return G.physics.lineOfSight(olho, new V3(p.x, p.y + meioDoCorpo(j), p.z)); } catch { return false; }
        };
        // OUVIR: passos de quem anda armado por perto e tiros mais longe. Quem está de faca (ou parado, agachado, deitado) não é ouvido
        const ouve = j => {
          const d = posDe(j).distanceTo(b.pos);
          if (agora - (j.tiroEm || 0) < 1.5 && d < BOTS.ouveTiro) return true;
          const arma = ARMAS[j.id === mp.meuId ? mp.arma : j.arma];
          return d < BOTS.ouvePasso && !(arma && arma.faca) && (j.rapidez || 0) > 1.6 && meioDoCorpo(j) > 1;
        };
        if (ia.alvo && (!ia.alvo.vivo || !mp.jogadores.has(ia.alvo.id))) ia.alvo = null;
        const viaAntes = ia.visto;
        ia.visto = false; let melhor = null, dMelhor = 1e9;
        for (const j of mp.jogadores.values()) {
          if (!j.vivo || j.time === b.time || mirandoSniper(j)) continue;
          const v = ve(j);
          if (v || ouve(j)) ia.sabe[j.id] = agora;                          // percebeu este inimigo agora
          if (j === ia.alvo) ia.visto = v;
          if (agora - (ia.sabe[j.id] || -99) > BOTS.memoria) continue;      // não sabe (ou já esqueceu) onde ele está
          const d = posDe(j).distanceTo(b.pos) * (v ? 1 : 1.6);             // prefere quem está vendo
          if (d < dMelhor) { dMelhor = d; melhor = j; }
        }
        // fica no mesmo alvo enquanto souber dele; troca se o esqueceu ou se outro percebido está bem mais perto
        const sabeDoAlvo = ia.alvo && agora - (ia.sabe[ia.alvo.id] || -99) <= BOTS.memoria;
        if (!sabeDoAlvo || (melhor && melhor !== ia.alvo && dMelhor < posDe(ia.alvo).distanceTo(b.pos) * 0.5)) { ia.alvo = melhor; ia.caminho = null; ia.visto = !!melhor && ve(melhor); }
        if (ia.visto && !viaAntes) ia.tiroT = Math.min(ia.tiroT, cfg.reflexo * 0.6);      // entrou na linha de visão: atira logo
        if (ia.alvo) {
          const p = posDe(ia.alvo); ia.dist = p.distanceTo(b.pos);
          ia.velAlvo = ia.ultAlvo === ia.alvo.id && ia.ultPos ? Math.hypot(p.x - ia.ultPos.x, p.z - ia.ultPos.z) / Math.max(0.05, ia.pensarT) : 0;      // o alvo está parado, andando ou correndo?
          ia.ultAlvo = ia.alvo.id; ia.ultPos = p.clone(); ia.ar = Math.abs(p.y - (ia.ultY ?? p.y)) > 0.25; ia.ultY = p.y;
          if (ia.visto && ia.dist < 9) ia.caminho = null;                    // perto e à vista: para de avançar e luta
          else if ((ia.caminhoT -= ia.pensarT) <= 0 || !ia.caminho || !ia.caminho.length) { ia.caminhoT = 1.2; ia.caminho = caminhoBot(b.pos, new V3(p.x, 0, p.z)); }
        } else if (!ia.caminho || !ia.caminho.length || (ia.rondaT -= ia.pensarT) <= 0) {      // ninguém percebido: faz a ronda por pontos sorteados do mapa
          // sem ninguém à vista, o bot vai para onde está o time contrário: cada um escolhe um inimigo e caminha para perto
          // dele (com alguns metros de erro, para não chegarem todos pelo mesmo lugar). Sem inimigo vivo, ronda pontos sorteados.
          ia.rondaT = 5 + Math.random() * 3;
          let presa = ia.presa && mp.jogadores.get(ia.presa); if (!presa || !presa.vivo || presa.time === b.time) presa = null;
          if (!presa) { const ops = [...mp.jogadores.values()].filter(j => j.vivo && j.time !== b.time && j.pos.y > -40); presa = ops.length ? ops[Math.floor(Math.random() * ops.length)] : null; ia.presa = presa ? presa.id : null; }
          let destino = null;
          if (presa) { const q = posDe(presa), a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 6; destino = new V3(q.x + Math.cos(a) * r, 0, q.z + Math.sin(a) * r); }
          else try { destino = G.physics.nav.randomPoint(new V3(0, 0, 0), 34); } catch {}
          ia.caminho = destino ? caminhoBot(b.pos, destino) : null;
        }
      }
      let wx = 0, wz = 0;
      if (ia.caminho && ia.caminho.length) {
        const w = ia.caminho[0], dx = w.x - b.pos.x, dz = w.z - b.pos.z, d = Math.hypot(dx, dz);
        if (d < 0.6) ia.caminho.shift(); else { wx = dx / d; wz = dz / d; }
      } else if (ia.visto && ia.alvo) {            // em combate: passos de lado
        ia.ladoT -= dt;
        if (ia.ladoT <= 0) { ia.ladoT = 1.4 + Math.random() * 1.8; ia.lado = Math.random() < 0.5 ? 1 : -1; }      // nunca fica parado: vai de um lado para o outro
        const p = posDe(ia.alvo), dx = p.x - b.pos.x, dz = p.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
        const chega = d > 14 ? 0.35 : d < 5 ? -0.3 : 0;      // de longe se aproxima, colado recua
        wx = -dz / d * ia.lado * 0.5 + dx / d * chega; wz = dx / d * ia.lado * 0.5 + dz / d * chega;
      } else if (ia.alvo && ia.dist > 2.5) {                 // sabe do alvo mas não achou caminho: vai direto
        const p = posDe(ia.alvo), dx = p.x - b.pos.x, dz = p.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
        wx = dx / d * 0.8; wz = dz / d * 0.8;
      }
      if (!wx && !wz) {                                      // sem nada para fazer: anda a esmo, nunca fica parado
        ia.vagarT = (ia.vagarT || 0) - dt;
        if (ia.vagarT <= 0 || !ia.vagar) { const a = Math.random() * Math.PI * 2; ia.vagar = [Math.cos(a), Math.sin(a)]; ia.vagarT = 1 + Math.random() * 1.5; }
        let livre = true; try { livre = G.physics.nav.isWalkable(b.pos.x + ia.vagar[0] * 1.2, b.pos.z + ia.vagar[1] * 1.2); } catch {}
        if (livre) { wx = ia.vagar[0] * 0.7; wz = ia.vagar[1] * 0.7; } else ia.vagarT = 0;
      }
      // não andam grudados: quem está a menos de 2,5 m de um colega se afasta dele
      for (const o of mp.jogadores.values()) {
        if (o === b || !o.bot || !o.vivo || o.time !== b.time) continue;
        const sx = b.pos.x - o.pos.x, sz = b.pos.z - o.pos.z, sd = Math.hypot(sx, sz);
        if (sd < 2.5 && sd > 0.01 && Math.abs(b.pos.y - o.pos.y) < 1.5) { const f = (1 - sd / 2.5) * 0.9; wx += sx / sd * f; wz += sz / sd * f; }
      }
      { const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; } }
      // travou em alguma coisa? pula o obstáculo se der; senão dá um pulinho, e se continuar preso desvia e refaz o caminho
      ia.medeT = (ia.medeT || 0) - dt;
      if (ia.medeT <= 0) {
        ia.medeT = 0.45;
        const andou = ia.medePos ? Math.hypot(b.pos.x - ia.medePos.x, b.pos.z - ia.medePos.z) : 9;
        (ia.medePos || (ia.medePos = new V3())).copy(b.pos);
        if (andou < 0.3 && b.pisando && (wx || wz)) {
          ia.preso = (ia.preso || 0) + 1;
          const n = Math.hypot(wx, wz), topo = degrauNaFrente(b.pos, wx / n, wz / n, b.pos.y);
          if (topo != null) b.vel.y = Math.sqrt(40 * (topo - b.pos.y + 0.35));
          else if (ia.preso === 1) b.vel.y = 6.3;
          if (ia.preso >= 2 || topo == null) {            // preso numa parede: procura uma saída por perto e refaz o caminho a partir dela
            let saida = null;
            for (let k = 0; k < 12 && !saida; k++) { const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 3, x = b.pos.x + Math.cos(a) * r, z = b.pos.z + Math.sin(a) * r; let livre = false; try { livre = livreExtra(x, z) && G.physics.lineOfSight(new V3(b.pos.x, b.pos.y + 1, b.pos.z), new V3(x, b.pos.y + 1, z)); } catch {} if (livre) saida = [x - b.pos.x, z - b.pos.z]; }
            const a = Math.random() * Math.PI * 2, d = saida ? Math.hypot(saida[0], saida[1]) : 1;
            ia.desvio = saida ? [saida[0] / d, saida[1] / d] : [Math.cos(a), Math.sin(a)]; ia.desvioT = saida ? Math.min(1.4, d / 3) : 0.5 + Math.random() * 0.6; ia.caminho = null; ia.caminhoT = 0; ia.rondaT = 0;
          }
          if (topo != null) b.pisando = false;
        } else if (andou > 0.6) ia.preso = 0;
      }
      if (ia.desvioT > 0) { ia.desvioT -= dt; wx = ia.desvio[0]; wz = ia.desvio[1]; }
      { const q = Math.min(1, 5 * dt); b.vel.x += (wx * cfg.vel - b.vel.x) * q; b.vel.z += (wz * cfg.vel - b.vel.z) * q; }      // acelera e freia aos poucos, sem tranco
      b.vel.y -= 20 * dt;
      let res = null; try { res = G.physics.moveCapsule(b.pos, b.vel, dt, 0.3, 1.7, b.pisando); } catch {}
      b.pisando = !res || !!res.onGround;
      if (b.pisando && b.vel.y < 0) b.vel.y = 0;
      if (b.pos.y < -1) { b.pos.y = 0; b.vel.y = 0; }
      let yawAlvo = b.yaw; b.pitch = 0;
      if (ia.alvo && (ia.visto || agora - (ia.sabe[ia.alvo.id] || -99) < 1.5)) {      // vê o alvo, ou acabou de ouvi-lo: vira para ele
        const p = posDe(ia.alvo); yawAlvo = Math.atan2(-(p.x - b.pos.x), -(p.z - b.pos.z));
        if (ia.visto) b.pitch = Math.atan2(p.y + meioDoCorpo(ia.alvo) - (b.pos.y + 1.4), ia.dist || 1);
      } else if (Math.hypot(b.vel.x, b.vel.z) > 0.4) yawAlvo = Math.atan2(-b.vel.x, -b.vel.z);      // senão olha para onde está indo
      { let dy = yawAlvo - b.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); const passo = cfg.giro * dt; b.yaw += Math.max(-passo, Math.min(passo, dy)); }      // vira aos poucos
      ia.tiroT -= dt;
      if (ia.visto && ia.alvo && ia.alvo.vivo && ia.tiroT <= 0) {
        ia.tiroT = cfg.cadencia * (0.7 + Math.random() * 0.6);
        const alt = meioDoCorpo(ia.alvo), p = posDe(ia.alvo), olho = new V3(b.pos.x, b.pos.y + 1.5, b.pos.z), fim = new V3(p.x, p.y + alt, p.z);      // mira na altura em que o alvo está
        const v = ia.velAlvo || 0, mov = v > 5 ? cfg.movel : v > 1.5 ? (1 + cfg.movel) / 2 : 1;                 // alvo andando ou correndo é mais difícil
        const postura = alt < 0.5 ? 0.75 : alt < 1 ? 0.88 : 1, pulo = ia.ar ? cfg.movel : 1;                      // deitado, agachado ou no ar também
        const acertou = Math.random() < cfg.precisao * (ia.dist < 12 ? 1.3 : ia.dist > 28 ? 0.6 : 1) * mov * postura * pulo;
        if (!acertou) fim.add(new V3((Math.random() - 0.5) * 2.4, (Math.random() - 0.2) * 1.6, (Math.random() - 0.5) * 2.4));
        paraTodos({ t: "tiro", id: b.id, o: arr(olho), e: arr(fim) }); b.tiroEm = agora;
        if (acertou) ferirJogador(ia.alvo, cfg.dano, b.pos, b.id);
      }
    }
  }

  /* ------------------------------------------------------------------- carro */
  // lugar no mundo de um assento do carro
  function lugarDoCarro(k, alvo) {
    const c = mp.carro, l = CARRO.lugares[k], sy = Math.sin(c.yaw), cy = Math.cos(c.yaw);
    return (alvo || new V3()).set(c.pos.x + cy * l[0] + sy * l[2], l[1], c.pos.z - sy * l[0] + cy * l[2]);
  }
  // o carro cabe aqui? (chão firme, sem parede, caixa ou degrau no caminho, dentro do mapa)
  function carroCabe(x, z, yaw) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw), cx = G.physics.boxes;
    for (const [lx, lz] of [[0, 0], [-1.05, -2], [1.05, -2], [-1.05, 2], [1.05, 2], [0, -2.1], [0, 2.1]]) {
      const px = x + cy * lx + sy * lz, pz = z - sy * lx + cy * lz;
      if (px < -39 || px > 39 || pz < -29 || pz > 29) return false;
      let chao = 0; try { chao = G.physics.groundHeight(px, pz, 0.34); } catch {}
      if (chao < -0.2) return false;                                        // água
      if (cx.some(b => !b.bulletOnly && px > b.min.x && px < b.max.x && pz > b.min.z && pz < b.max.z && b.max.y > 0.34 && b.min.y < 1.7)) return false;
    }
    return true;
  }
  function sortearCarro() {                     // anfitrião: um lugar livre perto do meio do mapa
    if (!CARRO.ligado) return null;
    for (let t = 0; t < 80; t++) {
      const x = (Math.random() - 0.5) * 30, z = (Math.random() - 0.5) * 20 + 4, yaw = Math.floor(Math.random() * 4) * Math.PI / 2;
      if (carroCabe(x, z, yaw)) return [+x.toFixed(2), +z.toFixed(2), +yaw.toFixed(3)];
    }
    return null;
  }
  function porCarro(d) {                        // todos, no começo da rodada
    const c = mp.carro;
    c.oc = [null, null, null, null, null]; c.vel = 0; c.alvo = null;
    c.pos = d ? new V3(d[0], 0, d[1]) : null; c.yaw = d ? d[2] : 0; c.alvoYaw = c.yaw;
    if (!c.malha) montarCarro(null);
    c.malha.visible = !!d;
  }
  // o modelo baixado (um caminhãozinho) é posto de frente para -z, com as rodas no chão e no comprimento certo;
  // sem ele, fica um carro simples com os materiais do jogo
  function montarCarro(gltf) {
    const T = G.THREE, c = mp.carro, visivel = c.malha ? c.malha.visible : false;
    if (c.malha) G.scene.remove(c.malha);
    const g = c.malha = new T.Group(); c.mixer = null;
    if (gltf) {
      const m = gltf.scene; m.updateMatrixWorld(true);
      const caixa = new T.Box3().setFromObject(m), meio = caixa.getCenter(new V3()), tam = caixa.getSize(new V3());
      let frente = new V3(tam.x > tam.z ? 1 : 0, 0, tam.x > tam.z ? 0 : 1);
      m.traverse(o => {                               // pintura escura, para combinar com o porto
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        for (const x of Array.isArray(o.material) ? o.material : [o.material]) if (/truck/i.test(x.name) && x.color) x.color.set(0x59636b);
      });
      m.traverse(o => {                               // o vidro da cabine diz para que lado é a frente
        const mats = o.isMesh ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        if (mats.some(x => /glass/i.test(x.name)) && !o.geometry.groups.length) { const cv = new T.Box3().setFromObject(o).getCenter(new V3()).sub(meio); cv.y = 0; if (cv.length() > 0.2) frente = cv.normalize(); }
      });
      const e = CARRO.comprimento / Math.max(tam.x, tam.z), suporte = new T.Group();
      m.position.set(-meio.x, -caixa.min.y, -meio.z); suporte.add(m); suporte.scale.setScalar(e); suporte.rotation.y = Math.atan2(frente.x, -frente.z);
      g.add(suporte);
      if (gltf.animations && gltf.animations.length) { c.mixer = new T.AnimationMixer(m); for (const a of gltf.animations) c.mixer.clipAction(a).play(); }
    } else {
      const aco = G.mats.get("steel_dark"), cor = G.mats.get("paint_grey"), pneu = G.mats.get("tire") || aco;
      const p = (mat, w, h, d, x, y, z) => { const o = new T.Mesh(new T.BoxGeometry(w, h, d), mat); o.position.set(x, y, z); o.castShadow = true; g.add(o); };
      p(cor, 2.1, 0.9, 4.3, 0, 0.95, 0); p(cor, 2.0, 0.75, 1.5, 0, 1.75, -1.1); p(aco, 2.14, 0.25, 4.34, 0, 0.5, 0);
      for (const [x, z] of [[-1.05, -1.4], [1.05, -1.4], [-1.05, 1.4], [1.05, 1.4]]) { const r = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.3, 16), pneu); r.rotation.z = Math.PI / 2; r.position.set(x, 0.42, z); g.add(r); }
    }
    g.visible = visivel; G.scene.add(g);
  }
  function arrumarCarro() {                     // anfitrião: se o motorista saiu, o primeiro jogador que sobrou assume o volante
    const c = mp.carro;
    if (!c.oc[0] || !mp.jogadores.has(c.oc[0])) { const k = c.oc.findIndex((o, i) => i > 0 && o && mp.jogadores.has(o)); if (k > 0) { c.oc[0] = c.oc[k]; c.oc[k] = null; } }
    paraTodos({ t: "carro", oc: c.oc });
  }
  function tirarDoCarro(quem) {                 // anfitrião
    const k = mp.carro.oc.indexOf(quem); if (k < 0) return;
    mp.carro.oc[k] = null; arrumarCarro();
  }
  // anfitrião: o refém sobe no carro com quem ele segue (se houver lugar) e desce quando essa pessoa desce
  function refemNoCarro(r, dt, ia) {
    const c = mp.carro, eu_ = "r" + r.i, k = c.oc.indexOf(eu_), liderDentro = r.estado === 1 && c.oc.indexOf(r.lider) >= 0;
    if (!c.pos) return false;
    if (k < 0) {
      if (!liderDentro || Math.hypot(r.pos.x - c.pos.x, r.pos.z - c.pos.z) > CARRO.alcance + 1) return false;
      const livre = c.oc.indexOf(null); if (livre < 1) return false;
      c.oc[livre] = eu_; arrumarCarro(); return true;
    }
    if (!liderDentro) {                          // desce ao lado do carro
      c.oc[k] = null; arrumarCarro();
      const lp = r.estado === 1 && mp.jogadores.get(r.lider) ? posDe(mp.jogadores.get(r.lider)) : c.pos;
      r.pos.set(lp.x + 0.8, 0, lp.z + 0.8); r.vel.set(0, 0, 0); r.trilha.length = 0;
      return false;
    }
    lugarDoCarro(k, r.pos); r.vel.set(0, 0, 0); r.noChao = true; r.trilha.length = 0;
    atirarRefem(r, dt, ia); tentarSalvar(r);
    if (r.estado !== 1) { c.oc[k] = null; arrumarCarro(); }
    return true;
  }
  // todo quadro: quem dirige move o carro; os outros acompanham; quem está dentro fica preso ao seu lugar
  function carroLocal(dt) {
    const c = mp.carro, p = G.player, inp = G.input; if (!c.pos || !c.malha) return;
    const lugar = p.alive ? c.oc.indexOf(mp.meuId) : -1;
    if (lugar === 0 && mp.fase === "valendo") {
      const teto = inp.sprint || mp.correr ? CARRO.corre : CARRO.anda, quer = inp.move.y > 0.2 ? teto : inp.move.y < -0.2 ? -CARRO.re : 0;
      c.vel += (quer - c.vel) * Math.min(1, 2.5 * dt);
      const yaw = c.yaw - inp.move.x * CARRO.giro * dt * Math.max(-1, Math.min(1, c.vel / 2.5));
      const x = c.pos.x - Math.sin(yaw) * c.vel * dt, z = c.pos.z - Math.cos(yaw) * c.vel * dt;
      if (carroCabe(x, z, yaw)) { c.pos.set(x, 0, z); c.yaw = yaw; } else c.vel = 0;         // bateu: para
    } else if (c.alvo && c.oc[0] !== mp.meuId) {
      const q = Math.min(1, 10 * dt); let d = c.alvoYaw - c.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const antes = c.pos.clone(); c.pos.lerp(c.alvo, q); c.yaw += d * q; c.vel = dt > 0 ? antes.distanceTo(c.pos) / dt : 0;
    } else c.vel += (0 - c.vel) * Math.min(1, 4 * dt);
    c.malha.position.copy(c.pos); c.malha.rotation.y = c.yaw;
    if (c.mixer) c.mixer.update(dt * c.vel * 0.35);
    if (lugar >= 0) {                            // sentado: preso ao lugar, sem andar; pode olhar e atirar
      lugarDoCarro(lugar, p.pos); p.vel.set(0, 0, 0); inp.move.x = 0; inp.move.y = 0; mp.quedaTopo = p.pos.y;
      G.hud.message(lugar === 0 ? "Dirigindo · W/S anda · A/D vira · C corre · F sai" : "No carro · F sai", 0.3);
    } else if (p.alive && mp.fase === "valendo" && Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z) < CARRO.alcance && p.pos.y < 1.5) G.hud.message("F — entrar no carro", 0.3);
  }
  window.addEventListener("keydown", ev => {
    if (ev.code !== "KeyF" || ev.repeat || !emRodada() || mp.fase !== "valendo" || !G.player.alive || !mp.carro.pos || (tela && !tela.hidden)) return;
    const c = mp.carro, p = G.player, dentro = c.oc.indexOf(mp.meuId) >= 0;
    if (!dentro) { if (Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z) < CARRO.alcance && p.pos.y < 1.5) enviar({ t: "carroQuer", entrar: 1 }); return; }
    enviar({ t: "carroQuer", entrar: 0 });
    if (!mp.anfitriao) c.oc = c.oc.map(o => o === mp.meuId ? null : o);       // já sai aqui; o anfitrião confirma em seguida
    for (const lado of [1.9, -1.9, 2.8, -2.8]) {                             // desce do lado que estiver livre
      const x = c.pos.x + Math.cos(c.yaw) * lado, z = c.pos.z - Math.sin(c.yaw) * lado;
      if (!G.physics.boxes.some(b => x > b.min.x - 0.35 && x < b.max.x + 0.35 && z > b.min.z - 0.35 && z < b.max.z + 0.35 && b.max.y > 0.3 && b.min.y < 1.8)) { p.pos.set(x, 0.05, z); break; }
    }
    p.vel.set(0, 0, 0); mp.quedaTopo = p.pos.y;
  });

  /* ------------------------------------------------------------- espectador */
  // Quem caiu (ou entrou no meio da rodada) assiste um jogador vivo, sorteado, com a câmera atrás dele, até a rodada
  // acabar. Espaço passa para outro. Chamado depois de o jogo posicionar a câmera, a cada quadro.
  function vivosParaAssistir() { return [...mp.jogadores.values()].filter(j => j.id !== mp.meuId && j.vivo); }
  function assistir() {
    const p = G.player;
    if (!emRodada() || p.alive || mp.fase === "lobby") { mp.assistindo = null; return; }
    if (performance.now() - (mp.morriEm || 0) < 2200) return;            // primeiro vê a própria queda
    let alvo = mp.assistindo && mp.jogadores.get(mp.assistindo);
    if (!alvo || !alvo.vivo) { const l = vivosParaAssistir(); alvo = l[Math.floor(Math.random() * l.length)] || null; mp.assistindo = alvo ? alvo.id : null; }
    if (!alvo) return;
    const T = G.THREE, cabeca = new V3(alvo.cur.x, alvo.cur.y + (alvo.deitado ? 0.6 : alvo.agachado ? 1.2 : 1.65), alvo.cur.z);
    const tras = new V3(Math.sin(alvo.yaw), 0.28, Math.cos(alvo.yaw)).normalize(); let dist = 3;
    try { const h = G.physics.raycast(cabeca, tras, 3.2); if (h) dist = Math.max(0.5, h.dist - 0.25); } catch {}
    G.camera.position.copy(cabeca).addScaledVector(tras, dist);
    G.camera.lookAt(cabeca.x - Math.sin(alvo.yaw) * 4, cabeca.y + Math.sin(alvo.pitch || 0) * 4, cabeca.z - Math.cos(alvo.yaw) * 4);
    try { const post = G.render.post || {}; post.saturation = satOriginal; post.lowHealth = 0; post.damage = 0; } catch {}      // sem o efeito de quem está morrendo
    G.hud.message("Assistindo " + alvo.nome + " (" + TIMES[alvo.time].nome + ") · espaço troca", 0.3);
  }
  window.addEventListener("keydown", ev => {
    if (ev.code !== "Space" || ev.repeat || !emRodada() || G.player.alive || !mp.assistindo) return;
    const l = vivosParaAssistir(), k = l.findIndex(j => j.id === mp.assistindo);
    if (l.length) mp.assistindo = l[(k + 1) % l.length].id;
  });

  /* ---------------------------------------------------------------- pichação */
  // tecla P: marca a parede (ou o chão) para onde se está olhando com o desenho do time
  let pichacoes = null; const artes = {};
  function artePichacao(time) {
    if (artes[time]) return artes[time];
    const T = G.THREE, cv = document.createElement("canvas"); cv.width = cv.height = 256; const c = cv.getContext("2d");
    c.lineJoin = c.lineCap = "round"; c.textAlign = "center"; c.textBaseline = "middle";
    if (time === "p") {                                   // escudo com estrela
      c.beginPath(); c.moveTo(128, 14); c.lineTo(228, 48); c.lineTo(216, 140); c.quadraticCurveTo(200, 200, 128, 236); c.quadraticCurveTo(56, 200, 40, 140); c.lineTo(28, 48); c.closePath();
      c.fillStyle = "rgba(22,44,92,.9)"; c.fill(); c.strokeStyle = "#e8e4da"; c.lineWidth = 9; c.stroke();
      c.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? 17 : 42; c.lineTo(128 + Math.cos(a) * r, 96 + Math.sin(a) * r); } c.closePath(); c.fillStyle = "#e8e4da"; c.fill();
      c.font = '700 36px "Barlow Condensed", Arial, sans-serif'; c.fillText("POLÍCIA", 128, 170);
    } else {                                              // caveira de tinta vermelha, escorrendo
      const cor = "#c2261a"; c.strokeStyle = cor; c.fillStyle = cor;
      c.lineWidth = 16; c.beginPath(); c.moveTo(36, 40); c.lineTo(220, 176); c.moveTo(220, 40); c.lineTo(36, 176); c.stroke();
      c.beginPath(); c.arc(128, 96, 62, 0, 6.3); c.fill(); c.fillRect(94, 132, 68, 48);
      c.globalCompositeOperation = "destination-out";
      c.beginPath(); c.arc(104, 96, 17, 0, 6.3); c.arc(152, 96, 17, 0, 6.3); c.fill();
      c.beginPath(); c.moveTo(128, 112); c.lineTo(118, 134); c.lineTo(138, 134); c.closePath(); c.fill();
      c.lineWidth = 4; for (const x of [108, 121, 135, 148]) { c.beginPath(); c.moveTo(x, 150); c.lineTo(x, 180); c.stroke(); }
      c.globalCompositeOperation = "source-over"; c.lineWidth = 5;
      for (const [x, y, h] of [[78, 150, 34], [168, 146, 46], [128, 182, 22]]) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + h); c.stroke(); }
      c.font = '900 40px "Big Shoulders Display", Impact, sans-serif'; c.fillText("TERROR", 128, 228);
    }
    const tex = new T.CanvasTexture(cv); if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    return artes[time] = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  }
  // os seis desenhos de spray (laranja, com o nome embaixo e a tinta escorrendo), desenhados em vetor num canvas
  const PICHOS = [["MARMITA"], ["ADAM VIADO"], ["GORDO"], ["PAULETE QUE", "FAZ BOQUETE"], ["PILINGUINHA"], ["NEGRITUDE"]];
  const pichoTelas = [];
  function telaDoPicho(i) {
    if (pichoTelas[i]) return pichoTelas[i];
    const cv = document.createElement("canvas"); cv.width = cv.height = 384; const c = cv.getContext("2d"), COR = "#f4560a";
    let semente = 7 + i * 131; const rnd = () => (semente = (semente * 16807) % 2147483647) / 2147483647;
    c.lineJoin = c.lineCap = "round"; c.fillStyle = c.strokeStyle = COR;
    const elipse = (x, y, rx, ry, rot) => { c.beginPath(); c.ellipse(x, y, rx, ry, rot || 0, 0, 6.3); c.fill(); };
    const poli = (pts, traco) => { c.beginPath(); pts.forEach((p, k) => k ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); if (traco) { c.lineWidth = traco; c.stroke(); } else c.fill(); };
    const risco = (pts, w) => { c.lineWidth = w; c.beginPath(); pts.forEach((p, k) => k ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.stroke(); };
    const curva = (a, b, d, e, w) => { c.lineWidth = w; c.beginPath(); c.moveTo(a[0], a[1]); c.bezierCurveTo(b[0], b[1], d[0], d[1], e[0], e[1]); c.stroke(); };
    const furo = f => { c.globalCompositeOperation = "destination-out"; f(); c.globalCompositeOperation = "source-over"; c.fillStyle = c.strokeStyle = COR; };
    if (i === 0) {             // marmita aberta, com comida e fumaça
      poli([[86, 150], [300, 150], [276, 226], [112, 226]], 12); risco([[70, 150], [316, 150]], 14);
      for (const x of [140, 172, 204, 236]) risco([[x, 168], [x - 6, 214]], 6);
      for (const [x, y, r] of [[118, 128, 16], [146, 118, 18], [176, 124, 16], [204, 116, 17]]) elipse(x, y, r, r * 0.8);
      poli([[218, 138], [240, 104], [292, 112], [300, 138]]); furo(() => { risco([[244, 132], [258, 112]], 5); risco([[266, 134], [280, 116]], 5); });
      c.save(); c.translate(92, 138); c.rotate(-0.42); poli([[0, 0], [0, -92], [150, -92], [150, 0]], 12); poli([[18, -18], [18, -74], [132, -74], [132, -18]], 7); c.restore();
      curva([286, 96], [262, 70], [318, 54], [292, 22], 11); curva([326, 100], [308, 80], [346, 66], [330, 44], 9);
    } else if (i === 1) {      // cabeça de cervo, de frente, com a galhada
      c.lineWidth = 12; c.beginPath(); c.arc(192, 150, 104, 0.25, Math.PI - 0.25); c.stroke();
      poli([[192, 246], [150, 190], [138, 132], [164, 104], [192, 96], [220, 104], [246, 132], [234, 190]]);
      for (const k of [-1, 1]) {
        const x = v => 192 + k * v;
        poli([[x(52), 128], [x(112), 92], [x(100), 140], [x(62), 156]]);
        curva([x(24), 100], [x(40), 70], [x(86), 60], [x(108), 12], 13);
        risco([[x(40), 78], [x(30), 30]], 10); risco([[x(66), 60], [x(64), 16]], 10); risco([[x(88), 46], [x(128), 30]], 10); risco([[x(98), 30], [x(134), 8]], 8);
      }
      furo(() => { for (const k of [-1, 1]) poli([[192 + k * 14, 150], [192 + k * 42, 132], [192 + k * 38, 150]]); poli([[176, 196], [208, 196], [192, 214]]); risco([[178, 226], [206, 226]], 5);
        for (const k of [-1, 1]) poli([[192 + k * 62, 136], [192 + k * 96, 108], [192 + k * 90, 132]]); });
    } else if (i === 2) {      // pata com garras e arranhões
      elipse(192, 178, 82, 56); elipse(150, 150, 40, 36); elipse(234, 150, 40, 36);
      for (const [x, y, a] of [[104, 112, -0.35], [160, 78, -0.1], [224, 78, 0.1], [280, 112, 0.35]]) {
        elipse(x, y, 25, 34, a);
        c.save(); c.translate(x, y); c.rotate(a); poli([[-11, -38], [0, -84], [11, -38]]); c.restore();
      }
      for (const [a, b] of [[[40, 210], [106, 150]], [[52, 244], [112, 190]], [[290, 150], [356, 96]], [[296, 188], [366, 136]]]) { poli([a, [(a[0] + b[0]) / 2 - 5, (a[1] + b[1]) / 2 - 7], b, [(a[0] + b[0]) / 2 + 5, (a[1] + b[1]) / 2 + 7]]); }
      furo(() => { risco([[150, 196], [176, 170]], 4); risco([[214, 204], [236, 184]], 4); });
    } else if (i === 3) {      // microfone antigo com o cabo
      c.save(); c.translate(196, 96); c.rotate(-0.3);
      c.beginPath(); c.roundRect(-50, -74, 100, 140, 46); c.fill();
      furo(() => { for (let y = -50; y <= 44; y += 19) risco([[-36, y], [36, y]], 7); risco([[0, -64], [0, 56]], 6); });
      poli([[-22, 66], [22, 66], [16, 92], [-16, 92]]); c.restore();
      risco([[212, 180], [206, 214]], 16);
      curva([206, 214], [120, 208], [96, 176], [150, 168], 9); curva([206, 214], [280, 196], [320, 204], [296, 232], 9);
      for (const [a, b] of [[[84, 60], [124, 82]], [[72, 104], [118, 108]], [[92, 150], [126, 132]], [[310, 60], [272, 86]], [[324, 104], [278, 110]], [[306, 148], [272, 132]]]) poli([a, [b[0], b[1] - 5], [b[0], b[1] + 5]]);
    } else if (i === 4) {      // copinho inclinado, espirrando
      c.save(); c.translate(190, 150); c.rotate(0.3);
      poli([[-56, -62], [56, -62], [40, 78], [-40, 78]], 11); poli([[-44, -6], [-10, -14], [16, -2], [46, -10], [36, 62], [-36, 62]]);
      furo(() => { elipse(-14, 20, 5, 5); elipse(16, 34, 4, 4); elipse(2, 8, 3, 3); });
      c.restore();
      curva([200, 84], [214, 40], [250, 64], [262, 22], 15); curva([226, 80], [262, 70], [276, 50], [306, 56], 12);
      for (const [x, y, r] of [[270, 16, 11], [316, 54, 10], [240, 28, 7], [296, 30, 6], [188, 50, 7], [326, 82, 5], [112, 190, 8], [286, 170, 6], [92, 150, 4]]) elipse(x, y, r, r);
    } else {                   // punho fechado com raios
      for (let k = 0; k < 14; k++) { const a = -Math.PI + k * Math.PI / 13 * 1.0 - 0.0, a0 = a - 0.075, a1 = a + 0.075, r0 = 96, r1 = 142 - (k % 2) * 14;
        poli([[192 + Math.cos(a0) * r0, 150 + Math.sin(a0) * r0], [192 + Math.cos(a0) * r1, 150 + Math.sin(a0) * r1], [192 + Math.cos(a1) * r1, 150 + Math.sin(a1) * r1], [192 + Math.cos(a1) * r0, 150 + Math.sin(a1) * r0]]); }
      c.lineWidth = 11; c.beginPath(); c.arc(192, 150, 84, 0, 6.3); c.stroke();
      c.beginPath(); c.roundRect(150, 92, 86, 66, 14); c.fill(); c.beginPath(); c.roundRect(138, 118, 40, 46, 14); c.fill();
      poli([[160, 150], [228, 150], [222, 232], [166, 232]]);
      furo(() => { for (const x of [172, 193, 214]) risco([[x, 96], [x, 126]], 4); risco([[156, 132], [232, 132]], 4); risco([[150, 150], [176, 158]], 4); });
    }
    // nome em letra de spray, inclinado, com um risco embaixo e tinta escorrendo
    const linhas = PICHOS[i], tam = linhas.length > 1 ? 50 : 76, y0 = linhas.length > 1 ? 276 : 300;
    c.textAlign = "center"; c.textBaseline = "middle";
    linhas.forEach((txt, k) => {
      c.save(); c.translate(192, y0 + k * (tam + 2)); c.transform(1, -0.07, -0.14, 1, 0, 0);
      c.font = `900 ${tam}px "Big Shoulders Display", Impact, "Arial Black", sans-serif`;
      const larg = c.measureText(txt).width; if (larg > 350) c.scale(350 / larg, 1);
      c.lineWidth = 5; c.strokeText(txt, 0, 0); c.fillText(txt, 0, 0); c.restore();
    });
    const yr = y0 + (linhas.length - 1) * (tam + 2) + tam * 0.62;
    curva([74, yr + 6], [150, yr - 8], [240, yr - 8], [318, yr - 2], 9);
    for (let k = 0; k < 7; k++) { const x = 50 + rnd() * 284, h = 10 + rnd() * 26; risco([[x, yr - 2], [x, Math.min(378, yr + h)]], 5); elipse(x, Math.min(378, yr + h), 3.5, 4.5); }
    c.globalAlpha = 0.5; for (let k = 0; k < 260; k++) { const x = rnd() * 384, y = rnd() * 384, d = c.getImageData(x, y, 1, 1).data[3] ? 0 : 1; if (d) elipse(x, y, 0.8 + rnd() * 1.2, 0.8 + rnd() * 1.2); }
    c.globalAlpha = 1;
    furo(() => { for (let k = 0; k < 60; k++) risco([[rnd() * 384, rnd() * 384], [rnd() * 384, rnd() * 384]].map((p, q, l) => q ? [l[0][0] + (p[0] - 192) * 0.06, l[0][1] + (p[1] - 192) * 0.06] : p), 1.6); });      // falhas da tinta
    return pichoTelas[i] = cv;
  }
  function artePicho(i) {
    const ch = "d" + i; if (artes[ch]) return artes[ch];
    const T = G.THREE, tex = new T.CanvasTexture(telaDoPicho(i)); if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    return artes[ch] = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  }
  // P abre a escolha: seis desenhos de 150 px; clicar (ou apertar de 1 a 6) picha o que estiver à frente e volta para o jogo
  let pichoEl = null;
  function abrirPichos(abre) {
    if (abre && !pichoEl) {
      pichoEl = document.createElement("div"); pichoEl.className = "mp-pichos"; pichoEl.hidden = true;
      pichoEl.innerHTML = `<div class="mp-pichos-caixa"><h3>Escolha a pichação</h3><div class="mp-pichos-grade">${PICHOS.map((_, i) => `<button data-picho="${i}"><img width="150" height="150" alt="${PICHOS[i].join(" ")}" src="${telaDoPicho(i).toDataURL()}"><span>${i + 1}</span></button>`).join("")}</div><p>Clique em um desenho ou aperte de 1 a 6 · Esc cancela</p></div>`;
      pichoEl.addEventListener("click", ev => { const b = ev.target.closest("[data-picho]"); if (b) pichar(+b.dataset.picho); else if (ev.target === pichoEl) abrirPichos(false); });
      document.getElementById("app").appendChild(pichoEl);
    }
    if (!pichoEl) return;
    pichoEl.hidden = !abre;
    if (!abre && mp.pichoAlvo) { try { G.player.yaw = mp.pichoAlvo.yaw; G.player.pitch = mp.pichoAlvo.pitch; } catch {} }
    try { if (abre) G.input.exitLock(); else G.input.requestLock(); } catch {}
  }
  function pichar(i) {
    const al = mp.pichoAlvo; abrirPichos(false);
    if (!al) return;
    try { G.player.yaw = al.yaw; G.player.pitch = al.pitch; } catch {}      // a mira volta para onde estava
    mp.picharT = 2; mp.pichoAlvo = null;
    enviar({ t: "pichar", p: al.p, n: al.n, d: i, g: al.g });
  }
  window.addEventListener("keydown", ev => {      // com a escolha aberta, as teclas não chegam ao jogo
    if (!pichoEl || pichoEl.hidden) return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    const n = /^(Digit|Numpad)([1-6])$/.exec(ev.code);
    if (n) pichar(+n[2] - 1); else if (ev.code === "Escape" || ev.code === "KeyP") abrirPichos(false);
  }, true);
  function porPichacao(m) {
    if (!emRodada() || !TIMES[m.time]) return;
    const T = G.THREE, n = new V3().fromArray(m.n).normalize(), malha = new T.Mesh(pichacoes.userData.geo || (pichacoes.userData.geo = new T.PlaneGeometry(1.25, 1.25)), PICHOS[m.d] ? artePicho(m.d) : artePichacao(m.time));
    malha.quaternion.setFromUnitVectors(new V3(0, 0, 1), n);
    if (Math.abs(n.y) > 0.9) malha.rotateZ(m.g != null ? m.g : 0); else malha.rotateZ((Math.random() - 0.5) * 0.12);
    malha.position.fromArray(m.p).addScaledVector(n, 0.02);
    pichacoes.add(malha);
    while (pichacoes.children.length > 24) pichacoes.remove(pichacoes.children[0]);      // as mais antigas somem
    tocar("reload_magout", { pos: malha.position, gain: 0.5 });
  }
  function limparPichacoes() { if (pichacoes) while (pichacoes.children.length) pichacoes.remove(pichacoes.children[0]); }
  window.addEventListener("keydown", ev => {
    if (ev.code !== "KeyP" || ev.repeat || !emRodada() || mp.fase !== "valendo" || !G.player.alive || mp.picharT > 0 || (tela && !tela.hidden)) return;
    const p = G.player; let h = null; try { h = G.physics.raycast(p.eye, p.forward, 7); } catch {}
    if (!h || !h.normal) return G.hud.message("Mire numa parede, no chão, no teto ou num container (até 7 m) e aperte P", 2);
    mp.pichoAlvo = { p: arr(h.point), n: arr(h.normal), g: +p.yaw.toFixed(2), yaw: p.yaw, pitch: p.pitch };
    abrirPichos(true);
  });

  /* --------------------------------------------------------------- explosivos */
  const NOMES_ITEM = { granada: "Granada", bomba: "Bomba", relogio: "Bomba-relógio", colete: "Colete", capacete: "Capacete" };
  let explosivos = null, bolsaEl = null;
  // modelos: granada verde-oliva com alavanca e argola; bomba = banana de dinamite com detonador;
  // bomba-relógio = maleta com mostrador. "led" pisca nas bombas armadas.
  function modeloExplosivo(tipo, escala) {
    const T = G.THREE, g = new T.Group();
    const mat = (hex, rug = 0.7, met = 0.1) => new T.MeshStandardMaterial({ color: hex, roughness: rug, metalness: met });
    const add = (geo, m, x, y, z) => { const o = new T.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
    // metal, fosfato e polímero são os materiais da arma do jogo (com a textura deles), tingidos quando preciso
    const base = (i, hex) => { const m = G.weapon.root.children[i].material.clone(); if (hex != null) m.color.set(hex); return m; };
    const aco = base(0, 0xb4b9be), preto = base(1), tx = texturasDeRoupa();
    if (tipo === "colete") {                    // colete tático: corpo, alças, bolsos e fivela
      const lona = new T.MeshStandardMaterial({ color: 0x454e3a, roughness: 0.85, map: tx.tecido, bumpMap: tx.tecido, bumpScale: 1.2 }), bolso = lona.clone(); bolso.color.set(0x5d6650);
      add(new T.CylinderGeometry(0.17, 0.155, 0.34, 16), lona, 0, 0, 0).scale.z = 0.62;
      for (const x of [-0.09, 0.09]) add(new T.BoxGeometry(0.06, 0.07, 0.17), lona, x, 0.2, 0);
      for (const x of [-0.085, 0, 0.085]) add(new T.BoxGeometry(0.07, 0.09, 0.04), bolso, x, -0.07, -0.108);
      add(new T.BoxGeometry(0.2, 0.05, 0.02), bolso, 0, 0.08, -0.1);
      add(new T.BoxGeometry(0.035, 0.03, 0.012), aco, 0, 0.08, -0.113);
    } else if (tipo === "capacete") {           // capacete: casco, aba, forro e jugular
      const casco = base(2, 0x4a5340); casco.side = T.DoubleSide;
      add(new T.SphereGeometry(0.13, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.56), casco, 0, -0.02, 0).scale.set(0.96, 1, 1.08);
      add(new T.TorusGeometry(0.127, 0.006, 6, 28), preto, 0, -0.045, 0).rotation.x = Math.PI / 2;
      add(new T.TorusGeometry(0.1, 0.005, 6, 20, Math.PI), preto, 0, -0.05, 0).rotation.set(0, Math.PI / 2, Math.PI);
    } else if (tipo === "granada") {
      const oliva = base(2, 0x5a6a30);
      add(new T.SphereGeometry(0.06, 24, 18), oliva, 0, 0, 0).scale.y = 1.22;
      for (const y of [-0.045, -0.022, 0, 0.022, 0.045]) { const a = add(new T.TorusGeometry(0.0605 * Math.sqrt(1 - (y / 0.0735) ** 2), 0.0035, 6, 28), preto, 0, y, 0); a.rotation.x = Math.PI / 2; }   // sulcos
      for (let k = 0; k < 6; k++) { const a = add(new T.TorusGeometry(0.0605, 0.003, 6, 28), preto, 0, 0, 0); a.rotation.y = k * Math.PI / 6; a.scale.y = 1.22; }
      add(new T.CylinderGeometry(0.02, 0.026, 0.035, 12), aco, 0, 0.086, 0);
      add(new T.BoxGeometry(0.014, 0.1, 0.02), aco, 0.045, 0.045, 0).rotation.z = -0.35;        // alavanca
      add(new T.TorusGeometry(0.02, 0.003, 6, 16), aco, -0.04, 0.1, 0);                          // argola
    } else {
      const led = add(new T.SphereGeometry(0.012, 8, 8), new T.MeshStandardMaterial({ color: 0xff2a1a, emissive: 0xff2a1a, emissiveIntensity: 2 }), 0, 0, 0);
      g.userData.led = led;
      if (tipo === "bomba") {
        const vermelho = new T.MeshStandardMaterial({ color: 0xa3211b, roughness: 0.8, map: tx.pele, bumpMap: tx.tecido, bumpScale: 0.6 });
        add(new T.BoxGeometry(0.05, 0.004, 0.03), new T.MeshStandardMaterial({ color: 0x1a0500, emissive: 0xff3a1a, emissiveIntensity: 1.2 }), -0.012, 0.096, 0);   // visor do detonador
        for (const [y, z] of [[0, -0.024], [0, 0.024], [0.042, 0]]) { const b = add(new T.CylinderGeometry(0.023, 0.023, 0.22, 12), vermelho, 0, y, z); b.rotation.z = Math.PI / 2; }
        for (const x of [-0.06, 0.06]) add(new T.BoxGeometry(0.016, 0.1, 0.105), preto, x, 0.018, 0);          // fita
        add(new T.BoxGeometry(0.08, 0.03, 0.055), preto, 0, 0.08, 0);                                          // detonador
        for (const [x, c] of [[-0.03, 0xd8b21c], [0.03, 0x2a6fd6]]) { const f = add(new T.TorusGeometry(0.03, 0.003, 6, 12, Math.PI), mat(c), x, 0.085, 0.02); f.rotation.y = Math.PI / 2; }
        led.position.set(0.025, 0.1, 0);
      } else {
        add(new T.BoxGeometry(0.24, 0.07, 0.16), base(1, 0x565c63), 0, 0, 0);                                   // maleta
        for (const x of [-0.1, 0.1]) add(new T.BoxGeometry(0.02, 0.012, 0.012), aco, x, 0.02, 0.083);            // fechos
        add(new T.BoxGeometry(0.245, 0.006, 0.165), aco, 0, 0.012, 0);
        add(new T.TorusGeometry(0.035, 0.006, 6, 12, Math.PI), preto, 0, 0, 0.08).rotation.x = Math.PI / 2;     // alça
        add(new T.CylinderGeometry(0.045, 0.045, 0.01, 20), mat(0xe8e4da, 0.6, 0), -0.04, 0.04, 0);             // mostrador
        add(new T.BoxGeometry(0.004, 0.004, 0.035), preto, -0.04, 0.047, -0.012);
        add(new T.BoxGeometry(0.025, 0.004, 0.004), preto, -0.03, 0.047, 0);
        led.position.set(0.07, 0.042, 0);
      }
    }
    g.scale.setScalar(escala);
    explosivos.add(g);
    return g;
  }
  // item para pegar: flutua e gira sobre um aro fino e claro no chão (sem cor de time)
  function anelNeutro() {
    const T = G.THREE, anel = new T.Mesh(new T.RingGeometry(0.33, 0.36, 32), new T.MeshBasicMaterial({ color: 0xe8e4da, transparent: true, opacity: 0.4, side: T.DoubleSide, depthWrite: false }));
    anel.rotation.x = -Math.PI / 2;
    return anel;
  }
  function limparExplosivos() {
    while (explosivos.children.length) {
      const m = explosivos.children[0]; explosivos.remove(m);
      m.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    }
    mp.itens.clear(); mp.bombas.clear(); mp.granadas.length = 0;
    mp.bolsa = { granada: 0, bomba: 0, relogio: 0 }; mp.desarmarT = 0; mp.colete = false; mp.capacete = false; mp.reservaColete = 0; mp.reservaCapacete = 0; mp.superUsado = false;
    try { G.player.maxHealth = 100; } catch {}
  }
  function ferirRefem(r, golpes, porId) {       // anfitrião; cada golpe vale um tiro na cabeça
    if (mp.fase !== "valendo" || r.estado > 1 || golpes <= 0) return;
    r.hp -= golpes;
    if (r.hp > 0.001) return;
    const quem = mp.jogadores.get(porId);
    r.estado = 3; r.lider = null;
    paraTodos({ t: "refem", i: r.i, ev: "morto", id: porId });
    fimDaRodada(quem && quem.time === "p" ? "t" : "p", (quem ? quem.nome : "Alguém") + " matou um refém");
  }
  function sortearItens() {                     // anfitrião: pontos aleatórios pelo mapa todo, cada item longe dos outros
    const itens = [], postos = [], jogando = [...mp.jogadores.values()].filter(j => j.time).length; let id = 1;
    const quantos = { ...CFG.itens, colete: jogando * 2, capacete: jogando * 2 };
    for (const [tipo, n] of Object.entries(quantos)) for (let k = 0; k < n; k++) {
      let melhor = null, folga = -1;
      for (let tent = 0; tent < 40; tent++) {           // fica com o ponto mais afastado dos itens já postos
        let p = null; try { p = G.physics.nav.randomPoint(new V3(0, 0, 0), 38); } catch {}
        if (!p) continue;
        let d = 1e9; for (const q of postos) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
        if (d > folga) { folga = d; melhor = p.clone(); }
        if (d >= 8) break;
      }
      melhor = melhor || new V3(); postos.push(melhor);
      itens.push([id++, tipo, +melhor.x.toFixed(1), +melhor.z.toFixed(1)]);
    }
    return itens;
  }
  function explodir(pos, cfg, por) {            // anfitrião: avisa todos e fere máquinas e reféns
    paraTodos({ t: "explosao", p: arr(pos), raio: cfg.raio, dano: cfg.dano, por });
    for (const b of [...mp.jogadores.values()]) if (b.bot && b.vivo) { const d = b.pos.distanceTo(pos); if (d < cfg.raio) ferirBot(b, cfg.dano * (1 - d / cfg.raio), por); }
    for (const e of G.enemies.list) {
      const d = e.pos.distanceTo(pos);
      if (e.alive && d < cfg.raio) try { e.damage(cfg.dano * (1 - d / cfg.raio), e.pos.clone(), e.pos.clone().sub(pos).normalize(), "body"); } catch {}
    }
    for (const r of mp.refens) {
      const d = r.pos.distanceTo(pos);
      if (d < cfg.raio) {                          // explosão perto também fere; o colete segura a primeira pancada
        let golpes = Math.round(cfg.dano * (1 - d / cfg.raio) / 50);
        if (golpes > 0 && (r.prot & 1)) { r.prot &= ~1; golpes--; }
        ferirRefem(r, golpes, por);
      }
    }
  }
  function explosivosDoAnfitriao(dt) {
    for (const b of [...mp.bombas.values()]) if (b.t <= 0) {
      paraTodos({ t: "bombaFora", id: b.id, ev: "explodiu" });
      explodir(b.pos, CFG[b.tipo], b.por);
    }
  }
  // todos: granadas voando, bombas piscando, jogador pegando itens do chão
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
      b.malha.userData.led.material.emissiveIntensity = Math.sin(tempo * (b.t < 6 ? 16 : 6)) > 0 ? 4 : 0.15;     // LED pisca, mais rápido no fim
      if (b.bipe <= 0) { b.bipe = b.t < 6 ? 0.25 : 1; tocar("telegraph", { pos: b.pos, gain: 0.6 }); }
    }
    for (const it of mp.itens.values()) {
      it.malha.rotation.y = tempo * 1.5; it.malha.position.y = 0.45 + Math.sin(tempo * 2 + it.id) * 0.05;
      if ((it.tipo === "colete" || it.tipo === "capacete") && mp[it.tipo]) continue;      // já está usando um: passa por cima sem pegar
      if (j && p.alive && mp.fase === "valendo" && !it.pedido && Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z) < 1.3 && p.pos.y < 2) {
        it.pedido = true; enviar({ t: "pegueiItem", id: it.id });
      }
    }
    const b = mp.bolsa, mostra = !!(j && p.alive);
    bolsaEl.hidden = !mostra;
    if (mostra) {
      const txt = (ARMAS[mp.arma] && ARMAS[mp.arma].faca ? `<span class="mp-furtivo">Modo furtivo · ninguém ouve seus passos · máquinas só te veem de frente</span>` : "") +
        (mp.mirando ? `<span class="mp-furtivo">Na mira da sniper · máquinas e bots não veem você</span>` : "") +
        (p.pos.y > ALTO && !mp.mirando ? `<span class="mp-furtivo">No alto · os drones não pegam você aqui</span>` : "") +
        (b.granada ? `<span><kbd>4</kbd> Jogar granada <b>${b.granada}</b></span>` : "") +
        (b.bomba ? `<span><kbd>B</kbd> Armar bomba aqui · explode em ${CFG.bomba.pavio}s <b>${b.bomba}</b></span>` : "") +
        (b.relogio ? `<span><kbd>V</kbd> Armar bomba-relógio de ${CFG.relogio.tempos[mp.tempoIdx]}s <b>${b.relogio}</b> · <kbd>T</kbd> muda o tempo</span>` : "") +
        `<span>Colete <b>${mp.colete ? "sim" : "não"}</b> · Capacete <b>${mp.capacete ? "sim" : "não"}</b></span>`;
      if (txt !== bolsaEl._txt) { bolsaEl._txt = txt; bolsaEl.innerHTML = txt; }
    }
  }
  window.addEventListener("keydown", ev => {
    const p = G && G.player, j = eu();
    if (!emRodada() || mp.fase !== "valendo" || !j || !p.alive || ev.repeat) return;
    if (ev.code === "KeyT") mp.tempoIdx = (mp.tempoIdx + 1) % CFG.relogio.tempos.length;
    else if ((ev.code === "Digit4" || ev.code === "Numpad4") && mp.bolsa.granada > 0) {
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
  function sortearArmas(nasc) {                 // anfitrião: um conjunto completo perto de onde cada jogador nasce
    const lista = []; let naSala = 0;
    for (const [id, pt] of Object.entries(nasc)) {
      const j = mp.jogadores.get(id); if (!j || j.bot) continue;      // bot já nasce armado: não precisa de armas no chão
      const chaves = Object.keys(ARMAS).filter(k => ARMAS[k].time === j.time && !ARMAS[k].faca && !ARMAS[k].reserva), dentro = pt[1] > 1, fila = dentro ? naSala++ : 0;
      chaves.forEach((k, n) => {
        if (dentro) return lista.push([mp.proxId++, k, +([-15.1, -13.9, -12.7, -9.9, -8.7, -7.5][n % 6] + (fila ? 0.6 : 0)).toFixed(2), +(SALA.z1 - 0.35).toFixed(2), SALA.chao, 1]);   // no cabide sob a janela, bem espaçadas e fora do vão da porta
        const ang = n / chaves.length * Math.PI * 2, q = pisavel(pt[0] + Math.cos(ang) * 3.8, pt[2] + Math.sin(ang) * 3.8);      // em roda larga, uns 4 m uma da outra
        lista.push([mp.proxId++, k, +q[0].toFixed(2), +q[1].toFixed(2), 0]);
      });
    }
    // e um conjunto completo (com a sniper) no chão de cada base, para quem nascer longe ou quiser trocar
    for (const [t, cx, cz] of [["p", BASE_POLICIA[0] + 3.5, BASE_POLICIA[1]], ["t", 24, 15]]) {
      const chaves = Object.keys(ARMAS).filter(k => ARMAS[k].time === t && !ARMAS[k].faca && !ARMAS[k].reserva);
      chaves.forEach((k, n) => {
        const ang = n / chaves.length * Math.PI * 2, q = pisavel(cx + Math.cos(ang + 0.5) * 5.5, cz + Math.sin(ang + 0.5) * 5.5);
        lista.push([mp.proxId++, k, +q[0].toFixed(2), +q[1].toFixed(2), 0]);
      });
    }
    return lista;
  }
  // a arma para pegar é uma cópia do modelo do jogo: no cabide da sala fica em pé, de perfil; no chão, gira sobre um aro
  function porArmaNoChao(d) {
    const T = G.THREE, a = ARMAS[d[1]], g = new T.Group(), giro = new T.Group(); if (!a) return;
    const copia = copiaDaArma(d[1]), curta = a.faca || (VARIANTES[d[1]] || {}).curta; let anel = null;
    giro.add(copia); g.add(giro);
    if (d[5]) {
      copia.rotation.set(Math.PI / 2, 0, Math.PI / 2); if (a.faca) copia.scale.setScalar(1.8);
      if (!curta) {                                       // as longas ficam inclinadas o quanto for preciso para caber sob a janela
        giro.updateMatrixWorld(true);
        const em_pe = new T.Box3().setFromObject(giro), comp = em_pe.max.y - em_pe.min.y;
        giro.rotation.z = Math.max(0.3, comp > 0.78 ? Math.acos(0.78 / comp) : 0);
      }
      giro.updateMatrixWorld(true);
      const cx = new T.Box3().setFromObject(giro), alt = cx.max.y - cx.min.y;
      giro.position.set(-(cx.min.x + cx.max.x) / 2, (curta ? 0.5 - alt / 2 : 0.07) - cx.min.y, 0.15 - (cx.min.z + cx.max.z) / 2);
    } else {
      if (a.faca) copia.scale.setScalar(2.2); else { copia.position.z = 0.08 * VARIANTES[d[1]].z; copia.scale.setScalar(1.2); giro.rotation.z = 0.25; }
      giro.position.y = 0.5;
      anel = anelNeutro(); anel.position.y = 0.04; g.add(anel);
    }
    g.position.set(d[2], d[4] || 0, d[3]); armasGrupo.add(g);
    mp.armasChao.set(d[0], { id: d[0], arma: d[1], pos: new V3(d[2], d[4] || 0, d[3]), malha: g, giro, anel, fixo: !!d[5], pedido: false });
  }
  function tirarArmaDoChao(id) {
    const it = mp.armasChao.get(id); if (!it) return;
    armasGrupo.remove(it.malha);
    if (it.anel) { it.anel.geometry.dispose(); it.anel.material.dispose(); }      // o resto é compartilhado com a arma do jogo
    mp.armasChao.delete(id);
  }
  function limparArmas() {
    for (const id of [...mp.armasChao.keys()]) tirarArmaDoChao(id);
    mp.arma = null; mp.principal = null; mp.municao = {}; mp.prontaEm = {}; mp.armaAntes = null; mp.trocaPara = null; mp.rajada = 0; mp.cadT = 0; mp.armaVisivel = null; mp.gatilhoAntes = false;
  }
  function soltarArma() {
    if (!mp.principal || !emRodada()) return;      // só a arma pega no chão se solta; a faca (e a pistola reserva) ficam
    const p = G.player;
    enviar({ t: "armaSolta", arma: mp.principal, p: [+(p.pos.x - Math.sin(p.yaw) * 0.9).toFixed(2), +(p.pos.z - Math.cos(p.yaw) * 0.9).toFixed(2), +p.pos.y.toFixed(2)] });
    for (const it of mp.armasChao.values()) if (Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z) < 1.8) it.espera = true;      // as armas por perto só voltam a ser pegas depois de se afastar
    mp.principal = null; mp.arma = eu() && eu().time ? eu().time + "_faca" : null; mp.rajada = 0; mp.semPegarT = 0.5; tocar("reload_magout");      // soltou a arma: volta para a faca
  }
  function facada() {
    facaAnim = 0.32;
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
    const w = G.weapon, p = G.player, vale = p.alive && mp.fase === "valendo", gatilho = !!G.input.fire;
    mp.cadT -= dt; mp.semPegarT -= dt; mp.passoT -= dt;
    if (mp.trocaPara) {                                    // troca de arma: a atual desce, troca lá embaixo e a nova sobe
      mp.trocaT += dt;
      if (mp.trocaT >= TROCA.desce && mp.arma !== mp.trocaPara) { mp.armaAntes = mp.arma; mp.arma = mp.trocaPara; tocar("reload_magin"); }
      if (mp.trocaT >= TROCA.desce + TROCA.sobe || !p.alive) { if (mp.arma !== mp.trocaPara && p.alive) { mp.armaAntes = mp.arma; mp.arma = mp.trocaPara; } mp.trocaPara = null; }
    }
    const a = ARMAS[mp.arma];                              // só depois da troca: daqui para baixo vale a arma que está na mão agora
    let pode = false;
    if (a && !a.faca && vale && mp.cadT <= 0) {
      if (w.ammo === 0 || w.state === "reloading") mp.rajada = 0;
      if (a.modo === "auto") pode = gatilho;
      else if (a.modo === "semi") pode = gatilho && !mp.gatilhoAntes;                    // um tiro por clique
      else { if (gatilho && !mp.gatilhoAntes && mp.rajada <= 0) mp.rajada = a.rajada; pode = mp.rajada > 0; }
    }
    if (a && a.faca && vale && gatilho && !mp.gatilhoAntes && mp.cadT <= 0) { mp.cadT = FACA.espera; facada(); }
    if (G.input.sprint && G.input.move.y > 0.55) pode = false;        // correndo a arma abaixa: não atira
    if (mp.trocaPara) pode = false;                        // no meio da troca não atira
    // a arma do jogo só dispara quando o gatilho "desce"; se o aperto cai antes de ela estar pronta, ele se perde e a rajada
    // para. Por isso, enquanto não sai o tiro, o gatilho é solto e reapertado a cada dois quadros.
    if (pode) { mp.pulso = (mp.pulso || 0) + 1; if (mp.pulso > 2) { pode = false; mp.pulso = 0; } } else mp.pulso = 0;
    mp.gatilhoAntes = gatilho; G.input.fire = pode;
    if (mp.arma !== mp.armaPente) {                      // trocou de arma: cada uma guarda a sua munição e o seu tempo de espera
      const antes = ARMAS[mp.armaPente], agora = performance.now() / 1000;
      if (antes && !antes.faca) { mp.municao[mp.armaPente] = Math.max(0, Math.min(antes.pente, w.ammo | 0)); mp.prontaEm[mp.armaPente] = agora + Math.max(0, mp.cadT); }
      mp.armaPente = mp.arma; mp.rajada = 0;
      try { w.reset(); } catch {}                         // cancela uma recarga que estivesse no meio (senão ela terminava na arma nova, com a munição errada)
      w.setVisible(!!a && !a.faca && p.alive); mp.armaVisivel = !!a && !a.faca && p.alive;
      if (a && !a.faca) { w.magSize = a.pente; w.ammo = mp.municao[mp.arma] != null ? mp.municao[mp.arma] : a.pente; }
      mp.cadT = Math.max(0.3, (mp.prontaEm[mp.arma] || 0) - agora);
    }
    if (a && !a.faca) { w.magSize = a.pente; if (w.ammo > a.pente) w.ammo = a.pente; w.reserve = 150; try { if (typeof w.rpm === "number") w.rpm = Math.max(a.rpm, a.modo === "auto" ? 600 : a.rpm); } catch {} }
    if (a && !a.faca && mp.recarregando && w.state !== "reloading" && mp.armaRecarga === mp.arma) w.ammo = a.pente;      // terminou de recarregar: pente cheio, sempre
    mp.recarregando = !!a && !a.faca && w.state === "reloading"; mp.armaRecarga = mp.arma;
    if (a && !a.faca && vale && w.ammo <= 0 && w.state !== "reloading" && !mp.trocaPara) { try { w.reloadNow(); } catch {} }      // pente vazio: recarrega sozinho
    // garantia: se por qualquer motivo a recarga do jogo não começar, em menos de 2 s o pente volta cheio do mesmo jeito
    mp.secoT = a && !a.faca && vale && w.ammo <= 0 && w.state !== "reloading" && !mp.trocaPara ? (mp.secoT || 0) + dt : 0;
    if (mp.secoT > 1.8) { w.ammo = a.pente; mp.secoT = 0; tocar("reload_magin"); }
    if (!mp.linhaMunicao) mp.linhaMunicao = document.querySelector(".h-ammo-row");
    if (mp.linhaMunicao) mp.linhaMunicao.style.visibility = a && a.faca ? "hidden" : "";                                         // de faca não há munição para mostrar       // munição infinita: R sempre recarrega
    mp.mirando = !!(a && a.mira && p.alive && G.input.ads);
    p.tuning.fovAds = a && a.mira ? (p.baseFov || 75) / a.mira : 52; p.tuning.adsLook = a && a.mira ? 0.22 : 0.6;      // zoom da sniper no botão direito
    if (a && a.reserva && !temReserva()) { mp.arma = mp.principal; return; }      // pegou uma arma comum: a reserva some
    w.name = a ? a.nome : "Sem arma";
    const visivel = !!a && !a.faca && p.alive;
    if (visivel !== mp.armaVisivel) { mp.armaVisivel = visivel; w.setVisible(visivel); }
    if (mp.arma !== modeloAtual) aplicarModelo(mp.arma);
    animarFaca(dt, !!(a && a.faca) && p.alive);
    if (!mp.principal && p.alive && mp.semPegarT <= 0 && mp.fase !== "fim") {      // de faca na mão, passar por cima de uma arma pega a arma
      let alvo = null, dAlvo = 0.85;                  // pega a mais próxima das que estão ao alcance
      for (const it of mp.armasChao.values()) {
        const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
        if (it.espera) { if (d > 1.8) it.espera = false; continue; }
        if (!it.pedido && d < dAlvo && Math.abs(p.pos.y - it.pos.y) < 1.5) { dAlvo = d; alvo = it; }
      }
      if (alvo) { alvo.pedido = true; mp.semPegarT = 0.4; enviar({ t: "armaPeguei", id: alvo.id }); }
    }
    let perto = null, dPerto = 1.5;
    for (const it of mp.armasChao.values()) {
      const d = Math.hypot(it.pos.x - p.pos.x, it.pos.z - p.pos.z);
      it.giro.visible = d < 16;                       // de longe fica só o anel, para não pesar
      if (!it.fixo) it.giro.rotation.y += dt * 1.2;
      if (d < dPerto && Math.abs(p.pos.y - it.pos.y) < 1.5) { dPerto = d; perto = it; }
    }
    if (perto && p.alive) G.hud.message(ARMAS[perto.arma].nome + (a && !a.faca ? " · solte a sua com G para trocar" : ""), 0.3);
  }
  window.addEventListener("keydown", ev => {
    if (ev.code === "KeyG" && !ev.repeat && emRodada() && G.player.alive && !(tela && !tela.hidden)) soltarArma();
  });

  // troca de arma como no CS: Q alterna com a última usada, 1 = arma pega no chão, 2 = pistola reserva, 3 = faca.
  // A pistola reserva (9 tiros) só existe para quem não tem arma do chão ou está de sniper.
  const TROCA = { desce: 0.18, sobe: 0.24 };      // segundos para a arma descer e para a outra subir
  function temReserva() { return true; }      // pistola e faca são de todos, sempre; do chão só se leva UMA arma principal
  function trocarArma(para) {
    const t = eu() && eu().time; if (!t || !para || para === mp.arma || !ARMAS[para]) return;
    if (ARMAS[para].reserva && !temReserva()) return;
    if (mp.trocaPara) return;                             // já está trocando
    mp.trocaPara = para; mp.trocaT = 0;                    // a troca em si acontece no meio do movimento (ver armasLocais)
  }
  window.addEventListener("keydown", ev => {
    if (ev.repeat || !emRodada() || mp.fase === "fim" || !G.player.alive || (tela && !tela.hidden)) return;
    const t = eu() && eu().time; if (!t) return;
    if (ev.code === "Digit1") trocarArma(mp.principal);
    else if (ev.code === "Digit2") trocarArma(t + "_reserva");
    else if (ev.code === "Digit3") trocarArma(t + "_faca");
    else if (ev.code === "KeyQ") {
      let alvo = mp.armaAntes;
      if (!alvo || !ARMAS[alvo] || alvo === mp.arma || (alvo !== mp.principal && !ARMAS[alvo].faca && !(ARMAS[alvo].reserva && temReserva())))
        alvo = mp.arma === mp.principal || !mp.principal ? (temReserva() && mp.arma !== t + "_reserva" ? t + "_reserva" : t + "_faca") : mp.principal;
      trocarArma(alvo);
    }
  });

  /* ------------------------------------------------------- modelos das armas */
  // As armas de fogo usam o modelo original do jogo (o único detalhado), cada uma com uma variação:
  // z = comprimento, g = grossura, acab = acabamento da coronha e do guarda-mão,
  // pente = [largura, altura] do carregador (0 = sem carregador), duasMaos = mão esquerda no guarda-mão,
  // curta = pistola: o mesmo modelo sem coronha, sem guarda-mão e sem luneta, com a boca do cano junto à caixa da arma.
  const VARIANTES = {
    p_fuzil:    { z: 1,    g: 1,    acab: "preto",   pente: [1, 1],      duasMaos: true },
    t_fuzil:    { z: 1.06, g: 1.04, acab: "madeira", pente: [1, 1.25],   duasMaos: true },
    p_metra:    { z: 0.72, g: 0.95, acab: "preto",   pente: [0.8, 1.15], duasMaos: true },
    t_metra:    { z: 0.6,  g: 1,    acab: "areia",   pente: [0.9, 1.3],  duasMaos: true },
    p_12:       { z: 1.1,  g: 1.15, acab: "madeira", pente: 0,           duasMaos: true },
    p_sniper:   { z: 1.4,  g: 0.92, acab: "preto",   pente: [0.7, 0.6],  duasMaos: true },
    t_sniper:   { z: 1.4,  g: 0.92, acab: "madeira", pente: [0.7, 0.6],  duasMaos: true },
    t_12:       { z: 0.62, g: 1.2,  acab: "madeira", pente: 0,           duasMaos: true },
    p_pistola:  { z: 1,    g: 0.9,  acab: "preto",   pente: 0,           duasMaos: false, curta: true },
    p_reserva:  { z: 0.95, g: 0.88, acab: "preto",   pente: 0,           duasMaos: false, curta: true },
    t_reserva:  { z: 0.95, g: 0.88, acab: "areia",   pente: 0,           duasMaos: false, curta: true },
    p_revolver: { z: 0.88, g: 0.98, acab: "aco",     pente: 0,           duasMaos: false, curta: true },
    t_pistola:  { z: 1.08, g: 0.94, acab: "areia",   pente: 0,           duasMaos: false, curta: true },
    t_pistola2: { z: 1.12, g: 0.86, acab: "madeira", pente: 0,           duasMaos: false, curta: true },
  };
  const NA_MAO = [0, 0.02, -0.2];      // a pistola é curta: sobe e avança na mão para aparecer na tela
  let ferrolho = null, maoDireita = null, posMao = null;
  let pecasDaArma = [], carregador = null, zCarregador = 0, coronha = null, acabamentos = {}, maoEsquerda = null, clarao = null,
    facaNaMao = null, facaModelo = null, modeloAtual, facaAnim = 0, facaBalanco = 0;
  function montarModelos() {
    const T = G.THREE, raiz = G.weapon.root;
    pecasDaArma = raiz.children.slice(0, 8).filter((_, i) => i !== 5); carregador = raiz.children[5]; zCarregador = carregador.position.z;
    coronha = raiz.children[2]; clarao = raiz.children[8]; maoEsquerda = raiz.children[10];
    const areia = carregador.children[0].material, madeira = areia.clone(); madeira.color.set(0x8a5230);
    acabamentos = { preto: coronha.material, areia, madeira, aco: raiz.children[0].material };
    ferrolho = raiz.children[4]; maoDireita = raiz.children[9]; posMao = maoDireita.position.clone();
    for (const o of pecasDaArma) if (o.isMesh) {
      o.userData.inteira = o.geometry; try { o.userData.curta = cortarCurta(o.geometry); } catch { o.userData.curta = o.geometry; }
      // o jogo anima o z do ferrolho, então nele o avanço da pistola vai embutido na geometria
      o.userData.curtaNaMao = o === ferrolho ? o.userData.curta.clone().translate(0, 0, NA_MAO[2]) : o.userData.curta;
    }
    // a faca: lâmina recortada, guarda e cabo, na mão de luva do próprio jogo. Fica presa à câmera na mesma
    // posição em que o jogo segura o fuzil, porque a arma do jogo some quando se está de faca.
    facaNaMao = new T.Group(); facaNaMao.visible = false;
    const mao = raiz.children[9].clone(true); facaNaMao.add(mao);
    const perfil = new T.Shape(); perfil.moveTo(0, -0.013); perfil.lineTo(0.12, -0.013); perfil.lineTo(0.175, 0.006); perfil.lineTo(0.13, 0.014); perfil.lineTo(0, 0.014); perfil.closePath();
    const pronto = m => { m.layers.set(1); m.frustumCulled = false; m.receiveShadow = true; return m; };
    const lamina = pronto(new T.Mesh(new T.ExtrudeGeometry(perfil, { depth: 0.003, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 1 }), new T.MeshStandardMaterial({ color: 0xcfd4d8, metalness: 0.85, roughness: 0.28 })));
    const cabo = pronto(new T.Mesh(new T.CapsuleGeometry(0.014, 0.085, 4, 10), coronha.material)); cabo.rotation.z = Math.PI / 2; cabo.position.set(-0.055, 0, 0.0015);
    const guarda = pronto(new T.Mesh(new T.BoxGeometry(0.008, 0.045, 0.014), raiz.children[1].material)); guarda.position.set(-0.004, 0, 0.0015);
    facaModelo = new T.Group(); facaModelo.add(lamina, cabo, guarda);
    const faca = facaModelo.clone(true);
    faca.position.set(0.02, -0.07, 0.1); faca.rotation.set(0, Math.PI / 2, 0.55); faca.scale.setScalar(1.5);   // cabo dentro do punho, lâmina para a frente e um pouco para cima
    facaNaMao.add(faca);
    G.camera.add(facaNaMao);
  }
  // A geometria da arma é feita de peças soltas. Para a pistola ficam só as peças da caixa da arma e do punho
  // (nada atrás, nada à frente, nada em cima) e as peças da boca do cano são trazidas para junto da caixa.
  function cortarCurta(geo) {
    const T = G.THREE, g = geo.index ? geo.toNonIndexed() : geo, p = g.attributes.position, n = p.count, pai = new Map(), chaves = new Array(n);
    const raiz = k => { while (pai.get(k) !== k) { pai.set(k, pai.get(pai.get(k))); k = pai.get(k); } return k; };
    for (let v = 0; v < n; v++) { const k = p.getX(v).toFixed(4) + "," + p.getY(v).toFixed(4) + "," + p.getZ(v).toFixed(4); chaves[v] = k; if (!pai.has(k)) pai.set(k, k); }
    for (let t = 0; t < n; t += 3) { pai.set(raiz(chaves[t]), raiz(chaves[t + 1])); pai.set(raiz(chaves[t + 1]), raiz(chaves[t + 2])); }
    const caixas = new Map();                              // peça -> [z mínimo, z máximo, y mínimo]
    for (let v = 0; v < n; v++) {
      const k = raiz(chaves[v]); let b = caixas.get(k); if (!b) caixas.set(k, b = [9, -9, 9]);
      b[0] = Math.min(b[0], p.getZ(v)); b[1] = Math.max(b[1], p.getZ(v)); b[2] = Math.min(b[2], p.getY(v));
    }
    const fica = [];                                       // pares: primeiro vértice do triângulo, quanto recuar
    for (let t = 0; t < n; t += 3) {
      const b = caixas.get(raiz(chaves[t])), boca = b[1] <= -0.458;
      if (boca || (b[0] >= -0.11 && b[0] < 0.095 && b[2] < 0.0395)) fica.push(t, boca ? 0.361 : 0);
    }
    const nova = new T.BufferGeometry();
    for (const nome in g.attributes) {
      const a = g.attributes[nome], tam = a.itemSize, dados = new a.array.constructor(fica.length / 2 * 3 * tam);
      for (let k = 0; k < fica.length; k += 2) for (let c = 0; c < 3 * tam; c++) dados[k / 2 * 3 * tam + c] = a.array[fica[k] * tam + c];
      nova.setAttribute(nome, new T.BufferAttribute(dados, tam, a.normalized));
    }
    const np = nova.attributes.position;
    for (let k = 0; k < fica.length; k += 2) if (fica[k + 1]) for (let c = 0; c < 3; c++) np.setZ(k / 2 * 3 + c, np.getZ(k / 2 * 3 + c) + fica[k + 1]);
    return nova;
  }
  // cópia da arma para o mundo (cabide, chão, mão dos bonecos): mesmas peças e geometria da arma do jogo, de frente para -z
  const materiaisMundo = new Map();
  function materialMundo(m) {
    let c = materiaisMundo.get(m);
    if (!c) { c = m.clone(); if (c.color) c.color.lerp(new G.THREE.Color(0x9aa0a6), 0.2); materiaisMundo.set(m, c); }
    return c;
  }
  function copiaDaArma(chave) {
    const T = G.THREE, g = new T.Group(), raiz = G.weapon.root, v = VARIANTES[chave] || VARIANTES.p_fuzil;
    const noMundo = o => { o.traverse(x => { x.layers.set(0); x.frustumCulled = true; x.castShadow = false; x.visible = true; x.userData.emprestado = true; if (x.isMesh) x.material = materialMundo(x.material); }); return o; };
    if (ARMAS[chave] && ARMAS[chave].faca) { const f = noMundo(facaModelo.clone(true)); f.position.set(0, 0, 0); f.rotation.set(0, Math.PI / 2, 0); g.add(f); return g; }
    for (const i of [0, 1, 2, 3, 4]) {
      const o = raiz.children[i], c = new T.Mesh(v.curta ? o.userData.curta : o.userData.inteira, i === 2 ? acabamentos[v.acab] : o.material);
      c.scale.set(v.g, v.g, v.z); g.add(noMundo(c));
    }
    if (v.pente) { const c = noMundo(carregador.clone(true)); c.scale.set(v.g * v.pente[0], v.g * v.pente[1], v.z); c.position.set(0, -0.02, zCarregador * v.z); g.add(c); }
    return g;
  }
  function aplicarModelo(chave) {
    const v = VARIANTES[chave] || VARIANTES.p_fuzil;      // mãos vazias e jogo solo: fuzil original
    const d = v.curta ? NA_MAO : [0, 0, 0];
    for (const o of pecasDaArma) {
      o.scale.set(v.g, v.g, v.z); if (o.userData.inteira) o.geometry = v.curta ? o.userData.curtaNaMao : o.userData.inteira;
      o.position.x = d[0]; o.position.y = d[1]; if (o !== ferrolho) o.position.z = d[2];
    }
    maoDireita.position.set(posMao.x + d[0], posMao.y + d[1], posMao.z + d[2]);
    carregador.visible = !!v.pente;
    if (v.pente) carregador.scale.set(v.g * v.pente[0], v.g * v.pente[1], v.z);
    carregador.position.z = zCarregador * v.z;
    coronha.material = acabamentos[v.acab];
    maoEsquerda.visible = v.duasMaos;
    clarao.position.set(d[0], d[1], -(v.curta ? 0.17 : 0.531) * v.z + d[2]);
    modeloAtual = chave;
  }
  // a faca balança com a passada e, no golpe, recua, corta em arco da direita para a esquerda e volta
  function animarFaca(dt, naMao) {
    facaNaMao.visible = naMao;
    if (!naMao) return;
    const p = G.player, anda = Math.min(1, (p.speed || 0) / 4);
    facaBalanco += dt * (4 + anda * 7);
    facaAnim = Math.max(0, facaAnim - dt);
    const t = 1 - facaAnim / 0.32, ativo = facaAnim > 0;
    const recuo = ativo && t < 0.25 ? t / 0.25 : 0;                                   // puxa para trás
    const corte = ativo && t >= 0.25 ? Math.sin((t - 0.25) / 0.75 * Math.PI) : 0;     // estocada em arco
    facaNaMao.position.set(
      0.075 + Math.sin(facaBalanco * 0.5) * 0.006 * (0.3 + anda) + recuo * 0.04 - corte * 0.13,
      -0.05 + Math.abs(Math.sin(facaBalanco)) * 0.008 * anda - recuo * 0.02 + corte * 0.03,
      -0.44 + recuo * 0.07 - corte * 0.2);
    facaNaMao.rotation.set(0.034 - corte * 0.35, 0.085 + recuo * 0.25 + corte * 0.75, -0.03 - corte * 0.3);
  }

  /* --------------------------------------------------------- laço da partida */
  let placarEl = null;
  // vida bem visível embaixo, no meio: número grande e barra que muda de cor
  // MAPA (lado direito): o pátio visto de cima, com o norte para cima. Mostra você (seta), os colegas de time (bolinhas com o
  // nome), os reféns e, para os Policiais, o ponto de resgate. Inimigos não aparecem.
  let mapaEl = null, mapaFundo = null, mapaT = 0;
  const MAPA = { x0: -38, x1: 30, z0: -30, z1: 58, larg: 176 };
  function fundoDoMapa() {
    const esc = MAPA.larg / (MAPA.x1 - MAPA.x0), cv = document.createElement("canvas"); cv.width = MAPA.larg; cv.height = Math.round((MAPA.z1 - MAPA.z0) * esc);
    const c = cv.getContext("2d"); c.fillStyle = "rgba(11,13,15,.78)"; c.fillRect(0, 0, cv.width, cv.height);
    for (const b of G.physics.boxes) {
      if (b.bulletOnly || b.playerOnly || b.max.y < 1.2 || b.min.y > 1.5 || b.max.x - b.min.x > 60 || b.max.z - b.min.z > 60) continue;
      c.fillStyle = b.max.y > 6 ? "rgba(232,228,218,.34)" : "rgba(232,228,218,.2)";
      c.fillRect((b.min.x - MAPA.x0) * esc, (b.min.z - MAPA.z0) * esc, Math.max(1, (b.max.x - b.min.x) * esc), Math.max(1, (b.max.z - b.min.z) * esc));
    }
    c.strokeStyle = "rgba(232,228,218,.5)"; c.lineWidth = 1; c.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
    return cv;
  }
  function desenharMapa(dt) {
    if (!mapaEl) return;
    const j = eu(), mostra = emRodada() && !!j && !!j.time;
    mapaEl.hidden = !mostra; if (!mostra) return;
    mapaT -= dt; if (mapaT > 0) return; mapaT = 0.1;
    if (!mapaFundo || mapaFundo.rodada !== mp.rodada) { mapaFundo = fundoDoMapa(); mapaFundo.rodada = mp.rodada; mapaEl.width = mapaFundo.width; mapaEl.height = mapaFundo.height; }
    const c = mapaEl.getContext("2d"), esc = MAPA.larg / (MAPA.x1 - MAPA.x0), X = x => (x - MAPA.x0) * esc, Z = z => (z - MAPA.z0) * esc;
    c.clearRect(0, 0, mapaEl.width, mapaEl.height); c.drawImage(mapaFundo, 0, 0);
    const ondeResgate = j.time === "p" ? mp.resgateVisto : mp.superUsado ? mp.resgateSuper : null;
    if (ondeResgate) {              // onde deixar os reféns: círculo cheio, piscando, com o nome
      const r = ondeResgate, pulso = 0.5 + 0.5 * Math.sin(performance.now() / 260);
      c.fillStyle = "rgba(255,210,122," + (0.25 + 0.3 * pulso).toFixed(2) + ")"; c.strokeStyle = "#ffd27a"; c.lineWidth = 2;
      c.beginPath(); c.arc(X(r.x), Z(r.z), Math.max(6, RAIO_RESGATE * esc), 0, 6.3); c.fill(); c.stroke();
      c.fillStyle = "#ffd27a"; c.font = "700 9px sans-serif"; c.textAlign = "center"; c.fillText("RESGATE", Math.max(24, Math.min(mapaEl.width - 24, X(r.x))), Z(r.z) + (Z(r.z) > mapaEl.height - 22 ? -12 : 20));
    }
    if (j.time === "p") for (const r of mp.refens) if (r.estado < 2) { c.fillStyle = "#f08a00"; c.fillRect(X(r.cur.x) - 2.5, Z(r.cur.z) - 2.5, 5, 5); }
    c.font = "600 9px sans-serif"; c.textAlign = "center";
    for (const o of mp.jogadores.values()) {
      if (o.id === mp.meuId || o.time !== j.time || !o.naRodada && !o.vivo) continue;
      const x = X(o.cur.x), z = Z(o.cur.z); if (o.cur.y < -40) continue;
      c.fillStyle = o.vivo ? TIMES[j.time].css : "rgba(232,228,218,.35)"; c.beginPath(); c.arc(x, z, 3.2, 0, 6.3); c.fill();
      if (o.vivo && !o.bot) { c.fillStyle = "#e8e4da"; c.fillText(String(o.nome).slice(0, 8), x, z - 6); }
    }
    if (mp.superUsado) {                                  // super poder: inimigos (vermelho) e máquinas (cinza) aparecem no mapa
      for (const o of mp.jogadores.values()) if (o.vivo && o.time !== j.time && o.cur.y > -40) { c.fillStyle = "#ff3b30"; c.beginPath(); c.arc(X(o.cur.x), Z(o.cur.z), 3.4, 0, 6.3); c.fill(); c.strokeStyle = "#fff"; c.lineWidth = 1; c.stroke(); }
      for (const e of G.enemies.list) if (e.alive) { c.fillStyle = "rgba(232,228,218,.8)"; c.fillRect(X(e.pos.x) - 1.5, Z(e.pos.z) - 1.5, 3, 3); }
      if (j.time !== "p") for (const r of mp.refens) if (r.estado < 2) { c.fillStyle = "#f08a00"; c.fillRect(X(r.cur.x) - 2.5, Z(r.cur.z) - 2.5, 5, 5); }
    }
    const p = G.player, yaw = p.yaw;                    // você: seta apontando para onde olha
    c.save(); c.translate(X(p.pos.x), Z(p.pos.z)); c.rotate(-yaw); c.fillStyle = "#ffffff"; c.strokeStyle = "#0b0d0f"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, -7); c.lineTo(4.5, 5); c.lineTo(0, 2.5); c.lineTo(-4.5, 5); c.closePath(); c.fill(); c.stroke(); c.restore();
  }
  // RELÓGIO da rodada, grande, no alto e no meio da tela (fica vermelho e pisca nos últimos 30 segundos)
  let tempoEl = null, tempoTxt = "";
  function desenharTempo() {
    if (!tempoEl) return;
    const mostra = emRodada() && (mp.fase === "valendo" || mp.fase === "preparo");
    tempoEl.hidden = !mostra; if (!mostra) return;
    const t = Math.max(0, Math.ceil(mp.tempo)), txt = mp.fase === "preparo" ? "PREPARAR" : Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
    if (txt !== tempoTxt) { tempoTxt = txt; tempoEl.textContent = txt; tempoEl.classList.toggle("fim", mp.fase === "valendo" && t <= 30); }
  }
  let vidaEl = null, tabEl = null;
  function desenharVida() {
    const p = G.player, v = p.alive ? Math.max(0, Math.round(p.health)) : 0, max = p.maxHealth || 100;
    if (v === vidaEl._v && max === vidaEl._m) return;
    vidaEl._v = v; vidaEl._m = max;
    const f = Math.min(1, v / max), cor = v <= 0 ? "#8a8f94" : f > 0.6 ? "#7bd88f" : f > 0.3 ? "#ffb347" : "#ff5a40";
    vidaEl.innerHTML = `<span>Vida</span><b style="color:${cor}">${v}</b><i><u style="width:${(f * 100).toFixed(0)}%;background:${cor}"></u></i>`;
  }
  // placar completo enquanto se segura Tab: os dois times, quem está vivo, abates na rodada e na partida, mortes e vitórias
  function desenharTab() {
    const linha = j => `<tr class="${j.vivo ? "" : "mp-morto"}${j.id === mp.meuId ? " mp-eu" : ""}"><td>${esc(j.nome)}</td><td>${j.vivo ? "vivo" : "morto"}</td><td>${j.abatesRodada | 0}</td><td>${j.abates | 0}</td><td>${j.mortes | 0}</td></tr>`;
    const time = t => {
      const gente = [...mp.jogadores.values()].filter(j => j.time === t).sort((a, b) => (b.abates | 0) - (a.abates | 0));
      return `<section style="--cor:${TIMES[t].css}"><h3>${TIMES[t].nome} <b>${mp.placar[t]}</b> <em>${mp.placar[t] === 1 ? "vitória" : "vitórias"} · ${gente.filter(j => j.vivo).length} de ${gente.length} vivos</em></h3>
        <table><tr><th>Jogador</th><th>Situação</th><th>Abates na rodada</th><th>Abates na partida</th><th>Mortes</th></tr>${gente.map(linha).join("") || `<tr><td colspan="5">ninguém</td></tr>`}</table></section>`;
    };
    tabEl.innerHTML = `<h2>Placar · rodada ${mp.rodada} de ${mp.rodadasTotal}</h2>${time("p")}${time("t")}`;
  }
  window.addEventListener("keydown", ev => { if (ev.code === "Tab" && emRodada()) { ev.preventDefault(); if (tabEl.hidden) { tabEl.hidden = false; desenharTab(); } } });
  window.addEventListener("keyup", ev => { if (ev.code === "Tab" && tabEl) { ev.preventDefault(); tabEl.hidden = true; } });
  window.addEventListener("blur", () => { if (tabEl) tabEl.hidden = true; });
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
      if (!p.alive && !mp.assistindo) post.saturation = Math.max(0.15, (post.saturation ?? 1) - dt * 0.6);
      else if (mp.assistindo) post.saturation = satOriginal;
      if (mp.fase === "preparo") {
        mp.preparoT -= dt;
        if (mp.preparoT <= 0) { mp.fase = "valendo"; p.enabled = p.alive; G.hud.warn("Valendo", 1.6); tocar("objective"); }
      }
      if (mp.fase === "valendo" && !mp.anfitriao) mp.tempo -= dt;
      if (j) { j.vivo = p.alive && j.vivo; j.pos.copy(p.pos); j.cur.copy(p.pos); j.yaw = p.yaw; j.pitch = p.pitch; j.agachado = p.crouching; }
      mp.picharT -= dt;
      carroLocal(dt);
      movimentoEspecial(dt);
      armasLocais(dt);
      if (pertoDaPorta()) { G.hud.setPrompt(null); portas(dt); }       // colado na porta, ela tem prioridade sobre o refém
      else if (!interagir(dt)) portas(dt);
      animarPorta(dt); explosivosLocais(dt);
      if (mp.anfitriao) logicaDoAnfitriao(dt); else moverMarionetes(dt);
      atualizarBonecos(dt); atualizarObjetivo();
      mp.envioT -= dt;
      if (mp.envioT <= 0) {
        mp.envioT = 1 / 30;      // 30 atualizações por segundo entre os jogadores
        if (j) enviar({ t: "estado", p: arr(p.pos), y: +p.yaw.toFixed(3), x: +p.pitch.toFixed(3), c: mp.deitarManual ? 2 : p.crouching ? 1 : 0, v: j.vivo ? 1 : 0, a: (mp.colete ? 1 : 0) | (mp.capacete ? 2 : 0), w: mp.arma || "", s: mp.mirando ? 1 : undefined,
          k: mp.carro.oc[0] === mp.meuId && mp.carro.pos ? [+mp.carro.pos.x.toFixed(2), +mp.carro.pos.z.toFixed(2), +mp.carro.yaw.toFixed(3)] : undefined });
        if (mp.anfitriao) paraTodos({ t: "estados", tempo: +mp.tempo.toFixed(1),
          j: [...mp.jogadores.values()].map(x => [x.id, ...arr(x.pos), +x.yaw.toFixed(3), +x.pitch.toFixed(3), x.noChao ? 2 : x.agachado ? 1 : 0, x.vivo ? 1 : 0, x.armadura | 0, x.id === mp.meuId ? mp.arma || "" : x.arma || ""]),
          r: mp.refens.map(r => [...arr(r.pos), r.estado, r.lider, r.prot | 0, r.estado === 1 ? r.post | 0 : 0]),
          k: mp.carro.pos ? [+mp.carro.pos.x.toFixed(2), +mp.carro.pos.z.toFixed(2), +mp.carro.yaw.toFixed(3)] : null,
          m: G.enemies.list.filter(e => e.alive).map(e => [e.id, e.type === "hound" ? 1 : 0, ...arr(e.pos), +(e.yaw || 0).toFixed(2)]) }, mp.meuId);
      }
      mp.placarT -= dt;
      if (mp.placarT <= 0) { mp.placarT = 0.25; desenharPlacar(); if (!tabEl.hidden) desenharTab(); }
      desenharVida(); desenharMapa(dt); desenharTempo();
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
    instalarTiros(); instalarMaquinas(); montarCenario(); carregarModelos();
    { const pd = G.player.damage.bind(G.player);      // o que não vem do multiplayer (tiro de drone, mordida de cão) pesa conforme a dificuldade
      G.player.damage = (q, de) => pd(emRodada() && !mp.danoMeu ? q * ((dif().maq || {}).dano || 1) : q, de); }
    const armaAtualiza = G.weapon.update;            // deitado, a câmera (e de onde sai o tiro) desce até perto do chão
    G.weapon.update = function (...a) {
      if (emRodada() && mp.deitado && G.player.alive) { G.camera.position.y -= 0.55; G.player.eye.y -= 0.55; }
      assistir(); travarNoDuto();
      const r = armaAtualiza.apply(this, a);
      if (mp.trocaPara && emRodada()) {                    // movimento da troca: mão para baixo e para trás, depois volta com a outra arma
        const t = mp.trocaT, k = t < TROCA.desce ? t / TROCA.desce : Math.max(0, 1 - (t - TROCA.desce) / TROCA.sobe), e = k * k * (3 - 2 * k);
        for (const o of [G.weapon.root, facaNaMao]) if (o) { o.position.y -= e * 0.26; o.position.z += e * 0.1; o.rotation.x -= e * 0.95; o.rotation.z += e * 0.35; }
      }
      return r;
    };
    tempoEl = document.createElement("div"); tempoEl.className = "mp-tempo"; tempoEl.hidden = true; document.getElementById("app").appendChild(tempoEl);
    mapaEl = document.createElement("canvas"); mapaEl.className = "mp-mapa"; mapaEl.hidden = true; document.getElementById("app").appendChild(mapaEl);
    vidaEl = document.createElement("div"); vidaEl.className = "mp-vida"; vidaEl.hidden = true; document.getElementById("app").appendChild(vidaEl);
    tabEl = document.createElement("div"); tabEl.className = "mp-tab"; tabEl.hidden = true; document.getElementById("app").appendChild(tabEl);
    placarEl = document.createElement("div"); placarEl.className = "mp-placar"; placarEl.hidden = true;
    document.getElementById("app").appendChild(placarEl);
    bolsaEl = document.createElement("div"); bolsaEl.className = "mp-bolsa"; bolsaEl.hidden = true;
    document.getElementById("app").appendChild(bolsaEl);
    const acoes = document.querySelector(".m-title .m-actions");      // botão na tela de título
    if (acoes) { const b = document.createElement("button"); b.className = "btn"; b.dataset.mp = "criar"; b.textContent = "Criar sala"; acoes.appendChild(b); }
    const codigo = new URLSearchParams(location.search).get("sala");
    if (codigo && /^[a-z0-9]{6,20}$/.test(codigo)) {
      let era = null; try { era = sessionStorage.getItem("saltline.anfitriao"); } catch {}
      let minha = null; try { minha = localStorage.getItem("pebacity.sala"); } catch {}
      if (era === codigo || minha === codigo) pedirPerfil().then(nome => abrirComoAnfitriao(codigo, nome));   // o anfitrião recarregou a página
      else entrarNaSala(codigo);
    }
    const versaoEl = document.getElementById("versao");      // a versão some enquanto se joga (solo ou multiplayer)
    if (versaoEl) { G.events.on("game:state", ev => { versaoEl.hidden = !!ev && ev.state === "playing"; }); }
    window.__mp = mp; window.__MAO = MAO;
  }
  // TELA CHEIA SEMPRE. O navegador só deixa entrar em tela cheia a partir de um clique ou tecla da pessoa; então, a cada
  // clique ou tecla, se a página não estiver em tela cheia, ela entra. Em tela cheia o Esc fica preso para o jogo (pausa),
  // em vez de sair da tela cheia, nos navegadores que permitem isso.
  // MOUSE = MIRA. Se a primeira captura do mouse falha (por exemplo, a rodada começa sem um clique do convidado), o jogo original
  // desiste e passa a girar a câmera só com o cursor na borda da tela. Aqui, durante a rodada, todo clique ou tecla pede a
  // captura de novo, até pegar; quando pega, o jogo volta sozinho ao modo normal de mira.
  const travarMouse = () => {
    try {
      if (!G || !emRodada() || document.pointerLockElement || G.input.touch || (tela && !tela.hidden) || (pichoEl && !pichoEl.hidden) || (dicasEl && dicasEl.classList.contains("aberta"))) return;
      G.input.requestLock();
    } catch {}
  };
  const telaCheia = () => {
    travarMouse();                                         // antes da tela cheia, que gasta a permissão do clique
    const d = document; if (d.fullscreenElement || d.webkitFullscreenElement) return;
    const el = d.documentElement, entrar = el.requestFullscreen || el.webkitRequestFullscreen; if (!entrar) return;
    try {
      const r = entrar.call(el, { navigationUI: "hide" });
      if (r && r.then) r.then(() => { try { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(); } catch {} }).catch(() => {});      // prende todas as teclas: Esc, Ctrl+W, Ctrl+T...
    } catch {}
  };
  for (const tipo of ["pointerdown", "pointerup", "click", "touchend", "keydown"]) window.addEventListener(tipo, telaCheia, true);
  document.addEventListener("fullscreenchange", () => { mp.telaMudouEm = performance.now(); try { window.dispatchEvent(new Event("resize")); } catch {} });      // o jogo refaz o tamanho da tela
  // PORTÃO DE ENTRADA: como a tela cheia depende de um clique, o jogo abre com uma tela pedindo esse clique. Ela volta sempre que
  // alguém sai da tela cheia fora de uma rodada (dentro da rodada, o próximo clique já devolve a tela cheia).
  const portao = document.createElement("div"); portao.className = "mp-portao";
  portao.innerHTML = "<div><b>PEBACITY</b><span>Clique para jogar em tela cheia</span></div>";
  const mostrarPortao = () => {
    const el = document.documentElement, cheio = document.fullscreenElement || document.webkitFullscreenElement;
    portao.hidden = !!cheio || !(el.requestFullscreen || el.webkitRequestFullscreen) || emRodada();
  };
  portao.addEventListener("click", () => { telaCheia(); portao.hidden = true; });
  (document.getElementById("app") || document.body).appendChild(portao); mostrarPortao();
  for (const tipo of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(tipo, mostrarPortao);
  // SEM CHUVA: o tempo do jogo fica seco (a chuva atrapalhava a visão)
  const semChuva = () => { try { const g = window.__G; for (const k in g) if (g[k] && typeof g[k].setRain === "function") g[k].setRain(0); } catch {} };
  setInterval(semChuva, 2000);
  // IMAGEM MAIS CLARA nas rodadas do multiplayer (a exposição do jogo original é de fim de tarde, escura)
  setInterval(() => { try { const r = window.__G && window.__G.render; if (r && typeof r.exposure === "number") r.exposure = emRodada() ? brilho() : 1; } catch {} }, 300);
  // SOM AMBIENTE. O jogo toca em laço chuva, chuva por dentro, vento e mar (nessa ordem) e depois a música. Não há controle de
  // volume só para eles, então o ajuste é feito na própria gravação, na hora em que cada laço começa a tocar: os dois primeiros
  // (chuva) ficam mudos e os outros ficam bem mais baixos. Tiros e passos não são laços e continuam como estavam.
  try {
    const P = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype, iniciarSom = P && P.start, lacos = window.__lacos = [];
    if (iniciarSom) P.start = function (...a) {
      try {
        const b = this.buffer;
        if (this.loop && b && b.duration > 1.5 && lacos.indexOf(b) < 0) {
          lacos.push(b);
          const fator = lacos.length <= 2 ? 0 : 0.3;
          for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= fator; }
        }
      } catch {}
      return iniciarSom.apply(this, a);
    };
  } catch {}
  const espera = setInterval(() => {
    if (window.__fatal) return clearInterval(espera);
    if (window.__ready && window.__G && window.__G.game && window.__G.game.menus) { clearInterval(espera); try { iniciar(); } catch (e) { console.error("[mp] não iniciou", e); } }
  }, 200);
})();
