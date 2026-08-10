# Requirements Document

## Introduction

本模块为 HAECO LGS MES 工程模块（技术服务 / Technical Service）的基础功能：**工卡管理（Task Card Management，流程编号 LGS-TS-01-01）**。目标是为起落架（Landing Gear）维修提供数字化、无纸化的工卡管理能力，供技术服务（TS）部门使用，覆盖从工卡清单查询、工卡编制、工序编辑到对接工包系统发布的全流程。

本模块需满足用户需求中"工作指令最小信息集（I.1–I.11）"及"对接工包系统（II）"要求，实现工卡的标准化、无纸化与可追溯性。系统在商务端创建服务订单（SO）后自动生成 PID，TS 部门在该 PID 下依据工包清单数据库与 ISO 要求选用例行工卡（Routine Card）与特殊工卡（Special Card）。

本需求文档聚焦于工卡管理三大界面（工卡清单界面、工卡编制界面、工序信息编辑界面）及其配套的分类、版本、权限、集成能力。

**模块边界声明**（对齐蓝图 2.3.4「工程部门核心操作功能（3项）」）：

- **工卡管理（Task Card Management, LGS-TS-01-01）** — 本模块范围。
- **工作范围管理（Work Scope）** — 独立功能，不在本模块范围。依据蓝图工作分解步骤 30，系统依据 ISO 生成 Work Scope，各部门在其中维护自身相关工作内容并回馈 ISO 要求。本模块仅通过需求 25.3 描述其对接触点（依据 PID/ISO 提供可选工卡范围）。
- **工包清单数据库及单 PID 工包生成（Work Package List, LGS-TS-01-03）** — 独立流程，本模块仅描述对接触点（需求 24 发布、需求 37 JOB No 承载、需求 48 BOM Base 输出、需求 42.1(c) 在编工包引用查询）。
- **非例行工卡（NRC Control, LGS-TS-01-02）** — 独立流程，本模块仅描述对接触点（需求 21 工卡关联）。
- **技术出版物中心（Technical Publication Centre, LGS-TS-07-01）** — 独立流程；蓝图工作分解步骤 40「TS 在系统内针对 TPC 文件管理，上传原文件」不在本模块范围，本模块仅描述取数触点（需求 7.3、25.1 读取文档元数据）。
- **JOB 执行域** — 执行界面、多 SHEET 整合展示、执行附页等具体功能依蓝图原文「具体功能在生产蓝图上体现」归属生产蓝图。本模块声明 JOB No 的生成触发点与承载关系（需求 37），并定义**由编制域配置所决定**的执行期约束与数据落位：工序条码（需求 15）、安全警示前置门禁（需求 31.5–31.7）、电子签章与无纸化归档（需求 32）、工卡与工序起止时间（需求 33）、工序内容快照（需求 49.5–49.7）。上述条目构成本模块与生产蓝图之间的**接口契约**，生产蓝图 SHALL NOT 就同一行为重复定义。

## Glossary

- **工卡管理系统 (Task_Card_System)**：本模块所定义的工卡管理软件系统整体。
- **工卡清单界面 (Task_Card_List)**：用于工卡统一查询、筛选、批量操作与状态管理的入口界面。
- **工卡编制界面 (Task_Card_Editor)**：用于工卡结构化元数据编制与管理的主界面。
- **工序编辑界面 (Process_Step_Editor)**：用于工卡执行步骤编辑与数据采集配置的界面。
- **工卡 (Task_Card)**：技术服务部门依据制造商手册编制的维修工作指令，具备唯一编号与版本。
- **工序 (Process_Step)**：工卡内的单个执行步骤，具备工序编号、技能要求、工时与采集项。
- **参考文件 (Reference_Document)**：工卡所依据的手册文件，含文件类型、参考号、版本号、ATA 章节号。
- **IR卡 (IR_Card)**：工卡类型编码 04（IR Inspection card），含 Base Number（基础件号）与 IPC 项号等 BOM 建立字段。
- **工卡状态 (Card_Status)**：工卡生命周期状态，取值为 新增(New)、审核中(UnderReview)、生效(Effective)、已被取代(Superseded)、作废(Void)。其中「新增/生效/作废」为蓝图 2.3.4 明列的业务状态；「审核中」为承载蓝图工作分解步骤 60「编制完成的工卡进行审核」及一编一审合规要求所必需的中间态（详见需求 34）；「已被取代」为承载升版后原生效版本退出生效态所必需的终态（详见需求 44），其语义为「被更高版本取代」，区别于「作废」的「主动停用」。
- **审核意见 (Review_Comment)**：审核人在批准或驳回工卡时填写的意见，随工卡版本留存。
- **能力清单 (Capability_List)**：由 QA 依据局方文件维护并定期更新的能力主数据，作为工卡编制的输入约束（蓝图工作分解步骤 10）。
- **JOB No**：工卡经工程释放后生成的执行实例标识，用于承载执行期数据与条码（蓝图 2.3.6「JOB No 工程释放后生成」）。
- **Work Scope（工作范围）**：系统依据 ISO 生成的工作范围，属独立功能，本模块仅描述对接触点。
- **A/C Type**：机型代码，取值集合见需求 6。
- **Gear Type**：起落架类型代码，取值集合见需求 6。
- **Stage**：工卡阶段代码，取值集合见需求 6。
- **Skill**：专业代码，取值集合见需求 6。
- **Ctrl Code**：控制代码，取值集合见需求 6。
- **WBS**：工作分解结构，代表系统内工卡类型，下拉选择。
- **TPC数据库 (TPC_Database)**：技术出版物中心数据库，提供文件类型、参考号、文件版本、文件描述等文档元数据。
- **工包系统 (Work_Card_Package_System)**：接收已编制工卡进行工卡包生成与发布的下游系统。
- **PPC**：生产计划控制部门，单独维护每个工序的工作分类与预计工时。
- **PID**：起落架单次维修的唯一项目标识，由商务端创建 SO 后自动生成。
- **ISO**：客户订单相关的维修要求依据。
- **FAI**：首件检验标记（First Article Inspection flag）。
- **SWS**：Supplementary Work Sheet（补充工作单）。
- **TS工程师 (TS_Engineer)**：负责工卡编制的技术服务工程师。
- **TS经理 (TS_Manager)**：负责工卡审核/批准的技术服务经理。
- **NDT审核人 (NDT_Reviewer)**：负责无损检测相关内容审核的角色。
- **条码/二维码 (Barcode_QR)**：系统按固定逻辑为工序生成的标识，用于工具领用、报工、化学品领用等。
- **Process Data**：工艺数据来源，向工卡/工序带出 PART No、PART S/N、PART DES.、Operation Type、Operation 等字段。
- **工卡执行相关字段 (Execution_Fields)**：OWNER、JOB TARGET DATE、Check、INBOUND/OUTBOUND GEAR P/N、S/N、CSNo.、WORK ORDER 等由系统自动带出的只读字段。
- **商务执行工卡分类 (Commercial_Classification)**：由商务（CMC）确认的执行范围分类，取值见需求 29。
- **E-work card（电子工卡）**：支持线上电子化执行的工卡形态，可承载安全警示、视觉提示（图片/视频）与维修技巧，并要求操作人员执行前查看（蓝图 2.1.1 TS-01）。
- **安全警示 (Safety_Warning)**：针对关键维修任务/易误操作任务的警示内容，执行前须查看确认。
- **视觉提示 (Visual_Cue)**：以图片或视频形式承载的操作提示内容。
- **维修技巧 (Repair_Tips)**：辅助操作人员理解复杂步骤的经验性说明。
- **电子签章 (Electronic_Signature)**：用于工卡签署栏认证的电子签名/签章，实现无纸化归档。
- **签署项 (Signature_Requirement)**：编制阶段为工序配置的签署要求，含签署角色、是否盖章、完成日期，是需求 32.4「必需签署项」的唯一来源（详见需求 45）。
- **Lot List**：执行单据类型 LT，承载一组 Base Number；IR Lot 卡（类型 05）经其向 BOM List 输出 Base（详见需求 48）。
- **BOM List（预拆下清单）**：由工包汇总各 Task Card 的 Base Number 形成的单脚 BOM 基础，字段含 Task Card No、Task Title、上级件名称、Base Number、Lot Number、LRU 标记（蓝图 2.3.6）。
- **Planning / PPC 角色**：计划工程师与计划经理，拥有工序 Work Category 与 Estimated ManHours 的写入权限（经 PPC 专属界面），对本模块工卡为只读（详见需求 47）。
- **可编辑态 (Editable_State)**：工卡编制域内容允许被修改的唯一状态，即「新增(New)」；其余四态（审核中/生效/已被取代/作废）内容一律冻结，变更须经升版（详见需求 49）。
- **工序快照 (Step_Snapshot)**：工卡释放为 JOB 时对该次释放所含工序内容建立的不可变副本，供该 JOB 执行与呈现使用，不随编制域模板后续变动（详见需求 49.5–49.7）。

## Requirements

### 需求 1：工卡清单多维度查询

**User Story:** 作为 TS工程师，我希望在工卡清单界面按多个维度筛选工卡，以便快速定位需要处理的工卡。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 打开工卡清单界面, THE Task_Card_List SHALL 展示可按 A/C Type、Task Card No、Gear Type、工卡标题描述 输入或选择的筛选条件。
2. WHEN TS_Engineer 提交筛选条件, THE Task_Card_List SHALL 返回同时满足所有已填写筛选条件的工卡集合。
3. WHEN 具备清单查询权限的用户未填写任何筛选条件并执行查询, THE Task_Card_List SHALL 返回全部工卡。本模块 SHALL NOT 设置行级（按工卡逐条）数据权限，权限控制仅作用于功能点（见需求 47）；因此「有权访问的全部工卡」对具备清单查询权限的用户即等于全集。
4. IF 筛选条件无匹配工卡, THEN THE Task_Card_List SHALL 展示空结果提示并保留已输入的筛选条件。
5. WHEN TS_Engineer 在筛选条件中选择工卡状态为"生效(Effective)", THE Task_Card_List SHALL 仅返回状态为生效的工卡。

### 需求 2：工卡清单列表展示

**User Story:** 作为 TS工程师，我希望在列表中清晰看到工卡关键信息，以便判断工卡的适用范围与类型。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_List SHALL 为每条工卡展示以下关键字段：是否 FAI、Gear Type/构型、模板类型、工卡类型、工卡编号、工卡标题。
2. THE Task_Card_List SHALL 为每条工卡展示当前工卡状态（新增/审核中/生效/已被取代/作废）。
3. WHERE TS_Engineer 已配置列显示与布局设置, THE Task_Card_List SHALL 按用户保存的列顺序与列可见性展示列表。
4. WHEN TS_Engineer 修改列显示或布局设置, THE Task_Card_List SHALL 保存该配置供后续访问复用。

### 需求 3：工卡清单操作能力

**User Story:** 作为 TS工程师，我希望对工卡执行复制、变更、查看、导出、新增等操作，以便高效管理工卡。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 点击【新增】, THE Task_Card_System SHALL 打开空白的工卡编制界面。
2. WHEN TS_Engineer 对某条工卡点击【Edit】, THE Task_Card_System SHALL 打开该工卡的工卡编制界面并载入其已有信息。
3. WHEN TS_Engineer 选择一条或多条工卡并执行【复制】, THE Task_Card_System SHALL 为每条被选工卡生成一份内容副本作为新工卡。
4. WHEN TS_Engineer 选择一条或多条工卡并执行【变更/升版】, THE Task_Card_System SHALL 为每条被选工卡创建版本号自动加一的新版本。
5. WHEN TS_Engineer 对某条工卡执行【查看详情】, THE Task_Card_System SHALL 以只读方式展示该工卡的完整信息。
6. WHEN TS_Engineer 执行【关键信息导出】, THE Task_Card_System SHALL 导出所选工卡的关键字段。
7. WHEN TS_Engineer 执行【全量导出】, THE Task_Card_System SHALL 导出所选工卡的全部字段。
8. IF TS_Engineer 执行需要选中工卡的批量操作但未选中任何工卡, THEN THE Task_Card_System SHALL 提示需先选择工卡且不执行该操作。

### 需求 4：工卡状态管理

**User Story:** 作为 TS工程师，我希望管理工卡的生命周期状态，以便进行业务管控。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡被创建, THE Task_Card_System SHALL 将其工卡状态置为"新增(New)"。
2. WHEN 工卡完成审核批准, THE Task_Card_System SHALL 将其工卡状态置为"生效(Effective)"。
3. WHEN TS_Engineer 对工卡执行作废操作, THE Task_Card_System SHALL 将其工卡状态置为"作废(Void)"。
4. THE Task_Card_System SHALL 允许按工卡状态（新增/审核中/生效/已被取代/作废）对工卡清单进行筛选。
5. THE Task_Card_System SHALL 仅允许以下状态迁移：新增→审核中（提交审核）、审核中→生效（批准）、审核中→新增（驳回）、生效→已被取代（被更高版本取代，系统自动）、生效→作废（作废）、新增→作废（作废）。
6. IF 请求的状态迁移不属于上述允许集合, THEN THE Task_Card_System SHALL 拒绝该迁移并保持原状态不变。
7. THE Task_Card_System SHALL 将「已被取代(Superseded)」与「作废(Void)」均视为终态，不允许由其迁出至任何其它状态。

### 需求 5：工卡格式化打印

**User Story:** 作为 TS工程师，我希望按现有格式打印工卡，以便保证现有 LGS 业务运转。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 对某条工卡执行打印, THE Task_Card_System SHALL 按预定义格式生成可打印的工卡输出。
2. THE Task_Card_System SHALL 在打印输出中不展示工卡分类（工卡类型）信息。
3. THE 打印输出 SHALL 包含工卡最小信息集所要求呈现的字段（组织名称、工卡编号、标题、参考文件与版本、修订版本与日期、适用机型/件号、工序步骤与记录栏、签署栏、特殊工具/耗材、工时与起止时间栏、维修草图）。

### 需求 6：工卡元数据编制（最小信息集与下拉字段）

**User Story:** 作为 TS工程师，我希望在工卡编制界面录入结构化元数据，以便满足工卡最小信息集要求。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_Editor SHALL 提供录入以下字段：Task No（工卡编号）、Title（标题）、Revision（版本）、Date（修订日期）。
2. THE Task_Card_Editor SHALL 允许 TS_Engineer 手动输入 Task No。
3. THE Task_Card_Editor SHALL 将 A/C Type 提供为下拉选择，取值限定为 {190, 195, 320, 32E, 330, 350, 737, 73C, 741, 744, 747, 748, 757, 767, 777, 787, 909, 919, 999, A21}。
4. THE Task_Card_Editor SHALL 将 Gear Type 提供为下拉选择，取值限定为 {BLG, LDG, MLG, N/A, NLG, WLG}。
5. THE Task_Card_Editor SHALL 将 Stage 提供为下拉选择，取值限定为 {CUS, DMY, MOD, NRC, RTN, SPC, WCC, WFD}。
6. THE Task_Card_Editor SHALL 将 Skill 提供为下拉选择，取值限定为 {AS, BH, CL, DI, EL, GR, IR, LA, LT, ML, NC, NT, PL, PP, PPC, QC, SC, SP, TS, TSC}。
7. THE Task_Card_Editor SHALL 将 Ctrl Code 提供为下拉选择，取值限定为 {AS, CL, DA, FAB, FT, IS, LD, MD, OHV}。〔**待业务方确认**：蓝图 2.3.4 Ctrl Code 表的描述列存在错位（如 "AS | ASSEMBLY CLEANING"、"FAB | LOGISTICS DEPART MODIFICATION"、"OHV | OVERHAUL PAINTING RECEIVING INSPECTION REPAIR"），业务方将回填正式值域后复核本条〕
8. THE Task_Card_Editor SHALL 将 WBS 提供为下拉选择，其值域即需求 16.1 定义的工卡类型编码集（01–11）；WBS 与工卡类型为**同一字段**的两种称法（蓝图字段说明「WBS：未来系统中的工卡类型，下拉选择」），系统中以单一字段存储，需求 8 的 IR 卡条件判断以该字段等于 04 为准。
9. IF TS_Engineer 在下拉字段中选择了取值集合以外的值, THEN THE Task_Card_Editor SHALL 拒绝该值并提示仅允许选择预定义取值。
10. THE Task_Card_System SHALL 将 Ctrl Code 与 Skill 视为两个**相互独立的值域**；对于同时出现于两者的代码（如 AS、CL），SHALL 按同码不同义处理，SHALL NOT 合并代码或共用字典。

### 需求 7：工卡编制自动带出与联动字段

**User Story:** 作为 TS工程师，我希望系统自动带出版本、日期、文档信息与操作人信息，以便减少重复录入并保证准确性。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡执行升版操作, THE Task_Card_Editor SHALL 将 Revision **默认**设置为原版本号加一，并允许 TS_Engineer 手动调整为其它版本号。
2. WHEN 新建工卡, THE Task_Card_Editor SHALL 将 Date 默认设置为当天日期，并允许 TS_Engineer 手动修改。
3. WHEN TS_Engineer 从 TPC_Database 选择一条文档记录, THE Task_Card_Editor SHALL 自动带出 Document Type、Ref No、Document Revision、Document Desc 字段值。
4. WHEN 工卡被保存, THE Task_Card_Editor SHALL 自动记录 Last Update（最后更新日期）与 Operator ID（操作人工号）。
5. IF TS_Engineer 手动调整后的 Revision 与该 Task No 下已存在的版本号重复, THEN THE Task_Card_System SHALL 拒绝该调整并提示版本号已存在（对应需求 38.6 的 (Task No, Revision) 唯一性约束）。

### 需求 8：IR 卡 BOM 字段

**User Story:** 作为 TS工程师，我希望在 IR 卡上录入基础件号与 IPC 项号，以便建立 BOM。

#### 验收标准 (Acceptance Criteria)

1. WHERE 工卡类型为 IR_Card, THE Task_Card_Editor SHALL 提供录入 Base Number（基础件号）字段。
2. WHERE 工卡类型为 IR_Card, THE Task_Card_Editor SHALL 提供录入 IPC 项号字段。
3. WHERE 工卡类型不为 IR_Card, THE Task_Card_Editor SHALL 不要求录入 Base Number 与 IPC 项号。

### 需求 9：参考文件管理

**User Story:** 作为 TS工程师，我希望管理工卡的参考文件，以便满足"Reference Document and Revision"要求。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 新增一条参考文件, THE Task_Card_Editor SHALL 记录该文件的文件类型、参考号、版本号、ATA 章节号。
2. WHEN TS_Engineer 删除一条参考文件, THE Task_Card_Editor SHALL 从当前工卡中移除该参考文件记录。
3. THE Task_Card_Editor SHALL 允许一张工卡关联多条参考文件。

### 需求 10：工序入口与编制流程控制

**User Story:** 作为 TS工程师，我希望在工卡编制界面管理工序并控制保存提交流程，以便保证编制的合规性与完整性。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_Editor SHALL 提供工序操作入口，包含新增插件、模板下载、模板导入、排序、全选、折叠/展开。
2. WHEN TS_Engineer 进入某条工序, THE Task_Card_System SHALL 打开工序编辑界面。
3. WHEN TS_Engineer 执行【保存】, THE Task_Card_Editor SHALL 保存当前工卡编制内容。
4. WHEN TS_Engineer 执行【提交】, THE Task_Card_Editor SHALL 先执行查重校验再提交工卡。
5. IF 查重校验发现存在重复工卡编号, THEN THE Task_Card_Editor SHALL 阻止提交并提示存在重复工卡。

### 需求 11：工序属性配置

**User Story:** 作为 TS工程师，我希望配置工序的属性，以便定义工序的执行要求与工时。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 新增工序, THE Process_Step_Editor SHALL 按固定规则自动生成 Process ID（工序编号）。
2. THE Process_Step_Editor SHALL 允许 TS_Engineer 维护工序的 Skill（技能要求）与 Ref Doc（参考文件）。
3. THE Process_Step_Editor SHALL 以只读方式展示由 PPC 维护的 Work Category（工作分类）与 Estimated ManHours（预计工时），且不允许 TS_Engineer 在本模块编辑（工时由 PPC 单独界面维护）。
4. THE Process_Step_Editor SHALL 以只读方式展示工卡执行过程中收集的 Effective Manhours（有效工时）与 Actual ManHours（实际工时），且不允许 TS_Engineer 编辑。

### 需求 12：工序步骤描述与数据采集

**User Story:** 作为 TS工程师，我希望编写双语工序描述并配置数据采集项，以便满足"Working steps & provision for recording"要求。

#### 验收标准 (Acceptance Criteria)

1. THE Process_Step_Editor SHALL 允许 TS_Engineer 编写中文与英文的工序步骤描述。
2. THE Process_Step_Editor SHALL 允许 TS_Engineer 配置任意数量的数据采集项，采集项类型可配置且与需求 13.1 的插入组件体系共用类型定义；P/N（部件号）与 S/N（序列号）为其中的常用类型示例，不构成固定的两项限制。
3. WHEN TS_Engineer 将某个数据采集项标记为必填, THE Process_Step_Editor SHALL 为该采集项记录必填标记并提供执行时的输入框。

### 需求 13：工序组件插入与维修草图

**User Story:** 作为 TS工程师，我希望在工序中插入多种功能组件并添加维修草图，以便配置电子工卡执行所需信息。

#### 验收标准 (Acceptance Criteria)

1. THE Process_Step_Editor SHALL 支持插入以下组件：测量值、表格、文本、设备/工具、图片、视频、音频、测量范围、耗材、时间、数据组、自定义选项、**签署栏（Signature Column）**。其中前 12 类为蓝图 2.3.4 明列组件；签署栏为承载用户需求 I.8「Column for Staff Signature, stamp and Date of Completion」所必需（详见需求 45）。
2. WHEN TS_Engineer 插入图片组件并上传维修草图, THE Process_Step_Editor SHALL 将该维修草图关联至当前工序。
3. WHEN TS_Engineer 插入设备/工具或耗材组件, THE Process_Step_Editor SHALL 记录对应的特殊工具/设备/耗材信息。

### 需求 14：工序模板复用

**User Story:** 作为 TS工程师，我希望调用工序模板，以便提升编制效率。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 调用某个工序模板, THE Process_Step_Editor SHALL 将模板内容填入当前工序。
2. THE Process_Step_Editor SHALL 允许 TS_Engineer 将当前工序保存为可复用模板。

### 需求 15：工序条码/二维码生成

**User Story:** 作为 TS工程师，我希望系统在工卡释放为 JOB 时为每个工序生成条码/二维码，以便支撑工具领用、报工与化学品领用，并确保条码可唯一定位到某次维修的某道工序。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡经工程释放生成 JOB, THE Task_Card_System SHALL 按固定逻辑为该 JOB 下的每道工序生成条码或二维码。
2. THE 生成的条码/二维码 SHALL 以 JOB No 与 Process ID 的组合作为唯一性约束。
3. THE Task_Card_System SHALL 不在工卡编制态（模板态）为工序生成条码，以避免同一工卡多次维修复用同一条码。
4. THE 生成的条码/二维码 SHALL 携带 JOB 上下文，可唯一定位到某次维修的某道工序。

### 需求 16：工卡类型与执行单据分类

**User Story:** 作为 TS工程师，我希望按标准分类维护工卡类型与执行单据类型，以便正确区分工卡用途。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 支持工卡类型分类，取值限定为编码 {01 收货检查工卡, 02 拆分卡, 03 预处理卡, 04 IR卡, 05 IR Lot卡, 06 组装/测试卡, 07 电线卡, 08 LRU Subcontract卡, 09 单独件维修卡, 10 AD/SB/SL卡, 11 客户特殊要求卡}。
2. THE Task_Card_System SHALL 支持执行过程单据类型，取值限定为 {CR, PC, LT, BH, TS, SC, NR, PR, EN, SW, TA}。
3. THE Task_Card_System SHALL 记录工卡分类信息并在工卡打印输出中不予展示。
4. THE Task_Card_System SHALL 为每个执行过程单据类型记录其签署要求属性；除 SC 外，CR、PC、LT、BH、TS、NR、PR、EN、SW、TA 的签署要求属性取值均为「签署」。
5. WHERE 执行过程单据类型为 SC（Subcontract Work Order）, THE Task_Card_System SHALL 记录该单据本身不签署、而其所发出的工卡步骤需要签署。

### 需求 17：工卡编制与迁移

**User Story:** 作为 TS工程师，我希望将现有文字格式工卡迁移到系统，以便保留历史工卡并延续原有命名规则。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 迁移一份现有文字格式工卡, THE Task_Card_System SHALL 保留该工卡原有的命名规则。
2. THE Task_Card_System SHALL 将迁移后的工卡以结构化工卡形式存储且可编辑。

### 需求 18：图文混编呈现

**User Story:** 作为 TS工程师，我希望工卡内容支持图文混编，以便工序细节与图片对应展示。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 支持在工序内容中混合展示文本与图片。
2. THE Task_Card_System SHALL 保持每个工序与其关联图片的对应关系。

### 需求 19：版本与变更记录

**User Story:** 作为 TS工程师，我希望工卡的删减与更改留存记录及原因，以便满足质量管理的可追溯要求。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡发生删减或更改, THE Task_Card_System SHALL 留存对应的变更记录。
2. WHEN TS_Engineer 提交工卡变更, THE Task_Card_System SHALL 要求填写变更原因备注。
3. THE Task_Card_System SHALL 允许查询某张工卡的历史版本与变更记录。

### 需求 20：批量字段/文本替换

**User Story:** 作为 TS工程师，我希望批量替换工卡中的某个字段或文本，以便高效维护多张工卡。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 对所选工卡执行批量替换某字段/文本, THE Task_Card_System SHALL 将所选工卡中匹配的字段/文本替换为目标值。
2. WHEN 批量替换完成, THE Task_Card_System SHALL 反馈受影响的工卡数量与替换结果。
3. THE Task_Card_System SHALL 仅允许对状态为"新增(New)"的工卡版本执行批量替换。
4. IF 所选工卡中包含状态为"审核中(UnderReview)"、"生效(Effective)"、"已被取代(Superseded)"或"作废(Void)"的版本, THEN THE Task_Card_System SHALL 拒绝对这些版本执行替换并在结果中逐条列出被拒绝的工卡及原因。
5. WHERE TS_Engineer 需要变更已生效工卡的内容, THE Task_Card_System SHALL 要求先对该工卡执行升版（见需求 38），并仅对升版产生的"新增"版本执行替换。
6. WHEN TS_Engineer 提交批量替换, THE Task_Card_System SHALL 要求填写替换原因（Replace Reason）。
7. IF 替换原因为空, THEN THE Task_Card_System SHALL 阻止该批量替换操作。
8. WHEN 批量替换执行成功, THE Task_Card_System SHALL 为**每一张**被修改的工卡各自写入一条变更记录（见需求 19），包含替换字段、替换前值、替换后值、替换原因、操作人与时间。
9. THE Task_Card_System SHALL 将批量替换作为**独立权限点**控制，仅授予该权限的用户可执行；具备编卡权限不自动获得批量替换权限。
10. THE Task_Card_System SHALL 以事务方式执行批量替换，任一工卡替换失败时整批回滚，不产生部分生效的结果。

### 需求 21：工卡关联

**User Story:** 作为 TS工程师，我希望将 Task Card 与附属工卡关联，以便确保项目闭环与信息可追溯。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 建立 Task_Card 与附属工卡（NRC、EN、SWS 等）的关联, THE Task_Card_System SHALL 记录并保持该关联关系。
2. THE Task_Card_System SHALL 允许从一张 Task_Card 查看其关联的附属工卡。
3. THE Task_Card_System SHALL 支持 Task_Card 与全部执行过程单据类型（CR、PC、LT、BH、TS、SC、NR、PR、EN、SW、TA）建立关联关系。
4. WHEN 执行过程中产生 Process Card、Condition Report、Technique Sheet 等关联单据, THE Task_Card_System SHALL 自动建立其与来源 Task_Card 的关联关系而无需人工关联。
5. WHEN 已关联单据的关键信息（机型、件号、序列号、工卡编号）发生变更, THE Task_Card_System SHALL 同步该变更至关联关系记录以保持信息一致。

### 需求 22：编审权限划分（一编一审）

**User Story:** 作为 TS经理，我希望编卡与审卡权限分离，以便满足一编一审的合规要求。

#### 验收标准 (Acceptance Criteria)

1. WHERE 用户具备编卡权限, THE Task_Card_System SHALL 允许该用户编制工卡。
2. WHERE 用户具备审卡权限, THE Task_Card_System SHALL 允许该用户审核工卡。
3. IF 某张工卡的审核人与其编制人为同一用户, THEN THE Task_Card_System SHALL 阻止该用户审核该工卡。

### 需求 23：SWS 复制功能

**User Story:** 作为 TS工程师，我希望复制 SWS，以便基于已有 SWS 快速创建新单。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 对某份 SWS 执行复制, THE Task_Card_System SHALL 生成一份内容一致的 SWS 副本作为新单据。
2. THE Task_Card_System SHALL 将 SWS 视为执行过程单据类型 SW（见需求 16.2）的实例，其复制 SHALL 沿用需求 38.1–38.3 的编号与初始状态规则：副本须指定不重复的新编号、状态置「新增(New)」、版本置初始版本。
3. 〔待澄清〕SWS 单据自身的**编制**功能归属（本模块 / LGS-TS-03-05 Supplementary Work Sheet 独立流程）尚未确定；本模块当前仅保证其复制（本需求）与关联（需求 21.3）能力，不含 SWS 的独立编制界面。

### 需求 24：对接工包系统发布

**User Story:** 作为 TS工程师，我希望将编制完成的工卡对接到工包系统，以便实现工卡自动生成与发布。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 提交一张已通过审核的工卡, THE Task_Card_System SHALL 将该工卡对接至 Work_Card_Package_System 用于工卡生成与发布。
2. IF 待发布工卡的状态不为"生效(Effective)", THEN THE Task_Card_System SHALL 阻止发布并提示工卡尚未生效。
3. THE Task_Card_System SHALL 记录工卡发布至 Work_Card_Package_System 的结果。

### 需求 25：集成数据来源

**User Story:** 作为 TS工程师，我希望系统从上游系统获取所需数据，以便减少人工录入并保证数据一致。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡编制需要文档元数据, THE Task_Card_System SHALL 从 TPC_Database 获取文件类型、参考号、文件版本与文件描述。
2. WHEN 工序需要工作分类与预计工时, THE Task_Card_System SHALL 从 PPC 维护的数据获取 Work Category 与 Estimated ManHours。
3. WHERE 工卡在某个 PID 下选用, THE Task_Card_System SHALL 依据 PID 关联的机型、客户与工作范围及 ISO 要求提供可选工卡范围。

### 需求 26：工卡执行相关字段自动带出（只读）

**User Story:** 作为 TS工程师，我希望工卡编制界面按蓝图展示工卡执行相关字段并由系统自动带出，以便工卡进入执行阶段后可追溯执行上下文而无需人工录入。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_Editor SHALL 提供以下工卡执行相关字段并以只读方式展示：OWNER（所有者）、JOB TARGET DATE（工作完成预定日期）、Check（检查类型）、INBOUND GEAR P/N（进厂起落架部件号）、S/N（序列号）、CSNo.（工卡控制序号）、WORK ORDER（工作指令）、OUTBOUND GEAR P/N（出厂起落架部件号）。
2. WHERE 工卡以编制态（模板视图）打开且不含 JOB 实例上下文, THE Task_Card_Editor SHALL 不呈现上述执行相关字段栏位，以避免出现永久空白栏位。
3. WHERE 工卡通过 JOB 实例上下文查看, THE Task_Card_Editor SHALL 呈现上述执行相关字段并带出该 JOB 的实际值。
4. WHEN JOB TARGET DATE 需要取值, THE Task_Card_System SHALL 依据 PPC 排产结果自动带出该值。
5. THE Task_Card_Editor SHALL 不允许 TS_Engineer 手动编辑上述执行相关字段。

### 需求 27：Process Card 关联字段带出（只读）

**User Story:** 作为 TS工程师，我希望工卡编制界面按蓝图展示 Process Card 相关字段并基于 Process Data 带出，以便零件相关信息与工序数据保持一致。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_Editor SHALL 提供以下 Process Card 相关字段并以只读方式展示：PART No（零件号）、PART S/N（序列号）、PART DES.（零件描述）、Operation Type（操作类型）。
2. WHEN Process Card 相关字段需要取值, THE Task_Card_System SHALL 基于 Process Data 自动带出上述字段值。
3. THE Task_Card_Editor SHALL 不允许 TS_Engineer 手动编辑上述 Process Card 相关字段。
4. WHERE 工卡以编制态（模板视图）打开且不含 JOB 实例上下文, THE Task_Card_Editor SHALL 不呈现上述 Process Card 相关字段栏位，以避免出现永久空白栏位（与需求 26.2 同一处置）。
5. WHERE 工卡通过 JOB 实例上下文查看, THE Task_Card_Editor SHALL 呈现上述字段并带出该 JOB 的实际值；上述字段 SHALL 存于执行域（JOB 实例）而非编制域（Task_Card），以满足需求 37.5 的两域分离要求。

### 需求 28：编制与审核角色字段及文档章节字段

**User Story:** 作为 TS工程师，我希望在工卡上记录编写人、NDT 审核人、ATA 章节号与检查类型，以便满足蓝图的基础信息录入要求与质量可追溯。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_Editor SHALL 提供录入并展示编写人（Created By）字段，并在保存工卡时自动记录当前编制人。
2. THE Task_Card_Editor SHALL 提供录入 NDT 审核人（NDT Reviewer）角色字段。
3. THE Task_Card_Editor SHALL 提供录入 ATA 章节号字段。
4. THE Task_Card_Editor SHALL 提供录入检查类型（Check Type）字段。〔待澄清〕本字段（编制态标注的工卡适用检查类型）与需求 26.1 的 Check（由 PID 带出的本次维修检查类型）是否为同一业务概念尚未确认；当前按两个独立字段处理，编制域字段仅用于工卡适用性标注。

### 需求 29：商务要求执行工卡分类

**User Story:** 作为 TS工程师，我希望系统按已裁定的判定依据派生并持久化商务执行工卡分类，以便与商务（CMC）确认的执行范围保持一致、完整展示候选证据并避免覆盖当前权威值。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 支持商务执行工卡分类，取值限定为 {Gear Inspection, Routine, Material Special Replacement, SB/AD/SL, NRC, LLP, Configuration(MOD), Outsource, Dummy Job}；Outsource SHALL 同时选择二级类型 {L sub, 工序外委}。
2. THE Task_Card_System SHALL 依据运行时 `derivation_priority_config` 的 `tier_order` 与 `enabled` 评估全部启用层级并汇总全部命中候选；业务方于 **2026-08-10 已裁定**的默认顺序为 P1→P6：P1 计划设置→Dummy Job；P2 实际发起单据→NRC；P3 实际外包清单→Outsource；P4 零件性质→LLP；P5 工包划分→Routine / Material Special Replacement / Configuration(MOD)；P6 工卡类型映射→需求 43.2 的兜底分类。系统 SHALL 以候选首次命中的运行时层级顺序排序；P6 启用时 SHALL 与 P1–P5 事实候选并存且不得覆盖事实来源，显式停用时 SHALL 不参与；类型 11 特例不受该配置影响。
3. WHERE 工卡类型为 11（客户特殊要求卡）, THE Task_Card_System SHALL 不评估 P1–P5 且固定返回 Material Special Replacement 与 Configuration(MOD) 两个候选，`recommendedClassification` SHALL 为 `null`，并要求 TS_Engineer 确认其一后方可提交审核。
4. WHEN 全部命中仅聚合为一个不同分类候选, THE Task_Card_System SHALL 自动派生该分类并允许继续提交审核；WHEN 聚合为多个不同分类候选, THE Task_Card_System SHALL 将状态持久化为 `requires_confirmation`、以优先顺序中的首个候选作为推荐（类型 11 除外）并阻止提交审核直至确认。
5. THE Task_Card_System SHALL 对同一分类的重复命中聚合为一个候选，并在候选中保留首次命中层级以及全部 `sources`；每条 source SHALL 包含 `hitTier`、`sourceRef` 与 `outsourceSubtype`。
6. WHEN TS_Engineer 确认候选, THE Task_Card_System SHALL 要求提交当前待确认结果的 `derivationResultId` 与完整候选选择；WHERE 分类为 Outsource, 请求 SHALL 同时包含属于该候选的 `outsourceSubtype`。过期结果、非候选分类或 subtype 不匹配 SHALL 被拒绝。
7. THE Task_Card_System SHALL 以追加式记录持久化每次派生/确认的 `resultId`、`status`、候选、推荐值、命中证据、确认人与确认时间，并提供最新结果及完整历史查询。
8. THE `task_card.commercial_classification` 与 `task_card.outsource_subtype` SHALL 为当前权威值；`requires_confirmation` 或 `undetermined` 派生结果 SHALL NOT 清空既有权威值，只有 `derived` 或 `confirmed` 结果方可同步更新权威值。
9. WHEN 打开已有工卡或分类确认界面, THE Task_Card_System SHALL 依据最新持久化 `status` 恢复待确认状态，不得仅凭工卡类型或当前分类值推断；确认界面 SHALL 优先使用传入或最新的 pending 结果，仅在没有 pending 结果时重新派生。
10. WHERE 派生结果由 TS_Engineer 确认, THE Task_Card_System SHALL 标记该结果为「人工确认」并记录确认人与确认时间；IF 人工指定了取值集合以外的值, THEN SHALL 拒绝该值。
11. THE Task_Card_System SHALL 允许业务方维护 P1–P6 层级配置而无需修改程序代码；该配置用于启停与证据排序，不改变本需求已裁定的类型 11 特例。

### 需求 30：工序 Operation 字段带出（只读）

**User Story:** 作为 TS工程师，我希望工序展示由 Process Data 带出的 Operation（操作）字段，以便工序与工艺数据保持一致。

#### 验收标准 (Acceptance Criteria)

1. THE Process_Step_Editor SHALL 展示由 Process Data 带出的 Operation（操作）字段。
2. THE Process_Step_Editor SHALL 不允许 TS_Engineer 手动编辑该 Operation 字段。

### 需求 31：E-work card 安全警示与视觉提示（TS-01）

**User Story:** 作为 TS工程师，我希望对关键维修任务和易误操作任务在电子工卡（E-work card）上添加安全警示、视觉提示或维修技巧，并要求操作人员执行前查看，以便降低误操作风险、提升执行端理解效率。

#### 验收标准 (Acceptance Criteria)

1. THE Process_Step_Editor SHALL 允许 TS_Engineer 为工序添加安全警示（Safety Warning）内容。
2. THE Process_Step_Editor SHALL 允许 TS_Engineer 为工序添加视觉提示（Visual Cue），且支持以图片或视频形式承载。
3. THE Process_Step_Editor SHALL 允许 TS_Engineer 为工序添加维修技巧（Repair Tips）内容。
4. THE Process_Step_Editor SHALL 允许 TS_Engineer 将工序标记为关键维修任务或易误操作任务。
5. WHERE 工序被标记为关键维修任务或易误操作任务, THE Task_Card_System SHALL 要求操作人员在执行该工序前查看其安全警示、视觉提示与维修技巧内容。
6. IF 操作人员未确认查看被标记工序的安全警示内容, THEN THE Task_Card_System SHALL 阻止该工序进入执行状态。
7. THE Task_Card_System SHALL 记录操作人员对安全警示内容的查看确认结果，包含确认人与确认时间。

### 需求 32：电子签章与无纸化执行

**User Story:** 作为 TS工程师，我希望编制完成的工卡支持线上电子化执行并通过电子签章认证，以便实现全流程无纸化。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 支持已生效工卡以线上电子化方式提供执行。
2. THE Task_Card_System SHALL 为工卡签署栏提供电子签章（Electronic Signature/Stamp）认证能力。
3. WHEN 工卡签署栏通过电子签章认证完成签署, THE Task_Card_System SHALL 记录签署人、签章标识与完成日期。
4. WHERE 工卡全部必需签署项均已通过电子签章认证, THE Task_Card_System SHALL 支持该工卡以无纸化形式归档而无需纸质签署件。

### 需求 33：工卡与工序起止时间（对应用户需求 I.10）

**User Story:** 作为 TS工程师，我希望工卡与工序记录开始时间与结束时间，以便满足工作指令最小信息集 I.10「the start time and finish time of the work card」的适航要求并支撑工时核算。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 为工卡提供 Start Time（开始时间）与 Finish Time（结束时间）字段；该两字段 SHALL 由 **JOB 实例（执行域）** 承载，SHALL NOT 存于 Task_Card（编制域），以满足需求 37.5 的两域分离要求。同一 Task_Card 多次释放时，各 JOB 分别记录其自身的起止时间。
2. THE Task_Card_System SHALL 为每道工序提供 Start Time（开始时间）与 Finish Time（结束时间）字段；该两字段 SHALL 由 JOB 工序实例承载，SHALL NOT 存于编制域工序模板。
3. WHEN 工序在执行阶段被首次报工开始, THE Task_Card_System SHALL 自动记录该工序的开始时间。
4. WHEN 工序在执行阶段被报工完成, THE Task_Card_System SHALL 自动记录该工序的结束时间。
5. WHEN 某 JOB 下首道工序开始, THE Task_Card_System SHALL 将该时间记录为该 JOB 的工卡开始时间。
6. WHEN 某 JOB 下全部工序均已完成, THE Task_Card_System SHALL 将最晚工序结束时间记录为该 JOB 的工卡结束时间；WHERE 尚有工序未完成, THE Task_Card_System SHALL NOT 记录工卡结束时间。
7. THE Task_Card_System SHALL 在 JOB 上下文中以只读方式展示工卡与工序的开始时间与结束时间，且不允许任何角色手动编辑；WHERE 工卡以编制态（无 JOB 上下文）打开, THE Task_Card_Editor SHALL 不呈现该栏位（与需求 26.2 同一处置）。
8. IF 工卡或工序同时存在开始时间与结束时间, THEN THE Task_Card_System SHALL 保证结束时间不早于开始时间。
9. THE 打印输出 SHALL 包含工卡的计划工时、实际工时、开始时间与结束时间栏（对应需求 5.3 的「工时与起止时间栏」）。

### 需求 34：工卡审核流程与状态流转

**User Story:** 作为 TS经理，我希望工卡编制完成后经提交审核、批准或驳回的完整流程后才能生效，以便满足蓝图工作分解步骤 60 与一编一审的局方合规要求。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 对状态为"新增(New)"的工卡执行【提交审核】, THE Task_Card_System SHALL 依次执行以下完整校验集合，全部通过后方将工卡状态置为"审核中(UnderReview)"：
   - (a) 工卡编号查重校验（同版本号下 Task No 不重复，见需求 10.5、38.6）；
   - (b) 枚举字段取值合法性校验（见需求 6.9）；
   - (c) 必填字段完整性校验（工作指令最小信息集所需字段）；
   - (d) 能力清单范围校验（机型/起落架类型/Skill 组合，见需求 39.2）；
   - (e) 变更原因填报校验（升版或变更提交时，见需求 19.2）；
   - (f) 签署项配置校验（签署要求属性为「签署」的单据须至少配置一个签署项，见需求 45.8、45.9）；
   - (g) Stage 与工卡类型组合合法性校验（见需求 46.10、46.11）；
   - (h) 商务分类持久状态校验（见需求 29.3、29.4、29.8、29.9）：最新结果为 `requires_confirmation`，或类型 11 尚无已确认权威分类时阻止提交；单候选 `derived` 结果已同步权威值时允许继续提交。
2. IF 上述任一校验未通过, THEN THE Task_Card_System SHALL 阻止提交审核、保持工卡状态为"新增(New)"并提示未通过的具体校验项。
3. WHERE 工卡状态为"审核中(UnderReview)", THE Task_Card_System SHALL 阻止对该工卡内容的编辑（该约束为需求 49.1「仅新增态可编辑」的一个特例，统一按需求 49 执行）。
4. WHEN 具备审卡权限的用户对状态为"审核中"的工卡执行批准, THE Task_Card_System SHALL 将工卡状态置为"生效(Effective)"并记录审核人与批准时间。
5. WHEN 具备审卡权限的用户对状态为"审核中"的工卡执行驳回, THE Task_Card_System SHALL 将工卡状态置回"新增(New)"以便编制人重新编辑。
6. WHEN 审核人执行批准或驳回, THE Task_Card_System SHALL 要求填写审核意见（Review Comment）。
7. IF 审核意见为空, THEN THE Task_Card_System SHALL 阻止该批准或驳回操作。
8. THE Task_Card_System SHALL 按工卡版本留存审核记录，包含审核人、审核动作（批准/驳回）、审核意见与审核时间。
9. THE Task_Card_System SHALL 允许查询某张工卡各版本的审核记录。
10. IF 工卡状态不为"审核中(UnderReview)", THEN THE Task_Card_System SHALL 阻止对其执行批准或驳回操作。
11. WHEN 工卡经升版产生新版本, THE Task_Card_System SHALL 要求该新版本重新经过完整审核流程，不继承上一版本的审核结果。

### 需求 35：组织名称（对应用户需求 I.1）

**User Story:** 作为 TS工程师，我希望工卡承载组织名称，以便满足工作指令最小信息集 I.1「Name of the Organization」要求。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 通过系统参数配置维护组织名称（Organization Name）。
2. WHEN 生成工卡抬头或打印输出, THE Task_Card_System SHALL 从系统参数配置取得组织名称并呈现于工卡抬头。
3. THE Task_Card_Editor SHALL 以只读方式展示当前组织名称，且不允许 TS_Engineer 在工卡上单独修改。

### 需求 36：是否 FAI 与模板类型字段维护

**User Story:** 作为 TS工程师，我希望维护工卡的是否 FAI 标记与模板类型，以便清单列表能据此展示并支撑业务筛选。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_Editor SHALL 提供维护是否 FAI（First Article Inspection flag）标记的能力，取值为 是/否。
2. THE Task_Card_Editor SHALL 提供维护模板类型（Template Type）字段的能力。
3. WHEN 工卡被创建且未指定是否 FAI, THE Task_Card_System SHALL 将该标记默认置为"否"。
4. THE Task_Card_List SHALL 展示由需求 36.1 与 36.2 维护的是否 FAI 与模板类型字段值（对应需求 2.1）。

### 需求 37：JOB No 生成与承载关系

**User Story:** 作为 TS工程师，我希望工卡经工程释放后生成 JOB No 并承载执行期数据，以便明确编制域（模板）与执行域（实例）的边界与追溯链。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡经工程释放至工包, THE Task_Card_System SHALL 为该次释放生成唯一的 JOB No（对应蓝图 2.3.6「JOB No 工程释放后生成」）。
2. THE Task_Card_System SHALL 保持 JOB No 与其来源 Task_Card 及所属 PID 的关联关系。
3. THE Task_Card_System SHALL 将同一张 Task_Card 的多次释放生成为各自独立的 JOB No。
4. THE Task_Card_System SHALL 在 JOB No 下承载执行期数据，包含需求 26 的执行相关字段、需求 33 的起止时间与需求 15 的工序条码。
5. THE Task_Card_System SHALL 保持 Task_Card（编制域模板）内容与 JOB（执行域实例）数据相互独立，JOB 执行数据的产生不修改来源 Task_Card 的编制内容。

### 需求 38：复制与升版的编号及初始状态规则

**User Story:** 作为 TS工程师，我希望复制与升版产生的工卡有明确的编号与初始状态规则，以便不与工卡编号查重规则冲突。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 复制一张工卡, THE Task_Card_System SHALL 要求为副本指定新的且不与现有工卡重复的 Task No。
2. IF 复制时指定的 Task No 与现有工卡重复, THEN THE Task_Card_System SHALL 阻止该复制操作并提示编号重复。
3. WHEN 复制操作完成, THE Task_Card_System SHALL 将副本的工卡状态置为"新增(New)"、版本号置为初始版本。
4. WHEN TS_Engineer 对工卡执行升版, THE Task_Card_System SHALL 保持新版本的 Task No 与原工卡一致且不允许修改。
5. WHEN 升版操作完成, THE Task_Card_System SHALL 将新版本的工卡状态置为"新增(New)"并将版本号置为原版本号加一。
6. THE Task_Card_System SHALL 以 Task No 与版本号的组合作为工卡的唯一性约束；需求 10.5 的提交查重 SHALL 仅针对相同版本号下的重复 Task No 进行拦截。
7. WHERE 同一 Task No 存在多个版本, THE Task_Card_System SHALL 保证最多只有一个版本处于"生效(Effective)"状态。
8. WHEN TS_Engineer 批量复制多张工卡, THE Task_Card_System SHALL 依据可配置的编号生成规则（前缀、后缀、起始序号与步长）为每张副本自动生成不重复的 Task No，而不要求逐张人工指定。
9. WHEN 批量复制自动生成的 Task No 与现有工卡重复, THE Task_Card_System SHALL 自动跳至下一可用序号直至不重复。
10. THE Task_Card_System SHALL 允许 TS_Engineer 在批量复制完成后逐张调整副本的 Task No，调整时仍执行不重复校验。

### 需求 39：QA 能力清单约束

**User Story:** 作为 TS工程师，我希望工卡编制受 QA 维护的能力清单约束，以便确保所编制工卡处于本厂经批准的能力范围内。

#### 验收标准 (Acceptance Criteria)

1. WHEN 工卡编制需要能力数据, THE Task_Card_System SHALL 从 QA 维护的 Capability_List（能力清单）获取当前有效的能力范围。
2. WHEN TS_Engineer 提交工卡审核, THE Task_Card_System SHALL 校验该工卡的机型、起落架类型与专业（Skill）组合是否处于能力清单范围内。
3. IF 工卡的机型、起落架类型与专业组合不在能力清单范围内, THEN THE Task_Card_System SHALL 阻止提交并提示超出已批准能力范围。
4. THE Task_Card_System SHALL 依据能力清单的**当前有效版本**执行上述校验。当前有效版本的判定规则为：在生效期间覆盖校验当日的记录中（`effective_from ≤ 校验日` 且 `effective_to ≥ 校验日`，`effective_to` 为空视为长期有效）取版本号（revision）最大者。

### 需求 40：按类型配置打印模板

**User Story:** 作为 TS工程师，我希望按工卡类型与执行单据类型配置各自的打印模板，以便保证现有 LGS 各类纸质格式的业务运转。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 支持为工卡类型（01–11）分别配置打印模板。
2. THE Task_Card_System SHALL 支持为执行过程单据类型（CR、PC、LT、BH、TS、SC、NR、PR、EN、SW、TA）分别配置打印模板。
3. WHEN TS_Engineer 对某张工卡执行打印, THE Task_Card_System SHALL 依据该工卡的类型选用对应的打印模板。
4. WHERE 某类型未配置专属打印模板, THE Task_Card_System SHALL 采用默认打印模板并保证需求 5.3 的最小信息集字段完整呈现。
5. THE 各类型打印模板 SHALL 均遵守需求 5.2「打印输出不展示工卡分类」的约束。

### 需求 41：现有文字格式工卡迁移方案

**User Story:** 作为 TS工程师，我希望以批量方式将现有文字格式工卡迁移入系统，以便在可控成本内完成存量工卡的数字化。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 支持批量迁移现有文字格式工卡。
2. THE Task_Card_System SHALL 支持以 Word（.doc/.docx）、RTF、Excel 与结构化文本作为迁移源格式；WHERE 存量工卡以 Word 文档为主, THE Task_Card_System SHALL 以 Word/RTF 作为主要迁移通道。
3. WHEN 执行迁移, THE Task_Card_System SHALL 对每条记录校验必填字段与枚举取值合法性。
4. IF 某条迁移记录校验失败, THEN THE Task_Card_System SHALL 跳过该条记录、继续处理其余记录，并在迁移结果中记录该条的失败原因。
5. WHEN 迁移完成, THE Task_Card_System SHALL 输出迁移结果报告，包含成功条数、失败条数与各条失败原因。
6. WHEN 迁移成功, THE Task_Card_System SHALL 将迁移后的工卡状态置为"新增(New)"并保留其原有命名规则（对应需求 17.1）。

### 需求 42：工卡作废前置校验

**User Story:** 作为 TS工程师，我希望作废工卡前系统校验其引用情况，以便避免影响历史工包与在执行的 JOB。

#### 验收标准 (Acceptance Criteria)

1. WHEN TS_Engineer 对工卡执行作废, THE Task_Card_System SHALL 校验该工卡是否存在以下任一引用：(a) 处于执行中的关联 JOB；(b) 已生成但尚未开始执行的关联 JOB；(c) 在编（尚未释放）工包中已选入该工卡的引用。
2. IF 存在需求 42.1 所列任一引用, THEN THE Task_Card_System SHALL 阻止作废并提示具体的引用类型与引用位置，以避免计划端持有悬空的待执行 JOB。
3. WHERE 工卡已被历史工包引用, THE Task_Card_System SHALL 允许作废该工卡，且 SHALL 保持历史工包中已引用的工卡版本记录不变。
4. WHEN 工卡被作废, THE Task_Card_System SHALL 使该工卡不再可被新工包选用。
5. WHEN 工卡被作废, THE Task_Card_System SHALL 要求填写作废原因并留存至变更记录（对应需求 19）。

### 需求 43：工卡类型与商务分类映射

**User Story:** 作为 TS工程师，我希望系统维护工卡类型与商务执行工卡分类之间的映射关系，以便支撑需求 29 的候选聚合与 P6 兜底。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 维护工卡类型（01–11）与商务执行工卡分类之间的映射关系。
2. THE 映射关系 SHALL 至少包含以下条目：01→Gear Inspection、Routine；02–09→Routine；10→SB/AD/SL；11→Material Special Replacement、Configuration(MOD)。
3. WHERE 工卡类型不为 11, THE 映射关系 SHALL 作为需求 29.2 的 P6 候选来源参与全量聚合，并不得覆盖或丢失 P1–P5 的候选与证据。
4. WHERE 工卡类型为 11, THE Task_Card_System SHALL 按需求 29.3 固定返回两个候选、忽略 P1–P5 且不显示推荐；该行为已于 2026-08-10 裁定，不再作为待澄清项。
5. WHERE 映射产生多个不同候选（如类型 01）, THE Task_Card_System SHALL 按需求 29.4–29.6 持久化待确认状态、展示全部来源并以完整候选对象确认。
6. THE Task_Card_System SHALL 允许业务方维护该映射关系而无需修改程序代码；任何映射值仍受商务分类封闭值域约束。

### 需求 44：版本取代与单一生效版本保障

**User Story:** 作为 TS经理，我希望新版本工卡批准生效时原生效版本自动退出生效态并标记为已被取代，以便在不误用"作废"语义的前提下保证同一工卡编号下始终只有一个生效版本。

#### 验收标准 (Acceptance Criteria)

1. WHEN 某工卡的新版本经审核批准置为"生效(Effective)", THE Task_Card_System SHALL 在同一事务内将该 Task No 下原处于"生效(Effective)"的版本自动迁移至"已被取代(Superseded)"。
2. THE Task_Card_System SHALL 在执行上述自动迁移时记录取代关系，包含被取代版本号、取代版本号与取代时间。
3. THE Task_Card_System SHALL 不要求为版本取代填报作废原因，且 SHALL NOT 将版本取代计入需求 42 的作废流程。
4. WHERE 工卡版本处于"已被取代(Superseded)", THE Task_Card_System SHALL 保留其完整内容与历史记录供查询与追溯，且不允许对其编辑。
5. WHERE 工卡版本处于"已被取代(Superseded)", THE Task_Card_System SHALL 使该版本不再可被新工包选用。
6. THE Task_Card_System SHALL 保持历史工包中已引用的被取代版本记录不变（适航记录完整性要求）。
7. THE Task_Card_System SHALL 保证在任一时刻，同一 Task No 下处于"生效(Effective)"状态的版本数不超过 1（对应需求 38.7）。
8. IF 版本取代的自动迁移失败, THEN THE Task_Card_System SHALL 回滚该次批准操作，使新版本不进入"生效"状态。

### 需求 45：工序级签署要求配置（对应用户需求 I.8）

**User Story:** 作为 TS工程师，我希望在编制阶段为工序配置签署要求（签署角色、是否盖章、是否记录完成日期），以便满足 I.8「Column for Staff Signature, stamp and Date of Completion」并为需求 32.4 的「必需签署项」提供确定来源。

#### 验收标准 (Acceptance Criteria)

1. THE Process_Step_Editor SHALL 允许 TS_Engineer 为工序配置是否需要签署。
2. WHERE 工序需要签署, THE Process_Step_Editor SHALL 允许 TS_Engineer 指定签署角色，取值限定为 {执行人(Operator), QC 检验(QC), NDT 检验(NDT), 授权放行人(Certifying Staff)}〔角色集合为 Hotfix 假定，见《临时设计说明》待澄清项 A3〕。
3. THE Process_Step_Editor SHALL 允许为同一工序配置多个签署角色，形成多签署项。
4. THE Process_Step_Editor SHALL 允许为每个签署项配置是否需要盖章（Stamp Required）。
5. THE Process_Step_Editor SHALL 为每个签署项默认要求记录完成日期（Date of Completion）。
6. THE Task_Card_System SHALL 将工卡下全部工序所配置的签署项集合作为需求 32.4「必需签署项」的**唯一来源**。
7. WHEN 工卡被打印, THE Task_Card_System SHALL 依据签署项配置在对应工序下呈现签署栏（含签署人、签章、完成日期栏位）。
8. WHERE 执行过程单据类型的签署要求属性为「签署」（见需求 16.4）, THE Task_Card_System SHALL 要求该单据至少配置一个签署项。
9. IF 工卡存在需求 16.4 要求签署但未配置任何签署项的单据, THEN THE Task_Card_System SHALL 在提交审核时阻止并提示缺失签署项配置。

### 需求 46：Stage 语义与维度关系

**User Story:** 作为 TS工程师，我希望明确 Stage 与工卡类型、工卡状态三者的维度关系，以便工包组包（Load Standard Package 依 Stage=RTN 取卡）取数口径准确。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 将 Stage（工卡阶段）与工卡类型（01–11）视为**存在强约束关系**的两个字段（约束规则见需求 46.9–46.13），并将工卡状态（生命周期）视为**与前两者相互独立**的维度；三者分别独立存储，工卡状态不由 Stage 或工卡类型派生。
2. THE Task_Card_System SHALL 以 Stage 表示工卡的**用途/阶段归属**（例行、特殊、改装、客户要求等），用于工包组包筛选。
3. WHEN 工包执行 Load Standard Package, THE Task_Card_System SHALL 依 TPC、A/C Type、Gear Type 与 Stage=RTN 且工卡状态为"生效(Effective)"的条件取卡（对应蓝图 2.3.6）。
4. THE Task_Card_System SHALL 将 Stage=WFD（Task card which is wait for delete）视为**待删除标记**，其语义为「已标记待删除但尚未执行作废」，SHALL NOT 等同于工卡状态"作废(Void)"〔WFD 与作废的联动关系为 Hotfix 假定，见《临时设计说明》待澄清项 A4〕。〔另一待澄清项〕WFD 在语义上属「状态标记」而非「用途阶段」，当前依蓝图 Stage 值域保留为 Stage 的一个取值；若业务方裁定改为独立标记位（Pending Delete Flag），则需求 46.5、46.6、46.12、46.13 随之调整。
5. WHERE 工卡 Stage 为 WFD, THE Task_Card_System SHALL 将该工卡从 Load Standard Package 的取卡结果中排除，即使其状态仍为"生效(Effective)"。
6. WHERE 工卡 Stage 为 WFD, THE Task_Card_System SHALL 在工卡清单中以显著标识提示该工卡待删除，并允许按 Stage=WFD 筛选以便批量处置。
7. THE Task_Card_System SHALL NOT 依据 Stage=WFD 自动将工卡状态迁移为"作废(Void)"；作废 SHALL 仍需经需求 42 的作废流程与前置校验。
8. THE Task_Card_System SHALL 记录 Stage 与商务执行工卡分类为独立字段，SHALL NOT 由 Stage 自动派生商务分类（商务分类派生依需求 29.2）。
9. THE Task_Card_System SHALL 维护 Stage 与工卡类型的**允许组合约束表**，并按下列默认约束校验〔具体映射为 Hotfix 假定，依蓝图「工卡类型区分」表说明列推导，见《临时设计说明》待澄清项 A4〕：
   - 工卡类型 01–09（说明列为 Routine）→ 允许 Stage = {RTN}
   - 工卡类型 10（AD/SB/SL 卡，说明列为 SB/AD/SL）→ 允许 Stage = {SPC}
   - 工卡类型 11（客户特殊要求卡，说明列含 EO/ER 与 Configuration(MOD)）→ 允许 Stage = {CUS, MOD}
10. WHEN TS_Engineer 保存或提交审核工卡, THE Task_Card_System SHALL 校验其 Stage 与工卡类型的组合是否属于约束表的允许组合。
11. IF Stage 与工卡类型的组合不属于允许组合, THEN THE Task_Card_System SHALL 阻止保存或提交并提示该工卡类型允许的 Stage 取值范围。
12. WHERE 工卡类型仅对应单一允许 Stage（如 01–09 对应 RTN、10 对应 SPC）, THE Task_Card_Editor SHALL 在选定工卡类型后将该 Stage 自动填入为**默认值**，并 SHALL 允许 TS_Engineer 在「该类型的允许组合 ∪ 需求 46.13 的横切取值」范围内改选；THE Task_Card_Editor SHALL NOT 将 Stage 字段置为只读。〔原 Hotfix 假定为「自动填入并置只读」，因与 46.5、46.6、46.13 互斥——只读将使 WFD 等横切取值对工卡类型 01–10 永久不可标记，需求 46.5 的 WFD 排除逻辑亦随之失效——故修正为「默认值 + 可改选」〕
13. THE Task_Card_System SHALL 将 Stage = {DMY, NRC, WCC, WFD} 视为**不受工卡类型约束的横切取值**：DMY 由计划设置、NRC 对应执行期衍生单据、WCC 为保修索赔、WFD 为待删除标记；上述取值 SHALL 可与任意工卡类型共存且不触发需求 46.11 的阻止〔横切取值集合为 Hotfix 假定，见《临时设计说明》A4〕。
14. THE Task_Card_System SHALL 允许业务方维护该约束表而无需修改程序代码。

### 需求 47：跨部门角色与权限边界（蓝图 2.1.1 TS-01）

**User Story:** 作为 TS经理，我希望明确 TS、Planning(PPC)、Production、QA 各角色在本模块的权限边界，以便满足 TS-01 所列跨部门协作要求并避免越权写入。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 定义以下角色：TS 工程师（TS_Engineer）、TS 经理（TS_Manager）、NDT 审核人（NDT_Reviewer）、计划工程师（Planning_Engineer）、计划经理（Planning_Manager）、生产技师（Production_Technician）、生产经理（Production_Manager）、QA 工程师（QA_Engineer）。
2. THE Task_Card_System SHALL 授予 TS_Engineer 工卡编制（新增/编辑/复制/升版/提交审核）权限，且 SHALL NOT 授予其审核批准权限。
3. THE Task_Card_System SHALL 授予 TS_Manager 工卡审核批准与驳回权限（受需求 22.3 一编一审约束）。
4. THE Task_Card_System SHALL 授予 Planning_Engineer 与 Planning_Manager 对工序 Work Category 与 Estimated ManHours 的**写入**权限，该写入 SHALL 通过 PPC 专属维护界面进行，SHALL NOT 通过本模块的工卡编制界面进行。
5. THE Task_Card_System SHALL 对 TS 角色将 Work Category 与 Estimated ManHours 置为只读（对应需求 11.3）。
6. THE Task_Card_System SHALL 授予 Planning_Engineer 与 Planning_Manager 工卡清单与工卡详情的**只读**查询权限。
7. THE Task_Card_System SHALL 授予 Production_Technician 与 Production_Manager 对已释放 JOB 的执行数据（起止时间、有效/实际工时、采集项、签署、安全警示确认）写入权限，且 SHALL NOT 授予其修改编制域工卡内容的权限。
8. THE Task_Card_System SHALL 授予 QA_Engineer 能力清单（Capability_List）的维护权限，且 SHALL NOT 授予其工卡编制或审核权限。
9. THE Task_Card_System SHALL 将批量替换（需求 20.9）作为独立权限点，与上述角色权限分离授予。
10. IF 任一角色尝试执行超出其权限边界的操作, THEN THE Task_Card_System SHALL 拒绝该操作并记录越权尝试。

### 需求 48：IR Lot 卡与 Lot List 关联及 BOM Base 输出（蓝图 2.3.6 BOM List）

**User Story:** 作为 TS工程师，我希望 IR Lot 卡（05）能关联 Lot List 并将其 Base Number 输出至 BOM List，以便形成完整的单脚 BOM，支撑后续零件跟踪与构型管理。

#### 验收标准 (Acceptance Criteria)

1. WHERE 工卡类型为 05（IR Lot 卡）, THE Task_Card_Editor SHALL 允许 TS_Engineer 关联一个或多个 Lot List（对应执行单据类型 LT）。
2. THE Task_Card_System SHALL 为每条 Lot List 关联记录其 Lot Number。
3. THE Task_Card_System SHALL 从所关联的 Lot List 带出其包含的 Base Number 集合。
4. WHEN 工包生成 BOM List, THE Task_Card_System SHALL 输出以下来源的 Base Number：(a) 工卡类型 04（IR 卡）在需求 8.1 维护的 Base Number；(b) 工卡类型 05（IR Lot 卡）经需求 48.3 从 Lot List 带出的 Base Number。
5. THE Task_Card_System SHALL 在 BOM List 输出中同时携带 Task Card No、Task Title、Base Number 与 Lot Number（对应蓝图 BOM List 字段）。
6. WHERE Base Number 来源为 Lot List, THE Task_Card_System SHALL 在 BOM List 中标识其 Lot Number 以区别于 IR 卡直接维护的 Base Number。
7. THE Task_Card_System SHALL 允许 TS_Engineer 为 BOM List 中的每个 Base Number 维护上级件名称与 LRU 标记〔上级件与 LRU 标记的维护界面归属 Work Package List 模块，本模块仅保证 Base Number 输出完整，见《临时设计说明》待澄清项 A6〕。
8. WHEN 所关联 Lot List 的 Base Number 集合发生变更, THE Task_Card_System SHALL 同步更新该工卡向 BOM List 输出的 Base Number 集合。

### 需求 49：编制内容可编辑态约束与执行域快照隔离

**User Story:** 作为 TS经理，我希望仅「新增」状态的工卡版本可被编辑，且已释放 JOB 所引用的工序内容不随编制域模板变动，以便任何对已生效工卡的内容变更都必须经升版与一编一审，满足适航记录不可被追溯性修改的要求。

#### 验收标准 (Acceptance Criteria)

1. THE Task_Card_System SHALL 仅允许对状态为"新增(New)"的工卡版本编辑其编制域内容；编制域内容包含工卡元数据、参考文件、工序（含 Skill、参考文件、双语描述）、数据采集项、插入组件、签署项配置与工卡关联。
2. IF 对状态为"审核中(UnderReview)"、"生效(Effective)"、"已被取代(Superseded)"或"作废(Void)"的工卡版本请求编辑其编制域内容, THEN THE Task_Card_System SHALL 拒绝该操作并提示当前状态不可编辑。
3. WHERE TS_Engineer 需要变更已生效工卡的内容, THE Task_Card_System SHALL 要求先对该工卡执行升版（见需求 38.4、38.5），并仅对升版产生的"新增"版本进行编辑。
4. THE Task_Card_System SHALL 对**全部编辑入口**一致执行需求 49.1 与 49.2 的约束，包含但不限于：工卡保存、工序增删改与排序、参考文件增删、采集项与组件增删改、签署项配置增删、工卡关联增删、批量替换（需求 20.3 为本约束在批量替换路径上的特例）。
5. WHEN 工卡释放生成 JOB, THE Task_Card_System SHALL 对该次释放所含的工序内容（工序编号、Skill、参考文件、双语描述、数据采集项、插入组件、签署项配置）建立快照并存于执行域。
6. THE Task_Card_System SHALL 使 JOB 的执行与呈现仅依赖需求 49.5 所建立的快照，SHALL NOT 依赖编制域工序记录的当前内容。
7. WHEN 编制域工序内容在后续版本中被修改, THE Task_Card_System SHALL 保持既有 JOB 的快照内容不变（对应需求 37.5 的两域分离与需求 44.6 的记录完整性要求）。
8. THE Task_Card_System SHALL 允许对状态为"生效(Effective)"的工卡执行不改变其编制域内容的操作，包含查看、打印、导出、复制、升版、作废与发布至工包。
