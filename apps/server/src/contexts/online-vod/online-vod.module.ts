import { Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import 'reflect-metadata';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import { DomainError } from '@platform/http-common/domain-error';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimitService } from '@platform/http-common/rate-limit/rate-limit.service';
import { Database } from '@platform/database/database';
import { UNIT_OF_WORK } from '@platform/database/unit-of-work';
import { getConfig } from '@platform/config/env';
import {
  SAFE_UPSTREAM_PORT,
  VOD_SAFE_UPSTREAM_BUDGETS,
  type SafeUpstreamOpenRequest,
  type SafeUpstreamPort,
  type SafeUpstreamReadResult,
} from '@platform/upstream/safe-upstream.port';
import { RemoteReadFailure } from '@platform/upstream/safe-upstream-reader';
import { createVodSourceConfigurationPort } from '@contexts/sources';
import {
  evaluateEffectiveMediaPolicy,
  parseStoredList,
  type EffectiveMediaPolicyInput,
  type ParentChildMediaFacts,
} from '@contexts/policy';
import { ONLINE_VOD_PUBLICATION_PARTICIPANT, ONLINE_VOD_STORE, VOD_CACHE, VOD_MATERIALIZATION, VOD_POSTER_SERVICE, VOD_PREVIEW_SERVICE, VOD_SEARCH_SERVICE, type VodMaterializationAssembly } from '@contexts/online-vod/online-vod.tokens';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import { drizzleOnlineVodStore } from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import { type OnlineVodStore } from '@contexts/online-vod/application/online-vod-store.port';
import { VodRetentionService } from '@contexts/online-vod/application/vod-retention.service';
import { drizzleVodRetentionStore } from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import { createVodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import type { VodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import { vodConfigProvider, VOD_RUNTIME_CONFIG, type VodRuntimeConfig } from '@contexts/online-vod/infrastructure/vod-config';
import { parseDetailDocument, parseSearchList, type AppleCmsListDocumentWire } from '@contexts/online-vod/infrastructure/apple-cms.adapter';
import { ProviderParseError } from '@contexts/online-vod/domain/provider-model';
import type { ContinuitySignature } from '@contexts/online-vod/domain/continuity.rules';
import {
  createVodSearchService,
  VodUpstreamTimeoutError,
  type VodSearchUpstreamFn,
} from '@contexts/online-vod/application/search.service';
import { createVodPosterService } from '@contexts/online-vod/application/poster.service';
import { createVodPreviewService, type VodDetailUpstreamFn } from '@contexts/online-vod/application/preview.service';
import type { MaterializationServiceDeps } from '@contexts/online-vod/application/materialization.service';
import type {
  MaterializeTargetResolver,
  ResolvedMaterializationTarget,
} from '@contexts/online-vod/application/materialization.service';
import type { MaterializeCommand } from '@contexts/online-vod/application/publication-work-set.port';
import { createVodMaterializationTargetResolver, VodMaterializationController } from '@contexts/online-vod/interface/materialization.controller';
import { PublicVodController, VodSearchRateGuard } from '@contexts/online-vod/interface/public-vod.controller';
import { VodSwitchController, VOD_SWITCH_WIRING, type VodSwitchWiring } from '@contexts/online-vod/interface/vod-switch.controller';
import {
  SWITCH_PROBE_BUDGETS,
  type VodProbeUpstreamFn,
  type VodProbeUpstreamOutcome,
} from '@contexts/online-vod/application/switch-probe.service';
import type { VodCandidateBindingPayload } from '@contexts/online-vod/application/switch-candidates.service';
import type { VodSourceConfigurationPort } from '@contexts/online-vod/application/publication-work-set.port';
import type { PlaybackTransitionSourcePort, SwitchSourceContextFacts, SwitchSourceContextRequest, SwitchSourceTitleFactsLoader } from '@contexts/online-vod/application/switch-candidates.service';
import type { SwitchProbePolicyGate } from '@contexts/online-vod/application/switch-probe.service';

/**
 * RateLimitGuard / VodSearchRateGuard 构造参数元数据补齐(本模块装载时一次性执行,
 * 与 media-catalog.module 同款)—— esbuild/tsx 运行时不发射 design:paramtypes,
 * @UseGuards(类引用) 实例化时构造依赖解析为 undefined → 回退进程级共享单例。
 * 补齐 [RateLimitService(, Reflector)] 元数据后守卫经本模块注入器解析
 * HttpCommonModule 的 per-app 实例 —— 限频桶随 app 生命周期隔离(契约 rig 每用例
 * 重建 app 即桶清零;限频「才跨路由累计」语义在同一 app 内保持)。
 */
Reflect.defineMetadata(PARAMTYPES_METADATA, [RateLimitService, Reflector], RateLimitGuard);
Reflect.defineMetadata(PARAMTYPES_METADATA, [RateLimitService], VodSearchRateGuard);

/**
 * OnlineVod 模块(T031 服务端总装配)。
 *
 * 承载装配落点:VodCache 有界缓存单例(工厂 + dispose 挂 onModuleDestroy/
 * onApplicationShutdown 钩子)、三服务工厂(搜索/预览/物化)、两个契约控制器
 * (public-vod / materialization)。所有网络在事务外:搜索/详情上游读取经
 * SAFE_UPSTREAM_PORT(组合根绑定 createSafeUpstreamService;许可=LAN_ALLOWED_
 * TARGETS,请求侧逐一传入)+ T025 apple-cms.adapter 解析;数据访问经
 * ONLINE_VOD_STORE seam;事务参与者经构造器显式传入(T016)。
 *
 * 共享单例约束:VOD_CACHE 是 T028 search/preview 服务与 T031 resolveTarget 桥
 * 的**同一实例**(opaque ref 注册表单例;module 内 useFactory 一次产出)。
 *
 * 边界(internal-ports.md §1/§4):
 * - 不 import playback/other contexts 的私有实现;跨上下文仅消费各上下文
 *   index.ts 发布面端口(sources 配置端口/policy 有效媒体策略纯函数),装配在
 *   模块工厂完成,无 forwardRef 循环。
 * - 不引入第二全局播放器;播放控制权仍归 playback 上下文。
 * - 实现类/私表不出本上下文发布面。
 */

/* ------------------------------------------------------------------ */
/* 上游装配(apple-cmsJSON;SafeUpstream 有界读取 + T025 解析;网络在事务外) */
/* ------------------------------------------------------------------ */

/** Apple CMS v10 查询参数构建(根 locator 已含 path;query 逐项覆写) */
function appleCmsUrl(locator: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(locator);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** 关键词检索 URL(ac=list&wd=;首页不带 pg —— wd 检索命名空间按词命中,pg 仅用于后续页) */
function appleCmsSearchUrl(locator: string, query: string, page: number): string {
  return appleCmsUrl(locator, page > 1 ? { ac: 'list', wd: query, pg: String(page) } : { ac: 'list', wd: query });
}

/**
 * 换源候选检索 URL(ac=list&wd=&pg=1;首页显式携带分页参数)—— 与公共检索的
 * 「首页省略 pg」形态区分:候选检索是服务端诊断面,显式 pg=1 让上游按页语义
 * 应答(部分上游按 pg 在场与否区分「检索/全量」应答形态),wd 缺命中时回落
 * 全量首页,保证同题候选不被上游检索别名差异吞掉(T070 候选检索面)。
 */
function appleCmsSwitchSearchUrl(locator: string, query: string, page: number): string {
  return page > 1
    ? appleCmsUrl(locator, { ac: 'list', wd: query, pg: String(page) })
    : appleCmsUrl(locator, { ac: 'list', wd: query, pg: '1' });
}

/** 响应体 → 信封 wire(非 JSON = 完整性受损,整体拒绝) */
function parseEnvelope(bytes: Buffer): AppleCmsListDocumentWire {
  try {
    return JSON.parse(bytes.toString('utf8')) as AppleCmsListDocumentWire;
  } catch {
    throw new ProviderParseError('integrity_violation', '上游响应不是合法 JSON,整体拒绝');
  }
}

function isRemoteReadFailure(error: unknown): error is RemoteReadFailure {
  return error instanceof RemoteReadFailure;
}

/**
 * 单源单页上游搜索:GET {locator}?ac=list&wd=&pg= ;预算 = 共享 deadline(绝对
 * 期限转 timeBudgets)+ detail.maxBytes;失败按稳定码分类(timeout/invalid 停留
 * 展示层,其余传输故障原样上抛 → 服务侧 unavailable)。
 * searchUrl 构建器可注入(公共检索=appleCmsSearchUrl 首页省略 pg;换源候选检索
 * =appleCmsSwitchSearchUrl 显式 pg=1,见该函数注释),其余行为逐字一致。
 */
function createSearchUpstream(
  safeUpstream: SafeUpstreamPort,
  sourceConfig: ReturnType<typeof createVodSourceConfigurationPort>,
  config: VodRuntimeConfig,
  searchUrl: (locator: string, query: string, page: number) => string = appleCmsSearchUrl,
): VodSearchUpstreamFn {
  return async (request) => {
    const locator = sourceConfig.findSourceLocatorById(request.sourceId);
    if (locator === undefined) {
      // 来源已禁用/未配置:传输级不可用(服务侧记 unavailable,不泄露细节)
      throw new RemoteReadFailure('SOURCE_TARGET_DENIED', '来源定位不可用');
    }
    const remainingMs = Math.max(0, request.deadlineMs - Date.now());
    let read: SafeUpstreamReadResult;
    try {
      read = await safeUpstream.read({
        url: searchUrl(locator, request.query, request.page),
        allowedTargets: getConfig().LAN_ALLOWED_TARGETS,
        byteBudget: config.detail.maxBytes,
        timeBudgets: {
          totalTimeoutMs: remainingMs,
          idleTimeoutMs: VOD_SAFE_UPSTREAM_BUDGETS.idleTimeoutMs,
          maxRedirects: VOD_SAFE_UPSTREAM_BUDGETS.maxRedirects,
        },
        signal: request.signal,
      } satisfies SafeUpstreamOpenRequest);
    } catch (error) {
      // 010 恢复(search.service 头注释「二者任一命中即 timeout 语义」):装配侧
      // 超时形态统一折算 VodUpstreamTimeoutError —— 空闲超时/外部中止(共享
      // deadline)直接映射;总时长预算耗尽(SOURCE_BUDGET_EXCEEDED 的时长变体,
      // 与字节超限同码)以「已过共享 deadline」判定,避免与真实字节超限混淆。
      if (isRemoteReadFailure(error)) {
        if (error.code === 'SOURCE_IDLE_TIMEOUT' || error.code === 'SOURCE_ABORTED') {
          throw new VodUpstreamTimeoutError();
        }
        if (error.code === 'SOURCE_BUDGET_EXCEEDED' && Date.now() >= request.deadlineMs) {
          throw new VodUpstreamTimeoutError();
        }
      }
      throw error;
    }
    const document = parseEnvelope(read.bytes);
    const items = parseSearchList(document);
    // hasMore = 上游还有下一页(信封 page/pagecount 可判;缺省按满页推断)
    const page = Number(document.page ?? request.page);
    const pagecount = Number(document.pagecount ?? 1);
    const hasMore =
      items.length > 0 &&
      Number.isFinite(page) &&
      Number.isFinite(pagecount) &&
      pagecount > 0 &&
      page < pagecount;
    return { items, hasMore };
  };
}

/**
 * 单源详情上游:GET {locator}?ac=detail&ids= ;预算 = preview.totalTimeoutMs/
 * preview.maxBytes(请求侧给出);超时/字节超限按契约映射(504/422),其余传输
 * 故障原样上抛 → preview 服务 502。
 */
function createDetailUpstream(safeUpstream: SafeUpstreamPort, sourceConfig: ReturnType<typeof createVodSourceConfigurationPort>, config: VodRuntimeConfig): VodDetailUpstreamFn {
  return async (request) => {
    const locator = sourceConfig.findSourceLocatorById(request.sourceId);
    if (locator === undefined) {
      throw new RemoteReadFailure('SOURCE_TARGET_DENIED', '来源定位不可用');
    }
    const remainingMs = Math.max(0, request.deadlineMs - Date.now());
    try {
      const read: SafeUpstreamReadResult = await safeUpstream.read({
        url: appleCmsUrl(locator, { ac: 'detail', ids: request.upstreamVodId }),
        allowedTargets: getConfig().LAN_ALLOWED_TARGETS,
        byteBudget: request.maxBytes,
        timeBudgets: {
          totalTimeoutMs: remainingMs,
          idleTimeoutMs: VOD_SAFE_UPSTREAM_BUDGETS.idleTimeoutMs,
          maxRedirects: VOD_SAFE_UPSTREAM_BUDGETS.maxRedirects,
        },
        signal: request.signal,
      } satisfies SafeUpstreamOpenRequest);
      return parseDetailDocument(parseEnvelope(read.bytes), {
        budgets: {
          maxLines: config.detail.maxLines,
          maxEpisodesPerLine: config.detail.maxEpisodesPerLine,
          maxEpisodesTotal: config.detail.maxEpisodesTotal,
        },
      });
    } catch (error) {
      if (error instanceof ProviderParseError || error instanceof VodUpstreamTimeoutError) {
        throw error;
      }
      if (isRemoteReadFailure(error)) {
        // 字节预算超限 → 422 VOD_DETAIL_TOO_LARGE(整次失败);空闲/外部中止(共享
        // deadline)→ 504;其余传输故障原样上抛 → 502
        if (error.code === 'SOURCE_BUDGET_EXCEEDED') {
          throw new ProviderParseError('budget_exceeded', '上游详情读取超过字节预算,整次失败');
        }
        if (error.code === 'SOURCE_IDLE_TIMEOUT' || error.code === 'SOURCE_ABORTED') {
          throw new VodUpstreamTimeoutError();
        }
      }
      throw error;
    }
  };
}

/* ------------------------------------------------------------------ */
/* T070/T071 换源装配(候选/测速:来源授权投影、标题事实、策略门、测速上游) */
/* ------------------------------------------------------------------ */

/** 来源会话只读投影行(playback_session 共享表只读;不写任何他上下文表) */
interface SwitchSourceRow {
  readonly id: string;
  readonly generation: number;
  readonly state: string;
  readonly mediaId: string;
  readonly endedAt: string | null;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
}

/** playback_session 只读投影(组合根级单语句读;语句单一事实源归 playback 仓储) */
function readSwitchSourceRow(householdId: string, fromSessionId: string): SwitchSourceRow | undefined {
  return Database.db.prepare(
    `SELECT id, generation, state, media_id AS mediaId, ended_at AS endedAt,
            device_session_id AS deviceSessionId, profile_id AS profileId,
            profile_context_version AS profileContextVersion
     FROM playback_session WHERE household_id = ? AND id = ?`,
  ).get(householdId, fromSessionId) as SwitchSourceRow | undefined;
}

/** 与 T059 只读授权完全同形的 404(身份/存在性失配不可判别,api §0) */
function switchSourceNotFound(): DomainError {
  return new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在');
}

/**
 * PlaybackTransitionSourcePort 消费面实现(候选/测速授权;internal-ports §1「终态
 * 也可读合法来源上下文」):playback_session 只读投影 + 同上下文校验(家庭/设备/
 * Profile/context 全等,任一失配 404 同形)。
 *
 * state 投影(装配裁定,逐字):failed 保留原值 —— T070 用例面据其执行「可恢复
 * failed 仅 60s」恢复窗;其余状态(活动 preparing/ready/playing/paused 与 ended)
 * 一律投影 'ended' —— 候选/测速是播放中的只读可达性诊断(api §5 候选/测速行均无
 * 终态要求;FR-029「用户无需退出重搜」),消费侧终态资格(「正常 switch 旧来源必须
 * 先 stop 到 ended」)归 transition 消费面(US4 T072),不属本投影语义。
 */
function createSwitchTransitionSourcePort(): PlaybackTransitionSourcePort {
  return {
    authorizeReadonlySourceContext(request: SwitchSourceContextRequest): SwitchSourceContextFacts {
      const row = readSwitchSourceRow(request.householdId, request.fromSessionId);
      if (
        row === undefined ||
        row.deviceSessionId !== request.deviceSessionId ||
        row.profileId !== request.profileId ||
        row.profileContextVersion !== request.profileContextVersion
      ) {
        throw switchSourceNotFound();
      }
      return {
        fromSessionId: row.id,
        generation: row.generation,
        state: row.state === 'failed' ? 'failed' : 'ended',
        mediaId: row.mediaId,
        endedAt: row.endedAt,
      };
    },
  };
}

/** 物化标题的预览事实(进程内有界投影;仅 title/year 服务端事实,无 URL/采集时间) */
interface MaterializedTitleFacts {
  readonly title: string;
  readonly year: string | null;
}

/** 预览事实投影上限(插入序淘汰;进程内存有界,重启即清) */
const MATERIALIZED_TITLE_FACTS_MAX = 1024;

/**
 * 来源可信标题事实投影(T070 loadSourceTitleFacts 装配;T070 单测 spec 内生产形态
 * 参考实现的三级回退):vod_episode.continuity_signature(已验证证据)→ 物化预览
 * 事实投影(缺签名物化 —— 证据 unverified —— 在解析桥处登记的进程内 title/year
 * 服务端事实;不自造 URL/采集时间,data-model §3)→ 目录父标题回退。canonicalName
 * 归一为空 → undefined(缺关键字段不自动制造「内容一致」)。
 */
function createSwitchSourceTitleFactsLoader(
  store: OnlineVodStore,
  titleFacts: ReadonlyMap<string, MaterializedTitleFacts>,
): SwitchSourceTitleFactsLoader {
  return (householdId, mediaId) => {
    const episode = store.findEpisodeByMedia(householdId, mediaId);
    if (episode === undefined) return undefined;
    const line = store.findLine(householdId, episode.lineId);
    const title = line === undefined ? undefined : store.findTitle(householdId, line.titleId);
    const parentTitle =
      title === undefined
        ? undefined
        : (
            Database.db.prepare('SELECT title FROM media_item WHERE household_id = ? AND id = ?').get(
              householdId,
              title.parentMediaId,
            ) as { title: string } | undefined
          )?.title;
    const signature = parseContinuitySignature(episode.continuitySignature);
    const previewFacts =
      title === undefined
        ? undefined
        : titleFacts.get(`${householdId}\u0000${title.sourceId}\u0000${title.upstreamVodId}`);
    const canonicalName = (signature?.canonicalName ?? previewFacts?.title ?? parentTitle ?? '')
      .normalize('NFC')
      .trim();
    if (canonicalName.length === 0) return undefined;
    return {
      canonicalName,
      year: signature?.year ?? previewFacts?.year ?? null,
      seasonKey: signature?.seasonKey ?? null,
      episodeKey: episode.episodeKey,
      languageVersion: signature?.languageVersion ?? null,
      knownVersionLabel: signature?.knownVersionLabel ?? null,
    };
  };
}

/** continuity_signature JSON 解析(损坏/缺关键字段 → null;T070 spec 参考形态) */
function parseContinuitySignature(raw: string | null): ContinuitySignature | null {
  if (raw === null || raw === '') return null;
  try {
    const value = JSON.parse(raw) as Partial<ContinuitySignature>;
    if (typeof value.canonicalName !== 'string' || typeof value.matchRuleVersion !== 'string') return null;
    return {
      canonicalName: value.canonicalName,
      year: value.year ?? null,
      seasonKey: value.seasonKey ?? null,
      languageVersion: value.languageVersion ?? null,
      knownVersionLabel: value.knownVersionLabel ?? null,
      matchRuleVersion: value.matchRuleVersion,
    };
  } catch {
    return null;
  }
}

/** profile_policy 行 → 判定视图;缺失与损坏统一 null(领域函数归一 fail-closed 拒绝) */
function readProfilePolicyJudgment(profileId: string): EffectiveMediaPolicyInput['policy'] {
  const row = Database.db.prepare(
    `SELECT max_content_level AS maxContentLevel, allow_unrated AS allowUnrated,
            allowed_media_ids AS allowedMediaIds, blocked_media_ids AS blockedMediaIds,
            allowed_channel_ids AS allowedChannelIds, version
     FROM profile_policy WHERE profile_id = ?`,
  ).get(profileId) as
    | {
        readonly maxContentLevel: unknown;
        readonly allowUnrated: unknown;
        readonly allowedMediaIds: unknown;
        readonly blockedMediaIds: unknown;
        readonly allowedChannelIds: unknown;
        readonly version: unknown;
      }
    | undefined;
  if (row === undefined) return null;
  const maxContentLevel = row.maxContentLevel;
  const allowUnrated = row.allowUnrated;
  const version = row.version;
  try {
    if (
      !Number.isInteger(maxContentLevel) ||
      (maxContentLevel as number) < 0 ||
      (maxContentLevel as number) > 18 ||
      (allowUnrated !== 0 && allowUnrated !== 1) ||
      !Number.isInteger(version) ||
      (version as number) < 1
    ) {
      return null;
    }
    return {
      maxContentLevel: maxContentLevel as number,
      allowUnrated: allowUnrated === 1,
      allowedMediaIds: parseStoredList(row.allowedMediaIds as string, 'allowedMediaIds'),
      blockedMediaIds: parseStoredList(row.blockedMediaIds as string, 'blockedMediaIds'),
      allowedChannelIds: parseStoredList(row.allowedChannelIds as string, 'allowedChannelIds'),
    };
  } catch {
    return null;
  }
}

/**
 * 候选目标内容策略门(T017 evaluateEffectiveMediaPolicy 复用;internal-ports §3
 * 「临时候选策略使用同一预分配/已有映射事实,不能把 ref 当媒体 ID 或只按 adult
 * 展示模式放行」):仅在存在稳定映射时以真实目录父子事实判定(父轴 + 同标题全部
 * 已物化子轴一次集合装载,禁逐集 N+1);父轴或任一子轴拒绝即拒绝。未物化候选无
 * 服务端分级事实可判,不在测速面虚构媒体事实 —— 放行由后续物化事务的真实策略门
 * 兜底(测速本身零授权副作用,api §5「无票/无历史」)。
 */
function createSwitchProbePolicyGate(): SwitchProbePolicyGate {
  return {
    evaluateCandidateTarget(input: {
      readonly householdId: string;
      readonly profileId: string;
      readonly sourceId: string;
      readonly upstreamVodId: string;
    }): boolean {
      const title = Database.db.prepare(
        'SELECT id AS titleId, parent_media_id AS parentMediaId FROM vod_title WHERE household_id = ? AND source_id = ? AND upstream_vod_id = ?',
      ).get(input.householdId, input.sourceId, input.upstreamVodId) as
        | { readonly titleId: string; readonly parentMediaId: string }
        | undefined;
      if (title === undefined) return true;
      const parent = Database.db.prepare(
        'SELECT id AS mediaId, type AS role, content_level AS contentLevel FROM media_item WHERE household_id = ? AND id = ?',
      ).get(input.householdId, title.parentMediaId) as
        | { readonly mediaId: string; readonly role: string; readonly contentLevel: number | null }
        | undefined;
      if (parent === undefined) return false;
      const children = Database.db.prepare(
        `SELECT c.id AS mediaId, c.type AS role, c.content_level AS contentLevel
         FROM media_item c
         WHERE c.household_id = ?
           AND c.id IN (
             SELECT sib.media_id FROM vod_episode sib
             JOIN vod_line vl ON vl.household_id = sib.household_id AND vl.id = sib.line_id
             JOIN vod_title vt ON vt.household_id = vl.household_id AND vt.id = vl.title_id
             WHERE vt.household_id = ? AND vt.parent_media_id = ?
           )`,
      ).all(input.householdId, input.householdId, title.parentMediaId) as ReadonlyArray<{
        readonly mediaId: string;
        readonly role: string;
        readonly contentLevel: number | null;
      }>;
      if (children.length === 0) return false;
      const facts: ParentChildMediaFacts = {
        householdId: input.householdId,
        parent: {
          mediaId: parent.mediaId,
          role: parent.role as ParentChildMediaFacts['parent']['role'],
          contentLevel: parent.contentLevel,
          householdEnabled: true,
        },
        children: children.map((child) => ({
          mediaId: child.mediaId,
          role: child.role as ParentChildMediaFacts['children'][number]['role'],
          contentLevel: child.contentLevel,
          householdEnabled: true,
        })),
      };
      try {
        const decision = evaluateEffectiveMediaPolicy(readProfilePolicyJudgment(input.profileId), facts);
        return decision.parent.allowed && decision.children.some((child) => child.allowed);
      } catch {
        // 父子事实损坏:整组拒绝,不泄露判定轴
        return false;
      }
    },
  };
}

/**
 * 有界测速上游读取(装配面;SafeUpstreamPort 全维度校验:协议/DNS/每跳重定向/
 * 内网许可/timeout/byteBudget/AbortSignal,internal-ports §1/§3):
 * - 预算:timeBudgets.totalTimeoutMs = 候选级绝对期限剩余;byteBudget = 1MiB;
 * - 结论分类:清单首响应(#EXTM3U)→ reachable{首响应延迟};空闲超时/外部中止/
 *   时长预算耗尽 → timeout;mpegurl 自认但体非清单 → incompatible;其余传输故障
 *   (许可/DNS/不可达/重定向超限/字节超限/非清单响应)→ unavailable。
 */
function createSwitchProbeUpstream(safeUpstream: SafeUpstreamPort): VodProbeUpstreamFn {
  return async (request): Promise<VodProbeUpstreamOutcome> => {
    const startedAtMs = Date.now();
    const remainingMs = Math.max(0, request.deadlineMs - startedAtMs);
    let read: SafeUpstreamReadResult;
    try {
      read = await safeUpstream.read({
        url: request.url,
        allowedTargets: getConfig().LAN_ALLOWED_TARGETS,
        byteBudget: request.maxBytes,
        timeBudgets: {
          totalTimeoutMs: remainingMs,
          idleTimeoutMs: VOD_SAFE_UPSTREAM_BUDGETS.idleTimeoutMs,
          maxRedirects: VOD_SAFE_UPSTREAM_BUDGETS.maxRedirects,
        },
        signal: request.signal,
      } satisfies SafeUpstreamOpenRequest);
    } catch (error) {
      if (isRemoteReadFailure(error)) {
        if (error.code === 'SOURCE_IDLE_TIMEOUT' || error.code === 'SOURCE_ABORTED') {
          return { kind: 'timeout' };
        }
        if (error.code === 'SOURCE_BUDGET_EXCEEDED' && Date.now() >= request.deadlineMs) {
          return { kind: 'timeout' };
        }
      }
      return { kind: 'unavailable' };
    }
    const latencyMs = Date.now() - startedAtMs;
    // 首清单判定:HLS 清单首行锚(#EXTM3U);只读首字节,清单内容零下发
    const head = read.bytes.subarray(0, 7).toString('utf8');
    if (head.startsWith('#EXTM3U')) {
      return { kind: 'reachable', latencyMs };
    }
    const contentType = (read.contentType ?? '').toLowerCase();
    if (contentType.includes('mpegurl')) {
      return { kind: 'incompatible' };
    }
    return { kind: 'unavailable' };
  };
}

/**
 * T070 候选绑定 → 物化目标桥(module 装配;I1 候选物化贯通的缺失生产面):
 * candidateRef 经 VodCache 注册表反查 T070 签发的候选绑定载荷(kind='preview',
 * TTL 60s,绑定原 session/generation),键/事实全为服务端事实(与 T028 preview
 * 同形态;私有定位只进 validated_private_payload,绝不进公共 DTO),同事务仍受
 * CAS/策略/配额全量重验(物化用例内)。非 T070 签发 ref 返回 undefined,回落
 * 基础解析桥(登记目标注册表,D 组 rig 面;生产零注册)。
 */
function createSwitchCandidateBindingBridge(input: {
  readonly cache: VodCache;
  readonly sourceConfig: VodSourceConfigurationPort;
  readonly noteTitleFacts: (householdId: string, sourceId: string, upstreamVodId: string, facts: MaterializedTitleFacts) => void;
}): (householdId: string, command: Extract<MaterializeCommand, { kind: 'candidateRef' }>) => ResolvedMaterializationTarget | undefined {
  return (householdId, command) => {
    // T070 绑定条目以 candidateRef 为 id 直存于缓存注册表(T070 签发形态;与 T031
    // resolveStableTarget 的 titleRef 直读同形)
    const view = input.cache.get<VodCandidateBindingPayload>(command.candidateRef);
    const payload = view?.payload;
    if (
      view === undefined ||
      payload === undefined ||
      payload.kind !== 'candidate-binding' ||
      view.householdId !== householdId ||
      view.kind !== 'preview' ||
      view.expired
    ) {
      return undefined;
    }
    // 来源健康门(禁源/配置失配先失效缓存再 410;对齐 T028 preview 语义)
    const enabled = input.sourceConfig
      .listEnabledVodSources(householdId)
      .find((endpoint) => endpoint.sourceId === payload.sourceId);
    const currentRevision = input.sourceConfig.readLocatorRevision(householdId, payload.sourceId);
    const adapter = input.sourceConfig.findSourceConfig(householdId, payload.sourceId)?.adapter;
    if (
      enabled === undefined ||
      enabled.locatorRevision !== payload.locatorRevision ||
      currentRevision !== payload.locatorRevision ||
      adapter !== 'apple-cms-json'
    ) {
      input.cache.invalidateSource(householdId, payload.sourceId);
      throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED, '候选引用已过期,请重新获取候选');
    }
    input.noteTitleFacts(householdId, payload.sourceId, payload.upstreamVodId, {
      title: payload.title,
      year: payload.year,
    });
    const locatorEntries = payload.lines.map((line) => ({
      lineKey: line.lineKey,
      name: line.lineLabel,
      episodes: line.episodes.map((episode) => ({
        episodeKey: episode.episodeKey,
        locatorUrl: episode.locatorUrl,
      })),
    }));
    return {
      sourceId: payload.sourceId,
      upstreamVodId: payload.upstreamVodId,
      lineKey: payload.lineKey,
      episodeKey: payload.episodeKey,
      previewRevision: payload.previewRevision,
      previewExpiresAt: new Date(view.expiresAtMs).toISOString(),
      candidate: { sourceSessionId: payload.fromSessionId, sourceGeneration: payload.sourceGeneration },
      detail: {
        detailRevision: payload.previewRevision,
        locatorRevision: payload.locatorRevision,
        title: payload.title,
        description: null,
        parentContentLevel: null,
        payloadDigest: createHash('sha256').update(JSON.stringify(locatorEntries)).digest('hex'),
        validatedPrivatePayload: JSON.stringify({ kind: 'vod-detail-private', lines: locatorEntries }),
        fetchedAt: new Date(payload.fetchedAtMs).toISOString(),
        expiresAt: new Date(view.expiresAtMs).toISOString(),
        lines: payload.lines.map((line, lineIndex) => ({
          lineKey: line.lineKey,
          displayName: line.lineLabel,
          sortOrder: lineIndex + 1,
          episodes: line.episodes.map((episode, episodeIndex) => {
            const ordinalMatch = /\d+/.exec(episode.episodeKey);
            const parsed = ordinalMatch === null ? Number.NaN : Number.parseInt(ordinalMatch[0] ?? '', 10);
            return {
              episodeKey: episode.episodeKey,
              label: episode.label,
              ordinal: Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : episodeIndex + 1,
              seasonKey: null,
              sequenceRevision: 1,
              sequenceStatus: 'ordered' as const,
              contentLevel: null,
              contentVersionState: 'unverified' as const,
              evidenceKind: null,
              evidenceDigest: null,
              schemaVersion: null,
              continuityRevision: null,
              continuitySignature: null,
            };
          }),
        })),
      },
    };
  };
}

/* ------------------------------------------------------------------ */
/* 缓存生命周期(工厂 + dispose 钩子;对齐仓库 onModuleDestroy 惯例)      */
/* ------------------------------------------------------------------ */

@Injectable()
export class VodCacheLifecycle implements OnModuleDestroy, OnApplicationShutdown {
  constructor(@Inject(VOD_CACHE) private readonly cache: VodCache) {}

  onModuleDestroy(): void {
    this.cache.dispose();
  }

  onApplicationShutdown(): void {
    this.cache.dispose();
  }
}

/**
 * T084 vod 保留清扫节拍引导(装配/节拍最小):就绪库上武装每日清扫链(VodRetentionService
 * 内置启动首拍追赶 + 24h 间隔;停止路径由该服务的 onApplicationShutdown 停转 —— 与
 * playback 侧 PlaybackBootstrapper→PlaybackRetentionService 同款)。清扫本体:
 * 过期登记候选(与过期物化 operation 联合回收)→ 过期 operation → 过期偏好 operation
 * (不删偏好)→ 物化 24h 保护窗满标题组按引用图整组清理(data-model §4/§9/§10;
 * 历史与偏好行永不在删除面 —— 「schema 不能靠删除历史释放配额」)。清扫入口独立可测
 * (app.get(VodRetentionService).runRetentionSweep());未就绪形态库(升级中断/降级
 * 残留)不武装,healthz 仍以 503 拒绝 —— 与 T009 就绪门禁语义一致。
 */
@Injectable()
export class VodRetentionBootstrapper implements OnModuleInit {
  constructor(@Inject(VodRetentionService) private readonly retention: VodRetentionService) {}

  onModuleInit(): void {
    if (!Database.isReady()) {
      return;
    }
    this.retention.start();
  }
}

/* ------------------------------------------------------------------ */
/* 模块                                                                 */
/* ------------------------------------------------------------------ */

@Module({
  imports: [HttpCommonModule],
  controllers: [PublicVodController, VodMaterializationController, VodSwitchController],
  providers: [
    {
      // 010 T016:OnlineVodPublicationParticipant 事务参与者令牌绑定 —— 值为
      // TxStore 工厂(基础设施角色):每次 run 由平台 UnitOfWork 以同一连接
      // TransactionBinding 调用产出绑定实现;非 HTTP 发布面,实现类不出上下文。
      provide: ONLINE_VOD_PUBLICATION_PARTICIPANT,
      useValue: createOnlineVodTxParticipants,
    },
    {
      // 010 T027:ONLINE_VOD_STORE seam 绑定(对齐 SOURCES_STORE 惯例,ADR-0015 D1)
      // —— 非事务读面 Drizzle 实现(句柄随 Database 单例惰性解析,重开安全)。
      // (010 T090 knip 清理:原 bindOnlineVodStore seam 槽已删除——无读者,消费方
      // 全走 DI;本工厂行为不变)
      provide: ONLINE_VOD_STORE,
      useFactory: (): OnlineVodStore => drizzleOnlineVodStore(),
    },
    // 010 T019:运行期预算(env 只许收紧;DI 解析期读 env,per-rig 语义)
    vodConfigProvider(),
    {
      // 010 T028:VodCache 有界缓存单例(T028 服务与 T031 resolveTarget 桥同一实例;
      // 数值取 VodRuntimeConfig,只许收紧;TTL 固定 api §2 10min 契约值)
      provide: VOD_CACHE,
      inject: [VOD_RUNTIME_CONFIG],
      useFactory: (config: VodRuntimeConfig): VodCache =>
        createVodCache({
          maxTotalBytes: config.cache.maxTotalBytes,
          maxActiveSearchesPerHousehold: config.households.maxActiveSearchesPerHousehold,
          maxActivePreviewsPerHousehold: config.households.maxActivePreviewsPerHousehold,
        }),
    },
    {
      // 010 T028:公共搜索用例(轮转/去重/分页/并发合并;上游经 SafeUpstream+解析)
      provide: VOD_SEARCH_SERVICE,
      inject: [VOD_RUNTIME_CONFIG, VOD_CACHE, SAFE_UPSTREAM_PORT],
      useFactory: (config: VodRuntimeConfig, cache: VodCache, safeUpstream: SafeUpstreamPort) => {
        const sourceConfig = createVodSourceConfigurationPort();
        return createVodSearchService({
          config,
          cache,
          sourceConfig,
          searchUpstream: createSearchUpstream(safeUpstream, sourceConfig, config),
        });
      },
    },
    {
      // 010 T028:公共预览用例(绑定 → 详情快照;缓存命中重放逐字段不变)
      provide: VOD_PREVIEW_SERVICE,
      inject: [VOD_RUNTIME_CONFIG, VOD_CACHE, SAFE_UPSTREAM_PORT],
      useFactory: (config: VodRuntimeConfig, cache: VodCache, safeUpstream: SafeUpstreamPort) => {
        const sourceConfig = createVodSourceConfigurationPort();
        return createVodPreviewService({
          config,
          cache,
          sourceConfig,
          fetchDetail: createDetailUpstream(safeUpstream, sourceConfig, config),
        });
      },
    },
    {
      // 海报代理(posterRef → 私有 posterUrl → SafeUpstream 有界读取;许可列表
      // 与搜索/详情同一 getConfig().LAN_ALLOWED_TARGETS 口径)
      provide: VOD_POSTER_SERVICE,
      inject: [VOD_CACHE, SAFE_UPSTREAM_PORT],
      useFactory: (cache: VodCache, safeUpstream: SafeUpstreamPort) =>
        createVodPosterService({ cache, safeUpstream, allowedTargets: getConfig().LAN_ALLOWED_TARGETS }),
    },
    {
      // 010 T029/T031:物化装配束(uow + 有效媒体策略端口 + 净配额 + 非事务预查 +
      // 事务内同连接 revision 读数 + resolveTarget 桥 + 会话上下文版本读)。
      // readCatalogRevision/readProfileContextVersion 为组合根级同连接读
      // (better-sqlite3 事务为连接级,同连接语句自然参与事务),语句单一事实源
      // 归各所有者仓储,此处只读投影,不写任何他上下文表。
      // T070/T071 挂载:resolveTarget 桥经 VOD_SWITCH_WIRING 增加「T070 候选绑定
      // 分支」(I1 候选物化贯通)与「物化预览事实登记」(缺签名标题的候选检索事实)。
      provide: VOD_MATERIALIZATION,
      inject: [UNIT_OF_WORK, VOD_RUNTIME_CONFIG, VOD_CACHE, ONLINE_VOD_STORE, SAFE_UPSTREAM_PORT, VOD_SWITCH_WIRING],
      useFactory: (
        uow: MaterializationServiceDeps['uow'],
        config: VodRuntimeConfig,
        cache: VodCache,
        store: OnlineVodStore,
        // 010 恢复:物化解析走预览缓存/登记桥(零网络),SAFE_UPSTREAM_PORT 仅保持
        // 依赖面声明(候选签发贯通 T070 后复用);未用参数以 _ 前缀声明(eslint 口径)。
        _safeUpstream: SafeUpstreamPort,
        switchWiring: VodSwitchWiring,
      ): VodMaterializationAssembly => {
        const sourceConfig = createVodSourceConfigurationPort();
        const deps: MaterializationServiceDeps = {
          uow,
          // T017 端口:领域纯函数提升(发布端口=领域纯函数;父子事实构造在服务内)
          effectiveMediaPolicy: {
            evaluate: (input) => evaluateEffectiveMediaPolicy(input.policy, input.facts),
          },
          quotas: {
            maxParentTitles: config.catalog.maxParentTitles,
            maxChildEpisodes: config.catalog.maxChildEpisodes,
          },
          // 提交时 revision 读数(catalog_state;无行视为初版 1;同连接即事务内读)
          readCatalogRevision: (householdId) =>
            (
              Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
                | { revision: number }
                | undefined
            )?.revision ?? 1,
          // 非事务幂等预查(ONLINE_VOD_STORE seam;只认 committed_at 非空)
          findCommittedOperation: (householdId, deviceSessionId, profileContextVersion, operationKey) =>
            store.findCommittedOperation(householdId, deviceSessionId, profileContextVersion, operationKey),
          nowIso: () => new Date().toISOString(),
        };
        const resolveBase = createVodMaterializationTargetResolver({ cache, store, sourceConfig });
        // T070/T071 解析桥挂载:候选分支先经 T070 绑定(缓存注册表反查;生产签发面),
        // 未命中回落基础桥(登记目标注册表;D 组 rig 面,生产零注册);稳定分支解析
        // 成功后登记物化预览事实(缺签名标题的候选检索事实投影源)。
        const resolveTarget: MaterializeTargetResolver = async (command, context) => {
          if (command.kind === 'candidateRef') {
            const bound = switchWiring.resolveCandidateBindingTarget(context.householdId, command);
            if (bound !== undefined) {
              return bound;
            }
          }
          const target = await resolveBase(command, context);
          if (command.kind === 'stableRef') {
            switchWiring.noteMaterializedTitleFacts(context.householdId, command.titleRef, cache, target);
          }
          return target;
        };
        return {
          deps,
          resolveTarget,
          readProfileContextVersion: (deviceSessionId: string): number => {
            const row = Database.db
              .prepare('SELECT profile_context_version AS v FROM device_session WHERE id = ?')
              .get(deviceSessionId) as { v: number } | undefined;
            if (row === undefined) {
              // 会话已被撤销/清理(守卫后竞态):按未认证同形拒绝
              throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
            }
            return row.v;
          },
        };
      },
    },
    {
      // 010 T070/T071:换源路由装配束(VodSwitchController 构造器内直构候选/测速
      // 用例)。VodCache 与 T028/T070 同一单例;上游读取复用 T028 SafeUpstream 工厂
      // 形态(候选检索显式 pg=1,见 appleCmsSwitchSearchUrl);来源会话授权为
      // playback_session 只读投影(PlaybackTransitionSourcePort 消费面,不 import
      // playback 私有实现);物化预览事实投影为本 provider 进程内有界登记。
      provide: VOD_SWITCH_WIRING,
      inject: [VOD_RUNTIME_CONFIG, VOD_CACHE, ONLINE_VOD_STORE, SAFE_UPSTREAM_PORT],
      useFactory: (config: VodRuntimeConfig, cache: VodCache, store: OnlineVodStore, safeUpstream: SafeUpstreamPort): VodSwitchWiring => {
        const sourceConfig = createVodSourceConfigurationPort();
        // 物化标题预览事实投影(进程内、有界、插入序淘汰;重启即清,零持久化)
        const titleFacts = new Map<string, MaterializedTitleFacts>();
        const noteTitleFacts = (
          householdId: string,
          sourceId: string,
          upstreamVodId: string,
          facts: MaterializedTitleFacts,
        ): void => {
          if (facts.title.trim().length === 0) return;
          const key = `${householdId}\u0000${sourceId}\u0000${upstreamVodId}`;
          if (!titleFacts.has(key) && titleFacts.size >= MATERIALIZED_TITLE_FACTS_MAX) {
            const oldest = titleFacts.keys().next();
            if (!oldest.done) titleFacts.delete(oldest.value);
          }
          titleFacts.set(key, facts);
        };
        return {
          config,
          probeBudgets: SWITCH_PROBE_BUDGETS,
          cache,
          sourceConfig,
          switchSearchUpstream: createSearchUpstream(safeUpstream, sourceConfig, config, appleCmsSwitchSearchUrl),
          fetchDetailUpstream: createDetailUpstream(safeUpstream, sourceConfig, config),
          probeUpstream: createSwitchProbeUpstream(safeUpstream),
          transitionSource: createSwitchTransitionSourcePort(),
          loadSourceTitleFacts: createSwitchSourceTitleFactsLoader(store, titleFacts),
          policyGate: createSwitchProbePolicyGate(),
          store,
          authorizeSwitchSource: (input) => {
            const row = readSwitchSourceRow(input.householdId, input.fromSessionId);
            if (
              row === undefined ||
              row.deviceSessionId !== input.deviceSessionId ||
              row.profileId !== input.profileId ||
              row.profileContextVersion !== input.profileContextVersion ||
              // 代次失配与未授权同形 404(api §0「旧上下文按既有 404 同形」)
              row.generation !== input.expectedGeneration
            ) {
              throw switchSourceNotFound();
            }
            return {
              fromSessionId: row.id,
              generation: row.generation,
              state: row.state,
              mediaId: row.mediaId,
              endedAt: row.endedAt,
            };
          },
          readProfileContextVersion: (deviceSessionId: string): number => {
            const row = Database.db
              .prepare('SELECT profile_context_version AS v FROM device_session WHERE id = ?')
              .get(deviceSessionId) as { v: number } | undefined;
            if (row === undefined) {
              throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
            }
            return row.v;
          },
          resolveCandidateBindingTarget: createSwitchCandidateBindingBridge({
            cache,
            sourceConfig,
            noteTitleFacts,
          }),
          noteMaterializedTitleFacts: (householdId, titleRef, previewCache, target) => {
            // 稳定分支:物化成功解析后登记预览快照的 title/year 服务端事实
            const payload = previewCache.get<Record<string, unknown>>(titleRef)?.payload;
            if (payload === undefined || payload['kind'] !== 'title-preview') return;
            const title = payload['title'];
            const year = payload['year'];
            noteTitleFacts(householdId, target.sourceId, target.upstreamVodId, {
              title: typeof title === 'string' ? title : '',
              year: typeof year === 'string' ? year : null,
            });
          },
        };
      },
    },
    {
      // 010 T084:vod 保留清扫(过期幂等/候选/偏好 operation 回收 + 24h 窗满组引用图
      // 整组清理)。store 为 application/vod-retention.service.ts 声明的 VodRetentionStore
      // 结构端口,绑定 drizzleVodRetentionStore(句柄随 Database 单例惰性解析,重开安全);
      // 节拍由 VodRetentionBootstrapper 在就绪库上武装(启动首拍追赶 + 每日间隔)。
      provide: VodRetentionService,
      useFactory: () => new VodRetentionService({ store: drizzleVodRetentionStore() }),
    },
    // 010 T084:清扫节拍引导(就绪门禁;见类注释)
    VodRetentionBootstrapper,
    VodCacheLifecycle,
  ],
  // 010 T072(US4):仅放行 VodCache 单例令牌 —— playback.module 装配 transition 换源
  // 候选匹配结论读面(TransitionCandidateFactsPort 结构端口)所需;其余服务/实现类
  // 不出模块(报告注记:最小模块装配 seam,一行为改动)
  exports: [VOD_CACHE],
})
export class OnlineVodModule {}
