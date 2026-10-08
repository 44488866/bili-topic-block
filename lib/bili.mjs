/**
 * B 站只读 API 客户端（零依赖，仅用全局 fetch 与 node 内建能力）。
 *
 * 本模块**只包含读接口**：nav / finger.spi / view / tag / related / search。
 * 拉黑等写接口（`x/relation/modify`、`x/relation/batch/modify`）不在本阶段实现。
 *
 * 安全约定：一旦请求携带 Cookie（`cookie` 非空），强制 `redirect: 'error'`，
 * 避免凭据被重定向带到其他源。
 *
 * @module bili-topic-block/lib/bili
 */

import { keyFromUrl, signQuery } from './wbi.mjs'
import { isRiskCode, riskLabel } from './rate.mjs'

/** 接口根地址。 */
export const API_ORIGIN = 'https://api.bilibili.com'

/** 真实浏览器 UA；接口对无 UA / 类脚本 UA 更严格。 */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** B 站站点 Referer，风控会校验。 */
export const SITE_REFERER = 'https://www.bilibili.com/'

/**
 * 带符号错误码的接口错误。
 */
export class BiliError extends Error {
  /**
   * @param message - 人类可读的说明。
   * @param code - 符号化错误码，如 `BILI_RISK_CONTROL`。
   * @param detail - 附加信息（业务码、HTTP 状态等）。
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 把业务码翻译成结构化错误。
 * @param code - 接口返回的 `code`。
 * @param message - 接口返回的 `message`。
 * @param where - 出错位置描述。
 * @returns 对应的 {@link BiliError}。
 */
export function codeToError(code, message, where) {
  const value = Number(code)
  const suffix = message ? ` message=${message}` : ''
  if (value === -101) {
    return new BiliError(`${where}：需要登录（code -101${suffix}）`, 'BILI_LOGIN_REQUIRED', { code: value })
  }
  if (value === -403) {
    return new BiliError(`${where}：访问被拒绝（code -403${suffix}）`, 'BILI_FORBIDDEN', { code: value })
  }
  if (value === -404) {
    return new BiliError(`${where}：内容不存在（code -404${suffix}）`, 'BILI_NOT_FOUND', { code: value })
  }
  if (isRiskCode(value)) {
    return new BiliError(
      `${where}：触发风控（code ${value} ${riskLabel(value)}）`,
      'BILI_RISK_CONTROL',
      { code: value },
    )
  }
  return new BiliError(`${where}：接口返回 code ${value}${suffix}`, 'BILI_API_ERROR', { code: value, message })
}

/**
 * 合并多个 AbortSignal。
 * @param signals - 可能为空的信号列表。
 * @returns 合并后的信号；全空时返回 undefined。
 */
function combineSignals(signals) {
  const list = signals.filter((item) => item instanceof AbortSignal)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * 构造超时信号（优先用内建 `AbortSignal.timeout`）。
 * @param timeoutMs - 超时毫秒数。
 * @returns 信号。
 */
function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  return controller.signal
}

/**
 * 发起一次 GET 并解析 JSON 信封。
 *
 * @param path - 以 `/` 开头的接口路径。
 * @param options - 请求选项。
 * @param options.params - 查询参数。
 * @param options.cookie - 可选的 Cookie 头；非空时禁止重定向。
 * @param options.timeoutMs - 超时毫秒数。
 * @param options.signal - 调用方取消信号。
 * @param options.mixinKey - 提供时对参数做 WBI 签名。
 * @param options.referer - Referer 覆盖。
 * @returns `{ httpStatus, json, text }`。
 * @throws {BiliError} 网络/HTTP/解析失败时抛出。
 */
export async function apiGet(path, options = {}) {
  const {
    params = {},
    cookie,
    timeoutMs = 20000,
    signal,
    mixinKey,
    referer = SITE_REFERER,
  } = options

  const url = new URL(path, API_ORIGIN)
  if (mixinKey) {
    url.search = signQuery(params, mixinKey)
  } else {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  }

  /** @type {Record<string, string>} */
  const headers = {
    'User-Agent': BROWSER_UA,
    Referer: referer,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (cookie) headers.Cookie = cookie

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      // 携带凭据时拒绝重定向，避免 Cookie 被转发到其他源。
      redirect: cookie ? 'error' : 'follow',
      signal: combineSignals([signal, timeoutSignal(timeoutMs)]),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new BiliError(`${path}：请求被取消或超时`, 'BILI_REQUEST_CANCELLED', { cause: String(error?.message ?? '') })
    }
    const message = String(error?.message ?? error)
    if (/redirect/i.test(message)) {
      throw new BiliError(`${path}：响应试图重定向，已按凭据安全策略拒绝`, 'BILI_REDIRECT_REFUSED', { cause: message })
    }
    throw new BiliError(`${path}：网络请求失败（${message}）`, 'BILI_REQUEST_FAILED', { cause: message })
  }

  return finishResponse(path, response)
}

/**
 * 处理响应：HTTP 状态映射、JSON 解析、信封校验。
 * @param path - 接口路径（用于报错）。
 * @param response - fetch 的 Response。
 * @returns `{ httpStatus, json, text }`。
 * @throws {BiliError} 状态异常、非 JSON 或缺 code 字段时抛出。
 */
async function finishResponse(path, response) {
  const httpStatus = response.status
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    throw new BiliError(`${path}：读取响应体失败`, 'BILI_REQUEST_FAILED', { cause: String(error?.message ?? error) })
  }

  if (httpStatus === 412 || httpStatus === 429) {
    throw new BiliError(
      `${path}：HTTP ${httpStatus}，已被服务端风控拦截（常见原因：缺少 buvid Cookie 或 WBI 签名）`,
      'BILI_RISK_CONTROL',
      { httpStatus },
    )
  }
  if (httpStatus === 403) {
    throw new BiliError(`${path}：HTTP 403 访问被拒绝`, 'BILI_FORBIDDEN', { httpStatus })
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new BiliError(`${path}：HTTP ${httpStatus}`, 'BILI_HTTP_ERROR', { httpStatus })
  }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new BiliError(
      `${path}：响应不是 JSON（前 120 字符：${text.slice(0, 120)}）`,
      'BILI_BAD_RESPONSE',
      { httpStatus },
    )
  }
  if (json === null || typeof json !== 'object' || !Object.hasOwn(json, 'code')) {
    throw new BiliError(`${path}：响应信封缺少 code 字段`, 'BILI_BAD_RESPONSE', { httpStatus })
  }

  return { httpStatus, json, text }
}

/**
 * 发起一次 POST（`application/x-www-form-urlencoded`）并解析 JSON 信封。
 *
 * **写接口专用。** 与 {@link apiGet} 一样：只要携带 Cookie 就强制
 * `redirect: 'error'`，避免凭据被重定向带走；额外带上 `Origin`。
 *
 * @param path - 以 `/` 开头的接口路径。
 * @param options - 请求选项。
 * @param options.params - 表单字段。
 * @param options.cookie - Cookie 头（写操作必需）。
 * @param options.timeoutMs - 超时毫秒数。
 * @param options.signal - 调用方取消信号。
 * @param options.referer - Referer 覆盖。
 * @param options.origin - Origin 覆盖。
 * @returns `{ httpStatus, json, text }`。
 * @throws {BiliError} 网络/HTTP/解析失败时抛出。
 */
export async function apiPost(path, options = {}) {
  const {
    params = {},
    cookie,
    timeoutMs = 20000,
    signal,
    referer = SITE_REFERER,
    origin = 'https://www.bilibili.com',
  } = options

  const url = new URL(path, API_ORIGIN)
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value))
  }

  /** @type {Record<string, string>} */
  const headers = {
    'User-Agent': BROWSER_UA,
    Referer: referer,
    Origin: origin,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (cookie) headers.Cookie = cookie

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      redirect: cookie ? 'error' : 'follow',
      signal: combineSignals([signal, timeoutSignal(timeoutMs)]),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new BiliError(`${path}：请求被取消或超时`, 'BILI_REQUEST_CANCELLED', { cause: String(error?.message ?? '') })
    }
    const message = String(error?.message ?? error)
    if (/redirect/i.test(message)) {
      throw new BiliError(`${path}：响应试图重定向，已按凭据安全策略拒绝`, 'BILI_REDIRECT_REFUSED', { cause: message })
    }
    throw new BiliError(`${path}：网络请求失败（${message}）`, 'BILI_REQUEST_FAILED', { cause: message })
  }

  return finishResponse(path, response)
}

/**
 * 校验信封 `code === 0`，否则抛出结构化错误。
 * @param json - 接口响应。
 * @param where - 出错位置描述。
 * @returns 响应中的 `data`。
 * @throws {BiliError} 业务码非 0 时抛出。
 */
export function ensureOk(json, where) {
  if (Number(json.code) !== 0) {
    throw codeToError(json.code, json.message, where)
  }
  return json.data
}

/**
 * 读取 WBI 口令（未登录也会返回，文档已说明）。
 * @param options - 透传给 {@link apiGet} 的选项。
 * @returns `{ imgKey, subKey }`。
 * @throws {BiliError} 取不到口令时抛出。
 */
export async function fetchWbiKeys(options = {}) {
  const { json } = await apiGet('/x/web-interface/nav', options)
  const imgUrl = json?.data?.wbi_img?.img_url
  const subUrl = json?.data?.wbi_img?.sub_url
  const imgKey = keyFromUrl(imgUrl)
  const subKey = keyFromUrl(subUrl)
  if (!imgKey || !subKey) {
    throw new BiliError('nav 接口未返回可用的 WBI 口令', 'BILI_WBI_KEYS_UNAVAILABLE', { code: json?.code })
  }
  return { imgKey, subKey }
}

/**
 * 申请匿名设备指纹 Cookie（buvid3/buvid4），搜索接口需要。
 * @param options - 透传给 {@link apiGet} 的选项。
 * @returns `{ buvid3, buvid4, cookie }`。
 * @throws {BiliError} 申请失败时抛出。
 */
export async function fetchBuvid(options = {}) {
  const { json } = await apiGet('/x/frontend/finger/spi', options)
  const data = ensureOk(json, 'finger/spi')
  const raw3 = String(data?.b_3 ?? '')
  const raw4 = String(data?.b_4 ?? '')
  if (!raw3) {
    throw new BiliError('finger/spi 未返回 buvid3', 'BILI_BAD_RESPONSE', { code: json?.code })
  }
  const buvid3 = safeDecode(raw3)
  const buvid4 = safeDecode(raw4)
  const parts = [`buvid3=${buvid3}`]
  if (buvid4) parts.push(`buvid4=${buvid4}`)
  return { buvid3, buvid4, cookie: parts.join('; ') }
}

/**
 * 宽松地做一次 percent 解码；失败则原样返回。
 * @param value - 待解码字符串。
 * @returns 解码结果。
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 取单个视频的完整元数据（免登录）。
 * @param input - 查询输入。
 * @param input.bvid - BV 号。
 * @param input.aid - av 号；与 `bvid` 二选一。
 * @param options - 透传给 {@link apiGet} 的选项。
 * @returns 视频数据对象。
 */
export async function fetchVideoView({ bvid, aid }, options = {}) {
  const params = bvid ? { bvid } : { aid }
  const { json } = await apiGet('/x/web-interface/view', { ...options, params })
  return ensureOk(json, 'video/view')
}

/**
 * 取视频标签（免登录）。
 * @param input - 查询输入。
 * @param input.bvid - BV 号。
 * @param options - 透传给 {@link apiGet} 的选项。
 * @returns 标签数组。
 */
export async function fetchVideoTags({ bvid }, options = {}) {
  const { json } = await apiGet('/x/tag/archive/tags', { ...options, params: { bvid } })
  const data = ensureOk(json, 'tag/archive/tags')
  return Array.isArray(data) ? data : []
}

/**
 * 取相关推荐视频（免登录、免签名）；一次通常返回 40 条，每条含 `owner.mid`。
 * @param input - 查询输入。
 * @param input.bvid - BV 号。
 * @param options - 透传给 {@link apiGet} 的选项。
 * @returns 相关视频数组。
 */
export async function fetchRelated({ bvid }, options = {}) {
  const { json } = await apiGet('/x/web-interface/archive/related', { ...options, params: { bvid } })
  const data = ensureOk(json, 'archive/related')
  return Array.isArray(data) ? data : []
}

/**
 * 关键词搜索视频（**需要 WBI 签名 + buvid Cookie**，免登录）。
 * @param input - 查询输入。
 * @param input.keyword - 关键词。
 * @param input.page - 页码，从 1 开始。
 * @param options - 透传给 {@link apiGet} 的选项，必须包含 `mixinKey` 与 `cookie`。
 * @returns 结果数组（可能为空）。
 */
export async function fetchSearchVideos({ keyword, page = 1 }, options = {}) {
  const { json } = await apiGet('/x/web-interface/search/type', {
    ...options,
    params: { search_type: 'video', keyword, page },
  })
  const data = ensureOk(json, 'search/type')
  return Array.isArray(data?.result) ? data.result : []
}

/**
 * 关系操作码（依据 bilibili-API-collect `docs/user/relation.md` 的 act 表）。
 * @type {Readonly<Record<string, number>>}
 */
export const RELATION_ACT = Object.freeze({
  FOLLOW: 1,
  UNFOLLOW: 2,
  BLOCK: 5,
  UNBLOCK: 6,
})

/** 关注来源代码：从视频场景发起（doc 中 `re_src` 表）。 */
export const RE_SRC_VIDEO = 14

/**
 * 查询当前账号的登录态与自身 mid（用于预检和「不能拉黑自己」的保护）。
 * 未登录时 `code` 为 -101 但接口本身仍是 200，所以这里不抛错。
 * @param options - 透传给 {@link apiGet} 的选项，需带 `cookie`。
 * @returns `{ code, isLogin, mid, uname }`。
 */
export async function fetchLoginState(options = {}) {
  const { json } = await apiGet('/x/web-interface/nav', options)
  const data = json?.data ?? {}
  return {
    code: Number(json?.code ?? -1),
    isLogin: data.isLogin === true,
    mid: Number(data.mid ?? 0),
    uname: String(data.uname ?? ''),
  }
}

/**
 * 批量操作用户关系（写接口）。
 *
 * 依据文档：`x/relation/batch/modify` 只支持关注(1)与拉黑(5)，`fids` 最多 50 个、
 * 逗号分隔、不能包含自己；成功时 `data.failed_fids` 列出失败成员。
 *
 * 这里**不**调用 {@link ensureOk}：调用方需要同时读取业务码与 `failed_fids`，
 * 以便区分「风控要停」与「个别失败可继续」。
 *
 * @param input - 请求体字段。
 * @param input.fids - 目标 mid 列表（≤50）。
 * @param input.act - 操作码，仅 1 或 5。
 * @param input.csrf - 取自 `bili_jct` cookie。
 * @param input.reSrc - 关注来源代码。
 * @param options - 透传给 {@link apiPost} 的选项，需带 `cookie`。
 * @returns 原始响应信封。
 */
export async function batchModifyRelation({ fids, act, csrf, reSrc = RE_SRC_VIDEO }, options = {}) {
  const { json } = await apiPost('/x/relation/batch/modify', {
    ...options,
    params: { fids: fids.join(','), act, re_src: reSrc, csrf },
  })
  return json
}

/**
 * 单个操作用户关系（写接口，act=6 用于取消拉黑）。
 * @param input - 请求体字段。
 * @param input.fid - 目标 mid。
 * @param input.act - 操作码。
 * @param input.csrf - 取自 `bili_jct` cookie。
 * @param input.reSrc - 关注来源代码。
 * @param options - 透传给 {@link apiPost} 的选项，需带 `cookie`。
 * @returns 原始响应信封。
 */
export async function modifyRelation({ fid, act, csrf, reSrc = RE_SRC_VIDEO }, options = {}) {
  const { json } = await apiPost('/x/relation/modify', {
    ...options,
    params: { fid, act, re_src: reSrc, csrf },
  })
  return json
}

/**
 * 视频引用（用户输入解析结果）。
 * @typedef {object} VideoRef
 * @property {string} [bvid] - BV 号。
 * @property {number} [aid] - av 号。
 * @property {number} page - 分 P 序号，默认 1。
 */

/**
 * 从链接/编号解析出 BV 号或 av 号。
 * @param input - 用户输入，如完整链接、`BV...`、`av123` 或纯数字。
 * @returns 解析结果。
 * @throws {BiliError} 无法解析时抛出。
 */
export function parseVideoRef(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new BiliError('视频链接/编号为空', 'BILI_BAD_INPUT')
  }
  const raw = input.trim()
  const pageMatch = raw.match(/[?&]p=(\d{1,4})/)
  const page = pageMatch ? Number(pageMatch[1]) : 1

  const bvMatch = raw.match(/BV[0-9A-Za-z]{10}/)
  if (bvMatch) return { bvid: bvMatch[0], page }

  const avMatch = raw.match(/(?:^|[^0-9A-Za-z])av(\d{1,12})/i)
  if (avMatch) return { aid: Number(avMatch[1]), page }

  if (/^\d{1,12}$/.test(raw)) return { aid: Number(raw), page }

  throw new BiliError(
    `无法从 "${raw}" 解析出 BV 号或 av 号；请提供形如 https://www.bilibili.com/video/BV1xx411c7mD 的链接`,
    'BILI_BAD_INPUT',
  )
}

/**
 * 去掉搜索结果标题里的 `<em>` 高亮标签并还原常见实体。
 * @param value - 原始字符串。
 * @returns 纯文本。
 */
export function stripHtml(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * 截断文本到指定长度。
 * @param value - 原始文本。
 * @param limit - 最大字符数。
 * @returns 截断后的文本。
 */
export function truncate(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
