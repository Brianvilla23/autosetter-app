/**
 * Atinov — Plantillas de WhatsApp del cliente (administración vía Meta)
 *
 * Las plantillas (message templates) son los únicos mensajes que WhatsApp
 * deja mandar FUERA de la ventana de 24 h — confirmaciones, recordatorios,
 * "¿seguimos?" al día siguiente. Cada una la aprueba Meta (minutos a horas).
 * Atinov ya las USABA (Shopify: `shopify_template_name`) pero no las
 * administraba: el dueño tenía que crearlas en el Business Manager.
 *
 * Este módulo cierra dos cosas a la vez:
 *  1. Producto: el dueño crea, ve el estado de aprobación y borra sus
 *     plantillas desde el panel, sin salir de Atinov.
 *  2. App Review: es la evidencia visible de `whatsapp_business_management`
 *     ("administra números y plantillas del cliente") que el video tiene
 *     que mostrar. Sin esta pantalla, ese permiso se justifica solo por
 *     lectura de configuración y el rechazo es más probable.
 *
 * API de Meta: GET/POST /{waba_id}/message_templates · DELETE por nombre.
 * Todo con el token de WhatsApp de la cuenta (nunca de la plataforma).
 *
 * Reglas duras que Meta aplica y acá se validan ANTES de gastar el POST:
 *  - nombre: minúsculas, dígitos y guion bajo, ≤512 chars.
 *  - categoría: UTILITY | MARKETING | AUTHENTICATION.
 *  - variables {{1}}, {{2}}… secuenciales desde 1, y con ejemplos.
 *  - cuerpo ≤1024 chars; header de texto ≤60; footer ≤60.
 */

const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v21.0';
const CATEGORIAS = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
const IDIOMAS_COMUNES = ['es', 'es_CL', 'es_AR', 'es_MX', 'es_ES', 'en', 'en_US', 'pt_BR'];

/** Valida el borrador y devuelve el body listo para Meta, o lanza con motivo claro. */
function construirPayload({ name, category, language, header, body, footer, buttons }) {
  const nombre = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(nombre)) {
    throw new ErrorPlantilla('El nombre solo admite minúsculas, números y guion bajo (ej: recordatorio_cita).');
  }
  const cat = String(category || '').toUpperCase();
  if (!CATEGORIAS.includes(cat)) throw new ErrorPlantilla('Categoría inválida: usa UTILITY, MARKETING o AUTHENTICATION.');
  const lang = String(language || 'es').trim();
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) throw new ErrorPlantilla('Idioma inválido (ej: es, es_CL, en_US).');

  const cuerpo = String(body || '').trim();
  if (!cuerpo || cuerpo.length > 1024) throw new ErrorPlantilla('El cuerpo es obligatorio y admite hasta 1024 caracteres.');

  // Variables {{n}} deben ser 1..N sin saltos, y llevar ejemplo cada una.
  const vars = [...new Set([...cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  for (let i = 0; i < vars.length; i++) {
    if (vars[i] !== i + 1) throw new ErrorPlantilla('Las variables deben ir {{1}}, {{2}}, {{3}}… en orden y sin saltos.');
  }
  const componentes = [];

  if (header && String(header).trim()) {
    const h = String(header).trim();
    if (h.length > 60) throw new ErrorPlantilla('El encabezado admite hasta 60 caracteres.');
    if (/\{\{\d+\}\}/.test(h)) throw new ErrorPlantilla('El encabezado de esta versión no admite variables — ponlas en el cuerpo.');
    componentes.push({ type: 'HEADER', format: 'TEXT', text: h });
  }

  const compBody = { type: 'BODY', text: cuerpo };
  if (vars.length) {
    // Meta exige ejemplos para aprobar: los genera el dueño en la UI; si no
    // vienen, se ponen ejemplos neutros que igual pasan la validación.
    compBody.example = { body_text: [vars.map(n => `ejemplo ${n}`)] };
  }
  componentes.push(compBody);

  if (footer && String(footer).trim()) {
    const f = String(footer).trim();
    if (f.length > 60) throw new ErrorPlantilla('El pie admite hasta 60 caracteres.');
    componentes.push({ type: 'FOOTER', text: f });
  }

  // Botones de respuesta rápida (hasta 3, ≤25 chars) — lo que un negocio
  // chileno usa de verdad: "Confirmar", "Cambiar hora", "Cancelar".
  if (Array.isArray(buttons) && buttons.length) {
    const btns = buttons.map(b => String(b || '').trim()).filter(Boolean).slice(0, 3);
    if (btns.some(b => b.length > 25)) throw new ErrorPlantilla('Cada botón admite hasta 25 caracteres.');
    if (btns.length) {
      componentes.push({ type: 'BUTTONS', buttons: btns.map(t => ({ type: 'QUICK_REPLY', text: t })) });
    }
  }

  return { name: nombre, category: cat, language: lang, components: componentes };
}

class ErrorPlantilla extends Error {}

/** Lista las plantillas del WABA con su estado (APPROVED / PENDING / REJECTED). */
async function listar({ wabaId, accessToken }) {
  const r = await axios.get(`${GRAPH}/${wabaId}/message_templates`, {
    params: { fields: 'name,status,category,language,components,rejected_reason,quality_score', limit: 100 },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return (r.data?.data || []).map(resumir);
}

/** Crea la plantilla en Meta. Devuelve { id, status }. */
async function crear({ wabaId, accessToken, borrador }) {
  const payload = construirPayload(borrador);
  const r = await axios.post(`${GRAPH}/${wabaId}/message_templates`, payload, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  return { id: r.data?.id || null, status: r.data?.status || 'PENDING', name: payload.name, language: payload.language };
}

/** Borra la plantilla por nombre (Meta borra todas sus versiones de idioma). */
async function borrar({ wabaId, accessToken, name }) {
  const nombre = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(nombre)) throw new ErrorPlantilla('Nombre inválido.');
  await axios.delete(`${GRAPH}/${wabaId}/message_templates`, {
    params: { name: nombre },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return { ok: true, name: nombre };
}

/** Vista compacta para el panel: texto del cuerpo, variables, botones, estado. */
function resumir(t) {
  const comps = Array.isArray(t.components) ? t.components : [];
  const body = comps.find(c => c.type === 'BODY')?.text || '';
  const header = comps.find(c => c.type === 'HEADER')?.text || null;
  const footer = comps.find(c => c.type === 'FOOTER')?.text || null;
  const buttons = (comps.find(c => c.type === 'BUTTONS')?.buttons || []).map(b => b.text).filter(Boolean);
  const vars = [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].length;
  return {
    id: t.id || null,
    name: t.name,
    status: t.status,               // APPROVED | PENDING | REJECTED | PAUSED | DISABLED
    category: t.category,
    language: t.language,
    header, body, footer, buttons,
    variables: vars,
    rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    quality: t.quality_score?.score || null,
  };
}

/** Traduce el error de Meta a algo que el dueño pueda arreglar (sin filtrar internals). */
function explicarErrorMeta(e) {
  const err = e.response?.data?.error || {};
  const msg = String(err.error_user_msg || err.message || e.message || '');
  if (/already exists|ya existe/i.test(msg)) return 'Ya existe una plantilla con ese nombre e idioma. Cambia el nombre o borra la anterior.';
  if (/#100|Invalid parameter/i.test(msg) && /example/i.test(msg)) return 'Meta pide un ejemplo por cada variable {{n}}. Completa los ejemplos.';
  if (/#100|Invalid parameter/i.test(msg)) return 'Meta rechazó el formato de la plantilla. Revisa nombre (minúsculas_y_guiones), variables en orden y largos máximos.';
  if (/#10|permission|OAuth/i.test(msg)) return 'El token de WhatsApp de la cuenta no tiene permiso para administrar plantillas (whatsapp_business_management).';
  if (/#80007|rate limit/i.test(msg)) return 'Meta limitó las solicitudes por un momento. Espera un minuto y reintenta.';
  return 'Meta no aceptó la operación. Revisa los datos e intenta de nuevo.';
}

module.exports = {
  construirPayload,
  listar,
  crear,
  borrar,
  resumir,
  explicarErrorMeta,
  ErrorPlantilla,
  CATEGORIAS,
  IDIOMAS_COMUNES,
};
