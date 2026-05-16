/**
 * Atinov — Pipeline CRM
 *
 * Fuente única de verdad de las etapas del embudo de ventas.
 * Cambiar AQUÍ = cambia en toda la app (UI Kanban, export CSV, auto-progresión).
 *
 * Por ahora en español. Cuando se internacionalice, agregar `name_en`.
 *
 * `auto`: si true, el sistema puede mover el lead a esta etapa
 * automáticamente (ej: bot respondió → "contactado"). Las etapas
 * sin `auto` solo se setean manualmente por el usuario (drag&drop / botón).
 */

const STAGES = [
  { id: 'nuevo',      name: 'Nuevo',          order: 1, color: '#64748b', auto: true,  desc: 'Llegó el DM, sin atender todavía' },
  { id: 'contactado', name: 'Contactado',     order: 2, color: '#0ea5e9', auto: true,  desc: 'El asistente ya respondió al menos una vez' },
  { id: 'calificado', name: 'Calificado',     order: 3, color: '#10b981', auto: true,  desc: 'Mostró intención real de comprar (HOT)' },
  { id: 'demo',       name: 'Demo / Llamada', order: 4, color: '#06b6d4', auto: false, desc: 'Agendó o tuvo la llamada/demo' },
  { id: 'propuesta',  name: 'Propuesta',      order: 5, color: '#f59e0b', auto: false, desc: 'Le pasaste precio / oferta' },
  { id: 'ganado',     name: 'Ganado',         order: 6, color: '#22c55e', auto: true,  desc: 'Cerró y pagó' },
  { id: 'perdido',    name: 'Perdido',        order: 7, color: '#ef4444', auto: false, desc: 'Dijo que no o ghost definitivo' },
];

const STAGE_IDS = STAGES.map(s => s.id);
const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));

/**
 * Mapeo automático qualification (hot/warm/cold) → pipeline_stage,
 * solo si el lead todavía está en una etapa "temprana" y automática.
 * No pisa etapas manuales avanzadas (demo/propuesta/ganado/perdido).
 */
function autoStageFromQualification(currentStage, qualification, isConverted) {
  if (isConverted) return 'ganado';
  // No degradar: si ya está en demo/propuesta/ganado/perdido, no tocar.
  const advanced = ['demo', 'propuesta', 'ganado', 'perdido'];
  if (advanced.includes(currentStage)) return currentStage;
  if (qualification === 'hot')  return 'calificado';
  if (qualification === 'warm' || qualification === 'cold') {
    // warm/cold: si todavía es "nuevo", pasa a "contactado" (el bot ya habló)
    return currentStage === 'nuevo' ? 'contactado' : currentStage;
  }
  return currentStage || 'nuevo';
}

function isValidStage(id) {
  return STAGE_IDS.includes(id);
}

module.exports = { STAGES, STAGE_IDS, STAGE_BY_ID, autoStageFromQualification, isValidStage };
