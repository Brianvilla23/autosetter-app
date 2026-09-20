# Soporte que aprende

**Qué es.** El copiloto del panel (la burbuja ✦) es el primer nivel de soporte
de Atinov. No es un chat genérico: antes de hablarle al modelo, el código lee
el estado real de la cuenta y saca conclusiones. Desde el 20-09-2026 además
tiene un **libro de fallas** y un **ciclo para crecer**: todo lo que nos cuesta
descubrir con un cliente queda escrito y el copiloto lo sabe para todos.

## Las tres piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| Libro de fallas | `services/copilotoRunbook.js` | Lista de problemas ya vistos: síntoma, causa real, dónde hacer clic, fecha. Las entradas con `senal(estado)` se disparan solas. |
| Estado ampliado | `services/copiloto.js` → `senalesExtra` | Reconexiones pendientes, caducidad del token de WhatsApp, entregas fallidas por código de Meta (7 días), agenda, playbook, token de Mercado Pago, personas bajo control humano, errores internos (24 h). |
| Cola de aprendizaje | `db.copilotoConsultas` + admin → Sistema | Cada pregunta y respuesta queda guardada. El dueño califica "me sirvió / no me sirvió". Soporte revisa las que no sirvieron. |

## El ciclo (así aprende)

1. **Un cliente pregunta** en el copiloto. El código diagnostica, el modelo
   redacta, y la consulta se guarda con los hallazgos que había en ese momento.
2. **El cliente califica** bajo la respuesta. "No me sirvió" la pone en la cola.
3. **Soporte revisa la cola** (admin → Sistema → "Copiloto: lo que preguntan
   los clientes", filtro "No sirvió y sin revisar"). Para cada una decide:
   - era un bug → se arregla, y **en el mismo commit** se agrega la entrada al
     runbook con `desde: <fecha>`;
   - era falta de conocimiento → entrada nueva en el runbook, sin código;
   - era detectable por el estado de la cuenta → la entrada lleva `senal`, y
     desde ese día el copiloto lo dice solo, sin que pregunten.
4. **Se marca revisada** con una nota corta. La nota es memoria de trabajo; lo
   que vale es la entrada en el runbook, porque viaja a todas las cuentas.

## Reglas

- Una entrada nueva por cada bug arreglado. Sin excepción: es más barato
  escribir cinco líneas hoy que volver a diagnosticar lo mismo en otra cuenta.
- La `causa` es la causa real, no la aparente ("la ventana de 24 h se cerró",
  no "WhatsApp falla a veces").
- La `solucion` dice dónde hacer clic en el panel. Si no hay clic posible,
  dice "escribir a soporte" y qué decir.
- Español de Chile, tuteando, sin emojis: el texto viaja al modelo y al panel.
- `senal` lee solo el objeto `estado`. Nunca toca la base ni la red.
- Cada señal nueva lleva un test en `test/copilotorunbook.test.js` con el
  estado que la dispara y el estado sano que no.

## Costo

El runbook viaja completo en cada consulta (~1.300 tokens con 27 entradas).
Con gpt-4o-mini eso cuesta menos que un mensaje de WhatsApp. Si pasa de ~80
entradas conviene filtrar por tema antes de mandarlo al modelo.
