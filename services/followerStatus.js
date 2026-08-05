/**
 * Atinov — ¿esta persona te sigue?
 *
 * Cambia el guion del agente en el momento que más importa: no es lo mismo
 * hablarle a alguien que ya te sigue hace meses que a un desconocido que llegó
 * por un reel.
 *
 * LÍMITE REAL DE META (no es un capricho del código): estos datos solo se
 * entregan si la persona TE ESCRIBIÓ — eso cuenta como consentimiento. Quien
 * solo comentó un post y nunca mandó un DM devuelve error. Por eso se consulta
 * al recibir mensajes, no al recibir comentarios.
 *
 * Todo es best-effort: si no se puede saber, el agente responde exactamente
 * como responde hoy. Nunca bloquea ni retrasa una respuesta por esto.
 */

const db = require('../db/database');

// Cuánto vale el dato antes de volver a preguntarlo. Seguir/dejar de seguir
// no es algo que pase cada hora, y cada consulta gasta cuota de la API.
const VIGENCIA_DIAS = 7;
// Si la consulta falló, no vale quemar una semana de caché: pudo ser un
// timeout o un token en refresh. Se reintenta al día siguiente.
const REINTENTO_HORAS = 24;

/** ¿Hay que (re)consultar el estado de seguidor de este lead? */
function necesitaChequeo(lead) {
  if (!lead) return false;
  // Solo Instagram: en WhatsApp no existe el concepto.
  const esIG = !lead.channel || lead.channel === 'instagram';
  if (!esIG || !lead.ig_user_id) return false;
  if (!lead.follow_checked_at) return true;
  const edad = Date.now() - new Date(lead.follow_checked_at).getTime();
  if (!Number.isFinite(edad)) return true;
  const ventana = lead.follow_probe_failed ? REINTENTO_HORAS * 36e5 : VIGENCIA_DIAS * 864e5;
  return edad > ventana;
}

/**
 * Consulta y guarda el estado en el lead. Devuelve el lead actualizado
 * (o el original si no se pudo consultar).
 */
async function refrescarEstado(lead, account) {
  if (!necesitaChequeo(lead) || !account?.access_token) return lead;
  try {
    const { getUserProfileFull } = require('./meta');
    const perfil = await getUserProfileFull({
      igsid: lead.ig_user_id,
      accessToken: account.access_token,
      igUserId: account.ig_platform_id || account.ig_user_id,
      pageToken: account.fb_page_token || null,   // segundo intento si hay Página
    });
    // La consulta se marca igual aunque falle: sin esto reintentaríamos en
    // CADA mensaje de alguien que solo comentó, gastando cuota para nada.
    const upd = { follow_checked_at: new Date().toISOString(), follow_probe_failed: !perfil };
    if (perfil) {
      if (perfil.teSigue !== null)       upd.te_sigue = perfil.teSigue;
      if (perfil.followerCount !== null) upd.follower_count = perfil.followerCount;
      upd.verificado = !!perfil.verificado;   // simétrico: si lo perdió, se refleja
      // Aprovechar para corregir el username si veníamos con el ID numérico
      if (perfil.username && (!lead.ig_username || lead.ig_username === lead.ig_user_id)) {
        upd.ig_username = perfil.username;
      }
    }
    await db.update(db.leads, { _id: lead._id }, upd).catch(() => null);
    return { ...lead, ...upd };
  } catch (e) {
    return lead;
  }
}

/**
 * Bloque para el prompt. Devuelve null si no sabemos nada — así el agente se
 * comporta igual que hoy en vez de recibir un "no sé si te sigue" que lo
 * confunda.
 */
function buildFollowerContext(lead, { esMencion = false } = {}) {
  if (!lead || typeof lead.te_sigue !== 'boolean') return null;
  const lineas = ['--- RELACIÓN DE ESTA PERSONA CON TU CUENTA ---'];

  if (lead.te_sigue) {
    lineas.push('YA TE SIGUE en Instagram.');
    lineas.push('Trátala como alguien que ya te conoce: nada de presentaciones largas ni de explicar quién eres, y NUNCA le pidas que te siga. Puedes dar por sabido lo básico de tu negocio e ir directo a lo que necesita.');
  } else if (esMencion) {
    // Quien te menciona en su historia obviamente sabe quién eres: pedirle que
    // te siga o presentarse ahí suena a robot y contradice el agradecimiento.
    lineas.push('No te sigue en Instagram, pero te mencionó en su historia: te conoce igual. No te presentes ni le pidas que te siga.');
  } else {
    lineas.push('NO te sigue todavía — probablemente llegó por un post, un reel o un anuncio.');
    lineas.push('Es su primer contacto contigo: ubícala en una línea (qué haces y para quién) antes de entrar en detalles, y no des por sabido nada de tu negocio. Si la conversación va bien y hay un momento natural, puedes invitarla a seguirte para no perder el contacto — una sola vez, sin insistir y nunca como condición para ayudarla.');
  }

  if (Number.isFinite(lead.follower_count)) {
    if (lead.follower_count >= 10000) {
      lineas.push(`Ojo: tiene ${lead.follower_count.toLocaleString('es-CL')} seguidores. Puede ser una cuenta con audiencia — trátala con especial cuidado y, si la conversación lo permite, avísale al dueño que podría interesar una colaboración.`);
    } else if (lead.follower_count > 0 && lead.follower_count < 15) {
      // > 0 a propósito: un 0 devuelto por la API (dato ausente) no puede
      // degradar la atención a un cliente legítimo. Y el umbral es bajo porque
      // los clientes de un negocio local tienen cuentas personales chicas.
      lineas.push('Tiene muy pocos seguidores: podría ser una cuenta nueva. No la trates distinto ni la acuses de nada; solo evita ofrecer descuentos especiales o datos sensibles sin más contexto.');
    }
  }

  if (lead.verificado) {
    lineas.push('Su cuenta está verificada por Instagram.');
  }

  return lineas.join('\n');
}

module.exports = { necesitaChequeo, refrescarEstado, buildFollowerContext, VIGENCIA_DIAS };
