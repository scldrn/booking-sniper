# LCN Auto-Book

Servicio personal que vigila el tablero de LCN Idiomas y reserva clases de inglés que coinciden con las preferencias del estudiante. La ejecución productiva ocurre en una Edge Function de Supabase, activada por `pg_cron` cada minuto de lunes a sábado.

## Estado actual

El perfil activo está configurado para **B1**. El motor acepta una clase cuyo grupo contenga el código CEFR `B1` (`B1`, `A2-B1`, `B1-B2`, etc.) y rechaza niveles diferentes o ausentes. El nivel se lee de `student_config.target_level`; durante la migración también se reconoce temporalmente el nombre antiguo `level_group_name`.

## Arquitectura

```text
pg_cron
  -> Edge Function auto-book
      -> valida secreto del disparador
      -> adquiere lock distribuido
      -> carga y valida preferencias
      -> autentica en LCN con Sanctum
      -> consulta el tablero de 3 fechas
      -> filtra y ordena clases B1 elegibles
      -> reserva de forma secuencial
      -> registra resultado sin guardar credenciales
```

La función conserva el burst de apertura: consulta inmediatamente y vuelve a consultar a los 10, 20, 30, 40 y 50 segundos solo si todavía no logró una reserva. También hace el intento de `+1 minuto`, backoff y patrullas en horas/medias horas.

## Estructura

```text
database/
  schema.sql
  migrations/20260826_harden_and_move_to_b1.sql
  schedule.sql
supabase/
  config.toml
  functions/auto-book/
    index.ts          # Entrada y orquestación
    config.ts         # Validación de entorno y configuración
    domain.js         # Fechas, niveles, filtros y respuestas; código puro
    domain.d.ts       # Tipos de la lógica JavaScript para Deno/TypeScript
    lcnClient.ts      # Login Sanctum, cookies, timeout y endpoints LCN
    repository.ts     # Supabase, logs y lock distribuido
    types.ts
tests/unit/           # Pruebas deterministas sin red ni reservas
tests/                # Diagnósticos manuales, separados de las pruebas
research/             # Evidencia histórica de reverse engineering
scripts/audit-secrets.mjs
```

## Despliegue seguro

Las credenciales y tokens deben existir únicamente como secretos del entorno. El repositorio ya no debe contener cookies, JWT, contraseñas ni tokens de Supabase.

1. Revoca/rota inmediatamente las cookies LCN, la contraseña de LCN y cualquier JWT que haya estado en versiones anteriores del repositorio. Eliminar un literal del último commit no lo elimina del historial de Git.
2. En una base nueva ejecuta `database/schema.sql` y crea tu fila de preferencias usando `database/student-config.example.sql` como guía. En una base existente ejecuta `database/migrations/20260826_harden_and_move_to_b1.sql`; esa migración elimina las columnas de cookies obsoletas y cambia las preferencias antiguas a B1.
3. Configura los secretos de la Edge Function (por ejemplo, con Supabase CLI):

   ```bash
   supabase secrets set \
     LCN_EMAIL="tu-correo" \
     LCN_PASSWORD="tu-contraseña" \
     AUTO_BOOK_ENABLED="false" \
     AUTO_BOOK_TRIGGER_SECRET="un-secreto-largo-y-aleatorio" \
     LCN_REQUEST_TIMEOUT_MS="8000" \
     AUTO_BOOK_LOCK_TTL_SECONDS="180"
   ```

   `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` deben estar disponibles en el entorno de la función. Nunca expongas la service-role key al navegador ni a `pg_cron`.

4. Despliega la función:

   ```bash
   supabase functions deploy auto-book
   ```

5. Abre `database/schedule.sql`, reemplaza localmente sus tres placeholders (`SUPABASE_PROJECT_REF`, `SUPABASE_ANON_KEY` y `AUTO_BOOK_TRIGGER_SECRET`) y ejecútalo en el SQL Editor. No guardes el archivo reemplazado.

6. Verifica que `student_config` tenga la sede, días y rango horario deseados. Los valores habituales del proyecto siguen siendo lunes-viernes y 09:00–12:00; el motor no inventa preferencias. Para bloquear una franja cancelada manualmente usa, por ejemplo, `[{"date":"2026-09-01","startHour":450}]` en `blocked_slots`.

La reserva está desactivada por defecto mediante `AUTO_BOOK_ENABLED=false`. La función responde en modo `dry_run` y no autentica contra LCN mientras ese valor no sea `true`. Cuando quieras activar el agendamiento, cambia únicamente ese secreto a `true`; antes de hacerlo confirma la configuración y prueba primero el flujo de solo lectura.

Si la versión anterior todavía tiene un cron activo, ejecuta `database/pause-scheduler.sql` para detenerlo durante esta etapa. Ese archivo solo pausa; no programa nada.

## Pruebas y mantenimiento

```bash
npm test
npm run check
```

Las pruebas automáticas no hacen login ni reservan. El único diagnóstico manual de `tests/` es de solo lectura y recibe sus valores desde variables de entorno.

Para inspeccionar logs, usa la tabla `booking_logs`. Los detalles se redactan antes de insertarse y cada ejecución tiene un `request_id`. El lock de `booking_locks` evita que dos minutos consecutivos hagan reservas simultáneamente; si no se puede adquirir o liberar correctamente, se registra el incidente.

## Fortalezas

- Ventana móvil de tres fechas, adecuada para aperturas con 48 horas de anticipación.
- Filtro de sede, tipo, horario, día, cupos, nivel, anticipación mínima y bloqueos manuales.
- Orden cronológico y deduplicación por ID antes de reservar.
- Autenticación renovada por ejecución con CSRF y cookies de sesión.
- Timeouts, respuestas JSON tolerantes y logs sanitizados.
- Pruebas puras para las reglas más sensibles: zona horaria, aperturas, B1 y elegibilidad.

## Riesgos que se corrigieron

- Fechas construidas con `toISOString()` podían cambiar de día según la zona horaria del servidor. Ahora se calculan con `America/Bogota` explícitamente.
- Las horas de sábado podían activar el motor cualquier día. Ahora se distinguen lunes-viernes, sábado y domingo.
- El filtro anterior usaba `includes`, por lo que podía aceptar coincidencias textuales imprecisas. Ahora compara códigos CEFR completos.
- Había un firewall de fechas de junio de 2026 incrustado en código. Ahora los bloqueos son datos configurables en `blocked_slots`.
- El cron y el esquema contenían secretos y cookies. Ahora usan placeholders/secretos del entorno.
- El proceso no tenía bloqueo distribuido, timeout ni validación de capacidad/configuración. Esos controles están en el motor y el esquema.

## Nota de responsabilidad

Este servicio actúa sobre una cuenta personal y contra endpoints de una plataforma de terceros. Respeta los términos de LCN, sus límites de uso y las reglas de cancelación; una reserva automática no debe usarse para acaparar cupos ni para operar cuentas ajenas.
