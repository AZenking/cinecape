import type { Profile } from '@platform/database/schema';

/**
 * ProfileSummary 响应体与白名单投影（T024 自 interface/account-session.dto 上提）：
 * - 上提原因：application 层 import 本上下文 interface 层为审计禁边（R1），而
 *   bootstrap.service 以本 DTO 为首建/PIN 恢复的返回契约并消费 toProfileSummary
 *   纯投影，故类型与纯函数落位 application 层（与 DeviceDtoBody 落位
 *   device.service 同层先例一致；identity-access.ports.ts 为「仅提取类型」的
 *   发布面文件，不落运行时函数，且 application→ports 边不在 R1b 合法面）；
 * - interface/account-session.dto 与发布面 index 仍再导出本文件符号，
 *   既有消费方零改动；
 * - 白名单投影，永不含 PIN 哈希、失败计数、策略等设置主体。
 */

/** ProfileSummary 响应体(契约 B001ProfileDto;选档/首建/会话共用) */
export interface ProfileSummaryBody {
  id: string;
  name: string;
  avatar: string | null;
  type: 'adult' | 'child';
  isDefault: boolean;
  isMain: boolean;
  pinProtected: boolean;
  status: 'active' | 'disabled';
  createdAt: string;
  version: number;
}

/** Profile 行 → ProfileSummary 白名单投影(pin_hash/failed_pin_count 等永不进入 DTO) */
export function toProfileSummary(row: Profile): ProfileSummaryBody {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    type: row.type as ProfileSummaryBody['type'],
    isDefault: row.isDefault === 1,
    isMain: row.isMain === 1,
    pinProtected: row.pinHash !== null,
    status: row.status as ProfileSummaryBody['status'],
    createdAt: row.createdAt,
    version: row.version,
  };
}
