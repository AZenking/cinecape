/**
 * 线路聚合消费端规则(010 T033;contracts/api.md §1 StableEpisodes 行 +
 * §2「线路可跨页重复，消费者按 lineRef 聚合，不能把每页线路当新线」)。
 *
 * 该规则钉在**消费端**(VodPreview 预览线路与 StableEpisodes 稳定分集共用):
 * - 上游把同一线路按页/按块重复下发,重复块的 episodes 是同一线路的后续分页,
 *   必须并入既有线路组(保持首次出现顺序),不得当新线路重复渲染;
 * - 同一线路组内按集引用(episodeRef/mediaId)去重,保持首次出现顺序;
 *   api.md §2「已生成页重放不变」保证同一 ref 的重复下发是同一集。
 */

/** 可聚合线路的最小形状(VodPreviewLine/StableEpisodeLine 均满足) */
export interface AggregatableLine<TEpisode> {
  lineRef: string;
  name: string;
  episodes: TEpisode[];
}

/** 聚合后的线路组:同 lineRef 合并为一组,组内集保持首次出现顺序且去重 */
export interface AggregatedLine<TEpisode> {
  lineRef: string;
  name: string;
  episodes: TEpisode[];
}

/** 取集的去重键(VodPreviewLine 用 episodeRef;StableEpisodeLine 用 mediaId) */
export function aggregateLines<TEpisode>(
  lines: readonly AggregatableLine<TEpisode>[],
  episodeKey: (episode: TEpisode) => string,
): Array<AggregatedLine<TEpisode>> {
  const byLineRef = new Map<string, AggregatedLine<TEpisode>>();
  for (const line of lines) {
    const existing = byLineRef.get(line.lineRef);
    if (existing === undefined) {
      byLineRef.set(line.lineRef, {
        lineRef: line.lineRef,
        name: line.name,
        episodes: [...line.episodes],
      });
      continue;
    }
    // 重复线路块:仅追加新出现的集,已有集(同 ref)不重复渲染
    const seen = new Set(existing.episodes.map(episodeKey));
    for (const episode of line.episodes) {
      if (!seen.has(episodeKey(episode))) {
        existing.episodes.push(episode);
        seen.add(episodeKey(episode));
      }
    }
  }
  return [...byLineRef.values()];
}
