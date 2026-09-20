## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Soporte que aprende (copiloto)

- `services/copilotoRunbook.js` es el libro de fallas del producto. **Cada bug que se arregla agrega una entrada** (`id`, `sintoma`, `causa`, `solucion`, `desde`) en el mismo commit del fix. Si el estado de la cuenta permite detectarlo solo, la entrada lleva `senal(estado)` y el copiloto lo dice sin que el dueño pregunte.
- Las preguntas que el copiloto no supo responder se ven en admin → Sistema → "Copiloto: lo que preguntan los clientes". Al resolver una: entrada nueva en el runbook + marcar la consulta como revisada.
- Tests: `test/copilotorunbook.test.js` (forma de cada entrada y señales), `test/copilotoconsultas.test.js` (registro y calificación), `test/copiloto.test.js` (diagnóstico base). Ciclo completo en `docs/SOPORTE_QUE_APRENDE.md`.
