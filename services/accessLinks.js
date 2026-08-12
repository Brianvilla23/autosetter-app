/**
 * Atinov — Links de acceso directo al agente, por canal
 *
 * Un negocio necesita UNA cosa para que le lleguen leads: que escribirle
 * cueste un solo toque. Cada plataforma tiene su puerta oficial:
 *
 *   Instagram → https://ig.me/m/<usuario>?text=...   (ya existía)
 *   WhatsApp  → https://wa.me/<dígitos>?text=...     (link universal oficial)
 *   Messenger → https://m.me/<página>?ref=...        (Facebook)
 *
 * Los tres se sirven detrás de /go/<slug> (server.js), que registra el click
 * y redirige — así el tracking funciona igual si el link va en la bio, en un
 * ad o impreso como QR en el mostrador.
 *
 * ⚠️ Diferencia que importa: wa.me e ig.me aceptan texto pre-escrito
 * (?text=) — útil para que el lead llegue con la keyword de un agente.
 * m.me NO acepta texto: solo lleva un ?ref= que Meta entrega como metadato
 * del webhook. Por eso acá el ref es el slug (atribución), no un mensaje.
 */

/**
 * Normaliza un número "visible" a los dígitos que exige wa.me.
 * "+56 9 8566 6043" → "56985666043". Devuelve null si no hay confianza:
 * mejor no generar el link que generar uno que abre el chat de un extraño.
 */
function digitosWhatsapp(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.replace(/^00+/, '');
  if (d.length === 9 && d.startsWith('9')) d = `56${d}`;   // celular chileno pelado
  // Con código de país: entre 10 y 15 dígitos (E.164). Menos que eso es un
  // número local ambiguo; más, basura.
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

const CANALES = ['instagram', 'whatsapp', 'messenger'];

/**
 * Construye la URL destino de un magnet link según su canal.
 * Los links viejos no tienen `channel` → Instagram (comportamiento original).
 * Devuelve null si al link le faltan los datos de su canal (fail-closed:
 * /go redirige a la home antes que a un destino roto).
 */
function buildMagnetTarget(link) {
  const canal = CANALES.includes(link?.channel) ? link.channel : 'instagram';

  if (canal === 'whatsapp') {
    const digitos = digitosWhatsapp(link.wa_digits);
    if (!digitos) return null;
    let url = `https://wa.me/${digitos}`;
    if (link.preset_text) url += `?text=${encodeURIComponent(link.preset_text)}`;
    return url;
  }

  if (canal === 'messenger') {
    const pagina = String(link.fb_page || '').trim().replace(/^@/, '');
    if (!pagina || !/^[\w.\-]+$/.test(pagina)) return null;
    // ref = slug: llega como metadato del webhook (messaging_referrals) y
    // sirve para atribución futura. m.me no soporta texto pre-escrito.
    return `https://m.me/${encodeURIComponent(pagina)}?ref=${encodeURIComponent(link.slug || '')}`;
  }

  // Instagram (default y legacy)
  const usuario = String(link.ig_username || '').replace(/^@/, '');
  if (!usuario) return null;
  let url = `https://ig.me/m/${encodeURIComponent(usuario)}`;
  if (link.preset_text) url += `?text=${encodeURIComponent(link.preset_text)}`;
  return url;
}

const CANAL_LABEL = {
  instagram: { emoji: '📷', nombre: 'Instagram' },
  whatsapp:  { emoji: '📱', nombre: 'WhatsApp' },
  messenger: { emoji: '📨', nombre: 'Messenger' },
};

module.exports = { digitosWhatsapp, buildMagnetTarget, CANALES, CANAL_LABEL };
