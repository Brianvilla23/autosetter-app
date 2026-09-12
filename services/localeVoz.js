/**
 * Atinov — Perfil de VOZ por país (prefijo del teléfono)
 *
 * Idea de Brayan (2026-09-12): si el agente LLAMA a un lead, ya sabemos su
 * número y, muchas veces, su perfil. Con eso se elige cómo hablarle: trato
 * (tú / vos / usted), modismos, cómo decir la plata y el idioma con el que
 * se transcribe. Antes esto estaba fijo en el prompt ("chileno, nunca
 * voseo"): correcto para Chile, absurdo para un cliente argentino llamando a
 * argentinos.
 *
 * Es un módulo PURO (sin db, sin red) a propósito: se testea solo. El chat de
 * WhatsApp ya tenía su detección por prefijo (`detectCountryStyle` en
 * services/openai.js); esta es la versión para hablar, con bloques más largos
 * porque por voz el registro se nota mucho más que por texto.
 *
 * PRECEDENCIA (de más a menos confiable):
 *   1. lead.pais explícito (lo dijo la persona, o lo puso el dueño)
 *   2. prefijo del teléfono (E.164)
 *   3. account.pais (el país del negocio)
 *   4. 'CL' — Atinov es chileno y sus clientes hoy también
 */

const PERFILES = {
  CL: {
    pais: 'CL', nombre: 'Chile', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Chile.',
    bloque: `
--- REGISTRO DEL PAÍS: CHILE ---
- Tuteo por defecto (tú, tienes, puedes). Nunca voseo argentino ("vos tenés").
- Muletillas seguras, con moderación: "ya", "mira", "al tiro" (significa de inmediato). "Po" solo si la persona lo usa primero. Nunca "cachai" en una llamada de venta.
- La plata en pesos chilenos y en palabras: "ciento treinta y cinco mil pesos".
- Con alguien mayor o muy formal, "usted" desde el inicio.`,
  },
  AR: {
    pais: 'AR', nombre: 'Argentina', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español rioplatense (Argentina).',
    bloque: `
--- REGISTRO DEL PAÍS: ARGENTINA ---
- Voseo PLENO y culto: "vos tenés", "vos sabés", "vos querés", "podés". Nunca mezclar con "tú tienes": a medias suena extranjero.
- Muletillas seguras: "dale", "obvio", "bárbaro". "Che" como apertura casual. Nunca "boludo".
- La plata en pesos argentinos y en palabras. Si el negocio cobra en dólares, dilo como "dólares".`,
  },
  UY: {
    pais: 'UY', nombre: 'Uruguay', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español rioplatense (Uruguay).',
    bloque: `
--- REGISTRO DEL PAÍS: URUGUAY ---
- Voseo pleno: "vos tenés", "vos querés", "dale". Nunca "tú tienes".
- Tono tranquilo y directo. La plata en pesos uruguayos y en palabras.`,
  },
  MX: {
    pais: 'MX', nombre: 'México', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de México.',
    bloque: `
--- REGISTRO DEL PAÍS: MÉXICO ---
- "Usted" con desconocidos y personas mayores; "tú" si la persona es joven o te tutea primero.
- Muletillas seguras: "órale", "sale", "ándale", "qué padre". Diminutivos naturales: "ahorita", "tantito".
- OJO: "al rato" significa MÁS TARDE. Nunca uses "al tiro" (chileno, significa lo contrario).
- La plata en pesos mexicanos y en palabras.`,
  },
  CO: {
    pais: 'CO', nombre: 'Colombia', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Colombia.',
    bloque: `
--- REGISTRO DEL PAÍS: COLOMBIA ---
- "Usted" por defecto, incluso con gente joven: es lo normal y lo cortés. Cambia a "tú" solo si la persona te tutea con claridad.
- Acuse seguro: "listo" (equivale al "ya" chileno). Nunca "parce" ni "qué chimba" en primer contacto.
- La plata en pesos colombianos y en palabras.`,
  },
  PE: {
    pais: 'PE', nombre: 'Perú', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Perú.',
    bloque: `
--- REGISTRO DEL PAÍS: PERÚ ---
- "Usted" es lo seguro en primer contacto comercial; "tú" si la persona te tutea.
- Muletillas seguras: "ya pues", "chévere". Nunca "causa" en una venta.
- La plata en soles y en palabras.`,
  },
  EC: {
    pais: 'EC', nombre: 'Ecuador', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Ecuador.',
    bloque: `
--- REGISTRO DEL PAÍS: ECUADOR ---
- Tuteo cordial; "usted" con personas mayores. Muletillas livianas: "chuta", "full", "bacán" solo si encajan.
- La plata en dólares y en palabras.`,
  },
  VE: {
    pais: 'VE', nombre: 'Venezuela', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Venezuela.',
    bloque: `
--- REGISTRO DEL PAÍS: VENEZUELA ---
- Tuteo cálido. "Chévere" es seguro; "pana" solo si la persona lo usa primero.
- La plata: pregunta si prefiere el precio en dólares o en bolívares antes de decirlo.`,
  },
  ES: {
    pais: 'ES', nombre: 'España', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de España.',
    bloque: `
--- REGISTRO DEL PAÍS: ESPAÑA ---
- Tuteo generalizado, incluso en comercio. Plural "vosotros" con su conjugación, nunca "ustedes" (suena latinoamericano).
- Muletillas seguras: "vale", "venga", "oye". Nunca "tío/tía" en una venta.
- La plata en euros y en palabras.`,
  },
  CR: {
    pais: 'CR', nombre: 'Costa Rica', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Costa Rica.',
    bloque: `
--- REGISTRO DEL PAÍS: COSTA RICA ---
- Voseo suave centroamericano ("vos tenés"), más neutro que el argentino; "usted" también es muy común y siempre correcto.
- "Pura vida" solo si la persona lo dice primero. La plata en colones y en palabras.`,
  },
  GT: {
    pais: 'GT', nombre: 'Guatemala', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Guatemala.',
    bloque: `
--- REGISTRO DEL PAÍS: GUATEMALA ---
- Voseo suave ("vos tenés") o "usted": ambos correctos; sigue el que use la persona.
- La plata en quetzales y en palabras.`,
  },
  NI: {
    pais: 'NI', nombre: 'Nicaragua', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Nicaragua.',
    bloque: `
--- REGISTRO DEL PAÍS: NICARAGUA ---
- Voseo suave ("vos tenés"); "usted" con personas mayores.
- La plata en córdobas y en palabras.`,
  },
  PY: {
    pais: 'PY', nombre: 'Paraguay', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Paraguay.',
    bloque: `
--- REGISTRO DEL PAÍS: PARAGUAY ---
- Voseo ("vos tenés") es lo normal; "usted" con mayores. Tono pausado y cordial.
- La plata en guaraníes y en palabras (los montos son grandes: di "doscientos mil guaraníes", no los dígitos).`,
  },
  BO: {
    pais: 'BO', nombre: 'Bolivia', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español de Bolivia.',
    bloque: `
--- REGISTRO DEL PAÍS: BOLIVIA ---
- "Usted" en primer contacto; "tú" si la persona te tutea. Tono respetuoso y sin apuro.
- La plata en bolivianos y en palabras.`,
  },
  US: {
    pais: 'US', nombre: 'Estados Unidos (mercado hispano)', idioma: 'es', vozSugerida: 'marin',
    promptTranscripcion: 'Conversación en español latino con posibles palabras en inglés.',
    bloque: `
--- REGISTRO DEL PAÍS: ESTADOS UNIDOS (persona hispana) ---
- Español neutro latinoamericano: sin marcar regionalismos fuertes, porque la gente viene de muchos países.
- Tuteo cordial; "usted" con personas mayores. Algo de inglés suelto es natural ("okay", "sale") si la persona lo usa.
- Si la persona te contesta en inglés, cambia a inglés y quédate ahí.
- La plata en dólares y en palabras.`,
  },
  EN: {
    pais: 'EN', nombre: 'Inglés (EE.UU.)', idioma: 'en', vozSugerida: 'marin',
    promptTranscripcion: 'Phone conversation in US English.',
    bloque: `
--- LANGUAGE: US ENGLISH ---
- Speak natural, friendly US English. Short turns, one idea at a time, casual but professional ("sure", "got it", "sounds good").
- Say prices and times in words ("a hundred and thirty-five dollars", "three thirty in the afternoon").
- If the person switches to Spanish, switch with them and stay there.`,
  },
};

/** Prefijo E.164 → país. Se prueba el más largo primero (3, 2, 1 dígitos). */
const PREFIJOS = {
  '56': 'CL', '54': 'AR', '598': 'UY', '52': 'MX', '57': 'CO', '51': 'PE',
  '593': 'EC', '58': 'VE', '34': 'ES', '506': 'CR', '502': 'GT', '505': 'NI',
  '595': 'PY', '591': 'BO', '1': 'US',
};

function normalizarPais(v) {
  const c = String(v || '').trim().toUpperCase();
  return PERFILES[c] ? c : null;
}

function paisDesdeTelefono(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  for (const n of [3, 2, 1]) {
    const p = digits.slice(0, n);
    if (PREFIJOS[p]) return PREFIJOS[p];
  }
  return null;
}

/**
 * Devuelve el perfil con el que hay que hablarle a esta persona.
 * `lead.idioma === 'en'` fuerza inglés (persona de EE.UU. que habla inglés).
 */
function perfilPara({ telefono, lead, account } = {}) {
  const explicito   = normalizarPais(lead && (lead.pais || lead.locale_pais));
  const porTelefono = paisDesdeTelefono(telefono || (lead && (lead.wa_id || lead.phone || lead.telefono)));
  const porCuenta   = normalizarPais(account && account.pais);
  let codigo = explicito || porTelefono || porCuenta || 'CL';
  let origen = explicito ? 'lead' : porTelefono ? 'telefono' : porCuenta ? 'cuenta' : 'default';

  if (lead && String(lead.idioma || '').toLowerCase() === 'en') { codigo = 'EN'; origen = 'lead'; }

  return { ...PERFILES[codigo], origen };
}

module.exports = { PERFILES, PREFIJOS, paisDesdeTelefono, perfilPara, normalizarPais };
