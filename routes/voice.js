/**
 * Atinov — Demo de voz en vivo (OpenAI Realtime)
 *
 * Deja HABLAR con el agente hoy, sin depender de la verificación de Meta:
 * el navegador abre una sesión WebRTC directo contra OpenAI usando un token
 * EFÍMERO que este endpoint acuña con las instrucciones y la Knowledge Base
 * REALES de la cuenta. No es una maqueta: es el mismo agente que responde
 * por WhatsApp, hablando.
 *
 * Es además el banco de pruebas del bridge de WhatsApp Calling: la parte
 * difícil (cómo se comporta el agente por voz, latencia, español chileno,
 * interrupciones) se valida acá y después solo se cambia el transporte.
 *
 * SEGURIDAD: el endpoint exige sesión (requireAuth en server.js). Un endpoint
 * abierto que acuña tokens de OpenAI es una canilla libre contra la tarjeta
 * del dueño. La API key nunca sale del servidor: el browser solo recibe un
 * secreto efímero (~60s) atado a ESTA sesión.
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../db/database');
const { knowledgeForAgent } = require('../services/agents/knowledge');

// Constantes y reglas de voz compartidas con el closer en vivo
// (routes/closer.js). Viven en services/voiceCommon.js para que afinar el
// comportamiento por voz se haga en UN solo lugar y las dos vías no se
// desincronicen.
const {
  VOCES_REALTIME, EQUIV_VOZ, VOZ_DEFAULT, MODELO, MODELO_TRANSCRIPCION,
  SECRETO_SEGUNDOS, MAX_TOKENS_SALIDA, REGLAS_VOZ,
} = require('../services/voiceCommon');

const MAX_SESIONES_DIA = 20;   // por cuenta — compartido con el closer

/**
 * POST /api/voice/token
 * Body: { agentId? }
 * Devuelve { value, expires_at, agent, voz } — el secreto efímero para que el
 * browser abra la sesión WebRTC.
 */
router.post('/token', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    if (!accountId) return res.status(400).json({ error: 'cuenta no resuelta desde la sesión' });

    // API key: misma precedencia que todo el repo (plataforma → cuenta).
    const settings = await db.findOne(db.settings, { account_id: accountId });
    const apiKey = process.env.OPENAI_API_KEY || settings?.openai_key;
    if (!apiKey) {
      return res.status(400).json({ error: 'La cuenta no tiene API key de OpenAI configurada (Configuración → OpenAI).' });
    }

    // Tope diario por cuenta. El rate limit por IP no alcanza: cambiar de IP
    // es trivial, y cada sesión de audio se factura por minuto sin techo
    // natural. Reset perezoso por fecha, igual que el contador de DMs.
    const hoy = new Date().toISOString().slice(0, 10);
    const usadasHoy = settings?.voice_sessions_date === hoy
      ? Number(settings.voice_sessions_count || 0)
      : 0;
    if (usadasHoy >= MAX_SESIONES_DIA) {
      return res.status(429).json({
        error: `Alcanzaste el máximo de ${MAX_SESIONES_DIA} sesiones de voz por día. Vuelve mañana.`,
      });
    }

    // Agente: el pedido, o el primero habilitado de la cuenta.
    const agentes = await db.find(db.agents, { account_id: accountId });
    const agent = (req.body?.agentId && agentes.find(a => a._id === req.body.agentId))
      || agentes.find(a => a.enabled)
      || agentes[0];
    if (!agent) return res.status(404).json({ error: 'La cuenta no tiene ningún agente creado.' });

    // Knowledge real del agente (misma regla que usa el flujo de chat).
    const todaKnowledge = await db.find(db.knowledge, { account_id: accountId });
    const kb = knowledgeForAgent(todaKnowledge, agent);
    const kbTexto = kb.length
      ? '\n\n--- INFORMACIÓN DEL NEGOCIO ---\n' + kb.map(k => `[${k.title}]\n${k.content}`).join('\n\n')
      : '';

    const vozPedida = EQUIV_VOZ[agent.voice] || agent.voice;
    const voz = VOCES_REALTIME.includes(vozPedida) ? vozPedida : VOZ_DEFAULT;
    const instrucciones = (agent.instructions || '') + kbTexto + REGLAS_VOZ;

    const r = await axios.post('https://api.openai.com/v1/realtime/client_secrets', {
      expires_after: { anchor: 'created_at', seconds: SECRETO_SEGUNDOS },
      session: {
        type: 'realtime',
        model: MODELO,
        instructions: instrucciones,
        max_output_tokens: MAX_TOKENS_SALIDA,
        audio: {
          input: { transcription: { model: MODELO_TRANSCRIPCION } },
          output: { voice: voz },
        },
      },
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const value = r.data?.value || r.data?.client_secret?.value;
    if (!value) throw new Error('OpenAI no devolvió el secreto efímero');

    // Contabilizar DESPUÉS de que OpenAI aceptó (un fallo no gasta cuota).
    if (settings) {
      await db.update(db.settings, { account_id: accountId }, {
        voice_sessions_date: hoy, voice_sessions_count: usadasHoy + 1,
      }).catch(() => null);
    } else {
      await db.insert(db.settings, {
        account_id: accountId, openai_key: '',
        voice_sessions_date: hoy, voice_sessions_count: 1,
      }).catch(() => null);
    }

    console.log(`🎙️ [voz] Sesión demo abierta — cuenta ${accountId}, agente ${agent.name} (${usadasHoy + 1}/${MAX_SESIONES_DIA} hoy)`);
    res.json({
      value,
      expires_at: r.data?.expires_at || null,
      agent: { id: agent._id, name: agent.name, avatar: agent.avatar || '🎙️' },
      voz,
      modelo: MODELO,
      restantes_hoy: MAX_SESIONES_DIA - (usadasHoy + 1),
    });
  } catch (e) {
    // El mensaje de OpenAI puede traer el project id, el estado de facturación
    // o el prefijo de la key. Al log del servidor sí; al cliente NUNCA.
    console.error('[voz] no se pudo acuñar el token:', e.response?.data?.error?.message || e.message);
    res.status(500).json({ error: 'No se pudo iniciar la sesión de voz. Revisa la configuración de OpenAI e intenta de nuevo.' });
  }
});

module.exports = router;
