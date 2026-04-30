/**
 * Public CLI entrypoint consumed by user `drizzle.config.ts` files.
 *
 * Exposes {@link resolveSchemas}, which expands a {@link VoyantConfig} into the
 * dependency-ordered list of schema entrypoints drizzle-kit should load.
 */

export {
  type ResolveSchemasOptions,
  resolveSchemas,
  type SchemaResolutionStyle,
} from "./lib/resolve-schemas.js"
