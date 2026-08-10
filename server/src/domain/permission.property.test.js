import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ROLE, PERMISSION_POINT } from './enums.js';
import { ROLE_PERMISSION_MATRIX, buildRolePermissionRows } from '../db/seed.js';
import { checkPermission, isWritableField, READONLY_DERIVED_FIELDS } from './permission.js';

const rows = buildRolePermissionRows();

const roleArb = fc.constantFrom(...ROLE);
const permissionPointArb = fc.constantFrom(...PERMISSION_POINT);

// Feature: task-card-management, Property 29: 角色权限边界不可越权 —— For any 角色与操作，操作被允许当且仅当该 (角色, 权限点) 组合在 role_permission 中被允许；TS 角色恒不可写入 Work Category 与 Estimated ManHours；Planning 角色恒不可修改编制域工卡内容；Production 角色恒不可修改编制域内容；QA 角色恒不可编制或审核；批量替换权限不由编卡权限自动继承。For any 角色与任意只读带出字段（需求 26.1 的执行相关字段、需求 27.1 的 Process Card 四字段、需求 30.1 的工序 Operation、需求 11.3 的 Work Category 与 Estimated ManHours、需求 11.4 的有效/实际工时），针对该字段的人工写入请求恒被拒绝，其值恒只能来自对应集成读取契约或执行期采集——不存在任何角色可经本模块编制界面改写这些字段的路径。
describe('Property 29: 角色权限边界不可越权（server/src/domain/permission.js）', () => {
  it('操作被允许当且仅当 (角色, 权限点) 在 role_permission 中允许（以 ROLE_PERMISSION_MATRIX 为地面真相）', () => {
    fc.assert(
      fc.property(roleArb, permissionPointArb, (role, permissionPoint) => {
        const expected = ROLE_PERMISSION_MATRIX[role].includes(permissionPoint);
        expect(checkPermission(role, permissionPoint, rows)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('TS 角色恒不可写 PPC 工时（ppc_manhours_write），需求 47.4、47.5、11.3', () => {
    const tsRoleArb = fc.constantFrom('TS_Engineer', 'TS_Manager');
    fc.assert(
      fc.property(tsRoleArb, (role) => {
        expect(checkPermission(role, 'ppc_manhours_write', rows)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('Planning / Production 恒不可改编制域内容（card_edit），需求 47.6、47.7', () => {
    const nonEditRoleArb = fc.constantFrom(
      'Planning_Engineer',
      'Planning_Manager',
      'Production_Technician',
      'Production_Manager',
    );
    fc.assert(
      fc.property(nonEditRoleArb, (role) => {
        expect(checkPermission(role, 'card_edit', rows)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('QA 恒不可编不可审（card_edit、card_review），需求 47.8', () => {
    fc.assert(
      fc.property(fc.constant('QA_Engineer'), (role) => {
        expect(checkPermission(role, 'card_edit', rows)).toBe(false);
        expect(checkPermission(role, 'card_review', rows)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('batch_replace 不由 card_edit 继承（需求 20.9、47.9）：不存在「有 card_edit 即有 batch_replace」的隐含蕴含', () => {
    fc.assert(
      fc.property(roleArb, (role) => {
        const hasCardEdit = checkPermission(role, 'card_edit', rows);
        const hasBatchReplace = checkPermission(role, 'batch_replace', rows);
        // 蕴含式 hasCardEdit -> hasBatchReplace 必须不是全域恒真：
        // 断言矩阵中确有 card_edit=true 但 batch_replace=false 的角色存在（TS_Engineer），
        // 从而否定「继承」这一隐含关系对任意角色恒成立。
        if (role === 'TS_Engineer') {
          expect(hasCardEdit).toBe(true);
          expect(hasBatchReplace).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
    // 显式确认反例存在（矩阵中至少一行推翻「card_edit 蕴含 batch_replace」）
    const counterexampleExists = ROLE.some(
      (role) => checkPermission(role, 'card_edit', rows) && !checkPermission(role, 'batch_replace', rows),
    );
    expect(counterexampleExists).toBe(true);
  });

  it('只读带出字段的人工写入恒被拒绝，且与角色无关（需求 26.1、27.1、30.1、11.3、11.4）', () => {
    // isWritableField 的函数签名只接受一个参数（字段名），不接受角色参数——
    // 这本身即是「恒不可写」的结构性保证：不存在任何入参组合可使其对只读字段返回 true。
    expect(isWritableField.length).toBe(1);

    const readonlyFieldArb = fc.constantFrom(...READONLY_DERIVED_FIELDS);
    fc.assert(
      fc.property(readonlyFieldArb, roleArb, (qualifiedField, _roleIgnoredByDesign) => {
        // 限定名（如 job.check_type）与裸列名（如 check_type）均须恒为不可写，
        // 且此断言不因角色变量而改变——验证 isWritableField 的结果不依赖调用者角色。
        expect(isWritableField(qualifiedField)).toBe(false);
        const bareColumn = qualifiedField.slice(qualifiedField.indexOf('.') + 1);
        expect(isWritableField(bareColumn)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
