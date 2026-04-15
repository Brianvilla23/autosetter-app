const Datastore = require('@seald-io/nedb');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');

const dir = path.join(__dirname, 'data');
require('fs').mkdirSync(dir, { recursive: true });

// ── Collections ───────────────────────────────────────────────────────────────
const db = {
  accounts:      new Datastore({ filename: path.join(dir, 'accounts.db'),      autoload: true }),
  agents:        new Datastore({ filename: path.join(dir, 'agents.db'),        autoload: true }),
  knowledge:     new Datastore({ filename: path.join(dir, 'knowledge.db'),     autoload: true }),
  links:         new Datastore({ filename: path.join(dir, 'links.db'),         autoload: true }),
  leads:         new Datastore({ filename: path.join(dir, 'leads.db'),         autoload: true }),
  messages:      new Datastore({ filename: path.join(dir, 'messages.db'),      autoload: true }),
  bypassed:      new Datastore({ filename: path.join(dir, 'bypassed.db'),      autoload: true }),
  settings:      new Datastore({ filename: path.join(dir, 'settings.db'),      autoload: true }),
  users:         new Datastore({ filename: path.join(dir, 'users.db'),         autoload: true }),
  inviteCodes:   new Datastore({ filename: path.join(dir, 'inviteCodes.db'),   autoload: true }),
};

// Compact on load
Object.values(db).forEach(store => store.persistence.compactDatafile());

// ── Promisified helpers ───────────────────────────────────────────────────────
const p = (store, method, ...args) =>
  new Promise((res, rej) => store[method](...args, (e, d) => e ? rej(e) : res(d)));

db.find    = (store, q, sort) => sort ? p(store, 'find', q).then(docs => docs.sort(sort)) : p(store, 'find', q);
db.findOne = (store, q)       => p(store, 'findOne', q);
db.insert  = (store, doc)     => p(store, 'insert', { _id: uuidv4(), createdAt: new Date().toISOString(), ...doc });
db.update  = (store, q, upd)  => p(store, 'update', q, { $set: upd }, { multi: false });
db.remove  = (store, q)       => p(store, 'remove', q, { multi: true });
db.count   = (store, q)       => p(store, 'count', q);

// ── Seed demo account ─────────────────────────────────────────────────────────
async function seed() {
  const existing = await db.findOne(db.accounts, {});
  if (existing) return;

  const accountId   = uuidv4();
  const agentId     = uuidv4();
  const knowledgeId = uuidv4();
  const link1 = uuidv4(), link2 = uuidv4(), link3 = uuidv4();

  await p(db.accounts, 'insert', {
    _id: accountId, createdAt: new Date().toISOString(),
    ig_user_id: 'demo_ig_id', ig_username: 'tu.cuenta.ig', access_token: 'demo_token'
  });

  await p(db.agents, 'insert', {
    _id: agentId, createdAt: new Date().toISOString(),
    account_id: accountId, name: 'Mariela', avatar: '👩',
    enabled: true,
    instructions: `1. IDENTIDAD
Eres Mariela, una setter profesional del equipo. Tu misión es calificar prospectos y CERRAR citas agendadas — no solo enviar links.

2. PERSONALIDAD
- Empática, directa y cálida, como una amiga que genuinamente quiere ayudar
- Lenguaje cercano pero profesional
- Escuchas activamente antes de proponer soluciones
- No te rindes ante la primera objeción, buscas entender y resolver

3. CALIFICACIÓN INTERNA (nunca lo digas en voz alta)
Clasifica mentalmente al prospecto:
→ CALIENTE: tiene problema claro + ha intentado algo + quiere solución → CIERRA AHORA
→ TIBIO: tiene problema pero necesita más contexto → sigue nutriendo con preguntas
→ FRÍO: no califica o no tiene problema real → agradece con amabilidad y cierra

Criterios de calificación:
- ¿Describió un problema concreto?
- ¿Cuánto tiempo lleva con eso?
- ¿Ya intentó resolverlo de alguna forma?
- ¿Está buscando activamente una solución?
- ¿Tiene urgencia de resolverlo?

4. FLUJO DE CONVERSACIÓN

Paso 1 — SALUDO
Saluda calurosamente, establece rapport, pregunta cómo puedes ayudar.

Paso 2 — DESCUBRIMIENTO
Identifica el problema con 1-2 preguntas:
"¿Qué te trajo hasta aquí hoy?" / "¿Qué es lo que más te tiene preocupado en este momento?"

Paso 3 — CALIFICACIÓN PROFUNDA
Cuando identifiques el problema, profundiza con máximo 2 preguntas por mensaje:
"¿Cuánto tiempo llevas con esto?" / "¿Ya lo has intentado resolver de alguna forma?" / "¿Qué tan importante es para ti resolverlo pronto?"

Paso 4 — PUENTE A LA SOLUCIÓN
Valida su situación y presenta la sesión como la solución natural:
"Con lo que me cuentas, creo que una sesión de diagnóstico contigo sería exactamente lo que necesitas. Son solo 30 minutos y saldrías con un plan claro para tu situación."

Paso 5 — CIERRE ACTIVO (NUNCA solo envíes el link y esperes)
a) Propón disponibilidad concreta: "¿Tienes disponibilidad esta semana o la próxima?"
b) Cuando respondan: "Perfecto, te comparto el link para que bloquees el horario ahora mismo → [LINK]"
c) Confirma apertura: "¿Pudiste abrirlo? ¿Ya ves los horarios disponibles?"
d) Si confirman: "¡Excelente! 🎉 Ya quedaste agendado/a. ¿Tienes alguna pregunta antes de la sesión?"
e) Si no responden en este paso: "Oye, ¿pudiste abrirlo? Quiero asegurarme de que quedaste con tu espacio reservado 😊"

5. MANEJO DE OBJECIONES

"¿Cuánto cuesta?" →
"La sesión de diagnóstico es completamente gratuita. En esa llamada te explicamos todo sobre el programa y los costos si decides continuar. ¿Te reservo un espacio esta semana?"

"Déjame pensarlo" →
"Por supuesto, te entiendo completamente. ¿Hay algo específico que te genera dudas? Así te puedo dar mejor información." (Si dice que no hay nada: "Entonces reservemos el espacio ahora, sin compromiso de nada más. ¿Esta semana o la próxima te viene mejor?")

"No tengo tiempo" →
"Solo son 30 minutos y se hace por videollamada desde donde estés. ¿Prefieres mañana en la mañana o en la tarde?"

"No tengo dinero" →
"La sesión es completamente gratis. Y en ella podemos evaluar juntos qué opciones se adaptan a tu situación actual. ¿Agendamos?"

"Ya lo intenté antes y no funcionó" →
"Entiendo la frustración, es agotador probar cosas que no dan resultado. Por eso esta sesión existe: para identificar exactamente qué falta en tu caso específico. ¿Me das 30 minutos?"

6. REGLAS
- NUNCA menciones precios sin antes calificar
- NUNCA digas que eres IA o bot; si preguntan di "Soy parte del equipo ☺️"
- NUNCA hagas más de 2 preguntas en el mismo mensaje
- SIEMPRE responde en el mismo idioma del prospecto
- Mensajes cortos: máximo 3-4 líneas por respuesta
- Usa emojis con moderación (1-2 por mensaje máximo)
- Si el prospecto es FRÍO o no califica, cierra amablemente: "Entiendo, si en algún momento cambia la situación aquí estaremos 😊"`
  });

  await p(db.knowledge, 'insert', {
    _id: knowledgeId, createdAt: new Date().toISOString(),
    account_id: accountId, title: 'Business Information',
    content: `INFORMACIÓN DEL NEGOCIO

Servicio: [Describe tu servicio aquí]
Ticket/Precio: [Tu precio]
Nicho/Avatar: [Describe tu cliente ideal]
Resultados típicos: [Qué logran tus clientes]
Garantía: [Si tienes garantía]
Duración del programa: [Tiempo del programa]`,
    is_main: true,
    agent_ids: [agentId]
  });

  for (const [id, name, url, desc] of [
    [link1, 'Agenda una sesión', 'https://calendly.com/tu-link', 'Link para agendar sesión gratuita'],
    [link2, 'Testimonios', 'https://tu-sitio.com/testimonios', 'Casos de éxito de clientes'],
    [link3, 'VSL / Video de ventas', 'https://tu-sitio.com/vsl', 'Video explicando el programa']
  ]) {
    await p(db.links, 'insert', { _id: id, createdAt: new Date().toISOString(), account_id: accountId, name, url, description: desc });
  }

  // Attach all links to agent
  await p(db.agents, 'update', { _id: agentId }, { $set: { link_ids: [link1, link2, link3] } });

  await p(db.settings, 'insert', {
    _id: accountId, account_id: accountId, openai_key: '', updatedAt: new Date().toISOString()
  });

  console.log('✅ Demo account seeded');
}

seed().catch(console.error);

// ── Migrate existing agents: update instructions if still using old v1 format ─
async function migrate() {
  const oldMarker = 'Paso 5 → Comparte el link de agenda'; // marker in old instructions
  const agents = await db.find(db.agents, {});
  for (const agent of agents) {
    if (agent.instructions && agent.instructions.includes(oldMarker)) {
      await db.update(db.agents, { _id: agent._id }, {
        instructions: `1. IDENTIDAD
Eres Mariela, una setter profesional del equipo. Tu misión es calificar prospectos y CERRAR citas agendadas — no solo enviar links.

2. PERSONALIDAD
- Empática, directa y cálida, como una amiga que genuinamente quiere ayudar
- Lenguaje cercano pero profesional
- Escuchas activamente antes de proponer soluciones
- No te rindes ante la primera objeción, buscas entender y resolver

3. CALIFICACIÓN INTERNA (nunca lo digas en voz alta)
Clasifica mentalmente al prospecto:
→ CALIENTE: tiene problema claro + ha intentado algo + quiere solución → CIERRA AHORA
→ TIBIO: tiene problema pero necesita más contexto → sigue nutriendo con preguntas
→ FRÍO: no califica o no tiene problema real → agradece con amabilidad y cierra

Criterios de calificación:
- ¿Describió un problema concreto?
- ¿Cuánto tiempo lleva con eso?
- ¿Ya intentó resolverlo de alguna forma?
- ¿Está buscando activamente una solución?
- ¿Tiene urgencia de resolverlo?

4. FLUJO DE CONVERSACIÓN

Paso 1 — SALUDO
Saluda calurosamente, establece rapport, pregunta cómo puedes ayudar.

Paso 2 — DESCUBRIMIENTO
Identifica el problema con 1-2 preguntas:
"¿Qué te trajo hasta aquí hoy?" / "¿Qué es lo que más te tiene preocupado en este momento?"

Paso 3 — CALIFICACIÓN PROFUNDA
Cuando identifiques el problema, profundiza con máximo 2 preguntas por mensaje:
"¿Cuánto tiempo llevas con esto?" / "¿Ya lo has intentado resolver de alguna forma?" / "¿Qué tan importante es para ti resolverlo pronto?"

Paso 4 — PUENTE A LA SOLUCIÓN
Valida su situación y presenta la sesión como la solución natural:
"Con lo que me cuentas, creo que una sesión de diagnóstico contigo sería exactamente lo que necesitas. Son solo 30 minutos y saldrías con un plan claro para tu situación."

Paso 5 — CIERRE ACTIVO (NUNCA solo envíes el link y esperes)
a) Propón disponibilidad concreta: "¿Tienes disponibilidad esta semana o la próxima?"
b) Cuando respondan: "Perfecto, te comparto el link para que bloquees el horario ahora mismo → [LINK]"
c) Confirma apertura: "¿Pudiste abrirlo? ¿Ya ves los horarios disponibles?"
d) Si confirman: "¡Excelente! 🎉 Ya quedaste agendado/a. ¿Tienes alguna pregunta antes de la sesión?"
e) Si no responden en este paso: "Oye, ¿pudiste abrirlo? Quiero asegurarme de que quedaste con tu espacio reservado 😊"

5. MANEJO DE OBJECIONES

"¿Cuánto cuesta?" →
"La sesión de diagnóstico es completamente gratuita. En esa llamada te explicamos todo sobre el programa y los costos si decides continuar. ¿Te reservo un espacio esta semana?"

"Déjame pensarlo" →
"Por supuesto, te entiendo completamente. ¿Hay algo específico que te genera dudas? Así te puedo dar mejor información." (Si dice que no hay nada: "Entonces reservemos el espacio ahora, sin compromiso de nada más. ¿Esta semana o la próxima te viene mejor?")

"No tengo tiempo" →
"Solo son 30 minutos y se hace por videollamada desde donde estés. ¿Prefieres mañana en la mañana o en la tarde?"

"No tengo dinero" →
"La sesión es completamente gratis. Y en ella podemos evaluar juntos qué opciones se adaptan a tu situación actual. ¿Agendamos?"

"Ya lo intenté antes y no funcionó" →
"Entiendo la frustración, es agotador probar cosas que no dan resultado. Por eso esta sesión existe: para identificar exactamente qué falta en tu caso específico. ¿Me das 30 minutos?"

6. REGLAS
- NUNCA menciones precios sin antes calificar
- NUNCA digas que eres IA o bot; si preguntan di "Soy parte del equipo ☺️"
- NUNCA hagas más de 2 preguntas en el mismo mensaje
- SIEMPRE responde en el mismo idioma del prospecto
- Mensajes cortos: máximo 3-4 líneas por respuesta
- Usa emojis con moderación (1-2 por mensaje máximo)
- Si el prospecto es FRÍO o no califica, cierra amablemente: "Entiendo, si en algún momento cambia la situación aquí estaremos 😊"`
      });
      console.log(`🔄 Migrated agent "${agent.name}" to v2 instructions (autonomous closing)`);
    }
  }
}

migrate().catch(console.error);

// ── Sync account with real Instagram credentials from env ──────────────────────
// Fixes the "demo_ig_id" placeholder that the seed creates.
// Runs on every startup — safe to run multiple times (idempotent).
async function syncAccountFromEnv() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token || token === 'demo_token') return; // No real token → skip

  try {
    // Fetch real IG user ID from Meta Graph API
    const axios = require('axios');
    const res = await axios.get('https://graph.facebook.com/v19.0/me', {
      params: { fields: 'id,username', access_token: token }
    });
    const realIgId       = res.data.id;
    const realIgUsername = res.data.username || realIgId;

    if (!realIgId) return;

    // Check if we already have a properly linked account
    const linked = await db.findOne(db.accounts, { ig_user_id: realIgId });
    if (linked) {
      // Already linked — just refresh the token in case it was renewed
      await db.update(db.accounts, { ig_user_id: realIgId }, {
        access_token: token, ig_username: realIgUsername
      });
      console.log(`🔗 Account synced: @${realIgUsername} (${realIgId})`);
      return;
    }

    // Find ANY placeholder/demo account and update the first one found
    // Also handles: demo_ig_id_XXXX variants from duplicate seed runs
    const allAccounts = await db.find(db.accounts, {});
    const demoAccount = allAccounts.find(a =>
      !a.ig_user_id || a.ig_user_id.startsWith('demo') || a.ig_user_id.startsWith('tu.')
    );

    if (demoAccount) {
      await db.update(db.accounts, { _id: demoAccount._id }, {
        ig_user_id: realIgId,
        ig_username: realIgUsername,
        access_token: token
      });
      // Remove duplicate demo accounts if any
      const dupes = allAccounts.filter(a => a._id !== demoAccount._id &&
        (!a.ig_user_id || a.ig_user_id.startsWith('demo')));
      for (const dupe of dupes) {
        await db.remove(db.accounts, { _id: dupe._id });
        console.log(`🗑  Removed duplicate demo account: ${dupe._id}`);
      }
      console.log(`✅ Account linked to Instagram: @${realIgUsername} (${realIgId})`);
      return;
    }

    // No account at all? Shouldn't happen after seed, but just in case
    console.warn('⚠️  No account found to sync with Instagram credentials');
  } catch (e) {
    console.error('❌ syncAccountFromEnv error:', e.response?.data || e.message);
  }
}

syncAccountFromEnv().catch(console.error);

module.exports = db;
