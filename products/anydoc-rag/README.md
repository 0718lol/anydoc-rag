# AnyDoc RAG

文档上传、Markdown 转换和 RAG 输出一体的产品壳。

## 运行

由平台托管启动即可。

## 外部语料回归

公开测试样本及来源记录在 `testdata/external/manifest.tsv`。

```bash
./scripts/fetch-test-corpus.sh
cargo build --release --locked
./scripts/test-corpus.sh
```
