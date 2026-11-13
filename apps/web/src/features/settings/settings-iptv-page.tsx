/**
 * IPTV 管理页(设置菜单拆分:来源管理中的 IPTV/EPG 来源 + 原「EPG 管理」聚合;
 * 018 IPTV 管理优化:HIG 层级 = 页头 → 紧凑 Tabs → 内容):
 *
 * - 标签页组织:直播源(iptv) / 节目单(epg) / 频道管理(matching,原 EPG 管理页);
 *   「直播源」挂来源清单(单类型视图:kind 徽标隐藏、手动导入改称立即同步);
 *   「节目单」挂 EPG 来源合并看板(SettingsEpgPriorities:来源清单 × 优先级按
 *   sourceId 合一,每源一行、停用源不缺行 —— 取代「清单 + 优先级」两列布局);
 *   「频道管理」挂频道表格(SettingsEpgPage,内嵌时隐藏冗余工作台标题与嵌套卡);
 * - 标签经 URL search 参数深链:?tab=epg / ?tab=matching;缺省直播源;切回缺省
 *   标签时清掉参数保持地址整洁(replace 不产生历史记录);
 * - 「新建来源」为页头唯一主操作(仅直播源/节目单标签;频道管理标签无页级主操作,
 *   一屏一主操作);创建弹层(CreateSourceModal)与来源管理页共用;创建成功给出
 *   「立即同步」下一步(与来源管理页同语义:幂等 operationKey,任务轮询与状态
 *   呈现由当前标签的内容组件按 lastJobId 自举承担);
 * - 直播源/节目单共享同一来源列表查询键(queryKeys.settings.sources),
 *   react-query 按键去重;Tabs 非激活面板不挂载,互不干扰本地状态。
 */
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Tabs } from '@heroui/react';
import { SettingsSourcesPage } from './settings-sources-page';
import { SettingsEpgPage } from './settings-epg-page';
import { SettingsEpgPriorities } from './settings-epg-priorities';
import { SettingsDataGovernance } from './settings-data-governance';
import { SettingsPageHeader } from './shared/settings-page-header';
import { CreateSourceModal, type SettingsSourceDto, type SettingsSourceKind } from './components/CreateSourceModal';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useAppToast } from '../../shared/ui';
import { useAppMutation } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { privateFetch } from '../../shared/fetch';
import type { RefreshDto } from './shared/settings-api';

/** 标签键(同时是 URL ?tab= 的合法取值) */
const IPTV_TAB_KEYS = ['iptv', 'epg', 'matching', 'governance'] as const;
type IptvTabKey = (typeof IPTV_TAB_KEYS)[number];

const DEFAULT_TAB: IptvTabKey = 'iptv';

function isIptvTabKey(value: string | null): value is IptvTabKey {
  return (IPTV_TAB_KEYS as readonly string[]).includes(value ?? '');
}

export function SettingsIptvPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: IptvTabKey = isIptvTabKey(rawTab) ? rawTab : DEFAULT_TAB;
  const [creatingKind, setCreatingKind] = useState<SettingsSourceKind | null>(null);
  const [createdSource, setCreatedSource] = useState<SettingsSourceDto | null>(null);
  const toast = useAppToast();

  // 创建表单打开即视为未保存编辑(FR-041 拦截)
  const guard = useUnsavedGuard(creatingKind !== null);

  // 创建后「立即同步」下一步:幂等 operationKey + expectedVersion CAS(与来源管理页
  // 同一语义);任务轮询与状态呈现由当前标签内容组件按 lastJobId 自举承担
  const startRefresh = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; expectedVersion: number; operationKey: string }) =>
      privateFetch<RefreshDto>(`/settings/sources/${vars.sourceId}/refresh`, {
        method: 'POST',
        body: { expectedVersion: vars.expectedVersion, operationKey: vars.operationKey },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  const runCreatedSync = (): void => {
    if (createdSource === null) {
      return;
    }
    void startRefresh
      .mutateAsync({
        sourceId: createdSource.id,
        expectedVersion: createdSource.version,
        operationKey:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      })
      .then((job) => {
        toast.success(`同步任务已创建(状态 ${job.status}),任务状态见列表行内呈现…`);
        setCreatedSource(null); // 下一步动作已完成
      })
      .catch(() => {
        // 其余拒绝经 useAppMutation toast 呈现;banner 保留可重试
      });
  };

  const tabDescription =
    activeTab === 'iptv'
      ? '管理 IPTV 直播播放列表(M3U)来源与同步任务'
      : activeTab === 'epg'
      ? '管理 EPG 节目单来源(XMLTV)、同步任务与匹配优先级'
      : activeTab === 'governance'
      ? '清理过期节目、失效线路、原始快照与归档来源'
      : '维护频道资产、聚合线路与节目单绑定的前台呈现';

  return (
    <div className="flex flex-1 flex-col gap-4">
      <SettingsPageHeader
        description={tabDescription}
        actions={
          activeTab === 'iptv' || activeTab === 'epg' ? (
            <Button
              variant="primary"
              size="sm"
              data-testid="create-source-open"
              onPress={() => setCreatingKind(activeTab === 'iptv' ? 'iptv' : 'epg')}
            >
              新建来源
            </Button>
          ) : null
        }
      />

      {createdSource !== null && creatingKind === null ? (
        <div
          className="flex flex-col gap-2 rounded-2xl border border-success/50 bg-success-soft p-4 text-sm"
          data-testid="source-created-next-step"
        >
          <p className="text-success">
            来源「{createdSource.name}」已创建。下一步:立即同步,拉取{createdSource.kind === 'epg' ? '节目单' : '直播频道'}内容。
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="source-start-sync"
              isPending={startRefresh.isPending}
              onPress={runCreatedSync}
            >
              立即同步
            </Button>
            <Button variant="ghost" size="sm" onPress={() => setCreatedSource(null)}>
              稍后再说
            </Button>
          </div>
        </div>
      ) : null}

      <Tabs
        selectedKey={activeTab}
        onSelectionChange={(key) => {
          // 缺省标签不带参数(地址整洁);其余标签写 ?tab= 供刷新/分享深链
          const next = String(key);
          if (next === DEFAULT_TAB) {
            setSearchParams({}, { replace: true });
          } else {
            setSearchParams({ tab: next }, { replace: true });
          }
        }}
        className="flex flex-1 flex-col gap-4"
      >
        <Tabs.ListContainer className="w-fit max-w-full self-start">
          <Tabs.List aria-label="IPTV 管理分区" className="w-fit max-w-full">
            <Tabs.Tab id="iptv" className="whitespace-nowrap">
              直播源
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="epg" className="whitespace-nowrap">
              节目单
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="matching" className="whitespace-nowrap">
              频道管理
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="governance" className="whitespace-nowrap">
              数据治理
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="iptv" className="flex flex-1 flex-col">
          <SettingsSourcesPage
            kinds={['iptv'] satisfies readonly SettingsSourceKind[]}
            hideHeader
            hideViewContent
          />
        </Tabs.Panel>
        <Tabs.Panel id="epg" className="flex flex-1 flex-col">
          <SettingsEpgPriorities />
        </Tabs.Panel>
        <Tabs.Panel id="matching" className="flex flex-1 flex-col">
          <SettingsEpgPage hideHeader />
        </Tabs.Panel>
        <Tabs.Panel id="governance" className="flex flex-1 flex-col">
          <SettingsDataGovernance />
        </Tabs.Panel>
      </Tabs>

      {creatingKind !== null ? (
        <CreateSourceModal
          allowedKinds={[creatingKind]}
          defaultKind={creatingKind}
          onCreated={(source) => {
            setCreatingKind(null);
            setCreatedSource(source);
          }}
          onCancel={() => setCreatingKind(null)}
        />
      ) : null}

      {guard.dialog}
    </div>
  );
}
