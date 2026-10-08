/**
 * 插件配置：手写的 StandardSchemaV1 校验器（零依赖）。
 *
 * Cordis 的 `resolveConfig` 会同步调用 `Config['~standard'].validate(row.config)`，
 * 并按返回的 `{ value }` 或 `{ issues }` 决定放行或抛 ValidationError，
 * 因此这里不引入 schemastery/zod，直接实现同一接口。
 *
 * @module bili-topic-block/lib/config
 */

/**
 * 默认忽略的关键词（**精确匹配**，不区分大小写）。
 *
 * 两类词都会把大量无关内容带进候选，实测证据写在 README：
 * - **宽泛分类词**：「解说」拉进英雄联盟教学、「经典」拉进经典港片与儿歌、
 *   「LIVE」拉进 EDC 电音节、「MV」拉进韩团 MV 合集。
 * - **抽象类目词**：一条标签为「社会/人文/思维/认知/年轻人/后代」的选题视频，
 *   靠「人文」把街拍系列刷出 15 条命中、靠「认知」拉进认知玄学号、
 *   靠「社会」拉进时政新闻号。剔除这 4 个词后这类噪声全部消失。
 *
 * 只影响**关键词搜索**，不影响「相关推荐」，也不影响 `source.tags` 的展示；
 * 被忽略的词会在输出 `topic.ignored_keywords` 里回报，不会静默丢弃。
 * @type {readonly string[]}
 */
export const DEFAULT_IGNORE_KEYWORDS = Object.freeze([
  // 宽泛分类词
  '解说',
  '电影解说',
  '影视解说',
  '影评杂谈',
  '经典',
  'MV',
  'LIVE',
  '现场',
  '音乐现场',
  '流行音乐',
  '欧美音乐',
  '欧美MV',
  '教程',
  '入门教程',
  // 抽象类目词
  '社会',
  '人文',
  '思维',
  '认知',
])

/** 字符串数组型配置的项数上限。 */
const STRING_LIST_LIMIT = 200

/**
 * 默认配置。`maxBlock` 属于 block 阶段契约，preview 只回显、暂不强制。
 * @type {Readonly<Record<string, unknown>>}
 */
export const DEFAULTS = Object.freeze({
  requestTimeoutMs: 20000,
  requestMinDelayMs: 1200,
  requestMaxDelayMs: 3500,
  enableKeywordSearch: true,
  searchPages: 1,
  maxKeywords: 6,
  ignoreKeywords: DEFAULT_IGNORE_KEYWORDS,
  useTitleAsKeywordFallback: false,
  includeSourceUploader: false,
  candidateMinHits: 1,
  maxCandidates: 60,
  // ---- block 阶段 ----
  maxBlock: 50,
  sessdataRef: 'BILIBILI_SESSDATA',
  csrfRef: 'BILI_JCT',
  batchSize: 50,
  batchRestMs: 60000,
  probeFailures: true,
  maxProbes: 10,
  riskCooldownHintMs: 600000,
})

/**
 * 整数型配置的取值范围。
 * @type {Readonly<Record<string, readonly [number, number]>>}
 */
const INT_RANGES = Object.freeze({
  requestTimeoutMs: [1000, 120000],
  requestMinDelayMs: [0, 60000],
  requestMaxDelayMs: [0, 60000],
  searchPages: [0, 2],
  maxKeywords: [0, 10],
  candidateMinHits: [1, 500],
  maxCandidates: [1, 500],
  maxBlock: [1, 500],
  // 文档规定 batch/modify 的 fids 最多 50 个，故上限锁死 50。
  batchSize: [1, 50],
  batchRestMs: [0, 600000],
  maxProbes: [0, 50],
  riskCooldownHintMs: [0, 86400000],
})

/** 凭据名允许的字符（避免把奇怪的值拼进 Cookie 头）。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9_]+$/

/**
 * 校验并归一化配置。
 * @param input - Loader 行上的 `config`（可能是 `{}`、`undefined` 或用户手写值）。
 * @returns 归一化后的配置对象。
 * @throws {Error} 当存在非法值时抛出，消息中带全部问题。
 */
export function normalizeConfig(input) {
  const result = validate(input)
  if (result.issues) {
    const lines = result.issues.map((issue) => (issue.path ? `  - ${issue.message}` : `  - ${issue.message}`))
    throw new Error(`bili-topic-block 配置无效：\n${lines.join('\n')}`)
  }
  return result.value
}

/**
 * 执行校验，返回标准 schema 形状的结果。
 * @param input - 待校验的原始配置。
 * @returns `{ value }` 或 `{ issues }`。
 */
function validate(input) {
  const issues = []
  const raw = input === undefined || input === null ? {} : input

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'config 必须是一个对象' }] }
  }

  // 先查未知键：防止 `maxblock` 这类拼写错误被静默忽略。
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      issues.push({ message: `未知配置项 \`${key}\`。可用项：${Object.keys(DEFAULTS).join(', ')}`, path: [key] })
    }
  }

  /** @type {Record<string, unknown>} */
  const value = { ...DEFAULTS }

  for (const [key, range] of Object.entries(INT_RANGES)) {
    const candidate = Object.hasOwn(raw, key) ? raw[key] : DEFAULTS[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) {
      issues.push({ message: `\`${key}\` 必须是整数，收到 ${JSON.stringify(candidate)}`, path: [key] })
      continue
    }
    const [min, max] = range
    if (candidate < min || candidate > max) {
      issues.push({ message: `\`${key}\` 必须在 ${min}–${max} 之间，收到 ${candidate}`, path: [key] })
      continue
    }
    value[key] = candidate
  }

  for (const key of ['enableKeywordSearch', 'includeSourceUploader', 'useTitleAsKeywordFallback', 'probeFailures']) {
    const candidate = Object.hasOwn(raw, key) ? raw[key] : DEFAULTS[key]
    if (typeof candidate !== 'boolean') {
      issues.push({ message: `\`${key}\` 必须是布尔值，收到 ${JSON.stringify(candidate)}`, path: [key] })
      continue
    }
    value[key] = candidate
  }

  for (const key of ['sessdataRef', 'csrfRef']) {
    const candidate = Object.hasOwn(raw, key) ? raw[key] : DEFAULTS[key]
    if (typeof candidate !== 'string' || !CREDENTIAL_REF_PATTERN.test(candidate)) {
      issues.push({ message: `\`${key}\` 只能由字母、数字与下划线组成，收到 ${JSON.stringify(candidate)}`, path: [key] })
      continue
    }
    value[key] = candidate
  }

  for (const key of ['ignoreKeywords']) {
    const candidate = Object.hasOwn(raw, key) ? raw[key] : DEFAULTS[key]
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== 'string')) {
      issues.push({ message: `\`${key}\` 必须是字符串数组`, path: [key] })
      continue
    }
    const cleaned = candidate.map((item) => item.trim()).filter((item) => item !== '')
    if (cleaned.length > STRING_LIST_LIMIT) {
      issues.push({ message: `\`${key}\` 最多 ${STRING_LIST_LIMIT} 项，收到 ${cleaned.length}`, path: [key] })
      continue
    }
    value[key] = cleaned
  }

  if (
    typeof value.requestMinDelayMs === 'number'
    && typeof value.requestMaxDelayMs === 'number'
    && value.requestMinDelayMs > value.requestMaxDelayMs
  ) {
    issues.push({
      message: `\`requestMinDelayMs\` (${value.requestMinDelayMs}) 不能大于 \`requestMaxDelayMs\` (${value.requestMaxDelayMs})`,
      path: ['requestMinDelayMs'],
    })
  }

  return issues.length > 0 ? { issues } : { value }
}

/**
 * 插件 Config：符合 StandardSchemaV1 的最小实现。
 * @type {{ '~standard': { version: 1, vendor: string, validate: (input: unknown) => unknown } }}
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'bili-topic-block',
    validate,
  },
}
