# Cómo funciona dsh-plugin-doc-forge

Toolkit de documentos por lotes para DeepSeek Harness. Convierte el trabajo
mecánico con PDFs y documentos de Office en tools MCP concretas, validables y
auditables, sin que el agente pueda tocar archivos fuera de las rutas permitidas.

## Arquitectura

```
DSH ──MCP stdio──► server.mjs (bundle single-file, ~2.1 MB)
                    ├── pdf-lib (incluido en el bundle): merge/split/rotate/images
                    ├── pdftotext local (opcional, autodetectado)
                    ├── soffice/LibreOffice local (opcional, autodetectado)
                    └── config + allowedPaths + audit.jsonl
```

- El servidor se empaqueta con **esbuild** en un único `dist/server.mjs`; en
  runtime **no descarga nada** ni necesita `node_modules`.
- `postinstall` copia ese bundle a `<DSH_HOME>\plugins\doc-forge\server.mjs` y
  crea la config base.
- El `cordis.patch.yml` registra el servidor como `docs` (`mcp__docs__*`) con
  timeout de tool de 120 s.

## Detección de binarios (investigación previa)

En el equipo de desarrollo se comprobó:

| Binario | Resultado |
|---|---|
| `soffice` / `libreoffice` | **No instalado** (ni en PATH ni en rutas habituales). `office_to_pdf` queda disponible pero devuelve un error con instrucciones si falta LibreOffice. |
| `pdftotext` | **Disponible** en `C:\Program Files\Git\mingw64\bin\pdftotext.exe` (xpdf 4.06, parte de Git for Windows). El plugin lo autodetecta; `pdf_extract_text` funciona. |
| `ffmpeg` | Disponible, pero **no se usa**: las operaciones de PDF e imágenes no lo necesitan. |
| `gs`, `qpdf`, `pdfinfo` | No disponibles; no se usan. |
| Python bundled | Tiene `python-docx`, `openpyxl` y `Pillow`; se usa **solo en tests** para generar fixtures, nunca en runtime. |

Conclusión de diseño: **pdf-lib** (devDependency, bundleado) cubre merge, split,
rotate e imágenes sin dependencias externas; `pdftotext` y LibreOffice son
capacidades opcionales con detección en runtime y errores accionables.

## Tools

### `status`
No escribe nada. Detección de `pdftotext` y `soffice` (PATH, configuración y
rutas habituales: LibreOffice en Program Files, pdftotext de Git), ruta de
config, modo, rutas permitidas, salida por defecto, auditoría y límites.

### `pdf_merge`
`inputs` (2–50 PDFs), `output` opcional y `confirm:true`. Carga cada PDF con
`PDFDocument.load`, copia todas sus páginas en orden y guarda un único archivo.
Valida tamaño total y número de páginas antes de escribir.

### `pdf_split`
`input`, `ranges` opcional (`"1-3,5,7-9"`, 1-based), `outputDir` y `prefix`.
Sin `ranges` genera **un archivo por página**. Cada rango produce un PDF con sus
páginas copiadas; el nombre es `<prefijo>-p<rango>.pdf` y nunca pisa un archivo
existente (sufijos `-1`, `-2`…).

### `pdf_rotate`
`input`, `degrees` (90/180/270), `pages` opcional y `output`. Suma la rotación
sobre la existente (`(actual + grados) % 360`) con `page.setRotation`, sin
cambiar el tamaño de página. El original queda intacto.

### `images_to_pdf`
`images` (1–50 PNG/JPG), `output`, `pageSize` (`fit`, `a4`, `letter`).
`fit` crea una página del tamaño de la imagen; `a4`/`letter` centran la imagen
con 24 pt de margen y orientación según el aspecto. Verifica la firma binaria
PNG/JPEG antes de incrustar; formatos como WebP o BMP no están soportados.

### `pdf_extract_text`
`input`, `pages` opcional (un solo rango), `layout`, `output` y `confirm`.
- Sin `output`: devuelve el texto en la respuesta (operación de lectura, válida
  también en read-only), con recorte a 50.000 caracteres.
- Con `output`: exige `confirm:true` y escribe un `.txt`.
- Usa `pdftotext` con salida a stdout (`-`) o al archivo indicado. **No hay OCR**:
  un PDF escaneado devuelve texto vacío con aviso.

### `office_to_pdf`
`input` (DOCX/DOC/ODT/RTF/XLSX/XLS/ODS/CSV/PPTX/PPT/ODP), `output` y `confirm`.
Lanza LibreOffice headless con un perfil de usuario temporal:
`soffice --headless --norestore --nolockcheck -env:UserInstallation=... --convert-to pdf --outdir <tmp> <input>`.
El PDF resultante se copia a la salida única; la carpeta temporal se elimina
siempre. Si `soffice` no existe, el error explica cómo instalarlo.

## Herramientas reales

- `status`: Estado de Document Forge
- `pdf_merge`: Unir PDFs
- `pdf_split`: Dividir PDF
- `pdf_rotate`: Rotar páginas de un PDF
- `images_to_pdf`: Imágenes a PDF
- `pdf_extract_text`: Extraer texto de un PDF
- `office_to_pdf`: Office a PDF

## Seguridad

- `allowedPaths` de la config limita lectura y escritura; el directorio de caché
  del plugin siempre está permitido. Los binarios se ejecutan sin shell.
- `confirm:true` obligatorio para cualquier escritura; `DSH_DOCS_MODE=read-only`
  deshabilita todas las escrituras y permite status + extracción inline.
- Nunca se sobrescribe: la salida no puede coincidir con una entrada y los
  destinos existentes reciben un sufijo único.
- Límites de tamaño, páginas e imágenes, timeout cooperativo de 60 s entre
  páginas y límite de escrituras por minuto.
- Auditoría JSONL en `<DSH_HOME>\cache\doc-forge\audit.jsonl` con operación,
  entradas, salida, tamaño y errores.

## Capacidades descartadas (y por qué)

- **`pdf_to_images` (PDF → PNG/JPG)**: no viable en este equipo. No hay
  `pdftoppm`/`pdftocairo` (poppler completo), ni `gs` (Ghostscript), ni
  ImageMagick; `ffmpeg` no rasteriza PDF por sí solo. Se omite en lugar de
  empaquetar un renderizador pesado.
- **`pdf_extract_text` con OCR**: no se incluye OCR; un PDF escaneado devuelve
  texto vacío con aviso.
- **Formatos de imagen exóticos** (WebP, BMP, TIFF): solo PNG y JPG, que pdf-lib
  puede incrustar sin conversión externa.

## Verificación

`test/connect-test.mjs` levanta el servidor MCP real por stdio y ejecuta 51
comprobaciones: registro de tools, status, merge (orden/tamaños), split por
rango y por página, rotate (rotación y tamaño), imágenes (fit y A4), extracción
de texto inline/rango/archivo, rutas fuera de `allowedPaths`, archivo
inexistente, confirmación obligatoria, no-sobrescritura, read-only, fallo
accionable de Office sin LibreOffice y auditoría. Los fixtures se generan sin
red con pdf-lib, Pillow (Python bundled) o ffmpeg como fallback, y python-docx.

El artefacto empaquetado se valida con `tools/verify-artifact.ps1`, que hace
`npm pack` → extrae → ejecuta `postinstall` sobre un `DSH_HOME` temporal y corre
el test contra el servidor desplegado (debe imprimir `artifact OK`).
