/**
 * Atinov — Invitación al closer en vivo (voz para un LEAD, sin sesión).
 *
 * EL PROBLEMA QUE RESUELVE
 * `/api/voice/token` exige sesión iniciada, y con razón: un endpoint abierto
 * que acuña tokens de OpenAI es una canilla libre contra la tarjeta del dueño.
 * Pero un prospecto NO tiene login. Necesita entrar sin cuenta y aun así no
 * debe poder abrir sesiones a discreción.
 *
 * LA SOLUCIÓN
 * Una invitación firmada, atada a UN lead, de UN solo uso y con vencimiento —
 * mismo principio que el `state` firmado del OAuth de Google Calendar, pero
 * más estricto porque acá cada sesión cuesta plata:
 *
 *  1. FIRMA HMAC   → nadie puede fabricar una invitación para otro lead.
 *  2. VENCIMIENTO  → un link filtrado deja de servir solo.
 *  3. UN SOLO USO  → en la base se guarda el HASH del nonce, nunca el token
 *                    (mismo patrón que el reset de contraseña). Al usarse se
 *                    borra, así el mismo link no abre dos sesiones.
 *
 * FAIL-CLOSED: sin `JWT_SECRET` en el entorno no se firma nada y `signInvite`
 * devuelve null → el agente simplemente no ofrece el closer. Nunca cae en un
 * secreto por defecto: eso volvería falsificable toda invitación en producción.
 */

const crypto = require('crypto');

const VIGENCIA_MIN = 30;   // el lead está caliente AHORA; 30 min es de sobra
const SIG_LEN      = 32;   // igual que calendar.signState

const secreto = () => process.env.JWT_SECRET || '';

function firmar(payload) {
  return crypto.createHmac('sha256', secreto()).update(payload).digest('hex').slice(0, SIG_LEN);
}

function hashNonce(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

/**
 * Crea una invitación para un lead.
 * Devuelve null si no hay JWT_SECRET (módulo inerte, sin secreto por defecto).
 *
 * El llamador DEBE persistir `hash` y `expiresAt` en el lead
 * (`voice_invite_hash`, `voice_invite_expires`) y mandar solo `token`.
 *
 * @returns {{token:string, hash:string, expiresAt:string}|null}
 */
function signInvite({ leadId, accountId }) {
  if (!secreto() || !leadId || !accountId) return null;

  const nonce   = crypto.randomBytes(16).toString('hex');
  const exp     = Date.now() + VIGENCIA_MIN * 60 * 1000;
  const payload = `${leadId}.${accountId}.${exp}.${nonce}`;
  const token   = Buffer.from(`${payload}.${firmar(payload)}`).toString('base64url');

  return { token, hash: hashNonce(nonce), expiresAt: new Date(exp).toISOString() };
}

/**
 * Valida firma y vencimiento. NO comprueba el uso único: eso exige leer el
 * lead y lo hace `matchesStoredHash` desde la ruta.
 *
 * @returns {{leadId:string, accountId:string, nonce:string}|null}
 */
function verifyInvite(token) {
  try {
    if (!secreto() || !token) return null;

    const partes = Buffer.from(String(token), 'base64url').toString().split('.');
    if (partes.length !== 5) return null;

    const [leadId, accountId, expStr, nonce, sig] = partes;
    if (!leadId || !accountId || !expStr || !nonce || !sig) return null;

    if (Number(expStr) < Date.now()) return null;

    // Comparación en tiempo constante: comparar con === filtra información por
    // cuánto tarda en fallar.
    const esperado = firmar(`${leadId}.${accountId}.${expStr}.${nonce}`);
    const a = Buffer.from(esperado);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    return { leadId, accountId, nonce };
  } catch {
    return null;
  }
}

/**
 * ¿El nonce de la invitación calza con el hash guardado en el lead?
 * Acá se cae un link ya usado (el hash se borró) o uno de una invitación vieja
 * que fue reemplazada por otra más nueva.
 */
function matchesStoredHash(nonce, storedHash) {
  if (!nonce || !storedHash) return false;
  const a = Buffer.from(hashNonce(nonce));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Arma el link que se le manda al lead por el chat. */
function buildInviteUrl(token) {
  const base = process.env.APP_URL || 'https://atinov.com';
  return `${base}/hablar.html?t=${encodeURIComponent(token)}`;
}

module.exports = { signInvite, verifyInvite, matchesStoredHash, buildInviteUrl, VIGENCIA_MIN };
