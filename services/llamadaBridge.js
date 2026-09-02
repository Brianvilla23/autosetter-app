/**
 * Atinov — Puente de audio: Twilio Media Streams ↔ OpenAI Realtime
 *
 * El corazón del batch de llamadas. Twilio abre un WebSocket contra este
 * servidor cuando el lead contesta; este módulo releva el audio g711 μ-law
 * a OpenAI Realtime (que lo acepta NATIVO — cero transcodificación) y
 * devuelve la voz del modelo a la llamada. Todo por TCP: corre en el
 * Railway actual sin infraestructura nueva.
 *
 * Autenticación del stream: Twilio NO firma el upgrade del WebSocket, así
 * que el wss va "desnudo" y la autorización viaja en los <Parameter> del
 * TwiML (llegan en el evento `start`): id de la llamada + HMAC de un solo
 * uso. Hasta que ese `start` valida, acá no se gasta un token de OpenAI.
 *
 * Candados que viven acá:
 *  - ws_lock: un solo stream por llamada (replay de un start = conexión muerta)
 *  - tope de duración (llamada.max_min, techo HARD_MAX_MIN) con cierre suave:
 *    a falta de 45s se le avisa al modelo para que cierre; al tope se corta.
 *  - timeout de 10s esperando `start` y 10s esperando a OpenAI: nada queda
 *    colgado gastando socket.
 */

const WebSocket = require('ws');
const db = require('../db/database');
const {
  VOCES_REALTIME, EQUIV_VOZ, VOZ_DEFAULT, MODELO, MODELO_TRANSCRIPCION,
  MAX_TOKENS_SALIDA, REGLAS_LLAMADA_SALIENTE, construirBloquesLead,
} = require('./voiceCommon');
const telefonia = require('./telefonia');

const WS_PATH = '/twilio-media';
const ESPERA_START_MS  = 10_000;
const ESPERA_OPENAI_MS = 10_000;
const AVISO_CIERRE_SEG = 45;     // aviso al modelo antes del tope de duración

/**
 * Engancha el WebSocket server al http.Server de Express. Se llama una vez
 * desde server.js con el retorno de app.listen().
 */
function attach(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* cae abajo */ }
    if (pathname !== WS_PATH) {
      // Único WS de la app: cualquier otro upgrade se corta sin handshake.
      socket.destroy();
      return;
    }
    if (!telefonia.telefoniaHabilitada()) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => manejarStream(ws));
  });

  console.log(`📞 Puente de llamadas escuchando en ${WS_PATH} ${telefonia.telefoniaHabilitada() ? '(Twilio configurado)' : '(inerte: faltan credenciales de Twilio)'}`);
  return wss;
}

// ── Normalizacion entre proveedores ──────────────────────────────────────────
// Twilio y Telnyx mandan el MISMO audio (PCMU 8k en base64) y el evento
// `media` tiene la misma forma en los dos. Lo que cambia es la envoltura:
//
//   Twilio  start:  { start: { streamSid, customParameters } }
//   Telnyx  start:  { stream_id, start: { call_control_id, media_format } }
//   Twilio  salida: { event:'media', streamSid, media:{ payload } }
//   Telnyx  salida: { event:'media', media:{ payload } }   ← sin id
//
// El proveedor se detecta del PROPIO mensaje, no de una variable de entorno:
// asi cada stream se identifica solo y las dos vias pueden convivir.

function leerStart(msg) {
  const s = msg.start || {};
  const params = s.customParameters || s.custom_parameters || s.parameters || {};
  const streamId = msg.streamSid || s.streamSid || msg.stream_id || s.stream_id || null;
  const proveedor = (msg.stream_id || s.stream_id || s.call_control_id) ? 'telnyx' : 'twilio';
  return { params, streamId, proveedor };
}

/** Audio del modelo hacia la llamada, en el formato que espera cada uno. */
function msgAudio(proveedor, streamId, payload) {
  return proveedor === 'telnyx'
    ? { event: 'media', media: { payload } }
    : { event: 'media', streamSid: streamId, media: { payload } };
}

/** Barge-in: tirar lo que quedo bufferizado del lado del proveedor. */
function msgClear(proveedor, streamId) {
  return proveedor === 'telnyx' ? { event: 'clear' } : { event: 'clear', streamSid: streamId };
}

/** Una conexión de media streams (Twilio o Telnyx) = una llamada en curso. */
function manejarStream(twilioWs) {
  const estado = {
    llamada: null,          // doc de db.llamadas
    streamSid: null,
    proveedor: 'twilio',      // se corrige al llegar el `start`
    openaiWs: null,
    cerrando: false,
    // barge-in: para truncar el audio del asistente donde el lead interrumpió
    tsMediaMs: 0,               // reloj de la llamada según frames entrantes de Twilio
    tsInicioRespuestaMs: null,  // cuándo empezó a sonar la respuesta vigente
    itemAsistente: null,        // item_id de la respuesta que está sonando
    // transcripción en memoria; se persiste al finalizar (una sola escritura)
    transcript: [],
    respuestaParcial: '',
    timers: { start: null, aviso: null, tope: null },
    inicioMs: Date.now(),
  };

  // Si `start` no llega y valida a tiempo, esto era ruido, no una llamada.
  estado.timers.start = setTimeout(() => {
    if (!estado.llamada) twilioWs.close(1008, 'start timeout');
  }, ESPERA_START_MS);

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      onStart(msg).catch(e => {
        console.error('[bridge] start rechazado:', e.message);
        cerrarTodo('start inválido');
      });
    } else if (msg.event === 'media' && msg.media?.payload) {
      estado.tsMediaMs = Number(msg.media.timestamp || estado.tsMediaMs);
      if (estado.openaiWs?.readyState === WebSocket.OPEN) {
        estado.openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload,
        }));
      }
    } else if (msg.event === 'stop') {
      cerrarTodo('el lead colgó');
    }
  });

  twilioWs.on('close', () => cerrarTodo('twilio ws cerrado'));
  twilioWs.on('error', (e) => { console.warn('[bridge] twilio ws error:', e.message); cerrarTodo('twilio ws error'); });

  async function onStart(msg) {
    const { params: p, streamId, proveedor } = leerStart(msg);
    const llamadaId = String(p.ll || '');
    const token     = String(p.t || '');
    if (!llamadaId || !telefonia.tokenValido(llamadaId, token)) {
      throw new Error('token inválido en customParameters');
    }

    // Un solo stream por llamada: el lock lo gana exactamente una conexión.
    const gane = await db.update(db.llamadas, { _id: llamadaId, ws_lock: null }, {
      ws_lock: `${Date.now()}`, ws_conectado_at: new Date().toISOString(),
    });
    if (!gane) throw new Error('la llamada ya tiene un stream conectado (replay)');

    const llamada = await db.findOne(db.llamadas, { _id: llamadaId });
    if (!llamada) throw new Error('llamada no existe');
    if (!['marcando', 'sonando', 'en_curso'].includes(llamada.status)) {
      throw new Error(`llamada en estado ${llamada.status}, no conectable`);
    }

    estado.llamada = llamada;
    estado.streamSid = streamId;
    estado.proveedor = proveedor;
    clearTimeout(estado.timers.start);

    await db.update(db.llamadas, { _id: llamadaId }, {
      status: 'en_curso', answered_at: llamada.answered_at || new Date().toISOString(),
    }).catch(() => null);

    // ── Armar las instrucciones con la receta del closer ─────────────────────
    const [lead, agent, settings] = await Promise.all([
      db.findOne(db.leads,    { _id: llamada.lead_id }),
      db.findOne(db.agents,   { _id: llamada.agent_id }),
      db.findOne(db.settings, { account_id: llamada.account_id }),
    ]);
    if (!lead || !agent) throw new Error('lead o agente ya no existen');

    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) throw new Error('cuenta sin API key de OpenAI');

    const { knowledgeForAgent } = require('./agents/knowledge');
    const { buildMemoryContext } = require('./leadMemory');
    const todaKnowledge = await db.find(db.knowledge, { account_id: llamada.account_id });
    const kb = knowledgeForAgent(todaKnowledge, agent);
    const kbTexto = kb.length
      ? '\n\n--- INFORMACIÓN DEL NEGOCIO ---\n' + kb.map(k => `[${k.title}]\n${k.content}`).join('\n\n')
      : '';
    const messages = await db.find(db.messages, { lead_id: lead._id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const nombreLead = lead.name || lead.wa_name || lead.ig_username || null;
    const bloques = construirBloquesLead({
      agent, kbTexto,
      lead: { ...lead, name: nombreLead },
      messages, buildMemoryContext,
    });
    bloques.push(REGLAS_LLAMADA_SALIENTE);
    if (llamada.tema) {
      bloques.push(`\n--- TEMA PENDIENTE DE ESTA LLAMADA ---\nQuedaron en: ${llamada.tema}. Ese es el objetivo de la llamada.`);
    }
    const instrucciones = bloques.filter(Boolean).join('\n');

    const vozPedida = EQUIV_VOZ[agent.voice] || agent.voice;
    const voz = VOCES_REALTIME.includes(vozPedida) ? vozPedida : VOZ_DEFAULT;

    await conectarOpenAI({ apiKey, instrucciones, voz });

    // ── Tope de duración: aviso suave y corte duro ───────────────────────────
    const maxMin = Math.min(Number(llamada.max_min) || telefonia.DEFAULT_MAX_MIN, telefonia.HARD_MAX_MIN);
    const topeMs = maxMin * 60_000;
    estado.timers.aviso = setTimeout(() => {
      enviarOpenAI({
        type: 'conversation.item.create',
        item: {
          type: 'message', role: 'system',
          content: [{ type: 'input_text', text: 'AVISO INTERNO: quedan menos de 45 segundos de llamada. Cierra AHORA con el siguiente paso concreto y despídete corto. No menciones límites de tiempo del sistema.' }],
        },
      });
    }, Math.max(topeMs - AVISO_CIERRE_SEG * 1000, 5_000));
    estado.timers.tope = setTimeout(() => {
      console.warn(`[bridge] llamada ${llamadaId} llegó al tope de ${maxMin} min — corte`);
      cerrarTodo('tope de duración');
    }, topeMs);

    console.log(`📞 [bridge] en curso ${llamadaId} → ${llamada.telefono} (agente ${agent.name}, voz ${voz}, máx ${maxMin} min)`);
  }

  function conectarOpenAI({ apiKey, instrucciones, voz }) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODELO)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      estado.openaiWs = ws;

      const guard = setTimeout(() => {
        reject(new Error('OpenAI Realtime no abrió a tiempo'));
        try { ws.close(); } catch { /* ya está */ }
      }, ESPERA_OPENAI_MS);

      ws.on('open', () => {
        // g711 μ-law en las DOS direcciones: el mismo formato que manda y
        // espera Twilio. Confirmado nativo — sin transcodificación en medio.
        // El modelo va en la URL del WS; repetirlo en session.update es
        // parámetro inválido en la API GA.
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: instrucciones,
            max_output_tokens: MAX_TOKENS_SALIDA,
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: { model: MODELO_TRANSCRIPCION },
                turn_detection: { type: 'server_vad' },
              },
              output: {
                format: { type: 'audio/pcmu' },
                voice: voz,
              },
            },
          },
        }));
      });

      ws.on('message', (raw) => {
        let ev;
        try { ev = JSON.parse(raw.toString()); } catch { return; }

        switch (ev.type) {
          case 'session.updated':
            clearTimeout(guard);
            // El lead contesta con "¿aló?" — pero si se queda callado, el
            // agente abre igual: es él quien llamó.
            ws.send(JSON.stringify({ type: 'response.create' }));
            resolve();
            break;

          // Audio del modelo → a la llamada. (GA y beta nombran distinto el
          // delta de audio; aceptar ambos no cuesta nada y aguanta upgrades.)
          case 'response.output_audio.delta':
          case 'response.audio.delta':
            if (ev.delta && twilioWs.readyState === WebSocket.OPEN && estado.streamSid) {
              if (estado.tsInicioRespuestaMs === null) estado.tsInicioRespuestaMs = estado.tsMediaMs;
              if (ev.item_id) estado.itemAsistente = ev.item_id;
              twilioWs.send(JSON.stringify(msgAudio(estado.proveedor, estado.streamSid, ev.delta)));
            }
            break;

          // El lead empezó a hablar encima → barge-in: tirar el audio
          // bufferizado en Twilio y truncar el item para que el modelo sepa
          // exactamente cuánto alcanzó a "decir".
          case 'input_audio_buffer.speech_started': {
            if (twilioWs.readyState === WebSocket.OPEN && estado.streamSid) {
              twilioWs.send(JSON.stringify(msgClear(estado.proveedor, estado.streamSid)));
            }
            if (estado.itemAsistente && estado.tsInicioRespuestaMs !== null) {
              const transcurrido = Math.max(0, estado.tsMediaMs - estado.tsInicioRespuestaMs);
              enviarOpenAI({
                type: 'conversation.item.truncate',
                item_id: estado.itemAsistente,
                content_index: 0,
                audio_end_ms: transcurrido,
              });
            }
            estado.itemAsistente = null;
            estado.tsInicioRespuestaMs = null;
            break;
          }

          // Transcripciones → memoria del sistema (se persiste al colgar).
          case 'conversation.item.input_audio_transcription.completed':
            if (ev.transcript?.trim()) {
              estado.transcript.push({ quien: 'lead', texto: ev.transcript.trim(), t: Date.now() });
            }
            break;

          case 'response.output_audio_transcript.delta':
          case 'response.audio_transcript.delta':
            estado.respuestaParcial += ev.delta || '';
            break;

          case 'response.output_audio_transcript.done':
          case 'response.audio_transcript.done': {
            const texto = (ev.transcript || estado.respuestaParcial).trim();
            if (texto) estado.transcript.push({ quien: 'agente', texto, t: Date.now() });
            estado.respuestaParcial = '';
            break;
          }

          case 'response.done':
            estado.itemAsistente = null;
            estado.tsInicioRespuestaMs = null;
            break;

          case 'error':
            // Regla del repo: el detalle del proveedor al log, jamás al lead.
            console.error('[bridge] OpenAI error:', ev.error?.message || JSON.stringify(ev.error || {}).slice(0, 200));
            break;
        }
      });

      ws.on('close', () => {
        clearTimeout(guard);
        cerrarTodo('openai ws cerrado');
      });
      ws.on('error', (e) => {
        clearTimeout(guard);
        console.error('[bridge] OpenAI ws error:', e.message);
        reject(e);
        cerrarTodo('openai ws error');
      });
    });
  }

  function enviarOpenAI(obj) {
    if (estado.openaiWs?.readyState === WebSocket.OPEN) {
      estado.openaiWs.send(JSON.stringify(obj));
    }
  }

  /**
   * Cierre único e idempotente de la conexión. La llamada se finaliza acá
   * (duración medida por el bridge) o en el status callback de Twilio
   * (duración oficial) — el primero que llegue gana, finalizarLlamada tiene
   * su propio lock.
   */
  function cerrarTodo(motivo) {
    if (estado.cerrando) return;
    estado.cerrando = true;
    Object.values(estado.timers).forEach(t => clearTimeout(t));

    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, 'fin'); } catch { /* nada */ }
    try { if (estado.openaiWs && estado.openaiWs.readyState === WebSocket.OPEN) estado.openaiWs.close(1000, 'fin'); } catch { /* nada */ }

    const ll = estado.llamada;
    if (!ll) return;

    (async () => {
      // Persistir la transcripción ANTES de finalizar: la nota del hilo la lee.
      await db.update(db.llamadas, { _id: ll._id }, {
        transcript: estado.transcript.slice(0, 400),
      }).catch(() => null);

      // Si el cierre lo inició ESTE lado (tope, error de OpenAI, lo que sea),
      // la pata telefónica puede seguir viva con aire muerto y taxímetro
      // corriendo: colgarla por REST. Si el cierre vino de Twilio (el lead
      // colgó / stop), la llamada ya murió y no hay nada que colgar.
      const cerroTwilio = motivo === 'el lead colgó' || motivo.startsWith('twilio');
      const doc = await db.findOne(db.llamadas, { _id: ll._id }).catch(() => null);
      if (!cerroTwilio && doc?.twilio_call_sid) {
        telefonia.colgarLlamadaTwilio(doc.twilio_call_sid).catch(e =>
          console.warn('[bridge] no se pudo colgar por REST:', e.message));
      }

      const dur = doc?.answered_at
        ? Math.round((Date.now() - new Date(doc.answered_at).getTime()) / 1000)
        : Math.round((Date.now() - estado.inicioMs) / 1000);
      await telefonia.finalizarLlamada(ll._id, { resultado: 'terminada', duracionSeg: dur });
      console.log(`📞 [bridge] cerrado ${ll._id} (${motivo})`);
    })().catch(e => console.error('[bridge] error al cerrar:', e.message));
  }
}

module.exports = { attach, WS_PATH, leerStart, msgAudio, msgClear };
