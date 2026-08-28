# AnyDoc RAG

面向知识库入库的批量文档解析工作台，支持 Markdown 与结构化 RAG JSON 输出。

## 产品能力

- 批量上传并顺序转换，单个任务失败不会中断队列
- DOC、DOCX、ODT、PDF、PPT、PPTX、RTF、EPUB、XLS、XLSX、XLSB、ODS、ODP、CSV
- 基于标题层级的文档分块、重叠窗口、资源元数据和 SHA-256
- 浏览器本地最近记录，不需要数据库
- 扫描 PDF 可通过本地 OCR 命令适配器处理

## 本地 OCR

Rust 服务仅在本地解析返回 `NeedsOcr` 时调用 OCR 命令。命令必须包含 `{input}`，可以将 Markdown 写入 `{output}`，或直接输出到 stdout。

```bash
export ANYDOC_OCR_COMMAND='my-ocr --input {input} --markdown {output}'
export ANYDOC_OCR_TIMEOUT=120
```

PaddleOCR 命令可通过 `ANYDOC_PADDLEOCR_COMMAND` 使用同一协议配置。命令以参数数组执行，不经过 shell。

## 运行

由平台托管启动即可。

## 外部语料回归

公开测试样本及来源记录在 `testdata/external/manifest.tsv`。

```bash
./scripts/fetch-test-corpus.sh
cargo build --release --locked
./scripts/test-corpus.sh
```

浏览器冒烟测试需要 Playwright：

```bash
NODE_PATH=/usr/lib/node_modules TEST_BASE_URL=http://127.0.0.1:$PORT node scripts/ui-smoke.js
```
