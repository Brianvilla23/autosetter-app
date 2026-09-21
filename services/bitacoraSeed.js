/**
 * Atinov — Siembra inicial de la bitácora
 *
 * Las conversaciones de trabajo que ya ocurrieron, para que el centro de datos
 * no arranque vacío. Corre UNA vez: si la bitácora ya tiene algo, no toca
 * nada, así una entrada borrada a mano no reaparece en el siguiente deploy.
 *
 * De acá en adelante las entradas nuevas se agregan desde el panel (admin →
 * Centro de mando → Agregar entrada) o por la API.
 */

const db = require('../db/database');

const HISTORIA = [
  {
    fecha: '2026-09-20',
    titulo: 'Playbook de cita',
    chat: 'Agenda y barberías',
    resumen: 'Los cuatro mensajes que salen solos alrededor de cada hora agendada: confirmar al abrir el día, recordar antes, preguntar cómo quedó e invitar a volver.',
    commits: ['b27ca4c'],
    construido: [
      'Motor de pasos de cita con las mismas defensas que el playbook de pedidos: manejo humano, cuota del plan, ventana de 24 horas y plantilla obligatoria fuera de ella',
      'Anclaje de fecha y hora a horario de Chile, resolviendo el cambio de hora de septiembre',
      'Cancelar al marcar cancelada o no vino, y armar el seguimiento al marcar atendida',
      'El atraso del día corre también el recordatorio, para no avisar una hora vieja',
      'Tarjeta Recordatorios de cita en el panel, con aviso de plantillas faltantes',
    ],
    decisiones: [
      'Los tres primeros mensajes son utility y no gastan cupo de marketing; la invitación a volver sí',
      'Sin plantilla aprobada, el mensaje no sale y queda el aviso en el hilo en vez de fallar en silencio',
    ],
    documentos: ['ATINOV_VERTICAL_BARBERIAS.md'],
    pendientes: [
      { texto: 'Crear las cuatro plantillas de cita en WhatsApp y dejarlas aprobadas', de: 'brayan' },
      { texto: 'Aviso automático de atraso a los clientes afectados', de: 'claude' },
      { texto: 'Lista de espera cuando alguien se baja de su hora', de: 'claude' },
      { texto: 'Abono del 50 por ciento ligado a la cita, con devolución si cancela a tiempo', de: 'claude' },
    ],
  },
  {
    fecha: '2026-09-20',
    titulo: 'Soporte que aprende',
    chat: 'Agenda y barberías',
    resumen: 'El copiloto del panel pasó de contestar dudas a acumular lo aprendido: un libro de fallas que crece con cada problema resuelto.',
    commits: ['af60a7d'],
    construido: [
      'Libro de fallas con síntoma, causa real, dónde hacer clic y fecha de cada problema ya visto',
      'Señales que se disparan solas leyendo el estado de la cuenta, sin que el dueño pregunte',
      'Botón me sirvió y no me sirvió bajo cada respuesta del copiloto',
      'Cola de revisión en admin, Sistema, con lo que no sirvió y nadie ha revisado',
    ],
    decisiones: [
      'Cada bug que se arregla agrega su entrada al libro de fallas en el mismo commit',
      'El diagnóstico lo saca el código, no el modelo: un diagnóstico equivocado es peor que ninguno',
    ],
    documentos: ['docs/SOPORTE_QUE_APRENDE.md'],
    pendientes: [
      { texto: 'Revisar semanalmente la cola de lo que no sirvió y volcarlo al libro de fallas', de: 'claude' },
    ],
  },
  {
    fecha: '2026-09-20',
    titulo: 'Agenda propia',
    chat: 'Agenda y barberías',
    resumen: 'Agenda para negocios con hora variable, pensada con el caso real del amigo barbero: atiende de 17 a 21, cuida a su mamá en la mañana y a veces va atrasado.',
    commits: ['d7fbf6b'],
    construido: [
      'Horario por día con varios tramos, excepciones por fecha y servicios con duración y precio',
      'Cupos reales que el agente consulta antes de ofrecer una hora',
      'Botón de atraso que corre las citas pendientes y muestra la hora estimada de cada una',
      'Sección Agenda en el panel y estados de cita completos',
    ],
    decisiones: [
      'Agenda propia en vez de integrarse con las agendas del mercado: ninguna expone una interfaz pública confirmada',
      'Si dos personas piden la misma hora, gana la primera y a la otra se le proponen alternativas',
    ],
    pendientes: [
      { texto: 'Configurar el horario real de la barbería del amigo y dejarlo probando con clientes', de: 'brayan' },
    ],
  },
  {
    fecha: '2026-09-12',
    titulo: 'Voz humana y auditoría a fondo',
    chat: 'Llamadas y voz',
    resumen: 'La llamada de prueba sonó robótica y sin presentación. Se rehicieron las reglas de voz y se auditó el producto completo con varios agentes.',
    commits: ['5a1dd5c'],
    construido: [
      'Reglas de voz nuevas: ritmo variable, silencios, horas habladas y espejo del trato',
      'Registro por prefijo telefónico con quince países, para hablar como el país al que se llama',
      'Agrupador de mensajes seguidos de WhatsApp y memoria que recuerda lo que el cliente ya dijo',
      'Estados reales de entrega de WhatsApp: enviado no es lo mismo que entregado',
    ],
    decisiones: [
      'El agente no anuncia que es inteligencia artificial salvo que le pregunten',
      'Probar en paralelo los dos proveedores de voz antes de elegir uno',
    ],
    documentos: ['ATINOV_VOZ_HUMANA', 'ATINOV_AUDITORIA_PREMIUM'],
    pendientes: [
      { texto: 'Poner las claves de los dos proveedores de voz en Railway para escuchar la comparación', de: 'brayan' },
    ],
  },
  {
    fecha: '2026-09-10',
    titulo: 'Twilio en producción y radar de prospectos',
    chat: 'Llamadas y voz',
    resumen: 'Las llamadas quedaron operativas y se construyó el buscador de prospectos por señales de dolor.',
    construido: [
      'Llamadas en producción con número verificado',
      'Radar de prospectos que junta negocios desde varias fuentes, los clasifica y arma la tarjeta de contacto',
    ],
    decisiones: [
      'El número de Estados Unidos que aparece al llamar a Chile no se arregla por configuración: la salida es la llamada por WhatsApp',
    ],
    documentos: ['ATINOV_ADQUISICION_CLIENTES.md'],
    pendientes: [
      { texto: 'Correr el extractor de Instagram del radar de prospectos', de: 'brayan' },
    ],
  },
  {
    fecha: '2026-09-06',
    titulo: 'Nichos, seguridad y diseño del panel',
    chat: 'Estrategia de producto',
    resumen: 'Tres frentes en paralelo: qué rubro atacar, qué tan seguro está el producto y qué tan entendible es el panel.',
    commits: ['f258ab6', 'e69058f'],
    construido: [
      'Ranking de seis rubros con puntaje',
      'Revisión de seguridad con tres agentes y arreglo de las dependencias',
      'Agente de ventas versión dos, con los precios tomados del código',
    ],
    decisiones: [
      'Descartar los coaches como rubro; ropa y estética quedan arriba',
    ],
    documentos: ['ATINOV_NICHOS_RANKING.md', 'ATINOV_PENTEST_2026-09.md', 'ATINOV_DISEÑO_PANEL.md'],
    pendientes: [
      { texto: 'Decidir un solo precio: la web muestra Founder y el cobro usa la escalera', de: 'brayan' },
    ],
  },
  {
    fecha: '2026-08-28',
    titulo: 'Primer cliente laboratorio y vertical de ropa',
    chat: 'Verticales',
    resumen: 'Diego, ropa con pago contra entrega. El primer vertical completo construido sobre un cliente real.',
    commits: ['89c498a'],
    construido: [
      'Playbook post compra con tope de frecuencia, stock vivo y configuración lista para ropa',
    ],
    decisiones: [
      'No construir un vertical sin un cliente real que lo use',
    ],
    documentos: ['ATINOV_CLIENTE_ROPA_PLAYBOOK.md'],
  },
  {
    fecha: '2026-08-10',
    titulo: 'Verificación de negocio aprobada',
    chat: 'Meta y permisos',
    resumen: 'Meta aprobó la verificación del negocio al primer intento. Quedaron desbloqueadas la voz por WhatsApp y la revisión de la app.',
    decisiones: [
      'Quedan dos intentos de verificación: no arriesgarlos',
    ],
    documentos: ['ATINOV_APP_REVIEW_HOY.md'],
    pendientes: [
      { texto: 'Grabar los cuatro videos y enviar los ocho permisos a revisión', de: 'brayan' },
      { texto: 'Poner la clave de Mercado Pago en Railway: sin ella nadie puede contratar', de: 'brayan' },
    ],
  },
];

/**
 * Siembra la historia si la bitácora está vacía. Devuelve cuántas entradas
 * insertó. No tumba el arranque si algo falla.
 */
async function sembrarSiVacia() {
  try {
    const n = await db.count(db.bitacora, {});
    if (n > 0) return 0;
    const { sanear } = require('./bitacora');
    for (const e of HISTORIA) await db.insert(db.bitacora, sanear(e));
    console.log(`📓 Bitácora sembrada con ${HISTORIA.length} conversaciones`);
    return HISTORIA.length;
  } catch (e) {
    console.warn('[bitacora] siembra omitida:', e.message);
    return 0;
  }
}

module.exports = { HISTORIA, sembrarSiVacia };
