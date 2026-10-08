/**
 * bili-topic-block —— DSH 插件入口（host 侧）。
 *
 * 本插件分两个阶段：
 * - **preview**：免登录、只读、无凭据、不写文件（`bili_topic_preview`）；
 * - **block**：用户确认后执行拉黑/撤销，凭据全部走 `ctx.credentials`（`bili_topic_block`、
 *   `bili_topic_unblock`）。
 *
 * 无论哪个阶段，插件都不写文件、不落盘凭据。
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
