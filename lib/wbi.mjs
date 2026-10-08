/**
 * Bilibili WBI 签名器（零依赖，仅用 node:crypto 的 MD5）。
 *
 * 算法与重排映射表来自 bilibili-API-collect 的 `docs/misc/sign/wbi.md`，
 * 照抄权威文档中的 `MIXIN_KEY_ENC_TAB`，未做任何改动或推测。
 *
 * @module bili-topic-block/lib/wbi
 */

import { createHash } from 'node:crypto'

/**
 * WBI 口令重排映射表（长度 64，权威文档原样）。
 * 按此表的顺序从 `img_key + sub_key` 中取字符，取前 32 位即 `mixin_key`。
 * @type {readonly number[]}
 */
export const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
])

/** 文档要求从参数值中过滤掉的字符。 */
const CHR_FILTER = /[!'()*]/g

/**
 * 由 `img_key` 与 `sub_key` 计算 `mixin_key`。
 * @param imgKey - nav 接口 `img_url` 的文件名（不含扩展名）。
 * @param subKey - nav 接口 `sub_url` 的文件名（不含扩展名）。
 * @returns 32 位 mixin key。
 */
export function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`
  let out = ''
  for (const index of MIXIN_KEY_ENC_TAB) out += raw[index] ?? ''
  return out.slice(0, 32)
}

/**
 * 计算 MD5 十六进制摘要。
 * @param input - 待摘要字符串（UTF-8）。
 * @returns 小写十六进制摘要。
 */
export function md5Hex(input) {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * 对查询参数做 WBI 签名，返回可直接拼到 URL 后的完整 query。
 *
 * 顺序严格按文档：复制参数 → 加 `wts` → 按键名升序 → `encodeURIComponent`
 * 编码（空格为 `%20`、十六进制大写）→ 拼接 `mixin_key` 后取 MD5 作为 `w_rid`
 * → 把 `w_rid` 追加到**原始**编码结果末尾。
 *
 * @param params - 原始查询参数（值为字符串或数字）。
 * @param mixinKey - {@link getMixinKey} 的结果。
 * @param wts - 秒级 Unix 时间戳；省略时取当前时间（注入以便测试）。
 * @returns 形如 `a=1&wts=...&w_rid=...` 的完整 query。
 */
export function signQuery(params, mixinKey, wts = Math.round(Date.now() / 1000)) {
  const merged = { ...params, wts }
  const query = Object.keys(merged)
    .sort()
    .map((key) => {
      const value = String(merged[key]).replace(CHR_FILTER, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = md5Hex(query + mixinKey)
  return `${query}&w_rid=${wRid}`
}

/**
 * 缓存 WBI 口令的取用器。口令全站统一、每日更替，故缓存若干小时并在
 * 签名失败时允许强制刷新。
 */
export class WbiKeyCache {
  /** @type {{imgKey: string, subKey: string} | null} */
  #keys = null
  /** @type {number} */
  #fetchedAt = 0
  /** @type {number} */
  #ttlMs

  /**
   * @param options - 缓存配置。
   * @param options.ttlMs - 缓存有效期，默认 6 小时。
   */
  constructor({ ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.#ttlMs = ttlMs
  }

  /** 当前缓存的口令（可能为 null）。 */
  get current() {
    return this.#keys
  }

  /** 丢弃缓存，令下次取用重新拉取。 */
  invalidate() {
    this.#keys = null
    this.#fetchedAt = 0
  }

  /**
   * 取用口令，必要时调用 `loader` 拉取。
   * @param loader - 返回 `{imgKey, subKey}` 的异步函数。
   * @param options - `force` 为真时忽略缓存。
   * @returns 口令对象。
   */
  async get(loader, { force = false } = {}) {
    const fresh = this.#keys !== null && Date.now() - this.#fetchedAt < this.#ttlMs
    if (fresh && !force) return this.#keys
    const keys = await loader()
    if (!keys || !keys.imgKey || !keys.subKey) {
      throw new Error('WBI 口令不可用：img_key/sub_key 为空')
    }
    this.#keys = keys
    this.#fetchedAt = Date.now()
    return keys
  }
}

/**
 * 从 nav/bili_ticket 返回的图片 URL 中截取文件名作为口令。
 * @param url - 形如 `https://i0.hdslb.com/bfs/wbi/<key>.png`。
 * @returns 文件名（不含扩展名），无法解析时返回空串。
 */
export function keyFromUrl(url) {
  if (typeof url !== 'string') return ''
  const last = url.slice(url.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot === -1 ? last : last.slice(0, dot)
}
