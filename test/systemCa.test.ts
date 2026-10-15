import { describe, it, expect } from 'vitest';
import * as tls from 'tls';
import { trustSystemCertificates, type CaApi } from '../src/systemCa';

/**
 * 15/10/2026: firewall công ty ký lại HTTPS của api.msedgeservices.com bằng CA chỉ có trong kho Windows; node chạy hook
 * chỉ tin CA đóng gói sẵn nên không tải được câu nào. Hook phải tin thêm kho chứng chỉ hệ thống, người dùng không phải đặt gì.
 */
describe('trustSystemCertificates: tin thêm CA của hệ thống', () => {
  it('đặt danh sách mặc định gồm CA đang dùng và CA hệ thống', () => {
    const set: string[][] = [];
    const api: CaApi = {
      getCACertificates: (type) => (type === 'default' ? ['bundled-root'] : ['company-root']),
      setDefaultCACertificates: (certs) => set.push(certs),
    };
    expect(trustSystemCertificates(api)).toBe(true);
    expect(set).toEqual([['bundled-root', 'company-root']]);
  });

  it('Node cũ không có API: không làm gì, trả false', () => {
    expect(trustSystemCertificates({})).toBe(false);
    expect(trustSystemCertificates({ getCACertificates: () => [] })).toBe(false);
  });

  const real = tls as unknown as CaApi;
  it.runIf(typeof real.setDefaultCACertificates === 'function')('Node thật: sau khi gọi, mọi CA hệ thống nằm trong danh sách mặc định', () => {
    expect(trustSystemCertificates()).toBe(true);
    const defaults = new Set(real.getCACertificates!('default'));
    const system = real.getCACertificates!('system');
    expect(system.filter((c) => !defaults.has(c))).toEqual([]);
  });
});
