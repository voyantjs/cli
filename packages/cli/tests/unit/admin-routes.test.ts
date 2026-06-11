import { describe, expect, it } from "vitest"

import {
  canonicalRouteFileRelPath,
  fileRouteIdFor,
  GENERATED_ROUTE_HEADER,
  isGeneratedRouteFile,
  renderRouteFile,
  scanDeclaredDestinationKeys,
  scanResolverMapKeys,
  scanRouteContributions,
} from "../../src/lib/admin-routes.js"

const PROMOTIONS_LIKE_SOURCE = `
import { defineAdminExtension } from "@voyantjs/admin"
import { loadFooPage, FooPage } from "../foo-page.js"

export function createFooAdminExtension(options = {}) {
  const { label = "Foo", path = "/foo" } = options
  return defineAdminExtension({
    id: "foo",
    routes: [
      {
        id: "foo-index",
        path,
        title: label,
        ssr: "data-only",
        component: FooPage,
        loader: ({ queryClient, runtime }) =>
          loadFooPage(queryClient, { baseUrl: runtime.baseUrl, fetcher: runtime.fetcher }),
      },
    ],
  })
}
`

const MULTI_ROUTE_SOURCE = `
export function createLegalishAdminExtension(options = {}) {
  const { basePath = "/legalish", labels = {} } = options
  const { contracts = "Contracts" } = labels
  return defineAdminExtension({
    id: "legalish",
    routes: [
      { id: "legalish-contracts-index", path: \`\${basePath}/contracts\`, title: contracts },
      { id: "legalish-contracts-detail", path: \`\${basePath}/contracts/$id\`, title: contracts },
      { id: "legalish-static", path: "/legalish/static", title: contracts, component: StaticPage },
      { id: "legalish-search", path: "/legalish/search", title: contracts, component: SearchPage, validateSearch: parseSearch, preload: "intent" },
    ],
  })
}
`

describe("scanRouteContributions", () => {
  it("resolves shorthand paths via option-destructuring defaults", () => {
    const [route] = scanRouteContributions(PROMOTIONS_LIKE_SOURCE)
    expect(route).toMatchObject({
      id: "foo-index",
      path: "/foo",
      hasComponent: true,
      hasLoader: true,
      hasValidateSearch: false,
      ssr: "data-only",
      preload: null,
    })
  })

  it("resolves template-literal paths and keeps $param segments visible", () => {
    const routes = scanRouteContributions(MULTI_ROUTE_SOURCE)
    expect(routes.map((route) => route.path)).toEqual([
      "/legalish/contracts",
      "/legalish/contracts/$id",
      "/legalish/static",
      "/legalish/search",
    ])
    expect(routes[0]?.hasComponent).toBe(false)
    expect(routes[2]?.hasComponent).toBe(true)
    expect(routes[3]).toMatchObject({
      hasComponent: true,
      hasValidateSearch: true,
      preload: "intent",
      ssr: null,
    })
  })

  it("returns null path when an interpolation has no static default", () => {
    const source = `
      export function createBarAdminExtension({ basePath }) {
        return { id: "bar", routes: [{ id: "bar-index", path: \`\${basePath}/bar\` }] }
      }
    `
    const [route] = scanRouteContributions(source)
    expect(route?.id).toBe("bar-index")
    expect(route?.path).toBeNull()
  })

  it("returns an empty array when there is no routes array", () => {
    expect(scanRouteContributions(`export const x = 1`)).toEqual([])
  })

  it("parses boolean ssr literals", () => {
    const source = `
      const routes = { routes: [{ id: "a", path: "/a", ssr: true, component: A }] }
    `
    expect(scanRouteContributions(source)[0]?.ssr).toBe(true)
  })
})

describe("scanDeclaredDestinationKeys", () => {
  it("extracts quoted keys from AdminDestinations declaration-merging blocks", () => {
    const source = `
      declare module "@voyantjs/admin" {
        interface AdminDestinations {
          /** The list page. */
          "foo.list": Record<string, never>
          "foo.detail": { fooId: string }
          "foo.optional"?: { maybe?: string }
        }
      }
    `
    expect(scanDeclaredDestinationKeys(source).sort()).toEqual([
      "foo.detail",
      "foo.list",
      "foo.optional",
    ])
  })

  it("ignores quoted strings outside the interface and other modules", () => {
    const source = `
      const slot = { slot: "booking.details.header" }
      declare module "@voyantjs/other" {
        interface AdminDestinations { "nope.key": {} }
      }
    `
    expect(scanDeclaredDestinationKeys(source)).toEqual([])
  })
})

describe("scanResolverMapKeys", () => {
  it("extracts keys of the object marked satisfies AdminDestinationResolvers", () => {
    const source = `
      export const destinations = {
        "foo.list": () => "/foo",
        "foo.detail": ({ fooId }) => \`/foo/\${encodeURIComponent(fooId)}\`,
      } satisfies AdminDestinationResolvers
    `
    expect(scanResolverMapKeys(source)?.sort()).toEqual(["foo.detail", "foo.list"])
  })

  it("returns null when no satisfies-marked map exists", () => {
    expect(scanResolverMapKeys(`export const x = { "a.b": () => "/x" }`)).toBeNull()
  })

  it("does not treat strings inside resolver bodies as keys", () => {
    const source = `
      const map = {
        "foo.list": () => "/foo" + "?tab=all",
      } satisfies AdminDestinationResolvers
    `
    expect(scanResolverMapKeys(source)).toEqual(["foo.list"])
  })
})

describe("route file paths", () => {
  it("derives the createFileRoute id from the routes dir", () => {
    expect(fileRouteIdFor("src/routes/_workspace", "/promotions")).toBe("/_workspace/promotions/")
    expect(fileRouteIdFor("src/routes", "/promotions")).toBe("/promotions/")
    expect(fileRouteIdFor("src/routes/_workspace", "/legal/templates")).toBe(
      "/_workspace/legal/templates/",
    )
  })

  it("derives the canonical generated file path", () => {
    expect(canonicalRouteFileRelPath("/legal/templates")).toBe("legal/templates/index.tsx")
  })
})

describe("renderRouteFile", () => {
  const baseOptions = {
    fileRouteId: "/_workspace/promotions/",
    importSpec: "@voyantjs/promotions-react/admin",
    exportName: "createPromotionsAdminExtension",
    routeId: "promotions-index",
    ssr: "data-only" as const,
    preload: null,
    hasLoader: true,
    hasValidateSearch: false,
    runtime: {
      apiUrlModule: "@/lib/env",
      apiUrlExport: "getApiUrl",
      fetcherModule: "@/lib/voyant-fetcher",
      fetcherExport: "operatorFetcher",
    },
  }

  it("renders a generator-owned thin host with the app runtime bound", () => {
    const content = renderRouteFile(baseOptions)
    expect(isGeneratedRouteFile(content)).toBe(true)
    expect(content).toContain(GENERATED_ROUTE_HEADER)
    expect(content).toContain(
      `import { createPromotionsAdminExtension } from "@voyantjs/promotions-react/admin"`,
    )
    expect(content).toContain(`import { requireAdminRoute } from "@voyantjs/admin"`)
    expect(content).toContain(
      `const route = requireAdminRoute(createPromotionsAdminExtension(), "promotions-index")`,
    )
    expect(content).toContain(`createFileRoute("/_workspace/promotions/")`)
    expect(content).toContain(`ssr: "data-only",`)
    expect(content).toContain(`runtime: { baseUrl: getApiUrl(), fetcher: operatorFetcher },`)
    expect(content).toContain(`component: RouteComponent,`)
    expect(content).not.toContain("validateSearch")
  })

  it("omits loader bindings (and their runtime imports) for loaderless routes", () => {
    const content = renderRouteFile({ ...baseOptions, hasLoader: false, ssr: null })
    expect(content).not.toContain("loader:")
    expect(content).not.toContain("@/lib/env")
    expect(content).not.toContain("ssr:")
  })

  it("binds validateSearch and preload when present", () => {
    const content = renderRouteFile({
      ...baseOptions,
      hasValidateSearch: true,
      preload: "intent",
    })
    expect(content).toContain(`validateSearch: route.validateSearch,`)
    expect(content).toContain(`preload: "intent",`)
  })
})
