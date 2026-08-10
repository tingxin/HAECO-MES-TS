import { describe, it, expect } from 'vitest';
import { CODE, ok, fail, httpStatusFor, send, sendOk, sendFail } from './response.js';

/** 最小 Express 响应替身：记录 status 与 json 的入参，不引入 mock 框架。 */
function fakeRes() {
  const captured = { status: undefined, body: undefined };
  return {
    captured,
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
}

const ERROR_CODES = Object.values(CODE).filter((c) => c !== CODE.OK);

describe('ok()', () => {
  it('返回 code 0 与默认消息 ok', () => {
    expect(ok()).toEqual({ code: 0, message: 'ok', data: null });
  });

  it('原样承载业务数据与自定义消息', () => {
    const data = { jobNo: 'JOB-001', failed: [{ row: 3, reason: '枚举非法' }] };
    expect(ok(data, '迁移完成')).toEqual({ code: 0, message: '迁移完成', data });
  });

  it('部分失败但整批成功的场景仍为 code 0，明细放 data', () => {
    const envelope = ok({ successCount: 8, failureCount: 2, failures: [{ row: 1, reason: '必填缺失' }] });
    expect(envelope.code).toBe(0);
    expect(envelope.data.failureCount).toBe(2);
  });
});

describe('fail()', () => {
  it('八个错误码各自带默认中文消息', () => {
    for (const code of ERROR_CODES) {
      const envelope = fail(code);
      expect(envelope.code).toBe(code);
      expect(envelope.message).toBeTruthy();
      expect(envelope.data).toBeNull();
    }
  });

  it('支持自定义消息与附加明细', () => {
    const data = { failedChecks: ['duplicate', 'capability'] };
    expect(fail(CODE.VALIDATION, '提交审核校验未通过', data)).toEqual({
      code: 400,
      message: '提交审核校验未通过',
      data,
    });
  });

  it('拒绝 code 0 —— 成功一律走 ok()', () => {
    expect(() => fail(CODE.OK, '不该成功')).toThrow(TypeError);
  });

  it('拒绝词表外的码，避免出现无法镜像为 HTTP status 的 code', () => {
    expect(() => fail(418)).toThrow(TypeError);
    expect(() => fail('400')).toThrow(TypeError);
  });
});

describe('httpStatusFor() 镜像约定', () => {
  it('code 0 恒为 HTTP 200', () => {
    expect(httpStatusFor(CODE.OK)).toBe(200);
  });

  it('非零 code 恒等于同值 HTTP status', () => {
    for (const code of ERROR_CODES) {
      expect(httpStatusFor(code)).toBe(code);
    }
  });

  it('未知 code 抛错', () => {
    expect(() => httpStatusFor(302)).toThrow(TypeError);
  });
});

describe('send / sendOk / sendFail', () => {
  it('成功响应写出 HTTP 200 与完整信封', () => {
    const res = fakeRes();
    sendOk(res, { id: 1 });
    expect(res.captured.status).toBe(200);
    expect(res.captured.body).toEqual({ code: 0, message: 'ok', data: { id: 1 } });
  });

  it('失败响应的 HTTP status 与 code 同值', () => {
    for (const code of ERROR_CODES) {
      const res = fakeRes();
      sendFail(res, code, '出错了');
      expect(res.captured.status).toBe(code);
      expect(res.captured.body).toEqual({ code, message: '出错了', data: null });
    }
  });

  it('send() 对任意信封都维持镜像不变式', () => {
    for (const envelope of [ok('x'), ...ERROR_CODES.map((c) => fail(c))]) {
      const res = fakeRes();
      send(res, envelope);
      expect(res.captured.status).toBe(envelope.code === 0 ? 200 : envelope.code);
      expect(res.captured.body).toBe(envelope);
    }
  });
});
