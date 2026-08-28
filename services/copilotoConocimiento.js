/**
 * Atinov — Lo que el copiloto SABE (módulo puro, sin db ni red)
 *
 * El copiloto es el chat interno del panel: el dueño pregunta en lenguaje
 * normal ("¿por qué no responde mi agente?", "¿cómo conecto WhatsApp?") y
 * recibe una respuesta sobre SU cuenta, no una ayuda genérica.
 *
 * La diferencia entre esto y un FAQ es el DIAGNÓSTICO: un FAQ contesta "revisa
 * que el canal esté conectado"; el copiloto contesta "tu WhatsApp está en
 * pausa desde ayer, por eso no responde — reanúdalo en Ajustes". Para eso este
 * módulo recibe el estado real de la cuenta y saca conclusiones ANTES de
 * hablarle al modelo. El modelo redacta; las conclusiones las saca el código,
 * que no alucina.
 *
 * Va aparte de copiloto.js (que sí toca db y OpenAI) para poder testear el
 * diagnóstico sin NeDB — misma razón que services/channels/core.js.
 */

/**
 * Manual del producto. Es lo único que el copiloto puede afirmar sobre cómo
 * funciona Atinov; si le preguntan algo que no está acá, debe decir que no lo
 * sabe en vez de inventar. Se mantiene corto a propósito: cada línea viaja en
 * cada consulta y se paga en tokens.
 */
const MANUAL = `
CANALES
- Instagram: se conecta en Ajustes con un clic (OAuth de Meta). Requiere cuenta
  Instagram Business vinculada a una Página de Facebook.
- WhatsApp: se conecta en Ajustes. Con el botón de un clic si está habilitado;
  si no, pegando Phone Number ID + WhatsApp Business Account ID + un token
  permanente de System User (Meta Business → Usuarios del sistema).
- Messenger: se conecta pegando el ID de la Página y su Page Access Token.
- Cada canal se puede PAUSAR (deja de responder pero conserva las credenciales,
  reanudar es un clic) u OLVIDAR CREDENCIALES (borra el acceso, hay que
  reconectar desde cero). Pausar es lo recomendado para apagar un rato.

AGENTES
- Cada agente tiene un objetivo (calificar, agendar, vender, informar, soporte,
  recolectar) y un prompt guiado: contexto del negocio, límites, manejo de
  objeciones, escalación y conversaciones de ejemplo.
- Los ejemplos pesan más que las reglas: 3-5 buenos ejemplos enseñan más que
  veinte líneas de instrucciones.
- Un agente puede tener canales asignados. Sin canales marcados atiende todos
  los que ningún otro agente reclame.
- Las palabras clave ("keywords") limitan cuándo se activa. Vacío = responde a
  cualquier mensaje.

PLANES (precios netos en USD, el IVA lo agrega el checkout)
- Inicial US$98: 1.500 conversaciones/mes, 90 de WhatsApp, 2 agentes, 1 cuenta.
  SIN llamadas con IA.
- Crecimiento US$275: 3.000 conversaciones, 150 de WhatsApp, 150 minutos de
  llamada, 5 agentes, 3 cuentas. Incluye API y webhook.
- Escala US$498: 5.600 conversaciones, 200 de WhatsApp, 400 minutos, 10 agentes,
  10 cuentas. Incluye white-label.
- A medida: se cotiza según volumen.
- WhatsApp tiene cuota aparte porque Meta cobra ese canal (~US$0,27 por
  conversación desde el 1-oct-2026); Instagram y Messenger no cuestan.
- Pasada la cuota se cobra excedente (US$0,50 por conversación), no se corta la
  atención.

LLAMADAS CON IA
- Solo en Crecimiento y Escala. El agente llama al lead caliente que aceptó en
  el chat, ~20 segundos después de que sale el aviso.
- Candados: consentimiento registrado, horario permitido por cuenta, tope
  diario, una llamada por lead por día, tope de duración.
- Requiere Twilio configurado. Sin credenciales, la capacidad ni aparece.

TIENDA ONLINE (Shopify) Y PLAYBOOK POST-COMPRA
- Con Shopify conectado (Configuración → Tienda), cada pedido crea el lead y
  sale la confirmación por WhatsApp; el agente conversa con el pedido en
  contexto (confirma, corrige dirección o cancela).
- El PLAYBOOK POST-COMPRA (opt-in) sigue el pedido solo: sugerencia de agregar
  algo al mismo envío (2-3 h), aviso "va en camino" y "llega HOY" cuando el
  courier reporta el estado, "¿llegó todo bien?" al entregar, petición de
  reseña (~10 días) e invitación a recomprar (~3 semanas).
- Fuera de la ventana de 24 h esos mensajes exigen PLANTILLAS aprobadas por
  Meta: si falta la plantilla de un paso, ese paso avisa en el hilo y no sale.
- Los pasos comerciales respetan un tope por cliente (default 3/mes, máx 1 al
  día): Meta limita cuántos mensajes de marketing puede recibir cada persona
  al día contando todas las marcas, y pasarse degrada el número.
- STOCK VIVO: con el token de Admin API de la tienda, el agente responde
  disponibilidad con el inventario real ("¿queda talla M?") y tiene prohibido
  inventar stock.
- CAMPAÑAS (Plantillas → Campañas): broadcast de una plantilla de Marketing
  aprobada a un segmento (compraron o no, temperatura, activos/dormidos).
  Regla sana: 2-3 campañas al mes por segmento. El sistema deja fuera solo a
  quien ya recibió su marketing del día o del mes (se reporta en las
  estadísticas), respeta el tope del plan SIN entrar en overage, y avanza de
  a ~15 envíos por minuto a propósito. Máximo 2 campañas activas a la vez.

PANEL INTELIGENCIA Y MEJORAS DEL AGENTE
- El Panel Inteligencia muestra lo aprendido de las conversaciones: objeciones
  frecuentes, motivos de pérdida y qué mensajes funcionan.
- Cada lunes el sistema analiza las conversaciones perdidas y propone mejoras
  al prompt del agente; el dueño las aprueba o descarta con un clic.
- En "Sube conversaciones reales" (mismo panel) el dueño puede pegar
  conversaciones propias con clientes — de su WhatsApp personal, de antes de
  tener el agente — y el sistema detecta qué le funciona y qué falla, y genera
  propuestas al momento. Límite: 10 análisis por día.

PROBLEMAS FRECUENTES Y SU CAUSA REAL
- "El agente no responde": el canal está pausado, o no hay agente con ese canal
  asignado, o el agente está deshabilitado, o hay keywords que el mensaje no
  contiene, o se acabó la cuota del plan.
- "No llegan los mensajes de WhatsApp": la ventana de 24 horas de Meta se
  cerró. Meta solo permite mensajes libres si la persona escribió al negocio
  en las últimas 24 h; fuera de eso hay que usar una plantilla aprobada.
- "El agente no llama": el plan no incluye llamadas, o Twilio no está
  configurado, o está fuera del horario, o el lead no dio consentimiento.
- "Se ve DMCloser en algún lado": es el nombre viejo; el producto se llama
  Atinov desde el rebrand.
`.trim();

/** Reglas de conducta del copiloto. Cortas y duras. */
const REGLAS = `
Eres el copiloto de Atinov: ayudas al DUEÑO del negocio a configurar su cuenta
y a resolver problemas. No hablas con sus clientes.

CÓMO RESPONDES
- En español de Chile, tuteando. Directo y corto: 2-5 frases salvo que pidan
  paso a paso.
- Primero la respuesta, después la explicación. Nada de "¡Claro que sí!" ni
  preámbulos.
- Cuando el diagnóstico de abajo ya detectó el problema, DILO como un hecho y
  di exactamente dónde hacer clic. No preguntes lo que ya sabes.
- Si algo no está en el manual ni en el estado de la cuenta, di que no lo sabes
  y sugiere escribir a soporte. NUNCA inventes una función, un precio ni una
  pantalla que no existe.
- Nunca pidas ni muestres tokens, contraseñas ni claves.
`.trim();

/** Redondea a un decimal sin arrastrar ruido de coma flotante. */
const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;

/**
 * Saca conclusiones del estado de la cuenta. Esta es la parte que hace útil al
 * copiloto: el código detecta el problema y el modelo solo lo redacta.
 *
 * @param {object} e estado normalizado de la cuenta (lo arma copiloto.js)
 * @returns {string[]} hallazgos en lenguaje natural, los más graves primero
 */
function diagnosticar(e) {
  if (!e) return [];
  const out = [];
  const canales = e.canales || {};
  const conectados = Object.entries(canales).filter(([, c]) => c.conectado);
  const activos = conectados.filter(([, c]) => !c.pausado);

  // 1. Sin ningún canal: nada puede funcionar, va primero.
  if (!conectados.length) {
    out.push('NO hay ningún canal conectado. Sin Instagram, WhatsApp o Messenger conectado el agente no puede recibir ni responder nada. Se conectan en Ajustes.');
  } else if (!activos.length) {
    out.push('TODOS los canales conectados están EN PAUSA. Por eso el agente no responde. Se reanudan en Ajustes con el botón "Reanudar canal".');
  } else {
    for (const [nombre, c] of conectados) {
      if (c.pausado) out.push(`El canal ${nombre} está EN PAUSA: recibe mensajes pero el agente no responde. Se reanuda en Ajustes.`);
    }
  }

  // 2. Agentes.
  if (!e.agentes?.total) {
    out.push('No hay ningún agente creado. Sin agente no hay quien responda: se crea en la sección Agentes.');
  } else if (!e.agentes.activos) {
    out.push(`Hay ${e.agentes.total} agente(s) pero ninguno está habilitado. Se activan con el interruptor en la sección Agentes.`);
  }

  // 3. Cuotas. El aviso llega antes del tope, no cuando ya pasó.
  const u = e.uso || {};
  const p = e.plan || {};
  if (Number.isFinite(p.maxDMsWhatsApp) && p.maxDMsWhatsApp > 0) {
    const pct = (u.whatsapp / p.maxDMsWhatsApp) * 100;
    if (pct >= 100) {
      out.push(`Se agotó la cuota de WhatsApp del plan ${p.name} (${u.whatsapp} de ${p.maxDMsWhatsApp}). Las conversaciones nuevas de WhatsApp se cobran como excedente a US$0,50 cada una.`);
    } else if (pct >= 80) {
      out.push(`La cuota de WhatsApp va en ${Math.round(pct)}% (${u.whatsapp} de ${p.maxDMsWhatsApp}). Conviene avisar o subir de plan antes de que se agote.`);
    }
  }
  if (Number.isFinite(p.maxDMs) && p.maxDMs > 0) {
    const pct = (u.dms / p.maxDMs) * 100;
    if (pct >= 80) {
      out.push(`Las conversaciones del mes van en ${Math.round(pct)}% del plan (${u.dms} de ${p.maxDMs}).`);
    }
  }
  if (Number.isFinite(p.minutosLlamada) && p.minutosLlamada > 0) {
    const pct = (u.minutosVoz / p.minutosLlamada) * 100;
    if (pct >= 80) {
      out.push(`Los minutos de llamada van en ${Math.round(pct)}% (${r1(u.minutosVoz)} de ${p.minutosLlamada}).`);
    }
  }

  // 4. Llamadas: distinguir "no lo compraste" de "falta configurarlo".
  if (e.plan && e.plan.llamadas === false) {
    out.push(`El plan ${p.name} NO incluye llamadas con IA. Para que el agente llame por teléfono hay que pasar a Crecimiento o Escala.`);
  } else if (e.plan?.llamadas && !e.twilioListo) {
    out.push('El plan incluye llamadas pero Twilio no está configurado, así que el agente no puede llamar todavía.');
  }

  return out;
}

/**
 * Arma el system prompt completo: reglas + manual + estado + diagnóstico.
 * El diagnóstico va AL FINAL porque es lo más específico y lo último que el
 * modelo lee antes de responder.
 */
function construirPrompt(estado) {
  const partes = [REGLAS, `--- CÓMO FUNCIONA ATINOV ---\n${MANUAL}`];

  if (estado) {
    const c = estado.canales || {};
    const p = estado.plan || {};
    const u = estado.uso || {};
    const linea = (n, x) => `- ${n}: ${!x?.conectado ? 'no conectado' : x.pausado ? 'conectado pero EN PAUSA' : 'conectado y activo'}${x?.detalle ? ` (${x.detalle})` : ''}`;

    partes.push(`--- ESTADO ACTUAL DE ESTA CUENTA ---
Negocio: ${estado.negocio || 'sin nombre'}
Plan: ${p.name || 'desconocido'}${Number.isFinite(p.price) ? ` (US$${p.price}/mes)` : ''}
Canales:
${linea('Instagram', c.instagram)}
${linea('WhatsApp', c.whatsapp)}
${linea('Messenger', c.messenger)}
Agentes: ${estado.agentes?.total || 0} creados, ${estado.agentes?.activos || 0} habilitados${estado.agentes?.nombres?.length ? ` (${estado.agentes.nombres.join(', ')})` : ''}
Uso del mes: ${u.dms || 0}${Number.isFinite(p.maxDMs) ? `/${p.maxDMs}` : ''} conversaciones · ${u.whatsapp || 0}${Number.isFinite(p.maxDMsWhatsApp) ? `/${p.maxDMsWhatsApp}` : ''} de WhatsApp · ${r1(u.minutosVoz)}${Number.isFinite(p.minutosLlamada) ? `/${p.minutosLlamada}` : ''} minutos de llamada
Llamadas con IA: ${p.llamadas ? (estado.twilioListo ? 'incluidas y configuradas' : 'incluidas en el plan pero Twilio sin configurar') : 'NO incluidas en este plan'}`);

    const hallazgos = diagnosticar(estado);
    if (hallazgos.length) {
      partes.push(`--- PROBLEMAS YA DETECTADOS EN ESTA CUENTA ---
Esto lo verificó el sistema, no es una suposición. Si la pregunta se relaciona con alguno, dilo directamente como la causa:
${hallazgos.map(h => `• ${h}`).join('\n')}`);
    } else {
      partes.push('--- REVISIÓN AUTOMÁTICA ---\nNo se detectaron problemas de configuración en esta cuenta.');
    }
  }

  return partes.join('\n\n');
}

module.exports = { MANUAL, REGLAS, diagnosticar, construirPrompt };
