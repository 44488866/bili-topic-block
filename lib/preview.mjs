/**
 * preview 阶段：给一个视频链接，免登录地识别它大概在讲什么，
 * 并把「发过相关内容」的 UP 主聚合成候选名单。
 *
 * 本阶段**只读**：不发送任何凭据、不写任何文件、不调用任何写接口。
 *
 * @module bili-topic-block/lib/preview
 */

import { Pacer, RiskTracker } from './rate.mjs'
import { WbiKeyCache, getMixinKey } from './wbi.mjs'
import { rememberCandidates } from './seen.mjs'
import {
  BiliError,
  fetchBuvid,
  fetchRelated,
  fetchSearchVideos,
  fetchVideoTags,
  fetchVideoView,
  fetchWbiKeys,
  parseVideoRef,
  stripHtml,
  truncate,
} from './bili.mjs'

/** 每个候选最多保留几条样例标题。 */
const MAX_SAMPLE_TITLES = 3

/** 源视频标签最多回显几条。 */
const MAX_TAGS_IN_OUTPUT = 20

/** 描述摘要长度上限。 */
const DESC_EXCERPT_LIMIT = 200

/** 允许的工具参数名。 */
const ALLOWED_ARG_KEYS = Object.freeze(['url', 'max_candidates', 'keywords', 'include_source_uploader'])

/** 工具入参 schema（标准 JSON Schema，registry 直接消费）。 */
export const PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description: 'B 站视频链接、BV 号或 av 号。例如 https://www.bilibili.com/video/BV1GJ411x7h7 或 BV1GJ411x7h7。',
    },
    max_candidates: {
      type: 'integer',
      description: '本次预览最多返回多少个候选 UP 主（1–500；省略则用插件配置 maxCandidates）。',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '额外的搜索关键词，会与视频标签一起用于扩大候选范围（最多 10 个）。',
    },
    include_source_uploader: {
      type: 'boolean',
      description: '是否把源视频自己的 UP 主也计入候选（默认否，只找“其他人”）。',
    },
  },
  required: ['url'],
})

/** 工具输出 schema（标准 JSON Schema）。 */
export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bvid: { type: 'string' },
        aid: { type: 'integer' },
        title: { type: 'string' },
        uploader_mid: { type: 'integer' },
        uploader_name: { type: 'string' },
        tid: { type: 'integer' },
        tname: { type: 'string' },
        duration: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        desc_excerpt: { type: 'string' },
      },
      required: ['bvid', 'aid', 'title', 'uploader_mid', 'uploader_name', 'tid', 'tname', 'duration', 'tags', 'desc_excerpt'],
    },
    topic: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keywords: { type: 'array', items: { type: 'string' } },
        ignored_keywords: { type: 'array', items: { type: 'string' } },
        related_count: { type: 'integer' },
        search_used: { type: 'boolean' },
      },
      required: ['keywords', 'ignored_keywords', 'related_count', 'search_used'],
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mid: { type: 'integer' },
          name: { type: 'string' },
          hits: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          matched_keywords: { type: 'array', items: { type: 'string' } },
          sample_titles: { type: 'array', items: { type: 'string' } },
          uploader_home: { type: 'string' },
        },
        required: ['mid', 'name', 'hits', 'confidence', 'sources', 'matched_keywords', 'sample_titles', 'uploader_home'],
      },
    },
    stats: {
      type: 'object',
      additionalProperties: false,
      properties: {
        related_scanned: { type: 'integer' },
        search_scanned: { type: 'integer' },
        candidates_found: { type: 'integer' },
        candidates_returned: { type: 'integer' },
        excluded_source_uploader: { type: 'boolean' },
        risk_hits: { type: 'integer' },
        elapsed_ms: { type: 'integer' },
      },
      required: ['related_scanned', 'search_scanned', 'candidates_found', 'candidates_returned', 'excluded_source_uploader', 'risk_hits', 'elapsed_ms'],
    },
    warnings: { type: 'array', items: { type: 'string' } },
    plan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_block: { type: 'integer' },
        enforced: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['max_block', 'enforced', 'note'],
    },
  },
  required: ['ok', 'source', 'topic', 'candidates', 'stats', 'warnings', 'plan'],
})

/**
 * 校验并归一化工具入参。
 * @param args - 模型给出的原始参数。
 * @returns 归一化参数。
 * @throws {BiliError} 参数非法时抛出。
 */
export function validateArgs(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const issues = []

  for (const key of Object.keys(input)) {
    if (!ALLOWED_ARG_KEYS.includes(key)) issues.push(`未知参数 \`${key}\``)
  }

  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (url === '') issues.push('`url` 必填，且必须是非空字符串')

  let maxCandidates
  if (input.max_candidates !== undefined) {
    if (!Number.isInteger(input.max_candidates) || input.max_candidates < 1 || input.max_candidates > 500) {
      issues.push('`max_candidates` 必须是 1–500 之间的整数')
    } else {
      maxCandidates = input.max_candidates
    }
  }

  let keywords = []
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords) || input.keywords.some((item) => typeof item !== 'string')) {
      issues.push('`keywords` 必须是字符串数组')
    } else {
      keywords = input.keywords.map((item) => item.trim()).filter((item) => item !== '').slice(0, 10)
    }
  }

  let includeSourceUploader
  if (input.include_source_uploader !== undefined) {
    if (typeof input.include_source_uploader !== 'boolean') {
      issues.push('`include_source_uploader` 必须是布尔值')
    } else {
      includeSourceUploader = input.include_source_uploader
    }
  }

  if (issues.length > 0) {
    throw new BiliError(`参数无效：\n- ${issues.join('\n- ')}`, 'BILI_BAD_INPUT')
  }

  return { url, maxCandidates, keywords, includeSourceUploader }
}

/**
 * 候选累加器：按 mid 聚合命中的视频，按 bvid 去重。
 */
class CandidateBag {
  /** @type {Map<number, {mid: number, name: string, hits: number, sources: Set<string>, matched_keywords: Set<string>, sample_titles: string[], seen: Set<string>}>} */
  #items = new Map()

  /**
   * 记录一次命中。
   * @param entry - 命中信息。
   * @param entry.mid - UP 主 mid。
   * @param entry.name - UP 主昵称。
   * @param entry.source - 来源标记，如 `related` 或 `search`。
   * @param entry.keyword - 命中所用的关键词（可选）。
   * @param entry.title - 该视频标题。
   * @param entry.bvid - 该视频 BV 号，用于同一 UP 主去重。
   */
  add({ mid, name, source, keyword, title, bvid }) {
    const numericMid = Number(mid)
    if (!Number.isFinite(numericMid) || numericMid <= 0) return

    let entry = this.#items.get(numericMid)
    if (!entry) {
      entry = {
        mid: numericMid,
        name: typeof name === 'string' && name !== '' ? name : `mid ${numericMid}`,
        hits: 0,
        sources: new Set(),
        matched_keywords: new Set(),
        sample_titles: [],
        seen: new Set(),
      }
      this.#items.set(numericMid, entry)
    }

    if (typeof name === 'string' && name !== '' && entry.name === `mid ${numericMid}`) entry.name = name
    entry.sources.add(source)
    if (typeof keyword === 'string' && keyword !== '') entry.matched_keywords.add(keyword)

    const dedupeKey = typeof bvid === 'string' && bvid !== '' ? bvid : `${source}:${entry.hits}`
    if (entry.seen.has(dedupeKey)) return
    entry.seen.add(dedupeKey)
    entry.hits += 1

    const cleanTitle = stripHtml(title)
    if (cleanTitle !== '' && entry.sample_titles.length < MAX_SAMPLE_TITLES) entry.sample_titles.push(cleanTitle)
  }

  /** 聚合到的候选总数。 */
  get size() {
    return this.#items.size
  }

  /**
   * 输出排序、过滤后的候选列表。
   *
   * 置信度规则（写入 README，可解释、可预期）：
   * - high：**两个来源都命中**（相关推荐 + 搜索）。跨来源互证最强。
   * - medium：单一来源，但有多重佐证（命中 ≥2 条 或 命中 ≥2 个不同关键词）。
   * - low：单一来源且只有单条单关键词命中，最可能是噪声。
   *
   * 注意：不再把「相关推荐」单独当作高可信来源。反例（实测）：13 秒短视频种子的
   * 相关推荐会落进泛短视频池，把抽象鬼畜号排到真 AMV/MAD 创作者前面。
   *
   * @param options - 过滤选项。
   * @param options.excludeMid - 需要排除的 mid（源视频 UP 主）。
   * @param options.minHits - 最小命中数。
   * @param options.limit - 最多返回几条。
   * @returns 候选数组。
   */
  toList({ excludeMid, minHits, limit }) {
    const rank = { high: 0, medium: 1, low: 2 }
    const list = [...this.#items.values()]
      .filter((entry) => entry.mid !== excludeMid)
      .filter((entry) => entry.hits >= minHits)
      .map((entry) => {
        const keywordCount = entry.matched_keywords.size
        const hasRelated = entry.sources.has('related')
        const hasSearch = entry.sources.has('search')
        const corroborated = entry.hits >= 2 || keywordCount >= 2
        let confidence = 'low'
        if (hasRelated && hasSearch) confidence = 'high'
        else if (corroborated) confidence = 'medium'
        return { entry, confidence, keywordCount }
      })
      .sort((a, b) => (rank[a.confidence] - rank[b.confidence])
        || (b.entry.hits - a.entry.hits)
        || (a.entry.mid - b.entry.mid))
      .slice(0, limit)
      .map(({ entry, confidence }) => ({
        mid: entry.mid,
        name: entry.name,
        hits: entry.hits,
        confidence,
        sources: [...entry.sources].sort(),
        matched_keywords: [...entry.matched_keywords].sort(),
        sample_titles: entry.sample_titles,
        uploader_home: `https://space.bilibili.com/${entry.mid}`,
      }))
    return list
  }
}

/**
 * 执行一次预览（工具 execute 的实体，亦供自检脚本直接调用）。
 * @param settings - 已归一化的插件配置。
 * @param args - 工具入参。
 * @param exec - 工具执行上下文（可空，self-test 时传 `{}`）。
 * @returns 与 {@link OUTPUT_SCHEMA} 一致的结果对象。
 * @throws {BiliError} 种子视频不可用时抛出。
 */
export async function runPreview(settings, args, exec = {}) {
  const startedAt = Date.now()
  const warnings = []
  const signal = exec?.signal
  const timeoutMs = settings.requestTimeoutMs

  const parsed = validateArgs(args)
  const ref = parseVideoRef(parsed.url)
  const maxCandidates = parsed.maxCandidates ?? settings.maxCandidates
  const includeSourceUploader = parsed.includeSourceUploader ?? settings.includeSourceUploader

  const pacer = new Pacer({ minDelayMs: settings.requestMinDelayMs, maxDelayMs: settings.requestMaxDelayMs })
  const risk = new RiskTracker()
  const wbiKeys = new WbiKeyCache()
  const requestOptions = { timeoutMs, signal }

  // 1) 种子视频元数据。这一步失败就没有继续的意义，直接抛出。
  const view = await pacer.run(() => fetchVideoView(ref, requestOptions), signal)
  risk.record(0)

  const sourceBvid = String(view?.bvid ?? ref.bvid ?? '')
  const sourceMid = Number(view?.owner?.mid ?? 0)
  const sourceName = String(view?.owner?.name ?? '')

  if (!sourceBvid) {
    throw new BiliError('video/view 未返回 bvid，无法继续', 'BILI_BAD_RESPONSE')
  }

  const pageCount = Array.isArray(view?.pages) ? view.pages.length : 1
  if (ref.page > pageCount) {
    warnings.push(`请求的分 P p=${ref.page} 超出该视频的分 P 数（${pageCount}），本次按第 1 P 处理。`)
  }

  // 2) 标签（非致命）。
  let tags = []
  try {
    const rawTags = await pacer.run(() => fetchVideoTags({ bvid: sourceBvid }, requestOptions), signal)
    risk.record(0)
    tags = rawTags
      .map((item) => (typeof item?.tag_name === 'string' ? item.tag_name.trim() : ''))
      .filter((item) => item !== '')
    if (tags.length > MAX_TAGS_IN_OUTPUT) {
      warnings.push(`该视频有 ${tags.length} 个标签，输出中只保留前 ${MAX_TAGS_IN_OUTPUT} 个。`)
    }
  } catch (error) {
    risk.record(error instanceof BiliError ? error.detail?.code ?? 0 : 0)
    warnings.push(`取标签失败（${describeError(error)}），已降级为仅用标题/相关推荐。`)
  }

  // 种子内容信号体检：信号太弱时必须明说，而不是照样给出一份看起来很确信的名单。
  const weakReasons = []
  const durationSec = Number(view?.duration ?? 0)
  if (durationSec > 0 && durationSec < 60) weakReasons.push(`时长仅 ${durationSec} 秒`)
  if (tags.length <= 2) weakReasons.push(`可用标签仅 ${tags.length} 个`)
  const descText = String(view?.desc ?? '').trim()
  if (descText === '' || descText === '-') weakReasons.push('简介为空')
  if (weakReasons.length >= 2) {
    warnings.push(
      `⚠ 该视频内容信号很弱（${weakReasons.join('、')}）：B 站的「相关推荐」对短视频会落进泛短视频池、`
      + '而不是同题材创作区，related 来源的候选可能整体跑偏。'
      + '请优先看 cross-source（相关推荐 + 搜索都命中）的候选，或换一个内容更实的视频作种子。',
    )
  }

  // 3) 相关推荐：免登录、免签名，一次约 40 条且带 owner.mid，是候选主力来源。
  const bag = new CandidateBag()
  let relatedScanned = 0
  try {
    const related = await pacer.run(() => fetchRelated({ bvid: sourceBvid }, requestOptions), signal)
    risk.record(0)
    relatedScanned = related.length
    for (const item of related) {
      bag.add({
        mid: item?.owner?.mid,
        name: item?.owner?.name,
        source: 'related',
        title: item?.title,
        bvid: item?.bvid,
      })
    }
  } catch (error) {
    risk.record(error instanceof BiliError ? error.detail?.code ?? 0 : 0)
    warnings.push(`取相关推荐失败（${describeError(error)}）。`)
  }

  // 4) 关键词搜索：需要 WBI 签名 + buvid，免登录；逐关键词、逐页串行，命中风控立即收手。
  const explicitKeywords = parsed.keywords
  const keywordPool = dedupe([...explicitKeywords, ...tags])

  // 宽泛分类词会带进大量无关视频（实测：解说→LOL教学、经典→经典港片、LIVE→电音节），
  // 因此按配置的忽略表剔除；被剔除的词会回显，不静默丢弃。
  const ignoreSet = new Set((settings.ignoreKeywords ?? []).map((item) => item.toLowerCase()))
  const keptKeywords = []
  const ignoredKeywords = []
  for (const keyword of keywordPool) {
    if (ignoreSet.has(keyword.toLowerCase())) ignoredKeywords.push(keyword)
    else keptKeywords.push(keyword)
  }
  // 全部关键词都被忽略时，默认**不再**退回用标题去搜：实测长标题里的口语化短语
  // 会字面命中无关视频（例如命中某个游戏招式），比只用相关推荐更差。
  let effectiveKeywords = keptKeywords
  if (effectiveKeywords.length === 0 && settings.useTitleAsKeywordFallback) {
    effectiveKeywords = [truncate(String(view?.title ?? ''), 40)].filter((item) => item !== '')
    if (effectiveKeywords.length > 0) {
      warnings.push('该视频的标签全部在忽略表里，已按配置退回用标题当关键词；实测标题含点击诱饵短语时字面命中会引入无关视频，慎用。')
    }
  }
  const keywords = effectiveKeywords.slice(0, settings.maxKeywords)

  if (ignoredKeywords.length > 0) {
    warnings.push(`已跳过 ${ignoredKeywords.length} 个宽泛关键词（${ignoredKeywords.join('、')}），它们会把无关视频带进候选；可在配置 ignoreKeywords 中调整。`)
  }
  if (keywords.length === 0 && ignoredKeywords.length > 0) {
    warnings.push('已无可用关键词，本次只用「相关推荐」找候选（不会用标题去搜）。如需改变，可调 ignoreKeywords，或把 useTitleAsKeywordFallback 设为 true。')
  }

  let searchScanned = 0
  let searchUsed = false

  if (settings.enableKeywordSearch && settings.searchPages > 0 && keywords.length > 0) {
    let buvidCookie = ''
    try {
      const buvid = await pacer.run(() => fetchBuvid(requestOptions), signal)
      risk.record(0)
      buvidCookie = buvid.cookie
    } catch (error) {
      risk.record(error instanceof BiliError ? error.detail?.code ?? 0 : 0)
      warnings.push(`申请匿名设备指纹失败（${describeError(error)}），已跳过关键词搜索。`)
    }

    if (buvidCookie !== '') {
      let mixinKey = ''
      try {
        const keys = await wbiKeys.get(() => pacer.run(() => fetchWbiKeys(requestOptions), signal))
        mixinKey = getMixinKey(keys.imgKey, keys.subKey)
      } catch (error) {
        warnings.push(`获取 WBI 口令失败（${describeError(error)}），已跳过关键词搜索。`)
      }

      if (mixinKey !== '') {
        search:
        for (const keyword of keywords) {
          for (let page = 1; page <= settings.searchPages; page += 1) {
            try {
              const results = await pacer.run(
                () => fetchSearchVideos(
                  { keyword, page },
                  { ...requestOptions, cookie: buvidCookie, mixinKey },
                ),
                signal,
              )
              risk.record(0)
              searchUsed = true
              searchScanned += results.length
              for (const item of results) {
                bag.add({
                  mid: item?.mid,
                  name: item?.author,
                  source: 'search',
                  keyword,
                  title: item?.title,
                  bvid: item?.bvid,
                })
              }
            } catch (error) {
              const code = error instanceof BiliError ? error.detail?.code ?? 0 : 0
              const consecutive = risk.record(code)
              warnings.push(`关键词「${keyword}」第 ${page} 页搜索失败：${describeError(error)}`)
              if (error instanceof BiliError && error.code === 'BILI_RISK_CONTROL') {
                warnings.push('搜索已触发风控，本次预览停止继续检索（相关推荐结果仍然有效）。')
                break search
              }
              if (consecutive >= 2) {
                warnings.push('连续两次失败，本次预览停止继续检索。')
                break search
              }
            }
          }
        }
      }
    }
  }

  const candidatesFound = bag.size
  const candidates = bag.toList({
    excludeMid: includeSourceUploader ? -1 : sourceMid,
    minHits: settings.candidateMinHits,
    limit: maxCandidates,
  })

  if (!includeSourceUploader && sourceMid > 0) {
    warnings.push(`已排除源视频 UP 主「${sourceName || sourceMid}」(mid ${sourceMid})；如需一并处理请传 include_source_uploader=true。`)
  }
  if (candidatesFound > candidates.length) {
    warnings.push(`聚合到 ${candidatesFound} 个候选，按上限/阈值筛选后返回 ${candidates.length} 个。`)
  }

  // 登记本次返回过的 mid，供 block 阶段做防幻觉校验。
  rememberCandidates(candidates)

  return {
    ok: true,
    source: {
      bvid: sourceBvid,
      aid: Number(view?.aid ?? 0),
      title: String(view?.title ?? ''),
      uploader_mid: sourceMid,
      uploader_name: sourceName,
      tid: Number(view?.tid ?? 0),
      tname: String(view?.tname ?? ''),
      duration: Number(view?.duration ?? 0),
      tags: tags.slice(0, MAX_TAGS_IN_OUTPUT),
      desc_excerpt: truncate(stripHtml(String(view?.desc ?? '')), DESC_EXCERPT_LIMIT),
    },
    topic: {
      keywords,
      ignored_keywords: ignoredKeywords,
      related_count: relatedScanned,
      search_used: searchUsed,
    },
    candidates,
    stats: {
      related_scanned: relatedScanned,
      search_scanned: searchScanned,
      candidates_found: candidatesFound,
      candidates_returned: candidates.length,
      excluded_source_uploader: !includeSourceUploader && sourceMid > 0,
      risk_hits: risk.total,
      elapsed_ms: Date.now() - startedAt,
    },
    warnings,
    plan: {
      max_block: settings.maxBlock,
      enforced: true,
      note: 'block 阶段已实现：该上限由 bili_topic_block 强制执行，达到即停、绝不超量。',
    },
  }
}

/**
 * 去重并保持顺序。
 * @param values - 字符串列表。
 * @returns 去重结果。
 */
function dedupe(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const key = String(value ?? '').trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * 把异常压成一行说明。
 * @param error - 任意异常。
 * @returns 说明文本。
 */
function describeError(error) {
  if (error instanceof BiliError) return `${error.code}: ${error.message}`
  return String(error?.message ?? error)
}

/**
 * 把结果渲染成给模型看的文本。
 * @param value - {@link runPreview} 的返回值。
 * @returns 文本。
 */
export function renderPreviewText(value) {
  if (value === null || typeof value !== 'object') return '预览失败：结果为空。'

  const lines = []
  const source = value.source ?? {}
  lines.push(`源视频：${source.title || '(无标题)'}`)
  lines.push(`  BV=${source.bvid} UP=${source.uploader_name || source.uploader_mid} (mid ${source.uploader_mid}) 分区=${source.tname || source.tid} 时长=${source.duration}s`)
  if (Array.isArray(source.tags) && source.tags.length > 0) {
    lines.push(`  标签：${source.tags.join(' / ')}`)
  }
  const topic = value.topic ?? {}
  lines.push(`话题关键词：${(topic.keywords ?? []).join(' / ') || '(无)'}`)
  if (Array.isArray(topic.ignored_keywords) && topic.ignored_keywords.length > 0) {
    lines.push(`已跳过（宽泛词）：${topic.ignored_keywords.join(' / ')}`)
  }
  lines.push(`扫描：相关推荐 ${(value.stats ?? {}).related_scanned ?? 0} 条，搜索 ${(value.stats ?? {}).search_scanned ?? 0} 条`)

  const candidates = Array.isArray(value.candidates) ? value.candidates : []
  lines.push('')
  lines.push(`候选 UP 主共 ${candidates.length} 个（置信度优先，其次命中数）：`)
  lines.push('  置信度含义：high=相关推荐与搜索都命中（跨来源互证）；medium=单一来源但有多重佐证；low=单条单关键词，最可能是噪声')
  if (candidates.length === 0) {
    lines.push('  (无候选)')
  }
  const badge = { high: '高', medium: '中', low: '低（可能是噪声）' }
  for (const [index, item] of candidates.entries()) {
    const keywords = Array.isArray(item.matched_keywords) && item.matched_keywords.length > 0
      ? ` | 命中词=${item.matched_keywords.join(',')}`
      : ''
    lines.push(`  ${index + 1}. [${badge[item.confidence] ?? item.confidence}] mid=${item.mid} ${item.name} | 命中 ${item.hits} 条 | 来源=${(item.sources ?? []).join('+')}${keywords}`)
    for (const title of item.sample_titles ?? []) lines.push(`       例：${title}`)
  }

  const warnings = Array.isArray(value.warnings) ? value.warnings : []
  if (warnings.length > 0) {
    lines.push('')
    lines.push('警告：')
    for (const warning of warnings) lines.push(`  - ${warning}`)
  }

  lines.push('')
  lines.push(`下一步：请让用户在以上候选里勾选/撤销，确认后再执行拉黑。plan.max_block=${value.plan?.max_block}（${value.plan?.note ?? ''}）`)
  return lines.join('\n')
}

/**
 * 在 `ctx.tools` 上注册 `bili_topic_preview`。
 * @param ctx - 携带 `tools` 服务的插件上下文。
 * @param settings - 已归一化的插件配置。
 * @returns 注销该工具的函数（供 `ctx.effect` 收尾）。
 */
export function registerPreviewTool(ctx, settings) {
  return ctx.tools.register({
    name: 'bili_topic_preview',
    description:
      '预览：给一个 B 站视频链接，免登录只读地识别它大概在讲什么（标题/简介/标签/分区），'
      + '并返回「发过相关内容」的 UP 主候选名单（含 mid、命中条数、来源与样例标题）。'
      + '本工具不发送任何凭据、不修改任何账号状态。拉黑请先用本工具拿到候选、'
      + '交用户勾选确认，再调用 bili_topic_block（必须显式传 confirm=true；'
      + '先用 dry_run=true 预演最稳）。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderPreviewText(value) }],
    },
    execute: (args, exec) => runPreview(settings, args, exec),
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: '预览相关 UP 主',
      kind: 'fetch',
      rawInput: { url: args?.url },
    }),
    timeoutMs: 240000,
  })
}
