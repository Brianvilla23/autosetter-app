const Datastore = require('@seald-io/nedb');
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── DB PATH ──────────────────────────────────────────────────────────────────
// CRITICO en producción: Railway containers son EFÍMEROS. Sin volumen montado,
// cada deploy/restart pierde TODOS los datos (users, leads, msgs, suscripciones).
//
// Configurá un Railway Volume montado en /data y seteá:
//     DB_PATH=/data
// en las variables de entorno. Local dev cae al fallback ./db/data automáticamente.

// Startup check: en producción, DB_PATH es OBLIGATORIO. Sin él, los datos se
// pierden en cada deploy y la app efectivamente no es operable. Fail fast.
if (process.env.NODE_ENV === 'production' && !process.env.DB_PATH) {
  console.error('❌ FATAL: DB_PATH no configurado en producción. Datos serían efímeros (se borran en cada deploy de Railway). Configurá un Volume montado y seteá DB_PATH=/data. Abortando.');
  process.exit(1);
}

const dir = process.env.DB_PATH || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });

// Marker para distinguir entornos (lo expone el healthcheck)
const isPersistent = !!process.env.DB_PATH;
if (isPersistent) {
  console.log(`📦 DB persistente en ${dir}`);
} else {
  console.warn(`⚠️  DB en path EFÍMERO (${dir}). Configurá DB_PATH a un Railway Volume para no perder datos en cada deploy.`);
}

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
  pendingSends:  new Datastore({ filename: path.join(dir, 'pendingSends.db'),  autoload: true }),
  failedSends:   new Datastore({ filename: path.join(dir, 'failedSends.db'),   autoload: true }),
  aiUsage:       new Datastore({ filename: path.join(dir, 'aiUsage.db'),       autoload: true }),
  auditLog:      new Datastore({ filename: path.join(dir, 'auditLog.db'),      autoload: true }),
  followups:     new Datastore({ filename: path.join(dir, 'followups.db'),     autoload: true }),
  magnetLinks:   new Datastore({ filename: path.join(dir, 'magnetLinks.db'),   autoload: true }),
  linkClicks:    new Datastore({ filename: path.join(dir, 'linkClicks.db'),    autoload: true }),
  emailLog:      new Datastore({ filename: path.join(dir, 'emailLog.db'),      autoload: true }),
  leadMagnets:   new Datastore({ filename: path.join(dir, 'leadMagnets.db'),   autoload: true }),
  magnetDeliveries: new Datastore({ filename: path.join(dir, 'magnetDeliveries.db'), autoload: true }),
  errorLog:      new Datastore({ filename: path.join(dir, 'errorLog.db'),      autoload: true }),
  referrals:     new Datastore({ filename: path.join(dir, 'referrals.db'),     autoload: true }),
  quickReplies:  new Datastore({ filename: path.join(dir, 'quickReplies.db'),  autoload: true }),
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

// ── Migración 2026-05-03: resetear planes LS legacy a 'founder' demo ─────────
// Tras el rechazo de Lemon Squeezy (2026-05-01) cualquier usuario con
// paymentProvider='ls' tiene una suscripción que ya no es cobrable.
// Hasta que tengamos Polar/MP activo, los pasamos a plan='founder' con
// status='demo' para que vean el pricing nuevo y la UI no muestre $297
// huérfanos. Cuando se conecte un procesador real, el flow normal
// /api/billing/checkout reasigna el provider correctamente.
async function migrateLegacyLSPlans() {
  try {
    const users = await db.find(db.users, {});
    let migrated = 0;
    for (const u of users) {
      // Solo cuentas con LS activo. Admins/founders ya marcados como
      // 'admin' o 'founder' los dejamos.
      if (u.paymentProvider !== 'ls') continue;
      if (u.membershipPlan === 'founder' || u.membershipPlan === 'admin') continue;
      if (u.ls_migrated_to_founder_at) continue; // ya migrado

      await db.update(db.users, { _id: u._id }, {
        membershipPlan:               'founder',
        paymentProvider:              null,
        subscriptionStatus:           'demo',
        ls_subscription_id_legacy:    u.ls_subscription_id || null, // preservar para auditoría
        ls_migrated_to_founder_at:    new Date().toISOString(),
        ls_migrated_from_plan:        u.membershipPlan,
      });
      migrated++;
      console.log(`🔄 Migración post-LS-rejection: ${u.email || u._id} pasó de ${u.membershipPlan}/ls → founder/demo`);
    }
    if (migrated) {
      console.log(`✅ migrateLegacyLSPlans: ${migrated} cuenta(s) migrada(s) a founder demo`);
    }
  } catch (e) {
    console.error('migrateLegacyLSPlans error:', e.message);
  }
}

migrateLegacyLSPlans().catch(console.error);

// syncAccountFromEnv removed — account is properly linked via Instagram Business Login OAuth.
// The OAuth flow in routes/auth.js stores ig_user_id, ig_platform_id and access_token in DB.
// Using META_ACCESS_TOKEN env var with graph.facebook.com is incompatible with IGAA tokens.

// Metadata para healthcheck/admin (qué path usa, si es persistente)
db._meta = { dir, isPersistent };

module.exports = db;
