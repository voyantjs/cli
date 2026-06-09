import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path"

import type { VoyantConfig } from "@voyantjs/core/config"

import { resolveSchemas, type SchemaResolutionStyle } from "./resolve-schemas.js"

const DEFAULT_GENERATED_SCHEMA_FILE = "drizzle.schemas.generated.ts"

type VoyantConfigWithLocalSchemas = VoyantConfig & {
  /**
   * Template/app-local Drizzle schema entrypoints. These are appended after
   * package-derived schemas and stay deployment-owned.
   */
  schemas?: string[]
}

export interface ResolveSchemaManifestOptions {
  cwd?: string
  style?: SchemaResolutionStyle
  additionalSchemas?: string[]
}

export interface RenderSchemaManifestOptions {
  cwd: string
  outPath?: string
  additionalSchemas?: string[]
}

export interface GeneratedSchemaManifest {
  path: string
  content: string
  entries: string[]
}

export function defaultSchemaManifestPath(cwd: string): string {
  return resolvePath(cwd, DEFAULT_GENERATED_SCHEMA_FILE)
}

export function resolveSchemaManifest(
  config: VoyantConfig,
  options: ResolveSchemaManifestOptions = {},
): string[] {
  const cwd = options.cwd ?? process.cwd()
  const style = options.style ?? "specifier"
  const packageSchemas = resolveSchemas(config, { cwd, style })
  const localSchemas = resolveLocalSchemas(config, cwd, style)
  const additionalSchemas = resolveAdditionalSchemas(options.additionalSchemas ?? [], cwd, style)
  return [...packageSchemas, ...localSchemas, ...additionalSchemas]
}

export function renderSchemaManifest(
  config: VoyantConfig,
  options: RenderSchemaManifestOptions,
): GeneratedSchemaManifest {
  const outPath = resolveOutputPath(options.cwd, options.outPath)
  const outDir = dirname(outPath)
  const absoluteEntries = resolveSchemaManifest(config, {
    cwd: options.cwd,
    style: "file",
    additionalSchemas: options.additionalSchemas,
  })
  const entries = absoluteEntries.map((entry) => toPortableRelativePath(outDir, entry))
  const content = [
    "// AUTO-GENERATED from voyant.config.ts - do not edit by hand.",
    "// Run `voyant db schemas --emit` or `voyant db generate` to refresh.",
    "export const schema = [",
    ...entries.map((entry) => `  ${JSON.stringify(entry)},`),
    "]",
    "",
  ].join("\n")

  return { path: outPath, content, entries }
}

export function writeSchemaManifest(
  config: VoyantConfig,
  options: RenderSchemaManifestOptions,
): GeneratedSchemaManifest {
  const manifest = renderSchemaManifest(config, options)
  writeFileSync(manifest.path, manifest.content)
  return manifest
}

export function readSchemaManifest(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

function resolveLocalSchemas(
  config: VoyantConfig,
  cwd: string,
  style: SchemaResolutionStyle,
): string[] {
  const localSchemas = (config as VoyantConfigWithLocalSchemas).schemas ?? []
  return localSchemas.map((entry) => {
    if (style === "file") {
      return isAbsolute(entry) ? entry : resolvePath(cwd, entry)
    }
    return entry
  })
}

function resolveAdditionalSchemas(
  schemas: string[],
  cwd: string,
  style: SchemaResolutionStyle,
): string[] {
  return schemas.map((entry) => {
    if (style === "file") {
      return isAbsolute(entry) ? entry : resolvePath(cwd, entry)
    }
    return entry
  })
}

function resolveOutputPath(cwd: string, outPath: string | undefined): string {
  if (!outPath) return defaultSchemaManifestPath(cwd)
  return isAbsolute(outPath) ? outPath : resolvePath(cwd, outPath)
}

function toPortableRelativePath(fromDir: string, target: string): string {
  let rel = relative(fromDir, target).replaceAll("\\", "/")
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel
}
