/**
 * 自检脚本：离线验证 WBI 签名、输入解析、配置校验与输出 schema 一致性；
 * 附带 `--live` 模式，用真实 B 站接口跑通整条 preview 链路。
 *
 * 用法（零依赖）：
 *   node tools/selftest.mjs                 # 只跑离线断言（不联网）
 *   node tools/selftest.mjs --live          # 额外跑一次真实预览（默认用示例 BV）
 *   node tools/selftest.mjs --live BV1xx... # 指定视频
 *
 * @module bili-topic-block/tools/selftest
 */

import assert from 'node:assert/strict'

import { DEFAULTS, Config, normalizeConfig } from '../lib/config.mjs'
import { parseVideoRef, stripHtml, truncate } from '../lib/bili.mjs'
import { MIXIN_KEY_ENC_TAB, getMixinKey, keyFromUrl, signQuery } from '../lib/wbi.mjs'
import { OUTPUT_SCHEMA, PARAMETERS, renderPreviewText, runPreview, validateArgs } from '../lib/preview.mjs'
import {
  RELATION_OUTPUT_SCHEMA,
  RELATION_PARAMETERS,
  buildPlan,
  classifyRelationCode,
  runRelation,
  validateBlockArgs,
} from '../lib/block.mjs'
import { clearVerified, rememberCandidates, unverifiedMids, verifiedCount } from '../lib/seen.mjs'

let passed = 0
let failed = 0

/**
 * 运行一个断言用例。
 * @param label - 用例名。
 * @param body - 断言体。
 */
function test(label, body) {
  try {
    body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(error?.message ?? error).split('\n').join('\n       ')}`)
  }
}

/**
 * 运行一个异步断言用例。
 * @param label - 用例名。
 * @param body - 断言体。
 */
async function testAsync(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(error?.message ?? error).split('\n').join('\n       ')}`)
  }
}

/**
 * 极简 JSON Schema 校验（覆盖本插件用到的关键字子集）。
 * @param schema - schema 节点。
 * @param value - 待校验值。
 * @param path - 当前路径（用于报错）。
 * @param errors - 错误收集器。
 * @returns 错误列表。
 */
function checkSchema(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors

  if (schema.type) {
    const expected = schema.type
    const actualOk = expected === 'object'
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : expected === 'array'
        ? Array.isArray(value)
        : expected === 'integer'
          ? Number.isInteger(value)
          : expected === 'number'
            ? typeof value === 'number'
            : expected === 'string'
              ? typeof value === 'string'
              : expected === 'boolean'
                ? typeof value === 'boolean'
                : expected === 'null'
                  ? value === null
                  : true
    if (!actualOk) {
      errors.push(`${path}: 期望 ${expected}，实际 ${JSON.stringify(value)?.slice(0, 60)}`)
      return errors
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: 值不在 enum 内`)
  }

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
        errors.push(`${path}: 缺少必填字段 ${key}`)
      }
    }
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push(`${path}: 出现未声明字段 ${key}`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) checkSchema(sub, value[key], `${path}.${key}`, errors)
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => checkSchema(schema.items, item, `${path}[${index}]`, errors))
  }

  return errors
}

console.log('== 离线断言 ==')

console.log('[WBI 签名]')
test('MIXIN_KEY_ENC_TAB 长度为 64 且是 0..63 的排列', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64)
  assert.deepEqual([...MIXIN_KEY_ENC_TAB].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i))
})
test('mixin_key 与权威文档示例一致', () => {
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  assert.equal(mixin, 'ea1db124af3c7062474693fa704f4ff8')
})
test('w_rid 与权威文档测试向量一致', () => {
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  const query = signQuery({ foo: '114', bar: '514', zab: '1919810' }, mixin, 1702204169)
  assert.equal(query, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
})
test('值中的 !\'()* 被过滤，中文按 encodeURIComponent 编码', () => {
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  const query = signQuery({ foo: "one one four!", bar: '五一四' }, mixin, 1702204169)
  assert.ok(query.startsWith('bar=%E4%BA%94%E4%B8%80%E5%9B%9B&foo=one%20one%20four&wts=1702204169&w_rid='), query)
})
test('keyFromUrl 从口令图片 URL 取文件名', () => {
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), '7cd084941338484aae1ad9425b84077c')
  assert.equal(keyFromUrl('nonsense'), 'nonsense')
})

console.log('[输入解析]')
test('解析完整链接并取分 P', () => {
  assert.deepEqual(parseVideoRef('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&t=1'), { bvid: 'BV1GJ411x7h7', page: 2 })
})
test('解析裸 BV 号', () => {
  assert.deepEqual(parseVideoRef('BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7', page: 1 })
})
test('解析 av 号与纯数字', () => {
  assert.deepEqual(parseVideoRef('av170001'), { aid: 170001, page: 1 })
  assert.deepEqual(parseVideoRef('https://www.bilibili.com/video/av170001'), { aid: 170001, page: 1 })
  assert.deepEqual(parseVideoRef('170001'), { aid: 170001, page: 1 })
})
test('无法解析时抛出 BILI_BAD_INPUT', () => {
  assert.throws(() => parseVideoRef('这不是链接'), (error) => error.code === 'BILI_BAD_INPUT')
})
test('stripHtml 去标签并还原实体', () => {
  assert.equal(stripHtml('<em class="keyword">Rick</em> Astley &amp; Co'), 'Rick Astley & Co')
})
test('truncate 按长度截断', () => {
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(truncate('abc', 3), 'abc')
})

console.log('[配置校验]')
test('空配置归一化为默认值', () => {
  assert.deepEqual(normalizeConfig({}), { ...DEFAULTS })
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS })
})
test('合法覆盖生效', () => {
  assert.equal(normalizeConfig({ maxBlock: 10, searchPages: 0 }).maxBlock, 10)
})
test('未知配置项被拒绝（防拼写错误）', () => {
  assert.throws(() => normalizeConfig({ maxblock: 10 }), /未知配置项/)
})
test('越界与类型错误被拒绝', () => {
  assert.throws(() => normalizeConfig({ maxBlock: 0 }), /maxBlock/)
  assert.throws(() => normalizeConfig({ requestTimeoutMs: '20s' }), /必须是整数/)
  assert.throws(() => normalizeConfig({ enableKeywordSearch: 'yes' }), /必须是布尔值/)
})
test('抖动下限大于上限被拒绝', () => {
  assert.throws(() => normalizeConfig({ requestMinDelayMs: 5000, requestMaxDelayMs: 100 }), /不能大于/)
})
test('Config 暴露 StandardSchemaV1 接口且同步返回', () => {
  const ok = Config['~standard'].validate({})
  assert.equal(ok.issues, undefined)
  assert.equal(ok.value.maxBlock, 50)
  const bad = Config['~standard'].validate({ nope: 1 })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0)
})
test('ignoreKeywords 默认包含实测确认的宽泛词', () => {
  const settings = normalizeConfig({})
  for (const word of ['解说', '经典', 'LIVE']) assert.ok(settings.ignoreKeywords.includes(word), `缺少宽泛分类词 ${word}`)
  for (const word of ['社会', '人文', '思维', '认知']) assert.ok(settings.ignoreKeywords.includes(word), `缺少抽象类目词 ${word}`)
  for (const word of ['原创', '生活', '情感', '女神', '剪辑', '影视剪辑', '必剪创作']) assert.ok(settings.ignoreKeywords.includes(word), `缺少标记/技法类词 ${word}`)
})
test('useTitleAsKeywordFallback 默认为 false 且校验类型', () => {
  assert.equal(normalizeConfig({}).useTitleAsKeywordFallback, false)
  assert.equal(normalizeConfig({ useTitleAsKeywordFallback: true }).useTitleAsKeywordFallback, true)
  assert.throws(() => normalizeConfig({ useTitleAsKeywordFallback: 'yes' }), /必须是布尔值/)
})
test('ignoreKeywords 会去空白项并拒绝非字符串数组', () => {
  assert.deepEqual(normalizeConfig({ ignoreKeywords: [' 经典 ', '', 'LIVE'] }).ignoreKeywords, ['经典', 'LIVE'])
  assert.deepEqual(normalizeConfig({ ignoreKeywords: [] }).ignoreKeywords, [])
  assert.throws(() => normalizeConfig({ ignoreKeywords: '经典' }), /必须是字符串数组/)
  assert.throws(() => normalizeConfig({ ignoreKeywords: [1, 2] }), /必须是字符串数组/)
})

console.log('[工具参数校验]')
test('缺少 url 被拒绝', () => {
  assert.throws(() => validateArgs({}), /url/)
})
test('未知参数被拒绝', () => {
  assert.throws(() => validateArgs({ url: 'BV1GJ411x7h7', limit: 3 }), /未知参数/)
})
test('越界 max_candidates 被拒绝', () => {
  assert.throws(() => validateArgs({ url: 'BV1GJ411x7h7', max_candidates: 0 }), /max_candidates/)
})
test('合法参数归一化', () => {
  const parsed = validateArgs({ url: ' BV1GJ411x7h7 ', keywords: [' a ', '', 'b'], include_source_uploader: true })
  assert.equal(parsed.url, 'BV1GJ411x7h7')
  assert.deepEqual(parsed.keywords, ['a', 'b'])
  assert.equal(parsed.includeSourceUploader, true)
})

console.log('[schema 自洽]')
test('PARAMETERS 与 OUTPUT_SCHEMA 是附加属性封闭的对象', () => {
  assert.equal(PARAMETERS.type, 'object')
  assert.equal(PARAMETERS.additionalProperties, false)
  assert.deepEqual(PARAMETERS.required, ['url'])
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false)
  assert.ok(OUTPUT_SCHEMA.required.includes('candidates'))
})
test('输出 schema 声明了 confidence 与 ignored_keywords', () => {
  const candidate = OUTPUT_SCHEMA.properties.candidates.items
  assert.ok(candidate.required.includes('confidence'))
  assert.deepEqual(candidate.properties.confidence.enum, ['high', 'medium', 'low'])
  assert.ok(OUTPUT_SCHEMA.properties.topic.required.includes('ignored_keywords'))
})

console.log('[block 业务码分类]')
test('成功与「已拉黑」都算良性', () => {
  assert.equal(classifyRelationCode(0).status, 'ok')
  assert.equal(classifyRelationCode(22120).status, 'already')
  assert.equal(classifyRelationCode(22003).status, 'already')
})
test('自身/已注销/不存在归为 skip', () => {
  assert.equal(classifyRelationCode(22001).status, 'skip')
  assert.equal(classifyRelationCode(22013).status, 'skip')
  assert.equal(classifyRelationCode(40061).status, 'skip')
})
test('黑名单满、鉴权失败、风控各自可辨', () => {
  assert.equal(classifyRelationCode(22008).status, 'full')
  assert.equal(classifyRelationCode(-111).status, 'auth')
  assert.equal(classifyRelationCode(-101).status, 'auth')
  for (const code of [-352, -412, -799, -509]) {
    const cls = classifyRelationCode(code)
    assert.equal(cls.status, 'risk', `code ${code} 应判为风控`)
    assert.equal(cls.risk, true)
  }
})
test('未知业务码归为 error', () => {
  assert.equal(classifyRelationCode(999999).status, 'error')
})

console.log('[block 执行计划]')
test('去重、剔除自己、过滤非法值', () => {
  const plan = buildPlan({ mids: [1, 2, 2, 3, 0, -5, 'x', 1], ownMid: 2, cap: 10, batchSize: 2 })
  assert.deepEqual(plan.queued, [1, 3])
  assert.deepEqual(plan.droppedOwn, [2, 2])
  assert.deepEqual(plan.duplicates, [1])
  assert.equal(plan.invalid.length, 3)
})
test('按 batchSize 切批且保持顺序', () => {
  const plan = buildPlan({ mids: [1, 2, 3, 4, 5], ownMid: 0, cap: 10, batchSize: 2 })
  assert.deepEqual(plan.batches, [[1, 2], [3, 4], [5]])
})
test('batchSize 被夹在 1–50', () => {
  assert.equal(buildPlan({ mids: [1], ownMid: 0, cap: 9, batchSize: 999 }).batchSize, 50)
  assert.equal(buildPlan({ mids: [1], ownMid: 0, cap: 9, batchSize: 0 }).batchSize, 1)
})
test('超出上限会被标记', () => {
  assert.equal(buildPlan({ mids: [1, 2, 3], ownMid: 0, cap: 2 }).overCap, true)
  assert.equal(buildPlan({ mids: [1, 2], ownMid: 0, cap: 2 }).overCap, false)
})

console.log('[block 参数校验]')
test('mids 缺失或为空被拒绝', () => {
  assert.throws(() => validateBlockArgs({}), /mids/)
  assert.throws(() => validateBlockArgs({ mids: [] }), /为空/)
  assert.throws(() => validateBlockArgs({ mids: 'BV1' }), /mids/)
})
test('未知参数与越界 max_block 被拒绝', () => {
  assert.throws(() => validateBlockArgs({ mids: [1], force: true }), /未知参数/)
  assert.throws(() => validateBlockArgs({ mids: [1], max_block: 0 }), /max_block/)
  assert.throws(() => validateBlockArgs({ mids: [1], max_block: 501 }), /max_block/)
})
test('confirm 缺省视为未确认，类型错误则直接拒绝', () => {
  assert.equal(validateBlockArgs({ mids: [1] }).confirm, false)
  assert.equal(validateBlockArgs({ mids: [1], confirm: true }).confirm, true)
  assert.equal(validateBlockArgs({ mids: [1], confirm: false }).confirm, false)
  assert.throws(() => validateBlockArgs({ mids: [1], confirm: 'yes' }), /confirm/)
})
test('block 的输出 schema 与入参 schema 自洽', () => {
  assert.deepEqual(RELATION_PARAMETERS.required, ['mids', 'confirm'])
  assert.equal(RELATION_PARAMETERS.additionalProperties, false)
  assert.equal(RELATION_OUTPUT_SCHEMA.additionalProperties, false)
  assert.deepEqual(
    RELATION_OUTPUT_SCHEMA.properties.counts.required,
    ['blocked', 'already_blocked', 'skipped', 'failed', 'not_attempted'],
  )
  assert.deepEqual(
    RELATION_OUTPUT_SCHEMA.properties.results.items.properties.status.enum,
    ['blocked', 'already_blocked', 'skipped', 'failed', 'not_attempted'],
  )
})

console.log('[block 安全闸门（离线，不触网）]')
await testAsync('没有 confirm 时只回报告、绝不执行', async () => {
  const settings = normalizeConfig({})
  const result = await runRelation(settings, { mids: [1, 2, 3] }, {}, {})
  assert.equal(result.aborted, true)
  assert.equal(result.abort_reason, 'confirm_required')
  assert.equal(result.results.length, 0)
  assert.equal(result.requested, 3)
  assert.deepEqual(checkSchema(RELATION_OUTPUT_SCHEMA, result), [])
})
await testAsync('确认了但没有凭据服务时报明确错误', async () => {
  const settings = normalizeConfig({})
  await assert.rejects(
    () => runRelation(settings, { mids: [1], confirm: true }, {}, {}),
    (error) => error.code === 'BILI_CREDENTIALS_UNAVAILABLE',
  )
})
await testAsync('凭据缺失时在发起任何写请求前就报错', async () => {
  const settings = normalizeConfig({})
  const credentials = { resolve: async () => undefined }
  await assert.rejects(
    () => runRelation(settings, { mids: [1], confirm: true }, {}, { credentials }),
    (error) => error.code === 'BILI_CREDENTIALS_MISSING' && error.message.includes('BILIBILI_SESSDATA'),
  )
})
await testAsync('缺少 bili_jct 时单独报错', async () => {
  const settings = normalizeConfig({})
  const credentials = { resolve: async (ref) => (ref === 'BILIBILI_SESSDATA' ? { value: 'tok' } : undefined) }
  await assert.rejects(
    () => runRelation(settings, { mids: [1], confirm: true }, {}, { credentials }),
    (error) => error.code === 'BILI_CREDENTIALS_MISSING' && error.message.includes('BILI_JCT'),
  )
})

console.log('[防幻觉护栏]')
test('preview 登记过的 mid 才被视为可信', () => {
  clearVerified()
  assert.equal(verifiedCount(), 0)
  rememberCandidates([{ mid: 111, name: 'a' }, { mid: 222, name: 'b' }, { mid: 0, name: 'bad' }])
  assert.equal(verifiedCount(), 2)
  assert.deepEqual(unverifiedMids([111, 999]), [999])
  clearVerified()
})

const liveIndex = process.argv.indexOf('--live')
if (liveIndex !== -1) {
  const target = process.argv[liveIndex + 1] && !process.argv[liveIndex + 1].startsWith('--')
    ? process.argv[liveIndex + 1]
    : 'BV1GJ411x7h7'

  console.log('')
  console.log(`== 在线预览（真实接口，匿名只读）: ${target} ==`)
  const settings = normalizeConfig({})
  const startedAt = Date.now()
  try {
    const result = await runPreview(settings, { url: target }, {})
    const schemaErrors = checkSchema(OUTPUT_SCHEMA, result, '$', [])
    console.log(renderPreviewText(result))
    console.log('')
    console.log(`耗时: ${Date.now() - startedAt}ms`)
    console.log(`输出 schema 校验: ${schemaErrors.length === 0 ? '通过' : '失败'}`)
    for (const error of schemaErrors) console.log(`  - ${error}`)
    if (schemaErrors.length > 0) failed += 1
    else passed += 1
  } catch (error) {
    failed += 1
    console.log(`预览失败: ${error?.code ?? ''} ${error?.message ?? error}`)
  }
}

console.log('')
console.log(`== 结果: ${passed} 通过, ${failed} 失败 ==`)
process.exitCode = failed === 0 ? 0 : 1
