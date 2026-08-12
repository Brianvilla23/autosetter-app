/**
 * Atinov — Closer en vivo (voz con un LEAD, sin sesión iniciada)
 *
 * Cuando un lead se pone caliente, el agente le ofrece pasar a una conversación
 * de voz ahí mismo. El argumento de venta no es "es igual que un closer humano":
 * es que a las 22:15 de un domingo el closer humano no existe y este sí.
 *
 * Es hermano de `routes/voice.js` (la demo del dueño) pero con dos diferencias
 * que lo cambian todo:
 *
 *  1. NO hay sesión. Quien entra es un desconocido. La autorización es una
 *     invitación firmada de un solo uso (`services/voiceInvite.js`).
 *  2. SÍ hay contexto. La sesión arranca sabiendo quién es la persona, qué
 *     conversaron y qué la frenó. Sin esto el closer pregunta lo que el lead
 *     ya contestó por texto — que es el bug de los ecos otra vez.
 *
 * LOS CANDADOS (regla del repo: todo endpoint que gaste plata necesita cuatro,
 * y `requireAuth` acá no está disponible):
 *  1. Invitación firmada con HMAC, atada a ese lead y con vencimiento
 *  2. Un solo uso — el hash se borra al abrir la sesión
 *  3. Rate limit por IP (voiceLimiter en el mount)
 *  4. Tope diario por cuenta, el MISMO contador que la demo
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../db/database');
const { knowledgeForAgent } = require('../services/agents/knowledge');
const { buildMemoryContext } = require('../services/leadMemory');
const { verifyInvite, matchesStoredHash } = require('../services/voiceInvite');
const {
  VOCES_REALTIME, EQUIV_VOZ, VOZ_DEFAULT, MODELO, MODELO_TRANSCRIPCION,
  SECRETO_SEGUNDOS, MAX_TOKENS_SALIDA, construirBloquesLead,
} = require('../services/voiceCommon');

const MAX_SESIONES_DIA = 20;  // por cuenta, compartido con la demo del dueño
const TURNOS_CONTEXTO  = 14;  // últimos mensajes que se le pasan al closer

// Un mensaje de error genérico para TODO fallo de invitación. Distinguir entre
// "no existe", "venció" y "ya se usó" le diría a alguien que prueba links si
// acertó el formato.
const INVITACION_INVALIDA = 'Este enlace ya no es válido. Pídele uno nuevo al asistente por el chat.';

/**
 * POST /api/closer/token   Body: { invite }
 * Público — la autorización es la invitación firmada.
 */
router.post('/token', async (req, res) => {
  try {
    const datos = verifyInvite(req.body?.invite);
    if (!datos) return res.status(403).json({ error: INVITACION_INVALIDA });

    const lead = await db.findOne(db.leads, { _id: datos.leadId });
    if (!lead || lead.account_id !== datos.accountId) {
      return res.status(403).json({ error: INVITACION_INVALIDA });
    }

    // Un solo uso: si el hash no está o no calza, el link ya se ocupó o fue
    // reemplazado por una invitación más nueva.
    if (!matchesStoredHash(datos.nonce, lead.voice_invite_hash)) {
      return res.status(403).json({ error: INVITACION_INVALIDA });
    }

    const accountId = datos.accountId;
    const settings  = await db.findOne(db.settings, { account_id: accountId });
    const apiKey    = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) {
      console.error(`[closer] cuenta ${accountId} sin API key de OpenAI`);
      return res.status(503).json({ error: 'El asistente de voz no está disponible en este momento.' });
    }

    // Tope diario por cuenta — el mismo contador que la demo del dueño, para
    // que las dos vías no sumen el doble sin que nadie lo note.
    const hoy = new Date().toISOString().slice(0, 10);
    const usadasHoy = settings?.voice_sessions_date === hoy
      ? Number(settings.voice_sessions_count || 0)
      : 0;
    if (usadasHoy >= MAX_SESIONES_DIA) {
      console.warn(`[closer] cuenta ${accountId} alcanzó el tope diario de voz`);
      return res.status(429).json({ error: 'El asistente de voz no está disponible en este momento. Sigue por el chat y te responde igual.' });
    }

    // Agente: el que venía atendiendo a este lead, o el primero habilitado.
    const agentes = await db.find(db.agents, { account_id: accountId });
    const agent = (lead.agent_id && agentes.find(a => a._id === lead.agent_id))
      || agentes.find(a => a.enabled)
      || agentes[0];
    if (!agent) {
      console.error(`[closer] cuenta ${accountId} sin agentes`);
      return res.status(503).json({ error: 'El asistente de voz no está disponible en este momento.' });
    }

    const todaKnowledge = await db.find(db.knowledge, { account_id: accountId });
    const kb = knowledgeForAgent(todaKnowledge, agent);
    const kbTexto = kb.length
      ? '\n\n--- INFORMACIÓN DEL NEGOCIO ---\n' + kb.map(k => `[${k.title}]\n${k.content}`).join('\n\n')
      : '';

    const messages = await db.find(db.messages, { lead_id: lead._id },
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Bloques compartidos con la llamada telefónica (services/voiceCommon.js):
    // afinar el comportamiento del closer por voz se hace en UN solo lugar.
    const bloques = construirBloquesLead({
      agent, kbTexto, lead, messages, buildMemoryContext, turnos: TURNOS_CONTEXTO,
    }).filter(Boolean);

    const vozPedida = EQUIV_VOZ[agent.voice] || agent.voice;
    const voz = VOCES_REALTIME.includes(vozPedida) ? vozPedida : VOZ_DEFAULT;

    const r = await axios.post('https://api.openai.com/v1/realtime/client_secrets', {
      expires_after: { anchor: 'created_at', seconds: SECRETO_SEGUNDOS },
      session: {
        type: 'realtime',
        model: MODELO,
        instructions: bloques.join('\n'),
        max_output_tokens: MAX_TOKENS_SALIDA,
        audio: {
          input:  { transcription: { model: MODELO_TRANSCRIPCION } },
          output: { voice: voz },
        },
      },
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const value = r.data?.value || r.data?.client_secret?.value;
    if (!value) throw new Error('OpenAI no devolvió el secreto efímero');

    // Consumir la invitación y contabilizar SOLO después de que OpenAI aceptó:
    // si falla, el lead puede reintentar con el mismo link y no se gastó cuota.
    await db.update(db.leads, { _id: lead._id },
      { voice_invite_hash: null, voice_invite_expires: null, voice_invite_used_at: new Date().toISOString() })
      .catch(() => null);

    if (settings) {
      await db.update(db.settings, { account_id: accountId },
        { voice_sessions_date: hoy, voice_sessions_count: usadasHoy + 1 }).catch(() => null);
    }

    await db.insert(db.messages, {
      lead_id: lead._id, account_id: accountId, role: 'sistema',
      content: '🎙️ El lead entró a una conversación de voz con el closer.',
      createdAt: new Date().toISOString(),
    }).catch(() => null);

    console.log(`🎙️ [closer] Sesión con lead ${lead._id} — cuenta ${accountId}, agente ${agent.name} (${usadasHoy + 1}/${MAX_SESIONES_DIA} hoy)`);

    res.json({
      value,
      expires_at: r.data?.expires_at || null,
      agent: { name: agent.name, avatar: agent.avatar || '🎙️' },
      lead:  { nombre: lead.name || null },
      voz,
      modelo: MODELO,
    });
  } catch (e) {
    // El error de OpenAI puede traer el project id, el estado de facturación o
    // el prefijo de la key. Al log sí; al cliente NUNCA.
    console.error('[closer] no se pudo abrir la sesión:', e.response?.data?.error?.message || e.message);
    res.status(500).json({ error: 'No se pudo iniciar la conversación de voz. Sigue por el chat y te respondemos igual.' });
  }
});

module.exports = router;
