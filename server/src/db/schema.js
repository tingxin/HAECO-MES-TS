/**
 * schema.sql 的**生成器**——枚举单一事实来源（Single Source of Truth）的落地方式。
 *
 * ## 为什么需要生成器
 *
 * design.md「枚举的单一事实来源」要求：SQLite `CHECK` 约束由 `domain/enums.js` 取值渲染，
 * **禁止在 DDL 中二次手写**。而 better-sqlite3 只能执行纯 SQL 文本，`schema.sql` 本身无法
 * 引用 JS 常量，故采用**占位符 + 渲染**方案：
 *
 * - `schema.sql` 只写占位符 `{{CHECK:<enumField>[:<columnName>]}}`，不出现任何枚举字面量；
 * - 本模块把占位符替换为 `renderCheckConstraint(field, columnName)` 的产出，得到可执行 DDL；
 * - 渲染后若仍残留 `{{`，立即抛错——生成期失败优于生成出无约束的表。
 *
 * ## 占位符写法（任务 3.3–3.6 一律沿用此模式）
 *
 * ```sql
 * card_type TEXT NOT NULL {{CHECK:cardType}}          -- 列名由字段名推导：card_type
 * status    TEXT NOT NULL {{CHECK:cardStatus:status}} -- 值域 CARD_STATUS 绑定到 status 列
 * type      TEXT NOT NULL {{CHECK:componentType:type}}
 * ```
 *
 * 第二段（`:columnName`）用于**值域名与列名不一致**的场景（如 `capture_item.type` 用
 * COMPONENT_TYPE、`task_card.status` 用 CARD_STATUS）。省略时按 camelCase → snake_case 推导。
 *
 * ⚠ 只有 `enums.js` 中登记的值域才用占位符。表内**局部**取值集（`attachment.kind`、
 * `card_relation.origin`、`bom_base_output.source` 等）不属全系统枚举，直接写字面量 CHECK，
 * 不进 `enums.js`——否则会把局部约束伪装成领域枚举，反而污染单一事实来源。
 *
 * ## 消费方
 *
 * 任务 3.6 的 `db/migrate.js` 调用 `buildSchemaSql()` / `applySchema(db)`，
 * 不直接读取 `schema.sql` 原文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCheckConstraint } from '../domain/enums.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** DDL 模板（含占位符）的路径 */
export const SCHEMA_SQL_PATH = path.join(MODULE_DIR, 'schema.sql');

/** 占位符语法：`{{CHECK:enumField}}` 或 `{{CHECK:enumField:column_name}}` */
const CHECK_PLACEHOLDER = /\{\{\s*CHECK:([A-Za-z0-9_]+?)(?::([A-Za-z0-9_]+))?\s*\}\}/g;

/**
 * 去掉 SQL 行注释后的文本，仅用于「残留占位符」扫描。
 * schema.sql 的注释块会举例说明占位符语法（如 `{{CHECK:<enumField>[:<columnName>]}}`），
 * 那些示例不是待渲染内容，不应触发生成期报错。DDL 内无含 `--` 的字符串字面量，故按行截断安全。
 */
function stripSqlComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/** 读取 DDL 模板原文（未渲染，仅供工具与测试使用） */
export function readSchemaTemplate() {
  return fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');
}

/**
 * 把模板中的 CHECK 占位符渲染为实际约束子句。
 * @param {string} template 含占位符的 DDL 文本
 * @returns {string} 可直接执行的 DDL
 * @throws {Error} 占位符引用未知枚举字段，或渲染后仍残留占位符
 */
export function renderSchemaSql(template) {
  const rendered = String(template).replace(
    CHECK_PLACEHOLDER,
    (_match, field, columnName) => renderCheckConstraint(field, columnName),
  );

  const effective = stripSqlComments(rendered);
  if (effective.includes('{{')) {
    const leftover = effective.match(/\{\{[^}]*\}\}/g) ?? ['(无法定位)'];
    throw new Error(`schema.sql 存在未识别的占位符：${leftover.join(', ')}`);
  }

  return rendered;
}

/** 读取模板并渲染，返回可执行 DDL 全文 */
export function buildSchemaSql() {
  return renderSchemaSql(readSchemaTemplate());
}

/**
 * 在给定连接上执行完整 DDL（幂等：全部对象均为 `IF NOT EXISTS`）。
 * @param {import('better-sqlite3').Database} connection
 * @returns {import('better-sqlite3').Database} 同一连接，便于链式调用
 */
export function applySchema(connection) {
  connection.exec(buildSchemaSql());
  return connection;
}

export default buildSchemaSql;
