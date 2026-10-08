/**
 * block 阶段：把用户勾选过的 UP 主批量拉黑（以及撤销拉黑的安全网）。
 *
 * 设计要点（与需求一一对应）：
 * - **两步确认**：必须显式传 `confirm: true`，否则只校验并拒绝执行。
 * - **数量硬上限**：`cap = min(配置 maxBlock, 入参 max_block)`，达到上限立即停止、
 *   剩余标记为 `not_attempted`，绝不超量。
 * - **凭据走宿主**：`ctx.credentials.resolve()`，不写死、不落配置、不出现在输出里。
 * - **先验登录态**：缺凭据或未登录都明确报错，不静默失败。
 * - **风控即停**：批量接口是主力（单请求 ≤50 个，显著减少请求数）；
 *   遇 -352/-412/-799/-509 立即终止本次运行并给出冷却建议（**不**在工具内长睡，
 *   否则只会把工具调用拖到超时、留下状态不明的副作用）。
 * - **黑名单满即停**：遇 22008 立即终止并告知用户。
 *
 * @module bili-topic-block/lib/block
 */

import {
  BiliError,
  RELATION_ACT,
  batchModifyRelation,
  fetchLoginState,
  modifyRelation,
} from './bili.mjs'
import { Pacer, isRiskCode, riskLabel, sleep } from './rate.mjs'
import { unverifiedMids, verifiedCount } from './seen.mjs'

/** 允许的工具参数名（block 与 unblock 共用）。 */
const ALLOWED_ARG_KEYS = Object.freeze(['mids', 'confirm', 'dry_run', 'max_block'])

/** 单条结果的取值集合。 */
const STATUSES = Object.freeze(['blocked', 'already_blocked', 'skipped', 'failed', 'not_attempted'])

/**
 * 业务码 → 语义分类（依据 bilibili-API-collect `docs/user/relation.md` 的返回码表）。
 * @type {ReadonlyMap<number, {status: string, message: string}>}
 */
const RELATION_CODES = Object.freeze(new Map([
  [0, { status: 'ok', message: '成功' }],
  [-101, { status: 'auth', message: '账号未登录（SESSDATA 可能已失效）' }],
  [-102, { status: 'auth', message: '账号被封停' }],
  [-111, { status: 'auth', message: 'csrf 校验失败（bili_jct 不正确或过期）' }],
  [-400, { status: 'error', message: '请求错误' }],
  [22001, { status: 'skip', message: '不能对自己进行此操作' }],
  [22003, { status: 'already', message: '用户位于黑名单（已拉黑）' }],
  [22008, { status: 'full', message: '黑名单达到上限' }],
  [22013, { status: 'skip', message: '账号已注销，无法完成操作' }],
  [22120, { status: 'already', message: '重复加入黑名单（已拉黑）' }],
  [40061, { status: 'skip', message: '用户不存在' }],
]))

/**
 * 解析业务码。
 * @param code - 接口返回的 `code`。
 * @returns `{ status, message, risk }`；未知码为 `error`。
 */
export function classifyRelationCode(code) {
  const value = Number(code)
  if (isRiskCode(value)) {
    return { status: 'risk', message: `触发风控：${riskLabel(value)}`, risk: true }
  }
  const hit = RELATION_CODES.get(value)
  if (hit) return { ...hit, risk: false }
  return { status: 'error', message: `未知业务码 ${value}`, risk: false }
}

/**
 * 校验并归一化入参。
 * @param args - 模型给出的原始参数。
 * @returns 归一化参数；`confirm` 缺失时为 `false`。
 * @throws {BiliError} 结构非法时抛出。
 */
export function validateBlockArgs(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const issues = []

  for (const key of Object.keys(input)) {
    if (!ALLOWED_ARG_KEYS.includes(key)) issues.push(`未知参数 \`${key}\``)
  }

  if (!Array.isArray(input.mids)) {
    issues.push('`mids` 必填，且必须是 mid 整数数组')
  } else if (input.mids.length === 0) {
    issues.push('`mids` 为空，没有要处理的 UP 主')
  }

  if (input.confirm !== undefined && typeof input.confirm !== 'boolean') {
    issues.push('`confirm` 必须是布尔值')
  }
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') {
    issues.push('`dry_run` 必须是布尔值')
  }
  if (input.max_block !== undefined) {
    if (!Number.isInteger(input.max_block) || input.max_block < 1 || input.max_block > 500) {
      issues.push('`max_block` 必须是 1–500 之间的整数')
    }
  }

  if (issues.length > 0) {
    throw new BiliError(`参数无效：\n- ${issues.join('\n- ')}`, 'BILI_BAD_INPUT')
  }

  return {
    mids: Array.isArray(input.mids) ? input.mids : [],
    confirm: input.confirm === true,
    dryRun: input.dry_run === true,
    maxBlockArg: Number.isInteger(input.max_block) ? input.max_block : undefined,
  }
}

/**
 * 计算执行计划（纯函数，便于离线单测）。
 *
 * 去重、剔除自己与非法值；按入参顺序保留；`cap` 为硬上限。
 *
 * @param input - 计划输入。
 * @param input.mids - 原始 mid 列表。
 * @param input.ownMid - 自身 mid（0 表示未知）。
 * @param input.cap - 本次硬上限。
 * @param input.batchSize - 每批个数（≤50）。
 * @returns 计划对象。
 */
export function buildPlan({ mids, ownMid = 0, cap, batchSize = 50 }) {
  const invalid = []
  const duplicates = []
  const droppedOwn = []
  const queued = []
  const unique = new Set()

  for (const raw of mids) {
    const mid = Number(raw)
    if (!Number.isInteger(mid) || mid <= 0) {
      invalid.push(raw)
      continue
    }
    if (ownMid > 0 && mid === ownMid) {
      droppedOwn.push(mid)
      continue
    }
    if (unique.has(mid)) {
      duplicates.push(mid)
      continue
    }
    unique.add(mid)
    queued.push(mid)
  }

  // 注意：不能用 `Number(batchSize) || 50`，那样传 0 会被静默当成 50。
  const numericSize = Number(batchSize)
  const size = Number.isFinite(numericSize) ? Math.min(50, Math.max(1, Math.floor(numericSize))) : 50
  const batches = []
  for (let index = 0; index < queued.length; index += size) {
    batches.push(queued.slice(index, index + size))
  }

  return { invalid, duplicates, droppedOwn, queued, batches, cap, batchSize: size, overCap: queued.length > cap }
}

/**
 * 读取凭据，对宿主冷启动时的瞬时失败做少量重试。
 * @param credentials - `ctx.credentials` 服务。
 * @param ref - 凭据名。
 * @returns 凭据值字符串，或 undefined。
 * @throws {BiliError} 连续失败时抛出。
 */
async function resolveCredential(credentials, ref) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resolved = await credentials.resolve(ref)
      return typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : undefined
    } catch (error) {
      lastError = error
      await sleep(700)
    }
  }
  throw new BiliError(
    `读取凭据 ${ref} 失败：${String(lastError?.message ?? lastError)}`,
    'BILI_CREDENTIALS_UNAVAILABLE',
  )
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
 * 空结果骨架（保证输出始终符合 schema）。
 * @param action - `block` 或 `unblock`。
 * @param cap - 本次上限。
 * @returns 结果对象。
 */
function emptyResult(action, cap) {
  return {
    ok: false,
    dry_run: false,
    action,
    requested: 0,
    queued: 0,
    cap,
    counts: { blocked: 0, already_blocked: 0, skipped: 0, failed: 0, not_attempted: 0 },
    results: [],
    aborted: false,
    abort_reason: '',
    retry_after_hint_ms: 0,
    warnings: [],
    unverified_mids: [],
    elapsed_ms: 0,
  }
}

/**
 * 执行一次关系写入（拉黑或取消拉黑）。
 *
 * @param settings - 已归一化配置。
 * @param args - 工具入参。
 * @param exec - 工具执行上下文（可空）。
 * @param deps - 依赖注入。
 * @param deps.credentials - `ctx.credentials`（缺失即报错）。
 * @param deps.action - `block` 或 `unblock`。
 * @returns 与 {@link RELATION_OUTPUT_SCHEMA} 一致的结果。
 * @throws {BiliError} 入参结构非法时抛出。
 */
export async function runRelation(settings, args, exec = {}, deps = {}) {
  const startedAt = Date.now()
  const action = deps.action === 'unblock' ? 'unblock' : 'block'
  const act = action === 'block' ? RELATION_ACT.BLOCK : RELATION_ACT.UNBLOCK
  const timeoutMs = settings.requestTimeoutMs
  const signal = exec?.signal

  // 上限取自**已校验的入参**（validateBlockArgs 已把 max_block 归一化），
  // 而不是从 deps 里取——否则调用方忘了透传就会静默退化成配置值。
  const parsed = validateBlockArgs(args)
  const configuredCap = Number(settings.maxBlock) || 50
  const cap = Number.isInteger(parsed.maxBlockArg)
    ? Math.min(configuredCap, parsed.maxBlockArg)
    : configuredCap

  const result = emptyResult(action, cap)
  result.requested = parsed.mids.length

  // ① 两步确认：没有显式 confirm 就只回报告，绝不落笔。
  if (!parsed.confirm) {
    result.abort_reason = 'confirm_required'
    result.aborted = true
    result.warnings.push(
      '未收到 `confirm: true`，已拒绝执行。请把 `bili_topic_preview` 的候选交给用户勾选，'
      + '得到明确同意后再带 `confirm: true` 调用。',
    )
    result.elapsed_ms = Date.now() - startedAt
    return result
  }

  // ② 凭据：全部走宿主凭据服务，缺一个就明确报错。
  const credentials = deps.credentials
  if (!credentials) {
    throw new BiliError(
      '宿主未提供凭据服务（ctx.credentials），无法读取 B 站登录态；请确认 DSH 的 credentials 插件已启用。',
      'BILI_CREDENTIALS_UNAVAILABLE',
    )
  }

  const sessdata = await resolveCredential(credentials, settings.sessdataRef)
  if (!sessdata) {
    throw new BiliError(
      `未配置凭据 \`${settings.sessdataRef}\`（B 站 SESSDATA）。`
      + '请在 DSH 凭据里配置该名字，键值为浏览器 Cookie 中 SESSDATA 的裸 token；'
      + '未配置前不会发起任何写请求。',
      'BILI_CREDENTIALS_MISSING',
    )
  }
  const csrf = await resolveCredential(credentials, settings.csrfRef)
  if (!csrf) {
    throw new BiliError(
      `未配置凭据 \`${settings.csrfRef}\`（B 站 bili_jct）。`
      + '拉黑是写操作，缺少 csrf 必定返回 -111；请在 DSH 凭据里配置该名字，'
      + '键值为浏览器 Cookie 中 bili_jct 的值。',
      'BILI_CREDENTIALS_MISSING',
    )
  }

  const cookie = `SESSDATA=${sessdata}; bili_jct=${csrf}`
  const pacer = new Pacer({ minDelayMs: settings.requestMinDelayMs, maxDelayMs: settings.requestMaxDelayMs })
  const requestOptions = { cookie, timeoutMs, signal }

  // ③ 预检登录态，并拿到自己的 mid（用于「不能拉黑自己」）。
  let login
  try {
    login = await pacer.run(() => fetchLoginState(requestOptions), signal)
  } catch (error) {
    throw new BiliError(`登录态校验失败：${describeError(error)}`, 'BILI_LOGIN_CHECK_FAILED')
  }
  if (!login.isLogin) {
    throw new BiliError(
      `登录态无效（nav 返回 code ${login.code}）：SESSDATA 可能已过期或被风控失效。`
      + '请在浏览器重新登录 B 站并更新凭据，本次未执行任何写操作。',
      'BILI_LOGIN_REQUIRED',
    )
  }

  // ④ 执行计划。
  const plan = buildPlan({
    mids: parsed.mids,
    ownMid: login.mid,
    cap,
    batchSize: settings.batchSize,
  })
  result.queued = plan.queued.length
  if (plan.invalid.length > 0) result.warnings.push(`忽略 ${plan.invalid.length} 个非法 mid。`)
  if (plan.duplicates.length > 0) result.warnings.push(`去重 ${plan.duplicates.length} 个重复 mid。`)
  if (plan.droppedOwn.length > 0) result.warnings.push(`已剔除你自己的 mid ${login.mid}（不能对自己操作）。`)

  // 防幻觉护栏：只在本次进程确实跑过 preview 时才检查。
  if (verifiedCount() > 0) {
    const unknown = unverifiedMids(plan.queued)
    result.unverified_mids = unknown
    if (unknown.length > 0) {
      result.warnings.push(
        `其中 ${unknown.length} 个 mid 不是本进程内 bili_topic_preview 返回过的，`
        + '请确认它们确实来自用户勾选，而不是模型臆造。',
      )
    }
  }

  if (plan.queued.length === 0) {
    result.warnings.push('去重与剔除后没有可处理的 mid。')
    result.elapsed_ms = Date.now() - startedAt
    return result
  }

  // ⑤ dry run：只回报告，不写。
  if (parsed.dryRun) {
    result.dry_run = true
    result.ok = true
    result.aborted = true
    result.abort_reason = 'dry_run'
    result.counts.not_attempted = Math.min(plan.queued.length, cap)
    result.warnings.push('dry_run=true：已完成凭据与登录态校验，未调用任何写接口。')
    result.elapsed_ms = Date.now() - startedAt
    return result
  }

  // ⑥ 真正执行：批量接口为主（单请求 ≤50），达到上限立即停。
  const byMid = new Map()
  /** 记录每个 mid 的结果。 */
  const record = (mid, status, code, message) => {
    const item = { mid, status, code, message }
    result.results.push(item)
    byMid.set(mid, item)
  }

  let budget = cap
  let processed = 0
  const notAttempted = []

  for (const [batchIndex, batch] of plan.batches.entries()) {
    if (budget <= 0) {
      notAttempted.push(...batch)
      continue
    }
    const slice = batch.slice(0, budget)

    if (batchIndex > 0 && settings.batchRestMs > 0) {
      try {
        await sleep(settings.batchRestMs, signal)
      } catch (error) {
        result.warnings.push(`批次间休息被中断：${describeError(error)}`)
      }
    }

    let json
    try {
      json = await pacer.run(
        () => batchModifyRelation(
          { fids: slice, act, csrf },
          requestOptions,
        ),
        signal,
      )
    } catch (error) {
      const risk = error instanceof BiliError && error.code === 'BILI_RISK_CONTROL'
      for (const mid of slice) record(mid, 'failed', 0, describeError(error))
      result.aborted = true
      result.abort_reason = risk ? 'risk_control' : 'request_failed'
      if (risk) result.retry_after_hint_ms = settings.riskCooldownHintMs
      notAttempted.push(...batch.slice(slice.length))
      notAttempted.push(...plan.batches.slice(batchIndex + 1).flat())
      break
    }

    const code = Number(json?.code ?? -1)
    const cls = classifyRelationCode(code)

    if (cls.status === 'risk' || cls.status === 'auth' || cls.status === 'full' || cls.status === 'error') {
      for (const mid of slice) record(mid, 'failed', code, cls.message)
      result.aborted = true
      result.abort_reason = cls.status === 'risk'
        ? 'risk_control'
        : cls.status === 'full'
          ? 'blacklist_full'
          : cls.status === 'auth'
            ? 'auth_error'
            : 'api_error'
      if (cls.status === 'risk') result.retry_after_hint_ms = settings.riskCooldownHintMs
      notAttempted.push(...batch.slice(slice.length))
      notAttempted.push(...plan.batches.slice(batchIndex + 1).flat())
      break
    }

    const failedFids = Array.isArray(json?.data?.failed_fids)
      ? json.data.failed_fids.map((value) => Number(value))
      : []
    const failedSet = new Set(failedFids)
    for (const mid of slice) {
      if (failedSet.has(mid)) record(mid, 'failed', 0, '批量接口未说明原因')
      else record(mid, 'blocked', 0, action === 'block' ? '已拉黑' : '已取消拉黑')
    }

    budget -= slice.length
    processed += slice.length
  }

  // ⑦ 对批量失败项做限量单条复探，拿到精确业务码（已拉黑 / 已注销 / 黑名单满）。
  if (settings.probeFailures && settings.maxProbes > 0) {
    const probeTargets = result.results.filter((item) => item.status === 'failed').slice(0, settings.maxProbes)
    for (const item of probeTargets) {
      if (result.abort_reason === 'risk_control' || result.abort_reason === 'blacklist_full') break
      let json
      try {
        json = await pacer.run(() => modifyRelation({ fid: item.mid, act, csrf }, requestOptions), signal)
      } catch (error) {
        item.message = `复探失败：${describeError(error)}`
        continue
      }
      const code = Number(json?.code ?? -1)
      const cls = classifyRelationCode(code)
      item.code = code
      item.message = cls.message
      if (cls.status === 'ok') item.status = 'blocked'
      else if (cls.status === 'already') item.status = 'already_blocked'
      else if (cls.status === 'skip') item.status = 'skipped'
      else if (cls.status === 'risk') {
        item.status = 'failed'
        result.aborted = true
        result.abort_reason = 'risk_control'
        result.retry_after_hint_ms = settings.riskCooldownHintMs
        break
      } else if (cls.status === 'full') {
        item.status = 'failed'
        result.aborted = true
        result.abort_reason = 'blacklist_full'
        break
      }
    }
  }

  for (const mid of notAttempted) record(mid, 'not_attempted', 0, '未处理（达到上限或已中止）')

  for (const item of result.results) {
    if (item.status === 'blocked') result.counts.blocked += 1
    else if (item.status === 'already_blocked') result.counts.already_blocked += 1
    else if (item.status === 'skipped') result.counts.skipped += 1
    else if (item.status === 'failed') result.counts.failed += 1
    else if (item.status === 'not_attempted') result.counts.not_attempted += 1
  }

  if (result.abort_reason === 'cap_reached' || (budget <= 0 && notAttempted.length > 0 && !result.aborted)) {
    result.aborted = true
    result.abort_reason = result.abort_reason || 'cap_reached'
    result.warnings.push(`达到数量上限 ${cap}：只处理了前 ${processed} 个，其余未处理。`)
  }
  if (result.abort_reason === 'risk_control') {
    result.warnings.push(
      `已触发风控（${result.results.find((item) => item.status === 'failed')?.message ?? ''}）：`
      + '本次立即终止，未继续发起请求。建议至少间隔 10 分钟以上再试，且减少单次数量。',
    )
  }
  if (result.abort_reason === 'blacklist_full') {
    result.warnings.push('黑名单已达上限：本次立即终止。请先清理已有黑名单再继续。')
  }

  result.ok = !result.aborted && result.counts.failed === 0
  result.elapsed_ms = Date.now() - startedAt
  return result
}

/**
 * 把结果渲染成给模型看的文本。
 * @param value - {@link runRelation} 的返回值。
 * @returns 文本。
 */
export function renderRelationText(value) {
  if (value === null || typeof value !== 'object') return '执行失败：结果为空。'
  const verb = value.action === 'block' ? '拉黑' : '取消拉黑'
  const lines = []
  lines.push(value.dry_run
    ? `【${verb}·预演】未执行任何写操作`
    : `【${verb}】${value.ok ? '完成' : '未完成/部分完成'}`)
  lines.push(`  请求 ${value.requested} 个 → 去重剔除后 ${value.queued} 个 → 本次上限 ${value.cap}`)
  const c = value.counts ?? {}
  lines.push(`  成功 ${c.blocked ?? 0} | 本已${verb === '拉黑' ? '拉黑' : '取消'} ${c.already_blocked ?? 0} | 跳过 ${c.skipped ?? 0} | 失败 ${c.failed ?? 0} | 未处理 ${c.not_attempted ?? 0}`)
  if (value.aborted && value.abort_reason !== 'dry_run') {
    lines.push(`  ⚠ 已中止：${value.abort_reason}${value.retry_after_hint_ms > 0 ? `（建议冷却 ${Math.round(value.retry_after_hint_ms / 60000)} 分钟）` : ''}`)
  }
  const failed = (value.results ?? []).filter((item) => item.status === 'failed' || item.status === 'skipped')
  if (failed.length > 0) {
    lines.push('  需要关注：')
    for (const item of failed.slice(0, 15)) {
      lines.push(`    - mid=${item.mid} [${item.status}] code=${item.code} ${item.message}`)
    }
    if (failed.length > 15) lines.push(`    …还有 ${failed.length - 15} 条`)
  }
  for (const warning of value.warnings ?? []) lines.push(`  - ${warning}`)
  lines.push(`  耗时 ${value.elapsed_ms}ms`)
  return lines.join('\n')
}

/** 工具输出 schema（标准 JSON Schema）。 */
export const RELATION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    dry_run: { type: 'boolean' },
    action: { type: 'string', enum: ['block', 'unblock'] },
    requested: { type: 'integer' },
    queued: { type: 'integer' },
    cap: { type: 'integer' },
    counts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocked: { type: 'integer' },
        already_blocked: { type: 'integer' },
        skipped: { type: 'integer' },
        failed: { type: 'integer' },
        not_attempted: { type: 'integer' },
      },
      required: ['blocked', 'already_blocked', 'skipped', 'failed', 'not_attempted'],
    },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mid: { type: 'integer' },
          status: { type: 'string', enum: [...STATUSES] },
          code: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['mid', 'status', 'code', 'message'],
      },
    },
    aborted: { type: 'boolean' },
    abort_reason: { type: 'string' },
    retry_after_hint_ms: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    unverified_mids: { type: 'array', items: { type: 'integer' } },
    elapsed_ms: { type: 'integer' },
  },
  required: [
    'ok', 'dry_run', 'action', 'requested', 'queued', 'cap', 'counts',
    'results', 'aborted', 'abort_reason', 'retry_after_hint_ms', 'warnings',
    'unverified_mids', 'elapsed_ms',
  ],
})

/** 工具入参 schema（block 与 unblock 共用）。 */
export const RELATION_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    mids: {
      type: 'array',
      items: { type: 'integer' },
      description: '要处理的 UP 主 mid 列表，按重要程度排序。只应来自 bili_topic_preview 返回的 candidates。',
    },
    confirm: {
      type: 'boolean',
      description: '必须显式传 true。缺省或 false 时本工具只回报告、拒绝执行任何写操作。',
    },
    dry_run: {
      type: 'boolean',
      description: 'true 时只校验凭据与登录态、给出执行计划，不调用任何写接口。',
    },
    max_block: {
      type: 'integer',
      description: '本次数量上限，只能调低；实际上限 = min(插件配置 maxBlock, 本参数)。',
    },
  },
  required: ['mids', 'confirm'],
})

/**
 * 注册 block 与 unblock 两个工具。
 * @param ctx - 携带 `tools` 服务的插件上下文。
 * @param settings - 已归一化配置。
 * @returns 注销函数（供 `ctx.effect` 收尾）。
 */
export function registerRelationTools(ctx, settings) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'bili_topic_block',
    description:
      '执行拉黑：把用户**已勾选**的 UP 主 mid 列表批量加入 B 站黑名单。'
      + '前置条件是先用 bili_topic_preview 拿到候选、并让用户确认。'
      + '必须显式传 confirm=true；数量受插件配置 maxBlock 硬上限约束，达到即停、绝不超量。'
      + '需要 DSH 凭据 BILIBILI_SESSDATA 与 BILI_JCT，缺失会明确报错且不发起任何写请求。'
      + '遇风控或黑名单已满会立即终止。可用 dry_run=true 先预演。',
    parameters: RELATION_PARAMETERS,
    output: {
      schema: RELATION_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRelationText(value) }],
    },
    execute: (args, exec) => runRelation(settings, args, exec, {
      credentials: ctx.get('credentials'),
      action: 'block',
    }),
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: '批量拉黑 UP 主',
      kind: 'edit',
      rawInput: { count: Array.isArray(args?.mids) ? args.mids.length : 0, dry_run: args?.dry_run === true },
    }),
    timeoutMs: 600000,
  }))

  disposers.push(ctx.tools.register({
    name: 'bili_topic_unblock',
    description:
      '撤销拉黑（安全网）：把给定的 UP 主 mid 从 B 站黑名单移除（act=6）。'
      + '用于纠正误拉黑。同样必须显式传 confirm=true，并受配置 maxBlock 约束。'
      + '注意：它会移除这些用户的黑名单记录，无论当初是谁拉黑的。',
    parameters: RELATION_PARAMETERS,
    output: {
      schema: RELATION_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRelationText(value) }],
    },
    execute: (args, exec) => runRelation(settings, args, exec, {
      credentials: ctx.get('credentials'),
      action: 'unblock',
    }),
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: '批量撤销拉黑',
      kind: 'edit',
      rawInput: { count: Array.isArray(args?.mids) ? args.mids.length : 0, dry_run: args?.dry_run === true },
    }),
    timeoutMs: 600000,
  }))

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // 注销失败不应阻断其它清理。
      }
    }
  }
}
