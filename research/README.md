# Investigación histórica

Esta carpeta conserva las conclusiones que llevaron al runtime actual. Los scripts de
exploración fueron retirados del árbol activo porque contenían sesiones, imprimían
respuestas sensibles o podían modificar reservas.

Hallazgos conservados:

- El login usa CSRF cookie de Sanctum y sesión Laravel en `api.lcnidiomas.edu.co`.
- El tablero de clases se consulta en `/api/schedules/between-dates/{sede}/{idioma}/{inicio}/{fin}?teachers=[]`.
- La reserva usa `/api/schedules/store-class-schedule/{hoursRange}` y recibe el objeto de la clase con `enrollment_id` y `third_party_id`.
- Inglés corresponde al `language_id` configurado (el valor histórico era 70) y una clase normal al `class_type_id` 1.
- El endpoint de recomendaciones podía ocultar clases; por eso el motor consulta el tablero sin filtrar y aplica su propio filtro B1.

Para una investigación nueva usa únicamente variables de entorno, respuestas redactadas
y endpoints de solo lectura. Cualquier prueba que modifique reservas debe vivir fuera
de la suite automática y requerir una activación explícita.
