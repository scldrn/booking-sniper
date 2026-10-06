# Pruebas

Las pruebas automáticas viven en `tests/unit` y no hacen llamadas ni reservas reales:

```bash
npm test
npm run check
```

El diagnóstico manual de solo lectura requiere credenciales cargadas desde variables de
entorno y una activación explícita:

```bash
RUN_LIVE_DIAGNOSTICS=1 node tests/manual/inspect-board.mjs
```

No hay scripts de reserva dentro del repositorio. Las reservas productivas ocurren
únicamente en la Edge Function después de pasar sus filtros y el lock distribuido.
