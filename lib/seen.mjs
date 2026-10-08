/**
 * 进程内「预览见过哪些 mid」登记表。
 *
 * 作用：给 block 阶段一个**防幻觉护栏** —— 模型只应拉黑 `bili_topic_preview`
 * 真实返回过的 mid。若 block 收到没见过的 mid，会在结果里以
 * `unverified_mids` 回报（告警而非拒绝，因为用户也可能手动给出名单）。
 *
 * 只存内存，不落盘（因此不触碰 `$DSH_HOME`）；进程重启后清空，
 * 此时护栏自动失效并跳过检查，只依赖告警提示。
 *
 * @module bili-topic-block/lib/seen
 */

/** @type {Map<number, {name: string, seenAt: number}>} */
const seen = new Map()

/**
 * 登记一批候选（由 preview 调用）。
 * @param candidates - preview 返回的候选数组，元素含 `mid` 与 `name`。
 * @returns 本次新增的 mid 个数。
 */
export function rememberCandidates(candidates) {
  if (!Array.isArray(candidates)) return 0
  let added = 0
  for (const item of candidates) {
    const mid = Number(item?.mid)
    if (!Number.isInteger(mid) || mid <= 0) continue
    if (!seen.has(mid)) added += 1
    seen.set(mid, { name: String(item?.name ?? ''), seenAt: Date.now() })
  }
  return added
}

/**
 * 查询某个 mid 是否被预览见过。
 * @param mid - 待查询 mid。
 * @returns 是否见过。
 */
export function isVerifiedMid(mid) {
  return seen.has(Number(mid))
}

/**
 * 当前登记的 mid 总数。
 * @returns 数量。
 */
export function verifiedCount() {
  return seen.size
}

/**
 * 从一组 mid 中挑出未被预览见过的。
 * @param mids - 待检查的 mid 列表。
 * @returns 未见过（或非法）的 mid 列表。
 */
export function unverifiedMids(mids) {
  return mids.filter((mid) => !seen.has(Number(mid)))
}

/** 清空登记表（测试用）。 */
export function clearVerified() {
  seen.clear()
}
