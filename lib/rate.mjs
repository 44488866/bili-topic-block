/**
 * 请求节流与风控码识别。
 *
 * 本模块只做「串行 + 随机抖动」和「风控码归类」，不自行决定重试策略：
 * 预览阶段遇到风控码只降级告警，block 阶段将据此长停或终止。
 *
 * @module bili-topic-block/lib/rate
 */

/**
 * 风控/限流类业务码（依据 bilibili-API-collect `docs/misc/errcode.md`）。
 * 注意：社区常把「请求过于频繁」记作 -509，但文档中 -509 是「超出限制」，
 * -799 才是「请求过于频繁」——这里两者都按风控处理。
 * @type {ReadonlyMap<number, string>}
 */
export const RISK_CODES = Object.freeze(new Map([
  [-352, '风控校验失败（UA 或 wbi 参数不合法）'],
  [-412, '请求被拦截（IP 被服务端风控）'],
  [-509, '超出限制'],
  [-799, '请求过于频繁'],
  [-503, '过载保护，服务暂不可用'],
]))

/**
 * 判断业务码是否属于风控/限流类。
 * @param code - 接口返回的 `code`。
 * @returns 是否属于风控类。
 */
export function isRiskCode(code) {
  return RISK_CODES.has(Number(code))
}

/**
 * 取风控码的中文说明。
 * @param code - 接口返回的 `code`。
 * @returns 说明文本；非风控码返回空串。
 */
export function riskLabel(code) {
  return RISK_CODES.get(Number(code)) ?? ''
}

/**
 * 可被 AbortSignal 打断的睡眠。
 * @param ms - 睡眠毫秒数。
 * @param signal - 可选取消信号。
 * @returns 睡眠结束后 resolve；被取消时 reject。
 */
export function sleep(ms, signal) {
  if (!(ms > 0)) {
    return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 构造一个标准的取消错误。 */
function abortError() {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

/**
 * 串行请求节流器：所有任务排队执行，任务之间插入随机抖动，
 * 保证任意时刻最多一个在途请求（不并发，降低风控面）。
 */
export class Pacer {
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve()
  /** @type {number} */
  #minDelayMs
  /** @type {number} */
  #maxDelayMs
  /** @type {number} */
  #completed = 0

  /**
   * @param options - 抖动区间。
   * @param options.minDelayMs - 抖谖下限，默认 0。
   * @param options.maxDelayMs - 抖动上限，默认 0。
   */
  constructor({ minDelayMs = 0, maxDelayMs = 0 } = {}) {
    this.#minDelayMs = Math.max(0, minDelayMs)
    this.#maxDelayMs = Math.max(this.#minDelayMs, maxDelayMs)
  }

  /** 已完成的请求数（首次请求不抖动，故用它区分）。 */
  get completed() {
    return this.#completed
  }

  /**
   * 计算本次抖动时长。
   * @returns 毫秒数。
   */
  #jitter() {
    if (this.#completed === 0) return 0
    const span = this.#maxDelayMs - this.#minDelayMs
    return this.#minDelayMs + Math.round(Math.random() * span)
  }

  /**
   * 排队执行一个任务。
   * @param task - 返回 Promise 的任务体。
   * @param signal - 可选取消信号，用于打断抖动等待。
   * @returns 任务结果；任务抛错时原样抛出。
   */
  run(task, signal) {
    const execute = async () => {
      await sleep(this.#jitter(), signal)
      try {
        return await task()
      } finally {
        this.#completed += 1
      }
    }
    const result = this.#tail.then(execute, execute)
    // 队尾只关心「上一个任务结束」，不关心成败，避免一次失败卡死整条队列。
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * 记录连续风控命中次数的计数器。
 * 预览阶段用它决定是否提前停止扩候选；block 阶段将用它触发长停/终止。
 */
export class RiskTracker {
  /** @type {number} */
  #consecutive = 0
  /** @type {number} */
  #total = 0
  /** @type {number[]} */
  #codes = []

  /**
   * 记录一次结果。
   * @param code - 业务码；0 表示成功。
   * @returns 当前连续命中次数。
   */
  record(code) {
    const value = Number(code)
    if (value === 0) {
      this.#consecutive = 0
    } else if (isRiskCode(value)) {
      this.#consecutive += 1
      this.#total += 1
      this.#codes.push(value)
    }
    return this.#consecutive
  }

  /** 连续命中次数。 */
  get consecutive() {
    return this.#consecutive
  }

  /** 累计命中次数。 */
  get total() {
    return this.#total
  }

  /** 命中过的风控码（去重）。 */
  get codes() {
    return [...new Set(this.#codes)]
  }
}
