/**
 * bili-topic-block —— DSH 插件入口（host 侧）。
 *
 * 本版本只实现 **preview 阶段**：免登录、只读、无凭据、不写文件。
 * 拉黑（block）阶段按约定在用户确认 preview 结果之后再实现。
 *
 * @module bili-topic-block
 */

import { Config, normalizeConfig } from './lib/config.mjs'
import { registerRelationTools } from './lib/block.mjs'
import { registerPreviewTool } from './lib/preview.mjs'

/** Loader 行 id 与包名一致，便于在 patch 里按 id 覆盖。 */
export const name = 'bili-topic-block'

/**
 * 只把 `tools` 声明为硬依赖。
 * 凭据服务刻意**不**放进 `inject`：万一宿主旧版本没有 `credentials`，
 * 进 inject 会让整个插件（含只读的 preview）永不激活；
 * 改为在 block 执行时用 `ctx.get('credentials')` 取，缺失就明确报错。
 */
export const inject = ['tools']

export { Config }

/**
 * 插件装配：注册只读预览工具与两个写工具，并把注销函数交给 `ctx.effect` 统一收尾。
 * @param ctx - 插件上下文。
 * @param config - 已由 {@link Config} 校验并归一化的配置。
 */
export function apply(ctx, config) {
  // 再归一化一次是幂等的，避免配置未经 schema 路径时出现 undefined 字段。
  const settings = normalizeConfig(config)
  ctx.effect(() => registerPreviewTool(ctx, settings))
  ctx.effect(() => registerRelationTools(ctx, settings))
}
