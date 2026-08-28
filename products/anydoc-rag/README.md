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

## 后续规划

### V1.2：OCR 可用性与解析质量

- 接入并部署 PaddleOCR 本地命令，完成扫描 PDF 的端到端转换
- 增加 OCR 超时、失败、空输出和多页扫描文档回归样本
- 修复 PPTX 纯表格文档无法提取文本的问题，将现有 `XFAIL` 转为 `PASS`
- 为每种格式增加关键内容断言，不再只验证输出非空

验收标准：扫描 PDF 可以在不上传第三方服务的情况下生成 Markdown；公开语料和 OCR 语料回归全部通过。

> 待确认：OCR 引擎建议优先采用 PaddleOCR。安装前需要确认模型体积、CPU 性能和中文/英文模型组合。

### V1.3：批量交付与任务控制

- 支持取消未开始任务和单个任务重试
- 支持批量下载 ZIP，并提供 Markdown、RAG JSON 两种打包方式
- 增加受控并发和队列进度，避免大文件批量处理时占满资源
- 增加文件去重、同名文件区分和上传前格式检查

验收标准：50 个混合格式文件可以稳定完成批量任务，失败项可单独重试，结果可一次下载。

### V1.4：持久化与知识库集成

- 将浏览器历史升级为服务端任务历史，支持重启后恢复
- 增加结果搜索、过滤、删除和过期清理策略
- 提供标准导出接口，对接向量数据库和知识库平台
- 增加 API 鉴权、配额、审计日志和敏感信息处理

验收标准：用户可追踪历史任务并将结构化分块稳定导入至少一种向量数据库。

### V2：生产化

- 后台任务执行、断点恢复和任务优先级
- 大文件流式上传、资源限制与并发隔离
- 可观测性，包括转换耗时、失败率、格式分布和 OCR 使用率
- 多用户空间、部署文档、版本迁移和备份恢复

## 当前已知限制

- OCR 命令适配层已完成，但运行环境尚未安装 OCR 引擎和模型
- PPTX 纯表格样本当前返回 `noExtractableText`
- 最近记录保存在浏览器本地；超过约 350,000 字符的结果只保留元数据
- 批量任务目前顺序执行，尚不支持暂停、取消或 ZIP 下载
