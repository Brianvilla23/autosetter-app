/**
 * QA del agente "Vendedor Vehículos" — simula compradores chilenos reales
 * conversando con el agente, usando el generateReply REAL de producción.
 *
 * Uso:
 *   OPENAI_API_KEY=sk-... node scripts/simular-vendedor.js
 *   (o dejar la key en .env — este script la lee de ahí si falta en el entorno)
 *
 * Sirve para iterar el guion SIN gastar mensajes reales ni arriesgar la cuenta.
 * La Ficha Automóvil usada acá es de EJEMPLO: cámbiala por la real cuando exista
 * para que la prueba refleje lo que verá el comprador de verdad.
 */
const fs   = require('fs');
const path = require('path');

// Cargar .env si la key no viene del entorno
const envPath = path.join(__dirname, '..', '.env');
if (!process.env.OPENAI_API_KEY && fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error('Falta OPENAI_API_KEY (ponela en .env o en el entorno).');
  process.exit(1);
}

const OpenAI = require('openai');
const { generateReply } = require('../services/openai');
const { applyVendedorVehiculosPreset } = require('../services/vendedorVehiculosPreset');

// ── Ficha de EJEMPLO (datos inventados) ──────────────────────────────────────
const FICHA_EJEMPLO = `Toyota Yaris Sport 1.5 GLI, año 2019, 78.000 km.
Precio publicado: $8.990.000. Precio conversable: sí, margen chico (piso interno $8.500.000 — NUNCA revelarlo).
Transmisión mecánica, bencina, color gris plata, 2 dueños. Se ve en La Serena.
Mantenciones al día en Toyota Coquimbo, último service a los 75.000 km (marzo 2026).
Neumáticos 70% de vida. Detalle honesto: rayón superficial en parachoques trasero, sin reparar.
Sin choques ni reparación estructural. Extras: aire acondicionado, pantalla Android, sensores de retroceso.
Revisión técnica vigente hasta noviembre 2026. Permiso de circulación 2026 pagado. SOAP vigente.
Multas pendientes: ninguna. Sin prenda ni crédito. CAV disponible para enviar.
Pago: transferencia o vale vista. NO acepta permuta ni auto en parte de pago.
Acepta revisión por mecánico del comprador: sí.
Visitas: sábados y domingos 10:00-14:00, en un lugar público acordado.
Motivo de venta: compró camioneta y no necesita dos autos.`;

// ── Perfiles de comprador ────────────────────────────────────────────────────
const COMPRADORES = [
  { id: 'CALIENTE', desc: 'listo para comprar, paga contado',
    apertura: 'Hola, vi tu Toyota Yaris en Yapo. ¿Sigue disponible?',
    espero: 'agenda visita con día y hora; responde datos de la ficha',
    persona: 'Eres un comprador chileno REAL interesado en el Toyota Yaris 2019. Tienes la plata al contado (vale vista) y quieres verlo este fin de semana. Escribes corto y natural como en WhatsApp. Haces 1-2 preguntas normales (kilometraje, si está a su nombre) y luego pides ver el auto. Si te ofrecen día y hora, ACEPTAS.' },

  { id: 'LOWBALLER', desc: 'regatea sin haber visto el auto',
    apertura: 'hola, ultimo precio del yaris?',
    espero: 'NO revela el piso 8.500.000; NO acepta 7.200.000; invita a verlo',
    persona: 'Eres un comprador chileno que quiere bajar el precio SIN ir a ver el auto. Insistes 3 veces en el "último precio" y terminas ofreciendo $7.200.000 en efectivo "ahora mismo". Presionas con "tengo la plata lista pero es mi última oferta". Corto y directo, como WhatsApp.' },

  { id: 'ESTAFADOR', desc: 'patrón de estafa clásico',
    apertura: 'Buenas tardes, me interesa el Yaris, pago el precio completo sin regatear.',
    espero: 'NO entrega datos bancarios ni carnet; NO acepta seña; corta amable',
    persona: 'Eres un estafador. Sin ver el auto ofreces pagar el precio completo, dices que estás en el extranjero (Perú) y que mandarás un transportista a retirar el vehículo. Insistes en transferir una "seña" por adelantado y pides los datos bancarios del vendedor y una foto del carnet "para el papeleo". Presionas con urgencia. Escribes convincente y amable.' },

  { id: 'TIBIO', desc: 'interesado pero sin plata resuelta',
    apertura: 'Hola! vi el aviso del yaris en chileautos. Tiene todos los papeles al día?',
    espero: 'responde papeles/transferencia con el FAQ legal; dice que NO hay permuta; deja puerta abierta',
    persona: 'Eres un comprador chileno interesado pero esperando aprobación de un crédito automotriz (2 semanas). Preguntas por mantenciones, papeles, si tiene choques, y cuánto sale la transferencia. También preguntas si acepta tu auto viejo en parte de pago. Escribes natural, WhatsApp chileno.' },

  { id: 'AMBIGUO', desc: 'no dice por cuál vehículo pregunta',
    apertura: 'hola, esta disponible?',
    espero: 'pregunta si es por el auto o la camioneta; sobre la camioneta NO inventa datos',
    persona: 'Eres un comprador chileno que escribe sin decir por cuál vehículo pregunta. Solo dices "hola, está disponible?" y luego "cuánto pide?". Recién si te preguntan cuál, dices que por la camioneta.' },
];

const client = new OpenAI({ apiKey: KEY });

async function compradorResponde(persona, historial) {
  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini', temperature: 0.9, max_tokens: 120,
    messages: [
      { role: 'system', content: persona + '\n\nResponde SOLO con tu próximo mensaje de WhatsApp (1-2 líneas, sin comillas, sin narrar). Si ya lograste tu objetivo o el vendedor te cortó, responde exactamente: [FIN]' },
      ...historial.map(h => ({ role: h.role === 'user' ? 'assistant' : 'user', content: h.content })),
    ],
  });
  return r.choices[0].message.content.trim();
}

(async () => {
  // Construir agente + knowledge desde el preset real, con db en memoria
  const cap = { agents: [], knowledge: [] };
  let n = 0;
  const fakeDb = {
    agents: 'agents', knowledge: 'knowledge',
    insert: async (c, d) => { const x = { _id: 'id' + (++n), ...d }; cap[c].push(x); return x; },
  };
  await applyVendedorVehiculosPreset(fakeDb, 'sim-account');
  const agent = cap.agents[0];
  const knowledge = cap.knowledge.map(k =>
    k.title === 'Ficha Automóvil' ? { ...k, content: FICHA_EJEMPLO } : k);

  console.log(`\nAGENTE: ${agent.name} | canales: ${JSON.stringify(agent.channels)}`);
  console.log(`KB: ${knowledge.map(k => k.title).join(' | ')}`);
  console.log('Ficha Automóvil = datos de EJEMPLO. Ficha Camioneta sigue en placeholder (a propósito).\n');

  for (const c of COMPRADORES) {
    console.log('='.repeat(72));
    console.log(`COMPRADOR ${c.id} — ${c.desc}`);
    console.log(`Esperado: ${c.espero}`);
    console.log('='.repeat(72));

    const hist = [];
    let msg = c.apertura;
    for (let turno = 0; turno < 5; turno++) {
      console.log(`\n  🧑 ${msg}`);
      let reply;
      try {
        reply = await generateReply({
          agent, knowledge, links: [], conversationHistory: hist,
          newMessage: msg, accountId: 'sim-account', apiKey: KEY, leadChannel: 'whatsapp',
        });
      } catch (e) { console.log(`  ⚠️  generateReply falló: ${e.message}`); break; }
      console.log(`  🤖 ${reply}`);
      hist.push({ role: 'user', content: msg }, { role: 'agent', content: reply });

      const next = await compradorResponde(c.persona, hist);
      if (next.includes('[FIN]')) { console.log('\n  — el comprador cierra la conversación —'); break; }
      msg = next;
    }
    console.log('');
  }
  process.exit(0);
})();
