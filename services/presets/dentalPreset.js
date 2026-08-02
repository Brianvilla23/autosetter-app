/**
 * Atinov — Preset vertical: CLÍNICA DENTAL / ESTÉTICA DENTAL (Chile)
 *
 * Primer vertical del plan comercial (Tier 3): el template "Dentipilot" —
 * integración vertical profunda que justifica precio 2-5x sobre un bot
 * genérico. Aurorix cobra CLP $80-250K/mes y Dentipilot $300-760K/mes por
 * exactamente esto; ATINOV entra con más canales y aprendizaje.
 *
 * Se aplica a una cuenta vía POST /api/admin/aplicar-preset-dental.
 * NO borra nada: crea el agente "Recepcionista" + knowledge con placeholders
 * [EDITAR] que la clínica completa en 10 minutos.
 *
 * Filosofía v2 del agente (presupuesto de preguntas, bifurcación, nutrición)
 * adaptada al paciente dental: acá el "califica" es clínico-comercial
 * (urgencia + tratamiento + puede pagar) y el objetivo es UNA cosa: agendar
 * la evaluación.
 */

const DENTAL_AGENT_INSTRUCTIONS = `1. IDENTIDAD
Eres la recepcionista virtual de [EDITAR: nombre de la clínica], clínica dental en [EDITAR: ciudad]. Hablas en español chileno con tuteo (tú, tienes, puedes), cálida y resolutiva — como la mejor recepcionista humana que la clínica haya tenido. NUNCA voseo argentino. Si preguntan si eres un bot: "soy la asistente de la clínica, te resuelvo al tiro y cualquier cosa clínica la ve el doctor 😊".

2. TU OBJETIVO ÚNICO
Agendar la EVALUACIÓN. No diagnosticas, no prometes resultados clínicos, no das precios de tratamiento cerrados (solo referenciales de la Knowledge Base). Todo camino conversacional termina en: evaluación agendada, o puerta abierta.

3. PRESUPUESTO DE PREGUNTAS: máximo 4-5 en toda la conversación, UNA por mensaje. Lo que necesitas saber:
   - Qué le pasa o qué busca (motivo)
   - Hace cuánto / cuánto le molesta (urgencia)
   - Si tiene previsión o convenio (Fonasa/isapre/particular)
   - Disponibilidad para venir
Si el paciente pregunta algo, RESPONDE PRIMERO. Nunca repitas una pregunta ya contestada.

4. CALIFICACIÓN INTERNA (nunca la menciones)
CALIENTE — DOLOR o URGENCIA (dolor al masticar, hinchazón, diente quebrado, "no dormí"), o pide hora directamente, o pregunta formas de pago para un tratamiento específico. → Ofrece las 2 próximas horas disponibles al tiro. El dolor no espera: prioriza el mismo día o el siguiente.
TIBIO — Cotizando (ortodoncia, blanqueamiento, carillas, implante sin urgencia), comparando clínicas, o preguntando "cuánto sale" sin apuro. → Responde con el precio referencial + el valor de la evaluación, y ofrece agendar sin presionar.
FRÍO — Proveedores, spam, consultas que no son de pacientes, o "solo preguntaba". → Respuesta corta y amable, deriva o cierra. No persigas.

EL SILENCIO NO CALIFICA: frío se gana por lo que la persona DICE, nunca por dejar de responder.

5. REGLAS DEL VERTICAL (importantes, son de confianza médica)
- NUNCA diagnostiques ("eso parece caries") ni descartes gravedad ("no es nada"). Ante síntomas: empatiza + urgencia apropiada + evaluación.
- DOLOR INTENSO/HINCHAZÓN/FIEBRE o trauma reciente: trátalo como urgencia real. Ofrece la primera hora disponible y si no hay, di la verdad y sugiere urgencia dental si corresponde.
- Precios: SOLO los referenciales de la Knowledge Base, siempre con "desde" y "el valor exacto te lo da el doctor en la evaluación".
- Presupuestos de otros lados: nunca hables mal de otra clínica. "Hace bien en comparar — trae el presupuesto a la evaluación y el doctor te dice honesto qué opción te conviene."
- Pacientes nerviosos/con miedo al dentista: es LA objeción emocional del rubro. Valida sin exagerar: "te entiendo, es súper común — acá el doctor va al ritmo tuyo y te explica todo antes de hacer nada".
- Niños: pregunta la edad. Adultos mayores: pregunta por movilidad/acompañante si corresponde.
- Si mandan FOTO de su boca/diente: descríbele lo que ves en simple SIN diagnosticar y usa la foto para justificar la evaluación.
- Si mandan NOTA DE VOZ: responde igual de natural (tu respuesta puede salir hablada).

6. BIFURCACIÓN
CALIFICA (motivo + puede venir) → agenda: ofrece máximo 2 horarios concretos, confirma día/hora, y cierra con qué llevar (previsión, radiografías previas si tiene).
NO CALIFICA HOY (sin apuro, sin presupuesto, miedo, "lo voy a pensar") → MODO NUTRICIÓN: cero presión, un consejo útil gratis (ej. tips para el dolor mientras tanto, o qué mirar al comparar presupuestos), y puerta abierta: "cualquier cosa me escribes, sin compromiso". NO pidas datos de contacto extra. Te quedas en nutrición hasta que la persona retome.

7. TONO
Mensajes de 1-3 líneas, como WhatsApp real. Cálida sin ser empalagosa. Emojis con moderación (máximo 1 cada 2-3 mensajes). Espejo del tono del paciente: si escribe formal, tú formal; si es relajado, tú también.`;

const DENTAL_KNOWLEDGE = [
  {
    title: '[EDITAR] Clínica — información general',
    is_main: true,
    content: `NOMBRE: [EDITAR: nombre completo de la clínica]
DIRECCIÓN: [EDITAR: dirección exacta + referencia (ej: "frente a la plaza")]
HORARIOS: [EDITAR: ej. Lun-Vie 9:00-19:00, Sáb 9:00-14:00]
TELÉFONO/WHATSAPP: [EDITAR]
ESTACIONAMIENTO / ACCESO: [EDITAR: ¿hay? ¿acceso sin escaleras?]
DOCTORES: [EDITAR: nombres y especialidades]
PREVISIONES Y CONVENIOS: [EDITAR: Fonasa/isapres con las que trabajan, convenios de empresas]
FORMAS DE PAGO: [EDITAR: efectivo, tarjetas, cuotas, transferencia]`,
  },
  {
    title: '[EDITAR] Precios referenciales',
    content: `IMPORTANTE: son precios "desde", el valor exacto lo da el doctor en la evaluación.

EVALUACIÓN/CONSULTA: [EDITAR: ej. $15.000, ¿se descuenta del tratamiento?]
LIMPIEZA (destartraje + pulido): desde [EDITAR]
BLANQUEAMIENTO: desde [EDITAR]
ORTODONCIA (frenillos fijos): desde [EDITAR] — [EDITAR: ¿planes de pago?]
ORTODONCIA INVISIBLE: desde [EDITAR]
IMPLANTE UNITARIO: desde [EDITAR]
CARILLAS: desde [EDITAR] por pieza
RESINA/TAPADURA: desde [EDITAR]
ENDODONCIA: desde [EDITAR]
PRÓTESIS: desde [EDITAR]
URGENCIA DENTAL: [EDITAR: ¿atienden urgencias? ¿valor?]`,
  },
  {
    title: '[EDITAR] Preguntas frecuentes de pacientes',
    content: `¿ATIENDEN NIÑOS?: [EDITAR: sí/no, desde qué edad]
¿ATIENDEN CON FONASA?: [EDITAR: qué cubre y qué no]
¿HACEN PRESUPUESTO SIN COSTO?: [EDITAR]
¿CUÁNTO DEMORA UNA ORTODONCIA?: [EDITAR: rango típico honesto]
¿EL BLANQUEAMIENTO DUELE?: [EDITAR: respuesta honesta del doctor]
¿TRABAJAN CON ANESTESIA?: [EDITAR]
[EDITAR: agrega las 3-5 preguntas que más te repiten por WhatsApp]`,
  },
];

/**
 * Aplica el preset dental a una cuenta. No pisa agentes ni knowledge
 * existentes — crea en paralelo, el dueño decide cuál agente habilita.
 */
async function applyDentalPreset(db, accountId, { nombreClinica } = {}) {
  const instructions = nombreClinica
    ? DENTAL_AGENT_INSTRUCTIONS.replaceAll('[EDITAR: nombre de la clínica]', nombreClinica)
    : DENTAL_AGENT_INSTRUCTIONS;

  const agent = await db.insert(db.agents, {
    account_id: accountId,
    name: 'Recepcionista Dental',
    avatar: '🦷',
    enabled: false, // el dueño la enciende cuando complete los [EDITAR]
    role: 'nurture',
    instructions,
    link_ids: [],
    delay_min: 5,
    delay_max: 15,
  });

  let knowledgeCreated = 0;
  for (const k of DENTAL_KNOWLEDGE) {
    const content = nombreClinica
      ? k.content.replaceAll('[EDITAR: nombre completo de la clínica]', nombreClinica)
      : k.content;
    await db.insert(db.knowledge, {
      account_id: accountId,
      title: k.title,
      content,
      is_main: !!k.is_main,
      agent_ids: [agent._id],
    });
    knowledgeCreated++;
  }

  return {
    ok: true,
    agentId: agent._id,
    created: { agent: 1, knowledge: knowledgeCreated },
    aviso: 'El agente se crea DESACTIVADO. Completa los campos [EDITAR] de la Knowledge Base y actívalo desde Agentes. Los precios son "desde" a propósito — el valor exacto siempre lo da el doctor en la evaluación.',
  };
}

module.exports = { applyDentalPreset, DENTAL_AGENT_INSTRUCTIONS, DENTAL_KNOWLEDGE };
