/**
 * Atinov — Visión (fotos entrantes)
 *
 * El lead manda una foto (el auto que vende, su sonrisa para la clínica,
 * el depto) y hoy el agente la ignora. Esta capa la describe con GPT-4o-mini
 * (multimodal, ya lo pagamos) y la inyecta al pipeline de texto como
 * "[Foto enviada por el lead] <descripción>" — mismo patrón que las notas
 * de voz: dos adaptadores de entrada, cero cambios al cerebro.
 */

const OpenAI = require('openai');

/**
 * Describe una imagen en contexto de venta. Devuelve string (o lanza).
 * @param {Buffer} buffer     — binario de la imagen
 * @param {string} mimeType   — ej 'image/jpeg'
 * @param {string} [caption]  — texto que acompañó la foto, si hubo
 */
async function describeImage({ buffer, mimeType = 'image/jpeg', caption, apiKey }) {
  const client = new OpenAI({ apiKey });
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 220,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Un cliente envió esta foto en una conversación de ventas por WhatsApp/Instagram${caption ? ` junto con el texto: "${caption}"` : ''}. Descríbela en 2-3 frases en español, con los detalles que le sirven a un vendedor: qué es exactamente, estado/condición, marca/modelo si se distingue, y cualquier detalle relevante para la venta. Sin opiniones ni recomendaciones — solo lo que se ve.`,
        },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ],
    }],
  });

  const text = res.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('visión sin descripción');
  return text;
}

module.exports = { describeImage };
