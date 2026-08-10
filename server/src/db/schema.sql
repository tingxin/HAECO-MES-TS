-- =====================================================================
-- HAECO MES · 工卡管理（Task Card Management）数据库架构
-- 权威依据：.kiro/specs/task-card-management/design.md「Data Models」
-- =====================================================================
--
-- 【本文件是模板，不是可直接执行的 SQL】
-- 枚举 CHECK 一律写作占位符 `{{CHECK:<enumField>[:<columnName>]}}`，由 db/schema.js
-- 从 domain/enums.js 渲染生成，**禁止在此手写枚举字面量**（design.md「枚举的单一事实来源」）。
-- 执行入口：db/schema.js 的 buildSchemaSql() / applySchema(db)，任务 3.6 的 migrate.js 调用之。
--
-- 约定（任务 3.3–3.6 追加表时沿用）：
--   1. 列名 snake_case；API 出入参转 camelCase（由仓储层负责）。
--   2. 全部对象使用 IF NOT EXISTS，保证迁移可重复执行。
--   3. 布尔列存 INTEGER 并加 `CHECK (col IN (0,1))`。
--   4. JSON 列存 TEXT，注释标注 (JSON)。
--   5. 表内局部取值集（非全系统枚举）直接写字面量 CHECK，不进 enums.js。
--   6. 追加表时写在所属「域」分节内，勿打散分节顺序。
--
-- =====================================================================
-- 分节 1 · 编制域（Authoring Domain）—— 任务 3.2
-- =====================================================================

-- ---------------------------------------------------------------------
-- task_card：工卡（编制域主表）
-- 需求 6.1–6.10, 7.1–7.5, 8.1–8.3, 16.1, 16.3, 17.1, 22.1–22.3, 28.1–28.4,
--       29.1, 29.3, 36.1–36.3, 38.6, 38.7, 41.6, 44.7
--
-- ⚠ 两域分离（Property 31）：本表**不含** start_time / finish_time，也不含
--   OWNER / JOB TARGET DATE / Check（执行期）/ 进厂·出厂 P/N·S/N / CSNo. /
--   WORK ORDER 与 Process Card 四字段（PART No/S/N/DES./Operation Type）——全部落 job 表。
-- ⚠ WBS 与工卡类型为同一字段（需求 6.8）：仅 card_type 单列，**不建 wbs 列**；
--   IR 卡判定为 card_type = '04'。
-- ⚠ revision 存 INTEGER（初始 1）；两位补零（01、02…）仅用于 UI / 打印 / 导出展示。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_card (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no                   TEXT    NOT NULL,                                  -- 工卡编号（需求 6.1、6.2）
  revision                  INTEGER NOT NULL DEFAULT 1,                         -- 版本号（需求 7.1、38.5）
  title                     TEXT    NOT NULL,                                  -- 标题（需求 6.1）
  date                      TEXT,                                               -- 修订日期 YYYY-MM-DD，默认当天（需求 7.2）
  ac_type                   TEXT    {{CHECK:acType}},                           -- 机型（需求 6.3、6.9）
  gear_type                 TEXT    {{CHECK:gearType}},                         -- 起落架类型（需求 6.4、6.9）
  stage                     TEXT    {{CHECK:stage}},                            -- 阶段，受 card_type 约束（需求 6.5、46）
  skill                     TEXT    {{CHECK:skill}},                            -- 专业（需求 6.6、6.9）
  ctrl_code                 TEXT    {{CHECK:ctrlCode}},                         -- 控制代码，与 skill 独立值域（需求 6.7、6.10）
  card_type                 TEXT    NOT NULL {{CHECK:cardType}},                -- 工卡类型 = WBS，单列存储（需求 6.8、16.1）
  is_fai                    INTEGER NOT NULL DEFAULT 0 CHECK (is_fai IN (0,1)), -- 是否 FAI，默认否（需求 36.1、36.3）
  template_type             TEXT,                                               -- 模板类型（需求 36.2）
  status                    TEXT    NOT NULL {{CHECK:cardStatus:status}},       -- 工卡状态五值（需求 4、34、44）
  document_type             TEXT,                                               -- TPC 带出，只读（需求 7.3、25.1）
  ref_no                    TEXT,                                               -- TPC 带出，只读
  document_revision         TEXT,                                               -- TPC 带出，只读
  document_desc             TEXT,                                               -- TPC 带出，只读
  base_number               TEXT,                                               -- IR 卡基础件号，card_type='04'（需求 8.1、8.3）
  ipc_item_no               TEXT,                                               -- IR 卡 IPC 项号（需求 8.2、8.3）
  created_by                TEXT,                                               -- 编制人，一编一审依据（需求 22.1、22.3）
  reviewed_by               TEXT,                                               -- 最近审核人（需求 22.2、34.4）
  ndt_reviewer              TEXT,                                               -- NDT 审核人（角色字段，非独立审核节点，需求 28.2）
  ata_chapter               TEXT,                                               -- ATA 章节号（需求 28.3）
  check_type                TEXT,                                               -- 检查类型（需求 28.4）
  commercial_classification TEXT    {{CHECK:commercialClassification}},         -- 当前商务分类（权威当前值，需求 29.1）
  outsource_subtype         TEXT    {{CHECK:outsourceSubtype}},                 -- 外包二级细分，仅 Outsource（需求 29.3）
  last_update               TEXT,                                               -- 最后更新日期，保存自动记录（需求 7.4）
  operator_id               TEXT,                                               -- 操作人工号，保存自动记录（需求 7.4）
  naming_rule_origin        TEXT,                                               -- 迁移工卡保留的原命名（需求 17.1、41.6）

  UNIQUE (task_no, revision)                                                    -- 工卡唯一性（需求 38.6）
);

-- 同一编号最多一个生效版本（需求 38.7、44.7）。
-- ⚠ SQLite 部分唯一索引为**语句级立即校验**：批准事务必须「①原生效版本降级为 Superseded →
--   ②本版本置 Effective」按序执行；顺序颠倒会在第一条 UPDATE 即撞索引并整体回滚（Property 25）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_card_effective_task_no
  ON task_card (task_no) WHERE status = 'Effective';

-- ---------------------------------------------------------------------
-- reference_document：参考文件（需求 9.1–9.3）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reference_document (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES task_card(id) ON DELETE CASCADE,
  doc_type     TEXT,                                                            -- 文件类型
  ref_no       TEXT,                                                            -- 参考号
  doc_revision TEXT,                                                            -- 版本号
  ata_chapter  TEXT                                                             -- ATA 章节号
);

CREATE INDEX IF NOT EXISTS ix_reference_document_card ON reference_document (card_id);

-- ---------------------------------------------------------------------
-- process_step：工序（编制域模板）
-- 需求 10.1, 11.1–11.3, 12.1, 30.1, 30.2, 31.1–31.4
--
-- ⚠ 本表**不含条码列**：条码属执行域，释放生成 JOB 时按 `JOB No + Process ID` 生成，
--   存于 job_process.barcode_value（需求 15.3）。
-- ⚠ 本表**不含**有效/实际工时与工序起止时间：均属执行域，存于 job_process
--   （需求 11.4、33.2–33.4、37.5）。
-- ⚠ operation / work_category / estimated_man_hours 为**只读带出列**（Process Data 与 PPC 写入），
--   任何角色皆不可经本模块编制界面人工写入——闸门在服务层（需求 30.2、47.4）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS process_step (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id             INTEGER NOT NULL REFERENCES task_card(id) ON DELETE CASCADE,
  process_id          TEXT    NOT NULL,                                         -- 自动生成工序编号（需求 11.1）
  seq                 INTEGER,                                                  -- 排序序号（需求 10.1）
  skill               TEXT    {{CHECK:skill}},                                  -- 技能要求，与卡头 skill 同值域（需求 11.2、6.6）
  ref_doc_id          INTEGER REFERENCES reference_document(id),                 -- 参考文件（引用本卡已登记条目，需求 11.2、9.1）
  operation           TEXT,                                                     -- Operation（Process Data 带出，只读；需求 30.1、30.2）
  work_category       TEXT,                                                     -- 工作分类（PPC 写入，TS 只读；需求 11.3、47.4）
  estimated_man_hours REAL,                                                     -- 预计工时（PPC 写入，TS 只读；需求 11.3、47.4）
  description_zh      TEXT,                                                     -- 中文步骤描述（需求 12.1）
  description_en      TEXT,                                                     -- 英文步骤描述（需求 12.1）
  safety_warning      TEXT,                                                     -- 安全警示内容（需求 31.1）
  visual_cue          TEXT,                                                     -- (JSON) 视觉提示，图片/视频引用（需求 31.2）
  repair_tips         TEXT,                                                     -- 维修技巧内容（需求 31.3）
  is_critical         INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1)),   -- 关键维修/易误操作标记（需求 31.4）

  UNIQUE (card_id, process_id)                                                  -- 工序编号在卡内唯一（需求 11.1）
);

CREATE INDEX IF NOT EXISTS ix_process_step_card ON process_step (card_id, seq);

-- ---------------------------------------------------------------------
-- capture_item：数据采集项（需求 12.2、12.3）
-- type 与需求 13.1 的插入组件体系**共用同一类型定义**（COMPONENT_TYPE）；
-- P/N、S/N 为 `text` 类型的常用实例，而非固定两项。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capture_item (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id    INTEGER NOT NULL REFERENCES process_step(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL {{CHECK:componentType:type}},                     -- 采集项类型（需求 12.2）
  item_key   TEXT,                                                              -- 采集键（如 PN、SN 或自定义）
  label      TEXT,                                                              -- 显示标签
  config     TEXT,                                                              -- (JSON) 类型特定配置，约定同 inserted_component.payload
  required   INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),              -- 必填标记
  sort_order INTEGER                                                            -- 顺序
);

CREATE INDEX IF NOT EXISTS ix_capture_item_step ON capture_item (step_id, sort_order);

-- ---------------------------------------------------------------------
-- inserted_component：插入组件（需求 13.1–13.3、18.1、18.2）
-- payload 约定：measurement→{label,unit,nominal}；range→{label,unit,min,max}；
--   table→{columns,rows}；text→{html}；tool→{toolPn,toolDesc,qty}；
--   consumable→{materialNo,desc,qty,unit}；image→{attachmentId,url,annotations}；
--   video/audio→{attachmentId,url,duration}；time→{label,format}；
--   dataGroup→{label,items}；custom→{schema}；signature→{requirementId}。
-- 图片/视频/音频不内联，统一以 attachmentId 引用 attachment 表。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inserted_component (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id    INTEGER NOT NULL REFERENCES process_step(id) ON DELETE CASCADE,
  type       TEXT    {{CHECK:componentType:type}},                              -- 组件类型（13 类，需求 13.1）
  payload    TEXT,                                                              -- (JSON) 类型特定数据
  sort_order INTEGER                                                            -- 组件顺序
);

CREATE INDEX IF NOT EXISTS ix_inserted_component_step ON inserted_component (step_id, sort_order);

-- ---------------------------------------------------------------------
-- attachment：附件（需求 5.3、13.2、13.3、18、31.2）
-- kind / mime_type 为本表局部取值集，非全系统枚举，故直接写字面量 CHECK。
-- 文件名一律由服务端生成（UUID + 扩展名），**不采用**客户端原始文件名参与路径拼接。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('image','video','audio')),     -- 附件类别
  original_name TEXT,                                                           -- 上传时原始文件名（仅记录）
  stored_path   TEXT    NOT NULL,                                               -- 相对 data/attachments 的存储路径
  mime_type     TEXT    NOT NULL,                                               -- 白名单校验在服务层
  byte_size     INTEGER NOT NULL,                                               -- 字节大小，上限校验在服务层
  sha256        TEXT,                                                           -- 内容摘要，去重与完整性核对
  uploaded_by   TEXT,
  uploaded_at   TEXT
);

-- ---------------------------------------------------------------------
-- signature_requirement：工序级签署项（需求 45.1–45.6）
-- 工卡下全部工序本表记录的**并集**即需求 32.4「必需签署项」的唯一来源。
-- signature_role ⚠ Hotfix 假定（《临时设计说明》A3），运行时以配置表为权威。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signature_requirement (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id        INTEGER NOT NULL REFERENCES process_step(id) ON DELETE CASCADE,
  signature_role TEXT    {{CHECK:signatureRole}},                               -- 签署角色（需求 45.2）
  stamp_required INTEGER NOT NULL DEFAULT 0 CHECK (stamp_required IN (0,1)),    -- 是否需盖章
  date_required  INTEGER NOT NULL DEFAULT 1 CHECK (date_required IN (0,1)),     -- 是否记录完成日期
  sort_order     INTEGER                                                        -- 展示顺序（未强制签署时序，见 A3）
);

CREATE INDEX IF NOT EXISTS ix_signature_requirement_step ON signature_requirement (step_id, sort_order);

-- ---------------------------------------------------------------------
-- card_relation：工卡关联（需求 21.1–21.5、45.8、45.9、16.4、16.5）
-- 承载 Task Card 与 11 类执行过程单据的关联；经 exec_doc_type.sign_rule 即可判定
-- 该工卡是否存在「要求签署」的单据。
-- origin 为本表局部取值集：'auto' = 执行期产生 PC/CR/TS 等单据时由服务层自动建立（需求 21.4）。
-- ⚠ job_id 指向执行域 job 表（任务 3.3 建立）。SQLite 允许**建表**时 FK 指向尚未存在的父表，
--   但 `PRAGMA foreign_keys = ON` 下**任何**对本表的写入都会解析父表，job 表缺失时报
--   `no such table: main.job`（job_id 为 NULL 亦然）。故本表的写入用例须待任务 3.3 建 job 后方可运行。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_relation (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id           INTEGER NOT NULL REFERENCES task_card(id) ON DELETE CASCADE,
  exec_doc_type     TEXT    NOT NULL {{CHECK:execDocType}},                     -- 关联单据类型（需求 21.3、45.8）
  related_doc_no    TEXT    NOT NULL,                                           -- 关联单据编号（需求 21.1）
  job_id            INTEGER REFERENCES job(id),                                 -- 执行期衍生单据所属 JOB；编制期人工关联为 NULL（需求 21.4）
  origin            TEXT    CHECK (origin IN ('manual','auto')),                -- 建立来源（需求 21.1、21.4）
  key_info_snapshot TEXT,                                                       -- (JSON) {acType, partNo, serialNo, taskNo}（需求 21.5）
  created_by        TEXT,
  created_at        TEXT,

  UNIQUE (card_id, exec_doc_type, related_doc_no)                               -- 三元组不重复（需求 21.1）
);

CREATE INDEX IF NOT EXISTS ix_card_relation_card ON card_relation (card_id);

-- ---------------------------------------------------------------------
-- exec_document：执行过程单据实例（需求 23.1–23.3、38.1–38.3）
-- SWS 即 exec_doc_type = 'SW' 的实例。本表为**最小实例存储**，仅支撑复制与关联取数，
-- **不含编制界面**（需求 23.3 归属待澄清）。content 为 JSON 而非展开列，见待确认项 D-07。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exec_document (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_doc_type  TEXT    NOT NULL {{CHECK:execDocType}},                        -- 单据类型（需求 16.2、23.2）
  doc_no         TEXT    NOT NULL,                                              -- 单据编号（需求 23.1、38.1）
  revision       INTEGER NOT NULL DEFAULT 1,                                    -- 版本号，复制置初始值（需求 38.3）
  status         TEXT    NOT NULL {{CHECK:cardStatus:status}},                  -- 单据状态，复制置 New（需求 38.3）
  title          TEXT,                                                          -- 单据标题（需求 23.1）
  content        TEXT,                                                          -- (JSON) 单据内容全量，复制逐字段克隆（需求 23.1）
  source_card_id INTEGER REFERENCES task_card(id),                              -- 来源工卡（若由工卡发出，需求 21.1）
  created_by     TEXT,
  created_at     TEXT,

  UNIQUE (exec_doc_type, doc_no, revision)                                      -- 单据版本唯一（需求 23.2、38.1）
);

-- ---------------------------------------------------------------------
-- lot_list_link：IR Lot 卡与 Lot List 关联（需求 48.1、48.2）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lot_list_link (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES task_card(id) ON DELETE CASCADE,     -- 所属工卡（card_type='05'）
  lot_number   TEXT    NOT NULL,                                                -- Lot Number
  lot_list_ref TEXT                                                             -- Lot List（LT 单据）引用标识
);

CREATE INDEX IF NOT EXISTS ix_lot_list_link_card ON lot_list_link (card_id);

-- ---------------------------------------------------------------------
-- bom_base_output：BOM Base 输出（需求 48.3–48.8）
-- source 为本表局部取值集：'ir_card' = 类型 04 直接维护；'lot_list' = 类型 05 经 Lot List 带出
-- （后者携带 lot_number 以区别来源）。当前**不去重**，两来源各自保留并标识 source（见 A6）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_base_output (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         INTEGER NOT NULL REFERENCES task_card(id) ON DELETE CASCADE,
  base_number     TEXT    NOT NULL,                                             -- Base Number
  source          TEXT    CHECK (source IN ('ir_card','lot_list')),             -- 来源类型
  lot_number      TEXT,                                                         -- 来源为 lot_list 时携带
  upper_part_name TEXT,                                                         -- 上级件名称（维护界面归属 WPL 模块，见 A6）
  is_lru          INTEGER NOT NULL DEFAULT 0 CHECK (is_lru IN (0,1))            -- LRU 标记
);

CREATE INDEX IF NOT EXISTS ix_bom_base_output_card ON bom_base_output (card_id);

-- =====================================================================
-- 分节 2 · 执行域（Execution Domain）—— 任务 3.3 追加
--   job / job_process / job_step_snapshot / safety_acknowledgement / electronic_signature
-- =====================================================================

-- ---------------------------------------------------------------------
-- job：执行实例（工程释放生成）
-- 需求 26.1–26.5, 27.1–27.5, 33.1, 33.5–33.7, 37.1–37.5, 42.1, 49.7
--
-- ⚠ 两域分离（Property 31）：OWNER / JOB TARGET DATE / Check / 进厂·出厂 P/N·S/N /
--   CSNo. / WORK ORDER 与 Process Card 四字段（PART No/S/N/DES./Operation Type）
--   **只落本表**，task_card 一律不含；执行期写入不修改来源 Task Card 任何字段（需求 37.5）。
-- ⚠ start_time / finish_time 是**工卡级起止时间的唯一落位**（需求 33.1）：由本 JOB 的
--   job_process 聚合而来，finish_time 仅在全部工序完成后写入（需求 33.5–33.7）。
-- ⚠ 同一 Task Card 多次释放生成各自独立的 job_no（需求 37.3），故 UNIQUE 落在 job_no 上，
--   而非 (card_id, card_revision)。
-- ⚠ owner / job_target_date / check_type / 进出厂件号 / Process Card 四字段与工时均为
--   **只读带出列**（PPC 排产与 Process Data 写入），编制界面不接受人工写入（需求 26.5、27.3）。
-- exec_status 为本表局部取值集（非全系统枚举），直接写字面量 CHECK：
--   Pending 待执行 / InProgress 执行中 / Completed 完成——供作废前置校验判定（需求 42.1）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_no            TEXT    NOT NULL UNIQUE,                                    -- JOB 编号，释放生成（需求 37.1、37.3）
  card_id           INTEGER REFERENCES task_card(id),                           -- 来源工卡（需求 37.2）
  card_revision     INTEGER,                                                    -- 来源工卡版本号（需求 37.2）
  pid_no            TEXT,                                                       -- 所属 PID（需求 37.2）
  released_at       TEXT,                                                       -- 释放时间（需求 37.1）
  released_by       TEXT,                                                       -- 释放操作人（需求 37.1）
  owner             TEXT,                                                       -- OWNER 所有者，默认 HAECO（需求 26.1）
  job_target_date   TEXT,                                                       -- JOB TARGET DATE，依 PPC 排产带出（需求 26.1、26.4）
  check_type        TEXT,                                                       -- Check 检查类型（需求 26.1）
  inbound_gear_pn   TEXT,                                                       -- 进厂起落架件号（需求 26.1）
  inbound_sn        TEXT,                                                       -- 进厂起落架序列号（需求 26.1）
  cs_no             TEXT,                                                       -- CSNo. 工卡控制序号（需求 26.1）
  work_order        TEXT,                                                       -- WORK ORDER 工作指令（需求 26.1）
  outbound_gear_pn  TEXT,                                                       -- 出厂起落架件号（需求 26.1）
  part_no           TEXT,                                                       -- Process Card PART No（Process Data 带出，需求 27.1、27.2）
  part_sn           TEXT,                                                       -- Process Card PART S/N（同上）
  part_desc         TEXT,                                                       -- Process Card PART DES.（同上）
  operation_type    TEXT,                                                       -- Process Card Operation Type（同上）
  start_time        TEXT,                                                       -- 工卡级开始时间 = 最早工序开始时间（需求 33.1、33.5）
  finish_time       TEXT,                                                       -- 工卡级结束时间，仅全部工序完成后写入（需求 33.6、33.7）
  exec_status       TEXT    CHECK (exec_status IN ('Pending','InProgress','Completed'))
                                                                                -- 执行状态，供作废前置校验（需求 42.1）
);

CREATE INDEX IF NOT EXISTS ix_job_card ON job (card_id, card_revision);
CREATE INDEX IF NOT EXISTS ix_job_pid ON job (pid_no);

-- ---------------------------------------------------------------------
-- job_process：JOB 工序实例（需求 11.4、15.1–15.4、33.2–33.4、47.7）
--
-- ⚠ 条码只在执行域生成：barcode_value = `{JOB No}-{Process ID}`（《临时设计说明》D-03），
--   全局唯一（需求 15.2）；编制域 process_step 不含条码列（需求 15.3）。
-- ⚠ step_id 仅作**溯源引用**：JOB 的执行与呈现一律读 job_step_snapshot.content，
--   不读 process_step 当前内容（Property 34、需求 49.6）。
-- ⚠ effective_man_hours / actual_man_hours 由 Production 报工写入，TS 编制界面不可写（需求 47.7）。
-- barcode_type 为本表局部取值集，直接写字面量 CHECK（条码与二维码承载同一字符串）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_process (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id               INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,   -- 所属 JOB
  step_id              INTEGER REFERENCES process_step(id),                     -- 来源工序模板，仅溯源（需求 49.6）
  process_id           TEXT    NOT NULL,                                        -- 工序编号（需求 11.1）
  barcode_value        TEXT    NOT NULL UNIQUE,                                 -- 条码值 {JOB No}-{Process ID}（需求 15.1、15.2）
  barcode_type         TEXT    CHECK (barcode_type IN ('barcode','qr')),        -- 条码类型（需求 15.1）
  start_time           TEXT,                                                    -- 工序开始时间（报工写入，需求 33.2–33.4）
  finish_time          TEXT,                                                    -- 工序结束时间（报工写入，需求 33.2–33.4）
  effective_man_hours  REAL,                                                    -- 有效工时（Production 写入，需求 11.4、47.7）
  actual_man_hours     REAL,                                                    -- 实际工时（Production 写入，需求 11.4、47.7）

  UNIQUE (job_id, process_id)                                                   -- 工序编号在 JOB 内唯一（需求 15.2）
);

CREATE INDEX IF NOT EXISTS ix_job_process_job ON job_process (job_id, process_id);
CREATE INDEX IF NOT EXISTS ix_job_process_step ON job_process (step_id);

-- ---------------------------------------------------------------------
-- job_step_snapshot：工序内容快照（需求 37.5、44.6、49.5–49.7）
--
-- 释放时对该次释放所含工序内容建立**不可变副本**。若无快照，job_process.step_id 直接引用
-- 可变的编制域模板行，后续任何模板修改都会追溯性改变历史 JOB 呈现的作业内容。
-- ⚠ 写入时机：POST /api/task-cards/:id/release 的同一事务内，与 job、job_process、条码一并完成。
-- ⚠ 本表**只写不改**：仓储层不提供 update 方法，无更新入口（Property 34、需求 49.7）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_step_snapshot (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_process_id       INTEGER NOT NULL UNIQUE
                               REFERENCES job_process(id) ON DELETE CASCADE,    -- 一对一绑定 JOB 工序实例
  source_step_id       INTEGER,                                                 -- 来源工序模板 id（仅溯源，不作读取依赖）
  source_card_revision INTEGER NOT NULL,                                        -- 快照取自的工卡版本号（需求 49.5）
  content              TEXT    NOT NULL,                                        -- (JSON) 工序内容全量快照（需求 37.5、49.6）
  snapshot_at          TEXT    NOT NULL                                         -- 快照生成时间 = 释放时间
);

-- ---------------------------------------------------------------------
-- safety_acknowledgement：安全警示查看确认（需求 31.5–31.7）
-- 关键工序进入执行前须存在该用户的查看确认记录（含确认人与确认时间）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS safety_acknowledgement (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_process_id  INTEGER NOT NULL REFERENCES job_process(id) ON DELETE CASCADE,
  acknowledged_by TEXT,                                                         -- 确认人工号（需求 31.7）
  acknowledged_at TEXT                                                          -- 确认时间（需求 31.7）
);

CREATE INDEX IF NOT EXISTS ix_safety_ack_process
  ON safety_acknowledgement (job_process_id, acknowledged_by);

-- ---------------------------------------------------------------------
-- electronic_signature：电子签章记录（需求 32.2–32.4、45.4、45.5）
-- 必需签署项来源为工卡全部工序 signature_requirement 的并集（需求 32.4）；
-- 无纸化归档要求每项均有含签署人、签章标识与完成日期的记录（需求 32.2、32.3）。
-- job_id 为 NULL 表示编制态签署（不绑定具体 JOB）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS electronic_signature (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id                  INTEGER REFERENCES task_card(id),                    -- 所属工卡
  job_id                   INTEGER REFERENCES job(id),                          -- 所属 JOB，编制态签署为 NULL
  signature_requirement_id INTEGER REFERENCES signature_requirement(id),        -- 对应签署项（需求 32.4、45.1）
  signed_by                TEXT,                                                -- 签署人（需求 32.2）
  stamp_id                 TEXT,                                                -- 签章标识，未要求盖章时为 NULL（需求 32.2、45.3）
  signed_at                TEXT                                                 -- 完成日期（需求 32.2）
);

CREATE INDEX IF NOT EXISTS ix_electronic_signature_card
  ON electronic_signature (card_id, signature_requirement_id);
CREATE INDEX IF NOT EXISTS ix_electronic_signature_job ON electronic_signature (job_id);

-- =====================================================================
-- 分节 3 · 流程与审计域 —— 任务 3.4 追加
--   review_record / supersede_record / change_record /
--   commercial_classification_result / migration_batch / migration_record /
--   work_package_release / access_denial_log
--
-- ⚠ 本分节各表均为**审计轨迹**：card_id 外键一律**不带 ON DELETE CASCADE**。工卡的退出
--   途径是作废（Void）而非物理删除，留痕不得随主数据一并消失（需求 19.3、44.6）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- review_record：按版本留存的审核记录（需求 34.6–34.9、34.11）
--
-- ⚠ comment NOT NULL 是需求 34.11「审核意见必填」的**数据层**落实：批准与驳回一律须带意见，
--   服务层的空白校验之外再加一道，绕过服务层的写入路径同样无法留下无意见的审核记录。
-- ⚠ 记录挂在 (card_id, card_revision) 上而非仅 card_id：升版后新版本审核记录数从 0 起算
--   （需求 34.9、Property 19）。
-- action 为本表局部取值集（非全系统枚举），直接写字面量 CHECK。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_record (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       INTEGER NOT NULL REFERENCES task_card(id),                      -- 被审核工卡
  card_revision INTEGER NOT NULL,                                              -- 被审核版本号（需求 34.9）
  action        TEXT    NOT NULL CHECK (action IN ('approve','reject')),        -- 审核动作（需求 34.6、34.7）
  reviewer      TEXT,                                                          -- 审核人工号，一编一审依据（需求 22.2、22.3）
  comment       TEXT    NOT NULL,                                              -- 审核意见，必填（需求 34.11）
  reviewed_at   TEXT                                                           -- 审核时间（需求 34.8）
);

CREATE INDEX IF NOT EXISTS ix_review_record_card ON review_record (card_id, card_revision);

-- ---------------------------------------------------------------------
-- supersede_record：版本取代关系（需求 44.1、44.2、44.8）
--
-- 新版本批准生效时于**同一事务**内写入，并将原生效版本迁至 Superseded；失败则整体回滚该次批准。
-- ⚠ 语句顺序（Property 25）：先降级原生效版本、后置本版本为 Effective，否则第一条 UPDATE 即撞
--   ux_task_card_effective_task_no 部分唯一索引。
-- ⚠ 键为 task_no 而非 card_id：取代关系描述的是**同一编号下两个版本**的关系，不填作废原因、
--   不走作废流程（需求 44.3）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supersede_record (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no              TEXT    NOT NULL,                                       -- 工卡编号（需求 44.1）
  superseded_revision  INTEGER NOT NULL,                                       -- 被取代版本号
  superseding_revision INTEGER NOT NULL,                                       -- 取代版本号
  superseded_at        TEXT                                                    -- 取代时间（需求 44.2）
);

CREATE INDEX IF NOT EXISTS ix_supersede_record_task_no ON supersede_record (task_no);

-- ---------------------------------------------------------------------
-- change_record：变更记录（需求 19.1–19.3、20.8、42.5）
--
-- ⚠ 唯一写入构造点为 domain/change-record.js 的 buildChangeRecords（Property 35）：保存、
--   工序/参考文件删除、升版、批量替换、作废五条路径一律经该单点，禁止各自拼装记录行。
-- ⚠ reason NOT NULL 是需求 19.2「变更原因必填」的**数据层**落实；纯空白原因的拒绝在领域层
--   （NOT NULL 拦不住空串）。
-- ⚠ field / old_value / new_value 可为 NULL：整体性变更（作废、删除）未必落到具体字段；
--   字段级变更则三列齐备，每个实际变化的字段恰对应一条记录（需求 19.3）。
-- change_type 为本表局部取值集（非全系统枚举），直接写字面量 CHECK。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_record (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       INTEGER NOT NULL REFERENCES task_card(id),                     -- 变更所属工卡
  card_revision INTEGER,                                                       -- 变更所在版本号
  change_type   TEXT    NOT NULL
                        CHECK (change_type IN ('edit','delete','revise','batch_replace','void')),
                                                                               -- 变更类型（需求 19.1、20.8、42.5）
  field         TEXT,                                                          -- 变更字段名（整体性变更时为 NULL）
  old_value     TEXT,                                                          -- 变更前值（需求 19.3）
  new_value     TEXT,                                                          -- 变更后值（需求 19.3）
  reason        TEXT    NOT NULL,                                              -- 变更原因，必填（需求 19.2、20.7）
  operator_id   TEXT,                                                          -- 操作人工号（需求 19.3）
  timestamp     TEXT                                                           -- 变更时间（需求 19.3）
);

CREATE INDEX IF NOT EXISTS ix_change_record_card ON change_record (card_id, card_revision);
CREATE INDEX IF NOT EXISTS ix_change_record_type ON change_record (change_type);

-- ---------------------------------------------------------------------
-- commercial_classification_result：商务分类派生审计轨迹（需求 29.5、29.6）
--
-- ⚠ **追加式（append-only）**：每次派生或人工确认都追加一行，不更新既有行。同一工卡因此可有
--   多行历史；当前权威值存 task_card.commercial_classification，其值恒等于本表最新一行的
--   classification。仓储层不提供 update（对应 jobStepSnapshotRepo 的同类约定）。
-- ⚠ classification 允许 NULL：类型 11 或同层多命中时**不自动裁决**，此行仅登记候选与待确认状态，
--   由人工确认后再追加一行（需求 29.6、29.7、43.4）。
-- ⚠ hit_tier 取值域为 DERIVATION_PRIORITY（P1–P6）；运行时优先级顺序以
--   derivation_priority_config 表为权威，本列只记录**该次命中的层级代码**（需求 29.5、29.8）。
-- source_ref 记录判定依据来源（如排产设置、发起单据号、外包清单条目、工包划分引用）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commercial_classification_result (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id             INTEGER NOT NULL REFERENCES task_card(id),               -- 所属工卡
  classification      TEXT    {{CHECK:commercialClassification:classification}},
                                                                               -- 派生结果，待人工确认时为 NULL（需求 29.1、29.6）
  hit_tier            TEXT    {{CHECK:derivationPriority:hit_tier}},           -- 命中层级 P1–P6（需求 29.5）
  source_ref          TEXT,                                                    -- 判定依据来源（需求 29.5）
  is_manual_confirmed INTEGER NOT NULL DEFAULT 0
                              CHECK (is_manual_confirmed IN (0,1)),            -- 是否经人工确认（需求 29.6）
  confirmed_by        TEXT,                                                    -- 人工确认人，自动派生时为 NULL
  confirmed_at        TEXT,                                                    -- 人工确认时间，自动派生时为 NULL
  created_at          TEXT                                                     -- 本行产生时间（追加顺序依据）
);

CREATE INDEX IF NOT EXISTS ix_classification_result_card
  ON commercial_classification_result (card_id, created_at);

-- ---------------------------------------------------------------------
-- migration_batch：存量迁移批次（需求 41.4、41.5）
-- 报告口径：success_count + failure_count 恒等于 total_count（Property 32）。
-- source_channel 为本表局部取值集：excel / csv 为主通道；word / rtf 为经人工确认的辅通道
-- （design.md「迁移解析层」）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_batch (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel TEXT    CHECK (source_channel IN ('excel','csv','word','rtf')), -- 迁移通道
  source_name    TEXT,                                                         -- 来源文件名（仅记录）
  total_count    INTEGER NOT NULL DEFAULT 0,                                   -- 输入总条数
  success_count  INTEGER NOT NULL DEFAULT 0,                                   -- 成功条数（需求 41.4）
  failure_count  INTEGER NOT NULL DEFAULT 0,                                   -- 失败条数（需求 41.4）
  executed_by    TEXT,
  executed_at    TEXT
);

-- ---------------------------------------------------------------------
-- migration_record：迁移逐条结果（需求 41.4、41.5、17.1、17.2）
--
-- ⚠ 失败隔离（Property 32）：单条失败只落一行 failed 并继续其余，不影响批次内其他记录。
-- ⚠ failure_category 支撑需求 41.5「按原因类型分组统计」——业务方须能区分「解析没解出来」
--   （enum_invalid / required_missing）与「约束不匹配」（stage_card_type_invalid /
--   duplicate_task_no）两类根因（《临时设计说明》A4-4）。仅失败行填写。
-- ⚠ card_id 仅成功行填写，指向落库后的工卡（状态 New、保留原命名规则，需求 17.1、41.6）。
-- status / failure_category 均为本表局部取值集，直接写字面量 CHECK。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_record (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id         INTEGER NOT NULL REFERENCES migration_batch(id) ON DELETE CASCADE,
  row_no           INTEGER,                                                    -- 源文件行号，便于回溯定位
  source_task_no   TEXT,                                                       -- 源记录工卡编号（原命名规则，需求 41.6）
  card_id          INTEGER REFERENCES task_card(id),                           -- 成功落库的工卡；失败行为 NULL
  status           TEXT    NOT NULL CHECK (status IN ('success','failed')),    -- 逐条结果（需求 41.4）
  failure_category TEXT    CHECK (failure_category IN
                            ('enum_invalid','required_missing','stage_card_type_invalid','duplicate_task_no')),
                                                                               -- 失败原因分类（需求 41.5）
  failure_reason   TEXT                                                        -- 失败原因描述（需求 41.4、41.5）
);

CREATE INDEX IF NOT EXISTS ix_migration_record_batch
  ON migration_record (batch_id, status, failure_category);

-- ---------------------------------------------------------------------
-- work_package_release：发布至工包的结果记录（需求 24.1–24.3）
-- ⚠ 无论成功与否均记录一次结果（需求 24.3、Property 15），故 result NOT NULL。
-- result 为本表局部取值集，直接写字面量 CHECK。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_package_release (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES task_card(id),                      -- 被发布工卡（须为 Effective，需求 24.1）
  job_no       TEXT,                                                           -- 关联 JOB 编号（若已生成）
  package_ref  TEXT,                                                           -- 目标工包引用标识
  released_at  TEXT,                                                           -- 发布时间
  result       TEXT    NOT NULL CHECK (result IN ('success','failed'))         -- 发布结果（需求 24.3）
);

CREATE INDEX IF NOT EXISTS ix_work_package_release_card ON work_package_release (card_id);

-- ---------------------------------------------------------------------
-- access_denial_log：越权尝试审计（需求 47.10）
-- ⚠ 与 change_record 职责分离：本表记录**被拒绝的访问尝试**（无业务变更发生），
--   change_record 记录**已发生的业务变更**，两者不混用。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_denial_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_no         TEXT,                                                       -- 尝试者工号
  role             TEXT    {{CHECK:role}},                                     -- 尝试者角色（需求 47.1）
  permission_point TEXT    {{CHECK:permissionPoint}},                          -- 被拒的权限点（需求 47.2–47.9）
  method           TEXT,                                                       -- HTTP 方法
  path             TEXT,                                                       -- 请求路径
  denied_at        TEXT                                                        -- 拒绝时间
);

CREATE INDEX IF NOT EXISTS ix_access_denial_log_staff ON access_denial_log (staff_no, denied_at);

-- =====================================================================
-- 分节 4 · 配置、主数据与集成 mock —— 任务 3.5 追加
--   app_user / role_permission / system_parameter / stage_card_type_constraint /
--   stage_crosscut / card_type_commercial_map / derivation_priority_config /
--   capability_list / print_template / exec_doc_type / task_no_sequence /
--   step_template / tpc_document / ppc_process_data / ppc_schedule /
--   process_data / lot_list_base
--
-- ⚠ 配置表是「改配置不改代码」的落点（需求 29.8、43.5、46.14）：Stage×类型约束、类型→商务
--   分类映射、派生优先级链、能力清单四组配置在**运行时以本分节表为权威**，enums.js 中对应
--   常量（STAGE_CROSSCUT/A4、DERIVATION_PRIORITY/A1）仅作 seed.js 的种子默认值与层级代码
--   字面量校验。故这些表的枚举列 CHECK 绑定**完整值域**（如 stage_crosscut.stage 用 STAGE 而
--   非 STAGE_CROSSCUT），否则业务方连「新增一个横切取值」都要改代码，配置化即失效。
-- ⚠ 集成 mock 表（tpc_document / ppc_process_data / ppc_schedule / process_data /
--   lot_list_base）代表**外部系统数据**，本模块只读、无写端点（需求 27.3、30.2、47.4、48.8）。
--   其 card_id / pid_no 为**软引用不建外键**：外部系统的行不应因本地工卡不存在而无法落地，
--   且需求 26.4 要求存在「取不到值则留空且不阻断」的分支，种子须能写入故意缺 PID 的行。
-- =====================================================================

-- ---------------------------------------------------------------------
-- app_user：最小用户主数据（需求 47.1、22.3、7.4）
-- ⚠ **不含口令列**：当前身份由 POST /api/session 选定 staff_no（design.md §1.10），
--   接企业统一认证后本表退化为角色映射表。
-- ⚠ 全系统操作人列（task_card.created_by / reviewed_by / operator_id 及各审计表）一律存
--   staff_no 而非本表 id，故 staff_no 必须 UNIQUE——一编一审（需求 22.3）以该值比较。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_no  TEXT    NOT NULL UNIQUE,                                           -- 工号，全系统操作人标识（需求 22.3、7.4）
  name      TEXT,                                                              -- 姓名
  role      TEXT    NOT NULL {{CHECK:role}},                                    -- 系统角色（需求 47.1）
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))               -- 是否启用
);

CREATE INDEX IF NOT EXISTS ix_app_user_role ON app_user (role, is_active);

-- ---------------------------------------------------------------------
-- role_permission：角色 × 权限点矩阵（需求 47.1–47.10、20.9）
-- ⚠ allowed 显式存 0 与 1 两态，而非「有行即允许」：8 角色 × 13 权限点的完整矩阵可被读出，
--   GET /api/me/permissions 与越权判定读同一张表，前端禁用与后端拦截口径一致。
-- ⚠ batch_replace / config_write / capability_write 为**独立权限点**，不由 card_edit 继承
--   （需求 20.9、47.9）——继承关系不在数据层隐含，一律逐点配置。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permission (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  role             TEXT    NOT NULL {{CHECK:role}},                             -- 角色（需求 47.1）
  permission_point TEXT    NOT NULL {{CHECK:permissionPoint}},                  -- 权限点（需求 47.2–47.9）
  allowed          INTEGER NOT NULL DEFAULT 0 CHECK (allowed IN (0,1)),         -- 是否允许

  UNIQUE (role, permission_point)                                              -- 同一角色同一权限点仅一条判定
);

-- ---------------------------------------------------------------------
-- system_parameter：系统参数（需求 35.1、35.2）
-- 组织名称 Organization Name 等全局参数；键即主键，读取端 GET /api/system-parameters。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_parameter (
  key   TEXT PRIMARY KEY,                                                      -- 参数键（如 organizationName）
  value TEXT                                                                   -- 参数值（需求 35.1）
);

-- ---------------------------------------------------------------------
-- stage_card_type_constraint：Stage × 工卡类型允许组合（需求 46.9–46.14）
--
-- ⚠ 本表为**运行时权威**：需求 46.11 的组合合法性校验、46.12 的默认值自动填入一律读本表，
--   业务方经 PUT /api/stage-constraints 维护即改校验结果，不改代码（需求 46.14）。
-- ⚠ 校验时的合法范围为「本表该类型的允许组合 ∪ stage_crosscut」（需求 46.12、46.13）：
--   横切取值不登记于本表，故仅查本表会误拒 DMY/NRC/WCC/WFD。
-- ⚠ is_auto_fill 标记「选定类型后自动填入的默认 Stage」（01–09→RTN、10→SPC，需求 46.12）；
--   仅为默认值，Stage 字段**不置只读**，故本列不影响可改选范围。
-- 默认数据（⚠ Hotfix 假定，《临时设计说明》A4）由任务 3.6 的 seed.js 写入。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stage_card_type_constraint (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_type     TEXT    NOT NULL {{CHECK:cardType}},                            -- 工卡类型 01–11（需求 16.1）
  allowed_stage TEXT    NOT NULL {{CHECK:stage:allowed_stage}},                 -- 该类型允许的 Stage（需求 6.5、46.9）
  is_auto_fill  INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_fill IN (0,1)),       -- 是否作为默认值自动填入（需求 46.12）

  UNIQUE (card_type, allowed_stage)                                            -- 同一组合不重复登记
);

CREATE INDEX IF NOT EXISTS ix_stage_constraint_card_type
  ON stage_card_type_constraint (card_type, is_auto_fill);

-- ---------------------------------------------------------------------
-- stage_crosscut：横切 Stage 取值（需求 46.13）
-- 不受工卡类型约束，可与任意类型共存且不触发需求 46.11 的阻止。
-- ⚠ CHECK 绑定完整 STAGE 值域而非 enums.js 的 STAGE_CROSSCUT：本表是运行时权威，业务方
--   增删横切取值属配置动作（需求 46.14）；STAGE_CROSSCUT 仅为种子默认值（A4 待澄清）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stage_crosscut (
  stage TEXT PRIMARY KEY {{CHECK:stage}}                                       -- 横切取值（种子默认 DMY/NRC/WCC/WFD）
);

-- ---------------------------------------------------------------------
-- card_type_commercial_map：工卡类型 → 商务分类映射（需求 43.1–43.5）
-- ⚠ 仅作派生优先级链的 **P6 兜底层**，永不覆盖 P1–P5 的命中结果（需求 29.2、43.3）。
-- ⚠ 同一类型允许多行：类型 11 等多命中场景不自动裁决，由人工确认（需求 43.4、29.6）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_type_commercial_map (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  card_type                 TEXT NOT NULL {{CHECK:cardType}},                   -- 工卡类型（需求 16.1）
  commercial_classification TEXT NOT NULL {{CHECK:commercialClassification}},   -- 兜底商务分类（需求 29.1、43.1）

  UNIQUE (card_type, commercial_classification)                                -- 同一映射不重复
);

CREATE INDEX IF NOT EXISTS ix_card_type_commercial_map_type
  ON card_type_commercial_map (card_type);

-- ---------------------------------------------------------------------
-- derivation_priority_config：商务分类派生优先级链（需求 29.8）
--
-- ⚠ 本表为**运行时权威源**：服务层一律 `ORDER BY tier_order` 读取并按 enabled 过滤，
--   禁止直接遍历 enums.js 的 DERIVATION_PRIORITY 常量（否则需求 29.8「改配置不改代码」失效）。
-- ⚠ tier_order UNIQUE 是 Property 23 派生确定性的数据层保障：两层同序会使 ORDER BY 结果
--   依赖行插入顺序，同一输入可得不同分类。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derivation_priority_config (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tier_code  TEXT    NOT NULL UNIQUE {{CHECK:derivationPriority:tier_code}},    -- 层级代码 P1–P6（需求 29.2）
  tier_order INTEGER NOT NULL UNIQUE,                                          -- 层级顺序，越小越优先（需求 29.8）
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))               -- 是否启用该层
);

-- ---------------------------------------------------------------------
-- capability_list：能力清单（需求 39.1–39.4，QA_Engineer 维护）
--
-- ⚠ 多版本 + 生效期：同一 (ac_type, gear_type, skill) 可有多条 revision，需求 39.4 的范围
--   校验取**当前生效版本**（effective_from <= 今日 AND (effective_to IS NULL OR
--   effective_to >= 今日)，同期多条取 revision 最大者）。effective_to 为 NULL 表示无限期有效。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capability_list (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ac_type        TEXT    NOT NULL {{CHECK:acType}},                             -- 机型（需求 6.3、39.1）
  gear_type      TEXT    NOT NULL {{CHECK:gearType}},                           -- 起落架类型（需求 6.4、39.1）
  skill          TEXT    NOT NULL {{CHECK:skill}},                              -- 专业（需求 6.6、39.1）
  revision       INTEGER NOT NULL DEFAULT 1,                                   -- 清单版本号（需求 39.4）
  effective_from TEXT,                                                         -- 生效起日 YYYY-MM-DD（需求 39.4）
  effective_to   TEXT,                                                         -- 生效止日；NULL = 无限期（需求 39.4）

  UNIQUE (ac_type, gear_type, skill, revision)                                 -- 同一能力项同版本仅一条
);

CREATE INDEX IF NOT EXISTS ix_capability_list_scope
  ON capability_list (ac_type, gear_type, skill, effective_from, effective_to);

-- ---------------------------------------------------------------------
-- print_template：打印模板（需求 40.1–40.4）
-- target_kind 为本表局部取值集：按工卡类型或执行单据类型各自配置模板；
-- target_code 相应存 card_type（01–11）或 exec_doc_type 代码，故不绑单一枚举值域。
-- template_body 为 HTML 模板字符串（Handlebars 语法子集 `{{field}}` / `{{#each steps}}`），
-- 由前端渲染后经浏览器打印，不引入服务端 PDF 引擎（design.md「配置与主数据表」）。
-- ⚠ 部分唯一索引保证「同一目标至多一个默认模板」（需求 40.4）：选模板时默认项须确定。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_template (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind   TEXT    NOT NULL CHECK (target_kind IN ('card_type','exec_doc_type')),
                                                                               -- 模板适用对象类别（需求 40.1）
  target_code   TEXT    NOT NULL,                                              -- 目标代码：card_type 或 exec_doc_type
  template_body TEXT,                                                          -- HTML 模板正文（需求 40.2）
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))         -- 是否该目标的默认模板（需求 40.4）
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_print_template_default
  ON print_template (target_kind, target_code) WHERE is_default = 1;

-- ---------------------------------------------------------------------
-- exec_doc_type：执行单据类型与签署要求属性（需求 16.2、16.4、16.5）
-- ⚠ sign_rule NOT NULL：需求 45.8 的「该单据至少配置一个签署项」判定以本列为依据，
--   缺值会使签署项缺失检查静默放过（SC = 单据不签署，其所发工卡步骤需签署，需求 16.5）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exec_doc_type (
  code      TEXT PRIMARY KEY {{CHECK:execDocType:code}},                        -- 单据类型代码（需求 16.2）
  name      TEXT,                                                              -- 中文/英文名称
  sign_rule TEXT NOT NULL                                                      -- 签署要求属性（需求 16.4、16.5）
);

-- ---------------------------------------------------------------------
-- task_no_sequence：批量复制的编号规则与流水（需求 38.8、38.9）
-- ⚠ prefix / suffix NOT NULL DEFAULT ''：SQLite 视 NULL 互不相等，若允许 NULL 则
--   (NULL, NULL) 可重复插入，同一规则出现两条流水，批量复制将生成重复编号。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_no_sequence (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix   TEXT    NOT NULL DEFAULT '',                                        -- 编号前缀（需求 38.8）
  suffix   TEXT    NOT NULL DEFAULT '',                                        -- 编号后缀（需求 38.8）
  next_seq INTEGER NOT NULL DEFAULT 1,                                         -- 下一流水号（需求 38.9）
  step     INTEGER NOT NULL DEFAULT 1,                                         -- 流水步长（需求 38.9）

  UNIQUE (prefix, suffix)                                                      -- 同一前后缀组合仅一条流水
);

-- ---------------------------------------------------------------------
-- step_template：工序模板（需求 14.1、14.2）
-- payload 为工序内容全量 JSON（工序字段 + 采集项 + 插入组件），套用时展开为 process_step
-- 及其子表记录；结构与 job_step_snapshot.content 同构，便于复用序列化逻辑。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS step_template (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT    NOT NULL UNIQUE,                                             -- 模板名称，供选择套用（需求 14.2）
  payload TEXT                                                                 -- (JSON) 工序内容模板（需求 14.1）
);

-- ---------------------------------------------------------------------
-- tpc_document：TPC 文档 mock（需求 7.3、25.1）
-- GET /api/tpc/documents 的数据源；检索命中后回填 task_card 的四个只读列
-- （document_type / ref_no / document_revision / document_desc）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tpc_document (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type     TEXT,                                                           -- 文件类型（需求 7.3）
  ref_no       TEXT,                                                           -- 参考号
  doc_revision TEXT,                                                           -- 版本号
  doc_desc     TEXT,                                                           -- 文件描述
  keyword      TEXT                                                            -- 检索关键字（需求 25.1）
);

CREATE INDEX IF NOT EXISTS ix_tpc_document_ref ON tpc_document (ref_no);
CREATE INDEX IF NOT EXISTS ix_tpc_document_keyword ON tpc_document (keyword);

-- ---------------------------------------------------------------------
-- ppc_process_data：PPC 工作分类与预计工时 mock（需求 11.3、25.2）
-- GET /api/ppc/process-data 的数据源。⚠ 本模块**只读**：写入归 PPC 专属界面，
-- TS 编制界面不得人工写入 work_category / estimated_man_hours（需求 47.4、47.5）。
-- card_id / step_ref 为软引用（不建外键，见分节头注）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppc_process_data (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id             INTEGER,                                                 -- 对应工卡（软引用）
  step_ref            TEXT,                                                    -- 工序引用（process_id）
  work_category       TEXT,                                                    -- 工作分类（需求 11.3）
  estimated_man_hours REAL                                                     -- 预计工时（需求 11.3）
);

CREATE INDEX IF NOT EXISTS ix_ppc_process_data_card ON ppc_process_data (card_id, step_ref);

-- ---------------------------------------------------------------------
-- ppc_schedule：PPC 排产结果 mock（需求 26.4）
-- GET /api/ppc/schedule?pid=&cardId= 的数据源；释放生成 JOB 时其 job_target_date 写入
-- job.job_target_date。⚠ 取不到值时该列留空且**不阻断**释放（编制态本就不呈现该栏位），
-- 故种子须包含故意缺失 PID 的样例以覆盖该分支（任务 3.6）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppc_schedule (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pid_no          TEXT,                                                        -- PID（软引用，可为空以覆盖取不到值分支）
  card_id         INTEGER,                                                     -- 对应工卡（软引用）
  job_target_date TEXT                                                         -- JOB TARGET DATE（需求 26.1、26.4）
);

CREATE INDEX IF NOT EXISTS ix_ppc_schedule_lookup ON ppc_schedule (pid_no, card_id);

-- ---------------------------------------------------------------------
-- process_data：Process Data mock（需求 27.1、27.2、30.1）
-- GET /api/process-data?pid=&cardId=&stepId= 的数据源，一次返回五项：
-- part_no / part_sn / part_desc / operation_type 落 **job 表**（需求 27.5 两域分离，
-- task_card 一律不含），operation 供工序只读展示（需求 30.1）。
-- ⚠ 本模块**只读，无写端点**：上述列任何角色皆不可经编制界面人工写入（需求 27.3、30.2）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS process_data (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pid_no         TEXT,                                                         -- PID（软引用）
  card_id        INTEGER,                                                      -- 对应工卡（软引用）
  step_ref       TEXT,                                                         -- 工序引用（process_id），卡级数据可为空
  part_no        TEXT,                                                         -- PART No（需求 27.1、27.2）
  part_sn        TEXT,                                                         -- PART S/N（同上）
  part_desc      TEXT,                                                         -- PART DES.（同上）
  operation_type TEXT,                                                         -- Operation Type（同上）
  operation      TEXT                                                          -- 工序 Operation，只读展示（需求 30.1）
);

CREATE INDEX IF NOT EXISTS ix_process_data_lookup ON process_data (pid_no, card_id, step_ref);

-- ---------------------------------------------------------------------
-- lot_list_base：Lot List 所含 Base Number 集合 mock（需求 48.3、48.8）
-- GET /api/lot-lists/:lotListRef/bases 的数据源，为 aggregateBomBase 的 lotLinks 入参
-- 补齐 Base 值。Lot List（LT 单据）主数据归独立模块（《临时设计说明》A6 待澄清项 1），
-- 本模块只读。⚠ 不去重：同一 lot_list_ref 下多条 Base 并存，来源标识由 bom_base_output 承担。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lot_list_base (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_list_ref TEXT    NOT NULL,                                               -- Lot List 引用标识（需求 48.1）
  lot_number   TEXT,                                                           -- Lot Number
  base_number  TEXT    NOT NULL                                                -- Base Number（需求 48.3）
);

CREATE INDEX IF NOT EXISTS ix_lot_list_base_ref ON lot_list_base (lot_list_ref);

-- Section 20 integration contracts: local read-only mock sources.
CREATE TABLE IF NOT EXISTS pid_scope (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pid_no     TEXT NOT NULL UNIQUE,
  scope_json TEXT
);

CREATE TABLE IF NOT EXISTS classification_source (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id                 INTEGER NOT NULL UNIQUE,
  plan_dummy_job          TEXT,
  nrc_originating_doc     TEXT,
  outsource_entry         TEXT,
  part_nature             TEXT,
  package_division        TEXT
);

CREATE TABLE IF NOT EXISTS work_package_in_progress_ref (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL,
  package_ref TEXT NOT NULL,
  UNIQUE (card_id, package_ref)
);

CREATE INDEX IF NOT EXISTS ix_work_package_in_progress_card
  ON work_package_in_progress_ref (card_id);
