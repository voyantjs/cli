import { describe, expect, it } from "vitest"

import { toCamelCase, toKebabCase, toPascalCase } from "../../src/lib/strings.js"

describe("toKebabCase", () => {
  it("lowercases and hyphenates", () => {
    expect(toKebabCase("Invoices")).toBe("invoices")
    expect(toKebabCase("Invoice Items")).toBe("invoice-items")
  })

  it("splits camelCase and PascalCase", () => {
    expect(toKebabCase("invoiceItem")).toBe("invoice-item")
    expect(toKebabCase("CreditNote")).toBe("credit-note")
  })

  it("collapses underscores and repeated separators", () => {
    expect(toKebabCase("some__name")).toBe("some-name")
    expect(toKebabCase("--leading--trailing--")).toBe("leading-trailing")
  })

  it("strips non-alphanumerics", () => {
    expect(toKebabCase("foo/bar@baz")).toBe("foobarbaz")
    expect(toKebabCase("foo bar!")).toBe("foo-bar")
  })

  it("handles empty input", () => {
    expect(toKebabCase("")).toBe("")
    expect(toKebabCase("   ")).toBe("")
  })
})

describe("toCamelCase", () => {
  it("converts to camelCase", () => {
    expect(toCamelCase("invoice items")).toBe("invoiceItems")
    expect(toCamelCase("credit-notes")).toBe("creditNotes")
    expect(toCamelCase("Product")).toBe("product")
    expect(toCamelCase("ALL_CAPS")).toBe("allCaps")
  })

  it("returns empty string for empty input", () => {
    expect(toCamelCase("")).toBe("")
  })
})

describe("toPascalCase", () => {
  it("converts to PascalCase", () => {
    expect(toPascalCase("invoice items")).toBe("InvoiceItems")
    expect(toPascalCase("credit-notes")).toBe("CreditNotes")
    expect(toPascalCase("product")).toBe("Product")
  })

  it("returns empty string for empty input", () => {
    expect(toPascalCase("")).toBe("")
  })
})
