# dsh-plugin-doc-forge — Document Forge

Toolkit de documentos por lotes para **DeepSeek Harness**: une, divide, rota e importa PDFs y convierte documentos de Office a PDF, con rutas permitidas, sin sobrescribir originales y con auditoría. Expone las tools como `mcp__docs__*`.

[English](README.en.md) · [Cómo funciona](docs/COMO-FUNCIONA.md) · MIT

## Herramientas (7)

| Tool | Qué hace |
|---|---|
| `mcp__docs__status` | Binarios detectados (pdftotext, LibreOffice), rutas permitidas, salida, modo y límites. |
| `mcp__docs__pdf_merge` | Une 2+ PDFs en uno, respetando el orden de los archivos. |
| `mcp__docs__pdf_split` | Divide por rangos (`"1-3,4-6"`) o en una página por archivo. |
| `mcp__docs__pdf_rotate` | Rota 90/180/270° las páginas indicadas (o todas) sin tocar el original. |
| `mcp__docs__images_to_pdf` | Convierte PNG/JPG en un PDF: página ajustada, A4 o Letter. |
| `mcp__docs__pdf_extract_text` | Extrae texto con `pdftotext` local (inline o a `.txt`). Sin OCR. |
| `mcp__docs__office_to_pdf` | Convierte DOCX/XLSX/PPTX/ODT/ODS/ODP a PDF con LibreOffice local. |

`pdf_merge`, `pdf_split`, `pdf_rotate`, `images_to_pdf` funcionan **sin binarios externos**: el motor PDF va incluido en el bundle.

## Requisitos

- Node ≥ 20 (lo aporta el harness).
- **Nada obligatorio extra** para las operaciones de PDF.
- Opcional para `pdf_extract_text`: `pdftotext` (poppler/xpdf). En Windows, Git for Windows lo trae en `C:\Program Files\Git\mingw64\bin` y el plugin lo autodetecta; también puedes instalarlo con `winget install oschwartz10612.Poppler` o apuntar `DSH_DOCS_PDFTOTEXT`.
- Opcional para `office_to_pdf`: **LibreOffice**. Instálalo con `winget install TheDocumentFoundation.LibreOffice` o define `DSH_DOCS_SOFFICE`. Si falta, `status` lo indica y la tool devuelve un error con instrucciones.

## Configuración

Archivo: `<DSH_HOME>\doc-forge\config.json` (el `postinstall` lo crea con `allowedPaths` = tu perfil).

```json
{
  "allowedPaths": ["C:\\Users\\tu-usuario"],
  "sofficePath": "",
  "pdftotextPath": "",
  "note": "Las rutas vacías se autodetectan."
}
```

- `allowedPaths`: carpetas desde las que se puede leer y escribir. Las salidas por defecto van a `<DSH_HOME>\cache\doc-forge`.
- `sofficePath` / `pdftotextPath`: ruta explícita al binario (vacío = autodetección).
- `rateLimitPerMinute`: opcional, límite de escrituras por minuto (por defecto 12).

Variables de entorno: `DSH_DOCS_MODE=read-only`, `DSH_DOCS_SOFFICE`, `DSH_DOCS_PDFTOTEXT`.

## Ejemplos de pedidos

- «Une estos tres PDFs en uno y guárdalo en el escritorio.»
- «Divide el PDF en una página por archivo.»
- «Saca solo las páginas 1-3 y 7 en un PDF nuevo.»
- «Rota la página 2 noventa grados.»
- «Pasa estas fotos a un solo PDF en A4.»
- «Extrae el texto del contrato y resúmelo.»
- «Convierte este DOCX a PDF.»

## Seguridad

- **Rutas permitidas** (`allowedPaths`): no lee ni escribe fuera de ellas.
- **Nunca sobrescribe**: la salida jamás puede ser una entrada y si el destino existe se crea un nombre único (`-1`, `-2`…).
- **Escritura con confirmación**: `pdf_merge`, `pdf_split`, `pdf_rotate`, `images_to_pdf`, `office_to_pdf` y `pdf_extract_text` con `output` exigen `confirm:true` y pedido explícito del usuario.
- **Modo read-only** (`DSH_DOCS_MODE=read-only`): solo status y extracción de texto en memoria.
- **Límites**: 200 MB por archivo, 400 MB por lote, 5.000 páginas, 200 archivos por división, 60 s por operación (timeout cooperativo), 12 escrituras/minuto.
- **Auditoría** en `<DSH_HOME>\cache\doc-forge\audit.jsonl` (operaciones y fallos).
- Sin comandos arbitrarios: los argumentos de los binarios se construyen desde parámetros validados.

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-doc-forge` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-doc-forge
```

El `postinstall` copia el runtime a `<DSH_HOME>\plugins\doc-forge` y crea la config base.

## Verificación

```powershell
node --check server.mjs
npm run build:bundle
node test/connect-test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File ..\tools\verify-artifact.ps1 -Slug doc-forge -ServerVar DOCS_SERVER
```

Los tests generan PDFs (pdf-lib), imágenes (Pillow o ffmpeg) y un DOCX (python-docx) locales, y verifican merge/split/rotate/imágenes/texto, seguridad de rutas, confirmación, read-only y auditoría. No usan red.

## Licencia

MIT © thegabopacheco-sudo
