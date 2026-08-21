/**
 * Bundled pharma-product-facts provider and soft router.
 *
 * @module dsh-pharma-product-facts
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Config as PluginConfig } from './config.ts';
export { Config, DEFAULT_CONFIG, resolveConfig, type ResolvedConfig } from './config.ts';
/** Cordis plugin name and bundle row id. */
export declare const name = "pharma-product-facts";
/** Services required by the provider, native tools, and pre-step router. */
export declare const inject: string[];
/**
 * Register the immutable provider, DSH-native tools, and soft router in one plugin fiber.
 * @param ctx - Cordis context carrying the skill, agent, and tool services.
 * @param config - Validated transport and evidence limits for this row.
 */
export declare function apply(ctx: Context, config?: PluginConfig): void;
