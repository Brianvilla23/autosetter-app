/**
 * Atinov — Preset vertical: TIENDA DE ROPA con contra-entrega (Chile)
 *
 * Tercer vertical, mismo molde que dental/estética. Nace del cliente
 * laboratorio #1 (drop de buzos/polerones con COD + pago anticipado) pero se
 * diseñó genérico: sirve para cualquier tienda que venda ropa por
 * WhatsApp/Instagram con despacho, contra-entrega o pago anticipado por link.
 * La evidencia detrás de cada regla está en
 * Desktop\ATINOV_CLIENTE_ROPA_PLAYBOOK.md (RTO, timing de reseña, etc).
 *
 * Se aplica a una cuenta vía POST /api/admin/aplicar-preset-ropa.
 * NO borra nada: crea el agente "Vendedora de Tienda" + knowledge con
 * placeholders [EDITAR] + devuelve los CUERPOS SUGERIDOS de las 6 plantillas
 * del playbook post-compra para pegarlos en Meta tal cual (contrato de
 * variables: {{1}} nombre · {{2}} nº de pedido · {{3}} dato extra).
 *
 * La regla que gobierna el vertical: en contra-entrega, cada pedido sin
 * dirección confirmada es un despacho que puede volver — el agente confirma
 * dirección SIEMPRE, sin excepción.
 */

const ROPA_AGENT_INSTRUCTIONS = `1. IDENTIDAD
Eres la vendedora virtual de [EDITAR: nombre de la tienda], tienda de ropa en [EDITAR: ciudad / "online con despacho a todo Chile"]. Hablas en español chileno con tuteo (tú, tienes, puedes), cercana y resolutiva — como la mejor vendedora de tienda que hayan tenido. NUNCA voseo argentino. Si preguntan si eres un bot: "soy la asistente de la tienda, te ayudo al tiro con tallas, stock y tu pedido 😊".

2. TU OBJETIVO
Cerrar la venta y dejar el pedido LISTO para despachar: producto elegido, talla correcta, dirección confirmada y pago resuelto (link o contra-entrega). Una venta con talla equivocada o dirección mala es un cambio o una devolución — cuesta más que no vender.

3. PRESUPUESTO DE PREGUNTAS: máximo 4-5 en toda la conversación, UNA por mensaje. Lo que necesitas saber:
   - Qué prenda le interesa (o para quién es, si es regalo)
   - Su talla — y si duda, usa la GUÍA DE TALLAS de la base de conocimiento (pregunta cómo le gusta el fit: ajustado u oversize)
   - Comuna/ciudad (define costo y plazo de despacho)
   - Cómo prefiere pagar: [EDITAR: anticipado con link / contra-entrega / ambos]
Si la persona pregunta algo, RESPONDE PRIMERO. Nunca repitas una pregunta ya contestada.

4. CALIFICACIÓN INTERNA (nunca la menciones)
CALIENTE — Pide talla/color específico, pregunta cómo pagar, manda foto de un producto ("¿tienen este?"), o quiere saber si llega antes de una fecha. → Cierra: confirma stock real, da el total con despacho y ofrece el pago.
TIBIO — Mirando ("¿a cuánto los polerones?"), comparando, preguntando por variedad. → Muestra 2-3 opciones concretas con precio (no el catálogo entero) y UNA pregunta que avance.
FRÍO — Proveedores, spam, "solo miraba". → Corta amable. No persigas.
EL SILENCIO NO CALIFICA: frío se gana por lo que la persona DICE, nunca por dejar de responder.

5. REGLAS DEL VERTICAL
- STOCK: responde disponibilidad SOLO con el stock de la lista (si está el stock vivo) o de la base de conocimiento. Si algo está agotado, dilo honesto y ofrece la alternativa más parecida. NUNCA inventes tallas, colores ni reposiciones ("la próxima semana llega" solo si la base lo dice).
- TALLAS: la duda de talla es LA objeción #1 de comprar ropa sin probársela. Usa la guía de medidas de la base; si la persona da su talla habitual o medidas, recomienda con honestidad ("si te gusta más suelto, súbete una talla"). Una talla bien recomendada = cero cambios.
- DIRECCIÓN (regla de oro anti-devolución): antes de cerrar CUALQUIER pedido, confirma dirección COMPLETA (calle, número, depto/casa, comuna) y teléfono. En contra-entrega además avisa: "te va a llegar tal día, el repartidor cobra $[monto] — que haya alguien para recibirlo". Un pedido contra-entrega rechazado cuesta el despacho ida y vuelta.
- PAGO ANTICIPADO: cuando la persona confirme qué lleva y su dirección, y elija pagar con link, usa el marcador de pago para generar el link real. Nunca inventes links ni datos bancarios: solo lo que está en la base de conocimiento.
- CAMBIOS Y DEVOLUCIONES: responde EXACTO lo que dice la política de la base. Nunca prometas cambios o plazos que no estén escritos.
- PRECIOS: solo los de la base o del stock vivo. Ofertas solo si están vigentes en la base. PROHIBIDO inventar descuentos.
- Si mandan FOTO de una prenda (pantallazo del Instagram o de la web): identifícala si puedes por la base, confirma stock de talla y avanza al cierre.
- Si mandan NOTA DE VOZ: responde igual de natural.
- No asumas el género de quien escribe ni para quién es la ropa: mucha gente compra de regalo. Escribe neutro hasta saber.
- Pedido ya hecho ("¿dónde viene mi pedido?"): si el sistema te muestra el pedido y su estado, respóndelo con esos datos. Si no aparece, pide el número de pedido y avisa que el equipo lo revisa — no inventes estados de envío.

6. BIFURCACIÓN
CALIFICA (producto + talla + dirección) → cierra: total claro (producto + despacho), método de pago, y confirmación final del pedido completo en UN mensaje resumen.
NO CALIFICA HOY ("lo voy a pensar", regalo para más adelante, sin presupuesto) → MODO NUTRICIÓN: cero presión, un dato útil gratis (ej. cómo elegir talla entre dos, cómo lavar la prenda para que dure, cuándo suelen reponer), y puerta abierta: "cualquier cosa me escribes 😊". Te quedas en nutrición hasta que la persona retome.

7. TONO
Mensajes de 1-3 líneas, como WhatsApp real. Buena onda sin ser empalagosa. Emojis con moderación (máximo 1 cada 2-3 mensajes). Espejo del tono de la persona.`;

const ROPA_KNOWLEDGE = [
  {
    title: '[EDITAR] Tienda — información general',
    content: `NOMBRE: [EDITAR: nombre de la tienda]
INSTAGRAM / WEB: [EDITAR]
DESPACHO: [EDITAR: zonas y costos — ej. "Santiago $3.500 (24-48h) · regiones por Starken/Chilexpress $4.500 (2-4 días hábiles)"]
CONTRA-ENTREGA: [EDITAR: ¿en qué comunas/ciudades está disponible? ¿monto máximo? — o "no ofrecemos"]
PAGO ANTICIPADO: [EDITAR: link de pago (Mercado Pago), transferencia — datos exactos]
HORARIO DE DESPACHO: [EDITAR: ej. "pedidos confirmados antes de las 14:00 salen el mismo día"]
RETIRO EN PERSONA: [EDITAR: dirección y horario, o "solo despacho"]`,
  },
  {
    title: '[EDITAR] Catálogo y precios',
    content: `IMPORTANTE: si la cuenta tiene el stock vivo de Shopify conectado, la disponibilidad REAL la ve el agente solo. Esta lista es el respaldo y el detalle de cada producto.

BUZOS: [EDITAR: modelos, colores, tallas disponibles, precio]
POLERONES: [EDITAR: modelos (oversize, canguro, polo), colores, tallas, precio]
POLERAS: [EDITAR: modelos, colores, tallas, precio]
[EDITAR: agrega o borra categorías según el catálogo real]
OFERTAS VIGENTES: [EDITAR: promo + fecha de término — o "ninguna por ahora"]`,
  },
  {
    title: '[EDITAR] Guía de tallas y fit',
    content: `La duda de talla es la objeción #1 — esta guía la resuelve. Completa con las medidas REALES de tus prendas (ancho pecho / largo, en cm):

POLERONES (fit [EDITAR: regular/oversize]):
S: [EDITAR: ancho x largo] · M: [EDITAR] · L: [EDITAR] · XL: [EDITAR]
POLERAS: S: [EDITAR] · M: [EDITAR] · L: [EDITAR] · XL: [EDITAR]
BUZOS (pantalón): S: [EDITAR: cintura/largo] · M: [EDITAR] · L: [EDITAR]

REGLAS DE RECOMENDACIÓN: [EDITAR: ej. "nuestro oversize ya viene holgado: recomendar la talla habitual; si lo quieren MUY suelto, una más"]`,
  },
  {
    title: '[EDITAR] Cambios, devoluciones y preguntas frecuentes',
    content: `POLÍTICA DE CAMBIOS: [EDITAR: plazo (ej. 10 días), condiciones (etiqueta puesta, sin uso), quién paga el envío del cambio]
¿SE PUEDE CAMBIAR LA TALLA?: [EDITAR: cómo funciona exactamente]
DEVOLUCIÓN DE DINERO: [EDITAR: sí/no y condiciones]
¿CUÁNDO LLEGA MI PEDIDO?: [EDITAR: plazos honestos por zona]
¿PUEDO PAGAR AL RECIBIR?: [EDITAR: política de contra-entrega]
¿TIENEN TIENDA FÍSICA?: [EDITAR]
[EDITAR: agrega las 3-5 preguntas que más te repiten]`,
  },
];

/**
 * Cuerpos sugeridos para las 6 plantillas del playbook post-compra.
 * Se pegan en Meta (WhatsApp Manager → Plantillas) TAL CUAL, con sus
 * categorías: las de servicio como UTILITY, las comerciales como MARKETING.
 * Contrato de variables: {{1}} nombre · {{2}} nº de pedido · {{3}} dato extra.
 */
const ROPA_PLANTILLAS_SUGERIDAS = [
  { config: 'playbook_template_tracking', nombre_sugerido: 'pedido_en_camino', categoria: 'UTILITY',
    cuerpo: '¡{{1}}, buenas noticias! Tu pedido {{2}} ya va en camino 🚚 Puedes seguirlo aquí: {{3}}' },
  { config: 'playbook_template_llega_hoy', nombre_sugerido: 'pedido_llega_hoy', categoria: 'UTILITY',
    cuerpo: '¡{{1}}! Tu pedido {{2}} salió a reparto y llega HOY. Te avisamos para que haya alguien para recibirlo (y si es contra entrega, con el pago a mano) 🙌' },
  { config: 'playbook_template_entregado', nombre_sugerido: 'pedido_entregado_check', categoria: 'UTILITY',
    cuerpo: '{{1}}, ¿te llegó bien tu pedido {{2}}? Cualquier detalle me cuentas por aquí y lo resolvemos al tiro 🙌' },
  { config: 'playbook_template_upsell', nombre_sugerido: 'pedido_agregar_envio', categoria: 'MARKETING',
    cuerpo: '{{1}}, tu pedido {{2}} ({{3}}) aún no sale 📦 Si quieres agregar algo más, va en el MISMO envío sin costo extra de despacho. ¿Te muestro lo que combina?' },
  { config: 'playbook_template_resena', nombre_sugerido: 'pedido_resena_video', categoria: 'MARKETING',
    cuerpo: '¡{{1}}! ¿Cómo te ha quedado tu {{3}}? Si me mandas un video corto usándolo, tenemos un regalo para tu próxima compra 🎁 Y tu opinión ayuda caleta a otros compradores.' },
  { config: 'playbook_template_winback', nombre_sugerido: 'pedido_recompra', categoria: 'MARKETING',
    cuerpo: '{{1}}, ¡hace poco te llevaste {{3}}! Llegaron cosas nuevas que combinan justo con eso. ¿Quieres que te mande fotos? 😊' },
];

/**
 * Aplica el preset ropa a una cuenta. No pisa agentes ni knowledge
 * existentes — crea en paralelo, el dueño decide cuál agente habilita.
 */
async function applyRopaPreset(db, accountId, { nombreTienda } = {}) {
  const instructions = nombreTienda
    ? ROPA_AGENT_INSTRUCTIONS.replaceAll('[EDITAR: nombre de la tienda]', nombreTienda)
    : ROPA_AGENT_INSTRUCTIONS;

  const agent = await db.insert(db.agents, {
    account_id: accountId,
    name: 'Vendedora de Tienda',
    avatar: '🧥',
    enabled: false, // el dueño la enciende cuando complete los [EDITAR]
    role: 'nurture',
    objetivo: 'vender',
    // Preset autocontenido: ve SOLO su propia knowledge. Sin esto mezclaría
    // la base común del negocio previo de la cuenta con la del vertical.
    ignore_main_knowledge: true,
    instructions,
    link_ids: [],
    delay_min: 5,
    delay_max: 15,
  });

  let knowledgeCreated = 0;
  for (const k of ROPA_KNOWLEDGE) {
    const content = nombreTienda
      ? k.content.replaceAll('[EDITAR: nombre de la tienda]', nombreTienda)
      : k.content;
    await db.insert(db.knowledge, {
      account_id: accountId,
      title: k.title,
      content,
      // NUNCA is_main: knowledgeForAgent inyecta is_main a TODOS los agentes
      // de la cuenta — un agente vivo empezaría a recibir los [EDITAR] en su
      // prompt. El preset se liga solo a su agente vía agent_ids.
      is_main: false,
      agent_ids: [agent._id],
    });
    knowledgeCreated++;
  }

  return {
    ok: true,
    agentId: agent._id,
    created: { agent: 1, knowledge: knowledgeCreated },
    plantillas_sugeridas: ROPA_PLANTILLAS_SUGERIDAS,
    aviso: 'El agente se crea DESACTIVADO. Completa los [EDITAR] de la Knowledge Base — en especial la GUÍA DE TALLAS con medidas reales (es la objeción #1) y la política de cambios — y actívalo desde Agentes. Para el playbook post-compra: crea en Meta las 6 plantillas sugeridas (respeta la categoría UTILITY/MARKETING de cada una), guarda sus nombres en Configuración → Tienda, y enciende el playbook.',
  };
}

module.exports = { applyRopaPreset, ROPA_AGENT_INSTRUCTIONS, ROPA_KNOWLEDGE, ROPA_PLANTILLAS_SUGERIDAS };
