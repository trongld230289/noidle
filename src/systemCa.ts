/**
 * Mạng công ty có kiểm tra SSL giải mã HTTPS rồi ký lại bằng CA nội bộ, CA đó chỉ có trong kho chứng chỉ của Windows/macOS.
 * VS Code tin kho đó, nhưng hook là tiến trình node riêng, mặc định chỉ tin bộ CA đóng gói sẵn: Edge TTS và ElevenLabs lỗi
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY hay SELF_SIGNED_CERT_IN_CHAIN, không đọc được câu nào (15/10/2026: từ 1.0.36 Edge dùng
 * api.msedgeservices.com, có mạng ký lại host này mà không ký lại speech.platform.bing.com cũ). Thêm CA hệ thống vào danh
 * sách mặc định, giống đặt NODE_USE_SYSTEM_CA=1 nhưng người dùng không phải làm gì.
 */
import * as tls from 'tls';

/** API của Node 22.19+ và 24.5+; @types/node 20 chưa khai báo. */
export interface CaApi {
  getCACertificates?: (type: 'default' | 'system') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

/**
 * Thêm CA hệ thống vào danh sách CA mặc định của tiến trình (Node tự bỏ trùng). false: Node cũ không có API, giữ nguyên.
 * Đọc kho lỗi thì ném ra cho nơi gọi ghi log. Tốn khoảng 90ms nên chỉ gọi khi sắp cần mạng.
 */
export function trustSystemCertificates(api: CaApi = tls as unknown as CaApi): boolean {
  if (typeof api.getCACertificates !== 'function' || typeof api.setDefaultCACertificates !== 'function') return false;
  api.setDefaultCACertificates([...api.getCACertificates('default'), ...api.getCACertificates('system')]);
  return true;
}
