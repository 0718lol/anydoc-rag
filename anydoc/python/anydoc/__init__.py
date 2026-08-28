"""Convert documents to GitHub-Flavored Markdown."""

import json
import hashlib
import os
import shlex
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Literal, Sequence

from anydoc._anydoc import (
    Asset,
    Block,
    Cell,
    CellSlot,
    ConvertError,
    Document,
    EncryptedError,
    ImageSource,
    Inline,
    LinkTarget,
    List,
    ListItem,
    MalformedError,
    MissingPartError,
    NeedsOcrError,
    Note,
    ResourceLimitError,
    Style,
    Table,
    UnsupportedError,
    format_from_bytes,
    format_from_extension,
    format_from_path,
    to_document,
)
from anydoc._anydoc import to_markdown as _to_markdown
from anydoc._anydoc import to_markdown_bytes as _to_markdown_bytes

Format = Literal[
    "doc", "docx", "odt", "pdf", "ppt", "pptx", "rtf", "epub", "xlsx", "ods", "odp", "csv"
]
"""Input format, named after the extension that identifies it. Container
variants that share a parser (`.docm`, `.xlsm`, `.ppsx`, ...) map onto these
via `format_from_bytes` or `format_from_extension`."""

Ocr = Literal["reject", "hosted", "local", "paddleocr"]
"""What happens to a PDF whose pages need OCR. `reject` (the default) raises
`NeedsOcrError` naming the pages. `hosted` sends the whole document to
Firecrawl Parse instead, while `local` runs a configured local command and
`paddleocr` runs PaddleOCR PP-StructureV3 locally.
Documents anydoc converts itself never leave the machine."""


class HostedError(ConvertError):
    """`ocr="hosted"` could not get the document through Firecrawl Parse."""


class LocalOcrError(ConvertError):
    """`ocr="local"` could not get Markdown from the configured command."""


def to_rag(
    path: "str | os.PathLike[str]",
    *,
    ocr: Ocr = "reject",
    api_key: "str | None" = None,
    api_url: "str | None" = None,
    ocr_command: "str | Sequence[str] | None" = None,
    paddleocr_command: "str | Sequence[str] | None" = None,
    ocr_timeout: float = 300,
    max_chars: int = 2000,
    overlap: int = 200,
) -> dict[str, Any]:
    """Convert a document file into a RAG-ready payload.

    The payload contains the full Markdown, retrieval chunks, lightweight
    asset metadata, and source metadata. Embedded asset bytes are intentionally
    not copied into the payload; use `to_document` when the raw bytes are
    needed.
    """
    _validate_chunking(max_chars, overlap)
    path = Path(path)
    data = path.read_bytes()
    format = format_from_bytes(data) or format_from_path(path)
    markdown = to_markdown(
        path,
        ocr=ocr,
        api_key=api_key,
        api_url=api_url,
        ocr_command=ocr_command,
        paddleocr_command=paddleocr_command,
        ocr_timeout=ocr_timeout,
    )
    return _rag_payload(
        data,
        markdown,
        format,
        source=str(path),
        ocr=ocr,
        max_chars=max_chars,
        overlap=overlap,
    )


def to_rag_bytes(
    data: "bytes | bytearray",
    format: "Format | None" = None,
    *,
    ocr: Ocr = "reject",
    api_key: "str | None" = None,
    api_url: "str | None" = None,
    ocr_command: "str | Sequence[str] | None" = None,
    paddleocr_command: "str | Sequence[str] | None" = None,
    ocr_timeout: float = 300,
    source: "str | None" = None,
    max_chars: int = 2000,
    overlap: int = 200,
) -> dict[str, Any]:
    """Convert in-memory document bytes into a RAG-ready payload."""
    _validate_chunking(max_chars, overlap)
    data = bytes(data)
    resolved = format or format_from_bytes(data)
    markdown = to_markdown_bytes(
        data,
        format,
        ocr=ocr,
        api_key=api_key,
        api_url=api_url,
        ocr_command=ocr_command,
        paddleocr_command=paddleocr_command,
        ocr_timeout=ocr_timeout,
    )
    return _rag_payload(
        data,
        markdown,
        resolved,
        source=source,
        ocr=ocr,
        max_chars=max_chars,
        overlap=overlap,
    )


def to_markdown(
    path: "str | os.PathLike[str]",
    *,
    ocr: Ocr = "reject",
    api_key: "str | None" = None,
    api_url: "str | None" = None,
    ocr_command: "str | Sequence[str] | None" = None,
    paddleocr_command: "str | Sequence[str] | None" = None,
    ocr_timeout: float = 300,
) -> str:
    """Convert a document file to Markdown. The format is detected from the
    file content; the extension is the fallback for signature-less formats
    (CSV) and unrecognizable containers.

    For `ocr="hosted"`, `api_key` falls back to `FIRECRAWL_API_KEY`, then
    keyless; `api_url` to `FIRECRAWL_API_URL`, then
    `https://api.firecrawl.dev`."""
    _validate_ocr(ocr)
    try:
        return _to_markdown(path)
    except NeedsOcrError:
        if ocr == "reject":
            raise
    path = Path(path)
    data = path.read_bytes()
    if ocr == "local":
        return _parse_local(data, path.name, ocr_command, ocr_timeout)
    if ocr == "paddleocr":
        return _parse_paddleocr(data, path.name, paddleocr_command, ocr_timeout)
    return _parse_hosted(data, path.name, api_key, api_url)


def to_markdown_bytes(
    data: "bytes | bytearray",
    format: "Format | None" = None,
    *,
    ocr: Ocr = "reject",
    api_key: "str | None" = None,
    api_url: "str | None" = None,
    ocr_command: "str | Sequence[str] | None" = None,
    paddleocr_command: "str | Sequence[str] | None" = None,
    ocr_timeout: float = 300,
) -> str:
    """Convert an in-memory document to Markdown. Without a format, it is
    detected from the content, which signature-less formats (CSV) have to
    name explicitly. `ocr`, `api_key` and `api_url` are as for
    `to_markdown`."""
    _validate_ocr(ocr)
    try:
        return _to_markdown_bytes(data, format)
    except NeedsOcrError:
        if ocr == "reject":
            raise
    if ocr == "local":
        return _parse_local(bytes(data), "document.pdf", ocr_command, ocr_timeout)
    if ocr == "paddleocr":
        return _parse_paddleocr(bytes(data), "document.pdf", paddleocr_command, ocr_timeout)
    return _parse_hosted(bytes(data), "document.pdf", api_key, api_url)


def _rag_payload(
    data: bytes,
    markdown: str,
    format: "Format | None",
    *,
    source: "str | None",
    ocr: Ocr,
    max_chars: int,
    overlap: int,
) -> dict[str, Any]:
    document = None
    assets: list[dict[str, Any]] = []
    if format != "pdf":
        try:
            document = to_document(data, format)
            assets = _asset_metadata(document)
        except ConvertError:
            if ocr == "reject":
                raise
    chunks = (
        _chunks_from_document(document, max_chars, overlap)
        if document is not None
        else _chunks_from_markdown(markdown, max_chars, overlap)
    )
    return {
        "markdown": markdown,
        "chunks": chunks,
        "assets": assets,
        "metadata": {
            "source": source,
            "format": format,
            "ocr": ocr,
            "bytes": len(data),
            "chunk_count": len(chunks),
            "asset_count": len(assets),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    }


def _validate_chunking(max_chars: int, overlap: int) -> None:
    if max_chars < 200:
        raise ValueError("max_chars must be at least 200")
    if overlap < 0:
        raise ValueError("overlap must be non-negative")
    if overlap >= max_chars:
        raise ValueError("overlap must be smaller than max_chars")


def _validate_ocr(ocr: Ocr) -> None:
    if ocr not in {"reject", "hosted", "local", "paddleocr"}:
        raise ValueError(f"unknown OCR mode: {ocr}")


def _asset_metadata(document: Document) -> list[dict[str, Any]]:
    return [
        {
            "id": asset.id,
            "media_type": asset.media_type,
            "origin_part": asset.origin_part,
            "bytes": len(asset.data),
        }
        for asset in document.assets
    ]


def _chunks_from_document(document: Document, max_chars: int, overlap: int) -> list[dict[str, Any]]:
    units = _document_units(document.blocks)
    chunks: list[dict[str, Any]] = []
    current: list[str] = []
    headings: list[str] = []
    current_headings: list[str] = []
    start_unit = 0

    for index, unit in enumerate(units):
        if unit["kind"] == "heading":
            headings = headings[: max(unit["level"] - 1, 0)] + [unit["text"]]
        text = unit["text"].strip()
        if not text:
            continue
        if current and _joined_len(current, text) > max_chars:
            chunks.append(_chunk(len(chunks), current, current_headings, start_unit, index - 1))
            current = _overlap_tail(current, overlap)
            start_unit = max(0, index - len(current))
        if not current:
            current_headings = list(headings)
            start_unit = index
        current.append(text)

    if current:
        chunks.append(_chunk(len(chunks), current, current_headings, start_unit, len(units) - 1))
    return chunks


def _document_units(blocks: list[Block]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    for block in blocks:
        if block.kind == "heading":
            units.append(
                {
                    "kind": "heading",
                    "level": block.level or 1,
                    "text": _inlines_text(block.content or []),
                }
            )
        elif block.kind == "paragraph":
            units.append(
                {"kind": "paragraph", "level": 0, "text": _inlines_text(block.content or [])}
            )
        elif block.kind == "list" and block.list is not None:
            for item in block.list.items:
                item_text = "\n".join(_block_texts(item.blocks))
                marker = item.marker_label or "-"
                units.append(
                    {"kind": "list_item", "level": 0, "text": f"{marker} {item_text}".strip()}
                )
        elif block.kind == "table" and block.table is not None:
            rows = []
            for row in block.table.grid:
                cells = []
                for slot in row:
                    if slot.kind == "origin" and slot.cell is not None:
                        cells.append(" ".join(_block_texts(slot.cell.blocks)))
                if cells:
                    rows.append(" | ".join(cells))
            units.append({"kind": "table", "level": 0, "text": "\n".join(rows)})
        elif block.kind == "block_quote":
            units.extend(_document_units(block.blocks or []))
        elif block.kind in {"code_block", "math"}:
            units.append({"kind": block.kind, "level": 0, "text": block.text or ""})
    return units


def _block_texts(blocks: list[Block]) -> list[str]:
    return [unit["text"] for unit in _document_units(blocks) if unit["text"].strip()]


def _inlines_text(inlines: list[Inline]) -> str:
    parts: list[str] = []
    for inline in inlines:
        if inline.kind == "text":
            parts.append(inline.text or "")
        elif inline.kind == "link":
            parts.append(_inlines_text(inline.content or []))
        elif inline.kind == "image":
            parts.append(inline.alt or "")
        elif inline.kind == "line_break":
            parts.append("\n")
        elif inline.kind == "math":
            parts.append(inline.text or "")
        elif inline.kind == "checkbox":
            parts.append("[x]" if inline.checked else "[ ]")
    return "".join(parts)


def _chunks_from_markdown(markdown: str, max_chars: int, overlap: int) -> list[dict[str, Any]]:
    paragraphs = [part.strip() for part in markdown.split("\n\n") if part.strip()]
    chunks: list[dict[str, Any]] = []
    current: list[str] = []
    start_unit = 0
    for index, paragraph in enumerate(paragraphs):
        if current and _joined_len(current, paragraph) > max_chars:
            chunks.append(_chunk(len(chunks), current, [], start_unit, index - 1))
            current = _overlap_tail(current, overlap)
            start_unit = max(0, index - len(current))
        if not current:
            start_unit = index
        current.append(paragraph)
    if current:
        chunks.append(_chunk(len(chunks), current, [], start_unit, len(paragraphs) - 1))
    return chunks


def _joined_len(parts: list[str], next_part: str) -> int:
    return len("\n\n".join(parts + [next_part]))


def _overlap_tail(parts: list[str], overlap: int) -> list[str]:
    if overlap == 0:
        return []
    kept: list[str] = []
    total = 0
    for part in reversed(parts):
        projected = total + len(part)
        if kept and projected > overlap:
            break
        kept.insert(0, part)
        total = projected
    return kept


def _chunk(
    index: int,
    parts: list[str],
    headings: list[str],
    start_unit: int,
    end_unit: int,
) -> dict[str, Any]:
    text = "\n\n".join(parts).strip()
    return {
        "id": f"chunk-{index}",
        "text": text,
        "metadata": {
            "headings": headings,
            "start_unit": start_unit,
            "end_unit": end_unit,
            "chars": len(text),
        },
    }


_API_URL = "https://api.firecrawl.dev"
_TIMEOUT_SECONDS = 300


def _parse_local(
    data: bytes,
    filename: str,
    command: "str | Sequence[str] | None",
    timeout: float,
) -> str:
    if timeout <= 0:
        raise ValueError("ocr_timeout must be greater than zero")
    configured = command or os.environ.get("ANYDOC_OCR_COMMAND")
    if not configured:
        raise LocalOcrError(
            'local OCR command is not configured; pass ocr_command or set ANYDOC_OCR_COMMAND'
        )
    try:
        arguments = shlex.split(configured) if isinstance(configured, str) else list(configured)
    except ValueError as error:
        raise LocalOcrError(f"invalid local OCR command: {error}") from error
    if not arguments or any(not isinstance(argument, str) for argument in arguments):
        raise LocalOcrError("local OCR command must contain string arguments")

    suffix = Path(filename).suffix or ".pdf"
    with tempfile.TemporaryDirectory(prefix="anydoc-ocr-") as directory:
        input_path = Path(directory) / f"input{suffix}"
        output_path = Path(directory) / "output.md"
        input_path.write_bytes(data)
        uses_input = any("{input}" in argument for argument in arguments)
        uses_output = any("{output}" in argument for argument in arguments)
        expanded = [
            argument.replace("{input}", str(input_path)).replace("{output}", str(output_path))
            for argument in arguments
        ]
        if not uses_input:
            expanded.append(str(input_path))
        try:
            result = subprocess.run(
                expanded,
                capture_output=True,
                check=False,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise LocalOcrError(f"local OCR command timed out after {timeout:g} seconds") from error
        except OSError as error:
            raise LocalOcrError(f"could not run local OCR command: {error}") from error
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "no error output"
            detail = detail[:2000]
            raise LocalOcrError(
                f"local OCR command exited with status {result.returncode}: {detail}"
            )
        if uses_output and output_path.is_file():
            markdown = output_path.read_text(encoding="utf-8")
        else:
            markdown = result.stdout
    if not markdown.strip():
        raise LocalOcrError("local OCR command returned no Markdown")
    return markdown if markdown.endswith("\n") else markdown + "\n"


def _parse_paddleocr(
    data: bytes,
    filename: str,
    command: "str | Sequence[str] | None",
    timeout: float,
) -> str:
    """Run PaddleOCR's PP-StructureV3 CLI and collect its Markdown result."""
    configured = command or os.environ.get("ANYDOC_PADDLEOCR_COMMAND")
    if configured is None:
        configured = ["paddleocr", "pp_structurev3", "-i", "{input}", "--save_path", "{output_dir}"]
    with tempfile.TemporaryDirectory(prefix="anydoc-paddleocr-") as directory:
        output_dir = Path(directory) / "output"
        output_dir.mkdir()
        markdown = _run_ocr_command(
            data,
            filename,
            configured,
            timeout,
            replacements={"{output_dir}": str(output_dir)},
            output_dir=output_dir,
        )
    return markdown


def _run_ocr_command(
    data: bytes,
    filename: str,
    command: "str | Sequence[str]",
    timeout: float,
    *,
    replacements: dict[str, str],
    output_dir: Path | None = None,
) -> str:
    if timeout <= 0:
        raise ValueError("ocr_timeout must be greater than zero")
    try:
        arguments = shlex.split(command) if isinstance(command, str) else list(command)
    except ValueError as error:
        raise LocalOcrError(f"invalid local OCR command: {error}") from error
    if not arguments or any(not isinstance(argument, str) for argument in arguments):
        raise LocalOcrError("local OCR command must contain string arguments")
    suffix = Path(filename).suffix or ".pdf"
    with tempfile.TemporaryDirectory(prefix="anydoc-ocr-") as directory:
        input_path = Path(directory) / f"input{suffix}"
        output_path = Path(directory) / "output.md"
        input_path.write_bytes(data)
        replacements = {"{input}": str(input_path), "{output}": str(output_path), **replacements}
        uses_input = any("{input}" in argument for argument in arguments)
        uses_output = any("{output}" in argument for argument in arguments)
        expanded = [
            argument.replace("{input}", str(input_path))
            .replace("{output}", str(output_path))
            for argument in arguments
        ]
        for placeholder, value in replacements.items():
            expanded = [argument.replace(placeholder, value) for argument in expanded]
        if not uses_input:
            expanded.append(str(input_path))
        try:
            result = subprocess.run(expanded, capture_output=True, check=False, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise LocalOcrError(f"local OCR command timed out after {timeout:g} seconds") from error
        except OSError as error:
            raise LocalOcrError(f"could not run local OCR command: {error}") from error
        if result.returncode != 0:
            detail = (result.stderr.strip() or result.stdout.strip() or "no error output")[:2000]
            raise LocalOcrError(f"local OCR command exited with status {result.returncode}: {detail}")
        candidates = [output_path] if uses_output else []
        if output_dir is not None:
            candidates.extend(sorted(output_dir.rglob("*.md")))
        for candidate in candidates:
            if candidate.is_file():
                markdown = candidate.read_text(encoding="utf-8")
                if markdown.strip():
                    return markdown if markdown.endswith("\n") else markdown + "\n"
        if result.stdout.strip():
            return result.stdout if result.stdout.endswith("\n") else result.stdout + "\n"
    raise LocalOcrError("local OCR command returned no Markdown")


# The whole document goes, not only the pages that need OCR: Parse has no
# page selection.
def _parse_hosted(data: bytes, filename: str, api_key: "str | None", api_url: "str | None") -> str:
    if api_key is None:
        api_key = os.environ.get("FIRECRAWL_API_KEY")
    api_url = api_url or os.environ.get("FIRECRAWL_API_URL") or _API_URL
    url = api_url.rstrip("/") + "/v2/parse"
    options = {"parsers": [{"type": "pdf", "mode": "auto"}], "origin": f"anydoc@{_version()}"}
    boundary = uuid.uuid4().hex
    request = urllib.request.Request(
        url,
        data=_multipart(boundary, json.dumps(options), filename, data),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            status, reply = response.status, _json(response.read())
    except urllib.error.HTTPError as error:
        status, reply = error.code, _json(error.read())
    except OSError as error:
        raise HostedError(f"Firecrawl Parse: {error}") from error
    if status != 200 or not reply.get("success"):
        detail = reply.get("error") or f"HTTP {status}"
        raise HostedError(_describe(status, detail, bool(api_key)))
    data = reply.get("data")
    markdown = data.get("markdown") if isinstance(data, dict) else None
    if not isinstance(markdown, str) or not markdown:
        raise HostedError("Firecrawl Parse returned no Markdown")
    return markdown if markdown.endswith("\n") else markdown + "\n"


def _multipart(boundary: str, options: str, filename: str, data: bytes) -> bytes:
    filename = filename.replace('"', "_").replace("\r", "_").replace("\n", "_")
    return b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="options"\r\n\r\n',
            options.encode(),
            f"\r\n--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode(),
            b"Content-Type: application/pdf\r\n\r\n",
            data,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )


def _json(body: bytes) -> dict:
    try:
        reply = json.loads(body)
    except ValueError:
        return {}
    return reply if isinstance(reply, dict) else {}


def _describe(status: int, detail: str, keyed: bool) -> str:
    if status == 401:
        return f"Firecrawl Parse rejected the API key: {detail}"
    if status == 402:
        return f"Firecrawl Parse is out of credits: {detail}"
    if status == 429 and keyed:
        return f"Firecrawl Parse rate limit reached: {detail}"
    if status == 429:
        return f"Firecrawl Parse keyless limit reached, set FIRECRAWL_API_KEY: {detail}"
    return f"Firecrawl Parse: {detail}"


def _version() -> str:
    try:
        return version("firecrawl-anydoc")
    except PackageNotFoundError:
        return "unknown"


__all__ = [
    "Asset",
    "Block",
    "Cell",
    "CellSlot",
    "ConvertError",
    "Document",
    "EncryptedError",
    "Format",
    "HostedError",
    "ImageSource",
    "Inline",
    "LinkTarget",
    "List",
    "ListItem",
    "LocalOcrError",
    "MalformedError",
    "MissingPartError",
    "NeedsOcrError",
    "Note",
    "Ocr",
    "ResourceLimitError",
    "Style",
    "Table",
    "UnsupportedError",
    "format_from_bytes",
    "format_from_extension",
    "format_from_path",
    "to_document",
    "to_markdown",
    "to_markdown_bytes",
    "to_rag",
    "to_rag_bytes",
]
