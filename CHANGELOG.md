# Changelog

## 0.1.0 — 2026-11-11

- Primera versión de **dsh-plugin-doc-forge** (`mcp__docs__*`): toolkit de documentos por lotes para DeepSeek Harness.
- Tools: `status`, `pdf_merge`, `pdf_split`, `pdf_rotate`, `images_to_pdf`, `pdf_extract_text`, `office_to_pdf`.
- PDF motor `pdf-lib` bundleado en `dist/server.mjs` (sin red en runtime, sin binarios externos).
- `pdf_extract_text` con autodetección de `pdftotext` (PATH, configuración y Git for Windows).
- `office_to_pdf` con autodetección de LibreOffice y error accionable si falta.
- Seguridad: `allowedPaths`, `confirm:true` para escribir, modo `DSH_DOCS_MODE=read-only`, sin sobrescrituras, límites de tamaño/páginas, timeout cooperativo, rate limit y auditoría JSONL.
- Tests end-to-end locales (51 comprobaciones) con fixtures generados por pdf-lib, Pillow y python-docx; verificación del artefacto empaquetado.
