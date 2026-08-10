# Implementation Plan: 工卡管理（Task Card Management）

## Overview

本实施计划将 design.md 转化为增量、测试驱动的编码任务序列，覆盖 requirements.md 全部 **49 条需求**与 design.md 全部 **35 条正确性属性**。

`HAECO-MES-TS` 为**全新独立全栈项目**（当前仅含 `.kiro/` 与 `docs/`），因此计划自脚手架起步：server 包 → 数据库 schema/migrate/seed → 领域纯函数 → 仓储 → 服务 → 身份权限 → REST 路由 → web 包与三大界面。测试基座为 Vitest + fast-check + Supertest。

**执行顺序**：统一契约 → 领域枚举（作为 schema CHECK 的唯一事实来源）→ 数据库层 → 领域纯函数层 → 仓储层 → 服务层（事务边界）→ 身份与权限 → REST 路由 → 前端。每一步基于前一步构建，无游离代码。

**技术栈**（固定，见 design.md）：Node.js + Express + better-sqlite3（后端）；Vue 3 + Vue Router 4 + Pinia + Element Plus + Vite（前端）；Vitest + fast-check + Supertest（测试）。所有 REST 接口返回 `{ code, message, data }`。

**测试约定**：标 `*` 的子任务为可选测试任务，核心实现任务不标注。每条属性各占**一个独立子任务**，按 design.md「Correctness Properties」的**被测层次**分两类：

| 类别 | 属性 | 被测对象 | 迭代次数 |
|------|------|----------|----------|
| 纯函数属性 | Property 1–12、14–24、26–30、32、33、**35** | `server/src/domain/*` 纯函数 | `numRuns: 100` |
| 事务/持久化属性 | **Property 13（回滚部分）、25、31、34** | 服务层 + 内存 SQLite（每迭代重建 schema+seed） | `numRuns: 30` |

标签格式：`// Feature: task-card-management, Property {number}: {property_text}`

---

## 关键实现约束（不得回归）

以下七项是设计评审定案的硬约束，实现时**任一处违反即为缺陷**，并已各自绑定属性测试：

1. **编辑态闸门（Property 26）**：编制域内容**仅**在 `status === 'New'` 时可修改。`isEditable(card)` 为服务层入口的统一前置闸门，覆盖全部编辑入口（工卡保存、工序增删改与排序、参考文件、采集项、组件、签署项、关联、批量替换）。审核中/生效/已被取代/作废四态一律 `422`。生效态内容变更须先升版（需求 49.1–49.4）。反之，需求 49.8 列举的**非内容变更**操作（查看、打印、导出、复制、升版、作废、发布）在生效态**必须放行**，不可被闸门误拦。

2. **批准事务语句顺序（Property 25）**：`UNIQUE(task_no) WHERE status='Effective'` 是 SQLite 部分唯一索引，**语句级立即校验**。批准服务必须按「①原生效版本 → `Superseded` + 写 `supersede_record`；②本版本 → `Effective` + 写 `review_record`」顺序执行，两步同一事务。**顺序颠倒会在第一条 UPDATE 即撞索引**，触发回滚导致任何版本都无法生效。属性测试须校验**每条语句执行后**的单一生效不变式，而非仅最终态。

3. **两域分离（Property 31）**：`task_card` 表**不含** `start_time` / `finish_time`，也不含 OWNER / JOB TARGET DATE / Check / 进厂·出厂 P/N·S/N / CSNo. / WORK ORDER 与 Process Card 四字段——全部落 `job` 表。工卡级起止时间是 `job.start_time` / `job.finish_time`，工序级是 `job_process.start_time` / `job_process.finish_time`。任何执行期写入都不得修改 `task_card` 行的任何字段。

4. **工序快照隔离（Property 34）**：释放生成 JOB 时须在同一事务内建 `job_step_snapshot`。JOB 的执行与呈现**只读快照**，`job_process.step_id` 仅作溯源，不作读取依赖。后续改编制域模板不得改变既有 JOB 的作业内容。

5. **Stage 可改选（Property 28）**：`defaultStageFor` 给出**默认值**，Stage 字段**不置只读**。`selectableStages` = 该类型允许组合 ∪ 横切取值 `{DMY, NRC, WCC, WFD}`，保证横切取值对**任意**工卡类型可达。若置只读，WFD 对类型 01–10 永久不可标记，需求 46.5 的 WFD 排除逻辑随之失效。

6. **单一事实来源与配置驱动**：枚举权威定义在 `server/src/domain/enums.js`，`schema.sql` 的 `CHECK` 由其渲染生成，禁止两处手写。属于 Hotfix 待澄清的枚举（`SIGNATURE_ROLE`/A3、`STAGE_CROSSCUT`/A4、`DERIVATION_PRIORITY`/A1）**同时**落配置表，运行时以配置表为权威，`enums.js` 仅作种子默认值。四组配置（Stage×类型约束表、类型→商务分类映射、派生优先级链、能力清单）均须提供 `config_write` / `capability_write` 写端点——「改配置不改代码」必须有可操作入口，否则需求 29.8、43.5、46.14 落空。

7. **变更留痕单点（Property 35）**：`domain/change-record.js` 的 `buildChangeRecords` 是**全部编辑入口共用的唯一留痕构造点**（保存、工序/参考文件删除、升版、批量替换、作废）。任何编辑路径绕过该单点自行拼 `change_record` 行即为缺陷——变更记录是适航可追溯性的核心证据，不得因入口不同而缺失。`reason` 为空或纯空白时整体拒绝，变更不落库。

> 其余数据模型要点：工卡状态五值（新增/审核中/生效/已被取代/作废）；WBS 与工卡类型为**同一字段**，仅存 `task_card.card_type` 单列（**不得**建 `wbs` 列），IR 卡判定 `card_type='04'`；条码归 `job_process`（`UNIQUE(barcode_value)`），编制态不生成；`revision` 存 **INTEGER**，两位补零仅用于 UI/打印/导出展示；商务分类 `task_card.commercial_classification` 为当前权威值，`commercial_classification_result` 为追加式审计轨迹；SWS 为 `exec_document` 表中 `exec_doc_type='SW'` 的实例，本模块只提供复制与读取、**不提供其编制界面**（需求 23.3）。

---

## Tasks

- [x] 1. 建立后端脚手架与统一响应契约
  - [x] 1.1 初始化 server 项目结构与依赖
    - 创建 `server/package.json`（`type: module`），运行依赖：express、better-sqlite3、multer（附件上传）、xlsx（Excel 解析）、mammoth（Word 转 HTML）；开发依赖：vitest、fast-check、supertest
    - 创建目录骨架 `server/src/{db,domain,repositories,services,routes,middleware,storage,lib}`
    - 配置 `vitest.config.js` 与 npm scripts：`test`、`migrate`、`seed`、`start`
    - _Requirements: 无（基础设施）_
  - [x] 1.2 实现响应信封与错误码契约
    - 在 `server/src/lib/response.js` 实现 `ok(data, message)` 与 `fail(code, message, data)`
    - 错误码：`0` 成功 / `400` 校验失败 / `401` 未识别身份 / `403` 越权 / `404` 未找到 / `409` 重复冲突 / `422` 状态或前置条件非法 / `500` 异常
    - **实现 code 与 HTTP status 的镜像约定**：非零 `code` 恒设为同值 HTTP status，`code:0` 恒为 HTTP 200。业务上「部分失败但整批成功」（迁移逐条失败、分类待人工确认、集成数据缺失）一律用 `code:0` + `data` 内明细承载，不占用错误码
    - _Requirements: 通用（Error Handling 节统一约定）_

- [x] 2. 实现领域枚举模块（schema 的唯一事实来源）
  - [x] 2.1 实现枚举集合与封闭性校验
    - 在 `server/src/domain/enums.js` 定义并导出：`AC_TYPE`(20)、`GEAR_TYPE`(6)、`STAGE`(8)、`SKILL`(20)、`CTRL_CODE`(9)、`CARD_TYPE`(01–11)、`EXEC_DOC_TYPE`(11) 与 `EXEC_DOC_SIGN_RULE`、`CARD_STATUS`(5)、`ALLOWED_TRANSITIONS`、`COMPONENT_TYPE`(**13** 类，含 `signature`)、`SIGNATURE_ROLE`、`COMMERCIAL_CLASSIFICATION`(9)、`OUTSOURCE_SUBTYPE`、`DERIVATION_PRIORITY`(P1–P6)、`ROLE`(8)、**`PERMISSION_POINT`(13 项，含 `config_write`、`capability_write`、`batch_replace`)**、`STAGE_CROSSCUT`
    - 实现 `isValidEnumValue(field, value)`；**Ctrl Code 与 Skill 为相互独立值域**，同码（AS、CL）不同义，不合并、不共用字典
    - 导出 `renderCheckConstraint(field)` 供 `schema.sql` 生成时使用，确保枚举不在 DDL 中二次手写
    - _Requirements: 6.3–6.10, 16.1, 16.2, 16.4, 16.5, 29.1, 29.3, 45.2, 47.1, 4.5_
  - [x]* 2.2 编写枚举封闭性属性测试
    - **Property 5: 枚举封闭性与值域独立**
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.6, 6.7, 6.9, 6.10, 16.1, 16.2**
    - fast-check 生成枚举内/外候选值，断言判定当且仅当值属于对应集合；额外断言 `isValidEnumValue('ctrlCode','GR')` 为假而 `isValidEnumValue('skill','GR')` 为真（值域独立），`numRuns: 100`

- [x] 3. 建立 SQLite 数据库层（架构、迁移、种子）
  - [x] 3.1 实现数据库连接单例
    - 在 `server/src/db/connection.js` 用 better-sqlite3 打开 `data/haeco-mes-ts.db`，`PRAGMA foreign_keys = ON`，导出同步连接单例
    - 支持环境变量指向临时库或 `:memory:`，供属性测试与接口测试逐次重建
    - _Requirements: 无（基础设施）_
  - [x] 3.2 编写编制域表 DDL
    - 以 design.md「Data Models」为**唯一权威**。`task_card`：枚举列 CHECK 由 `enums.js` 渲染；`card_type` **单列**（= WBS，不建 `wbs` 列）；`revision` INTEGER NOT NULL DEFAULT 1；`UNIQUE(task_no, revision)`；**部分唯一索引 `UNIQUE(task_no) WHERE status='Effective'`**；**不含** `start_time`/`finish_time`、执行期字段与 Process Card 字段
    - `reference_document`；`process_step`（`skill` **CHECK ∈ SKILL**、`ref_doc_id` FK → reference_document、`operation` 只读列、`UNIQUE(card_id, process_id)`；**不含**条码列、执行工时与起止时间列）
    - `capture_item`（**`type` NOT NULL CHECK ∈ COMPONENT_TYPE** + `config` JSON，落实需求 12.2「与组件体系共用类型定义」）
    - `inserted_component`（`type` CHECK ∈ 13 类；`payload` JSON，图片/视频/音频引用 `attachmentId`）
    - `signature_requirement`、`attachment`、`card_relation`（`UNIQUE(card_id, exec_doc_type, related_doc_no)`，含 `origin` CHECK ∈ ('manual','auto') 与 `key_info_snapshot` JSON）、`lot_list_link`、`bom_base_output`
    - **`exec_document`（新增）**：`exec_doc_type` CHECK ∈ EXEC_DOC_TYPE、`doc_no`、`revision` INTEGER DEFAULT 1、`status` CHECK ∈ CARD_STATUS、`title`、`content` JSON、`source_card_id` FK NULL、`created_by`/`created_at`；`UNIQUE(exec_doc_type, doc_no, revision)`。此为 SWS 复制的落位实体，保持最小结构（`content` 为 JSON 而非展开列，见待确认项 D-07）
    - _Requirements: 6.1–6.10, 8.1–8.3, 9.1–9.3, 11.1, 11.2, 12.1–12.3, 13.1–13.3, 17.1, 18.1, 18.2, 21.1–21.3, 23.1–23.3, 28.1–28.4, 29.1, 29.3, 30.1, 31.1–31.4, 36.1–36.3, 38.6, 38.7, 44.7, 45.1–45.5, 48.1, 48.2_
  - [x] 3.3 编写执行域表 DDL
    - `job`：`job_no` UNIQUE；`card_id`/`card_revision`/`pid_no`；`owner`、`job_target_date`（PPC 排产带出）、`check_type`、`inbound_gear_pn`/`inbound_sn`、`cs_no`、`work_order`、`outbound_gear_pn`；Process Card 四字段 `part_no`/`part_sn`/`part_desc`/`operation_type`（Process Data 带出）；**`start_time`/`finish_time`（工卡级起止时间的唯一落位）**；`exec_status`（供作废前置校验）
    - `job_process`：`UNIQUE(job_id, process_id)` + `UNIQUE(barcode_value)`；`start_time`/`finish_time`、`effective_man_hours`/`actual_man_hours`；`step_id` 仅作溯源
    - **`job_step_snapshot`**：`job_process_id` FK UNIQUE、`source_step_id`、`source_card_revision` NOT NULL、`content` JSON NOT NULL、`snapshot_at` NOT NULL；只写不改，无更新入口
    - `safety_acknowledgement`、`electronic_signature`
    - _Requirements: 11.4, 15.1, 15.2, 26.1–26.5, 27.1–27.5, 31.5–31.7, 32.2–32.4, 33.1–33.8, 37.1–37.5, 42.1, 49.5–49.7_
  - [x] 3.4 编写流程与审计域表 DDL
    - `review_record`（`comment` NOT NULL）、`supersede_record`、`change_record`（`change_type` 含 `edit|delete|revise|batch_replace|void`；`field`/`old_value`/`new_value` 支持字段级前后值；`reason` NOT NULL）
    - `commercial_classification_result`（追加式，含 `hit_tier`、`source_ref`、`is_manual_confirmed`、`confirmed_by`/`confirmed_at`）
    - `migration_batch` / `migration_record`（`status`、`failure_reason`）、`work_package_release`、**`access_denial_log`**
    - _Requirements: 19.1–19.3, 20.8, 24.3, 29.5, 29.6, 34.6–34.9, 41.4, 41.5, 42.5, 44.1, 44.2, 47.10_
  - [x] 3.5 编写配置、主数据与集成 mock 表 DDL
    - **`app_user`**（`staff_no` UNIQUE、`name`、`role` CHECK ∈ ROLE、`is_active`；**不含口令列**）、**`role_permission`**（`permission_point` **CHECK ∈ PERMISSION_POINT**）
    - `system_parameter`、`stage_card_type_constraint`（`card_type`/`allowed_stage`/`is_auto_fill`）、`stage_crosscut`、`card_type_commercial_map`、`derivation_priority_config`（`tier_code`/`tier_order`/`enabled`）
    - `capability_list`（`ac_type`/`gear_type`/`skill`/`revision`/`effective_from`/`effective_to`）、`print_template`（`target_kind`/`target_code`/`template_body`/`is_default`）、`exec_doc_type`（`code`/`name`/`sign_rule`）
    - `task_no_sequence`、`step_template`
    - 集成 mock 表（本模块**只读**，无写端点）：`tpc_document`、`ppc_process_data`、**`ppc_schedule`**（`pid_no`/`card_id`/`job_target_date`，需求 26.4 的来源）、**`process_data`**（`pid_no`/`card_id`/`step_ref`/`part_no`/`part_sn`/`part_desc`/`operation_type`/`operation`，需求 27.2、30.1 的来源）、**`lot_list_base`**（`lot_list_ref`/`lot_number`/`base_number`，需求 48.3 的来源）
    - _Requirements: 7.3, 11.3, 14.1, 14.2, 16.2, 16.4, 16.5, 25.1, 25.2, 26.4, 27.2, 29.8, 30.1, 35.1, 38.8, 38.9, 39.1, 39.4, 40.1, 40.2, 43.1, 43.5, 46.9, 46.13, 46.14, 47.1–47.9, 48.3, 48.8_
  - [x] 3.6 实现迁移脚本与种子数据
    - `server/src/db/migrate.js` 读取并执行 `schema.sql`（DDL 中枚举 CHECK 由 `enums.js` 渲染，不手写）
    - `server/src/db/seed.js` 写入：`app_user` 每角色至少一个演示账号（**TS_Engineer 与 TS_Manager 各不少于两个**，供一编一审用例）；`role_permission` 8 角色 × 13 权限点矩阵（`batch_replace`、`config_write`、`capability_write` 均为独立权限点，不由 `card_edit` 继承）；`exec_doc_type` 11 条含 `sign_rule`（SC = 单据不签署、其所发工卡步骤需签署）
    - `stage_card_type_constraint` 默认数据（01–09→RTN `is_auto_fill=1`、10→SPC `is_auto_fill=1`、11→CUS/MOD `is_auto_fill=0`）、`stage_crosscut`（DMY/NRC/WCC/WFD）、`card_type_commercial_map`（需求 43.2 全部条目）、`derivation_priority_config`（P1–P6 顺序）
    - `system_parameter`（组织名称）、`capability_list` 样例（含跨生效期与多 revision 记录以覆盖需求 39.4 判定）、`print_template` 默认模板一条
    - 集成 mock 数据：`tpc_document`、`ppc_process_data`、**`ppc_schedule`**（含 JOB TARGET DATE 样例与故意缺失的 PID 以覆盖「取不到值则留空且不阻断」分支）、**`process_data`**（PART No/S/N/DES./Operation Type 与工序 Operation）、**`lot_list_base`**（同一 `lot_list_ref` 下多条 Base）、少量演示工卡与工序、`exec_document` 样例（`exec_doc_type='SW'`，供 SWS 复制用例取数）
    - 上述 Hotfix 项种子须在注释中标注对应《临时设计说明》条目（A1/A3/A4/A6），便于澄清后定位
    - _Requirements: 6.3–6.8, 16.1, 16.2, 16.4, 23.2, 25.1, 25.2, 26.4, 27.2, 29.8, 30.1, 35.1, 39.1, 39.4, 40.4, 43.1, 43.2, 46.9, 46.13, 47.1–47.9, 48.3_
  - [x]* 3.7 编写数据库约束单元测试
    - 断言：`UNIQUE(task_no, revision)` 拦重复；**部分索引在同一 `task_no` 出现第二个 `Effective` 时报错**（此为 Property 25 语句顺序约束的成因，须先在此显式验证）；枚举 CHECK 拦非法值；`exec_document` 的 `UNIQUE(exec_doc_type, doc_no, revision)` 拦重复；`task_card` 无 `start_time`/`finish_time` 列；`process_step` 无条码列
    - _Requirements: 38.6, 38.7, 44.7, 6.9, 15.3, 23.2, 33.1_

- [x] 4. Checkpoint — 契约与数据层
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 实现工卡基础规则领域模块（纯函数）
  - [x] 5.1 实现状态机、可编辑态与发布前置
    - 在 `server/src/domain/card-rules.js` 实现 `canTransition(from, to)`（依 `ALLOWED_TRANSITIONS` 五态，Superseded/Void 无出边）
    - 实现 **`isEditable(card)` = `card.status === 'New'`**，以及 `canRelease(card)` = `card.status === 'Effective'`
    - 在 `server/src/domain/supersede.js` 实现 `isFrozen(card)` = `!isEditable(card)`（四态均冻结，**非**仅终态）
    - _Requirements: 4.1–4.3, 4.5–4.7, 24.1, 24.2, 34.3, 44.4, 44.5, 49.1, 49.2_
  - [x] 5.2 实现升版、复制、查重与 BOM 字段条件
    - `nextRevision(card)` 返回**默认**版本号（原版本+1），Task No 不变；调用方可传入手动指定版本号覆盖，覆盖值须经 `checkDuplicate` 校验
    - `copyCard(card, newTaskNo)`：内容逐字段一致，`status='New'`、`revision` 置初始值；源工卡保持不变
    - `checkDuplicate(cards, taskNo, revision, excludeId)` 仅在**相同版本号**内判重
    - `requiresBomFields(card)` = `card.card_type === '04'`（判定仅依赖单一 `card_type` 列）
    - _Requirements: 3.3, 3.4, 6.8, 7.1, 7.5, 8.1–8.3, 10.4, 10.5, 38.1–38.6_
  - [x] 5.3 实现打印投影（含逐工序签署栏）
    - `printProjection(card, template, jobContext?)`：剔除 `card_type`；含最小信息集全部字段（组织名称、编号、标题、参考文件与版本、修订版本与日期、适用机型/件号、工序步骤与记录栏、特殊工具/耗材、工时与起止时间栏、维修草图）
    - **按每道工序的 `signature_requirement` 配置逐工序输出签署栏**（签署人 / 签章 / 完成日期栏位），签署栏集合与配置一一对应：不产出无配置来源的签署栏，也不遗漏已配置的签署栏（需求 45.7）
    - `jobContext` 缺省为**编制态投影**（工时、起止时间、签署栏输出为空白待填栏位），传入时为**执行态投影**（带出实际工时、起止时间与签署记录）；`revision` 输出两位补零文本
    - _Requirements: 5.2, 5.3, 16.3, 33.9, 45.7_
  - [x]* 5.4 编写状态迁移合法性属性测试
    - **Property 1: 状态迁移合法性**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 4.7**
    - fast-check 生成五态全组合迁移对，断言当且仅当 `to ∈ ALLOWED_TRANSITIONS[from]` 为真，Superseded/Void 无出边，`numRuns: 100`
  - [x]* 5.5 编写编辑态封闭性属性测试
    - **Property 26: 编辑态封闭性与终态不可迁出**（纯函数部分：`isEditable` / `isFrozen` 对五态的判定）
    - **Validates: Requirements 4.7, 34.3, 42.3, 42.4, 44.4, 44.5, 44.6, 49.1, 49.2, 49.3, 49.4, 49.8**
    - 断言仅 `New` 可编辑；另断言 `Effective` 态在需求 49.8 列举的非内容变更操作（查看/打印/导出/复制/升版/作废/发布）上不被冻结，`numRuns: 100`
  - [x]* 5.6 编写升版属性测试
    - **Property 2: 升版单调递增且保持编号**
    - **Validates: Requirements 3.4, 7.1, 7.5, 38.4, 38.5, 38.6**
    - 含手动指定版本号的唯一性拒绝（需求 7.5）；无论默认或手动，`task_no` 恒不变、新版本状态恒为 New，`numRuns: 100`
  - [x]* 5.7 编写 IR 卡 BOM 字段条件性属性测试
    - **Property 6: IR 卡 BOM 字段条件性**
    - **Validates: Requirements 8.1, 8.2, 8.3, 6.8**
    - 断言判定仅依赖单一 `card_type` 列，不存在第二列（WBS 为其别名），`numRuns: 100`
  - [x]* 5.8 编写查重一致性属性测试
    - **Property 7: 查重一致性**
    - **Validates: Requirements 10.4, 10.5, 38.6**
    - 断言不同版本的相同 `task_no` 不构成重复，`numRuns: 100`
  - [x]* 5.9 编写打印投影属性测试
    - **Property 8: 打印隐藏分类**
    - **Validates: Requirements 5.2, 5.3, 16.3, 33.9, 45.7**
    - 断言输出不含 `card_type` 且含最小信息集全部字段；**并断言每道工序的签署栏集合与其 `signature_requirement` 配置一一对应**（无孤立签署栏、无遗漏签署栏），`numRuns: 100`
  - [x]* 5.10 编写发布前置条件属性测试
    - **Property 15: 发布前置条件**
    - **Validates: Requirements 24.1, 24.2, 24.3**
    - 断言仅 `Effective` 可发布，且无论成功与否均记录一次发布结果，`numRuns: 100`

- [x] 6. 实现版本取代、审核、编号生成与单据复制领域模块（纯函数）
  - [x] 6.1 实现版本取代规则
    - 在 `supersede.js` 实现 `supersedeOnApprove(cards, approvedCard)`：产出「须降级为 Superseded 的原生效版本」与取代记录（被取代版本号/取代版本号/取代时间），并**以「先降级、后生效」的操作序列形式返回**，供服务层按序执行
    - 保证同一 Task No 下生效版本数不超过 1；版本取代不填作废原因、不走作废流程
    - _Requirements: 38.7, 44.1–44.3, 44.7_
  - [x] 6.2 实现提交审核校验清单与审核动作接受条件
    - 在 `server/src/domain/review.js` 实现 `submitReviewChecklist(card, ctx)`，依次执行 **(a)** 查重 **(b)** 枚举 **(c)** 必填（最小信息集字段集，见《临时设计说明》D-04）**(d)** 能力清单 **(e)** 变更原因 **(f)** 签署项配置 **(g)** Stage×工卡类型组合，返回未通过项清单
    - 实现 `canApprove(card, userId)`（审卡权限 ∧ `userId !== card.created_by`）与 `acceptReviewAction(card, action, comment)`（态为 UnderReview ∧ 意见非空）
    - _Requirements: 22.1–22.3, 34.1, 34.2, 34.4–34.7, 34.10, 34.11, 39.2, 45.9, 46.10_
  - [x] 6.3 实现批量编号生成
    - 在 `server/src/domain/task-no.js` 实现 `generateTaskNoBatch(rule, existing, count)`，按前缀/后缀/起始序号/步长生成，命中已占用序号时自动跳至下一可用序号
    - _Requirements: 38.8–38.10_
  - [x] 6.4 实现执行过程单据（含 SWS）复制
    - 在 `server/src/domain/exec-doc.js` 实现 `copyExecDocument(doc, newDocNo)`：`content` 与其余业务字段逐字段克隆，`doc_no` 取传入的不重复新值，`status='New'`、`revision` 置初始值，源单据保持不变——与 `copyCard` **同语义**
    - SWS 即 `exec_doc_type === 'SW'` 的实例；本模块只提供复制与读取，**不实现 SWS 编制表单**（需求 23.3 归属待澄清）
    - _Requirements: 23.1, 23.2, 38.1–38.3_
  - [x]* 6.5 编写提交审核校验完备性属性测试
    - **Property 19: 提交审核校验完备性与审核记录归档**
    - **Validates: Requirements 34.1, 34.2, 34.4, 34.5, 34.6, 34.7, 34.8, 34.9, 34.10, 34.11, 46.10**
    - 校验清单为 **(a)–(h)** 八项全通过方可进入审核中，其中 (h) 要求最新持久化商务分类为唯一 `derived` 或人工 `confirmed`；每次被接受的审核动作使该版本审核记录数恰好 +1；升版新版本审核记录数初始为 0。注：需求 34.3 由 Property 26 覆盖，本属性不断言，`numRuns: 100`
  - [x]* 6.6 编写一编一审属性测试
    - **Property 14: 一编一审**
    - **Validates: Requirements 22.1, 22.2, 22.3**
    - `numRuns: 100`
  - [x]* 6.7 编写复制内容一致属性测试
    - **Property 3: 复制内容一致**
    - **Validates: Requirements 3.3, 23.1, 23.2**
    - **须同时覆盖两类实体**：`copyCard` 的工卡副本与 `copyExecDocument` 的执行过程单据（含 SWS）副本，断言除 `id`/编号/`status`/`revision` 外逐字段相等且源对象不变，`numRuns: 100`
  - [x]* 6.8 编写复制/升版编号与状态属性测试
    - **Property 20: 复制/升版的编号与状态规则**
    - **Validates: Requirements 38.1, 38.2, 38.3, 38.4, 38.5, 38.8, 38.9, 38.10, 23.2**
    - **须同时覆盖两类实体**：工卡副本 `task_no` 不与现存重复、批量复制跳过占用序号；单据副本 `doc_no` 不与现存重复；两者版本号均为初始值、状态均为 New，`numRuns: 100`

- [x] 7. 实现工序编号、条码、快照与时间聚合领域模块（纯函数）
  - [x] 7.1 实现工序编号与条码生成
    - 在 `server/src/domain/process-id.js` 实现 `generateProcessId(card, seq)`：大写字母序 A–Z，超过 26 道后为 AA、AB…（《临时设计说明》D-02）
    - 在 `server/src/domain/barcode.js` 实现 **`generateBarcode(jobNo, processId)`** = `` `${jobNo}-${processId}` ``（D-03，Code128；二维码承载同一字符串）。**编制态不生成条码**，本函数只在释放路径被调用
    - _Requirements: 11.1, 15.1–15.4_
  - [x] 7.2 实现工序内容快照构建
    - 在 `server/src/domain/snapshot.js` 实现 `buildStepSnapshots(steps, captureItems, components, sigReqs)`，产出不可变快照对象：`{processId, skill, refDoc, descriptionZh, descriptionEn, safetyWarning, visualCue, repairTips, isCritical, captureItems[], components[], signatureRequirements[]}` 及 `sourceCardRevision`
    - _Requirements: 37.5, 49.5, 49.6_
  - [x] 7.3 实现起止时间聚合与时序校验
    - 在 `server/src/domain/times.js` 实现 `computeCardTimes(processTimes)`：开始时间 = 最早工序开始时间（至少一道已开始时存在）；**结束时间仅在全部工序均已完成时存在**，等于最晚工序结束时间，否则为空
    - 实现 `isChronological(start, finish)`
    - _Requirements: 33.3–33.6, 33.8_
  - [x]* 7.4 编写工序编号唯一属性测试
    - **Property 10: 工序编号唯一**
    - **Validates: Requirements 11.1**
    - 断言同一工卡下生成的多个 `process_id` 两两互不相同且符合 A–Z→AA、AB… 规则，`numRuns: 100`
  - [x]* 7.5 编写 JOB 工序条码唯一对应属性测试
    - **Property 11: JOB 工序条码唯一对应**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
    - **属纯函数属性**：`generateBarcode` 无 I/O，「不同 `jobNo` 产出不同条码」直接生成两组 jobNo 断言；另断言编制态 `process_step` 不产生任何条码，`numRuns: 100`
  - [x]* 7.6 编写起止时间时序一致性属性测试
    - **Property 18: 起止时间时序一致性**
    - **Validates: Requirements 33.5, 33.6, 33.8**
    - 重点断言「存在未完成工序时工卡结束时间恒为空」，`numRuns: 100`

- [x] 8. 实现商务分类、Stage 约束、能力清单与权限领域模块（纯函数）
  - [x] 8.1 实现商务分类候选聚合与确认模型
    - 在 `server/src/domain/classification.js` 实现 `deriveCommercialClassification(card, sources, priorityCfg)`：按业务方 2026-08-10 裁定的 P1→P6 顺序评估全部启用层级，聚合全部不同分类候选；同分类合并全部 `sources`，保留首次 `hitTier/sourceRef`，非类型 11 以首候选为推荐
    - P1 计划设置→Dummy Job；P2 实际发起单据→NRC；P3 实际外包清单→Outsource（候选必须保留 L sub / 工序外委 subtype）；P4→LLP；P5→Routine / MSR / Configuration(MOD)；P6→类型映射。单候选 `derived`，多候选 `requires_confirmation`
    - 类型 11 为已裁定特例：忽略 P1–P5，固定 MSR/MOD 双候选，`recommendedClassification=null` 且必须人工确认；确认函数校验完整候选，Outsource subtype 不匹配即拒绝
    - _Requirements: 29.1–29.11, 43.2–43.6_
  - [x] 8.2 实现 Stage × 工卡类型约束
    - 在 `server/src/domain/stage-constraint.js` 实现 `validateStageCardType(stage, cardType, cfg)`（允许组合 ∪ 横切取值均通过）
    - 实现 **`defaultStageFor(cardType, cfg)`**（给出默认值）与 **`selectableStages(cardType, cfg)`**（= 该类型允许组合 ∪ `STAGE_CROSSCUT`）。**不实现任何将 Stage 置只读的逻辑**
    - 实现契约谓词 `selectableForStandardPackage(card)` = `stage === 'RTN' && status === 'Effective'`，且 `stage === 'WFD'` 恒返回假；供 Work Package List 模块消费，本模块不实现取卡查询
    - _Requirements: 46.1, 46.3–46.5, 46.7–46.14_
  - [x] 8.3 实现能力清单范围校验
    - 在 `server/src/domain/capability.js` 实现 `currentCapabilityRevision(list, onDate)`：取生效期覆盖校验当日（`effective_to` 为空视为长期有效）的记录中 `revision` 最大者
    - 实现 `checkCapability(card, capabilityList, onDate)`：（机型, 起落架类型, Skill）∈ 当前有效版本；无有效版本时判定为不通过并给出可区分的原因码
    - _Requirements: 39.1–39.4_
  - [x] 8.4 实现角色权限边界判定
    - 在 `server/src/domain/permission.js` 实现 `checkPermission(role, permissionPoint, cfg)`，`permissionPoint` 取值受 `PERMISSION_POINT` 词表约束
    - 实现 `READONLY_DERIVED_FIELDS` 常量与 `isWritableField(field)`：需求 26.1 执行相关字段、需求 27.1 Process Card 四字段、需求 30.1 工序 Operation、需求 11.3 Work Category / Estimated ManHours、需求 11.4 有效/实际工时**恒不可经本模块编制界面人工写入**，任何角色皆然
    - _Requirements: 11.3, 11.4, 20.9, 26.5, 27.3, 30.2, 47.1–47.10_
  - [x]* 8.5 编写商务分类候选聚合与确认属性测试
    - **Property 23: 商务分类候选聚合、推荐与确认一致性**
    - **Validates: Requirements 29.1–29.11, 34.1(h), 43.2–43.6**
    - 断言：全部层级命中被聚合、同分类 sources 完整且去重、首次证据稳定、非 11 推荐为首候选、类型 11 固定双候选且推荐 null；单候选 derived、多候选 pending；确认拒绝过期 `derivationResultId`、非候选及 Outsource subtype 不匹配；pending 不清空权威值，`numRuns: 100`
  - [x]* 8.6 编写 Stage 与工卡类型约束属性测试
    - **Property 28: Stage 与工卡类型约束一致性**
    - **Validates: Requirements 46.1, 46.3, 46.4, 46.5, 46.7, 46.8, 46.9, 46.10, 46.11, 46.12, 46.13**
    - **必须断言 `selectableStages` 对任意工卡类型恒包含全部横切取值**（需求 46.12 修正后的可达性保证）；另断言 WFD 恒使 `selectableForStandardPackage` 为假且不触发状态迁移，`numRuns: 100`
  - [x]* 8.7 编写能力清单范围校验属性测试
    - **Property 21: 能力清单范围校验**
    - **Validates: Requirements 39.1, 39.2, 39.3, 39.4**
    - 生成跨生效期与多 revision 的能力清单，断言校验依当前有效版本执行，`numRuns: 100`
  - [x]* 8.8 编写角色权限边界属性测试
    - **Property 29: 角色权限边界不可越权**
    - **Validates: Requirements 47.2, 47.3, 47.4, 47.5, 47.6, 47.7, 47.8, 47.9, 47.10, 11.3, 11.4, 20.9, 26.5, 27.3, 30.2**
    - 断言：操作被允许当且仅当 `(角色, 权限点)` 在 `role_permission` 中允许；TS 恒不可写 PPC 工时；Planning / Production 恒不可改编制域内容；QA 恒不可编审；`batch_replace` 不由 `card_edit` 继承
    - **并断言只读带出字段的人工写入恒被拒绝**（需求 26.1 执行相关字段、27.1 Process Card 四字段、30.1 工序 Operation、11.3 工作分类与预计工时、11.4 有效/实际工时）——**不存在任何角色可经编制界面改写这些字段的路径**，`numRuns: 100`

- [x] 9. 实现签署项、安全警示、工卡关联与 BOM 领域模块（纯函数）
  - [x] 9.1 实现签署项聚合与无纸化归档判定
    - 在 `server/src/domain/signature.js` 实现 `aggregateSignatureRequirements(steps)`：必需签署项 = 工卡下**全部工序** `signature_requirement` 的并集，为需求 32.4 的**唯一来源**
    - 实现 `canArchivePaperless(card, requirements, signatures)`：全部必需签署项均有含签署人、签章标识与完成日期的签署记录
    - _Requirements: 32.2–32.4, 45.1–45.6_
  - [x] 9.2 实现关键工序安全警示门禁
    - 在 `server/src/domain/safety.js` 实现 `canEnterExecution(step, acks, userId)`：工序未标记关键时放行；标记关键时须存在该用户的查看确认记录（含确认人与确认时间）
    - _Requirements: 31.4–31.7_
  - [x] 9.3 实现工卡关联规则
    - 在 `server/src/domain/relation.js` 实现 `buildRelation(card, doc, origin)`（`origin ∈ {manual, auto}`）、`syncRelationKeyInfo(relation, keyInfo)`（同步机型/件号/序列号/工卡编号至 `key_info_snapshot`）
    - 实现 **`requiredSignDocTypes(relations, signRuleCfg)`**：取出关联单据中 `sign_rule === '签署'` 的类型集合——这是 `submitReviewChecklist` 校验项 (f) 的数据来源
    - _Requirements: 16.4, 16.5, 21.1–21.5, 45.8, 45.9_
  - [x] 9.4 实现 BOM Base 输出汇总
    - 在 `server/src/domain/bom.js` 实现 `aggregateBomBase(cards, lotLinks)`：输出 = 「类型 04 直接维护的 Base」∪「类型 05 经 Lot List 带出的 Base」；`lotLinks` 的 Base 值由 `GET /api/lot-lists/:lotListRef/bases` 契约补齐；Lot List 来源携带 `lotNumber` 以区别来源；**当前不去重**（保留两条并各自标识 source，见《临时设计说明》A6 待澄清项 3）
    - _Requirements: 48.1–48.6, 48.8_
  - [x]* 9.5 编写必需签署项来源完备性属性测试
    - **Property 27: 必需签署项来源完备性**
    - **Validates: Requirements 45.1, 45.3, 45.6, 45.8, 45.9, 32.4**
    - 断言必需签署项恒等于全工序配置并集、不存在无来源项；签署要求为「签署」的单据未配置签署项时工卡不可提交审核（依赖 9.3 的 `requiredSignDocTypes`），`numRuns: 100`
  - [x]* 9.6 编写无纸化归档完备性属性测试
    - **Property 17: 无纸化归档完备性**
    - **Validates: Requirements 32.2, 32.3, 32.4**
    - `numRuns: 100`
  - [x]* 9.7 编写安全警示前置门禁属性测试
    - **Property 16: 关键工序安全警示前置门禁**
    - **Validates: Requirements 31.5, 31.6, 31.7**
    - `numRuns: 100`
  - [x]* 9.8 编写工卡关联属性测试
    - **Property 33: 工卡关联的完整性、自动建立与信息同步**
    - **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5, 45.8, 45.9, 16.4**
    - 纯函数部分：类型封闭（11 类）、增删互不影响、三元组不重复、执行期衍生单据 `origin='auto'`、`key_info_snapshot` 与来源当前值一致、要求签署单据集合的正确提取，`numRuns: 100`
  - [x]* 9.9 编写 BOM Base 输出完整性属性测试
    - **Property 30: BOM Base 输出完整性**
    - **Validates: Requirements 48.1, 48.2, 48.3, 48.4, 48.5, 48.6, 48.8**
    - 断言输出恒等于两来源并集、Lot List 来源携带 Lot Number、Lot List Base 集合变更后输出同步更新，`numRuns: 100`

- [x] 10. 实现变更留痕、批量替换、作废、迁移、打印与筛选领域模块（纯函数）
  - [x] 10.1 实现变更留痕构造（全部编辑入口的唯一单点）
    - 在 `server/src/domain/change-record.js` 实现 `buildChangeRecords(before, after, changeType, reason, operatorId)`：比对变更前后逐字段差异，**每个实际变化的字段产出恰好一条**记录（`field` / `old_value` / `new_value` / `change_type` / `reason` / `operator_id` / `timestamp`）；未变化字段不产生记录（`before === after` 时产出空集）
    - `reason` 为空或纯空白时**整体拒绝**，不产出任何记录
    - `changeType ∈ {edit, delete, revise, batch_replace, void}`；**保存、工序/参考文件删除、升版、批量替换、作废五条路径一律经本单点**，禁止各自拼装记录行
    - _Requirements: 19.1–19.3, 20.8, 42.5_
  - [x] 10.2 实现批量替换管控规则
    - 在 `server/src/domain/batch-replace.js` 实现 `batchReplace(cards, spec, reason)`：**仅作用于 `status === 'New'` 的版本**（复用 `isEditable`），任何非新增版本逐条拒绝并列明原因；`reason` 为空整批拒绝；每张被修改工卡经 `buildChangeRecords` 产出恰好 1 条变更记录；同一规则第二次执行受影响数为 0（幂等）；返回值须表达「整批成功」或「整批拒绝」两态，供服务层落事务
    - _Requirements: 19.1, 20.1–20.10, 49.4_
  - [x] 10.3 实现作废前置校验
    - 在 `server/src/domain/void-rules.js` 实现 `checkVoidPrecondition(card, refs, reason)`：三类引用（执行中 JOB / 已生成未开始 JOB / 在编工包已选入）任一存在即拒绝并给出引用类型与位置；`reason` 非空
    - 历史工包引用**不阻止**作废且其版本记录保持不变；作废后不可被新工包选用
    - _Requirements: 42.1–42.5_
  - [x] 10.4 实现迁移逐条校验与报告
    - 在 `server/src/domain/migrate-card.js` 实现 `migrateRecords(rows)`：逐条校验必填与枚举合法性（含 Stage×类型组合），失败则跳过、记原因、继续其余；成功记录状态置 `New` 并保留原命名规则
    - 报告须包含成功条数、失败条数（两者之和恒等于输入总数）与**按原因类型分组的统计**（枚举非法 / 必填缺失 / Stage×类型组合不合法 / 编号重复），以便区分「解析没解出来」与「约束不匹配」两类根因（《临时设计说明》A4-4）
    - _Requirements: 17.1, 17.2, 41.1, 41.3–41.6, 46.10_
  - [x] 10.5 实现打印模板选用与导出字段划分
    - 在 `server/src/domain/print-template.js` 实现 `selectPrintTemplate(card, templates)`：按 `card_type` / `exec_doc_type` 选模板，无专属回退 `is_default`
    - 在 `server/src/domain/export-fields.js` 实现 `exportFields(mode)`：`key` = 需求 2.1 清单展示字段 + 状态 + 版本；`all` = `task_card` 全部列 + 参考文件与工序展开行（《临时设计说明》D-05）
    - _Requirements: 3.6, 3.7, 40.1–40.5_
  - [x] 10.6 实现清单筛选与集合辅助
    - 在 `server/src/domain/filter.js` 实现 `matchesFilters(card, filters)`：非空条件 AND 组合，空条件全通过（含 status、stage、cardType 筛选）
    - 在 `server/src/domain/collections.js` 实现参考文件集合增删（不影响其它条目）与组件/采集项 `payload` 的 `serialize`/`parse` 往返
    - _Requirements: 1.1–1.5, 2.1, 4.4, 9.1–9.3, 13.1–13.3, 18.1, 18.2, 46.6_
  - [x]* 10.7 编写变更留痕完备性属性测试
    - **Property 35: 变更留痕完备性**
    - **Validates: Requirements 19.1, 19.2, 19.3, 20.8, 42.5**
    - 随机生成变更前后对象与 `change_type ∈ {edit, delete, revise, batch_replace, void}`：断言每个实际变化字段恰对应一条记录且 `old_value`/`new_value` 正确、`reason`/`operator_id`/`timestamp` 非空；未变化字段不产生记录；空或纯空白 `reason` 整体拒绝且零产出；变更序列的累积记录集合不丢失、不重复、无幻影记录，`numRuns: 100`
  - [x]* 10.8 编写批量替换管控属性测试
    - **Property 13: 批量替换正确、幂等且受管控**（纯函数部分；**整批回滚部分见任务 14.2**）
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.6, 20.7, 20.8, 49.4**
    - 断言态限制（仅 New）、原因必填、逐卡留痕恰 1 条、同规则二次执行受影响数为 0，`numRuns: 100`
  - [x]* 10.9 编写作废前置校验属性测试
    - **Property 24: 作废前置校验**
    - **Validates: Requirements 42.1, 42.2, 42.3, 42.4, 42.5**
    - `numRuns: 100`
  - [x]* 10.10 编写迁移失败隔离属性测试
    - **Property 32: 迁移失败隔离与报告完备性**
    - **Validates: Requirements 41.1, 41.3, 41.4, 41.5, 41.6, 17.1, 17.2**
    - 断言成功+失败条数恒等于输入总数、每条失败带原因、成功记录状态为 New 并保留原命名规则，`numRuns: 100`
  - [x]* 10.11 编写打印模板选用属性测试
    - **Property 22: 打印模板选用与分类隐藏**
    - **Validates: Requirements 40.1, 40.2, 40.3, 40.4, 40.5**
    - `numRuns: 100`
  - [x]* 10.12 编写筛选 AND 语义属性测试
    - **Property 4: 筛选 AND 语义**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 4.4**
    - `numRuns: 100`
  - [x]* 10.13 编写参考文件集合完整性属性测试
    - **Property 9: 参考文件集合完整性**
    - **Validates: Requirements 9.1, 9.2, 9.3**
    - `numRuns: 100`
  - [x]* 10.14 编写组件序列化往返属性测试
    - **Property 12: 组件序列化往返**
    - **Validates: Requirements 13.1, 13.2, 13.3, 18.1, 18.2**
    - 覆盖 13 类组件 `payload` 的往返等价与 `step_id` 绑定关系保持，`numRuns: 100`

- [x] 11. Checkpoint — 领域纯函数层（Property 1–12、14–24、26–30、32、33、35 应全部通过）
  - Ensure all tests pass, ask the user if questions arise.
  - 已确认：`npm test` 在 server 目录下 49 个测试文件、648 个测试全部通过；Property 1–12、14–24、26–30、32、33、35（全部纯函数属性）均已实现并通过，其中 Property 13/25/31/34（事务/持久化属性）留待任务 14（服务层完成后）。

- [x] 12. 实现仓储层（SQL 读写）
  - [x] 12.1 实现编制域仓储
    - 在 `server/src/repositories/` 实现 `taskCardRepo`（增删改查、分页筛选、版本列表、按 task_no 取生效版本）、`referenceDocRepo`、`processStepRepo`、`captureItemRepo`、`componentRepo`、`signatureRequirementRepo`、`relationRepo`、`attachmentRepo`、`lotLinkRepo`、`bomBaseRepo`
    - **`execDocumentRepo`（新增）**：`exec_document` 的列表、详情、插入（复制落库）；按 `(exec_doc_type, doc_no, revision)` 判重
    - 统一 `snake_case` ↔ `camelCase` 转换；`revision` 出入参保持 INTEGER
    - _Requirements: 2.1, 2.2, 3.2, 3.5, 9.1–9.3, 11.1, 11.2, 12.1–12.3, 13.1–13.3, 19.3, 21.1–21.3, 23.1–23.3, 45.1–45.5, 48.1–48.6_
  - [x] 12.2 实现执行域仓储
    - 实现 `jobRepo`、`jobProcessRepo`、`jobStepSnapshotRepo`（**只写不改**，不提供 update）、`safetyAckRepo`、`signatureRepo`
    - _Requirements: 15.1, 15.2, 26.1–26.3, 27.1, 27.2, 27.5, 31.5–31.7, 32.2, 32.3, 33.1–33.6, 37.1–37.4, 49.5–49.7_
  - [x] 12.3 实现流程与审计仓储
    - 实现 `reviewRecordRepo`、`supersedeRecordRepo`、`changeRecordRepo`、`classificationResultRepo`（追加式）、`migrationRepo`、`workPackageReleaseRepo`、`accessDenialLogRepo`
    - _Requirements: 19.1–19.3, 20.8, 24.3, 29.5, 29.6, 34.8, 34.9, 41.4, 41.5, 42.5, 44.2, 47.10_
  - [x] 12.4 实现配置、主数据与集成仓储
    - 实现 `appUserRepo`、`rolePermissionRepo`、`systemParameterRepo`、`stageConstraintRepo`（含 `stage_crosscut` 读写）、`commercialMapRepo`、`derivationPriorityRepo`（**按 `tier_order` 排序返回，作为运行时权威**；提供写入以支撑需求 29.8）、`capabilityRepo`、`printTemplateRepo`、`execDocTypeRepo`、`taskNoSequenceRepo`、`stepTemplateRepo`
    - 集成只读仓储：`tpcRepo`、`ppcRepo`、**`ppcScheduleRepo`**（按 `pid_no`/`card_id` 取 `job_target_date`）、**`processDataRepo`**（按 `pid_no`/`card_id`/`step_ref` 取 PART No/S/N/DES./Operation Type/Operation）、**`lotListBaseRepo`**（按 `lot_list_ref` 取 `[{baseNumber, lotNumber}]`）；三者**均无写方法**
    - _Requirements: 7.3, 11.3, 14.1, 14.2, 16.2, 16.4, 25.1, 25.2, 26.4, 27.2, 29.8, 30.1, 35.1, 38.8, 39.1, 40.1, 40.2, 43.1, 43.5, 46.9, 46.14, 47.1–47.8, 48.3, 48.8_
  - [x]* 12.5 编写仓储往返单元测试
    - 临时库 migrate+seed，断言：工卡保存后读取逐字段一致、双语描述往返、采集项 `type`/`config` 往返、组件 `payload` 往返、`exec_document` 的 `content` JSON 往返、`derivationPriorityRepo` 返回顺序随表数据变化而变化（验证配置驱动生效）、三个集成仓储无写方法
    - _Requirements: 12.1, 12.2, 13.1, 23.1, 29.8_

- [x] 13. 实现服务层（事务边界与关键约束落地）
  - [x] 13.1 实现编辑态统一闸门与编制服务
    - 在 `server/src/services/taskCardService.js` 于**服务层入口、领域校验之前**统一执行 `isEditable` 闸门，覆盖全部编辑入口；非 `New` 态返回 `422` 并对生效态提示「变更请先执行升版」
    - 实现创建（状态 New、Date 默认当天、FAI 默认否、Revision 初始 1）、保存（校验 Stage×类型与枚举，自动记录 `last_update`/`operator_id`）、参考文件与工序增删改、采集项与组件维护、签署项配置
    - **每次保存与删除均调 `buildChangeRecords` 写 `change_record`（唯一留痕单点）**；只读带出字段（执行相关字段、Process Card 四字段、工序 Operation、PPC 工时、执行期工时）一律从入参中剔除，不接受任何角色写入
    - **需求 49.8 的非内容变更操作（查看/打印/导出/复制/升版/作废/发布）不经该闸门**，须显式测试确认未被误拦
    - _Requirements: 3.1, 4.1, 7.2, 7.4, 9.1–9.3, 10.3, 11.1–11.4, 12.1–12.3, 13.1–13.3, 19.1, 19.2, 26.5, 27.3, 30.2, 36.3, 45.1–45.5, 46.10, 46.11, 49.1–49.4, 49.8_
  - [x] 13.2 实现审核服务与版本取代（语句顺序强制）
    - 实现 `submitForReview`（执行 (a)–(h) 八项校验，其中 (h) 校验最新持久化商务分类状态；全通过置 UnderReview；任一失败保持 New 并返回未通过项）
    - 实现 `approve`：单事务内**严格按「①原生效版本 → Superseded + 写 `supersede_record`；②本版本 → Effective + 写 `review_record`」顺序**执行；任一步失败整体回滚，新版本不生效且原生效版本保持生效。**在代码注释中写明顺序不可颠倒的原因（部分唯一索引立即校验）**
    - 实现 `reject`（回 New + 写 `review_record`）；审核意见为空一律拒绝；升版新版本不继承审核结果
    - _Requirements: 22.3, 34.1–34.11, 39.2, 44.1–44.3, 44.7, 44.8, 45.9, 46.10_
  - [x] 13.3 实现复制、升版与批量替换服务
    - 复制：单卡要求指定不重复 Task No；批量复制按 `task_no_sequence` 生成并跳过占用序号，支持事后逐张调整并复校
    - 升版：保持 Task No、默认版本+1（允许手动指定并校验 `(task_no, revision)` 唯一，冲突返回 `409`）、状态置 New，并经 `buildChangeRecords` 写 `revise` 类型留痕
    - 批量替换：**独立权限点** `batch_replace` 校验 → `batchReplace` 领域判定 → 事务写入，逐卡各写一条 `change_record`；任一失败整批回滚
    - _Requirements: 3.3, 3.4, 7.1, 7.5, 19.1, 19.2, 20.1–20.10, 38.1–38.10, 47.9_
  - [x] 13.4 实现执行过程单据复制服务（SWS）
    - 在 `server/src/services/execDocumentService.js` 实现 `copy({ id, newDocNo })`：取源单据 → `copyExecDocument` → 判重（`UNIQUE(exec_doc_type, doc_no, revision)`，冲突返回 `409`）→ 单事务落 `exec_document`
    - 提供列表与详情读取，供复制取数与结果查看；**不实现 SWS 编制表单**（需求 23.3 归属待澄清）
    - _Requirements: 23.1, 23.2, 23.3, 38.1–38.3_
  - [x] 13.5 实现发布服务（JOB + 快照 + 条码 + 集成带出）
    - `canRelease` 校验 → **单事务**内：生成 `job_no` 并写 `job` → 调 `buildStepSnapshots` 写 `job_step_snapshot` → 逐工序写 `job_process` 并调 `generateBarcode(jobNo, processId)` 生成条码 → 写 `work_package_release` 记录发布结果
    - **集成带出（写 `job` 表，不回写 `task_card`）**：经 `ppcScheduleRepo` 取 `job_target_date`（需求 26.4）；经 `processDataRepo` 取 PART No / PART S/N / PART DES. / Operation Type（需求 27.2、27.5）。**取不到值时该列留空、不阻断释放**，`message` 标注「集成数据缺失」
    - 同一 Task Card 多次释放生成各自独立 JOB No 与各自快照
    - _Requirements: 15.1–15.4, 24.1–24.3, 26.1–26.5, 27.1–27.5, 37.1–37.5, 49.5–49.7_
  - [x] 13.6 实现执行期服务
    - 报工开始/完成写 `job_process` 起止时间，并调 `computeCardTimes` 聚合至 `job.start_time`/`job.finish_time`（**结束时间仅在全部工序完成后写入**）；写入前后须保证 `task_card` 行未被修改
    - 执行期工时写入（`job_exec_write` 权限）；安全警示查看确认（关键工序未确认则阻止进入执行）；电子签章签署与无纸化归档完备性判定
    - JOB 查询与呈现**一律读 `job_step_snapshot`**，不读 `process_step` 当前内容
    - _Requirements: 11.4, 31.5–31.7, 32.1–32.4, 33.1–33.8, 37.4, 37.5, 47.7, 49.6_
  - [x] 13.7 实现分类派生、能力校验与作废服务
    - 分类派生：聚合 P1–P5 输入并按已裁定 P1→P6 顺序生成完整候选；追加写入 `commercial_classification_result` 的 `status/candidates_json/recommended_classification/evaluated_tiers_json`。仅 `derived/confirmed` 同步 `task_card` 权威值，`requires_confirmation/undetermined` 不清空既有分类
    - 确认：只接受最新 pending 的 `derivationResultId` 和完整候选选择；Outsource 必须含候选允许的 subtype；确认后追加 confirmed 行并关联原派生行。提供 latest/history 读取，供前端按持久化状态恢复
    - 能力校验服务按需求 39.4 规则选取当前有效版本
    - 作废服务：聚合三类引用（前两类查 `job.exec_status`，第三类查在编工包引用契约端点）→ `checkVoidPrecondition` → 通过则置 Void 并经 `buildChangeRecords` 写 `void` 类型留痕（原因必填）
    - _Requirements: 29.1–29.8, 39.1–39.4, 42.1–42.5, 43.3–43.5_
  - [x] 13.8 实现配置维护服务（config_write / capability_write）
    - 在 `server/src/services/configService.js` 实现四组配置的读写，**写入一律经 `config_write`（能力清单经 `capability_write`）权限校验**，越权 `403` 并写 `access_denial_log`：
      - `stage_card_type_constraint` + `stage_crosscut` 维护（改后 `validateStageCardType` 结果随之改变）
      - `card_type_commercial_map` 维护（P6 兜底层）
      - `derivation_priority_config` 维护（`tier_order` / `enabled`，改后派生结果随之改变）
      - `capability_list` 维护（QA）
    - 写入须校验取值属于对应枚举，非法值返回 `400`；**不得引入任何需改代码才能生效的判定分支**
    - _Requirements: 29.8, 39.1, 39.4, 43.1, 43.5, 46.9, 46.13, 46.14, 47.8, 47.10_
  - [x] 13.9 实现迁移服务与解析层
    - **主通道**：Excel/CSV 迁移模板经 `xlsx` 读取为结构化 `rows` → `migrateRecords` 校验管道 → 逐条落库，写 `migration_batch`/`migration_record`
    - **辅通道**：Word(.docx)/RTF 经 `mammoth` 转 HTML → 按标题与表格启发式切分为工序候选 → 返回**导入预览**结构供前端人工确认后再转 `rows`。**不实现全自动 Word 成卡**
    - 迁移报告输出按原因分组统计（见 10.4）
    - _Requirements: 17.1, 17.2, 41.1–41.6_
  - [x] 13.10 实现打印、导出与附件服务
    - 打印：`selectPrintTemplate` → `printProjection`，返回 `{ templateId, templateBody, model }`；`jobNo` 缺省为编制态投影，携带则为执行态投影；**签署栏按各工序签署项配置逐工序输出**
    - 导出：按 `exportFields(mode)` 生成 **CSV（UTF-8 带 BOM、逗号分隔、CRLF）**，`revision` 输出两位补零文本
    - 附件：在 `server/src/storage/` 实现落盘——**文件名由服务端生成 UUID + 扩展名，原始文件名仅入库记录、不参与路径拼接**；MIME 白名单（image/png|jpeg|webp、video/mp4、audio/mpeg|wav）与大小上限（image 10MB / audio 20MB / video 100MB）校验，超限或类型不符返回 `400`；计算 `sha256`；取回经 id 查表后返回流，不暴露文件系统路径
    - _Requirements: 3.6, 3.7, 5.1–5.3, 13.2, 13.3, 18.1, 31.2, 33.9, 35.1, 35.2, 40.1–40.5, 45.7_
  - [x] 13.11 实现关联服务与 BOM 输出服务
    - 人工关联增删查；执行期产生 PC/CR/TS 等衍生单据时**自动建立**关联并标记 `origin='auto'`（无需人工动作）；关键信息变更时同步 `key_info_snapshot`；向审核服务暴露 `requiredSignDocTypes` 结果作为校验项 (f) 的输入
    - BOM 输出：Lot 关联增删 → 经 **`lotListBaseRepo`（`GET /api/lot-lists/:lotListRef/bases` 的数据源）** 取回各 Lot List 的 Base 集合 → `aggregateBomBase` 汇总落 `bom_base_output`；Lot List Base 集合变更时同步刷新输出
    - _Requirements: 16.4, 21.1–21.5, 45.8, 45.9, 48.1–48.8_
  - [x]* 13.12 编写服务层错误分支单元测试
    - 覆盖：非 New 态编辑被拒（五态逐一）、需求 49.8 操作在生效态放行、重复编号阻止提交、审核意见为空、同人编审、非生效发布阻止、非法状态迁移、作废存在待执行 JOB、附件类型/大小不合规、能力清单无有效版本、变更原因为空、SWS 复制编号重复 `409`、无 `config_write` 维护配置 `403`
    - **集成带出示例测试（各 1–3 例，不做属性测试）**：TPC 四字段回填、PPC 工作分类/工时带出（TS 只读）、**PPC 排产带出 JOB TARGET DATE**、**Process Data 带出 Process Card 四字段与工序 Operation 且落执行域**、**Lot List Base 集合读取**；契约取不到值时字段留空且不阻断主流程
    - _Requirements: 7.3, 10.5, 11.3, 19.2, 22.3, 23.2, 24.2, 25.1, 25.2, 26.4, 27.2, 27.5, 29.8, 30.1, 39.4, 42.1, 48.3, 49.1, 49.2, 49.8_

- [x] 14. 编写事务/持久化属性测试
  > 被测对象为服务层 + 内存 SQLite（每迭代重建 schema+seed），`numRuns: 30`。这四条属性断言的是事务原子性与两域隔离，纯函数不可测。
  - [x]* 14.1 编写单一生效版本不变式属性测试
    - **Property 25: 单一生效版本不变式（版本取代）**
    - **Validates: Requirements 38.7, 44.1, 44.2, 44.3, 44.7, 44.8**
    - 随机生成批准操作序列，**在每条 SQL 语句执行之后**校验同一 `task_no` 下 `Effective` 版本数 ≤ 1；另设一个反向用例：故意以「先生效后降级」顺序执行，断言其触发唯一索引错误——以此锁定语句顺序约束
  - [x]* 14.2 编写批量替换整批回滚属性测试
    - **Property 13: 批量替换正确、幂等且受管控**（回滚部分）
    - **Validates: Requirements 20.10**
    - 随机构造含一张必然失败工卡的批次，断言无任何工卡被修改、无变更记录写入（无部分生效）
  - [x]* 14.3 编写 JOB 实例独立性属性测试
    - **Property 31: JOB 实例独立性**
    - **Validates: Requirements 37.1, 37.2, 37.3, 37.4, 37.5, 33.1, 33.2**
    - 随机释放次数序列，断言 JOB No 互不相同、各 JOB 执行数据相互隔离；**比对报工前后 `task_card` 行的逐字段快照完全一致**
  - [x]* 14.4 编写 JOB 工序快照隔离属性测试
    - **Property 34: JOB 工序快照隔离**
    - **Validates: Requirements 49.5, 49.6, 49.7, 37.5, 44.6**
    - 释放 → 升版并随机修改编制域工序内容（增删工序、改采集项、改组件、改签署项）→ 断言既有 JOB 的快照内容逐字段不变，且 JOB 呈现结果与模板当前内容无关

- [x] 15. Checkpoint — 后端内核（Property 1–35 应全部通过）
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. 实现身份上下文、权限中间件与 Express 装配
  - [x] 16.1 实现用户上下文中间件与身份路由
    - `server/src/middleware/user-context.js`：解析 `Authorization: Bearer <token>`，查内存 token→staffNo 映射并挂载 `req.user`；缺失或无效返回 `401`
    - `POST /api/session`（以 `staffNo` 选定身份，校验存在于 `app_user` 且 `is_active` 后签发不透明 token）、`DELETE /api/session`、`GET /api/me`、`GET /api/me/permissions`
    - **在文件头注释标明此为演示阶段替代品**：不含口令、会话过期与加密传输；接企业统一认证时仅改本中间件与 `POST /api/session`，服务层与领域函数不受影响
    - _Requirements: 7.4, 22.3, 47.1–47.9_
  - [x] 16.2 实现权限校验中间件与越权审计
    - `server/src/middleware/authorize.js`：按路由声明的 `permissionPoint` 调 `checkPermission`，拒绝时返回 `403` 并写 `access_denial_log`（staffNo/role/权限点/方法/路径/时间）
    - 实现 `GET /api/access-denials` 审计查询
    - _Requirements: 20.9, 29.8, 43.5, 46.14, 47.2–47.10_
  - [x] 16.3 装配 Express 应用
    - `server/src/app.js`：JSON 中间件 → `user-context` → 路由挂载（各路由声明所需权限点）→ 统一错误处理（领域错误映射为对应 `code` 并镜像 HTTP status，未捕获异常记日志返回 `500`）
    - `server/src/index.js` 启动入口
    - 统一约定：多步写操作一律包 `better-sqlite3` 事务；SQLite `CHECK`/`UNIQUE` 为最后防线
    - _Requirements: 通用（Error Handling 统一约定）_
  - [x]* 16.4 编写权限链路接口测试
    - 以不同角色调用同一端点，断言：TS 不可写 PPC 工时、Planning 不可改编制域内容、Production 不可改编制域内容、QA 不可编审、批量替换需 `batch_replace`、配置维护需 `config_write`、能力清单维护需 `capability_write`、越权返回 `403` 且 `access_denial_log` 新增恰好一条、无身份返回 `401`
    - _Requirements: 20.9, 29.8, 43.5, 46.14, 47.2–47.10_

- [x] 17. 实现 REST：工卡清单、编制、审核与版本
  - [x] 17.1 实现清单与查询路由
    - `GET /api/task-cards`（筛选参数 acType、taskNo、gearType、title、status、stage、cardType、page、pageSize，AND 组合）、`GET /api/task-cards/:id`（`?jobNo=` 携带 JOB 上下文时附执行期字段与快照内容）、`GET /api/task-cards/:id/versions`、`GET /api/task-cards/check-duplicate`
    - 筛选无结果返回 `code:0, data:{list:[],total:0}`
    - _Requirements: 1.1–1.5, 2.1, 2.2, 3.2, 3.5, 4.4, 10.5, 19.3, 26.2, 26.3, 27.4, 27.5, 38.6, 38.7, 44.4, 46.6_
  - [x] 17.2 实现编制与保存路由
    - `POST /api/task-cards`、`PUT /api/task-cards/:id`、参考文件增删、附件引用绑定；全部经 `isEditable` 闸门并写变更留痕
    - _Requirements: 3.1, 4.1, 7.2, 7.4, 9.1–9.3, 10.3, 19.1, 19.2, 36.3, 46.10, 46.11, 49.1–49.4_
  - [x] 17.3 实现审核路由
    - `POST /api/task-cards/:id/submit-review`（返回未通过校验项清单 (a)–(h)，其中 (h) 为商务分类持久状态门禁）、`POST .../approve`、`POST .../reject`、`GET .../reviews`
    - _Requirements: 22.3, 34.1–34.11, 39.2, 44.1–44.3, 44.8, 45.9, 46.10_
  - [x] 17.4 实现版本、复制、作废、批量替换与关联路由
    - `POST /api/task-cards/copy`（body: ids, numbering{prefix,suffix,startSeq,step}）、`POST /api/task-cards/revise`、`POST /api/task-cards/:id/void`（reason 必填）、`GET /api/task-cards/:id/void-precheck`（返回三类引用命中情况）、`GET /api/task-cards/:id/change-records`、`POST /api/task-cards/batch-replace`（`batch_replace` 独立权限点）
    - `POST /api/task-cards/:id/relations` / `DELETE .../:relId` / `GET .../relations` / `POST .../relations/auto` / `POST .../relations/sync`
    - 空 `ids[]` 返回 `code=400` 兜底
    - _Requirements: 3.3, 3.4, 3.8, 4.3, 7.1, 7.5, 19.1–19.3, 20.1–20.10, 21.1–21.5, 38.1–38.10, 42.1–42.5, 47.9_
  - [x]* 17.5 编写主链路接口测试
    - `POST /api/session` → `POST 新增` → `PUT 保存` → `submit-review`（**八项**校验，含 (h) 商务分类持久状态门禁）→ `reject`（回 New）→ `submit-review` → `approve`（一编一审 + 版本取代，断言未触发唯一索引冲突且原生效版本已置 Superseded）
    - 编辑态闸门链路：同一工卡在五态下分别调用全部编辑类端点，断言仅 New 通过、其余 `422` 且内容未变；再断言生效态经升版后可编辑，且生效态的打印/导出/复制/升版/作废/发布均放行
    - 留痕链路：保存 / 删除工序 / 升版 / 批量替换 / 作废各执行一次后，`GET .../change-records` 返回的记录数与类型恰与操作序列对应（Property 35 的接口侧回归）
    - _Requirements: 19.1, 19.3, 34.1, 34.4, 34.5, 42.5, 44.1, 49.1, 49.2, 49.8_

- [x] 18. 实现 REST：工序、签署项、安全警示与附件
  - [x] 18.1 实现工序路由
    - `POST /api/task-cards/:id/steps`（自动生成 Process ID，**不生成条码**）、`PUT .../steps/:stepId`（Skill/RefDoc/双语描述/采集项/组件）、`DELETE .../steps/:stepId`（写 `delete` 类型留痕）、`POST .../steps/reorder`
    - `operation` 字段**只读展示**，来源为 `GET /api/process-data`，不接受写入
    - _Requirements: 10.1, 10.2, 11.1, 11.2, 12.1–12.3, 13.1–13.3, 15.3, 18.1, 18.2, 19.1, 30.1, 30.2, 49.1_
  - [x] 18.2 实现签署项与安全警示路由
    - `POST /api/task-cards/:id/steps/:stepId/signature-requirements` / `DELETE .../:reqId`、`GET /api/task-cards/:id/signature-requirements`（全工序并集，需求 32.4 唯一来源）
    - `PUT /api/task-cards/:id/steps/:stepId/safety`（安全警示/视觉提示/维修技巧/关键标记）
    - _Requirements: 31.1–31.4, 32.4, 45.1–45.6_
  - [x] 18.3 实现工序模板与批量模板路由
    - `GET /api/step-templates` / `POST /api/step-templates` / `POST .../steps/:stepId/apply-template`（需求 14 单工序模板复用）
    - `GET /api/task-cards/:id/steps/template-file`（Excel 空模板下载）/ `POST /api/task-cards/:id/steps/import`（批量导入，复用迁移主通道的 Excel 解析与逐条校验管道）——对应需求 10.1 的「模板下载/模板导入」
    - _Requirements: 10.1, 14.1, 14.2_
  - [x] 18.4 实现附件路由
    - `POST /api/attachments`（`multipart/form-data`，multer 内存或临时落盘 → 白名单与大小校验 → 服务端生成文件名落 `data/attachments` → 返回 `{id, url}`）、`GET /api/attachments/:id`、`DELETE /api/attachments/:id`
    - _Requirements: 5.3, 13.2, 13.3, 18.1, 31.2_
  - [x]* 18.5 编写工序与附件接口测试
    - 断言：新增工序返回 Process ID 且**无条码字段**；采集项 `type` 与组件 `payload` 保存后读取一致；签署项并集返回正确；关键工序标记后安全内容可保存；`operation` 字段的写入尝试被忽略或拒绝；附件超限与类型不符返回 `400`；上传返回的 `url` 可取回
    - _Requirements: 11.1, 12.2, 13.1, 13.2, 15.3, 30.2, 31.1, 31.4, 45.6_

- [x] 19. 实现 REST：发布、JOB 与执行期数据
  - [x] 19.1 实现发布路由
    - `POST /api/task-cards/:id/release`：`canRelease` 校验 → 单事务生成 JOB No、`job_step_snapshot`、`job_process` 条码 → 带出 PPC 排产 JOB TARGET DATE 与 Process Data 四字段 → 记录发布结果；非生效返回 `422`
    - _Requirements: 15.1, 15.2, 24.1–24.3, 26.4, 27.2, 27.5, 37.1–37.4, 49.5_
  - [x] 19.2 实现 JOB 查询路由
    - `GET /api/jobs/:jobNo`（执行期字段 + 起止时间 + 快照工序）、`GET /api/jobs/:jobNo/processes`（含条码）
    - _Requirements: 15.1, 15.2, 15.4, 26.1, 26.3, 27.1, 27.5, 33.1, 33.2, 33.7, 37.2, 49.6_
  - [x] 19.3 实现执行期写入路由
    - `POST /api/job-processes/:id/start` / `/finish`（记录工序起止时间并聚合至 JOB）、`PUT /api/job-processes/:id/manhours`（`job_exec_write` 权限）、`POST /api/job-processes/:id/safety-ack`、`POST /api/task-cards/:id/signatures`、`GET /api/task-cards/:id/archive-status`
    - _Requirements: 11.4, 31.5–31.7, 32.1–32.4, 33.3–33.8, 47.7_
  - [x]* 19.4 编写发布与执行期接口测试
    - 断言：非生效发布 `422`；发布后 `job_step_snapshot` 与 `job_process` 条码齐备且条码值为 `{JOB No}-{Process ID}`；同一工卡二次释放产生不同 JOB No 与独立快照；`job.job_target_date` 与 Process Card 四字段取自集成契约且**未回写 `task_card`**；集成契约无数据时该列留空且释放仍成功；报工后 `job.start_time` 写入而 `job.finish_time` 在存在未完成工序时为空；关键工序未确认安全警示时进入执行 `422`；签署齐备后归档状态为可归档
    - _Requirements: 15.2, 24.2, 26.4, 27.2, 27.5, 31.6, 32.4, 33.5, 33.6, 37.3, 37.5, 49.5_

- [x] 20. 实现 REST：配置维护、分类、集成、单据与输出
  - [x] 20.1 实现枚举与配置读取路由
    - `GET /api/enums`（全部枚举含派生优先级、签署角色、角色、权限点）、`GET /api/stage-constraints`（允许组合 + 横切取值 + **可改选范围**）、`GET /api/card-type-commercial-map`、`GET /api/derivation-priority`、`GET /api/capabilities`、`GET /api/print-templates`、`GET /api/system-parameters`
    - _Requirements: 6.3–6.10, 16.1, 16.2, 29.2, 35.1, 35.2, 39.1, 40.1, 40.2, 43.1, 45.2, 46.9, 46.12, 46.13, 47.1_
  - [x] 20.2 实现配置维护写入路由（config_write / capability_write）
    - `PUT /api/stage-constraints`（维护 `stage_card_type_constraint` 与 `stage_crosscut`，改配置即改校验结果）
    - `PUT /api/card-type-commercial-map`（P6 兜底映射）
    - `PUT /api/derivation-priority`（`tier_order` / `enabled`；服务层一律按本表排序读取）
    - `PUT /api/capabilities`（QA 维护，需 `capability_write`）、`PUT /api/print-templates/:id`
    - 全部写端点声明所需权限点，越权 `403` 并写 `access_denial_log`；非法枚举值 `400`
    - _Requirements: 29.8, 39.1, 39.4, 40.1, 40.2, 43.5, 46.14, 47.8, 47.10_
  - [x] 20.3 实现分类派生、最新状态、历史与确认路由
    - `POST /api/task-cards/:id/classification/derive` 返回 `{resultId,status,candidates,recommendedClassification}`；`GET .../classification/latest` 恢复持久化 pending；`GET .../classification/history` 返回追加式轨迹
    - `POST .../classification/confirm` 强制 body 含 `{derivationResultId,classification,outsourceSubtype?}`，校验最新 pending、完整候选及 Outsource subtype；过期结果返回 `409`
    - _Requirements: 29.1–29.11, 43.3–43.6_
  - [x] 20.4 实现集成读取契约路由（本地表 / mock，只读）
    - `GET /api/tpc/documents`（回填四字段）、`GET /api/ppc/process-data`（TS 只读，**无写端点**）、`GET /api/pid/:pid/scope`
    - **`GET /api/ppc/schedule?pid=&cardId=`** → `{ jobTargetDate }`，释放时写入 `job.job_target_date`；取不到值该列留空
    - **`GET /api/process-data?pid=&cardId=&stepId=`** → `{ partNo, partSn, partDesc, operationType, operation }`：前四项落 `job` 表（需求 27.5），`operation` 供工序只读展示（需求 30.1）
    - **`GET /api/lot-lists/:lotListRef/bases`** → `[{ baseNumber, lotNumber }]`，为 `aggregateBomBase` 的 `lotLinks` 入参补齐 Base 值
    - `GET /api/classification-sources?cardId=`（一次返回 P1–P5 全部输入：planDummyJob / nrcOriginatingDoc / outsourceEntry / partNature / packageDivision）
    - `GET /api/work-packages/in-progress-refs?cardId=`（在编工包已选入引用，供作废前置校验第三类）
    - 上述端点**一律只读、无写端点**；数据缺失时 `code:0` 且字段留空，`message` 标注「集成数据缺失」或「演示数据」
    - _Requirements: 7.3, 11.3, 25.1–25.3, 26.4, 27.1–27.3, 29.2, 30.1, 30.2, 42.1, 42.2, 47.4, 47.5, 48.3, 48.8_
  - [x] 20.5 实现执行过程单据路由（SWS 复制与读取）
    - `POST /api/exec-documents/copy`（body `{ id, newDocNo }`；编号重复 `409`）、`GET /api/exec-documents`、`GET /api/exec-documents/:id`
    - **不提供编制端点**（需求 23.3 归属待澄清）
    - _Requirements: 21.3, 23.1, 23.2, 23.3, 38.1–38.3_
  - [x] 20.6 实现导出、打印、迁移与 BOM 路由
    - `GET /api/task-cards/export?mode=key|all&ids=`（CSV UTF-8 BOM，`Content-Disposition: attachment`）
    - `GET /api/task-cards/:id/print?jobNo=`（返回 `{templateId, templateBody, model}`，编制态/执行态两种投影，含逐工序签署栏）
    - `POST /api/migrations`（Excel/CSV 主通道 + Word/RTF 预览确认辅通道）、`GET /api/migrations/:id/report`（含按原因分组统计）
    - `POST /api/task-cards/:id/lot-links` / `DELETE .../:linkId`、`GET /api/task-cards/:id/bom-bases`（两来源并集，标识 source/lotNumber）
    - _Requirements: 3.6, 3.7, 5.1–5.3, 16.3, 17.1, 17.2, 33.9, 40.1–40.5, 41.1–41.6, 45.7, 48.1–48.8_
  - [x]* 20.7 编写配置、集成与输出接口测试
    - 断言：`GET /api/stage-constraints` 返回的可改选范围对类型 01–10 均含 WFD（**需求 46.12 修正的回归防线**）；`PUT /api/derivation-priority` 改 `tier_order` 后同一输入的派生结果随之改变、`PUT /api/stage-constraints` 改约束后同一组合的校验结果随之改变（**「改配置不改代码」的验证**，非读常量）
    - 断言：`GET /api/ppc/process-data`、`/api/process-data`、`/api/ppc/schedule`、`/api/lot-lists/:ref/bases` 均无对应写端点；无 `config_write` 时 `PUT` 类配置端点返回 `403`
    - 断言：打印返回三元组且 `model` 不含 `cardType`、签署栏与工序签署项配置一致；导出 CSV 首字节为 BOM；迁移报告成功+失败条数等于输入总数；`POST /api/exec-documents/copy` 副本内容与源一致、编号重复时 `409`
    - _Requirements: 5.2, 16.3, 23.1, 23.2, 26.4, 27.2, 29.8, 41.5, 45.7, 46.12, 46.13, 46.14, 47.4, 48.3_

- [x] 21. Checkpoint — 后端 REST API
  - Ensure all tests pass, ask the user if questions arise.

- [x] 22. 搭建前端脚手架与 API 层
  - [x] 22.1 初始化 web 项目
    - `web/package.json` 与 Vite 配置；安装 vue、vue-router、pinia、element-plus、axios
    - `web/src/main.js`；路由 `/task-card/list`、`/task-card/editor`、`/task-card/step`、`/job/:jobNo`、`/config`；Pinia store 骨架；开发代理转发 `/api`
    - _Requirements: 无（基础设施）_
  - [x] 22.2 实现 axios 封装与资源 API 模块
    - axios 实例 + 响应拦截器：`code===0` 返回 `data`，否则抛出携带 `message` 的错误；`401` 跳身份选择、`403` 统一越权提示（依 code 镜像 HTTP status 的约定，按 status 做统一分支）
    - 资源模块 `taskCardApi`、`reviewApi`、`stepApi`、`jobApi`、`classificationApi`、**`configApi`（约束表 / 类型映射 / 优先级链 / 能力清单 / 打印模板的读写）**、**`execDocApi`（SWS 复制与查询）**、`migrationApi`、`bomApi`、`attachmentApi`、**`integrationApi`（TPC / PPC / PPC 排产 / Process Data / Lot List / PID scope / 分类判定源 / 在编工包引用）**、`sessionApi`，方法与 design.md §1 端点一一对应
    - _Requirements: 通用（前端 API 层）_
  - [x] 22.3 实现身份与权限 store
    - 身份选择入口（调 `POST /api/session`）；启动时拉取 `GET /api/me` 与 `GET /api/me/permissions`，将权限点集合存入 Pinia，供各视图按权限点禁用操作按钮（批量替换依 `batch_replace`、配置维护依 `config_write`、能力清单依 `capability_write`，均**不**依 `card_edit` 推导）
    - _Requirements: 20.9, 29.8, 43.5, 46.14, 47.1–47.9_

- [x] 23. 实现前端工卡清单视图
  - [x] 23.1 实现 SearchToolbar 与 TaskCardTable
    - 筛选：A/C Type、Task No、Gear Type、标题、**状态（五值）**、Stage；表格列：是否 FAI、Gear Type/构型、模板类型、工卡类型、编号、标题、状态；**Stage=WFD 显著标识**；空结果占位并保留筛选条件
    - `revision` 列按两位补零展示
    - _Requirements: 1.1, 1.4, 1.5, 2.1, 2.2, 4.4, 36.4, 46.6_
  - [x] 23.2 实现列设置与批量操作对话框
    - `ColumnSettingsDialog`（列显隐/顺序/固定，持久化 `haeco_tc_list_columns`，读取失败回退默认列配置不阻断渲染）
    - `BatchCopyDialog`（前缀/后缀/起始序号/步长 + 事后逐张调整）、`BatchReplaceDialog`（原因必填、态限制提示、结果逐条反馈）、`VoidDialog`（原因必填 + 前置校验结果展示）
    - **`ExecDocCopyDialog`**：选取来源执行过程单据（SWS 即 `SW`）、指定不重复新编号、结果反馈；**不含单据编制表单**（需求 23.3）
    - _Requirements: 2.3, 2.4, 20.1–20.9, 23.1, 23.2, 38.8–38.10, 42.1, 42.2, 42.5_
  - [x] 23.3 实现 TaskCardListView 组装
    - 新增/编辑/复制/升版/查看详情/关键信息导出/全量导出/打印/作废/批量替换/SWS 复制入口；未选中工卡执行批量操作时提示「请先选择工卡」并不发请求
    - 按权限点禁用无权操作；生效态工卡的编辑入口改为「升版后编辑」引导（呼应需求 49.3、49.8）
    - _Requirements: 3.1–3.8, 4.3, 5.1, 23.1, 49.3, 49.8_
  - [x]* 23.4 编写清单视图组件测试
    - 断言：列布局持久化往返、读取失败回退默认、未选中批量操作被拦截、筛选空结果占位、WFD 标识渲染、无权限时按钮禁用、SWS 复制对话框要求新编号
    - _Requirements: 2.3, 2.4, 3.8, 23.2, 46.6, 47.2_

- [x] 24. 实现前端工卡编制视图
  - [x] 24.1 实现 TaskCardEditorView 骨架与编辑态只读化
    - `el-tabs`：基础信息 / 参考文件 / 工序 / 关联工卡 / 审核记录；支持 add / edit / view / revise 模式
    - **`status !== 'New'` 时整体转只读**，生效态提示「变更请先执行升版」（前端为体验层，后端 `isEditable` 为权威闸门）
    - _Requirements: 3.1, 3.2, 3.5, 34.3, 49.1–49.3_
  - [x] 24.2 实现 MetadataForm
    - 下拉字段绑定 `GET /api/enums`；**Stage 按类型带出默认值且可改选**（可选范围取 `GET /api/stage-constraints`，含横切取值，**不置只读**）；组合非法时提示该类型允许范围
    - 升版默认版本+1 且允许手动调整（重复时提示 `409`）；新建 Date 默认当天；IR 卡（`card_type='04'`）条件显示 Base Number / IPC 项号
    - 录入编写人、NDT 审核人、ATA 章节号、检查类型、是否 FAI（默认否）、模板类型；组织名称只读展示
    - **执行相关字段与 Process Card 字段在编制态不呈现栏位**（无 JOB 上下文时隐藏，避免永久空白）；有 JOB 上下文时只读呈现且无任何写入控件
    - _Requirements: 6.1–6.10, 7.1, 7.2, 7.5, 8.1–8.3, 26.1–26.5, 27.1, 27.3–27.5, 28.1–28.4, 35.3, 36.1–36.3, 46.10–46.13_
  - [x] 24.3 实现参考文件与 TPC 检索
    - `ReferenceDocTable`（文件类型/参考号/版本号/ATA 章节号增删）、`TpcLookupDialog`（检索并回填 Document Type / Ref No / Document Revision / Document Desc 四字段）
    - _Requirements: 7.3, 9.1–9.3, 25.1_
  - [x] 24.4 实现关联面板、Lot List 面板与 BOM 展示
    - `CardRelationPanel`（关联全 11 类执行单据，展示 `origin` 区分人工/自动，展示关键信息快照）、`LotLinkPanel`（类型 05 关联 Lot List）、`BomBaseTable`（Base 输出展示，标识来源与 Lot Number；Base 值取自 `GET /api/lot-lists/:ref/bases` 契约）
    - _Requirements: 21.1–21.5, 48.1–48.6, 48.8_
  - [x] 24.5 实现审核面板与变更记录
    - `ReviewPanel`：提交审核（失败时逐项列出 (a)–(h)；识别后端 (h) 商务分类门禁并打开确认框）；pending 或类型 11 未确认时体验层阻止，单候选自动派生后可继续提交；批准/驳回仍要求审核意见
    - 变更记录查询展示字段级前后值、变更类型与原因（对应 `buildChangeRecords` 产出）
    - _Requirements: 19.1–19.3, 29.4, 34.1–34.11_
  - [x] 24.6 实现商务分类确认对话框与持久状态恢复
    - `classificationApi` 增加 latest/history；`TaskCardEditorView` 加载已有卡时读取 latest，严格按持久化 `status` 恢复 pending，不凭类型 11 猜测，且 pending 派生不清空卡当前权威分类
    - `ClassificationConfirmDialog` 展示全部候选、非 11 推荐、每个候选首次层级与全部 sources；稳定 key 包含分类/subtype/来源，选择保留完整对象；打开时优先传入/最新 pending，必要时 derive
    - confirm 发送 `derivationResultId + classification + outsourceSubtype(Outsource)`；确认后编辑页更新权威分类并保持既有 `derived/confirmed` 事件兼容
    - _Requirements: 29.3–29.10, 34.1(h), 43.3–43.5_
  - [x]* 24.7 编写编制视图组件测试
    - 断言：**Stage 字段可改选且下拉含 WFD**（需求 46.12 回归防线）、IR 卡条件字段显隐、编制态不渲染执行期与 Process Card 字段栏位、JOB 上下文下该两组字段只读无写入控件、非 New 态整体只读、TPC 回填四字段、审核意见为空时批准按钮禁用、变更记录展示字段级前后值
    - _Requirements: 8.1, 8.3, 19.3, 26.2, 26.5, 27.3, 27.4, 34.7, 46.12, 49.1_

- [x] 25. 实现前端工序编辑视图
  - [x] 25.1 实现工序属性与双语描述
    - 工序属性表单：Process ID（自动生成只读）、Skill、Ref Doc（选自本卡参考文件）；**只读**展示 Operation（`GET /api/process-data` 带出）、Work Category / Estimated ManHours（PPC 维护）、Effective / Actual ManHours（执行期收集）——上述只读字段**不渲染任何写入控件**
    - 中英文步骤描述编辑，支持图文混编并保持工序与图片的对应关系
    - _Requirements: 11.1–11.4, 12.1, 18.1, 18.2, 30.1, 30.2, 47.5_
  - [x] 25.2 实现数据采集项配置
    - 任意数量采集项，**类型下拉与组件类型体系共用同一枚举**，P/N、S/N 作为常用示例而非固定两项；必填标记与执行时输入框预览
    - _Requirements: 12.2, 12.3_
  - [x] 25.3 实现 ComponentInserter 与 AttachmentUploader
    - `ComponentInserter`：**13 类**组件插入（测量值、表格、文本、设备/工具、图片、视频、音频、测量范围、耗材、时间、数据组、自定义选项、签署栏）
    - `AttachmentUploader`：图片/视频/音频经 `POST /api/attachments` 上传后写入组件 `payload.attachmentId`/`url`；维修草图经图片组件上传并关联当前工序；工具与耗材组件记录特殊工具/设备/耗材信息
    - _Requirements: 13.1–13.3, 18.1_
  - [x] 25.4 实现签署项面板、安全警示编辑与工序列表入口
    - `SignatureRequirementPanel`：工序级签署项配置（签署角色多选、是否盖章、完成日期默认要求、展示顺序）
    - `SafetyWarningEditor`：安全警示、视觉提示（图片/视频）、维修技巧编辑与关键维修/易误操作标记
    - `ProcessStepList`：新增插件、模板下载、模板导入、排序、全选、折叠/展开
    - _Requirements: 10.1, 14.1, 14.2, 31.1–31.4, 45.1–45.5_
  - [x]* 25.5 编写工序视图组件测试
    - 断言：13 类组件插入面板项数与类型正确、采集项类型下拉与组件类型一致、只读字段无写入控件、附件上传失败时已录入其它组件保留、签署项多角色配置往返、工序模板保存后应用还原
    - _Requirements: 11.3, 11.4, 12.2, 13.1, 14.1, 14.2, 30.2, 45.3_

- [x] 26. 实现前端 JOB 查看视图、执行期交互与配置维护视图
  - [x] 26.1 实现 JobViewerView
    - JOB 上下文展示：执行相关字段（OWNER / JOB TARGET DATE / Check / 进厂·出厂 P/N·S/N / CSNo. / WORK ORDER）与 Process Card 四字段（只读）、工卡与工序起止时间（只读）、`BarcodeView` 工序条码/二维码
    - **工序内容一律取自快照**，不取编制域模板当前内容
    - _Requirements: 15.1, 15.2, 26.1, 26.3, 26.5, 27.1, 27.3, 27.5, 33.1, 33.2, 33.7, 37.2, 37.4, 49.6_
  - [x] 26.2 实现安全确认弹窗与电子签章面板
    - `SafetyAckDialog`：关键工序执行前强制查看确认，未确认则禁用进入执行；`ElectronicSignaturePanel`：按签署项签署（签署人/签章标识/完成日期）并展示归档完备性状态
    - _Requirements: 31.5–31.7, 32.1–32.4_
  - [x] 26.3 实现打印、导出与迁移入口
    - 打印按 `{templateId, templateBody, model}` 渲染后浏览器打印；**编制态打印输出空白待填栏位、JOB 态打印带出实际工时/起止时间/签署记录**；签署栏按各工序签署项配置呈现；打印输出不展示工卡分类
    - `MigrationImportDialog`：迁移导入（Excel 主通道 + Word/RTF 预览人工确认）与结果报告展示（含按原因分组统计）
    - _Requirements: 5.1–5.3, 16.3, 33.9, 40.1–40.5, 41.1–41.6, 45.7_
  - [x] 26.4 实现配置维护视图
    - `ConfigMaintenanceView`：Stage×工卡类型约束表与横切取值、工卡类型→商务分类映射、商务分类派生优先级链（`tier_order`/`enabled`）、能力清单四组配置的表格化维护，分别调 `configApi` 写端点
    - 无 `config_write` / `capability_write` 权限时整表只读并提示；保存后提示「改配置即生效，无需改代码」
    - _Requirements: 29.8, 39.1, 39.4, 43.1, 43.5, 46.9, 46.13, 46.14, 47.8_
  - [x]* 26.5 编写 JOB 视图、打印与配置视图组件测试
    - 断言：JOB 视图渲染快照内容而非模板当前内容、未确认安全警示时进入执行按钮禁用、打印模型不含工卡分类且签署栏与配置一致、编制态与 JOB 态打印投影差异正确、无 `config_write` 时配置维护视图只读
    - _Requirements: 5.2, 16.3, 31.6, 45.7, 46.14, 47.8, 49.6_

- [x] 27. Final checkpoint — 全栈集成校验
  - 对照 requirements.md **需求 1–49** 逐项走查，确认最小信息集 I.1–I.11 与工包对接 II 全部落位
  - 确认 design.md **Property 1–35** 全部有对应测试且通过
  - 逐项复核《临时设计说明》「仍待澄清」项与开发期待确认项 D-01–D-07（含 D-07 `exec_document` 结构随 SWS 编制归属裁定而定），确认全部实现为配置驱动、改配置即可调整
  - 四界面导航流（清单 → 编制 → 工序 → JOB 查看）+ 配置维护视图人工走查，视觉对照 `HAECO-Demo`
  - Ensure all tests pass, ask the user if questions arise.

- [x] 28. 客户澄清修订（2026-08-10）
  - [x] 28.1 对齐 classification latest/history API 与派生/确认响应契约
  - [x] 28.2 分类确认框展示全部候选、推荐、首次层级及全部来源，并完整回传 Outsource subtype
  - [x] 28.3 编辑页按持久化 status 恢复 pending，保持待确认期间当前权威分类不变
  - [x] 28.4 审核面板接入 (h) 门禁，pending/类型 11 未确认阻止提交，单候选自动派生继续提交
  - [x] 28.5 更新前端组件测试并通过目标测试
  - [x] 28.6 同步 requirements/design/tasks 与临时设计说明的 A1 已裁定口径
  - [x] 28.7 强制人工确认携带最新 `derivationResultId`，缺失与陈旧结果分别拒绝
  - [x] 28.8 恢复并扩展 Property 23 与 Property 19(h) 覆盖，保持 `numRuns: 100`

---

## Notes

- 标 `*` 的子任务为可选测试任务，可为快速 MVP 跳过；核心实现任务不可跳过。
- 每条正确性属性各占**一个独立子任务**，标注属性编号与其校验的需求条款，保证 35 条属性与 49 条需求双向可追溯。
- 属性测试覆盖 design.md **Property 1–35**：纯函数属性（任务 5–10）`numRuns: 100`；事务/持久化属性 Property 13（回滚部分）、25、31、34（任务 14）`numRuns: 30`，被测对象为服务层 + 内存 SQLite。
- 本轮相对上一版任务表的增量：新增 `domain/change-record.js` 与 **Property 35**（任务 10.1、10.7）；新增 `domain/exec-doc.js` 与 `exec_document` 表（任务 3.2、6.4、13.4、20.5），Property 3 / 20 扩展为覆盖工卡与单据两类实体（任务 6.7、6.8）；新增三个集成只读契约端点与对应 mock 表（任务 3.5、12.4、20.4）；新增四组配置维护写端点与服务（任务 13.8、20.2、26.4）；`printProjection` 扩展为逐工序输出签署栏，Property 8 相应扩展（任务 5.3、5.9）；Property 29 扩展为覆盖全部只读带出字段（任务 8.4、8.8）。
- Supertest 接口测试使用临时或内存 SQLite，测试前 `migrate` + `seed`，测试后清理。
- Checkpoint 分布在数据层（任务 4）、领域层（任务 11）、后端内核（任务 15）、后端 API（任务 21）、全栈（任务 27）五处。
- `server/src/domain/collections.js`（任务 10.6）未列入 design.md 的领域模块表——该表列举的是「关键函数」，此模块为承载 Property 9 / 12 的集合与序列化辅助，属该表之外的补充。
- 全部 Hotfix 假定项一律实现为配置表 + 默认数据（`stage_card_type_constraint`、`stage_crosscut`、`derivation_priority_config`、`card_type_commercial_map`、`role_permission`、`capability_list`、`print_template`），并**必须配备写端点**，澄清后改数据不改代码。
- 集成对接一律为「本地 mock 表 + 只读端点」：`tpc_document`、`ppc_process_data`、`ppc_schedule`、`process_data`、`lot_list_base`、`capability_list`、工包发布与在编引用。本模块**不建这些数据的业务主表、不提供写入路径**，后续替换为真实对接时仅改仓储与路由实现。
- **被业务方阻塞、不应压在主线上的三项**：需求 40 的 11+11 套打印模板需纸质样张（当前以默认模板占位）；需求 41 的迁移规模评估需存量数量级（当前 Excel 主通道可用，Word 辅通道为半自动预览）；需求 23.3 的 SWS 编制归属裁定（当前 `exec_document.content` 为 JSON 最小结构，见 D-07）。建议迁移单独立项，不与主编制流程并行推进。

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0,  "tasks": ["1.1"] },
    { "id": 1,  "tasks": ["1.2", "2.1", "3.1"] },
    { "id": 2,  "tasks": ["2.2", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 3,  "tasks": ["3.6"] },
    { "id": 4,  "tasks": ["3.7", "5.1", "6.3", "6.4", "7.1", "7.3", "8.1", "8.2", "8.3", "8.4", "9.2", "9.4", "10.1", "10.3", "10.5", "10.6"] },
    { "id": 5,  "tasks": ["5.2", "6.1", "7.2", "9.1", "9.3", "10.2", "10.4"] },
    { "id": 6,  "tasks": ["5.3", "6.2"] },
    { "id": 7,  "tasks": ["5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "6.5", "6.6", "6.7", "6.8", "7.4", "7.5", "7.6", "8.5", "8.6", "8.7", "8.8", "9.5", "9.6", "9.7", "9.8", "9.9", "10.7", "10.8", "10.9", "10.10", "10.11", "10.12", "10.13", "10.14"] },
    { "id": 8,  "tasks": ["12.1", "12.2", "12.3", "12.4"] },
    { "id": 9,  "tasks": ["12.5", "13.1", "13.8", "13.11"] },
    { "id": 10, "tasks": ["13.2", "13.3", "13.4", "13.5", "13.7", "13.9", "13.10"] },
    { "id": 11, "tasks": ["13.6", "13.12"] },
    { "id": 12, "tasks": ["14.1", "14.2", "14.3", "14.4", "16.1"] },
    { "id": 13, "tasks": ["16.2", "16.3"] },
    { "id": 14, "tasks": ["16.4", "17.1", "17.2", "17.3", "17.4", "18.1", "18.2", "18.3", "18.4", "19.1", "19.2", "19.3", "20.1", "20.2", "20.3", "20.4", "20.5", "20.6"] },
    { "id": 15, "tasks": ["17.5", "18.5", "19.4", "20.7", "22.1"] },
    { "id": 16, "tasks": ["22.2"] },
    { "id": 17, "tasks": ["22.3"] },
    { "id": 18, "tasks": ["23.1", "23.2", "24.1", "25.1", "25.2", "26.1", "26.4"] },
    { "id": 19, "tasks": ["23.3", "24.2", "24.3", "24.4", "24.5", "24.6", "25.3", "25.4", "26.2", "26.3"] },
    { "id": 20, "tasks": ["23.4", "24.7", "25.5", "26.5"] }
  ]
}
```

> Checkpoint 任务（4、11、15、21、27）为串行门禁，位于其前一 wave 完成之后、后一 wave 开始之前，未列入 waves。
