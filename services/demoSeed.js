/**
 * Atinov — Cuenta demo para llamadas de venta
 *
 * Crea (o resetea) un usuario demo@atinov.com con una clínica dental
 * ficticia poblada de leads, conversaciones y calificaciones realistas —
 * para mostrar el dashboard en demos SIN exponer datos de clientes reales.
 *
 * Vertical dental a propósito: es el primer vertical del plan comercial
 * (Aurorix/Dentipilot validan la disposición a pagar en Chile).
 *
 * Idempotente: si el demo ya existe, borra los datos de su cuenta y
 * re-siembra. Nunca toca otras cuentas — todos los deletes filtran por
 * account_id del demo.
 */

const bcrypt = require('bcryptjs');
const db     = require('../db/database');

const DEMO_EMAIL = 'demo@atinov.com';

// hace N horas, como ISO — para que el briefing y el kanban se vean vivos
const haceHoras = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const LEADS_DEMO = [
  {
    nombre: 'Carolina Muñoz', canal: 'whatsapp', qual: 'hot', stage: 'calificado',
    reason: 'Pidió hora para evaluación de implante esta semana y preguntó formas de pago',
    memory: ['Busca: implante unitario, muela superior', 'Urgencia: dolor al masticar hace 2 semanas', 'Presupuesto: preguntó por cuotas — abierta a pagar con tarjeta', 'Disponibilidad: puede jueves o viernes por la tarde'],
    msgs: [
      { role: 'user', h: 26, text: 'Hola, quería saber cuánto sale un implante' },
      { role: 'agent', h: 26, text: 'Hola Carolina 😊 depende del caso, pero te cuento altiro cómo funciona. ¿Es por una pieza puntual o más de una?' },
      { role: 'user', h: 25, text: 'Una muela de arriba, me duele al masticar hace como 2 semanas' },
      { role: 'agent', h: 25, text: 'Uf, 2 semanas con dolor es harto. Lo primero es una evaluación con radiografía para ver si va implante o se puede rescatar la pieza. La evaluación cuesta $15.000 y se descuenta si sigues el tratamiento. ¿Te acomoda esta semana?' },
      { role: 'user', h: 3, text: 'Sí, ¿tienen hora el jueves o viernes en la tarde? ¿Y se puede pagar en cuotas?' },
      { role: 'agent', h: 3, text: 'Sí a las dos cosas: tenemos jueves 16:30 o viernes 15:00, y puedes pagar hasta en 12 cuotas con tarjeta. ¿Cuál te dejo?' },
    ],
  },
  {
    nombre: 'Rodrigo Pizarro', canal: 'whatsapp', qual: 'hot', stage: 'ganado', converted: true,
    deal: { value: 450000, currency: 'CLP' },
    reason: 'Confirmó tratamiento de ortodoncia invisible y pagó la primera cuota',
    memory: ['Tratamiento: ortodoncia invisible, apiñamiento leve', 'Motivación: se casa en noviembre', 'Cerrado: pagó primera cuota de $450.000'],
    msgs: [
      { role: 'user', h: 96, text: 'Hola! Vi en Instagram lo de la ortodoncia invisible, ¿sirve para apiñamiento?' },
      { role: 'agent', h: 96, text: 'Hola Rodrigo! Sí, el apiñamiento leve a moderado es justo el caso ideal. ¿Hace cuánto lo notas o te lo dijeron en algún control?' },
      { role: 'user', h: 95, text: 'Toda la vida jaja pero ahora me caso en noviembre y quiero llegar bien a las fotos' },
      { role: 'agent', h: 95, text: 'Jaja excelente motivo — y noviembre da justo para un caso leve. Te propongo evaluación con escáner 3D gratis esta semana y ahí te dicen plazo exacto y precio. ¿Te tinca?' },
      { role: 'user', h: 48, text: 'Ya fui a la evaluación, quedé en pagar la primera cuota hoy. ¿Me mandas los datos?' },
      { role: 'agent', h: 48, text: 'Buenísimo Rodrigo 🎉 te dejo el link de pago acá. Cualquier cosa me escribes. ¡A llegar impecable a noviembre!' },
    ],
  },
  {
    nombre: 'Fernanda Rojas', canal: 'instagram', qual: 'hot', stage: 'calificado',
    reason: 'Preguntó disponibilidad para blanqueamiento antes de un evento — urgencia real',
    memory: ['Busca: blanqueamiento', 'Urgencia: evento familiar en 10 días', 'Canal preferido: Instagram, responde rápido en la tarde'],
    msgs: [
      { role: 'user', h: 5, text: 'Holaa, ¿el blanqueamiento láser cuánto demora? Tengo un matrimonio en 10 días 😅' },
      { role: 'agent', h: 5, text: 'Hola Fernanda! Justo alcanza: son 1 o 2 sesiones de 45 min y el resultado se ve desde la primera. ¿Quieres que te reserve una evaluación express mañana para partir al tiro?' },
      { role: 'user', h: 4, text: 'Siii porfa, ¿en la tarde puede ser?' },
    ],
  },
  {
    nombre: 'Marcela Vega', canal: 'whatsapp', qual: 'warm', stage: 'contactado',
    reason: 'Interesada en ortodoncia para su hija, comparando precios con otra clínica',
    memory: ['Busca: ortodoncia para su hija de 14 años', 'Objeción: está comparando con otra clínica', 'Contexto: la hija usa frenillos removibles hace 1 año sin avance'],
    msgs: [
      { role: 'user', h: 30, text: 'Hola, ¿hacen ortodoncia para adolescentes? Mi hija tiene 14' },
      { role: 'agent', h: 30, text: 'Hola Marcela! Sí, es de lo que más hacemos. ¿Tu hija ya ha usado algún aparato o sería su primera evaluación?' },
      { role: 'user', h: 29, text: 'Usa removibles hace un año pero no le han hecho mucho efecto. Estoy viendo opciones, también cotizando en otra clínica' },
      { role: 'agent', h: 29, text: 'Hace bien en comparar — es un tratamiento largo y la confianza importa. Un dato útil para cualquier clínica que elijas: a los 14 con removibles sin avance, suele ser momento de fija. Si quieres, la evaluación acá es sin costo y te llevas el diagnóstico igual, decidas donde decidas.' },
    ],
  },
  {
    nombre: 'Jorge Salinas', canal: 'whatsapp', qual: 'warm', stage: 'contactado', media: 'audio',
    reason: 'Mandó audio consultando por prótesis para su padre — decisor indirecto',
    memory: ['Busca: prótesis para su papá de 78 años', 'Decisor: coordina él, paga entre hermanos', 'Restricción: el papá tiene movilidad reducida, preguntar por facilidad de acceso'],
    msgs: [
      { role: 'user', h: 8, media: 'audio', text: 'Hola, mira te cuento, es para mi papá, tiene 78 años y perdió varias piezas, queremos ver el tema de una prótesis pero él se mueve poco, ¿atienden gente mayor? ¿cómo es el acceso a la clínica?' },
      { role: 'agent', h: 8, text: 'Hola Jorge! Sí, atendemos hartos pacientes mayores. La clínica tiene acceso a nivel de calle, sin escaleras. Para prótesis lo ideal es una evaluación tranquila — ¿tu papá puede venir acompañado o prefieres que veamos primero opciones por acá con una foto de su situación actual?' },
    ],
  },
  {
    nombre: 'Valentina Soto', canal: 'instagram', qual: 'warm', stage: 'nuevo', media: 'image',
    reason: 'Mandó foto de su sonrisa preguntando por carillas',
    memory: ['Busca: carillas o diseño de sonrisa', 'Envió foto: diastema entre incisivos centrales', 'Sensible al precio: preguntó "más o menos cuánto" dos veces'],
    msgs: [
      { role: 'user', h: 12, media: 'image', text: '[El lead envió una FOTO. Lo que se ve: primer plano de una sonrisa con separación visible entre los dos incisivos centrales superiores (diastema), encías sanas, sin restauraciones visibles.]' },
      { role: 'user', h: 12, text: '¿Esto se puede arreglar con carillas? ¿más o menos cuánto sale?' },
      { role: 'agent', h: 12, text: 'Hola Valentina! Sí — por la foto, un diastema como el tuyo se resuelve súper bien con carillas o incluso con resina en una sesión, que es más económico. El precio exacto depende de cuál convenga: ¿te reservo una evaluación sin costo para darte el número real y no una adivinanza?' },
    ],
  },
  {
    nombre: 'Pablo Contreras', canal: 'whatsapp', qual: 'warm', stage: 'contactado',
    reason: 'Consultó por urgencia de fin de semana, quedó de confirmar',
    memory: ['Busca: atención por muela quebrada', 'Disponibilidad: solo sábados (trabaja fuera de la ciudad)'],
    msgs: [
      { role: 'user', h: 50, text: 'Hola, se me quebró una muela ayer, ¿atienden los sábados? Trabajo fuera toda la semana' },
      { role: 'agent', h: 50, text: 'Hola Pablo! Sí, sábado de 9 a 14. Una muela quebrada conviene verla luego para que no se infecte. ¿Te reservo este sábado a primera hora?' },
      { role: 'user', h: 49, text: 'Déjame confirmar y te aviso' },
      { role: 'agent', h: 26, text: 'Hola Pablo, ¿cómo sigue esa muela? Te guardo el cupo del sábado 9:00 hasta mañana por si lo quieres 😊', followup: true },
    ],
  },
  {
    nombre: 'Camila Herrera', canal: 'instagram', qual: 'cold', stage: 'nuevo',
    reason: 'Solo preguntó precio sin contexto y no volvió a responder',
    memory: [],
    msgs: [
      { role: 'user', h: 70, text: 'precio limpieza?' },
      { role: 'agent', h: 70, text: 'Hola Camila! La limpieza completa con ultrasonido está en $35.000. Si tienes previsión o convenio puede bajar — ¿tienes isapre o Fonasa?' },
    ],
  },
  {
    nombre: 'Andrés Fuentes', canal: 'whatsapp', qual: 'cold', stage: 'nuevo',
    reason: 'Revendedor de insumos dentales, no es paciente',
    memory: ['No es paciente: vende insumos dentales'],
    msgs: [
      { role: 'user', h: 90, text: 'Estimados, represento a DentalSupply SpA, ¿con quién puedo hablar por venta de insumos?' },
      { role: 'agent', h: 90, text: 'Hola Andrés! Este canal es de pacientes, pero te dejo el correo de administración para propuestas de proveedores: contacto@clinicademo.cl. ¡Éxito!' },
    ],
  },
  {
    nombre: 'Daniela Torres', canal: 'whatsapp', qual: null, stage: 'nuevo',
    reason: null,
    memory: [],
    msgs: [
      { role: 'user', h: 1, text: 'Hola! ¿Atienden con convenio de la empresa Minera del Norte?' },
      { role: 'agent', h: 1, text: 'Hola Daniela! Sí, tenemos convenio con varias empresas de la zona. ¿Me confirmas el nombre exacto que sale en tu credencial para verificarlo al tiro?' },
    ],
  },
];

async function seedDemo({ password }) {
  // 1. Usuario demo (crear o encontrar)
  let user = await db.findOne(db.users, { email: DEMO_EMAIL });
  const passHash = await bcrypt.hash(password, 12);

  let accountId;
  if (user) {
    accountId = user.account_id;
    await db.update(db.users, { _id: user._id }, { password_hash: passHash, onboardingCompleted: true, onboardingStep: 4 });
    // Limpiar datos anteriores de la cuenta demo (nunca otras cuentas).
    // messages no tiene account_id → primero se resuelven los lead_id del demo.
    const oldLeads = await db.find(db.leads, { account_id: accountId });
    if (oldLeads.length) {
      await db.remove(db.messages, { lead_id: { $in: oldLeads.map(l => l._id) } });
    }
    for (const store of ['leads', 'followups', 'knowledge', 'links', 'leadMagnets', 'agents']) {
      await db.remove(db[store], { account_id: accountId });
    }
  } else {
    const account = await db.insert(db.accounts, {
      name: 'Clínica Demo Sonrisa',
      ig_username: 'clinicademo.sonrisa',
      demo: true,
    });
    accountId = account._id;
    user = await db.insert(db.users, {
      email: DEMO_EMAIL,
      name: 'Cuenta Demo',
      password_hash: passHash,
      role: 'user',
      account_id: accountId,
      demo: true,
      membershipExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      // El revisor de Meta (y cualquier demo) entra directo al panel: sin el
      // asistente de bienvenida encima, que en una cuenta ya poblada no aporta.
      onboardingCompleted: true, onboardingStep: 4,
    });
    await db.insert(db.settings, { account_id: accountId, openai_key: '' });
  }

  // 2. Agente dental
  const agent = await db.insert(db.agents, {
    account_id: accountId,
    name: 'Recepcionista Sonrisa',
    avatar: '🦷',
    enabled: true,
    role: 'nurture',
    instructions: [
      'Eres la recepcionista virtual de Clínica Demo Sonrisa, en La Serena.',
      '',
      'CÓMO HABLAS: tuteo chileno cálido y natural, como una recepcionista con años en el rubro. Frases cortas. Nada de robot ni de formalidad acartonada. Un emoji ocasional, no en cada mensaje.',
      '',
      'TU OBJETIVO: que la persona termine con día y hora concretos para una evaluación. No sueltes el "avísame cuando puedas" — propón siempre dos alternativas de horario.',
      '',
      'CÓMO TRABAJAS:',
      '1. Primero entiendes el caso: qué le pasa, hace cuánto, si hay dolor. Una pregunta a la vez, no un interrogatorio.',
      '2. Con eso das el precio REFERENCIAL de la base de conocimiento y aclaras que el valor final lo define la evaluación.',
      '3. Cierras proponiendo horario.',
      '',
      'LÍMITES QUE NO CRUZAS:',
      '· Nunca diagnosticas por chat. Ante síntomas, el paso es evaluación presencial.',
      '· Nunca inventas precios, plazos ni convenios: si no está en tu conocimiento, dices que lo confirmas con el equipo.',
      '· Si hay dolor, priorizas: ofreces la hora más cercana.',
      '· Si comparan con otra clínica, no hablas mal de nadie: explicas qué incluye el precio y ofreces la evaluación.',
      '',
      '[CUENTA DEMO — datos ficticios para demostraciones y revisión]',
    ].join('\n'),
    link_ids: [],
    delay_min: 5, delay_max: 15,
  });

  // 3. Knowledge del demo.
  //
  // Cinco documentos, no uno. El probador en vivo (Agentes → el agente) es lo
  // que de verdad vende el producto: si el revisor o un prospecto le pregunta
  // "¿duele?", "¿puedo pagar en cuotas?" o "llego 20 min tarde, ¿alcanzo?",
  // el agente tiene que responder como una recepcionista de verdad. Con un
  // solo párrafo de precios contestaba en genérico y el motor no se lucía.
  const DOCS = [
    {
      title: 'Servicios y precios',
      content: [
        'PRECIOS REFERENCIALES (evaluación previa define el valor final):',
        '· Consulta de urgencia (dolor): $25.000, mismo día si hay cupo.',
        '· Limpieza + destartraje: $35.000. Dura 40 min.',
        '· Evaluación de implante (con radiografía): $15.000, se descuenta del tratamiento si continúa.',
        '· Implante unitario completo: desde $780.000 (incluye pilar y corona). 2 a 4 visitas en 4-6 meses.',
        '· Blanqueamiento láser: desde $120.000. 1 o 2 sesiones de 45 min; el resultado se ve desde la primera.',
        '· Carillas de porcelana: desde $180.000 por pieza. Mínimo recomendado 6 piezas para un resultado parejo.',
        '· Ortodoncia invisible: desde $1.890.000 todo incluido (escáner, alineadores, controles y retenedores).',
        '· Ortodoncia con brackets metálicos: desde $980.000. Controles mensuales incluidos.',
        '· Tapadura (resina): $38.000 por pieza. Endodoncia: desde $180.000.',
        'La evaluación con escáner 3D para ortodoncia es GRATIS y sin compromiso.',
      ].join('\n'),
    },
    {
      title: 'Horarios, ubicación y cómo llegar',
      content: [
        'Lunes a viernes 9:00 a 19:00. Sábados 9:00 a 14:00. Domingos cerrado.',
        'Dirección: Av. Francisco de Aguirre 234, oficina 3, La Serena.',
        'Acceso a nivel de calle, sin escaleras (apto para silla de ruedas y adultos mayores).',
        'Estacionamiento: hay públicos frente a la clínica ($1.500 la hora aprox).',
        'Urgencias fuera de horario: dejar mensaje por este mismo chat; se responde a primera hora.',
        'Tolerancia de atraso: 15 minutos. Pasados esos, se reagenda para no atrasar al resto.',
        'Cancelaciones: avisar con 24 h de anticipación. Sin aviso dos veces seguidas, la próxima hora se pide confirmada con abono.',
      ].join('\n'),
    },
    {
      title: 'Formas de pago, cuotas y convenios',
      content: [
        'Efectivo, débito, crédito y transferencia.',
        'Hasta 12 cuotas sin interés con tarjetas de crédito bancarias.',
        'Tratamientos sobre $500.000 se pueden pagar en cuotas mensuales directas con la clínica, sin banco: 30% al inicio y el saldo repartido en el plazo del tratamiento.',
        'CONVENIOS: Fonasa (bonificación en prestaciones codificadas) e Isapres con reembolso — se entrega boleta y detalle para que el paciente lo presente.',
        'Convenio con empresas de la zona: 15% de descuento presentando credencial.',
        'Boleta electrónica siempre. Presupuesto por escrito antes de empezar cualquier tratamiento: nunca se cobra algo que no se avisó antes.',
      ].join('\n'),
    },
    {
      title: 'Preguntas frecuentes de pacientes',
      content: [
        '¿DUELE? La evaluación no duele. En tratamientos se usa anestesia local; la mayoría describe molestia, no dolor. Para pacientes con miedo hay sedación consciente (se conversa en la evaluación).',
        '¿CUÁNTO DURA UN IMPLANTE? Con higiene y controles, más de 20 años. Garantía de la clínica: 5 años sobre el implante.',
        '¿EL BLANQUEAMIENTO DAÑA EL ESMALTE? No. Puede dar sensibilidad 24-48 h; se entrega gel desensibilizante incluido.',
        '¿CUÁNTO DURA EL BLANQUEAMIENTO? Entre 1 y 2 años según hábitos (café, té, cigarro).',
        '¿ATIENDEN NIÑOS? Sí, desde los 4 años. La primera visita es de reconocimiento y es gratis.',
        '¿EMBARAZADAS? Sí, la limpieza y las urgencias son seguras. Radiografías y tratamientos electivos se posponen al segundo trimestre o al postparto.',
        '¿PUEDO IR SOLO A COTIZAR? Sí, la evaluación no obliga a nada y el presupuesto queda por escrito.',
        'POSTOPERATORIO DE IMPLANTE: frío las primeras 24 h, comida blanda 3 días, sin fumar 1 semana. Control a los 7 días.',
      ].join('\n'),
    },
    {
      title: 'Cómo atiende la recepcionista (política de la clínica)',
      content: [
        'NUNCA diagnosticar por chat. Ante síntomas, el paso siempre es evaluación presencial.',
        'Ante dolor: priorizar. Ofrecer la hora más cercana disponible y, si no hay, dejar en lista de espera del día.',
        'Los precios se entregan siempre como REFERENCIALES y aclarando que el valor final lo define la evaluación.',
        'Si el paciente compara con otra clínica: no hablar mal de nadie. Explicar qué incluye el precio (materiales, controles, garantía) y ofrecer la evaluación gratis.',
        'Si el paciente dice que es caro: ofrecer las cuotas y el orden por prioridad (resolver primero lo urgente, lo estético después).',
        'Datos sensibles de salud: no pedir detalles clínicos por chat más allá de lo necesario para agendar.',
        'Cerrar siempre proponiendo día y hora concretos, no un "avísame cuando puedas".',
      ].join('\n'),
    },
  ];
  for (const d of DOCS) {
    await db.insert(db.knowledge, {
      account_id: accountId, agent_ids: [agent._id],
      is_main: d.title === 'Servicios y precios',
      title: `Clínica Demo Sonrisa — ${d.title}`,
      content: d.content,
    });
  }

  // 4. Leads + mensajes + follow-ups
  let created = 0;
  for (const L of LEADS_DEMO) {
    const isWa = L.canal === 'whatsapp';
    const idBase = `demo-${created}-${Date.now()}`;
    const lead = await db.insert(db.leads, {
      account_id: accountId,
      agent_id: agent._id,
      ig_user_id: idBase,
      ig_username: L.nombre,
      ...(isWa ? { wa_id: `569${String(10000000 + created)}`, wa_name: L.nombre } : {}),
      channel: L.canal,
      status: 'active', automation: 'automated',
      is_bypassed: false,
      is_converted: !!L.converted,
      pipeline_stage: L.stage,
      qualification: L.qual,
      qualification_reason: L.reason,
      ...(L.deal ? { deal_value: L.deal.value, deal_currency: L.deal.currency } : {}),
      memory_facts: L.memory,
      memory_updated_at: L.memory.length ? haceHoras(2) : null,
      last_message_at: haceHoras(L.msgs[L.msgs.length - 1].h),
      createdAt: haceHoras(L.msgs[0].h + 1),
      demo: true,
    });
    for (const m of L.msgs) {
      await db.insert(db.messages, {
        lead_id: lead._id,
        role: m.role,
        content: m.text,
        ...(m.media ? { media: m.media } : {}),
        ...(m.followup ? { is_followup: true, followup_num: 1 } : {}),
        createdAt: haceHoras(m.h),
      });
      if (m.followup) {
        await db.insert(db.followups, {
          lead_id: lead._id, account_id: accountId, agent_id: agent._id,
          attempt_num: 1, scheduled_for: haceHoras(m.h), sent_at: haceHoras(m.h), cancelled: false,
        });
      }
    }
    created++;
  }

  // 5. Una llamada telefónica de muestra (terminada) sobre el lead caliente:
  //    así el revisor de Meta y las llamadas de venta ven el dashboard de
  //    gasto de voz con datos y la nota 📞 en el hilo — sin haber marcado a
  //    nadie. Se limpia junto con el resto al resetear.
  try {
    await db.remove(db.llamadas, { account_id: accountId });
    const caliente = await db.findOne(db.leads, { account_id: accountId, qualification: 'hot', channel: 'whatsapp' });
    if (caliente) {
      const hoyCL = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
      await db.insert(db.llamadas, {
        account_id: accountId, lead_id: caliente._id, agent_id: agent._id,
        status: 'terminada', via: 'telefono', telefono: '+56912345678',
        tema: 'resolver si el tratamiento le sirve y dejar la hora tomada',
        fecha_chile: hoyCL, dial_at: haceHoras(2), answered_at: haceHoras(2), ended_at: haceHoras(2),
        duracion_seg: 187, max_min: 10,
        costo_usd: { minutos: 4, twilio: 0.2984, openai_est: 0.16, total_est: 0.4584 },
        consent_texto: 'ya po, llámame no más', consent_at: haceHoras(2),
        transcript: [
          { quien: 'agente', texto: 'Hola Carolina, soy la recepcionista de Sonrisa, te dije por el chat que te llamaba. ¿Puedes hablar un minutito?', t: 0 },
          { quien: 'lead', texto: 'Sí, dime.', t: 0 },
          { quien: 'agente', texto: 'Quedamos en lo del implante. Te propongo la evaluación con radiografía el jueves a las cuatro y media, y ahí te dicen si va implante o se rescata la pieza. ¿Te la dejo tomada?', t: 0 },
          { quien: 'lead', texto: 'Ya, el jueves está perfecto.', t: 0 },
          { quien: 'agente', texto: 'Listo, jueves cuatro y media. Te llega la confirmación por el chat. ¡Nos vemos!', t: 0 },
        ],
        finalized_at: haceHoras(2), ws_lock: 'demo', demo: true,
      });
      await db.insert(db.messages, {
        lead_id: caliente._id, account_id: accountId, role: 'sistema',
        content: '📞 Llamada realizada (3m 07s, ~US$0.46). Último tramo: la lead confirmó la evaluación del jueves 16:30.',
        createdAt: haceHoras(2),
      });
    }
  } catch (e) { console.warn('[demo] llamada de muestra no creada:', e.message); }

  return { ok: true, email: DEMO_EMAIL, accountId, leads: created };
}

/**
 * Paquete listo para pegar en el formulario de App Review de Meta: las
 * credenciales del revisor + los pasos en inglés para que llegue a cada
 * pantalla que prueba cada permiso. La contraseña la pasa el caller (solo
 * se conoce en el momento de crear/resetear el demo).
 */
function instruccionesRevisor({ password, appUrl }) {
  const base = (appUrl || process.env.APP_URL || 'https://atinov.com').replace(/\/$/, '');
  return [
    `TEST CREDENTIALS`,
    `URL: ${base}/app`,
    `Email: ${DEMO_EMAIL}`,
    `Password: ${password}`,
    ``,
    `HOW TO REVIEW (the account is pre-loaded with realistic sample conversations; no real customer data):`,
    `1) Log in at ${base}/app with the credentials above — or simply click "Ver la cuenta demo (sin registro)" on the login screen (no typing needed).`,
    `2) INBOX (left menu "Inbox"): open any conversation to see the AI assistant replying to Instagram / WhatsApp messages on behalf of the business (instagram_business_manage_messages, whatsapp_business_messaging, pages_messaging). Voice notes and photos from customers are understood and answered.`,
    `3) TEMPLATES (left menu "Plantillas"): create, list with approval status, and delete the business's WhatsApp message templates (whatsapp_business_management).`,
    `4) COMMENTS (left menu "Comentarios"): per-post keyword rules — a public reply plus a private message to the commenter (instagram_business_manage_comments).`,
    `5) SETTINGS (left menu "Ajustes"): the connected Instagram account, WhatsApp number and Facebook Page; the "Connect" buttons use Meta's official login dialogs; disconnect is one click.`,
    `6) ANALYTICS: qualification, conversion and — under "Gasto de voz" — the phone calls the assistant made with the customer's prior consent.`,
    `Data deletion instructions: ${base}/data-deletion · Privacy: ${base}/privacy · Terms: ${base}/terms`,
  ].join('\n');
}

module.exports = { seedDemo, DEMO_EMAIL, instruccionesRevisor };
