# dsh-plugin-doc-forge — Document Forge

Batch document toolkit for **DeepSeek Harness**: merge, split, rotate and import PDFs and convert Office documents to PDF, with allowlisted paths, no overwriting of originals and audit logging. Exposed as `mcp__docs__*` tools.

[Español](README.md) · [How it works](docs/HOW-IT-WORKS.md) · MIT

## Tools (7)

| Tool | What it does |
|---|---|
| `mcp__docs__status` | Detected binaries (pdftotext, LibreOffice), allowlisted paths, output dir, mode and limits. |
| `mcp__docs__pdf_merge` | Merges 2+ PDFs in input order. |
| `mcp__docs__pdf_split` | Splits by ranges (`"1-3,4-6"`) or one file per page. |
| `mcp__docs__pdf_rotate` | Rotates selected pages (or all) by 90/180/270°. |
| `mcp__docs__images_to_pdf` | Turns PNG/JPG images into one PDF (fit, A4 or Letter pages). |
| `mcp__docs__pdf_extract_text` | Extracts text with local `pdftotext` (inline or to `.txt`). No OCR. |
| `mcp__docs__office_to_pdf` | Converts DOCX/XLSX/PPTX/ODT/ODS/ODP to PDF with local LibreOffice. |

PDF operations need **no external binaries**: the PDF engine is bundled.

## Requirements

- Node ≥ 20 (provided by the harness).
- Nothing else for PDF operations.
- Optional for `pdf_extract_text`: `pdftotext` (poppler/xpdf). On Windows, Git for Windows ships it under `C:\Program Files\Git\mingw64\bin` and the plugin auto-detects it; otherwise install poppler or set `DSH_DOCS_PDFTOTEXT`.
- Optional for `office_to_pdf`: **LibreOffice** (`winget install TheDocumentFoundation.LibreOffice`) or `DSH_DOCS_SOFFICE`. When missing, `status` reports it and the tool returns an actionable error.

## Configuration

File: `<DSH_HOME>\doc-forge\config.json` (created by `postinstall` with `allowedPaths` = your profile).

```json
{
  "allowedPaths": ["C:\\Users\\your-user"],
  "sofficePath": "",
  "pdftotextPath": "",
  "note": "Empty paths are auto-detected."
}
```

- `allowedPaths`: folders the plugin may read/write. Default outputs go to `<DSH_HOME>\cache\doc-forge`.
- `sofficePath` / `pdftotextPath`: explicit binary paths (empty = auto-detect).
- `rateLimitPerMinute`: optional write rate limit (default 12).

Environment variables: `DSH_DOCS_MODE=read-only`, `DSH_DOCS_SOFFICE`, `DSH_DOCS_PDFTOTEXT`.

## Request examples

- "Merge these three PDFs into one."
- "Split this PDF into one file per page."
- "Extract pages 1-3 and 7 into a new PDF."
- "Rotate page 2 ninety degrees."
- "Put these photos into a single A4 PDF."
- "Extract the text from this contract."
- "Convert this DOCX to PDF."

## Safety

- **Allowlisted paths**: never reads or writes outside `allowedPaths`.
- **Never overwrites**: output can't be an input, and existing destinations get a unique suffix (`-1`, `-2`…).
- **Confirmed writes**: `confirm:true` is required for merging, splitting, rotating, image import, Office conversion and text extraction to a file.
- **Read-only mode** (`DSH_DOCS_MODE=read-only`): only status and in-memory text extraction.
- **Limits**: 200 MB per file, 400 MB per batch, 5,000 pages, 200 split files, 60 s per operation (cooperative timeout), 12 writes/minute.
- **Audit** at `<DSH_HOME>\cache\doc-forge\audit.jsonl`.
- No arbitrary commands: binary arguments are built from validated parameters.

## Install

From **DSH → Settings → Plugins**, install `github:thegabopacheco-sudo/dsh-plugin-doc-forge` and allow the install script.

```
dsh plugin --profile <profile> add github:thegabopacheco-sudo/dsh-plugin-doc-forge
```

## Verification

```powershell
node --check server.mjs
npm run build:bundle
node test/connect-test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File ..\tools\verify-artifact.ps1 -Slug doc-forge -ServerVar DOCS_SERVER
```

Tests generate local PDFs, images and a DOCX and validate merge/split/rotate/images/text, path safety, confirmation, read-only mode and audit. No network.

## License

MIT © thegabopacheco-sudo
