/**
 * Atinov — Planes y límites
 *
 * Fuente única de verdad para lo que cada plan puede hacer.
 * Cambiar AQUÍ = cambia en toda la app.
 *
 * Estructura:
 * - maxDMs: conversaciones/mes en TODOS los canales. Sobre el tope se cobra
 *   overage por conversación ($overagePerDM USD).
 * - maxDMsWhatsApp: cuota SEPARADA de WhatsApp. Existe por una razón dura de
 *   costo, no de producto: desde el 1-oct-2026 Meta cobra cada mensaje de
 *   servicio que sale por WhatsApp (US$0,02 en Chile). Con ~12 mensajes por
 *   conversación, una conversación de WhatsApp cuesta ~US$0,27 y una de
 *   Instagram o Messenger cuesta ~US$0,03 — nueve veces menos, porque Meta
 *   no cobra esos canales. Un contador único trataría como iguales dos cosas
 *   que difieren 9x, y el cliente compra esto justamente para WhatsApp.
 * - minutosLlamada: bolsa mensual de minutos de llamada con IA. El minuto
 *   cuesta ~US$0,115 (Twilio US$0,0746 + OpenAI Realtime ~US$0,04).
 * - features.llamadas: la llamada telefónica es el diferenciador del tramo
 *   medio hacia arriba. El plan de entrada NO la trae, a propósito.
 * - features: dict de booleans que apaga/prende secciones específicas.
 *   El frontend lo lee desde /api/usage para mostrar el lock UI.
 *
 * UNLIMITED ya no existe como concepto — siempre hay un techo, y arriba
 * del techo se cobra overage. Es más honesto y sostenible.
 *
 * Los precios son NETOS en USD. El IVA chileno (19%) lo agrega el checkout.
 */

/** Costos unitarios reales, para calcular márgenes y overage sin adivinar. */
const COSTOS = {
  metaMensajeServicio: 0.02,   // US$/mensaje WhatsApp (Chile, desde 1-oct-2026)
  mensajesPorConv:     12,     // medido: conversación de calificación + follow-ups
  // Derivado de gpt-4o-mini (el modelo por defecto): ~3.000 tokens de prompt
  // y ~150 de salida por respuesta = US$0,00054, por 12 respuestas = US$0,0065,
  // x2 por las llamadas auxiliares (score, resumen, embeddings, transcripción).
  // ⚠️ ES EL NÚMERO MENOS VERIFICADO Y EL QUE MÁS PESA EN LOS PLANES ALTOS.
  // Se mide de verdad con db.aiUsage, que guarda promptTokens/completionTokens
  // y model por llamada. Si OPENAI_USE_REASONING manda tráfico al modelo de
  // razonamiento, este número sube y hay que rehacerlo.
  llmPorConv:          0.013,
  twilioMinuto:        0.0746, // saliente a celular chileno
  realtimeMinuto:      0.04,   // OpenAI Realtime, punto medio de 0,02-0,06
  numeroMes:           7.00,   // arriendo del número (fijo, no por uso)
};

/** Lo que cuesta de verdad una conversación, según el canal por el que entra. */
const COSTO_CONV_WHATSAPP = COSTOS.metaMensajeServicio * COSTOS.mensajesPorConv + COSTOS.llmPorConv; // ~0,27
const COSTO_CONV_META     = COSTOS.llmPorConv;                                                       // ~0,03
const COSTO_MINUTO_LLAMADA = COSTOS.twilioMinuto + COSTOS.realtimeMinuto;                            // ~0,115

const PLANS = {
  trial: {
    id:          'trial',
    name:        'Trial',
    price:       0,
    priceCLP:    0,
    maxAccounts: 1,
    maxAgents:   1,
    maxDMs:      200,       // Conservador durante trial
    maxDMsWhatsApp: 50,
    minutosLlamada: 0,
    maxMagnets:  1,
    overagePerDM: null,     // No hay overage en trial: si llega al tope, se corta
    features: {
      followups:        false,
      leadMagnets:      false,
      qualification:    false,   // HOT/WARM/COLD automático
      webhook:          false,
      inboxTakeControl: true,    // tomar control sí (es básico)
      multiAccount:     false,
      whiteLabel:       false,
      multiUser:        false,
      apiAccess:        false,
      prioritySupport:  false,
      llamadas:         false,
    },
  },

  // ══ LOS TRES PLANES QUE SE VENDEN ════════════════════════════════════════
  // La escalera está diseñada para que el tramo de entrada deje ganas de
  // subir: trae el producto completo MENOS la llamada telefónica. Quien
  // quiere que el agente marque al lead caliente tiene que pasar a
  // Crecimiento, que es el plan robusto y donde debería quedarse la mayoría.

  inicial: {
    id:          'inicial',
    name:        'Inicial',
    price:       98,            // USD/mes neto (+IVA)
    priceCLP:    93000,
    maxAccounts: 1,
    maxAgents:   2,
    maxDMs:      1500,          // total, todos los canales
    maxDMsWhatsApp: 90,         // dimensionada para 55% de margen a uso pleno
    minutosLlamada: 0,          // sin llamadas: es la razón para subir
    maxMagnets:  3,
    overagePerDM: 0.50,         // cuesta 0,27 → 46% de margen
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,   // el score es el corazón del producto: va en todos
      webhook:          false,
      inboxTakeControl: true,
      multiAccount:     false,
      whiteLabel:       false,
      multiUser:        false,
      apiAccess:        false,
      prioritySupport:  false,
      llamadas:         false,  // ← el candado
    },
  },

  crecimiento: {
    id:          'crecimiento',
    name:        'Crecimiento',
    price:       275,
    priceCLP:    261000,
    maxAccounts: 3,
    maxAgents:   5,
    maxDMs:      3000,
    maxDMsWhatsApp: 150,
    minutosLlamada: 150,        // ~37 llamadas de 4 min
    maxMagnets:  10,
    overagePerDM: 0.50,
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       false,
      multiUser:        true,
      apiAccess:        true,
      prioritySupport:  true,
      llamadas:         true,   // ← lo que se compra al subir
    },
  },

  escala: {
    id:          'escala',
    name:        'Escala',
    price:       498,
    priceCLP:    473000,
    maxAccounts: 10,
    maxAgents:   10,
    maxDMs:      5600,
    // 200 y no más: cada conversación de WhatsApp cuesta ~US$0,27 y con 300 se
    // comía el presupuesto del tramo, dejando a Escala casi pegado a
    // Crecimiento en volumen. Bajarla es lo que abre la diferencia entre ambos.
    maxDMsWhatsApp: 200,
    minutosLlamada: 400,        // ~100 llamadas
    maxMagnets:  30,
    overagePerDM: 0.50,
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       true,
      multiUser:        true,
      apiAccess:        true,
      prioritySupport:  true,
      llamadas:         true,
    },
  },

  // ── PLAN A MEDIDA ─────────────────────────────────────────────────────────
  // Para el cliente que se sale de Escala. No tiene cuotas fijas: se cotizan
  // con precioAMedida() y se guardan en el propio usuario (custom_maxDMs,
  // custom_maxDMsWhatsApp, custom_minutosLlamada), que getPlanFor() superpone.
  //
  // Sin cuotas guardadas cae a los límites de Escala — nunca a algo mayor de
  // lo que se cobró. Fail-closed: cotizar de más es un problema comercial,
  // regalar capacidad es una pérdida.
  medida: {
    id:          'medida',
    name:        'A medida',
    price:       null,          // se fija por cliente al cotizar
    priceCLP:    null,
    maxAccounts: 25,
    maxAgents:   25,
    maxDMs:      5600,          // piso = Escala, hasta que se cargue la cotización
    maxDMsWhatsApp: 200,
    minutosLlamada: 400,
    maxMagnets:  50,
    overagePerDM: 0.50,
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       true,
      multiUser:        true,
      apiAccess:        true,
      prioritySupport:  true,
      llamadas:         true,
    },
  },

  // ── PLANES HEREDADOS — NO SE VENDEN ───────────────────────────────────────
  // Founder (US$148) fue el plan único hasta que se armó la escalera de tres
  // tramos. Nunca llegó a cobrarse: no hubo procesador de pagos conectado, así
  // que no hay nadie con precio congelado que respetar. Se conserva SOLO porque
  // la migración post-Lemon-Squeezy de db/database.js dejó cuentas en
  // membershipPlan='founder', y sacarlo de esta lista las haría caer a trial.
  //
  // Faltaba en esta lista, y eso NO era teórico: la migración post-Lemon
  // Squeezy de db/database.js ya dejó cuentas reales con
  // membershipPlan='founder' desde el 2026-05-03. Como getPlanFor() hace
  // `PLANS[key] || PLANS.trial`, esas cuentas caían a TRIAL — 200 DMs, sin
  // calificación, sin follow-ups, sin lead magnets. Es decir: el plan que se
  // cobra entregaba los límites del plan gratis.
  //
  // starter/pro/agency de más abajo son LEGACY: no se venden desde el rebrand
  // (2026-05-09). Se dejan para no romper cuentas viejas que aún los tengan.
  founder: {
    id:          'founder',
    name:        'Founder',
    price:       148,           // USD/mes — precio fundador, congelado de por vida
    priceCLP:    135000,        // debe calzar con MP_PRICE_FOUNDER_CLP (routes/billing.js)
    maxAccounts: 3,
    maxAgents:   5,
    maxDMs:      6000,          // "6.000 conversaciones/mes" de la landing
    maxDMsWhatsApp: null,   // heredado: sin cuota separada
    minutosLlamada: 200,
    maxMagnets:  10,
    overagePerDM: 0.50,         // alineado al costo real de octubre (US$0,27)
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       false,  // el white-label es del plan de agencias
      multiUser:        true,
      apiAccess:        true,
      llamadas:         true,
      prioritySupport:  true,   // "contacto directo con el fundador" es parte de la oferta
    },
  },
  starter: {
    id:          'starter',
    name:        'Starter',
    price:       197,           // USD/mes
    priceCLP:    180000,
    maxAccounts: 1,
    maxAgents:   1,             // 1 agente — diferenciador claro vs Pro
    maxDMs:      1500,
    maxDMsWhatsApp: null,
    minutosLlamada: 0,
    maxMagnets:  1,
    overagePerDM: null,         // Starter no permite overage, sube de plan
    features: {
      followups:        false,  // BLOQUEADO — upgrade a Pro
      leadMagnets:      false,  // BLOQUEADO — upgrade a Pro
      qualification:    false,  // BLOQUEADO — upgrade a Pro
      webhook:          false,  // BLOQUEADO
      inboxTakeControl: true,
      multiAccount:     false,
      whiteLabel:       false,
      multiUser:        false,
      apiAccess:        false,
      llamadas:         false,
      prioritySupport:  false,
    },
  },
  pro: {
    id:          'pro',
    name:        'Pro',
    price:       297,           // USD/mes
    priceCLP:    270000,
    maxAccounts: 3,
    maxAgents:   5,             // 5 agentes (no ilimitado)
    maxDMs:      6000,          // 6,000 DMs/mes (NO ilimitado)
    maxDMsWhatsApp: null,
    minutosLlamada: 200,
    maxMagnets:  10,
    overagePerDM: 0.025,        // $0.025 por DM extra ($25 / 1000 DMs)
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       false,  // BLOQUEADO — upgrade a Agency
      multiUser:        false,  // BLOQUEADO — upgrade a Agency
      apiAccess:        false,  // BLOQUEADO — upgrade a Agency
      llamadas:         true,
      prioritySupport:  true,
    },
  },
  agency: {
    id:          'agency',
    name:        'Agency',
    price:       497,           // USD/mes
    priceCLP:    450000,
    maxAccounts: 10,
    maxAgents:   20,            // 20 agentes
    maxDMs:      25000,         // 25,000 DMs/mes (NO ilimitado)
    maxDMsWhatsApp: null,
    minutosLlamada: 500,
    maxMagnets:  50,
    overagePerDM: 0.015,        // $0.015 por DM extra (más barato que Pro)
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       true,
      multiUser:        true,
      apiAccess:        true,
      llamadas:         true,
      prioritySupport:  true,
    },
  },
  // Admins tienen acceso total y sin límites — sólo equipo interno
  admin: {
    id:          'admin',
    name:        'Admin',
    price:       0,
    priceCLP:    0,
    maxAccounts: Infinity,
    maxAgents:   Infinity,
    maxDMs:      Infinity,
    maxDMsWhatsApp: Infinity,
    minutosLlamada: Infinity,
    maxMagnets:  Infinity,
    overagePerDM: 0,
    features: {
      followups:        true,
      leadMagnets:      true,
      qualification:    true,
      webhook:          true,
      inboxTakeControl: true,
      multiAccount:     true,
      whiteLabel:       true,
      multiUser:        true,
      apiAccess:        true,
      llamadas:         true,
      prioritySupport:  true,
    },
  },
};

/**
 * Devuelve el plan efectivo de un usuario.
 * Fallback: si no hay plan o no está en la lista → trial.
 *
 * Retorna el plan con shim retrocompat: `followups` y `webhook` directos
 * (codigo viejo) reflejan `features.followups` / `features.webhook`.
 */
function getPlanFor(user) {
  let plan;
  if (!user)                     plan = PLANS.trial;
  else if (user.role === 'admin') plan = PLANS.admin;
  else {
    const key = (user.membershipPlan || 'trial').toLowerCase();
    plan = PLANS[key] || PLANS.trial;
    // El plan a medida no tiene cuotas propias: son las que se cotizaron y se
    // guardaron en el usuario. Sin ellas queda con las de Escala, nunca más.
    if (plan.id === 'medida') {
      const sobre = {};
      for (const [campo, guardado] of [
        ['maxDMs', 'custom_maxDMs'],
        ['maxDMsWhatsApp', 'custom_maxDMsWhatsApp'],
        ['minutosLlamada', 'custom_minutosLlamada'],
        ['maxAgents', 'custom_maxAgents'],
        ['maxAccounts', 'custom_maxAccounts'],
      ]) {
        const v = Number(user[guardado]);
        if (Number.isFinite(v) && v > 0) sobre[campo] = v;
      }
      const precio = Number(user.custom_price);
      if (Number.isFinite(precio) && precio > 0) sobre.price = precio;
      plan = { ...plan, ...sobre };
    }
  }
  // Backward compat: plan.followups / plan.webhook como flags top-level
  return {
    ...plan,
    followups: !!plan.features?.followups,
    webhook:   !!plan.features?.webhook,
  };
}

/**
 * Verifica si una feature específica está disponible en el plan del user.
 * Uso: hasFeature(user, 'followups') → true/false
 */
function hasFeature(user, featureKey) {
  const plan = getPlanFor(user);
  return !!(plan.features && plan.features[featureKey]);
}

/**
 * Calcula el costo de overage para un usuario que pasó su límite de DMs.
 * Devuelve { extraDMs, costUSD, perDM } o null si su plan no permite overage.
 */
function calculateOverage(user, currentDMs) {
  const plan = getPlanFor(user);
  if (!plan.overagePerDM) return null;
  const extraDMs = Math.max(0, currentDMs - plan.maxDMs);
  return {
    extraDMs,
    perDM:   plan.overagePerDM,
    costUSD: +(extraDMs * plan.overagePerDM).toFixed(2),
  };
}

/**
 * Precio de venta de un minuto extra de llamada, pasada la bolsa del plan.
 * Cuesta ~US$0,115. A US$0,30 el margen es 62% y queda en línea con el
 * mercado español de voz (Recepio y Recepcionista.com cobran €0,25/min).
 */
const PRECIO_MINUTO_EXTRA = 0.30;

/**
 * Qué le cuesta a Atinov servir un plan si el cliente lo usa COMPLETO: su
 * cuota de WhatsApp, el resto de conversaciones por los canales gratis, y la
 * bolsa de minutos entera. Es el peor caso, no el esperado.
 *
 * Sirve para no volver a fijar un precio a ojo: si el margen de un plan cae,
 * se ve acá y no seis meses después en la cuenta bancaria.
 */
function costoPlan(planId) {
  const plan = PLANS[String(planId || '').toLowerCase()];
  // Un plan sin precio (trial, admin) no tiene margen que calcular.
  if (!plan || !Number.isFinite(plan.price) || plan.price <= 0) return null;

  const convWa   = Number.isFinite(plan.maxDMsWhatsApp) ? plan.maxDMsWhatsApp : 0;
  const convMeta = Number.isFinite(plan.maxDMs) ? Math.max(0, plan.maxDMs - convWa) : 0;
  const minutos  = Number.isFinite(plan.minutosLlamada) ? plan.minutosLlamada : 0;

  const whatsapp = convWa * COSTO_CONV_WHATSAPP;
  const meta     = convMeta * COSTO_CONV_META;
  const llamadas = minutos * COSTO_MINUTO_LLAMADA;
  // El número de Twilio solo se arrienda si el plan puede llamar.
  const numero   = plan.features && plan.features.llamadas ? COSTOS.numeroMes : 0;
  const total    = whatsapp + meta + llamadas + numero;

  return {
    precio:    plan.price,
    whatsapp:  +whatsapp.toFixed(2),
    meta:      +meta.toFixed(2),
    llamadas:  +llamadas.toFixed(2),
    numero:    +numero.toFixed(2),
    total:     +total.toFixed(2),
    margen:    +(plan.price - total).toFixed(2),
    margenPct: plan.price ? +(((plan.price - total) / plan.price) * 100).toFixed(1) : 0,
  };
}

/**
 * Estado de la cuota de WhatsApp del mes. Devuelve null en los planes
 * heredados, que no tienen cuota separada de canal.
 */
function cuotaWhatsApp(user, usadasWhatsApp = 0) {
  const plan = getPlanFor(user);
  const tope = plan.maxDMsWhatsApp;
  if (tope === null || tope === undefined) return null;
  const usadas = Math.max(0, Number(usadasWhatsApp) || 0);
  const extra  = Math.max(0, usadas - tope);
  return {
    tope,
    usadas,
    restantes: Number.isFinite(tope) ? Math.max(0, tope - usadas) : Infinity,
    excedidas: extra,
    costoExtraUSD: plan.overagePerDM ? +(extra * plan.overagePerDM).toFixed(2) : 0,
  };
}

/** Margen objetivo del tramo más alto; el plan a medida lo respeta. */
const MARGEN_A_MEDIDA = 0.65;

/** Piso del plan a medida: por debajo, el cliente debería ir a Escala. */
const PISO_A_MEDIDA = 698;

/**
 * Cotiza un plan a medida a partir de lo que el cliente pide.
 *
 * No es una opinión: toma el costo real de servir esa capacidad y le aplica el
 * mismo margen que Escala. Así el tramo de arriba nunca sale más barato en
 * proporción que el de abajo — que era justamente el problema de la escalera
 * anterior, donde a mayor cliente el negocio ganaba proporcionalmente menos.
 *
 * @param {{conversaciones:number, whatsapp:number, minutos:number}} pedido
 * @returns {{costo:number, precio:number, margen:number, margenPct:number, piso:boolean}}
 */
function precioAMedida({ conversaciones = 0, whatsapp = 0, minutos = 0 } = {}) {
  const conv = Math.max(0, Number(conversaciones) || 0);
  const wa   = Math.min(Math.max(0, Number(whatsapp) || 0), conv);
  const min  = Math.max(0, Number(minutos) || 0);

  const costo = wa * COSTO_CONV_WHATSAPP
              + (conv - wa) * COSTO_CONV_META
              + min * COSTO_MINUTO_LLAMADA
              + (min > 0 ? COSTOS.numeroMes : 0);

  const calculado = costo / (1 - MARGEN_A_MEDIDA);
  const precio    = Math.max(PISO_A_MEDIDA, Math.ceil(calculado));

  return {
    costo:     +costo.toFixed(2),
    precio,
    margen:    +(precio - costo).toFixed(2),
    margenPct: +(((precio - costo) / precio) * 100).toFixed(1),
    piso:      calculado < PISO_A_MEDIDA,
  };
}

module.exports = {
  PLANS, getPlanFor, hasFeature, calculateOverage, cuotaWhatsApp, costoPlan,
  COSTOS, COSTO_CONV_WHATSAPP, COSTO_CONV_META, COSTO_MINUTO_LLAMADA,
  PRECIO_MINUTO_EXTRA, precioAMedida, MARGEN_A_MEDIDA, PISO_A_MEDIDA,
  UNLIMITED: Infinity,
};

