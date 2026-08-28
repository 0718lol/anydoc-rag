# firecrawl-anydoc

[![PyPI](https://img.shields.io/pypi/v/firecrawl-anydoc.svg)](https://pypi.org/project/firecrawl-anydoc/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/firecrawl/anydoc/blob/main/LICENSE)

Convert Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF files into clean GitHub-Flavored Markdown. Python bindings for the [anydoc](https://github.com/firecrawl/anydoc) Rust crate, built by [Firecrawl](https://firecrawl.dev). Also available as a hosted API through [Firecrawl Parse](https://firecrawl.dev/parse), which adds our OCR models for the scanned pages anydoc can't read on its own.

Every format parses into one shared document model and renders through a single Markdown serializer, so headings, tables, lists, and footnotes come out the same no matter which format goes in. Conversion releases the GIL, so other threads keep running. Type stubs ship with the package.

```bash
pip install firecrawl-anydoc
```

The package installs as `firecrawl-anydoc` and imports as `anydoc`.

## Supported formats

| Format           | Extensions                                                 |
| ---------------- | ---------------------------------------------------------- |
| Word             | `.doc`, `.docx`, `.docm`                                   |
| PowerPoint       | `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm` |
| Excel            | `.xls`, `.xlsx`, `.xlsm`, `.xlsb`                          |
| OpenDocument     | `.odt`, `.ods`, `.odp`                                     |
| Rich Text Format | `.rtf`                                                     |
| EPUB             | `.epub`                                                    |
| CSV              | `.csv`                                                     |
| PDF              | `.pdf`                                                     |

## Usage

```python
import anydoc

# From a file path:
markdown = anydoc.to_markdown("report.docx")

# From bytes, with the format detected from the content:
markdown = anydoc.to_markdown_bytes(data)

# Or name it, which signature-less formats (CSV) need:
markdown = anydoc.to_markdown_bytes(data, "csv")

# Or stop at the document model, which also carries embedded assets:
document = anydoc.to_document(data)

# Or get a RAG-ready payload:
payload = anydoc.to_rag("report.docx")
for chunk in payload["chunks"]:
    index.add_text(chunk["text"], metadata=chunk["metadata"])
```

## RAG payload

`to_rag()` and `to_rag_bytes()` return a dictionary shaped for indexing
pipelines:

```python
payload = anydoc.to_rag("report.docx", max_chars=2000, overlap=200)

payload["markdown"]   # full Markdown
payload["chunks"]     # retrieval chunks with heading context
payload["assets"]     # id, media_type, origin_part, byte length
payload["metadata"]   # source, format, OCR mode, input size, chunk count
```

Chunks are built from the document model when the format supports it, so
heading context is preserved in `chunk["metadata"]["headings"]`. PDFs do not
currently expose a document model, so their chunks are split from Markdown.

Embedded images and objects are listed as lightweight asset metadata only; the
raw bytes stay available through `to_document()`.

## Scanned pages

anydoc converts locally and does not do OCR, so a PDF with scanned or image-only pages raises `NeedsOcrError`. Use `ocr="local"` to invoke an OCR command on the same machine, or `ocr="hosted"` to send that document to [Firecrawl Parse](https://firecrawl.dev/parse).

```python
markdown = anydoc.to_markdown("scan.pdf", ocr="hosted")
```

For local OCR, `{input}` expands to a temporary input file and `{output}` to
an optional Markdown output file. Commands without `{input}` receive the input
path as their final argument. If `{output}` is omitted, Markdown is read from
stdout. Commands run directly without a shell.

```python
markdown = anydoc.to_markdown(
    "scan.pdf",
    ocr="local",
    ocr_command=["my-ocr", "--input", "{input}", "--markdown", "{output}"],
    ocr_timeout=300,
)
```

For deployment, `ANYDOC_OCR_COMMAND` can provide the command as a shell-style
string, for example `my-ocr --input {input} --markdown {output}`. It is split
into arguments but is never executed through a shell. The local command only
runs after the built-in parser reports pages that need OCR.

PaddleOCR PP-StructureV3 is available as a built-in adapter:

```bash
pip install paddleocr paddlepaddle
```

```python
markdown = anydoc.to_markdown("scan.pdf", ocr="paddleocr", ocr_timeout=600)
```

It runs `paddleocr pp_structurev3` and collects the Markdown file generated in
the temporary output directory. Set `ANYDOC_PADDLEOCR_COMMAND` to override the
command template. The template supports `{input}` and `{output_dir}`; it is
split into arguments and never executed through a shell.

## Errors

A conversion raises only when no complete Markdown could come out of the file. The exception type names what went wrong:

```python
try:
    return anydoc.to_markdown(path)
except (anydoc.EncryptedError, anydoc.UnsupportedError) as error:
    # No document comes out of these, so record the file and take the next one.
    unconverted.append((path, type(error).__name__))
    return None
```

| Exception            | Raised when                                                         |
| -------------------- | ------------------------------------------------------------------- |
| `UnsupportedError`   | Unknown format, or one that cannot be converted                     |
| `NeedsOcrError`      | Scanned or image-only pages of a PDF, listed in `pages`             |
| `MalformedError`     | Structurally unusable: no meaningful content could be extracted     |
| `EncryptedError`     | Encrypted or password-protected                                     |
| `ResourceLimitError` | Crossed a fixed safety limit (decompression, nesting, node count)   |
| `MissingPartError`   | A part required for any meaningful output is absent                 |
| `HostedError`        | `ocr="hosted"` could not get the document through Firecrawl Parse   |
| `LocalOcrError`      | `ocr="local"` command was missing, failed, timed out, or gave no Markdown |
| `OSError`            | The file could not be read, from `to_markdown` only                 |

Every conversion failure subclasses `anydoc.ConvertError`, so catching that handles all of them at once. `MalformedError.part` and `MissingPartError.part` name the package part at fault, `ResourceLimitError.limit` names the limit crossed, and `str(error)` carries the whole message. A `format` argument naming no supported format raises `ValueError`.

## Format detection

The format is read from the file content, using the marker its specification designates: the PDF header, the RTF open group, OLE stream names, the ZIP package mimetype and content types. CSV has no such marker, so detection returns `None` for it and the extension, or an explicit format, names it instead.

```python
anydoc.format_from_bytes(data)  # 'docx', or None when nothing matches
anydoc.format_from_extension(".pptm")  # 'pptx'
anydoc.format_from_path("report.odt")  # 'odt'
```

## Images and embedded objects

Markdown cannot embed bytes, so an embedded image renders as its alt text while the bytes stay on `document.assets`, tagged with a media type and the part they came from. Images that carry an external URL render as ordinary Markdown images.

Full behavior notes and benchmarks live in the [repository README](https://github.com/firecrawl/anydoc#readme).

## License

[MIT](https://github.com/firecrawl/anydoc/blob/main/LICENSE)
