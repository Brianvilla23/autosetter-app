/**
 * Atinov — Constructor de prompt estructurado
 *
 * La calidad de un agente es 90% su prompt, y un dueño de pyme frente a un
 * textarea vacío escribe un prompt malo — y después culpa al producto. En vez
 * de pedirle "las instrucciones", el panel le hace preguntas con nombre:
 * qué hace tu negocio, qué NO debe prometer el agente, cómo responde a la
 * objeción de precio, cuándo deriva a un humano, y 3-5 conversaciones de
 * ejemplo. Este módulo junta esas respuestas en un solo bloque bien ordenado.
 *
 * Los ejemplos van al final y con jerarquía propia porque los modelos imitan
 * ejemplos mejor de lo que obedecen reglas: 3-5 buenos ejemplos rinden más
 * que veinte líneas de instrucciones.
 *
 * RETROCOMPATIBLE POR DISEÑO: un agente viejo (solo `instructions`) pasa por
 * acá y sale idéntico. Los campos nuevos SUMAN encima del texto libre, nunca
 * lo reemplazan — así el botón de mejora semanal (promptImprover), que anexa
 * a `instructions`, sigue funcionando sin enterarse de nada.
 *
 * Módulo PURO (sin db ni red) para poder testearlo sin NeDB.
 */

/** Objetivos que el panel ofrece al crear el agente. El objetivo no activa ni
 *  desactiva capacidades (los marcadores [PAGO]/[AGENDAR]/[LLAMAR] tienen sus
 *  propios candados de plan y configuración): le da FOCO a la conversación. */
const OBJETIVOS = {
  calificar: {
    label: 'Calificar leads',
    prompt: 'Tu objetivo principal es CALIFICAR a cada persona que escribe: entender qué necesita, cuánta urgencia tiene y si es un comprador real, haciendo pocas preguntas y naturales. La venta es consecuencia de calificar bien, no al revés.',
  },
  agendar: {
    label: 'Agendar citas',
    prompt: 'Tu objetivo principal es AGENDAR una cita o reunión con cada persona interesada. Toda la conversación empuja con naturalidad hacia proponer un día y una hora concretos.',
  },
  vender: {
    label: 'Cerrar ventas',
    prompt: 'Tu objetivo principal es CERRAR LA VENTA: resolver dudas, manejar objeciones y llevar a la persona al pago sin presionarla. Prefiere cerrar hoy una venta chica antes que perder al cliente persiguiendo una grande.',
  },
  informar: {
    label: 'Dar información',
    prompt: 'Tu objetivo principal es INFORMAR con precisión sobre los productos y servicios del negocio. Responde solo con lo que sabes del negocio; si no está en tu información, dilo y ofrece derivar.',
  },
  soporte: {
    label: 'Atención al cliente',
    prompt: 'Tu objetivo principal es ATENDER Y RESOLVER consultas de clientes existentes: estados de pedido, problemas, cambios. Resuelve lo que puedas y deriva a un humano lo que no, sin dejar a nadie sin respuesta.',
  },
  recolectar: {
    label: 'Recolectar datos',
    prompt: 'Tu objetivo principal es RECOLECTAR los datos que el negocio necesita de cada persona (los que indican tus instrucciones), pidiéndolos de a uno, con contexto de por qué se piden, y confirmándolos antes de cerrar.',
  },
};

function esObjetivoValido(o) {
  return Object.prototype.hasOwnProperty.call(OBJETIVOS, String(o || ''));
}

const LIMPIA = (s, max) => String(s || '').trim().slice(0, max);

/**
 * Normaliza los ejemplos que llegan del panel. Cada uno es un par
 * {cliente, agente}. Se aceptan hasta 5; los incompletos se descartan.
 */
function sanearEjemplos(ejemplos) {
  if (!Array.isArray(ejemplos)) return [];
  return ejemplos
    .map(e => ({
      cliente: LIMPIA(e && e.cliente, 500),
      agente:  LIMPIA(e && e.agente, 500),
    }))
    .filter(e => e.cliente && e.agente)
    .slice(0, 5);
}

/** ¿Este agente tiene algo estructurado, o es un agente clásico de texto libre? */
function tieneEstructura(agent) {
  if (!agent) return false;
  return !!(
    esObjetivoValido(agent.objetivo)
    || LIMPIA(agent.p_contexto, 1)
    || LIMPIA(agent.p_limites, 1)
    || LIMPIA(agent.p_objeciones, 1)
    || LIMPIA(agent.p_escalacion, 1)
    || sanearEjemplos(agent.p_ejemplos).length
  );
}

/**
 * Las instrucciones EFECTIVAS del agente: lo que de verdad va al modelo.
 *
 * Orden pensado, no alfabético: identidad → objetivo → contexto → límites →
 * objeciones → escalación → texto libre → ejemplos. Los límites van ANTES que
 * las objeciones porque definen la cancha; los ejemplos van al final porque
 * son lo último que el modelo lee y lo que más imita.
 */
function instruccionesEfectivas(agent) {
  if (!agent) return '';
  const libre = String(agent.instructions || '').trim();
  if (!tieneEstructura(agent)) return libre;   // agente clásico: intacto

  const partes = [];

  const cargo = LIMPIA(agent.cargo, 80);
  if (cargo) partes.push(`Tu rol: ${cargo}.`);

  if (esObjetivoValido(agent.objetivo)) {
    partes.push(OBJETIVOS[agent.objetivo].prompt);
  }

  const contexto = LIMPIA(agent.p_contexto, 4000);
  if (contexto) partes.push(`SOBRE EL NEGOCIO\n${contexto}`);

  const limites = LIMPIA(agent.p_limites, 2000);
  if (limites) {
    partes.push(`LÍMITES — LO QUE NUNCA HACES\n${limites}\nSi algo te empuja fuera de estos límites, no lo hagas: deriva a un humano.`);
  }

  const objeciones = LIMPIA(agent.p_objeciones, 2000);
  if (objeciones) partes.push(`CÓMO RESPONDES A OBJECIONES\n${objeciones}`);

  const escalacion = LIMPIA(agent.p_escalacion, 1500);
  if (escalacion) partes.push(`CUÁNDO DERIVAR A UN HUMANO\n${escalacion}`);

  if (libre) partes.push(`INSTRUCCIONES ADICIONALES\n${libre}`);

  const ejemplos = sanearEjemplos(agent.p_ejemplos);
  if (ejemplos.length) {
    const bloques = ejemplos.map((e, i) =>
      `Ejemplo ${i + 1}:\nCliente: ${e.cliente}\nTú: ${e.agente}`).join('\n\n');
    partes.push(`ASÍ RESPONDES TÚ — imita el tono y el largo de estos ejemplos\n${bloques}`);
  }

  return partes.join('\n\n');
}

module.exports = {
  OBJETIVOS,
  esObjetivoValido,
  sanearEjemplos,
  tieneEstructura,
  instruccionesEfectivas,
};
