/**
 * Atinov — El PLAN de supresión (Ley 21.719 + eliminación de datos de Meta)
 *
 * Solo listas. SIN require de db, a propósito: así el test puede verificar qué
 * se borra y por qué campo sin cargar la cadena de NeDB. (Correr dos archivos
 * de test que abren los mismos .db en paralelo dispara EPERM en la compactación
 * — mismo motivo por el que services/channels/core.js está separado.)
 *
 * La ejecución vive en services/supresion.js.
 */

/**
 * Colecciones que se limpian por cuenta, con el campo por el que se indexan.
 *
 * El esquema NO es uniforme: unas usan `account_id` y otras `accountId`.
 * Equivocarse en el nombre no lanza error — borra cero documentos en silencio
 * y deja dato personal vivo después de haberle prometido al titular que se
 * eliminó. Por eso va explícito, colección por colección, y con test.
 */
const POR_CUENTA = [
  ['followups',        'account_id'],
  ['pedidoTasks',      'account_id'],
  ['campanas',         'account_id'],
  ['pendingSends',     'accountId'],
  ['failedSends',      'accountId'],
  ['llamadas',         'account_id'],
  ['agents',           'account_id'],
  ['knowledge',        'account_id'],
  ['knowledgeSources', 'account_id'],
  ['links',            'account_id'],
  ['bypassed',         'account_id'],
  ['settings',         'account_id'],
  ['magnetLinks',      'account_id'],
  ['linkClicks',       'account_id'],
  ['leadMagnets',      'account_id'],
  ['magnetDeliveries', 'account_id'],
  ['postRules',        'account_id'],
  ['improvements',     'account_id'],
  ['quickReplies',     'account_id'],
  ['aiUsage',          'accountId'],
];

/** Colecciones que cuelgan del usuario, no de la cuenta. */
const POR_USUARIO = [
  ['emailLog',  'userId'],       // guarda la dirección de correo: dato personal
  ['referrals', 'referrer_id'],
];

/**
 * Lo que sobrevive a la supresión, y por qué.
 *
 * No alcanza con no borrarlos: la excepción tiene que estar escrita, porque
 * /data-deletion §3 se la declara al titular. Si el código y la página no
 * dicen lo mismo, la página es una promesa falsa.
 */
const CONSERVADO = {
  billableEvents: 'retención contable (sin contenido de conversaciones)',
  auditLog:       'rastro de la propia supresión',
};

module.exports = { POR_CUENTA, POR_USUARIO, CONSERVADO };
