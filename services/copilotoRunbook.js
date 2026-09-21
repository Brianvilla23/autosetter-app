/**
 * Atinov — Libro de fallas del copiloto (módulo puro, sin db ni red)
 *
 * Acá vive lo que el soporte APRENDIÓ: cada problema que ya vimos en una
 * cuenta real, con su causa verdadera y qué hacer. El copiloto lo lee en cada
 * consulta, y las entradas que traen `senal` se disparan solas cuando el
 * estado de la cuenta muestra el problema — sin que el dueño pregunte.
 *
 * REGLA DE CRECIMIENTO (ver docs/SOPORTE_QUE_APRENDE.md): cada bug que se
 * arregla en el producto y cada pregunta que el copiloto no supo responder
 * (admin → Sistema → "Lo que preguntan los clientes") termina como una
 * entrada nueva acá, con fecha. Así el soporte sabe mañana lo que nos costó
 * descubrir hoy, y lo sabe para TODOS los clientes a la vez.
 *
 * Forma de una entrada:
 *   id        único, estable (se usa en tests y para marcar consultas revisadas)
 *   sintoma   lo que el dueño ve o pregunta, con sus palabras
 *   causa     la causa real, no la aparente
 *   solucion  dónde hacer clic, en el panel de Atinov
 *   desde     fecha en que se aprendió (YYYY-MM-DD)
 *   codigo    (opcional) código de error de Meta/Twilio asociado
 *   senal     (opcional) (estado) => string | null. Si devuelve texto, ese texto
 *             entra como hallazgo automático. Debe leer solo `estado`, nunca db.
 *
 * Todo en español de Chile, tuteando, sin emojis: viaja al modelo y al panel.
 */

const fallosWa = (e, codigo) => Number((e && e.wa && e.wa.fallos7d && e.wa.fallos7d[String(codigo)]) || 0);

const FALLAS = [
  // ── Respuesta del agente ──────────────────────────────────────────────────
  {
    id: 'canal_pausado',
    sintoma: 'El agente no responde en un canal',
    causa: 'El canal está en pausa: recibe mensajes pero el agente no contesta.',
    solucion: 'Ajustes → tarjeta del canal → "Reanudar canal".',
    desde: '2026-08-20',
  },
  {
    id: 'lead_control_humano',
    sintoma: 'El agente no le responde a UNA persona en particular',
    causa: 'Ese lead está bajo control humano: tomaste el control en el Inbox o lo pusiste en la lista de excluidos. El agente calla a propósito.',
    solucion: 'Inbox → abrir ese lead → "Devolver al agente". O Ajustes → Excluidos → quitarlo.',
    desde: '2026-08-20',
    senal: e => (e && e.leads && e.leads.bypass > 0)
      ? `Hay ${e.leads.bypass} persona(s) bajo control humano: a ellas el agente no les responde a propósito. Si alguien "no recibe respuesta", revisa primero si está en esa lista (Inbox o Ajustes → Excluidos).`
      : null,
  },
  {
    id: 'agente_sin_canal',
    sintoma: 'Hay agente y canal, pero nadie responde',
    causa: 'El agente tiene canales asignados y este no es uno de ellos, o tiene palabras clave que el mensaje no contiene.',
    solucion: 'Agentes → editar → Canales: marcar el canal, y dejar las palabras clave vacías para que responda a todo.',
    desde: '2026-08-20',
  },
  {
    id: 'respuesta_larga',
    sintoma: 'El agente contesta con mensajes largos que explican de más',
    causa: 'El modelo se pasa de las reglas de brevedad cuando le preguntan algo abierto como "¿de qué se trata tu servicio?": enumera todo lo que sabe en vez de responder una cosa.',
    solucion: 'Desde el 21-09-2026 el sistema mide cada respuesta y la manda a reescribir si pasa de 45 palabras, tres oraciones, más de una pregunta o si enumera. Si igual ves mensajes largos, revisa que las instrucciones del agente no le pidan listar beneficios.',
    desde: '2026-09-21',
  },
  {
    id: 'agente_se_repite',
    sintoma: 'El agente repite lo que ya había dicho, con otras palabras',
    causa: 'El agente veía lo que había dicho el cliente, pero no tenía marcado lo que había dicho él mismo. Al reaparecer el tema volvía a explicar lo mismo.',
    solucion: 'Desde el 21-09-2026 sus últimos mensajes entran al contexto como "esto ya se lo dijiste" y el sistema compara la respuesta nueva contra ellos antes de mandarla.',
    desde: '2026-09-21',
  },
  {
    id: 'voz_suena_robot',
    sintoma: 'Las notas de voz suenan a máquina, sin pausas ni entonación',
    causa: 'Casi siempre es el TEXTO, no la voz: una frase larga con comas o una enumeración de marcas, leída en voz alta, suena a catálogo aunque la voz sea buena.',
    solucion: 'Desde el 21-09-2026, cuando la respuesta va a salir hablada se escribe distinto: máximo 30 palabras, frases cortas terminadas en punto y cero enumeraciones. Si igual suena plano, revisa que las instrucciones del agente no tengan listas de beneficios.',
    desde: '2026-09-21',
  },
  {
    id: 'agente_vosea',
    sintoma: 'El agente escribe con "vos", "tenés", "querés"',
    causa: 'Las instrucciones del agente (o un ejemplo pegado) traen voseo argentino. El modelo imita lo que ve.',
    solucion: 'Agentes → Configurar → revisar instrucciones y ejemplos; cambiar a "tú". Los presets de Atinov ya vienen sin voseo desde el 12-09-2026.',
    desde: '2026-09-12',
  },
  {
    id: 'agente_quedo_vacio',
    sintoma: 'Después de activar o desactivar algo, el agente quedó sin nombre ni instrucciones',
    causa: 'Bug arreglado el 12-09-2026: un cambio parcial (por ejemplo activar llamadas) borraba los demás campos del agente.',
    solucion: 'Ya no pasa. Si un agente quedó vacío antes de esa fecha, hay que volver a escribirlo o cargar un preset.',
    desde: '2026-09-12',
  },

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  {
    id: 'ventana_24h',
    codigo: 131047,
    sintoma: 'Un mensaje del negocio no llegó por WhatsApp',
    causa: 'Meta cerró la ventana de 24 horas: la persona no escribió en el último día y los mensajes libres se rechazan (error 131047).',
    solucion: 'Escribir primero con una plantilla aprobada (sección Plantillas) o esperar a que la persona escriba. Las respuestas del cliente abren 24 horas nuevas.',
    desde: '2026-09-12',
    senal: e => fallosWa(e, 131047)
      ? `${fallosWa(e, 131047)} mensaje(s) de WhatsApp de los últimos 7 días NO llegaron porque la ventana de 24 horas estaba cerrada (error 131047 de Meta). Para escribir primero hay que usar una plantilla aprobada.`
      : null,
  },
  {
    id: 'numero_sin_whatsapp',
    codigo: 131026,
    sintoma: 'WhatsApp dice que el mensaje falló a un número',
    causa: 'Ese número no tiene WhatsApp, bloqueó al negocio o no acepta mensajes de empresas (error 131026).',
    solucion: 'Confirmar el número con la persona por otro canal. No hay nada que arreglar en Atinov.',
    desde: '2026-09-12',
    senal: e => fallosWa(e, 131026)
      ? `${fallosWa(e, 131026)} mensaje(s) de los últimos 7 días fallaron porque el número de destino no está en WhatsApp o bloqueó al negocio (error 131026).`
      : null,
  },
  {
    id: 'limite_marketing',
    codigo: 131049,
    sintoma: 'Una plantilla de marketing no se entregó',
    causa: 'Meta limita cuántos mensajes de marketing recibe cada persona al día, contando todas las marcas (error 131049). No es un bloqueo del negocio.',
    solucion: 'Nada que hacer hoy; el sistema lo reintenta al día siguiente. Bajar la frecuencia de campañas a 2 o 3 al mes por segmento.',
    desde: '2026-09-12',
    senal: e => fallosWa(e, 131049)
      ? `${fallosWa(e, 131049)} mensaje(s) de marketing no se entregaron porque Meta limitó el marketing a esas personas por hoy (error 131049). Se reintentan solos.`
      : null,
  },
  {
    id: 'wa_reconectar',
    sintoma: 'WhatsApp aparece "por reconectar" o dejó de responder de un día para otro',
    causa: 'El acceso de Meta murió (token vencido o revocado). Los mensajes llegan pero el agente no puede contestar.',
    solucion: 'Ajustes → WhatsApp → volver a conectar. Con el botón de un clic o pegando el token permanente de System User.',
    desde: '2026-09-10',
    senal: e => (e && e.wa && e.wa.reconectar)
      ? 'WhatsApp está marcado PARA RECONECTAR: Meta dejó de aceptar el acceso guardado. Hasta reconectarlo en Ajustes → WhatsApp el agente no puede responder por ese canal.'
      : null,
  },
  {
    id: 'wa_token_vence',
    sintoma: 'Aviso de que el acceso de WhatsApp caduca',
    causa: 'Las conexiones hechas con el botón de un clic usan un token que Meta vence a los 60 días y que no se puede refrescar.',
    solucion: 'Ajustes → WhatsApp → "Reconectar" antes de la fecha. El panel muestra la cuenta regresiva desde 15 días antes.',
    desde: '2026-09-10',
    senal: e => (e && e.wa && Number.isFinite(e.wa.diasToken) && e.wa.diasToken <= 15)
      ? (e.wa.diasToken < 0
          ? 'El acceso de WhatsApp YA CADUCÓ. Hay que reconectar en Ajustes → WhatsApp.'
          : `El acceso de WhatsApp caduca en ${e.wa.diasToken} día(s). Conviene reconectar antes en Ajustes → WhatsApp para que no se corte.`)
      : null,
  },
  {
    id: 'wa_fb_duplicado',
    codigo: 409,
    sintoma: 'Al conectar WhatsApp o Messenger sale "ya está conectado en otra cuenta"',
    causa: 'El mismo número o la misma Página ya cuelgan de otra cuenta de Atinov. Un número solo puede vivir en una.',
    solucion: 'Desconectarlo de la otra cuenta primero, o escribir a soporte si esa cuenta no es tuya.',
    desde: '2026-09-12',
  },
  {
    id: 'un_clic_no_disponible',
    sintoma: 'El botón de conectar WhatsApp con un clic dice "Función no disponible"',
    causa: 'Ese botón depende de que Meta apruebe la revisión de la app de Atinov. Mientras tanto solo funciona para cuentas con rol en la app.',
    solucion: 'Conectar por la vía manual: Ajustes → WhatsApp → pegar Phone Number ID, WABA ID y un token permanente de System User.',
    desde: '2026-09-10',
  },
  {
    id: 'plantillas_vacias',
    sintoma: 'La sección Plantillas sale vacía',
    causa: 'La cuenta no tiene el WhatsApp Business Account (WABA) conectado, o el token no tiene permiso de administración.',
    solucion: 'Ajustes → WhatsApp: revisar que estén el WABA ID y el token. Reconectar si hace falta.',
    desde: '2026-09-12',
  },
  {
    id: 'audios_no_llegan',
    sintoma: '"Enviado" pero el audio o el mensaje nunca llegó al teléfono',
    causa: 'Que Meta acepte el envío no significa que se entregó. Casi siempre es la ventana de 24 horas cerrada o un número sin WhatsApp.',
    solucion: 'Mirar el estado real de entrega (entregado, leído o fallido) en el hilo. Si dice fallido, el motivo viene al lado.',
    desde: '2026-09-12',
  },
  {
    id: 'no_llegan_mensajes_nuevos',
    sintoma: 'Los mensajes de los clientes no aparecen en el Inbox',
    causa: 'Meta no está avisando a Atinov: la suscripción del webhook del número o de la Página se cayó, o el canal se conectó a medias.',
    solucion: 'Ajustes → el canal → "Olvidar credenciales" y volver a conectar. Si sigue igual, escribir a soporte: se revisa la suscripción del lado de Meta.',
    desde: '2026-08-20',
  },

  // ── Messenger e Instagram ─────────────────────────────────────────────────
  {
    id: 'fb_reconectar',
    sintoma: 'Messenger dejó de responder',
    causa: 'Meta rechazó el acceso de la Página (token vencido, contraseña cambiada o permisos quitados). El sistema marcó el canal para reconectar y avisó por correo.',
    solucion: 'Ajustes → Messenger → conectar la Página de nuevo.',
    desde: '2026-09-12',
    senal: e => (e && e.fb && e.fb.reconectar)
      ? `Messenger está marcado PARA RECONECTAR${e.fb.motivo ? ` (${e.fb.motivo})` : ''}. Hasta volver a conectar la Página en Ajustes → Messenger el agente no responde por ese canal.`
      : null,
  },
  {
    id: 'nombre_dmcloser',
    sintoma: 'Aparece "DMCloser" en un diálogo de Meta',
    causa: 'Es el nombre anterior del producto; el diálogo de permisos de Instagram lo muestra hasta que Meta sincronice el nombre.',
    solucion: 'Nada que hacer: es la misma app y los permisos son los mismos.',
    desde: '2026-08-10',
  },

  // ── Llamadas ──────────────────────────────────────────────────────────────
  {
    id: 'llamada_no_sale',
    sintoma: 'El agente no llama',
    causa: 'Alguno de los candados: el plan no incluye llamadas, Twilio no está configurado, es fuera del horario permitido, el lead no dio consentimiento en el chat, ya se llamó a ese lead hoy o se llegó al tope diario.',
    solucion: 'Sección Llamadas → revisar el motivo que aparece en cada intento. Los candados son a propósito: protegen el número y el presupuesto.',
    desde: '2026-08-18',
  },
  {
    id: 'llamada_numero_extranjero',
    sintoma: 'La llamada llega desde un número +1 (Estados Unidos)',
    causa: 'Twilio no garantiza mostrar el número chileno como identificador hacia Chile: la red de destino a veces lo reemplaza por uno de tránsito.',
    solucion: 'No se arregla con configuración. La salida real es la llamada por WhatsApp, que muestra el nombre del negocio y se habilita tras la revisión de la app de Meta.',
    desde: '2026-09-10',
  },
  {
    id: 'llamada_prueba_mismo_telefono',
    sintoma: 'La llamada de prueba dice que salió pero no suena',
    causa: 'Se probó llamando al mismo número desde el que sale la llamada. Ese número está ocupado siendo el origen.',
    solucion: 'Probar contra OTRO teléfono (el de un amigo o un segundo número).',
    desde: '2026-09-10',
  },

  // ── Ventas, pagos y tienda ────────────────────────────────────────────────
  {
    id: 'pago_sin_mp',
    sintoma: 'El agente promete un link de pago pero no lo manda',
    causa: 'La cuenta no tiene su token de Mercado Pago en Ajustes. Sin token el sistema elimina el link para no mandar uno roto.',
    solucion: 'Ajustes → Pagos → pegar el Access Token de Mercado Pago del negocio. Los cobros van directo a la cuenta del negocio, no pasan por Atinov.',
    desde: '2026-09-06',
    senal: e => (e && e.agentesUsanPago && e.pagos && e.pagos.mp === false)
      ? 'Al menos un agente está configurado para cobrar en el chat, pero la cuenta NO tiene el token de Mercado Pago en Ajustes → Pagos. Los links de pago no salen hasta pegarlo.'
      : null,
  },
  {
    id: 'mp_planes_no_configurados',
    sintoma: 'El botón de pagar con Mercado Pago da error o no abre nada',
    causa: 'Tener el token de Mercado Pago no basta: cada plan necesita su suscripción creada en Mercado Pago, y su identificador pegado en el servidor. Sin eso el cobro no se puede armar.',
    solucion: 'Crear las tres suscripciones en Mercado Pago (Tu negocio, Suscripciones) y pegar cada identificador en el servidor. La autoverificación del panel de administración dice cuál falta.',
    desde: '2026-09-21',
  },
  {
    id: 'mp_webhook_sin_firma',
    sintoma: 'Duda de si los avisos de pago de Mercado Pago son legítimos',
    causa: 'Sin el secreto del webhook configurado, el sistema acepta el aviso sin verificar la firma. Funciona, pero cualquiera que conozca la dirección podría enviar un aviso falso.',
    solucion: 'Copiar el secreto que Mercado Pago muestra al crear el webhook y pegarlo en el servidor. La autoverificación lo reporta mientras falte.',
    desde: '2026-09-21',
  },
  {
    id: 'pago_aparece_trial',
    sintoma: 'Pagó la suscripción pero el panel sigue en prueba o pide pagar',
    causa: 'Bug histórico arreglado el 12-09-2026: un aviso de "pago pausado" de Mercado Pago borraba el plan de la cuenta.',
    solucion: 'Ya no pasa. Si ocurre, escribir a soporte con el comprobante; se restaura el plan a mano el mismo día.',
    desde: '2026-09-12',
  },
  {
    id: 'playbook_sin_plantilla',
    sintoma: 'Un paso del playbook post-compra no sale (va en camino, llega hoy, reseña)',
    causa: 'Fuera de la ventana de 24 horas cada paso exige su plantilla aprobada por Meta. Si el paso no tiene plantilla asignada, avisa en el hilo y no sale.',
    solucion: 'Configuración → Tienda → Playbook: asignar una plantilla aprobada a cada paso. Se crean en Plantillas.',
    desde: '2026-08-28',
    senal: e => (e && e.playbook && e.playbook.activo && Array.isArray(e.playbook.faltan) && e.playbook.faltan.length)
      ? `El playbook post-compra está activo pero le faltan plantillas para: ${e.playbook.faltan.join(', ')}. Esos pasos no van a salir fuera de la ventana de 24 horas.`
      : null,
  },

  // ── Agenda ────────────────────────────────────────────────────────────────
  {
    id: 'agenda_sin_horario',
    sintoma: 'El agente dice que no hay horas o no ofrece ninguna',
    causa: 'La agenda propia está activa pero sin horario de atención, sin servicios, o el día tiene una excepción que lo cierra.',
    solucion: 'Agenda → Configuración: poner el horario de cada día y al menos un servicio. Las excepciones por fecha mandan sobre el horario semanal.',
    desde: '2026-09-20',
    senal: e => (e && e.agenda && e.agenda.activa && (!e.agenda.diasConHorario || !e.agenda.servicios))
      ? `La agenda está ACTIVA pero ${!e.agenda.diasConHorario ? 'no tiene horario en ningún día' : 'no tiene servicios definidos'}. El agente no puede ofrecer horas hasta completar eso en Agenda → Configuración.`
      : null,
  },
  {
    id: 'cita_sin_plantillas',
    sintoma: 'Los recordatorios de cita no le llegan a algunos clientes',
    causa: 'Fuera de la ventana de 24 horas cada recordatorio necesita su plantilla aprobada por Meta. Al cliente que escribió hace poco le llega igual; al que no, no sale nada.',
    solucion: 'Agenda → Recordatorios de cita: asignar una plantilla aprobada a cada uno de los cuatro mensajes. Se crean en la sección Plantillas.',
    desde: '2026-09-20',
    senal: e => (e && e.citas && e.citas.activo && Array.isArray(e.citas.faltan) && e.citas.faltan.length)
      ? `Los recordatorios de cita están activos pero les faltan plantillas: ${e.citas.faltan.join(', ')}. A quien no haya escrito en las últimas 24 horas no le va a llegar ese mensaje.`
      : null,
  },
  {
    id: 'cita_sin_conversacion',
    sintoma: 'Una cita creada a mano no manda recordatorios',
    causa: 'Los recordatorios salen por WhatsApp, así que la cita tiene que estar ligada a una conversación. Las citas escritas a mano en el panel, sin un chat detrás, no tienen a quién escribirle.',
    solucion: 'Si el cliente ya escribió alguna vez, agendar desde su conversación. Si no, el recordatorio hay que mandarlo a mano.',
    desde: '2026-09-20',
  },
  {
    id: 'cita_cancelada_sigue_avisando',
    sintoma: 'Duda de si le van a seguir escribiendo a alguien que canceló',
    causa: 'No. Al marcar la cita como cancelada o no vino, los recordatorios pendientes se apagan solos; al marcarla atendida se apaga el recordatorio y se arma el mensaje de después.',
    solucion: 'Nada que hacer. Solo mantener el estado de la cita al día en Agenda.',
    desde: '2026-09-20',
  },
  {
    id: 'agenda_atraso',
    sintoma: 'El barbero o profesional va atrasado y las citas se corren',
    causa: 'Es una función, no una falla: "Aplicar atraso" en Agenda corre todas las citas pendientes del día y muestra la hora estimada de cada una.',
    solucion: 'Agenda → Hoy → escribir los minutos de atraso → "Aplicar atraso". Avisar a los clientes afectados desde el hilo de cada uno.',
    desde: '2026-09-20',
  },

  // ── Plan y cuotas ─────────────────────────────────────────────────────────
  {
    id: 'cuota_wa_agotada',
    sintoma: 'Aviso de cuota de WhatsApp agotada',
    causa: 'WhatsApp tiene cuota aparte porque Meta cobra ese canal. Pasada la cuota no se corta la atención: cada conversación nueva se cobra como excedente.',
    solucion: 'Facturación → subir de plan si el excedente se repite todos los meses.',
    desde: '2026-08-24',
  },

  // ── Sistema ───────────────────────────────────────────────────────────────
  {
    id: 'errores_sistema',
    sintoma: 'Algo falló al guardar o al cargar una sección',
    causa: 'Un error interno del sistema. Cada uno queda registrado con la cuenta, la hora y la ruta para que soporte lo revise.',
    solucion: 'Reintentar. Si se repite, escribir a soporte diciendo qué estabas haciendo: el error ya está registrado del lado de Atinov.',
    desde: '2026-09-20',
    senal: e => (e && Number(e.errores24h) > 0)
      ? `El sistema registró ${e.errores24h} error(es) interno(s) en esta cuenta en las últimas 24 horas. Soporte ya los tiene; si algo falló, cuenta qué estabas haciendo para cruzarlo.`
      : null,
  },
];

/**
 * Hallazgos automáticos: recorre las entradas con `senal` y devuelve los
 * textos que se dispararon. Una señal que explota no tumba a las demás.
 */
function hallazgosDelRunbook(estado) {
  if (!estado) return [];
  const out = [];
  for (const f of FALLAS) {
    if (typeof f.senal !== 'function') continue;
    try {
      const r = f.senal(estado);
      if (r && typeof r === 'string') out.push(r);
    } catch { /* una señal rota no puede callar al copiloto */ }
  }
  return out;
}

/** El libro completo como texto para el prompt: una línea por falla. */
function textoRunbook() {
  return FALLAS.map(f => `- ${f.sintoma}: ${f.causa} Qué hacer: ${f.solucion}`).join('\n');
}

/** Busca una entrada por id (para marcar consultas revisadas y en tests). */
function fallaPorId(id) {
  return FALLAS.find(f => f.id === id) || null;
}

module.exports = { FALLAS, hallazgosDelRunbook, textoRunbook, fallaPorId };
