use axum::{
    Json, Router,
    extract::Multipart,
    http::{HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::Path};

#[derive(Serialize)]
struct RuntimeResponse {
    product: &'static str,
    version: &'static str,
    anydoc_version: &'static str,
    ocr: RuntimeOcr,
}

#[derive(Serialize)]
struct RuntimeOcr {
    hosted: bool,
    local_command: bool,
    paddleocr_command: bool,
}

#[derive(Serialize)]
struct ConvertResponse {
    ok: bool,
    file_name: String,
    format: Option<String>,
    mode: String,
    ocr: String,
    size_bytes: usize,
    markdown: String,
    rag: Option<RagPayload>,
}

#[derive(Serialize)]
struct RagPayload {
    markdown: String,
    chunks: Vec<RagChunk>,
    assets: Vec<RagAsset>,
    metadata: RagMetadata,
}

#[derive(Serialize)]
struct RagChunk {
    id: String,
    text: String,
    metadata: RagChunkMetadata,
}

#[derive(Serialize)]
struct RagChunkMetadata {
    headings: Vec<String>,
    start_unit: usize,
    end_unit: usize,
    chars: usize,
}

#[derive(Serialize)]
struct RagAsset {
    id: usize,
    media_type: String,
    origin_part: String,
    bytes: usize,
}

#[derive(Serialize)]
struct RagMetadata {
    source: Option<String>,
    format: Option<String>,
    ocr: String,
    bytes: usize,
    chunk_count: usize,
    asset_count: usize,
    sha256: String,
}

#[derive(Default)]
struct UploadInput {
    file_name: String,
    bytes: Vec<u8>,
    mode: String,
    ocr: String,
    max_chars: usize,
    overlap: usize,
}

#[derive(Clone)]
struct Unit {
    kind: UnitKind,
    level: usize,
    text: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UnitKind {
    Heading,
    Paragraph,
    ListItem,
    Table,
    CodeBlock,
    Math,
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);

    let app = Router::new()
        .route("/", get(index))
        .route("/styles.css", get(styles))
        .route("/app.js", get(app_js))
        .route("/api/runtime", get(runtime))
        .route("/api/convert", post(convert));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

async fn styles() -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/css; charset=utf-8"),
        )],
        include_str!("../static/styles.css"),
    )
}

async fn app_js() -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/javascript; charset=utf-8"),
        )],
        include_str!("../static/app.js"),
    )
}

async fn runtime() -> Json<RuntimeResponse> {
    Json(RuntimeResponse {
        product: "AnyDoc RAG",
        version: env!("CARGO_PKG_VERSION"),
        anydoc_version: anydoc::VERSION,
        ocr: RuntimeOcr {
            hosted: std::env::var("FIRECRAWL_API_KEY").is_ok(),
            local_command: std::env::var("ANYDOC_OCR_COMMAND").is_ok(),
            paddleocr_command: std::env::var("ANYDOC_PADDLEOCR_COMMAND").is_ok(),
        },
    })
}

async fn convert(mut multipart: Multipart) -> Result<Json<ConvertResponse>, ApiError> {
    let mut input = UploadInput {
        mode: "rag".to_string(),
        ocr: "reject".to_string(),
        max_chars: 2000,
        overlap: 200,
        ..Default::default()
    };

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                input.file_name = field.file_name().unwrap_or("document").to_string();
                input.bytes = field
                    .bytes()
                    .await
                    .map_err(|error| ApiError::bad_request(error.to_string()))?
                    .to_vec();
            }
            "mode" => input.mode = field.text().await.unwrap_or_else(|_| "rag".to_string()),
            "ocr" => input.ocr = field.text().await.unwrap_or_else(|_| "reject".to_string()),
            "max_chars" => {
                input.max_chars = field
                    .text()
                    .await
                    .ok()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(2000);
            }
            "overlap" => {
                input.overlap = field
                    .text()
                    .await
                    .ok()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(200);
            }
            _ => {}
        }
    }

    if input.bytes.is_empty() {
        return Err(ApiError::bad_request("file is required"));
    }
    if input.max_chars < 200 {
        return Err(ApiError::bad_request("max_chars must be at least 200"));
    }
    if input.overlap >= input.max_chars {
        return Err(ApiError::bad_request(
            "overlap must be smaller than max_chars",
        ));
    }

    let format = anydoc::Format::from_bytes(&input.bytes)
        .or_else(|| anydoc::Format::from_path(Path::new(&input.file_name)));

    let markdown = anydoc::to_markdown_bytes(&input.bytes, format).map_err(ApiError::convert)?;
    if markdown.trim().is_empty() {
        return Err(ApiError::unprocessable(
            "noExtractableText",
            "the document contains no extractable text",
        ));
    }

    let rag = if input.mode == "rag" {
        Some(build_rag_payload(
            &input.bytes,
            &markdown,
            format,
            input.file_name.clone(),
            input.ocr.clone(),
            input.max_chars,
            input.overlap,
        )?)
    } else {
        None
    };

    Ok(Json(ConvertResponse {
        ok: true,
        file_name: input.file_name,
        format: format.map(format_name),
        mode: input.mode,
        ocr: input.ocr,
        size_bytes: input.bytes.len(),
        markdown,
        rag,
    }))
}

fn build_rag_payload(
    bytes: &[u8],
    markdown: &str,
    format: Option<anydoc::Format>,
    source: String,
    ocr: String,
    max_chars: usize,
    overlap: usize,
) -> Result<RagPayload, ApiError> {
    let document = match format {
        Some(anydoc::Format::Pdf) => None,
        Some(format) => Some(
            anydoc::to_document(bytes, format).map_err(|error| ApiError::convert(error.into()))?,
        ),
        None => None,
    };

    let assets = document.as_ref().map(asset_metadata).unwrap_or_default();
    let asset_count = assets.len();
    let chunks = match document.as_ref() {
        Some(document) => chunks_from_document(&document.blocks, max_chars, overlap),
        None => chunks_from_markdown(markdown, max_chars, overlap),
    };
    let chunk_count = chunks.len();
    let sha256 = format!("{:x}", Sha256::digest(bytes));

    Ok(RagPayload {
        markdown: markdown.to_string(),
        chunks,
        assets,
        metadata: RagMetadata {
            source: Some(source),
            format: format.map(format_name),
            ocr,
            bytes: bytes.len(),
            chunk_count,
            asset_count,
            sha256,
        },
    })
}

fn asset_metadata(document: &anydoc::model::Document) -> Vec<RagAsset> {
    document
        .assets
        .iter()
        .map(|asset| RagAsset {
            id: asset.id.0,
            media_type: asset.media_type.clone(),
            origin_part: asset.origin_part.clone(),
            bytes: asset.bytes.len(),
        })
        .collect()
}

fn chunks_from_document(
    blocks: &[anydoc::model::Block],
    max_chars: usize,
    overlap: usize,
) -> Vec<RagChunk> {
    let units = document_units(blocks);
    let mut chunks = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut headings: Vec<String> = Vec::new();
    let mut current_headings: Vec<String> = Vec::new();
    let mut start_unit = 0usize;

    for (index, unit) in units.iter().enumerate() {
        if unit.kind == UnitKind::Heading {
            let level = unit.level.saturating_sub(1);
            headings.truncate(level);
            headings.push(unit.text.clone());
        }
        let text = unit.text.trim();
        if text.is_empty() {
            continue;
        }
        if !current.is_empty() && joined_len(&current, text) > max_chars {
            chunks.push(make_chunk(
                chunks.len(),
                &current,
                &current_headings,
                start_unit,
                index - 1,
            ));
            current = overlap_tail(&current, overlap);
            start_unit = index.saturating_sub(current.len());
        }
        if current.is_empty() {
            current_headings = headings.clone();
            start_unit = index;
        }
        current.push(text.to_string());
    }

    if !current.is_empty() {
        chunks.push(make_chunk(
            chunks.len(),
            &current,
            &current_headings,
            start_unit,
            units.len().saturating_sub(1),
        ));
    }
    chunks
}

fn chunks_from_markdown(markdown: &str, max_chars: usize, overlap: usize) -> Vec<RagChunk> {
    let paragraphs: Vec<String> = markdown
        .split("\n\n")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    let mut chunks = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut start_unit = 0usize;

    for (index, paragraph) in paragraphs.iter().enumerate() {
        if !current.is_empty() && joined_len(&current, paragraph) > max_chars {
            chunks.push(make_chunk(
                chunks.len(),
                &current,
                &[],
                start_unit,
                index - 1,
            ));
            current = overlap_tail(&current, overlap);
            start_unit = index.saturating_sub(current.len());
        }
        if current.is_empty() {
            start_unit = index;
        }
        current.push(paragraph.clone());
    }

    if !current.is_empty() {
        chunks.push(make_chunk(
            chunks.len(),
            &current,
            &[],
            start_unit,
            paragraphs.len().saturating_sub(1),
        ));
    }
    chunks
}

fn make_chunk(
    index: usize,
    parts: &[String],
    headings: &[String],
    start_unit: usize,
    end_unit: usize,
) -> RagChunk {
    let text = parts.join("\n\n").trim().to_string();
    RagChunk {
        id: format!("chunk-{index}"),
        text: text.clone(),
        metadata: RagChunkMetadata {
            headings: headings.to_vec(),
            start_unit,
            end_unit,
            chars: text.len(),
        },
    }
}

fn joined_len(parts: &[String], next_part: &str) -> usize {
    if parts.is_empty() {
        return next_part.len();
    }
    parts.iter().map(String::len).sum::<usize>() + 2 * parts.len() + next_part.len()
}

fn overlap_tail(parts: &[String], overlap: usize) -> Vec<String> {
    if overlap == 0 {
        return Vec::new();
    }
    let mut kept = Vec::new();
    let mut total = 0usize;
    for part in parts.iter().rev() {
        let projected = total + part.len();
        if !kept.is_empty() && projected > overlap {
            break;
        }
        kept.insert(0, part.clone());
        total = projected;
    }
    kept
}

fn document_units(blocks: &[anydoc::model::Block]) -> Vec<Unit> {
    let mut units = Vec::new();
    for block in blocks {
        match block {
            anydoc::model::Block::Heading { level, content, .. } => units.push(Unit {
                kind: UnitKind::Heading,
                level: *level as usize,
                text: anydoc::model::inlines_to_plain_text(content),
            }),
            anydoc::model::Block::Paragraph(content) => units.push(Unit {
                kind: UnitKind::Paragraph,
                level: 0,
                text: anydoc::model::inlines_to_plain_text(content),
            }),
            anydoc::model::Block::List(list) => {
                for (item_index, item) in list.items.iter().enumerate() {
                    let item_text = block_texts(&item.blocks).join("\n");
                    let marker = item
                        .marker_label
                        .clone()
                        .unwrap_or_else(|| list.marker.label((item_index + 1) as u64));
                    units.push(Unit {
                        kind: UnitKind::ListItem,
                        level: 0,
                        text: format!("{marker} {item_text}").trim().to_string(),
                    });
                }
            }
            anydoc::model::Block::Table(table) => {
                let mut rows = Vec::new();
                for row in &table.grid {
                    let mut cells = Vec::new();
                    for slot in row {
                        if let anydoc::model::CellSlot::Origin(cell) = slot {
                            cells.push(block_texts(&cell.blocks).join(" "));
                        }
                    }
                    if !cells.is_empty() {
                        rows.push(cells.join(" | "));
                    }
                }
                units.push(Unit {
                    kind: UnitKind::Table,
                    level: 0,
                    text: rows.join("\n"),
                });
            }
            anydoc::model::Block::BlockQuote(blocks) => units.extend(document_units(blocks)),
            anydoc::model::Block::CodeBlock { text, .. } => units.push(Unit {
                kind: UnitKind::CodeBlock,
                level: 0,
                text: text.clone(),
            }),
            anydoc::model::Block::Math(text) => units.push(Unit {
                kind: UnitKind::Math,
                level: 0,
                text: text.clone(),
            }),
            anydoc::model::Block::Rule => {}
        }
    }
    units
}

fn block_texts(blocks: &[anydoc::model::Block]) -> Vec<String> {
    document_units(blocks)
        .into_iter()
        .map(|unit| unit.text)
        .filter(|text| !text.trim().is_empty())
        .collect()
}

fn format_name(format: anydoc::Format) -> String {
    match format {
        anydoc::Format::Doc => "doc",
        anydoc::Format::Docx => "docx",
        anydoc::Format::Odt => "odt",
        anydoc::Format::Pdf => "pdf",
        anydoc::Format::Ppt => "ppt",
        anydoc::Format::Pptx => "pptx",
        anydoc::Format::Rtf => "rtf",
        anydoc::Format::Epub => "epub",
        anydoc::Format::Excel => "excel",
        anydoc::Format::Ods => "ods",
        anydoc::Format::Odp => "odp",
        anydoc::Format::Csv => "csv",
    }
    .to_string()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "badRequest",
            message: message.into(),
        }
    }

    fn unprocessable(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code,
            message: message.into(),
        }
    }

    fn convert(error: anydoc::ConvertError) -> Self {
        let status = match &error {
            anydoc::ConvertError::NeedsOcr { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            anydoc::ConvertError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        Self {
            status,
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({
            "ok": false,
            "error": self.message,
            "code": self.code
        }));
        (self.status, body).into_response()
    }
}
