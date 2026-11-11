# How dsh-plugin-doc-forge works

Batch document toolkit for DeepSeek Harness. It turns mechanical PDF and Office
work into concrete, validated and auditable MCP tools, without letting the agent
touch files outside the allowlisted paths.

## Architecture

```
DSH ──MCP stdio──► server.mjs (single-file bundle, ~2.1 MB)
                    ├── pdf-lib (bundled): merge/split/rotate/images
                    ├── local pdftotext (optional, auto-detected)
                    ├── local soffice/LibreOffice (optional, auto-detected)
                    └── config + allowedPaths + audit.jsonl
```

- The server is bundled with **esbuild** into `dist/server.mjs`; at runtime it
  downloads nothing and needs no `node_modules`.
- `postinstall` copies that bundle to `<DSH_HOME>\plugins\doc-forge\server.mjs`
  and creates the base config.
- `cordis.patch.yml` registers the server as `docs` (`mcp__docs__*`) with a
  120 s tool-call timeout.

## Binary detection (prior research)

On the development machine:

| Binary | Result |
|---|---|
| `soffice` / `libreoffice` | **Not installed** (not in PATH or usual locations). `office_to_pdf` is exposed but returns an actionable error when LibreOffice is missing. |
| `pdftotext` | **Available** at `C:\Program Files\Git\mingw64\bin\pdftotext.exe` (xpdf 4.06, shipped with Git for Windows). Auto-detected, so `pdf_extract_text` works. |
| `ffmpeg` | Available but **unused**: PDF and image operations don't need it. |
| `gs`, `qpdf`, `pdfinfo` | Not available; unused. |
| Bundled Python | Has `python-docx`, `openpyxl`, `Pillow`; used **only by tests** to create fixtures, never at runtime. |

Design conclusion: **pdf-lib** (dev dependency, bundled) covers merge, split,
rotate and images with no external dependency; `pdftotext` and LibreOffice are
optional capabilities detected at runtime with actionable errors.

## Tools

### `status`
Writes nothing. Detects `pdftotext` and `soffice` (PATH, configuration and usual
locations: LibreOffice in Program Files, Git's pdftotext), plus config path,
mode, allowlisted paths, default output, audit file and limits.

### `pdf_merge`
`inputs` (2–50 PDFs), optional `output` and `confirm:true`. Loads every PDF with
`PDFDocument.load`, copies all pages in order and saves one file. Validates total
size and page count before writing.

### `pdf_split`
`input`, optional `ranges` (`"1-3,5,7-9"`, 1-based), `outputDir` and `prefix`.
Without `ranges` it produces **one file per page**. Each range becomes a PDF with
its pages; the name is `<prefix>-p<range>.pdf` and never overwrites an existing
file (unique `-1`, `-2` prefixes).

### `pdf_rotate`
`input`, `degrees` (90/180/270), optional `pages` and `output`. Adds rotation on
top of the current one (`(current + degrees) % 360`) via `page.setRotation`
without changing page dimensions. The original stays untouched.

### `images_to_pdf`
`images` (1–50 PNG/JPG), `output`, `pageSize` (`fit`, `a4`, `letter`). `fit`
creates a page the size of the image; `a4`/`letter` centre the image with a 24 pt
margin and orientation based on aspect ratio. Binary PNG/JPEG signatures are
checked before embedding; WebP/BMP are not supported.

### `pdf_extract_text`
`input`, optional `pages` (single range), `layout`, `output` and `confirm`.
- Without `output`: returns text in the response (a read operation, allowed in
  read-only mode too), clipped at 50,000 characters.
- With `output`: requires `confirm:true` and writes a `.txt`.
- Uses `pdftotext` with stdout (`-`) or the given file. **No OCR**: a scanned PDF
  returns empty text with a notice.

### `office_to_pdf`
`input` (DOCX/DOC/ODT/RTF/XLSX/XLS/ODS/CSV/PPTX/PPT/ODP), `output` and `confirm`.
Runs headless LibreOffice with a temporary user profile:
`soffice --headless --norestore --nolockcheck -env:UserInstallation=... --convert-to pdf --outdir <tmp> <input>`.
The resulting PDF is copied to a unique output path; the temp folder is always
removed. If `soffice` is missing, the error explains how to install it.

## Safety

- `allowedPaths` limits reads and writes; the plugin cache directory is always
  allowed. Binaries are executed without a shell.
- `confirm:true` is mandatory for any write; `DSH_DOCS_MODE=read-only` disables
  all writes and allows status + in-memory text extraction.
- Never overwrites: output can't equal an input and existing destinations get a
  unique suffix.
- Size/page/image limits, a 60 s cooperative per-page timeout and a write rate
  limit.
- JSONL audit at `<DSH_HOME>\cache\doc-forge\audit.jsonl` with operation,
  inputs, output, size and errors.

## Discarded capabilities (and why)

- **`pdf_to_images` (PDF → PNG/JPG)**: not viable on this machine. There is no
  `pdftoppm`/`pdftocairo` (full poppler), no `gs` (Ghostscript) and no
  ImageMagick; `ffmpeg` alone does not rasterise PDFs. It is omitted rather than
  bundling a heavy renderer.
- **OCR for `pdf_extract_text`**: no OCR is included; a scanned PDF returns empty
  text with a notice.
- **Exotic image formats** (WebP, BMP, TIFF): only PNG and JPG, which pdf-lib can
  embed without external conversion.

## Verification

`test/connect-test.mjs` starts the real MCP server over stdio and runs 51
assertions: tool registration, status, merge (order/sizes), range and per-page
split, rotate (rotation and page size), images (fit and A4), text extraction
(inline/range/file), paths outside `allowedPaths`, missing files, mandatory
confirmation, no-overwrite, read-only, actionable Office error without
LibreOffice, and audit entries. Fixtures are generated offline with pdf-lib,
Pillow (bundled Python) or ffmpeg as fallback, and python-docx.

The packaged artifact is validated by `tools/verify-artifact.ps1`, which runs
`npm pack` → extract → `postinstall` into a temporary `DSH_HOME` → test against
the deployed server (must print `artifact OK`).
