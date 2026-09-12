/**
 * Atinov — Agrupar los mensajes rápidos de un lead antes de responder
 *
 * La gente escribe por WhatsApp en ráfagas: "hola" … "quiero saber el precio"
 * … "es para mi negocio". Antes cada burbuja disparaba su propia respuesta:
 * el agente contestaba el "hola" mientras la persona seguía escribiendo, y
 * quedaban dos hilos cruzados (y dos llamadas al modelo por lo que era UN
 * turno). Pedido de Brayan (2026-09-12): responder cuando la persona TERMINA
 * de escribir.
 *
 * Cómo: un buffer por lead. Cada burbuja entra y reinicia una espera corta
 * (ESPERA_MS). Cuando pasa la espera sin burbujas nuevas —o se cumple el tope
 * MAX_MS aunque siga escribiendo— se dispara UNA vez con todas las partes.
 *
 * Lo que NO hace: no persiste nada. Quien lo usa guarda cada burbuja con su
 * id de Meta ANTES de encolarla (idempotencia y transcripción intactas) y le
 * pasa al modelo el texto junto. El buffer vive en memoria del proceso: un
 * reinicio a mitad de una ráfaga pierde la respuesta de esa ráfaga (no los
 * mensajes, que ya están guardados). La ventana es de segundos: aceptable.
 *
 * `timers` se inyecta para testear sin esperar de verdad.
 */

const ESPERA_MS = Number(process.env.WA_AGRUPAR_MS) > 0 ? Number(process.env.WA_AGRUPAR_MS) : 2500;
const MAX_MS    = Number(process.env.WA_AGRUPAR_MAX_MS) > 0 ? Number(process.env.WA_AGRUPAR_MAX_MS) : 12000;

function crearAgrupador({ esperaMs = ESPERA_MS, maxMs = MAX_MS, timers = { setTimeout, clearTimeout }, ahora = Date.now } = {}) {
  const buffers = new Map();   // clave → { partes, timer, primeraEn, alDisparar }

  function disparar(clave) {
    const b = buffers.get(clave);
    if (!b) return;
    buffers.delete(clave);
    timers.clearTimeout(b.timer);
    // Nunca dejar que un error del consumidor mate el proceso ni el buffer de otros.
    Promise.resolve().then(() => b.alDisparar(b.partes)).catch(e => {
      console.error('[agrupador] error al disparar', clave, e && e.message);
    });
  }

  /**
   * Suma una parte al buffer del lead y programa (o reprograma) el disparo.
   * @param {string}   clave      — normalmente el _id del lead
   * @param {object}   parte      — { text, mid, wasAudio, wasImage, ... } tal cual la quiera el consumidor
   * @param {function} alDisparar — recibe el array de partes en orden de llegada, UNA vez
   * @returns {{ partes: number, esperaMs: number }} cuántas partes lleva y cuánto va a esperar
   */
  function agregar(clave, parte, alDisparar) {
    let b = buffers.get(clave);
    if (!b) {
      b = { partes: [], timer: null, primeraEn: ahora(), alDisparar };
      buffers.set(clave, b);
    }
    b.partes.push(parte);
    b.alDisparar = alDisparar;     // el último gana: mismo consumidor, contexto más fresco
    timers.clearTimeout(b.timer);
    // Si la persona lleva demasiado escribiendo, se responde igual: no se la
    // deja esperando 30 segundos por un buffer.
    const restante = Math.max(0, b.primeraEn + maxMs - ahora());
    const espera = Math.min(esperaMs, restante);
    b.timer = timers.setTimeout(() => disparar(clave), espera);
    return { partes: b.partes.length, esperaMs: espera };
  }

  /** Cuántas partes hay esperando para esta clave (para logs y tests). */
  function pendientes(clave) {
    return buffers.get(clave)?.partes.length || 0;
  }

  return { agregar, pendientes, _buffers: buffers };
}

// Un agrupador para todo el proceso: el webhook lo comparte entre requests.
const agrupadorGlobal = crearAgrupador();

module.exports = { crearAgrupador, agrupadorGlobal, ESPERA_MS, MAX_MS };
