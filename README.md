# AnyDoc RAG

基于 [firecrawl/anydoc](https://github.com/firecrawl/anydoc) 二次开发的本地文档转换产品，提供 Markdown 与 RAG JSON 输出。

产品源码位于 [`products/anydoc-rag`](products/anydoc-rag)，核心能力源码位于 [`anydoc`](anydoc)。

## 本地运行

```bash
cargo build --release --manifest-path products/anydoc-rag/Cargo.toml --locked
PORT=3000 products/anydoc-rag/target/release/anydoc-rag
```

打开 `http://127.0.0.1:3000`。

## 回归测试

```bash
products/anydoc-rag/scripts/fetch-test-corpus.sh
cargo build --release --manifest-path products/anydoc-rag/Cargo.toml --locked
products/anydoc-rag/scripts/test-corpus.sh
```
