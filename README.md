# AnyDoc RAG

基于 [firecrawl/anydoc](https://github.com/firecrawl/anydoc) 二次开发的本地文档转换产品，提供 Markdown 与 RAG JSON 输出。

产品源码位于 [`products/anydoc-rag`](products/anydoc-rag)，核心能力源码位于 [`anydoc`](anydoc)。

## 当前状态

当前版本已经具备可用的 V1.1 产品能力：

- 批量上传和顺序转换，单个失败不会中断队列
- Markdown 与结构化 RAG JSON 输出
- 标题感知分块、重叠窗口、资源元数据和 SHA-256
- 浏览器本地最近记录、复制和单文件下载
- 响应式工作台，支持桌面和移动端
- 本地 OCR 命令适配器，支持 `{input}`、`{output}`、stdout 和超时
- 13 份公开格式语料回归（包含格式级关键文本断言）和浏览器冒烟测试

## Roadmap

### V1.2：OCR 与解析质量

- 部署 PaddleOCR，打通扫描 PDF 的本地端到端转换
- 增加扫描、多页、失败和超时 OCR 回归数据
- 修复 PPTX 纯表格提取，将现有 `XFAIL` 转为 `PASS`
- 已为现有 13 份公开格式语料增加关键内容断言；后续 OCR 语料仍需单独补充

验收标准：扫描 PDF 无需第三方服务即可生成 Markdown，公开语料和 OCR 语料回归全部通过。

待确认事项：PaddleOCR 模型体积、CPU 性能，以及中文/英文模型组合。

### V1.3：批量交付

- 取消、单项重试和受控并发
- Markdown / RAG JSON 批量 ZIP 下载
- 文件去重、同名文件区分和上传前格式检查
- 50 个混合格式文件稳定性测试

### V1.4：持久化与集成

- 服务端任务历史、搜索、过滤和自动清理
- 向量数据库与知识库标准导出接口
- API 鉴权、配额、审计日志和敏感信息处理

### V2：生产化

- 后台任务、断点恢复、优先级和资源隔离
- 大文件流式上传
- 转换耗时、失败率、格式分布和 OCR 使用率监控
- 多用户空间、部署迁移与备份恢复

## 已知限制

- OCR 适配层已完成，但默认运行环境尚未安装 OCR 引擎和模型
- PPTX 纯表格样本目前返回 `noExtractableText`
- 最近记录保存在浏览器本地，大结果只保留元数据
- 批量任务目前顺序执行，尚不支持暂停、取消或 ZIP 下载

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
